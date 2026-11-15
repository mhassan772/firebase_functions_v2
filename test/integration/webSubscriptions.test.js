// Web subscriptions against the Firestore emulator, with the in-memory Stripe from
// test/helpers. Run with `npm run test:integration`; nothing here reaches Stripe or real data.
const assert = require("node:assert/strict");
const { beforeEach, describe, test } = require("node:test");

assert.ok(process.env.FIRESTORE_EMULATOR_HOST, "FIRESTORE_EMULATOR_HOST must point at the emulator");

const { admin } = require("../../lib/config/admin");
const { Timestamp } = require("firebase-admin/firestore");
const { createFakeStripe, DAY } = require("../helpers/fakeStripeGateway");
const {
  persistVerifiedSubscription,
  stateDocumentId,
  SUBSCRIPTION_MASTER_COLLECTION,
  SUBSCRIPTION_STATE_COLLECTION,
} = require("../../lib/services/subscriptions/persistence");
const { syncWebEntitlement } = require("../../lib/services/webSubscriptions/sync");
const { ensureCustomer, WEB_CUSTOMERS_COLLECTION } = require("../../lib/services/webSubscriptions/customers");
const { ledgerEntryToData, WEB_PURCHASES_COLLECTION } = require("../../lib/services/webSubscriptions/ledger");
const { HANDLED_WEB_EVENT_TYPES, WEB_STRIPE_EVENTS_COLLECTION } = require("../../lib/services/webSubscriptions/events");
const { firestoreWebPurchaseThrottle, WebPurchaseThrottledError, WEB_PURCHASE_THROTTLE_COLLECTION, throttleUidDocId } =
  require("../../lib/services/webSubscriptions/purchaseThrottle");
const { sweepPendingWebPurchases } = require("../../lib/services/webSubscriptions/pendingSweep");
const { handleStripeWebhook } = require("../../lib/handlers/webSubscriptionEventHandlers");
const { runFeedPhase, stripeEventsPhase, SUBSCRIPTION_RECONCILE_COLLECTION } = require("../../lib/handlers/subscriptionReconcileHandlers");
const { DELETED_ACCOUNTS_COLLECTION } = require("../../lib/services/accountDeletion/tombstone");
const { purgeAccount } = require("../../lib/services/accountDeletion/purge");
const { deleteWebCustomer } = require("../../lib/services/webSubscriptions/accountDeletion");
const { readWebPricingConfig } = require("../../lib/services/webSubscriptions/pricing");

const db = () => admin.firestore();
const UID = "WebBuyerAaaaaaaaaaaaaaa01";
const OTHER = "WebBuyerBbbbbbbbbbbbbbb02";
const SECRET = "whsec_integration";
const MINUTE = 60 * 1000;

