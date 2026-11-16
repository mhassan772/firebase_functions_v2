// Web subscriptions without Firestore: the slot model, the derivation over the fake Stripe,
// pricing, the ledger statuses, the throttle and the webhook's refusals. The Firestore side
// (sync writes, replays, reconcile, deletion) is in test/integration/webSubscriptions.test.js.
const assert = require("node:assert/strict");
const { describe, test } = require("node:test");
const { Timestamp } = require("firebase-admin/firestore");
const { createFakeStripe, DAY } = require("./helpers/fakeStripeGateway");
const {
  buildMasterProjection,
  buildSourceSummaries,
  MANUAL_SLOT_INDEX,
  STATE_SLOTS,
  stateDataToNormalized,
  stateDocumentId,
  WEB_SLOT_INDEXES,
  webSlotIndex,
} = require("../lib/services/subscriptions/persistence");
const { deriveWebSlot, readWebStripeFacts, WEB_GRACE_MS, WEB_RENEWAL_SLACK_MS } = require("../lib/services/webSubscriptions/sync");
const { ledgerUpdate, nextLedgerStatus, purchaseIdFor } = require("../lib/services/webSubscriptions/ledger");
const {
  billingAddressFromToken,
  cardFromToken,
  chargedTier,
  createPriceLookup,
  DEFAULT_WEB_PRICING,
  knownTier,
  lookupKeyFor,
  quoteTotal,
  unusedTimeCredit,
  webPricingConfigFromData,
} = require("../lib/services/webSubscriptions/pricing");
const { evaluatePurchaseThrottle, throttleIpDocId, throttleUidDocId } = require("../lib/services/webSubscriptions/purchaseThrottle");
const { livemodeOfKey, shortId } = require("../lib/services/webSubscriptions/stripeGateway");
const { handleStripeWebhook, handleWebEvent } = require("../lib/handlers/webSubscriptionEventHandlers");
const { deleteWebCustomer } = require("../lib/services/webSubscriptions/accountDeletion");
const { reasonOf } = require("../lib/utils/callableAuth");
const { computeStats } = require("../lib/services/subscriptions/stats");

const HOUR = 60 * 60 * 1000;
const START = Date.UTC(2026, 10, 14, 12, 0, 0) / 1000;
const UID = "WebBuyer0123456789abcdef";

/** A firestore stand-in that fails the test if anything touches it. */
const untouchable = new Proxy({}, { get: () => assert.fail("Firestore was touched") });

function setup() {
  const fake = createFakeStripe({ nowSec: START });
  const customer = fake.addCustomer(UID);
  return { fake, customer };
}

function entry(purchaseId, plan, refs, status = "paid", extra = {}) {
  return {
    purchaseId,
    uid: UID,
    plan,
    tierShown: "standard",
    tierCharged: "standard",
    lookupKey: `${plan}_standard`,
    priceId: "price",
    amount: 0,
    tax: 0,
    total: 0,
    currency: "usd",
    knownCountry: null,
    cardCountry: "US",
    cardFunding: "credit",
    wallet: null,
    billingCountry: "US",
    billingState: null,
    livemode: false,
    lang: "en",
    status,
    stripe: refs,
    createdAt: new Date(START * 1000),
    updatedAt: new Date(START * 1000),
    ...extra,
  };
}

async function derive(fake, customer, entries = [], nowSec = fake.nowSec) {
  const facts = await readWebStripeFacts(fake, customer, entries);
  return { facts, derivation: deriveWebSlot(facts, new Date(nowSec * 1000)) };
}

const paidPeriodEnd = async (fake, invoiceId) =>
  new Date((await fake.retrieveInvoice(invoiceId)).lines.data[0].period.end * 1000);