async function clearFirestore() {
  const response = await fetch(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-mantooq/databases/(default)/documents`,
    { method: "DELETE" }
  );
  assert.ok(response.ok, `clearing Firestore failed: ${response.status}`);
}

const slotRef = (uid, environment = "test") =>
  db().collection(SUBSCRIPTION_STATE_COLLECTION).doc(stateDocumentId(uid, "web", environment));
const masterRef = (uid) => db().collection(SUBSCRIPTION_MASTER_COLLECTION).doc(uid);
const read = async (ref) => {
  const snapshot = await ref.get();
  return snapshot.exists ? snapshot.data() : undefined;
};
const updateTimeOf = async (ref) => (await ref.get()).updateTime?.toMillis();

/** A fake Stripe dated to now, with the customer mapped the way the purchase callable maps it. */
async function setup({ livemode = false, uid = UID } = {}) {
  const fake = createFakeStripe({ livemode, nowSec: Math.floor(Date.now() / 1000) - 60 });
  const deps = { firestore: db(), gateway: fake };
  const customer = await ensureCustomer(uid, deps);
  return { fake, deps, customer };
}

async function writeLedger(purchaseId, fields) {
  const now = new Date();
  await db().collection(WEB_PURCHASES_COLLECTION).doc(purchaseId).set(
    ledgerEntryToData({
      purchaseId,
      uid: UID,
      plan: "web_monthly",
      tierShown: "standard",
      tierCharged: "standard",
      lookupKey: "web_monthly_standard",
      priceId: "price_web_monthly_standard",
      amount: 499,
      tax: 0,
      total: 499,
      currency: "usd",
      knownCountry: null,
      cardCountry: "US",
      cardFunding: "credit",
      wallet: null,
      billingCountry: "US",
      billingState: null,
      livemode: false,
      lang: "en",
      status: "pending",
      createdAt: now,
      updatedAt: now,
      ...fields,
    })
  );
}

async function webhook(fake, event, deps) {
  const signed = fake.signedEvent(event, SECRET);
  return handleStripeWebhook(
    { method: "POST", rawBody: signed.body, header: (name) => (name === "stripe-signature" ? signed.header : undefined) },
    { firestore: db(), gateway: fake, webhookSecret: SECRET, ...deps }
  );
}

beforeEach(clearFirestore);

describe("syncWebEntitlement", () => {
  test("a paid subscription writes the web test slot and projects the master when nothing else exists", async () => {
    const { fake, deps, customer } = await setup();
    const paid = fake.paySubscription({ customer, metadata: { uid: UID, purchaseId: "p1", plan: "web_monthly", tier: "standard" } });
    await writeLedger("p1", { stripe: { customerId: customer, subscriptionId: paid.subscriptionId, invoiceId: paid.invoiceId } });

    const result = await syncWebEntitlement(UID, deps);
    assert.equal(result.outcome, "written");
    assert.equal(result.ledgerUpdates, 1);
    const slot = await read(slotRef(UID));
    assert.equal(slot.platform, "web");
    assert.equal(slot.environment, "test");
    assert.equal(slot.status, "active");
    assert.equal(slot.purchaseReference, paid.subscriptionId);
    assert.equal(slot.web.customerId, customer);
    assert.equal(slot.web.purchaseId, "p1");
    assert.ok(slot.web.paidThrough instanceof Timestamp);
    assert.equal(await read(slotRef(UID, "production")), undefined, "a sandbox key never writes the production slot");
    const master = await read(masterRef(UID));
    assert.equal(master.platform, "web");
    assert.equal(master.environment, "test");
    assert.equal(master.active, true);
    assert.equal(master.productId, "web_monthly");
    assert.equal(master.purchaseReference, paid.subscriptionId);
    assert.ok(!("originalTransactionId" in master));
    assert.deepEqual(master.sources.map((row) => [row.platform, row.productId]), [["web", "web_monthly"]]);
    const ledger = await read(db().collection(WEB_PURCHASES_COLLECTION).doc("p1"));
    assert.equal(ledger.status, "paid");
    assert.equal(ledger.stripe.chargeId, paid.chargeId);
  });

  test("next to an active production Apple slot, a web test slot is a source but Apple keeps the master", async () => {
    const { fake, deps, customer } = await setup();
    const appleExpiry = new Date(Date.now() + 20 * DAY * 1000);
    await persistVerifiedSubscription(UID, {
      subscription: {
        active: true,
        status: "active",
        platform: "apple",
        productId: "monthly_sub",
        expiresAt: appleExpiry,
        autoRenewing: true,
        inGracePeriod: false,
        environment: "production",
        originalTransactionId: "orig-web-1",
        lastStoreEventAt: new Date(),
        lastVerifiedAt: new Date(),
      },
      ownership: [{ platform: "apple", environment: "production", originalTransactionId: "orig-web-1" }],
    });
    fake.paySubscription({ customer, lookupKey: "web_yearly_standard" });
    await syncWebEntitlement(UID, deps);
    const master = await read(masterRef(UID));
    assert.equal(master.platform, "apple");
    assert.equal(master.originalTransactionId, "orig-web-1");
    assert.ok(!("purchaseReference" in master));
    assert.deepEqual(
      master.sources.map((row) => [row.platform, row.environment, row.productId]),
      [["apple", "production", "monthly_sub"], ["web", "test", "web_yearly"]]
    );
  });

  test("next to an active Apple slot, a live web slot that runs longer takes the master", async () => {
    const { fake, deps, customer } = await setup({ livemode: true });
    await persistVerifiedSubscription(UID, {
      subscription: {
        active: true,
        status: "active",
        platform: "apple",
        productId: "monthly_sub",
        expiresAt: new Date(Date.now() + 20 * DAY * 1000),
        autoRenewing: true,
        inGracePeriod: false,
        environment: "production",
        originalTransactionId: "orig-web-2",
        lastStoreEventAt: new Date(),
        lastVerifiedAt: new Date(),
      },
      ownership: [{ platform: "apple", environment: "production", originalTransactionId: "orig-web-2" }],
    });
    const paid = fake.paySubscription({ customer, lookupKey: "web_yearly_standard" });
    await syncWebEntitlement(UID, deps);
    assert.equal((await read(slotRef(UID, "production"))).status, "active");
    const master = await read(masterRef(UID));
    assert.equal(master.platform, "web");
    assert.equal(master.environment, "production");
    assert.equal(master.purchaseReference, paid.subscriptionId);
    assert.ok(!("originalTransactionId" in master), "the Apple reference does not outlive the Apple master");
    assert.equal(master.sources.length, 2);
  });

  test("the store path refuses a web state, so only the sync writes the web slots", async () => {
    for (const environment of ["production", "test"]) {
      await assert.rejects(
        persistVerifiedSubscription(UID, {
          subscription: {
            active: true,
            status: "active",
            platform: "web",
            productId: "web_monthly",
            expiresAt: new Date(Date.now() + DAY * 1000),
            inGracePeriod: false,
            environment,
            lastStoreEventAt: new Date(),
            lastVerifiedAt: new Date(),
          },
          ownership: [],
        }),
        (error) => error.safeCode === "store-environment-unsupported"
      );
    }
    assert.equal(await read(slotRef(UID)), undefined);
  });

  test("a second sync writes nothing", async () => {
    const { fake, deps, customer } = await setup();
    fake.paySubscription({ customer });
    await syncWebEntitlement(UID, deps);
    const before = [await updateTimeOf(slotRef(UID)), await updateTimeOf(masterRef(UID))];
    const second = await syncWebEntitlement(UID, deps);
    assert.equal(second.outcome, "unchanged");
    assert.equal(second.ledgerUpdates, 0);
    assert.deepEqual([await updateTimeOf(slotRef(UID)), await updateTimeOf(masterRef(UID))], before);
  });

  test("an account with a tombstone, open or closed, or with no mapping, gets nothing written", async () => {
    const { fake, deps, customer } = await setup();
    fake.paySubscription({ customer });
    await db().collection(DELETED_ACCOUNTS_COLLECTION).doc(UID).set({ state: "deleted", closedAt: Timestamp.now() });
    assert.equal((await syncWebEntitlement(UID, deps)).outcome, "account_deleted");
    assert.equal(await read(slotRef(UID)), undefined);
    assert.equal(await read(masterRef(UID)), undefined);
    fake.resetCalls();
    assert.equal((await syncWebEntitlement(OTHER, deps)).outcome, "no_mapping");
    assert.deepEqual(fake.callNames(), [], "no Stripe call without a mapping");
    assert.equal(await read(masterRef(OTHER)), undefined);
  });

  test("a refund revokes the slot and cancels at Stripe; nothing left makes an existing slot expired", async () => {
    const { fake, deps, customer } = await setup();
    const paid = fake.paySubscription({ customer });
    await syncWebEntitlement(UID, deps);
    fake.refund(paid.chargeId);
    const revoked = await syncWebEntitlement(UID, deps);
    assert.deepEqual(revoked.cancelled, [paid.subscriptionId]);
    assert.equal((await read(slotRef(UID))).status, "revoked");
    assert.equal((await read(masterRef(UID))).active, false);
    assert.equal((await fake.retrieveSubscription(paid.subscriptionId)).status, "canceled");
    assert.equal((await syncWebEntitlement(UID, deps)).outcome, "unchanged", "the cancellation's own sync is a no-op");

    const { fake: other, deps: otherDeps, customer: otherCustomer } = await setup({ uid: OTHER });
    other.paySubscription({ customer: otherCustomer });
    await syncWebEntitlement(OTHER, otherDeps);
    await other.deleteCustomer(otherCustomer);
    assert.equal((await syncWebEntitlement(OTHER, otherDeps)).outcome, "written");
    const slot = await read(slotRef(OTHER));
    assert.deepEqual([slot.status, slot.active], ["expired", false]);
    assert.ok(slot.expiresAt.toMillis() <= Date.now());
  });

  test("lifetime bought over an active subscription cancels the subscription and holds for 50 years", async () => {
    const { fake, deps, customer } = await setup();
    const sub = fake.paySubscription({ customer });
    const life = fake.payLifetime({ customer });
    await writeLedger("life", { plan: "web_lifetime", status: "pending", stripe: { customerId: customer, invoiceId: life.invoiceId } });
    const result = await syncWebEntitlement(UID, deps);
    assert.deepEqual(result.cancelled, [sub.subscriptionId]);
    const master = await read(masterRef(UID));
    assert.equal(master.productId, "web_lifetime");
    assert.equal(master.expiresAt.toDate().getUTCFullYear(), new Date().getUTCFullYear() + 50);
    assert.equal((await read(db().collection(WEB_PURCHASES_COLLECTION).doc("life"))).status, "paid");
  });
});

describe("stripeWebEvents", () => {
  test("a replayed event is a no-op, and an event for an unmapped customer is ignored", async () => {
    const { fake, customer } = await setup();
    fake.paySubscription({ customer });
    const event = fake.state.events.find((row) => row.type === "invoice.paid");
    let syncs = 0;
    const sync = async (...args) => {
      syncs += 1;
      return syncWebEntitlement(...args);
    };
    assert.deepEqual(await webhook(fake, event, { sync }), { status: 200, body: { received: true, outcome: "synced" } });
    assert.equal((await read(slotRef(UID))).status, "active");
    assert.deepEqual(await webhook(fake, event, { sync }), { status: 200, body: { received: true, outcome: "duplicate" } });
    assert.equal(syncs, 1);
    const stored = await read(db().collection(WEB_STRIPE_EVENTS_COLLECTION).doc(event.id));
    assert.equal(stored.source, "webhook");
    assert.equal(stored.outcome, "synced_written");
    assert.ok(stored.expiresAt.toMillis() > Date.now() + 89 * DAY * 1000);

    const stranger = fake.addCustomer(OTHER);
    const foreign = fake.emit("invoice.paid", { object: "invoice", id: "in_x", customer: stranger });
    assert.equal((await webhook(fake, foreign, { sync })).body.outcome, "ignored");
    assert.equal(syncs, 1);
    assert.equal((await read(db().collection(WEB_STRIPE_EVENTS_COLLECTION).doc(foreign.id))).outcome, "ignored");
  });

  test("a dispute event reaches the account through its charge", async () => {
    const { fake, customer } = await setup();
    const paid = fake.paySubscription({ customer });
    fake.dispute(paid.chargeId, "needs_response");
    const event = fake.state.events.find((row) => row.type === "charge.dispute.created");
    assert.equal((await webhook(fake, event)).body.outcome, "synced");
    assert.equal((await read(slotRef(UID))).status, "revoked");
  });

  test("a failed sync releases the event and answers 500, so Stripe's retry handles it", async () => {
    const { fake, customer } = await setup();
    fake.paySubscription({ customer });
    const event = fake.state.events.find((row) => row.type === "invoice.paid");
    const failing = async () => {
      throw new Error("Firestore down");
    };
    assert.equal((await webhook(fake, event, { sync: failing })).status, 500);
    assert.equal(await read(db().collection(WEB_STRIPE_EVENTS_COLLECTION).doc(event.id)), undefined);
    assert.equal((await webhook(fake, event)).body.outcome, "synced");
  });
});

describe("reconcile", () => {
  test("the Stripe phase syncs a purchase whose events never arrived, then replays nothing", async () => {
    const { fake, deps, customer } = await setup();
    fake.paySubscription({ customer });
    const operationId = "op-web";
    const deadline = () => new Date(Date.now() + 30_000);
    const first = await runFeedPhase(stripeEventsPhase(deps, operationId), new Date(), deadline());
    assert.equal(first.completed, true);
    assert.ok(first.applied >= 1);
    assert.equal((await read(slotRef(UID))).status, "active");
    const state = await read(db().collection(SUBSCRIPTION_RECONCILE_COLLECTION).doc("stripe-events-test"));
    assert.ok(state.checkpointAt);

    // The next run starts at the checkpoint; replaying the same window is a no-op too.
    await db().collection(SUBSCRIPTION_RECONCILE_COLLECTION).doc("stripe-events-test").delete();
    const again = await runFeedPhase(stripeEventsPhase(deps, operationId), new Date(), deadline());
    assert.equal(again.applied, 0);
    assert.ok(again.skipped >= first.applied);
  });

  test("the Stripe phase pages through events with starting_after", async () => {
    const { fake, deps, customer } = await setup();
    for (let index = 0; index < 3; index++) fake.paySubscription({ customer });
    const phase = stripeEventsPhase(deps, "op-pages");
    const original = fake.listEvents;
    fake.listEvents = (params) => original({ ...params, limit: 2 });
    // Counted before the run: the first sync cancels the two older subscriptions as duplicates,
    // and the events that emits come after the listing.
    const handled = fake.state.events.filter((row) => HANDLED_WEB_EVENT_TYPES.includes(row.type));
    const summary = await runFeedPhase(phase, new Date(), new Date(Date.now() + 30_000));
    assert.equal(summary.completed, true);
    assert.ok(summary.pages >= 2);
    assert.equal(summary.processed, handled.length);
  });

  test("the pending sweep settles paid purchases and abandons ones unpaid for a day", async () => {
    const { fake, deps, customer } = await setup();
    const now = new Date();
    const ago = (minutes) => new Date(now.getTime() - minutes * MINUTE);
    const paid = fake.paySubscription({ customer });
    await writeLedger("paid-late", { createdAt: ago(20), stripe: { customerId: customer, subscriptionId: paid.subscriptionId, invoiceId: paid.invoiceId } });
    const young = fake.startSubscription({ customer });
    await writeLedger("young", { createdAt: ago(30), stripe: { customerId: customer, subscriptionId: young.subscriptionId, invoiceId: young.invoiceId } });
    const stale = fake.startSubscription({ customer });
    await writeLedger("stale", { createdAt: ago(25 * 60), stripe: { customerId: customer, subscriptionId: stale.subscriptionId, invoiceId: stale.invoiceId } });
    const draft = await fake.createInvoice({ customer, metadata: {} }, "inv_x");
    await writeLedger("draft", { plan: "web_lifetime", createdAt: ago(25 * 60), stripe: { customerId: customer, invoiceId: draft.id } });
    await writeLedger("no-invoice", { createdAt: ago(25 * 60), stripe: { customerId: customer } });
    await writeLedger("fresh", { createdAt: ago(5), stripe: { customerId: customer } });

    const summary = await sweepPendingWebPurchases(deps, { now, deadline: new Date(Date.now() + 30_000), operationId: "op-sweep" });
    assert.equal(summary.completed, true);
    assert.equal(summary.synced, 1, "one sync per account");
    const status = async (id) => (await read(db().collection(WEB_PURCHASES_COLLECTION).doc(id))).status;
    assert.equal(await status("paid-late"), "paid");
    assert.equal(await status("young"), "pending");
    assert.equal(await status("stale"), "abandoned");
    assert.equal((await fake.retrieveSubscription(stale.subscriptionId)).status, "canceled");
    assert.equal(await status("draft"), "abandoned");
    assert.equal(fake.state.invoices.has(draft.id), false, "the draft was deleted");
    assert.equal(await status("no-invoice"), "abandoned");
    assert.equal(await status("fresh"), "pending");
    assert.equal((await read(slotRef(UID))).status, "active");
  });
});

describe("throttle and config", () => {
  test("ten purchase attempts per uid a day; the eleventh counts nothing", async () => {
    const throttle = firestoreWebPurchaseThrottle(() => db());
    const nowMs = Date.now();
    for (let index = 0; index < 10; index++) await throttle.consume({ uid: UID, ip: "203.0.113.5", nowMs });
    await assert.rejects(throttle.consume({ uid: UID, ip: "203.0.113.5", nowMs }), WebPurchaseThrottledError);
    const counter = await read(db().collection(WEB_PURCHASE_THROTTLE_COLLECTION).doc(throttleUidDocId(UID)));
    assert.equal(counter.count, 10);
    assert.equal(counter.expiresAt.toMillis(), nowMs + DAY * 1000);
  });

  test("a stored config is read over the defaults", async () => {
    await db().collection("web_pricing").doc("config").set({ salesEnabled: true, testers: [UID], allowUnattestedSim: true });
    const config = await readWebPricingConfig(db());
    assert.equal(config.salesEnabled, true);
    assert.deepEqual(config.testers, [UID]);
    assert.equal(config.taxEnabled, false);
    assert.equal(config.tiers.low.prices.web_monthly, undefined);
  });
});

describe("account deletion", () => {
  const storage = { deleteByPrefix: async () => 0 };

  test("the Stripe customer is deleted, the mapping and throttle go, the ledger stays without the uid", async () => {
    const { fake, deps, customer } = await setup();
    const paid = fake.paySubscription({ customer });
    await writeLedger("kept", { status: "paid", stripe: { customerId: customer, subscriptionId: paid.subscriptionId, invoiceId: paid.invoiceId } });
    await syncWebEntitlement(UID, deps);
    await firestoreWebPurchaseThrottle(() => db()).consume({ uid: UID, nowMs: Date.now() });

    const result = await purgeAccount(UID, {
      firestore: db(),
      storage,
      now: Date.now,
      cancelWebSubscription: (uid) => deleteWebCustomer(uid, { firestore: db(), gateway: () => fake }),
    });
    assert.equal(result.ok, true, JSON.stringify(result.failedSteps));
    assert.equal((await fake.retrieveCustomer(customer)).deleted, true);
    assert.equal((await fake.retrieveSubscription(paid.subscriptionId)).status, "canceled");
    assert.equal(await read(db().collection(WEB_CUSTOMERS_COLLECTION).doc(UID)), undefined);
    assert.equal(await read(db().collection(WEB_PURCHASE_THROTTLE_COLLECTION).doc(throttleUidDocId(UID))), undefined);
    assert.equal(await read(slotRef(UID)), undefined);
    const ledger = await read(db().collection(WEB_PURCHASES_COLLECTION).doc("kept"));
    assert.ok(!("uid" in ledger));
    assert.ok(ledger.anonymised_at instanceof Timestamp);
    assert.equal(ledger.total, 499);

    // A later sync for the deleted account finds the tombstone and writes nothing.
    assert.equal((await syncWebEntitlement(UID, deps)).outcome, "account_deleted");
  });

  test("a failed Stripe deletion keeps the mapping for the next run", async () => {
    const { fake } = await setup();
    fake.failures.set("deleteCustomer", Object.assign(new Error("Stripe down"), { type: "api_error" }));
    const result = await purgeAccount(UID, {
      firestore: db(),
      storage,
      now: Date.now,
      cancelWebSubscription: (uid) => deleteWebCustomer(uid, { firestore: db(), gateway: () => fake }),
    });
    assert.equal(result.ok, false);
    assert.ok(result.failedSteps.includes("web_subscription"));
    assert.ok(await read(db().collection(WEB_CUSTOMERS_COLLECTION).doc(UID)));
  });

  test("an account with no web customer needs no Stripe key", async () => {
    const result = await purgeAccount(OTHER, {
      firestore: db(),
      storage,
      now: Date.now,
      cancelWebSubscription: (uid) => deleteWebCustomer(uid, { firestore: db(), gateway: () => assert.fail("no key needed") }),
    });
    assert.equal(result.ok, true, JSON.stringify(result.failedSteps));
  });
});