describe("slot model", () => {
  test("the web slots are appended after the manual slot, which keeps its index", () => {
    assert.deepEqual(STATE_SLOTS, [
      { platform: "apple", environment: "production" },
      { platform: "apple", environment: "sandbox" },
      { platform: "google", environment: "production" },
      { platform: "google", environment: "test" },
      { platform: "manual", environment: "production" },
      { platform: "web", environment: "production" },
      { platform: "web", environment: "test" },
    ]);
    assert.equal(MANUAL_SLOT_INDEX, 4);
    assert.deepEqual([...WEB_SLOT_INDEXES], [5, 6]);
    assert.equal(webSlotIndex(true), 5);
    assert.equal(webSlotIndex(false), 6);
    assert.match(stateDocumentId(UID, "web", "test"), /_web_test$/);
    assert.match(stateDocumentId(UID, "manual", "production"), /_manual_production$/);
  });

  const base = {
    active: true,
    status: "active",
    expiresAt: new Date(Date.UTC(2027, 0, 1)),
    autoRenewing: true,
    inGracePeriod: false,
    environment: "production",
    lastStoreEventAt: new Date(START * 1000),
    lastVerifiedAt: new Date(START * 1000),
  };
  const now = Timestamp.fromMillis(START * 1000);

  test("the master projection of Apple, Google and manual states is as before, plus each source's product", () => {
    const apple = { ...base, platform: "apple", productId: "monthly_sub", originalTransactionId: "orig-1" };
    const google = { ...base, platform: "google", productId: "premium_access", purchaseReference: "ref-1" };
    const manual = { ...base, platform: "manual", productId: "manual_grant", autoRenewing: false, manual: { activeGrantCount: 1, ledgerRevision: 2 } };
    const appleMaster = buildMasterProjection(apple, now, now, buildSourceSummaries([apple]));
    assert.equal(appleMaster.originalTransactionId, "orig-1");
    assert.ok(!("purchaseReference" in appleMaster));
    assert.ok(!("manual" in appleMaster));
    const googleMaster = buildMasterProjection(google, now, now);
    assert.equal(googleMaster.purchaseReference, "ref-1");
    assert.ok(!("originalTransactionId" in googleMaster));
    const manualMaster = buildMasterProjection(manual, now, now);
    assert.deepEqual(manualMaster.manual, { activeGrantCount: 1, ledgerRevision: 2 });
    assert.ok(!("purchaseReference" in manualMaster));
    assert.deepEqual(
      buildMasterProjection(apple, now, now, buildSourceSummaries([apple, google, manual])).sources.map((row) => row.productId),
      ["monthly_sub", "premium_access", "manual_grant"]
    );
  });

  test("a web master carries its purchase reference and nothing store-specific", () => {
    const web = { ...base, platform: "web", productId: "web_yearly", purchaseReference: "sub_1", originalTransactionId: "ignored" };
    const master = buildMasterProjection(web, now, now, buildSourceSummaries([web]));
    assert.equal(master.platform, "web");
    assert.equal(master.purchaseReference, "sub_1");
    assert.ok(!("originalTransactionId" in master));
    assert.deepEqual(master.sources[0].productId, "web_yearly");
  });

  test("a web row reads active only until its date; an entitled status past it reads expired", () => {
    const at = new Date(Date.UTC(2026, 11, 1));
    const doc = (status, expiresAt, extra = {}) => ({
      active: true,
      status,
      platform: "web",
      productId: "web_monthly",
      expiresAt: Timestamp.fromDate(expiresAt),
      inGracePeriod: status === "grace_period",
      environment: "test",
      lastStoreEventAt: now,
      lastVerifiedAt: now,
      ...extra,
    });
    const future = new Date(at.getTime() + DAY * 1000);
    const past = new Date(at.getTime() - 1000);
    assert.deepEqual(pick(stateDataToNormalized(doc("active", future), at)), { active: true, status: "active", inGracePeriod: false });
    assert.deepEqual(pick(stateDataToNormalized(doc("active", past), at)), { active: false, status: "expired", inGracePeriod: false });
    assert.deepEqual(pick(stateDataToNormalized(doc("canceled", past), at)), { active: false, status: "expired", inGracePeriod: false });
    assert.deepEqual(pick(stateDataToNormalized(doc("grace_period", past), at)), { active: false, status: "expired", inGracePeriod: false });
    assert.deepEqual(pick(stateDataToNormalized(doc("grace_period", future), at)), { active: true, status: "grace_period", inGracePeriod: true });
    assert.deepEqual(pick(stateDataToNormalized(doc("revoked", future, { active: false }), at)), { active: false, status: "revoked", inGracePeriod: false });
    // A store slot still trusts its stored flag, as before.
    const apple = stateDataToNormalized({ ...doc("active", past), platform: "apple", environment: "production" }, at);
    assert.deepEqual(pick(apple), { active: true, status: "active", inGracePeriod: false });
  });
});

describe("stats", () => {
  const NOW = new Date("2026-11-14T10:00:00.000Z");
  const stamp = (days) => Timestamp.fromMillis(NOW.getTime() + days * DAY * 1000);
  const input = (parts) => ({ masters: [], slots: [], events: [], egyptRequests: [], migrationRequests: [], archive: [], ...parts });
  const slot = (uid, platform, environment, createdDaysAgo) => ({
    id: `${uid}_${platform}_${environment}`,
    data: { uid, platform, environment, createdAt: stamp(-createdDaysAgo), expiresAt: stamp(30), active: true, status: "active" },
  });

  test("a production web subscriber counts under web, is new once, and a web test slot counts nowhere", () => {
    const { document } = computeStats(
      input({
        masters: [
          { id: "w1", data: { active: true, status: "active", platform: "web", environment: "production", expiresAt: stamp(30), sources: [] } },
          { id: "w2", data: { active: true, status: "active", platform: "web", environment: "test", expiresAt: stamp(30), sources: [] } },
          { id: "a1", data: { active: true, status: "active", platform: "apple", environment: "production", expiresAt: stamp(30), sources: [] } },
        ],
        slots: [slot("w1", "web", "production", 0), slot("w2", "web", "test", 0), slot("a1", "apple", "production", 40)],
      }),
      NOW
    );
    const { active } = document.summary;
    assert.deepEqual(
      { total: active.total, apple: active.apple, google: active.google, manual: active.manual, web: active.web },
      { total: 2, apple: 1, google: 0, manual: 0, web: 1 }
    );
    assert.equal(document.summary.newToday, 1, "only the production web buyer is new today");
    const yesterday = document.daily.at(-2).active;
    assert.equal(yesterday.web, 0);
    assert.equal(yesterday.apple, 1);
  });
});

function pick(state) {
  return { active: state.active, status: state.status, inGracePeriod: state.inGracePeriod };
}

describe("derivation", () => {
  test("active, not cancelling: access to the paid line period plus 6 hours, renewing", async () => {
    const { fake, customer } = setup();
    const paid = fake.paySubscription({ customer, metadata: { uid: UID, purchaseId: "p1", plan: "web_monthly", tier: "standard" } });
    const { derivation } = await derive(fake, customer);
    const paidThrough = await paidPeriodEnd(fake, paid.invoiceId);
    assert.equal(derivation.kind, "slot");
    const slot = derivation.slot;
    assert.equal(slot.status, "active");
    assert.equal(slot.active, true);
    assert.equal(slot.autoRenewing, true);
    assert.equal(slot.productId, "web_monthly");
    assert.equal(slot.purchaseReference, paid.subscriptionId);
    assert.equal(slot.expiresAt.getTime(), paidThrough.getTime() + WEB_RENEWAL_SLACK_MS);
    assert.equal(slot.web.paidThrough.getTime(), paidThrough.getTime());
    assert.deepEqual(
      { purchaseId: slot.web.purchaseId, tier: slot.web.tier, lastPaidInvoiceId: slot.web.lastPaidInvoiceId, paymentFailed: slot.web.paymentFailed },
      { purchaseId: "p1", tier: "standard", lastPaidInvoiceId: paid.invoiceId, paymentFailed: false }
    );
    assert.deepEqual(derivation.cancel, []);
  });

  test("active and cancelling at period end: canceled, still active, until the paid period's end", async () => {
    const { fake, customer } = setup();
    const paid = fake.paySubscription({ customer });
    await fake.updateSubscription(paid.subscriptionId, { cancel_at_period_end: true });
    const { derivation } = await derive(fake, customer);
    assert.equal(derivation.slot.status, "canceled");
    assert.equal(derivation.slot.active, true);
    assert.equal(derivation.slot.autoRenewing, false);
    assert.equal(derivation.slot.web.cancelAtPeriodEnd, true);
    assert.equal(derivation.slot.expiresAt.getTime(), (await paidPeriodEnd(fake, paid.invoiceId)).getTime());
  });

  test("past due inside 7 days: grace period to the paid period plus 7 days; the advanced item period is ignored", async () => {
    const { fake, customer } = setup();
    const paid = fake.paySubscription({ customer });
    const paidThrough = await paidPeriodEnd(fake, paid.invoiceId);
    fake.nowSec = paidThrough.getTime() / 1000 + 3600;
    fake.renew(paid.subscriptionId, { paid: false });
    const item = (await fake.retrieveSubscription(paid.subscriptionId)).items.data[0];
    assert.ok(item.current_period_end * 1000 > paidThrough.getTime(), "the item period moved on");
    const { derivation } = await derive(fake, customer);
    assert.equal(derivation.slot.status, "grace_period");
    assert.equal(derivation.slot.active, true);
    assert.equal(derivation.slot.inGracePeriod, true);
    assert.equal(derivation.slot.web.paymentFailed, true);
    assert.equal(derivation.slot.web.paidThrough.getTime(), paidThrough.getTime());
    assert.equal(derivation.slot.expiresAt.getTime(), paidThrough.getTime() + WEB_GRACE_MS);
  });

  test("past due after 7 days, or unpaid: billing retry, no access, dated to the paid period's end", async () => {
    const { fake, customer } = setup();
    const paid = fake.paySubscription({ customer });
    const paidThrough = await paidPeriodEnd(fake, paid.invoiceId);
    fake.nowSec = paidThrough.getTime() / 1000 + 3600;
    fake.renew(paid.subscriptionId, { paid: false });
    const late = await derive(fake, customer, [], paidThrough.getTime() / 1000 + 8 * DAY);
    assert.deepEqual(
      [late.derivation.slot.status, late.derivation.slot.active, late.derivation.slot.expiresAt.getTime()],
      ["billing_retry", false, paidThrough.getTime()]
    );
    fake.setSubscription(paid.subscriptionId, { status: "unpaid" });
    const unpaid = await derive(fake, customer);
    assert.deepEqual([unpaid.derivation.slot.status, unpaid.derivation.slot.active], ["billing_retry", false]);
    assert.equal(unpaid.derivation.slot.web.paymentFailed, true);
  });

  test("canceled: expired at the earlier of the paid period's end and the end of the subscription", async () => {
    const { fake, customer } = setup();
    const paid = fake.paySubscription({ customer });
    const paidThrough = await paidPeriodEnd(fake, paid.invoiceId);
    fake.advance(5 * DAY);
    await fake.cancelSubscription(paid.subscriptionId);
    const early = await derive(fake, customer);
    assert.deepEqual([early.derivation.slot.status, early.derivation.slot.active], ["expired", false]);
    assert.equal(early.derivation.slot.expiresAt.getTime(), (START + 5 * DAY) * 1000);
    fake.setSubscription(paid.subscriptionId, { ended_at: paidThrough.getTime() / 1000 + DAY });
    const late = await derive(fake, customer);
    assert.equal(late.derivation.slot.expiresAt.getTime(), paidThrough.getTime());
  });

  test("the latest paid charge refunded in full: revoked, and the subscription is cancelled", async () => {
    const { fake, customer } = setup();
    const paid = fake.paySubscription({ customer });
    fake.refund(paid.chargeId);
    const { derivation } = await derive(fake, customer);
    assert.deepEqual([derivation.slot.status, derivation.slot.active], ["revoked", false]);
    assert.deepEqual(derivation.cancel, [paid.subscriptionId]);
  });

  test("a partial refund changes nothing but the ledger's partialRefund", async () => {
    const { fake, customer } = setup();
    const paid = fake.paySubscription({ customer });
    fake.refund(paid.chargeId, 100);
    const ledger = entry("p1", "web_monthly", { customerId: customer, subscriptionId: paid.subscriptionId, invoiceId: paid.invoiceId });
    const { facts, derivation } = await derive(fake, customer, [ledger]);
    assert.deepEqual([derivation.slot.status, derivation.slot.active], ["active", true]);
    assert.deepEqual(derivation.cancel, []);
    const update = ledgerUpdate(ledger, facts.invoices.get(paid.invoiceId), new Date());
    assert.equal(update.partialRefund, 100);
    assert.ok(!("status" in update));
  });

  test("a dispute needing a response or under review: revoked, the subscription is left running", async () => {
    for (const status of ["needs_response", "under_review"]) {
      const { fake, customer } = setup();
      const paid = fake.paySubscription({ customer });
      fake.dispute(paid.chargeId, status);
      const { derivation } = await derive(fake, customer);
      assert.deepEqual([derivation.slot.status, derivation.slot.active], ["revoked", false], status);
      assert.deepEqual(derivation.cancel, [], status);
    }
  });

  test("a lost dispute: revoked and cancelled; a won one restores the row; warnings change nothing", async () => {
    const { fake, customer } = setup();
    const paid = fake.paySubscription({ customer });
    const dispute = fake.dispute(paid.chargeId, "needs_response");
    fake.setDispute(dispute, "won");
    const won = await derive(fake, customer);
    assert.deepEqual([won.derivation.slot.status, won.derivation.slot.active], ["active", true]);
    fake.setDispute(dispute, "warning_needs_response");
    const warning = await derive(fake, customer);
    assert.deepEqual([warning.derivation.slot.status, warning.derivation.slot.active], ["active", true]);
    fake.setDispute(dispute, "lost");
    const lost = await derive(fake, customer);
    assert.deepEqual([lost.derivation.slot.status, lost.derivation.slot.active], ["revoked", false]);
    assert.deepEqual(lost.derivation.cancel, [paid.subscriptionId]);
  });

  test("lifetime: active for 50 years from payment, and every open subscription is cancelled", async () => {
    const { fake, customer } = setup();
    const sub = fake.paySubscription({ customer });
    fake.advance(DAY);
    const life = fake.payLifetime({ customer });
    const entries = [entry("life", "web_lifetime", { customerId: customer, invoiceId: life.invoiceId })];
    const { derivation } = await derive(fake, customer, entries);
    assert.equal(derivation.slot.productId, "web_lifetime");
    assert.equal(derivation.slot.status, "active");
    assert.equal(derivation.slot.autoRenewing, false);
    assert.equal(derivation.slot.purchaseReference, life.invoiceId);
    assert.equal(derivation.slot.expiresAt.toISOString(), new Date((START + DAY) * 1000).toISOString().replace("2026", "2076"));
    assert.deepEqual(derivation.cancel, [sub.subscriptionId]);
  });

  test("a refunded or disputed lifetime gives no access; with a subscription the subscription decides", async () => {
    for (const revoke of ["refund", "dispute"]) {
      const { fake, customer } = setup();
      const life = fake.payLifetime({ customer });
      if (revoke === "refund") fake.refund(life.chargeId);
      else fake.dispute(life.chargeId, "needs_response");
      const entries = [entry("life", "web_lifetime", { customerId: customer, invoiceId: life.invoiceId })];
      const alone = await derive(fake, customer, entries);
      assert.deepEqual([alone.derivation.slot.status, alone.derivation.slot.active], ["revoked", false], revoke);
      const sub = fake.paySubscription({ customer });
      const withSub = await derive(fake, customer, entries);
      assert.deepEqual([withSub.derivation.slot.status, withSub.derivation.slot.purchaseReference], ["active", sub.subscriptionId], revoke);
    }
  });

  test("no purchase, an incomplete subscription only, or a deleted customer: nothing", async () => {
    const { fake, customer } = setup();
    assert.equal((await derive(fake, customer)).derivation.kind, "nothing");
    fake.startSubscription({ customer });
    assert.equal((await derive(fake, customer)).derivation.kind, "nothing");
    await fake.deleteCustomer(customer);
    assert.equal((await derive(fake, customer)).derivation.kind, "nothing");
  });

  test("a renewal waiting for authentication sets needsAction", async () => {
    const { fake, customer } = setup();
    const paid = fake.paySubscription({ customer });
    fake.nowSec = (await paidPeriodEnd(fake, paid.invoiceId)).getTime() / 1000 + 60;
    fake.renew(paid.subscriptionId, { paid: false, requiresAction: true });
    const { derivation } = await derive(fake, customer);
    assert.equal(derivation.slot.web.needsAction, true);
    assert.equal(derivation.slot.status, "grace_period");
  });

  test("a later paid renewal moves paidThrough to its own line period", async () => {
    const { fake, customer } = setup();
    const paid = fake.paySubscription({ customer });
    fake.nowSec = (await paidPeriodEnd(fake, paid.invoiceId)).getTime() / 1000;
    const renewal = fake.renew(paid.subscriptionId, { paid: true });
    const { derivation } = await derive(fake, customer);
    assert.equal(derivation.slot.web.lastPaidInvoiceId, renewal.invoiceId);
    assert.equal(derivation.slot.web.paidThrough.getTime(), (await paidPeriodEnd(fake, renewal.invoiceId)).getTime());
  });

  /** A monthly subscription ten days in, switched to yearly with the stage I update. */
  async function switched(fake, customer, card = {}) {
    const paid = fake.paySubscription({ customer, metadata: { tier: "standard", purchaseId: "p1" } });
    fake.setDefaultCard(paid.subscriptionId, card);
    fake.advance(10 * DAY);
    const sub = await fake.retrieveSubscription(paid.subscriptionId);
    const updated = await fake.updateSubscription(paid.subscriptionId, {
      items: [{ id: sub.items.data[0].id, price: "price_web_yearly_standard" }],
      proration_behavior: "always_invoice",
      billing_cycle_anchor: { type: "now" },
      cancel_at_period_end: false,
      payment_behavior: "pending_if_incomplete",
      metadata: { plan: "web_yearly", tier: "standard", purchaseId: "p2" },
      expand: ["latest_invoice.payments"],
    }, "switch_p2");
    return { paid, updated, invoice: updated.latest_invoice };
  }

  test("a plan switch: paid until the yearly line's end, though the credit line comes first; the slot is yearly", async () => {
    const { fake, customer } = setup();
    const { invoice } = await switched(fake, customer);
    assert.equal(invoice.status, "paid");
    assert.ok(invoice.lines.data[0].amount < 0, "the credit line first");
    const yearlyEnd = new Date(invoice.lines.data[1].period.end * 1000);
    assert.ok(yearlyEnd.getTime() > new Date(invoice.lines.data[0].period.end * 1000).getTime());
    const { derivation } = await derive(fake, customer);
    assert.equal(derivation.slot.productId, "web_yearly");
    assert.equal(derivation.slot.web.purchaseId, "p2");
    assert.equal(derivation.slot.web.lastPaidInvoiceId, invoice.id);
    assert.equal(derivation.slot.web.paidThrough.getTime(), yearlyEnd.getTime());
    assert.equal(derivation.slot.status, "active");
  });

  test("an open subscription_update invoice waiting for the bank is not a renewal needing action; the slot stays monthly", async () => {
    const { fake, customer } = setup();
    const { paid, updated } = await switched(fake, customer, { requiresAction: true });
    assert.ok(updated.pending_update, "the change waits");
    const { derivation } = await derive(fake, customer);
    assert.equal(derivation.slot.web.needsAction, false);
    assert.equal(derivation.slot.productId, "web_monthly");
    assert.equal(derivation.slot.web.lastPaidInvoiceId, paid.invoiceId);
    assert.equal(derivation.slot.web.purchaseId, "p1", "the switch's metadata waits for the payment too");
  });

  test("the slot's tier is the subscription's metadata tier, which every price change writes with the price", async () => {
    const { fake, customer } = setup();
    fake.paySubscription({ customer, lookupKey: "web_monthly_reduced", metadata: { tier: "reduced" } });
    assert.equal((await derive(fake, customer)).derivation.slot.web.tier, "reduced");
    const { fake: other, customer: otherCustomer } = setup();
    await switched(other, otherCustomer);
    assert.equal((await derive(other, otherCustomer)).derivation.slot.web.tier, "standard");
  });

  test("a full refund of the switch payment revokes access and cancels the subscription", async () => {
    const { fake, customer } = setup();
    const { paid, invoice } = await switched(fake, customer);
    const pi = fake.state.paymentIntents.get(invoice.payments.data[0].payment.payment_intent);
    fake.refund(pi.latest_charge);
    const { derivation } = await derive(fake, customer);
    assert.equal(derivation.slot.status, "revoked");
    assert.equal(derivation.slot.active, false);
    assert.deepEqual(derivation.cancel, [paid.subscriptionId]);
  });
});

describe("ledger", () => {
  const invoice = (status, charge) => ({ id: "in_1", status, charge });
  const charge = (extra = {}) => ({ fullyRefunded: false, amountRefunded: 0, dispute: "none", ...extra });

  test("statuses follow Stripe", () => {
    assert.equal(nextLedgerStatus("pending", invoice("paid", charge())), "paid");
    assert.equal(nextLedgerStatus("paid", invoice("paid", charge({ fullyRefunded: true }))), "refunded");
    assert.equal(nextLedgerStatus("paid", invoice("paid", charge({ dispute: "open" }))), "disputed");
    assert.equal(nextLedgerStatus("disputed", invoice("paid", charge())), "paid", "won");
    assert.equal(nextLedgerStatus("disputed", invoice("paid", charge({ dispute: "lost" }))), "dispute_lost");
    assert.equal(nextLedgerStatus("refunded", invoice("paid", charge())), "refunded");
    assert.equal(nextLedgerStatus("pending", invoice("open")), "pending");
    assert.equal(nextLedgerStatus("failed", invoice("open")), "failed");
    assert.equal(nextLedgerStatus("pending", invoice("void")), "abandoned");
    assert.equal(nextLedgerStatus("failed", invoice("void")), "failed");
  });

  test("the purchase id is the first 32 hex characters of sha256(uid:token)", () => {
    const id = purchaseIdFor(UID, "ctoken_abc");
    assert.match(id, /^[0-9a-f]{32}$/);
    assert.equal(id, purchaseIdFor(UID, "ctoken_abc"));
    assert.notEqual(id, purchaseIdFor(UID, "ctoken_abd"));
  });
});

describe("pricing", () => {
  const config = webPricingConfigFromData(undefined);

  test("missing or malformed fields fall back to the defaults, which keep sales off", () => {
    assert.deepEqual(config, DEFAULT_WEB_PRICING);
    const odd = webPricingConfigFromData({ salesEnabled: "yes", testers: ["a", 3, ""], fullPriceTier: "nope", countries: { eg: "low", XX: "low", SA: "unknown" } });
    assert.equal(odd.salesEnabled, false);
    assert.deepEqual(odd.testers, ["a"]);
    assert.equal(odd.fullPriceTier, "standard");
    assert.deepEqual(odd.countries, { EG: "low" });
  });

  test("the known tier is the dearest among the app report and every store country", () => {
    assert.deepEqual(knownTier(config, { storePurchase: [] }), { tier: "standard", countryKnown: false, knownCountry: null });
    assert.equal(knownTier(config, { appReport: "EG", storePurchase: [] }).tier, "low");
    assert.deepEqual(knownTier(config, { appReport: "EG", storePurchase: ["MA"] }), { tier: "reduced", countryKnown: true, knownCountry: "MA" });
    assert.equal(knownTier(config, { appReport: "EG", storePurchase: ["DE"] }).tier, "standard");
  });

  test("the charged tier is the dearer of the known tier and the card's; no card country is full price", () => {
    assert.equal(chargedTier(config, "low", "EG"), "low");
    assert.equal(chargedTier(config, "low", "US"), "standard");
    assert.equal(chargedTier(config, "low", "MA"), "reduced");
    assert.equal(chargedTier(config, "reduced", "EG"), "reduced", "a cheaper card never lowers it");
    assert.equal(chargedTier(config, "low", null), "standard");
  });

  test("monthly is not sold in the low tier", () => {
    assert.equal(lookupKeyFor(config, "reduced", "web_monthly"), "web_monthly_reduced");
    assert.throws(() => lookupKeyFor(config, "low", "web_monthly"), (error) => reasonOf(error) === "plan_unavailable");
  });

  test("prices come from Stripe, cached for ten minutes, one request for concurrent lookups", async () => {
    const fake = createFakeStripe();
    let clock = 0;
    const lookup = createPriceLookup(fake, () => clock);
    const [first, second] = await Promise.all([lookup.get(["web_yearly_low"]), lookup.get(["web_yearly_low"])]);
    assert.equal(first.get("web_yearly_low").amount, 1999);
    assert.equal(second.get("web_yearly_low").interval, "year");
    assert.equal(fake.callNames().filter((name) => name === "listPricesByLookupKeys").length, 1);
    clock = 9 * 60 * 1000;
    await lookup.get(["web_yearly_low"]);
    assert.equal(fake.callNames().filter((name) => name === "listPricesByLookupKeys").length, 1);
    clock = 11 * 60 * 1000;
    fake.state.prices.get("price_web_yearly_low").unit_amount = 2099;
    assert.equal((await lookup.get(["web_yearly_low"])).get("web_yearly_low").amount, 2099);
    await assert.rejects(lookup.get(["web_monthly_low"]), /web_monthly_low/);
  });

  test("the total: the price alone with tax off; Stripe's preview with tax on", async () => {
    const fake = createFakeStripe({ taxFor: (address) => (address.country === "CA" ? 650 : 0) });
    const lookup = createPriceLookup(fake);
    const yearly = (await lookup.get(["web_yearly_standard"])).get("web_yearly_standard");
    const lifetime = (await lookup.get(["web_lifetime_standard"])).get("web_lifetime_standard");
    assert.deepEqual(await quoteTotal(fake, yearly, { taxEnabled: false }), { amount: 4999, tax: 0, total: 4999, currency: "usd" });
    assert.equal(fake.callNames().includes("createInvoicePreview"), false);
    assert.deepEqual(
      await quoteTotal(fake, yearly, { taxEnabled: true, address: { country: "CA", state: "ON" } }),
      { amount: 4999, tax: 650, total: 5649, currency: "usd" }
    );
    assert.equal((await quoteTotal(fake, lifetime, { taxEnabled: true, address: { country: "US", postal_code: "10001" } })).tax, 0);
    const preview = fake.calls.filter((call) => call.name === "createInvoicePreview");
    assert.ok(preview[0].args.params.subscription_details, "a subscription is previewed as one");
    assert.ok(preview[1].args.params.invoice_items, "lifetime is previewed as a one-off invoice");
    await assert.rejects(
      quoteTotal(fake, yearly, { taxEnabled: true, address: { country: "CA" } }),
      (error) => reasonOf(error) === "billing_address_incomplete"
    );
  });

  test("billing address rules", async () => {
    const fake = createFakeStripe();
    const token = async (billing) => fake.retrieveConfirmationToken(fake.addToken({ country: "CA", billing }));
    const missing = await token({ country: null });
    assert.throws(() => billingAddressFromToken(missing, { taxEnabled: false }), (error) => reasonOf(error) === "billing_address_incomplete");
    const bare = await token({ country: "CA" });
    assert.equal(billingAddressFromToken(bare, { taxEnabled: false }).country, "CA");
    assert.throws(() => billingAddressFromToken(bare, { taxEnabled: true }), (error) => reasonOf(error) === "billing_address_incomplete");
    assert.deepEqual(billingAddressFromToken(bare, { taxEnabled: true, billingState: "QC" }).address, { country: "CA", state: "QC" });
    const postal = await token({ country: "CA", postal_code: "M5V 3L9", line1: "1 King St" });
    const read = billingAddressFromToken(postal, { taxEnabled: true });
    assert.deepEqual([read.country, read.state, read.address.postal_code], ["CA", null, "M5V 3L9"]);
  });

  test("only cards are accepted; the card's country, funding and wallet are read", async () => {
    const fake = createFakeStripe();
    const link = await fake.retrieveConfirmationToken(fake.addToken({ type: "link" }));
    assert.throws(() => cardFromToken(link), (error) => reasonOf(error) === "card_required");
    const wallet = await fake.retrieveConfirmationToken(fake.addToken({ country: "eg", funding: "debit", wallet: "apple_pay" }));
    assert.deepEqual(cardFromToken(wallet), { country: "EG", funding: "debit", wallet: "apple_pay", brand: "visa" });
    const noCountry = await fake.retrieveConfirmationToken(fake.addToken({ country: null }));
    assert.equal(cardFromToken(noCountry).country, null);
  });
});

describe("unused time credit", () => {
  const T = (iso) => Date.parse(iso) / 1000;
  const line = (amount, start, end) => ({ amount, period: { start: T(start), end: T(end) } });
  const invoice = (...lines) => ({ lines: { data: lines } });
  const at = (iso) => new Date(iso);
  const monthly = invoice(line(499, "2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z"));

  test("start, middle and end of a period, rounded down to a cent", () => {
    assert.equal(unusedTimeCredit(monthly, at("2026-11-01T00:00:00Z"), 14999), 499);
    assert.equal(unusedTimeCredit(monthly, at("2026-10-20T00:00:00Z"), 14999), 499, "before the period starts: all of it");
    assert.equal(unusedTimeCredit(monthly, at("2026-11-16T00:00:00Z"), 14999), Math.floor(499 * 15 / 30));
    assert.equal(unusedTimeCredit(monthly, at("2026-11-16T00:00:01Z"), 14999), 249, "249.49 → 249");
    assert.equal(unusedTimeCredit(monthly, at("2026-12-01T00:00:00Z"), 14999), 0);
    assert.equal(unusedTimeCredit(monthly, at("2026-12-09T00:00:00Z"), 14999), 0, "past the period: nothing, never negative");
    assert.equal(unusedTimeCredit(undefined, at("2026-11-16T00:00:00Z"), 14999), 0, "no paid invoice");
  });

  test("a switch invoice: the yearly line, not the credit line listed before it", () => {
    const switched = invoice(line(-333, "2026-11-26T00:00:00Z", "2026-12-16T00:00:00Z"), line(4999, "2026-11-26T00:00:00Z", "2027-11-26T00:00:00Z"));
    const now = at("2027-05-27T12:00:00Z");
    const expected = Math.floor(4999 * (Date.parse("2027-11-26T00:00:00Z") - now.getTime()) / (365 * 86400 * 1000));
    assert.equal(unusedTimeCredit(switched, now, 14999), expected);
  });

  test("a cancelled subscription is credited for its paid period alike; tax is never part of the base", () => {
    const taxed = { ...monthly, total: 564, total_taxes: [{ amount: 65 }] };
    assert.equal(unusedTimeCredit(taxed, at("2026-11-16T00:00:00Z"), 14999), unusedTimeCredit(monthly, at("2026-11-16T00:00:00Z"), 14999));
  });

  test("a partial refund credits only what is still paid; a full refund credits nothing", () => {
    const now = at("2026-11-16T00:00:00Z");
    assert.equal(unusedTimeCredit(monthly, now, 14999, 0.5), Math.floor(499 * 0.5 * 15 / 30));
    assert.equal(unusedTimeCredit(monthly, now, 14999, 0), 0);
    assert.equal(unusedTimeCredit(monthly, now, 14999, 1), unusedTimeCredit(monthly, now, 14999));
  });

  test("never more than leaves Stripe's minimum charge", () => {
    assert.equal(unusedTimeCredit(invoice(line(5000, "2026-11-01T00:00:00Z", "2027-11-01T00:00:00Z")), at("2026-11-01T00:00:00Z"), 5020), 4970);
  });
});

describe("purchase throttle", () => {
  test("10 attempts per uid and 30 per IP a day; a passed window starts again", () => {
    const now = 1_000_000_000;
    const counter = (count, windowStartMs = now - 1000) => ({ windowStartMs, count, lastAttemptMs: now - 1000 });
    assert.equal(evaluatePurchaseThrottle(counter(9), counter(29), true, now).allowed, true);
    assert.deepEqual(evaluatePurchaseThrottle(counter(10), undefined, true, now), { allowed: false, reason: "uid_day" });
    assert.deepEqual(evaluatePurchaseThrottle(counter(1), counter(30), true, now), { allowed: false, reason: "ip_day" });
    const next = evaluatePurchaseThrottle(counter(10, now - 25 * HOUR), undefined, false, now);
    assert.equal(next.allowed, true);
    assert.equal(next.uid.count, 1);
    assert.equal(next.ip, undefined);
    assert.equal(throttleUidDocId("a/b"), "uid_a%2Fb");
    assert.match(throttleIpDocId("203.0.113.9"), /^ip_[0-9a-f]{64}$/);
  });
});

describe("gateway helpers", () => {
  test("the mode comes from the key's prefix; anything else is refused", () => {
    assert.equal(livemodeOfKey("sk_live_x"), true);
    assert.equal(livemodeOfKey("rk_test_x"), false);
    assert.throws(() => livemodeOfKey("pk_test_x"), /not a Stripe key/);
    assert.equal(shortId("ctoken_1UbdAC9K4RmTBSihqtVj5ei3"), "ctoken_1UbdAC…");
  });
});

describe("webhook refusals", () => {
  const SECRET = "whsec_test";

  test("a bad signature is 400 and touches nothing", async () => {
    const fake = createFakeStripe();
    const event = fake.emit("invoice.paid", { object: "invoice", customer: "cus_1" });
    const { body } = fake.signedEvent(event, SECRET);
    const response = await handleStripeWebhook(
      { method: "POST", rawBody: body, header: () => "t=1,v1=00" },
      { firestore: untouchable, gateway: fake, webhookSecret: SECRET }
    );
    assert.deepEqual(response, { status: 400, body: { error: "invalid_signature" } });
    const tampered = await handleStripeWebhook(
      { method: "POST", rawBody: Buffer.from(body.toString().replace("cus_1", "cus_2")), header: () => fake.signedEvent(event, SECRET).header },
      { firestore: untouchable, gateway: fake, webhookSecret: SECRET }
    );
    assert.equal(tampered.status, 400);
  });

  test("a GET is 405; a missing key or webhook secret is 500, so Stripe keeps the event", async () => {
    const fake = createFakeStripe();
    assert.equal((await handleStripeWebhook({ method: "GET", header: () => undefined }, { firestore: untouchable, gateway: fake, webhookSecret: SECRET })).status, 405);
    assert.equal((await handleStripeWebhook({ method: "POST", header: () => undefined }, { firestore: untouchable, gateway: undefined, webhookSecret: SECRET })).status, 500);
    assert.equal((await handleStripeWebhook({ method: "POST", header: () => undefined }, { firestore: untouchable, gateway: fake, webhookSecret: undefined })).status, 500);
  });

  test("an event from the other mode, or of a type not handled, is answered 200 without a write", async () => {
    const fake = createFakeStripe({ livemode: true });
    const testEvent = { ...fake.emit("invoice.paid", { object: "invoice", customer: "cus_1" }), livemode: false };
    const signed = fake.signedEvent(testEvent, SECRET);
    const response = await handleStripeWebhook(
      { method: "POST", rawBody: signed.body, header: () => signed.header },
      { firestore: untouchable, gateway: fake, webhookSecret: SECRET }
    );
    assert.deepEqual(response, { status: 200, body: { received: true, outcome: "livemode_mismatch" } });
    const other = fake.emit("customer.created", { object: "customer", id: "cus_1" });
    assert.equal(await handleWebEvent({ id: other.id, type: other.type, created: other.created, livemode: true, object: {} }, "webhook", { firestore: untouchable, gateway: fake }), "ignored");
  });
});

describe("account deletion", () => {
  const firestoreWith = (mapping) => ({
    collection: () => ({ doc: () => ({ get: async () => ({ exists: mapping !== undefined, data: () => mapping }) }) }),
  });

  test("no mapping: returns without asking for a key", async () => {
    let asked = 0;
    await deleteWebCustomer(UID, { firestore: firestoreWith(undefined), gateway: () => void asked++ });
    assert.equal(asked, 0);
  });

  test("a mapping: the customer of the gateway's mode is deleted, an already deleted one is fine", async () => {
    const fake = createFakeStripe();
    const customer = fake.addCustomer(UID);
    await deleteWebCustomer(UID, { firestore: firestoreWith({ testCustomerId: customer }), gateway: () => fake });
    assert.equal((await fake.retrieveCustomer(customer)).deleted, true);
    await deleteWebCustomer(UID, { firestore: firestoreWith({ testCustomerId: customer }), gateway: () => fake });
    await deleteWebCustomer(UID, { firestore: firestoreWith({ liveCustomerId: "cus_live" }), gateway: () => fake });
    assert.equal(fake.callNames().filter((name) => name === "deleteCustomer").length, 2);
  });

  test("a mapping with no key configured fails, so the purge keeps the mapping", async () => {
    await assert.rejects(
      deleteWebCustomer(UID, { firestore: firestoreWith({ testCustomerId: "cus_1" }), gateway: () => undefined }),
      (error) => error.safeCode === "stripe-key-missing"
    );
  });
});
