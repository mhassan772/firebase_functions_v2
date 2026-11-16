// The five web purchase callables against the Firestore emulator, with the in-memory Stripe
// from test/helpers. Run with `npm run test:integration`; nothing here reaches Stripe.
const assert = require("node:assert/strict");
const { beforeEach, describe, test } = require("node:test");

assert.ok(process.env.FIRESTORE_EMULATOR_HOST, "FIRESTORE_EMULATOR_HOST must point at the emulator");

const { admin } = require("../../lib/config/admin");
const { Timestamp } = require("firebase-admin/firestore");
const { createFakeStripe, DAY } = require("../helpers/fakeStripeGateway");
const {
  stateDocumentId,
  SUBSCRIPTION_MASTER_COLLECTION,
  SUBSCRIPTION_STATE_COLLECTION,
} = require("../../lib/services/subscriptions/persistence");
const { WEB_CUSTOMERS_COLLECTION } = require("../../lib/services/webSubscriptions/customers");
const { ledgerEntryToData, purchaseIdFor, WEB_PURCHASES_COLLECTION } = require("../../lib/services/webSubscriptions/ledger");
const { firestoreWebPurchaseThrottle } = require("../../lib/services/webSubscriptions/purchaseThrottle");
const { createPriceLookup } = require("../../lib/services/webSubscriptions/pricing");
const { stopPendingStripeSide } = require("../../lib/services/webSubscriptions/pendingSweep");
const { WEB_GRACE_MS } = require("../../lib/services/webSubscriptions/sync");
const {
  handleFinishWebPurchase,
  handleGetWebPlans,
  handleStartWebPurchase,
} = require("../../lib/handlers/webPurchaseHandlers");
const { handleGetWebSubscription, handleManageWebSubscription } = require("../../lib/handlers/webManageHandlers");
const { reasonOf } = require("../../lib/utils/callableAuth");

const db = () => admin.firestore();
const UID = "WebPurchaserAaaaaaaaaa01";
const OTHER = "WebPurchaserBbbbbbbbbb02";
const CREATE_CALLS = ["createCustomer", "createSubscription", "createInvoice", "createInvoiceItem", "confirmPaymentIntent", "createSetupIntent"];

async function clearFirestore() {
  const response = await fetch(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-mantooq/databases/(default)/documents`,
    { method: "DELETE" }
  );
  assert.ok(response.ok, `clearing Firestore failed: ${response.status}`);
}
beforeEach(clearFirestore);

const read = async (ref) => {
  const snapshot = await ref.get();
  return snapshot.exists ? snapshot.data() : undefined;
};
const webSlotRef = (uid = UID, environment = "test") =>
  db().collection(SUBSCRIPTION_STATE_COLLECTION).doc(stateDocumentId(uid, "web", environment));
const ledgerRef = (id) => db().collection(WEB_PURCHASES_COLLECTION).doc(id);
const ledgerDocs = async () => (await db().collection(WEB_PURCHASES_COLLECTION).get()).docs.map((doc) => ({ id: doc.id, ...doc.data() }));

/** A test pricing map: SA is a low-tier country and AE a reduced one, as the sandbox script seeds. */
const TEST_COUNTRIES = { EG: "low", TR: "low", SA: "low", AE: "reduced", JO: "reduced" };

/**
 * A fake Stripe, the pricing config and the callable dependencies. `known` stands in for the
 * account's known countries (store country has its own tests).
 */
async function setup({ livemode = false, config = {}, known = { storePurchase: [] }, limits, taxFor } = {}) {
  const fake = createFakeStripe({ livemode, nowSec: Math.floor(Date.now() / 1000) - 60, taxFor });
  await db().collection("web_pricing").doc("config").set({
    salesEnabled: true,
    taxEnabled: false,
    testers: [UID, OTHER],
    countries: TEST_COUNTRIES,
    ...config,
  });
  const deps = {
    firestore: db(),
    gateway: fake,
    publishableKey: livemode ? "pk_live_fake" : "pk_test_fake",
    storeCountry: { knownCountries: async () => known },
    throttle: firestoreWebPurchaseThrottle(db, limits),
    now: () => new Date(),
    prices: createPriceLookup(fake),
  };
  return { fake, deps };
}

function caller(uid = UID, { provider = "password", verified = true, email = "buyer@example.com", ip = "203.0.113.7" } = {}) {
  return {
    auth: { uid, token: { email, email_verified: verified, firebase: { sign_in_provider: provider } } },
    rawRequest: { ip },
  };
}

async function refused(promise, code, reason) {
  try {
    await promise;
  } catch (error) {
    assert.equal(error.code, code, `code: ${error.code} ${reasonOf(error)} ${error.message}`);
    if (reason) assert.equal(reasonOf(error), reason);
    return error;
  }
  assert.fail(`expected ${code}/${reason}`);
}

const PRICES = { web_monthly: 499, web_yearly: 4999, web_lifetime: 14999 };

/** Buys `plan` through the callable with a fresh token; returns the answer and the token. */
async function buy(env, plan = "web_monthly", { token: tokenOptions = {}, acceptedTotal, uid = UID, context, extra = {} } = {}) {
  const token = env.fake.addToken({ setupFutureUsage: plan === "web_lifetime" ? null : "off_session", ...tokenOptions });
  const result = await handleStartWebPurchase(
    { plan, confirmationToken: token, acceptedTotal: acceptedTotal ?? PRICES[plan], lang: "en", ...extra },
    context ?? caller(uid),
    env.deps
  );
  return { result, token };
}

/** Moves a purchase and its lock `minutes` into the past. */
async function ageLock(purchaseId, minutes, uid = UID) {
  const then = Timestamp.fromMillis(Date.now() - minutes * 60 * 1000);
  await ledgerRef(purchaseId).update({ createdAt: then });
  await db().collection(WEB_CUSTOMERS_COLLECTION).doc(uid).update({ "activePurchase.startedAt": then });
}

const creates = (fake) => fake.callNames().filter((name) => CREATE_CALLS.includes(name));
const subscriptionsOf = (fake) => [...fake.state.subscriptions.values()];

async function seedStoreSlot(platform, { environment = "production", autoRenewing = true, active = true } = {}) {
  const now = Timestamp.now();
  await db().collection(SUBSCRIPTION_STATE_COLLECTION).doc(stateDocumentId(UID, platform, environment)).set({
    uid: UID,
    active,
    status: active ? "active" : "expired",
    platform,
    productId: "monthly_sub",
    expiresAt: Timestamp.fromMillis(Date.now() + (active ? 20 : -1) * DAY * 1000),
    inGracePeriod: false,
    environment,
    autoRenewing,
    lastStoreEventAt: now,
    lastVerifiedAt: now,
    createdAt: now,
    updatedAt: now,
  });
}

async function seedManualSlot({ days = 30 } = {}) {
  const now = Timestamp.now();
  await db().collection(SUBSCRIPTION_STATE_COLLECTION).doc(stateDocumentId(UID, "manual", "production")).set({
    uid: UID,
    active: true,
    status: "active",
    platform: "manual",
    productId: "manual_grant",
    expiresAt: Timestamp.fromMillis(Date.now() + days * DAY * 1000),
    inGracePeriod: false,
    environment: "production",
    autoRenewing: false,
    lastStoreEventAt: now,
    lastVerifiedAt: now,
    createdAt: now,
    updatedAt: now,
    manual: { activeGrantCount: 1, ledgerRevision: 1 },
  });
}

const acknowledged = { extra: { acknowledgeExisting: true } };

// ---------------------------------------------------------------------------

describe("getWebPlans", () => {
  test("an account with no known country gets the standard plans, the key and no blockers", async () => {
    const env = await setup();
    const plans = await handleGetWebPlans({ lang: "ar" }, caller(), env.deps);
    assert.deepEqual(plans, {
      publishableKey: "pk_test_fake",
      livemode: false,
      countryKnown: false,
      tier: "standard",
      plans: [
        { plan: "web_monthly", amount: 499, currency: "usd", interval: "month" },
        { plan: "web_yearly", amount: 4999, currency: "usd", interval: "year" },
        { plan: "web_lifetime", amount: 14999, currency: "usd", interval: null },
      ],
      taxEnabled: false,
      current: null,
      storeSubscription: null,
      blockers: [],
      premium: [],
    });
    assert.deepEqual(creates(env.fake), [], "nothing is created");
  });

  test("a low-tier account is offered yearly and lifetime only, at the low prices", async () => {
    const env = await setup({ known: { appReport: "EG", storePurchase: [] } });
    const plans = await handleGetWebPlans({}, caller(), env.deps);
    assert.equal(plans.tier, "low");
    assert.equal(plans.countryKnown, true);
    assert.deepEqual(plans.plans.map((row) => [row.plan, row.amount]), [["web_yearly", 1999], ["web_lifetime", 5999]]);
  });

  test("blockers and the store subscription: only an auto-renewing production store slot blocks", async () => {
    const env = await setup();
    await seedStoreSlot("apple", { environment: "sandbox" });
    let plans = await handleGetWebPlans({}, caller(), env.deps);
    assert.deepEqual(plans.blockers, []);
    assert.equal(plans.storeSubscription, null, "a sandbox slot is not a store subscription");
    await seedStoreSlot("google", { autoRenewing: false });
    plans = await handleGetWebPlans({}, caller(), env.deps);
    assert.deepEqual(plans.storeSubscription, { platform: "google", autoRenewing: false });
    assert.deepEqual(plans.blockers, []);
    await seedStoreSlot("apple");
    plans = await handleGetWebPlans({}, caller(), env.deps);
    assert.deepEqual(plans.storeSubscription, { platform: "apple", autoRenewing: true });
    assert.deepEqual(plans.blockers, ["store_subscription_active"]);
  });

  test("premium lists every source that gives premium now, sandbox store slots never", async () => {
    const env = await setup();
    await seedStoreSlot("apple", { environment: "sandbox" });
    assert.deepEqual((await handleGetWebPlans({}, caller(), env.deps)).premium, []);
    await seedManualSlot();
    await seedStoreSlot("google", { autoRenewing: false });
    await buy(env, "web_monthly", acknowledged);
    const plans = await handleGetWebPlans({}, caller(), env.deps);
    assert.deepEqual(plans.premium.map((row) => [row.source, row.kind, row.state, row.renews]), [
      ["web", "subscription", "active", true],
      ["google", "subscription", "cancelling", false],
      ["manual", "grant", "active", false],
    ]);
    assert.equal(plans.premium[0].plan, "web_monthly");
    assert.deepEqual(plans.blockers, ["already_subscribed"]);
  });

  test("a web subscription and a lifetime purchase show as current with their blockers", async () => {
    const env = await setup();
    await buy(env, "web_monthly");
    let plans = await handleGetWebPlans({}, caller(), env.deps);
    assert.deepEqual(plans.current, { state: "active", plan: "web_monthly" });
    assert.deepEqual(plans.blockers, ["already_subscribed"]);
    await buy(env, "web_lifetime");
    plans = await handleGetWebPlans({}, caller(), env.deps);
    assert.deepEqual(plans.current, { state: "lifetime", plan: "web_lifetime" });
    assert.deepEqual(plans.blockers, ["lifetime_active"]);
  });

  test("refusals: sales off, no key, a non-tester on a sandbox key, a key of the wrong mode, an unverified email, bad requests", async () => {
    const env = await setup({ config: { salesEnabled: false } });
    await refused(handleGetWebPlans({}, caller(), env.deps), "failed-precondition", "sales_disabled");
    const on = await setup();
    await refused(handleGetWebPlans({}, caller(), { ...on.deps, gateway: undefined }), "failed-precondition", "sales_disabled");
    await refused(handleGetWebPlans({}, caller("NotATester000000000000x"), on.deps), "failed-precondition", "sales_disabled");
    await refused(handleGetWebPlans({}, caller(), { ...on.deps, publishableKey: "pk_live_wrong" }), "failed-precondition", "sales_disabled");
    await refused(handleGetWebPlans({}, caller(), { ...on.deps, publishableKey: undefined }), "failed-precondition", "sales_disabled");
    await refused(handleGetWebPlans({}, caller(UID, { verified: false }), on.deps), "failed-precondition", "email_unverified");
    await refused(handleGetWebPlans({ lang: "en", extra: 1 }, caller(), on.deps), "invalid-argument", "invalid_request");
    await refused(handleGetWebPlans([], caller(), on.deps), "invalid-argument", "invalid_request");
    await refused(handleGetWebPlans({}, { auth: undefined }, on.deps), "unauthenticated", "signed_out");
    const live = await setup({ livemode: true, config: { testers: [] } });
    const plans = await handleGetWebPlans({}, caller("AnyoneOnLive00000000000x"), live.deps);
    assert.equal(plans.livemode, true, "a live key sells to everyone");
  });
});

// ---------------------------------------------------------------------------

describe("startWebPurchase", () => {
  test("monthly end to end: Stripe objects per recipe B4, the ledger paid, the slot and the master granting premium", async () => {
    const env = await setup();
    const { result, token } = await buy(env, "web_monthly");
    const purchaseId = purchaseIdFor(UID, token);
    assert.deepEqual(result, { status: "succeeded", purchaseId });

    const createSub = env.fake.calls.find((call) => call.name === "createSubscription");
    assert.equal(createSub.args.key, `sub_${purchaseId}`);
    assert.deepEqual(createSub.args.params.payment_settings, { save_default_payment_method: "on_subscription", payment_method_types: ["card"] });
    assert.equal(createSub.args.params.payment_behavior, "default_incomplete");
    assert.deepEqual(createSub.args.params.automatic_tax, { enabled: false });
    assert.deepEqual(createSub.args.params.metadata, { uid: UID, purchaseId, plan: "web_monthly", tier: "standard" });
    assert.equal(createSub.args.params.items[0].price, "price_web_monthly_standard");
    assert.equal(env.fake.calls.find((call) => call.name === "confirmPaymentIntent").args.key, `confirm_${purchaseId}`);
    assert.equal(env.fake.calls.find((call) => call.name === "createCustomer").args.key, `customer_${UID}`);
    const update = env.fake.calls.find((call) => call.name === "updateCustomer").args.params;
    assert.deepEqual(update, { address: { country: "US" }, preferred_locales: ["en"], email: "buyer@example.com" });

    const entry = await read(ledgerRef(purchaseId));
    assert.equal(entry.status, "paid");
    assert.equal(entry.uid, UID);
    assert.equal(entry.plan, "web_monthly");
    assert.equal(entry.tierShown, "standard");
    assert.equal(entry.tierCharged, "standard");
    assert.equal(entry.total, 499);
    assert.equal(entry.cardCountry, "US");
    assert.equal(entry.cardFunding, "credit");
    assert.equal(entry.billingCountry, "US");
    assert.equal(entry.lang, "en");
    assert.ok(entry.stripe.subscriptionId && entry.stripe.invoiceId && entry.stripe.paymentIntentId && entry.stripe.chargeId);
    assert.ok(!JSON.stringify(entry).includes("buyer@example.com"), "no email in the ledger");

    const slot = await read(webSlotRef());
    assert.equal(slot.status, "active");
    assert.equal(slot.productId, "web_monthly");
    assert.equal(slot.web.purchaseId, purchaseId);
    const master = await read(db().collection(SUBSCRIPTION_MASTER_COLLECTION).doc(UID));
    assert.equal(master.active, true);
    assert.equal(master.platform, "web");
    assert.equal((await read(db().collection(WEB_CUSTOMERS_COLLECTION).doc(UID))).testCustomerId, entry.stripe.customerId);
  });

  test("yearly and lifetime end to end; lifetime is a one-off invoice per recipe C8, cards only", async () => {
    const env = await setup();
    const yearly = await buy(env, "web_yearly");
    assert.equal(yearly.result.status, "succeeded");
    assert.equal((await read(webSlotRef())).productId, "web_yearly");

    const other = await setup();
    const { result, token } = await buy(other, "web_lifetime", { uid: OTHER });
    const purchaseId = purchaseIdFor(OTHER, token);
    assert.equal(result.status, "succeeded");
    const invoiceCall = other.fake.calls.find((call) => call.name === "createInvoice");
    assert.equal(invoiceCall.args.key, `inv_${purchaseId}`);
    assert.deepEqual(invoiceCall.args.params.payment_settings, { payment_method_types: ["card"] });
    assert.equal(invoiceCall.args.params.collection_method, "charge_automatically");
    assert.equal(invoiceCall.args.params.auto_advance, false);
    assert.equal(other.fake.calls.find((call) => call.name === "createInvoiceItem").args.key, `item_${purchaseId}`);
    assert.deepEqual(other.fake.calls.find((call) => call.name === "createInvoiceItem").args.params.pricing, { price: "price_web_lifetime_standard" });
    const slot = await read(webSlotRef(OTHER));
    assert.equal(slot.productId, "web_lifetime");
    assert.equal(slot.active, true);
    assert.equal(slot.expiresAt.toDate().getUTCFullYear() - new Date().getUTCFullYear(), 50);
    assert.equal((await read(ledgerRef(purchaseId))).status, "paid");
  });

  test("the server never trusts the page's total: a wrong one re-prices with nothing created and no ledger entry", async () => {
    const env = await setup();
    const { result } = await buy(env, "web_yearly", { acceptedTotal: 1 });
    assert.deepEqual(result, {
      status: "reprice",
      quote: { plan: "web_yearly", tier: "standard", amount: 4999, tax: 0, total: 4999, currency: "usd", reason: "price_changed" },
    });
    assert.deepEqual(creates(env.fake), []);
    assert.equal(env.fake.callNames().includes("updateCustomer"), false);
    assert.deepEqual(await ledgerDocs(), []);
  });

  test("re-price by card country: a low-tier account paying with a US card is quoted standard, then charged it once accepted", async () => {
    const env = await setup({ known: { appReport: "EG", storePurchase: [] } });
    const token = env.fake.addToken({ country: "US" });
    const request = { plan: "web_yearly", confirmationToken: token, acceptedTotal: 1999 };
    const first = await handleStartWebPurchase(request, caller(), env.deps);
    assert.deepEqual(first, {
      status: "reprice",
      quote: { plan: "web_yearly", tier: "standard", amount: 4999, tax: 0, total: 4999, currency: "usd", reason: "card_country" },
    });
    assert.deepEqual(creates(env.fake), []);
    assert.deepEqual(await ledgerDocs(), []);

    const second = await handleStartWebPurchase({ ...request, acceptedTotal: 4999 }, caller(), env.deps);
    assert.equal(second.status, "succeeded");
    const entry = await read(ledgerRef(second.purchaseId));
    assert.equal(entry.tierShown, "low");
    assert.equal(entry.tierCharged, "standard");
    assert.equal(entry.knownCountry, "EG");
    assert.equal(entry.total, 4999);
    assert.equal(env.fake.calls.find((call) => call.name === "createSubscription").args.params.items[0].price, "price_web_yearly_standard");
  });

  test("a cheaper card never lowers the known tier", async () => {
    const env = await setup({ known: { appReport: "US", storePurchase: ["AE"] } });
    const { result } = await buy(env, "web_yearly", { token: { country: "SA" } });
    assert.equal(result.status, "succeeded");
    assert.equal((await read(ledgerRef(result.purchaseId))).tierCharged, "standard");
  });

  test("re-price by tax, and by both; the accepted taxed total is charged and recorded", async () => {
    const taxFor = (address) => (address.country === "CA" ? 650 : 0);
    const env = await setup({ config: { taxEnabled: true }, taxFor });
    const token = env.fake.addToken({ country: "CA", billing: { country: "CA", state: "ON" } });
    const request = { plan: "web_yearly", confirmationToken: token, acceptedTotal: 4999 };
    const first = await handleStartWebPurchase(request, caller(), env.deps);
    assert.deepEqual(first.quote, { plan: "web_yearly", tier: "standard", amount: 4999, tax: 650, total: 5649, currency: "usd", reason: "tax" });
    assert.deepEqual(creates(env.fake), []);
    const second = await handleStartWebPurchase({ ...request, acceptedTotal: 5649 }, caller(), env.deps);
    assert.equal(second.status, "succeeded");
    const entry = await read(ledgerRef(second.purchaseId));
    assert.deepEqual([entry.amount, entry.tax, entry.total, entry.billingState], [4999, 650, 5649, "ON"]);
    assert.deepEqual(env.fake.calls.find((call) => call.name === "createSubscription").args.params.automatic_tax, { enabled: true });
    assert.deepEqual(env.fake.calls.find((call) => call.name === "updateCustomer").args.params.tax, { validate_location: "immediately" });

    const both = await setup({ config: { taxEnabled: true }, taxFor, known: { appReport: "EG", storePurchase: [] } });
    const quote = (await buy(both, "web_yearly", { uid: OTHER, acceptedTotal: 1999, token: { country: "CA", billing: { country: "CA", postal_code: "M5V 3L9" } } })).result.quote;
    assert.deepEqual(quote, { plan: "web_yearly", tier: "standard", amount: 4999, tax: 650, total: 5649, currency: "usd", reason: "both" });
  });

  test("billing address: no country, or Canada without a province or postal code while taxed, is incomplete; billingState fills the province", async () => {
    const env = await setup({ config: { taxEnabled: true } });
    const noCountry = env.fake.addToken({ billing: { country: null } });
    await refused(
      handleStartWebPurchase({ plan: "web_yearly", confirmationToken: noCountry, acceptedTotal: 4999 }, caller(), env.deps),
      "invalid-argument",
      "billing_address_incomplete"
    );
    const canada = env.fake.addToken({ country: "CA", billing: { country: "CA" } });
    await refused(
      handleStartWebPurchase({ plan: "web_yearly", confirmationToken: canada, acceptedTotal: 4999 }, caller(), env.deps),
      "invalid-argument",
      "billing_address_incomplete"
    );
    const filled = await handleStartWebPurchase(
      { plan: "web_yearly", confirmationToken: canada, acceptedTotal: 4999, billingState: "QC" },
      caller(),
      env.deps
    );
    assert.equal(filled.status, "succeeded");
    assert.equal((await read(ledgerRef(filled.purchaseId))).billingState, "QC");
  });

  test("a retried call with the same token lands on the same purchase and never charges twice", async () => {
    const env = await setup();
    const { result, token } = await buy(env, "web_monthly");
    const again = await handleStartWebPurchase({ plan: "web_monthly", confirmationToken: token, acceptedTotal: 499 }, caller(), env.deps);
    assert.deepEqual(again, result);
    assert.equal(env.fake.callNames().filter((name) => name === "confirmPaymentIntent").length, 1);
    assert.equal(env.fake.callNames().filter((name) => name === "createSubscription").length, 1);
    assert.equal(subscriptionsOf(env.fake).length, 1);
    assert.equal((await ledgerDocs()).length, 1);
    assert.equal([...env.fake.state.charges.values()].length, 1, "one charge");
  });

  test("a decline cancels the incomplete subscription, fails the entry with its category, and a retry repeats the answer", async () => {
    const env = await setup();
    const token = env.fake.addToken({ behavior: "decline", declineCode: "insufficient_funds" });
    const request = { plan: "web_monthly", confirmationToken: token, acceptedTotal: 499 };
    const error = await refused(handleStartWebPurchase(request, caller(), env.deps), "failed-precondition", "card_declined");
    assert.deepEqual(error.details, { reason: "card_declined", category: "insufficient_funds" });
    assert.equal(error.message, "The card was declined.", "Stripe's own message is not passed through");
    const [entry] = await ledgerDocs();
    assert.equal(entry.status, "failed");
    assert.equal(entry.failure, "insufficient_funds");
    const [subscription] = subscriptionsOf(env.fake);
    assert.equal(subscription.status, "canceled");
    assert.equal(env.fake.state.invoices.get(subscription.latest_invoice).status, "void", "no open invoice left");
    assert.equal(await read(webSlotRef()), undefined, "no access");

    env.fake.resetCalls();
    await refused(handleStartWebPurchase(request, caller(), env.deps), "failed-precondition", "card_declined");
    assert.deepEqual(creates(env.fake), [], "the retry creates and confirms nothing");
  });

  test("a lifetime decline voids the one-off invoice; each category is mapped", async () => {
    const env = await setup();
    const categories = { generic_decline: "declined", expired_card: "expired_card", incorrect_cvc: "incorrect_details", insufficient_funds: "insufficient_funds" };
    for (const [declineCode, category] of Object.entries(categories)) {
      const token = env.fake.addToken({ behavior: "decline", declineCode, setupFutureUsage: null });
      const error = await refused(
        handleStartWebPurchase({ plan: "web_lifetime", confirmationToken: token, acceptedTotal: 14999 }, caller(), env.deps),
        "failed-precondition",
        "card_declined"
      );
      assert.equal(error.details.category, category);
    }
    const invoices = [...env.fake.state.invoices.values()];
    assert.equal(invoices.length, 4);
    assert.ok(invoices.every((invoice) => invoice.status === "void"));
    assert.ok((await ledgerDocs()).every((entry) => entry.status === "failed"));
  });

  test("requires_action, then finishWebPurchase: pending until authenticated, then succeeded", async () => {
    const env = await setup();
    const { result } = await buy(env, "web_yearly", { token: { behavior: "requires_action" } });
    assert.equal(result.status, "requires_action");
    const entry = await read(ledgerRef(result.purchaseId));
    assert.equal(entry.status, "pending");
    assert.equal(result.clientSecret, env.fake.state.paymentIntents.get(entry.stripe.paymentIntentId).client_secret);
    assert.deepEqual(await handleFinishWebPurchase({ purchaseId: result.purchaseId }, caller(), env.deps), { status: "pending" });
    env.fake.completeAction(entry.stripe.paymentIntentId);
    assert.deepEqual(await handleFinishWebPurchase({ purchaseId: result.purchaseId }, caller(), env.deps), { status: "succeeded" });
    assert.equal((await read(ledgerRef(result.purchaseId))).status, "paid");
    assert.equal((await read(webSlotRef())).status, "active");
  });

  test("a failed authentication: finishWebPurchase fails the purchase and cancels its subscription", async () => {
    const env = await setup();
    const { result } = await buy(env, "web_monthly", { token: { behavior: "requires_action" } });
    const entry = await read(ledgerRef(result.purchaseId));
    env.fake.completeAction(entry.stripe.paymentIntentId, { succeed: false });
    assert.deepEqual(await handleFinishWebPurchase({ purchaseId: result.purchaseId }, caller(), env.deps), {
      status: "failed",
      category: "authentication_failed",
    });
    assert.equal((await read(ledgerRef(result.purchaseId))).status, "failed");
    assert.equal(env.fake.state.subscriptions.get(entry.stripe.subscriptionId).status, "canceled");
  });

  test("finishWebPurchase refuses another account's purchase and an unknown one alike", async () => {
    const env = await setup();
    const { result } = await buy(env, "web_monthly");
    await refused(handleFinishWebPurchase({ purchaseId: result.purchaseId }, caller(OTHER), env.deps), "not-found", "purchase_not_found");
    await refused(handleFinishWebPurchase({ purchaseId: "0".repeat(32) }, caller(), env.deps), "not-found", "purchase_not_found");
    await refused(handleFinishWebPurchase({ purchaseId: "nope" }, caller(), env.deps), "invalid-argument", "invalid_request");
  });

  test("lifetime bought while a web subscription is active: the subscription is cancelled once lifetime is paid", async () => {
    const env = await setup();
    const monthly = await buy(env, "web_monthly");
    const subscriptionId = (await read(ledgerRef(monthly.result.purchaseId))).stripe.subscriptionId;
    const lifetime = await buy(env, "web_lifetime");
    assert.equal(lifetime.result.status, "succeeded");
    assert.equal(env.fake.state.subscriptions.get(subscriptionId).status, "canceled");
    const slot = await read(webSlotRef());
    assert.equal(slot.productId, "web_lifetime");
    assert.equal(slot.active, true);
  });

  test("guards: lifetime_active, already_subscribed (active or cancelling), each before anything is created", async () => {
    const env = await setup();
    await buy(env, "web_monthly");
    env.fake.resetCalls();
    await refused(buy(env, "web_yearly"), "failed-precondition", "already_subscribed");
    await refused(buy(env, "web_monthly"), "failed-precondition", "already_subscribed");
    await handleManageWebSubscription({ action: "cancel" }, caller(), env.deps);
    env.fake.resetCalls();
    await refused(buy(env, "web_yearly"), "failed-precondition", "already_subscribed");
    assert.deepEqual(creates(env.fake), []);

    const other = await setup();
    await buy(other, "web_lifetime", { uid: OTHER });
    other.fake.resetCalls();
    await refused(buy(other, "web_yearly", { uid: OTHER }), "failed-precondition", "lifetime_active");
    await refused(buy(other, "web_lifetime", { uid: OTHER }), "failed-precondition", "lifetime_active");
    assert.deepEqual(creates(other.fake), []);
  });

  test("a past-due web subscription blocks a new one", async () => {
    const env = await setup();
    const { result } = await buy(env, "web_monthly");
    const subscriptionId = (await read(ledgerRef(result.purchaseId))).stripe.subscriptionId;
    env.fake.renew(subscriptionId, { paid: false });
    await refused(buy(env, "web_yearly"), "failed-precondition", "already_subscribed");
  });

  test("guards: an auto-renewing production store subscription blocks monthly and yearly with its platform, not lifetime", async () => {
    const env = await setup();
    await seedStoreSlot("google");
    const error = await refused(buy(env, "web_monthly"), "failed-precondition", "store_subscription_active");
    assert.deepEqual(error.details, { reason: "store_subscription_active", platform: "google" });
    await refused(buy(env, "web_yearly"), "failed-precondition", "store_subscription_active");
    assert.deepEqual(creates(env.fake), []);
    assert.equal((await buy(env, "web_lifetime", acknowledged)).result.status, "succeeded");
  });

  test("a store subscription that does not renew, or a sandbox one, does not block", async () => {
    const env = await setup();
    await seedStoreSlot("apple", { autoRenewing: false });
    await seedStoreSlot("google", { environment: "test" });
    assert.equal((await buy(env, "web_monthly", acknowledged)).result.status, "succeeded");
  });

  test("premium from a store or a manual grant needs acknowledgeExisting; refused without it, with nothing created and no ledger entry", async () => {
    const cases = [
      ["a manual grant", () => seedManualSlot(), "web_monthly", ["manual"]],
      ["a cancelled store subscription still running", () => seedStoreSlot("apple", { autoRenewing: false }), "web_yearly", ["apple"]],
      ["lifetime over a renewing store subscription", () => seedStoreSlot("google"), "web_lifetime", ["google"]],
    ];
    for (const [name, seed, plan, sources] of cases) {
      await clearFirestore();
      const env = await setup();
      await seed();
      const error = await refused(buy(env, plan), "failed-precondition", "existing_premium");
      assert.deepEqual(error.details.premium.map((row) => row.source), sources, name);
      assert.ok(error.details.premium.every((row) => typeof row.until === "string"), name);
      await refused(buy(env, plan, { extra: { acknowledgeExisting: false } }), "failed-precondition", "existing_premium");
      assert.deepEqual(env.fake.callNames(), [], `${name}: no Stripe call`);
      assert.deepEqual(await ledgerDocs(), [], `${name}: no ledger entry`);
      assert.equal((await buy(env, plan, acknowledged)).result.status, "succeeded", name);
    }
  });

  test("a web subscription alone needs no acknowledgement, and the flag never lifts a blocker", async () => {
    const env = await setup();
    await buy(env, "web_monthly");
    assert.equal((await buy(env, "web_lifetime")).result.status, "succeeded");
    await seedStoreSlot("google");
    await refused(buy(env, "web_yearly", acknowledged), "failed-precondition", "lifetime_active");
  });

  test("verified email: a password account needs email_verified; Google and Apple sign-ins count as verified", async () => {
    const env = await setup();
    await refused(buy(env, "web_monthly", { context: caller(UID, { verified: false }) }), "failed-precondition", "email_unverified");
    await refused(buy(env, "web_monthly", { context: caller(UID, { provider: "phone", verified: null, email: null }) }), "failed-precondition", "email_unverified");
    assert.deepEqual(creates(env.fake), []);
    assert.equal((await buy(env, "web_monthly", { context: caller(UID, { provider: "google.com", verified: null }) })).result.status, "succeeded");
    const apple = await setup();
    assert.equal((await buy(apple, "web_monthly", { uid: OTHER, context: caller(OTHER, { provider: "apple.com", verified: false }) })).result.status, "succeeded");
  });

  test("sales gate: off, no key, and the tester gate on a sandbox key; a live key sells to anyone", async () => {
    const off = await setup({ config: { salesEnabled: false } });
    await refused(buy(off, "web_monthly"), "failed-precondition", "sales_disabled");
    const env = await setup();
    await refused(buy(env, "web_monthly", { context: caller("NotATester000000000000x") }), "failed-precondition", "sales_disabled");
    await refused(buy({ ...env, deps: { ...env.deps, gateway: undefined } }, "web_monthly"), "failed-precondition", "sales_disabled");
    assert.deepEqual(creates(env.fake), []);
    const live = await setup({ livemode: true, config: { testers: [] } });
    const { result } = await buy(live, "web_monthly", { uid: OTHER });
    assert.equal(result.status, "succeeded");
    assert.equal((await read(webSlotRef(OTHER, "production"))).status, "active");
  });

  test("throttle by uid and by IP", async () => {
    const env = await setup({ limits: { uidPerWindow: 2, ipPerWindow: 3, windowMs: DAY * 1000 } });
    await buy(env, "web_yearly", { acceptedTotal: 1 });
    await buy(env, "web_yearly", { acceptedTotal: 1 });
    const error = await refused(buy(env, "web_yearly", { acceptedTotal: 1 }), "resource-exhausted", "throttled");
    assert.equal(error.details.limit, "uid_day");
    await buy(env, "web_yearly", { acceptedTotal: 1, uid: OTHER });
    const ip = await refused(buy(env, "web_yearly", { acceptedTotal: 1, uid: OTHER }), "resource-exhausted", "throttled");
    assert.equal(ip.details.limit, "ip_day");
  });

  test("token and card refusals: unknown, expired, used, wrong setup_future_usage, not a card", async () => {
    const env = await setup();
    const start = (token, plan = "web_monthly") =>
      handleStartWebPurchase({ plan, confirmationToken: token, acceptedTotal: PRICES[plan] }, caller(), env.deps);
    await refused(start("ctoken_doesnotexist"), "failed-precondition", "token_invalid");
    await refused(start(env.fake.addToken({ expiresInSec: 0 })), "failed-precondition", "token_invalid");
    const used = env.fake.addToken();
    env.fake.state.tokens.get(used).payment_intent = "pi_elsewhere";
    await refused(start(used), "failed-precondition", "token_invalid");
    await refused(start(env.fake.addToken({ setupFutureUsage: null })), "failed-precondition", "token_invalid");
    await refused(start(env.fake.addToken({ setupFutureUsage: "off_session" }), "web_lifetime"), "failed-precondition", "token_invalid");
    await refused(start(env.fake.addToken({ type: "link" })), "failed-precondition", "card_required");
    assert.deepEqual(creates(env.fake), []);
    assert.deepEqual(await ledgerDocs(), []);
  });

  test("plan_unavailable: monthly for a low-tier card on a low-tier account", async () => {
    const env = await setup({ known: { appReport: "EG", storePurchase: [] } });
    await refused(buy(env, "web_monthly", { token: { country: "SA" } }), "failed-precondition", "plan_unavailable");
    assert.deepEqual(creates(env.fake), []);
  });

  test("invalid requests", async () => {
    const env = await setup();
    const token = env.fake.addToken();
    const base = { plan: "web_monthly", confirmationToken: token, acceptedTotal: 499 };
    for (const data of [null, "x", [], { ...base, plan: "monthly" }, { ...base, acceptedTotal: -1 }, { ...base, acceptedTotal: 4.5 },
      { ...base, acceptedTotal: "499" }, { ...base, confirmationToken: "pm_123456" }, { ...base, extra: true }, { ...base, lang: "fr" },
      { plan: "web_monthly", acceptedTotal: 499 }]) {
      await refused(handleStartWebPurchase(data, caller(), env.deps), "invalid-argument", "invalid_request");
    }
    await refused(handleStartWebPurchase(base, { auth: { uid: UID, token: { firebase: { sign_in_provider: "anonymous" } } } }, env.deps), "unauthenticated", "anonymous");
  });

  test("Stripe's messages never reach the caller", async () => {
    const env = await setup();
    env.fake.failures.set("createSubscription", Object.assign(new Error("No such price: price_x; key sk_test_abc on cus_123"), { type: "StripeAPIError", code: "api_error" }));
    const error = await refused(buy(env, "web_monthly"), "internal");
    assert.equal(error.message, "Something went wrong. Try again later.");
    assert.equal(error.details, undefined);
  });

  test("pending purchases older than the lock are abandoned before a new charge: the incomplete subscription is cancelled", async () => {
    const env = await setup();
    const first = await buy(env, "web_monthly", { token: { behavior: "requires_action" } });
    const firstEntry = await read(ledgerRef(first.result.purchaseId));
    await ageLock(first.result.purchaseId, 11);
    const second = await buy(env, "web_yearly");
    assert.equal(second.result.status, "succeeded");
    assert.equal((await read(ledgerRef(first.result.purchaseId))).status, "abandoned");
    assert.equal(env.fake.state.subscriptions.get(firstEntry.stripe.subscriptionId).status, "canceled");
    assert.equal((await read(webSlotRef())).productId, "web_yearly");
  });

  test("an older pending purchase that turned out paid is synced, never cancelled, and blocks a second subscription", async () => {
    const env = await setup();
    const first = await buy(env, "web_monthly", { token: { behavior: "requires_action" } });
    const firstEntry = await read(ledgerRef(first.result.purchaseId));
    env.fake.completeAction(firstEntry.stripe.paymentIntentId);
    await refused(buy(env, "web_yearly"), "failed-precondition", "already_subscribed");
    assert.equal((await read(ledgerRef(first.result.purchaseId))).status, "paid");
    assert.equal(env.fake.state.subscriptions.get(firstEntry.stripe.subscriptionId).status, "active");
  });

  test("stopPendingStripeSide never cancels a subscription that started after its invoice was read", async () => {
    const env = await setup();
    const customer = env.fake.addCustomer(UID);
    const started = env.fake.startSubscription({ customer });
    env.fake.setSubscription(started.subscriptionId, { status: "active" });
    const paid = await stopPendingStripeSide(
      { firestore: db(), gateway: env.fake },
      { stripe: { customerId: customer, subscriptionId: started.subscriptionId, invoiceId: started.invoiceId } }
    );
    assert.equal(paid, true);
    assert.equal(env.fake.callNames().includes("cancelSubscription"), false);
  });
});

// ---------------------------------------------------------------------------

describe("getWebSubscription", () => {
  const get = (env, uid = UID) => handleGetWebSubscription({}, caller(uid), env.deps);

  test("none, then active with its renewal, amount and card", async () => {
    const env = await setup();
    assert.deepEqual(await get(env), { state: "none", storeSubscription: null, livemode: false, publishableKey: "pk_test_fake" });
    // A key of the other mode is never handed to the page; the state is still readable.
    assert.deepEqual(await handleGetWebSubscription({}, caller(), { ...env.deps, publishableKey: "pk_live_wrong" }), {
      state: "none",
      storeSubscription: null,
      livemode: false,
    });
    const { result } = await buy(env, "web_monthly", { token: { brand: "mastercard" } });
    const state = await get(env);
    const slot = await read(webSlotRef());
    assert.deepEqual(state, {
      state: "active",
      plan: "web_monthly",
      purchaseId: result.purchaseId,
      renewsAt: slot.web.paidThrough.toDate().toISOString(),
      amount: 499,
      currency: "usd",
      card: { brand: "mastercard", last4: "4242" },
      storeSubscription: null,
      livemode: false,
      publishableKey: "pk_test_fake",
    });
  });

  test("cancelling, payment_failed, needs_action and ended", async () => {
    const env = await setup();
    const { result } = await buy(env, "web_monthly");
    const subscriptionId = (await read(ledgerRef(result.purchaseId))).stripe.subscriptionId;
    await handleManageWebSubscription({ action: "cancel" }, caller(), env.deps);
    const cancelling = await get(env);
    assert.equal(cancelling.state, "cancelling");
    assert.equal(cancelling.endsAt, (await read(webSlotRef())).web.paidThrough.toDate().toISOString());
    await handleManageWebSubscription({ action: "resume" }, caller(), env.deps);

    env.fake.advance(31 * DAY);
    env.fake.renew(subscriptionId, { paid: false });
    const failed = await get(env);
    assert.equal(failed.state, "payment_failed");
    const slot = await read(webSlotRef());
    assert.equal(slot.status, "grace_period");
    assert.equal(slot.expiresAt.toMillis(), slot.web.paidThrough.toMillis() + WEB_GRACE_MS);

    const other = await setup();
    const bought = await buy(other, "web_monthly", { uid: OTHER });
    const otherSub = (await read(ledgerRef(bought.result.purchaseId))).stripe.subscriptionId;
    other.fake.renew(otherSub, { paid: false, requiresAction: true });
    assert.equal((await get(other, OTHER)).state, "needs_action");
    await other.fake.cancelSubscription(otherSub);
    const ended = await get(other, OTHER);
    assert.equal(ended.state, "ended");
    assert.equal(ended.card, undefined);
  });

  test("lifetime with what it cost and when it ends; the store subscription is reported", async () => {
    const env = await setup();
    await seedStoreSlot("apple");
    await buy(env, "web_lifetime", acknowledged);
    const state = await get(env);
    assert.equal(state.state, "lifetime");
    assert.equal(state.amount, 14999);
    assert.equal(new Date(state.endsAt).getUTCFullYear() - new Date().getUTCFullYear(), 50);
    assert.deepEqual(state.storeSubscription, { platform: "apple", autoRenewing: true });
  });

  test("works with sales off (a buyer can always see and cancel), but not for a non-tester on a sandbox key", async () => {
    const env = await setup();
    await buy(env, "web_monthly");
    await db().collection("web_pricing").doc("config").update({ salesEnabled: false });
    assert.equal((await get(env)).state, "active");
    await handleManageWebSubscription({ action: "cancel" }, caller(), env.deps);
    assert.equal((await get(env)).state, "cancelling");
    await refused(get(env, "NotATester000000000000x"), "failed-precondition", "sales_disabled");
    await refused(handleGetWebSubscription({ x: 1 }, caller(), env.deps), "invalid-argument", "invalid_request");
  });
});

// ---------------------------------------------------------------------------

describe("manageWebSubscription", () => {
  const manage = (env, data, uid = UID) => handleManageWebSubscription(data, caller(uid), env.deps);
  const subscriptionOf = async (purchaseId, fake) => fake.state.subscriptions.get((await read(ledgerRef(purchaseId))).stripe.subscriptionId);

  test("cancel then resume, each synced to the slot", async () => {
    const env = await setup();
    const { result } = await buy(env, "web_monthly");
    assert.deepEqual(await manage(env, { action: "cancel" }), { status: "succeeded" });
    assert.equal((await subscriptionOf(result.purchaseId, env.fake)).cancel_at_period_end, true);
    let slot = await read(webSlotRef());
    assert.equal(slot.status, "canceled");
    assert.equal(slot.active, true);
    assert.equal(slot.autoRenewing, false);
    assert.deepEqual(await manage(env, { action: "resume" }), { status: "succeeded" });
    slot = await read(webSlotRef());
    assert.equal(slot.status, "active");
    assert.equal(slot.autoRenewing, true);
  });

  test("no_subscription: no customer, lifetime only, an ended subscription", async () => {
    const env = await setup();
    await refused(manage(env, { action: "cancel" }), "failed-precondition", "no_subscription");
    await buy(env, "web_lifetime");
    await refused(manage(env, { action: "cancel" }), "failed-precondition", "no_subscription");
    const other = await setup();
    const { result } = await buy(other, "web_monthly", { uid: OTHER });
    await other.fake.cancelSubscription((await read(ledgerRef(result.purchaseId))).stripe.subscriptionId);
    await refused(manage(other, { action: "resume" }, OTHER), "failed-precondition", "no_subscription");
  });

  test("authenticate returns the waiting renewal's client secret; finishWebPurchase then settles it", async () => {
    const env = await setup();
    const { result } = await buy(env, "web_monthly");
    await refused(manage(env, { action: "authenticate" }), "failed-precondition", "no_action_required");
    const subscriptionId = (await read(ledgerRef(result.purchaseId))).stripe.subscriptionId;
    const renewal = env.fake.renew(subscriptionId, { paid: false, requiresAction: true });
    const answer = await manage(env, { action: "authenticate" });
    assert.deepEqual(answer, {
      clientSecret: env.fake.state.paymentIntents.get(renewal.paymentIntentId).client_secret,
      purchaseId: result.purchaseId,
    });
    env.fake.completeAction(renewal.paymentIntentId);
    assert.deepEqual(await handleFinishWebPurchase({ purchaseId: answer.purchaseId }, caller(), env.deps), { status: "succeeded" });
    assert.equal((await handleGetWebSubscription({}, caller(), env.deps)).state, "active");
  });

  test("replace_card with a dearer-tier card: re-priced first with no SetupIntent, then one update moves the price without proration", async () => {
    const env = await setup({ known: { appReport: "AE", storePurchase: [] } });
    const { result } = await buy(env, "web_monthly", { token: { country: "AE" }, acceptedTotal: 399 });
    assert.equal(result.status, "succeeded");
    const subscription = await subscriptionOf(result.purchaseId, env.fake);
    assert.equal(subscription.items.data[0].price.lookup_key, "web_monthly_reduced");

    env.fake.resetCalls();
    const token = env.fake.addToken({ country: "US" });
    const quote = await manage(env, { action: "replace_card", confirmationToken: token });
    assert.deepEqual(quote, {
      status: "reprice",
      quote: { plan: "web_monthly", tier: "standard", amount: 499, tax: 0, total: 499, currency: "usd", reason: "card_country" },
    });
    assert.deepEqual(creates(env.fake), [], "no SetupIntent before the new price is accepted");
    assert.deepEqual(await manage(env, { action: "replace_card", confirmationToken: token, acceptedRenewalAmount: 399 }), quote);

    env.fake.resetCalls();
    assert.deepEqual(await manage(env, { action: "replace_card", confirmationToken: token, acceptedRenewalAmount: 499 }), { status: "succeeded" });
    const updates = env.fake.calls.filter((call) => call.name === "updateSubscription");
    assert.equal(updates.length, 1, "one subscriptions.update");
    const params = updates[0].args.params;
    const after = env.fake.state.subscriptions.get(subscription.id);
    assert.equal(params.default_payment_method, after.default_payment_method);
    assert.equal(params.items[0].price, "price_web_monthly_standard");
    assert.equal(params.items[0].id, subscription.items.data[0].id);
    assert.equal(params.proration_behavior, "none");
    assert.equal(after.items.data[0].price.lookup_key, "web_monthly_standard");
    const setupCall = env.fake.calls.find((call) => call.name === "createSetupIntent").args;
    assert.equal(setupCall.params.usage, "off_session");
    assert.deepEqual(setupCall.params.allowed_payment_method_types, ["card"]);
    assert.equal(setupCall.params.customer, after.customer);
    assert.equal(env.fake.state.paymentMethods.get(after.default_payment_method).card.country, "US");
    assert.equal((await read(webSlotRef())).web.tier, "standard");
  });

  test("replace_card with a same-or-cheaper tier card changes only the card", async () => {
    const env = await setup();
    const { result } = await buy(env, "web_monthly");
    for (const country of ["GB", "AE", "SA"]) {
      env.fake.resetCalls();
      assert.deepEqual(await manage(env, { action: "replace_card", confirmationToken: env.fake.addToken({ country }), acceptedRenewalAmount: 1 }), { status: "succeeded" });
      const [update] = env.fake.calls.filter((call) => call.name === "updateSubscription");
      assert.deepEqual(Object.keys(update.args.params), ["default_payment_method"]);
    }
    assert.equal((await subscriptionOf(result.purchaseId, env.fake)).items.data[0].price.lookup_key, "web_monthly_standard");
  });

  test("replace_card on a past-due subscription pays the open invoice with the new card", async () => {
    const env = await setup();
    const { result } = await buy(env, "web_monthly");
    const subscriptionId = (await read(ledgerRef(result.purchaseId))).stripe.subscriptionId;
    env.fake.advance(31 * DAY);
    const renewal = env.fake.renew(subscriptionId, { paid: false });
    assert.equal((await handleGetWebSubscription({}, caller(), env.deps)).state, "payment_failed");
    assert.deepEqual(await manage(env, { action: "replace_card", confirmationToken: env.fake.addToken() }), { status: "succeeded" });
    const pay = env.fake.calls.find((call) => call.name === "payInvoice");
    assert.equal(pay.args.id, renewal.invoiceId);
    assert.equal(pay.args.params.payment_method, env.fake.state.subscriptions.get(subscriptionId).default_payment_method);
    assert.equal(env.fake.state.invoices.get(renewal.invoiceId).status, "paid");
    assert.equal((await read(webSlotRef())).status, "active");

    const other = await setup();
    const bought = await buy(other, "web_monthly", { uid: OTHER });
    other.fake.advance(31 * DAY);
    other.fake.renew((await read(ledgerRef(bought.result.purchaseId))).stripe.subscriptionId, { paid: false });
    const declined = await refused(
      manage(other, { action: "replace_card", confirmationToken: other.fake.addToken({ failsCharges: true }) }, OTHER),
      "failed-precondition",
      "card_declined"
    );
    assert.equal(declined.details.category, "insufficient_funds");
  });

  test("replace_card that needs authentication, then finish_replace_card; another customer's SetupIntent is refused", async () => {
    const env = await setup();
    await buy(env, "web_monthly");
    const answer = await manage(env, { action: "replace_card", confirmationToken: env.fake.addToken({ behavior: "requires_action", country: "GB" }) });
    assert.equal(answer.status, "requires_action");
    assert.match(answer.setupIntentId, /^seti_/);
    assert.equal(answer.clientSecret, env.fake.state.setupIntents.get(answer.setupIntentId).client_secret);
    assert.deepEqual(await manage(env, { action: "finish_replace_card", setupIntentId: answer.setupIntentId }), answer, "still waiting");
    env.fake.completeSetupAction(answer.setupIntentId);
    assert.deepEqual(await manage(env, { action: "finish_replace_card", setupIntentId: answer.setupIntentId }), { status: "succeeded" });

    const other = await setup();
    await buy(other, "web_monthly", { uid: OTHER });
    const foreignCustomer = other.fake.addCustomer("SomeoneElse");
    const foreign = await other.fake.createSetupIntent(
      { customer: foreignCustomer, usage: "off_session", confirm: true, confirmation_token: other.fake.addToken() },
      "seti_foreign"
    );
    other.fake.resetCalls();
    await refused(manage(other, { action: "finish_replace_card", setupIntentId: foreign.id }, OTHER), "not-found", "setup_intent_not_found");
    assert.equal(other.fake.callNames().includes("updateSubscription"), false);
    await refused(manage(other, { action: "finish_replace_card", setupIntentId: "seti_missing000" }, OTHER), "not-found", "setup_intent_not_found");
  });

  test("replace_card refusals: declined, token_invalid, card_required, throttled; bad requests", async () => {
    const env = await setup({ limits: { uidPerWindow: 4, ipPerWindow: 100, windowMs: DAY * 1000 } });
    await buy(env, "web_monthly");
    const declined = await refused(
      manage(env, { action: "replace_card", confirmationToken: env.fake.addToken({ behavior: "decline", declineCode: "expired_card" }) }),
      "failed-precondition",
      "card_declined"
    );
    assert.equal(declined.details.category, "expired_card");
    await refused(manage(env, { action: "replace_card", confirmationToken: env.fake.addToken({ setupFutureUsage: null }) }), "failed-precondition", "token_invalid");
    await refused(manage(env, { action: "replace_card", confirmationToken: env.fake.addToken({ type: "link" }) }), "failed-precondition", "card_required");
    await refused(manage(env, { action: "replace_card", confirmationToken: env.fake.addToken() }), "resource-exhausted", "throttled");
    for (const data of [{ action: "pause" }, { action: "cancel", subscriptionId: "sub_x" }, { action: "replace_card" },
      { action: "finish_replace_card", setupIntentId: "pi_123456" }, {}, null]) {
      await refused(manage(env, data), "invalid-argument", "invalid_request");
    }
  });
});

// ---------------------------------------------------------------------------
// Switching monthly to yearly (stage I)
// ---------------------------------------------------------------------------

const { billingNotifier, WEB_EMAIL_OUTBOX_COLLECTION } = require("../../lib/services/webSubscriptions/billingEmails");
const { sweepPendingWebPurchases } = require("../../lib/services/webSubscriptions/pendingSweep");

describe("switch to yearly", () => {
  const manage = (env, data, uid = UID) => handleManageWebSubscription(data, caller(uid), env.deps);
  const outboxRows = async () => (await db().collection(WEB_EMAIL_OUTBOX_COLLECTION).get()).docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  let attempts = 0;
  const attemptId = () => `attempt-${Date.now()}-${++attempts}-aaaaaaaa`;

  /** A monthly purchase ten days in, with the billing emails queued as live; `card` replaces its saved card. */
  async function monthly(options = {}, card) {
    const env = await setup(options);
    env.deps.notify = billingNotifier(db());
    const { result } = await buy(env, "web_monthly", { token: { country: "CA", billing: { country: "CA", state: "ON" } } });
    assert.equal(result.status, "succeeded");
    const subscriptionId = (await read(ledgerRef(result.purchaseId))).stripe.subscriptionId;
    if (card) env.fake.setDefaultCard(subscriptionId, card);
    env.fake.advance(10 * DAY);
    return { env, monthlyId: result.purchaseId, subscriptionId, sub: () => env.fake.state.subscriptions.get(subscriptionId) };
  }
  const switchCall = (env, quote, id = attemptId(), uid = UID) =>
    manage(env, { action: "switch_yearly", acceptedTotal: quote.total, attemptId: id, lang: "ar" }, uid);
  const updates = (fake) => fake.calls.filter((call) => call.name === "updateSubscription");

  test("the quote: the yearly price, the unused days as a credit, the total, a year from now and the card; nothing written", async () => {
    const { env, sub } = await monthly();
    const period = sub().items.data[0];
    const credit = Math.round((499 * (period.current_period_end - env.fake.nowSec)) / (period.current_period_end - period.current_period_start));
    const ledgerBefore = await ledgerDocs();
    env.fake.resetCalls();
    const answer = await manage(env, { action: "quote_switch_yearly" });
    assert.equal(answer.status, "quote");
    const yearEnd = new Date(env.fake.nowSec * 1000);
    yearEnd.setUTCFullYear(yearEnd.getUTCFullYear() + 1);
    assert.deepEqual(answer.quote, {
      plan: "web_yearly", tier: "standard", amount: 4999, credit, tax: 0, total: 4999 - credit, currency: "usd",
      renewsAt: yearEnd.toISOString(), card: { brand: "visa", last4: "4242" },
    });
    const [preview] = env.fake.calls.filter((call) => call.name === "createInvoicePreview");
    assert.deepEqual(preview.args.params.subscription_details, {
      items: [{ id: period.id, price: "price_web_yearly_standard" }],
      proration_behavior: "always_invoice",
      billing_cycle_anchor: { type: "now" },
      cancel_at_period_end: false,
    });
    assert.deepEqual(updates(env.fake), []);
    assert.deepEqual(await ledgerDocs(), ledgerBefore);
  });

  test("a switch that succeeds: one update, the slot yearly to the yearly end with renewal on, the entry paid, one switched_yearly email", async () => {
    const { env, monthlyId, subscriptionId, sub } = await monthly();
    const { quote } = await manage(env, { action: "quote_switch_yearly" });
    env.fake.resetCalls();
    const answer = await switchCall(env, quote);
    assert.equal(answer.status, "succeeded");
    const purchaseId = answer.purchaseId;
    const [update] = updates(env.fake);
    assert.equal(updates(env.fake).length, 1);
    assert.equal(update.args.key, `switch_${purchaseId}`);
    assert.deepEqual(update.args.params, {
      items: [{ id: sub().items.data[0].id, price: "price_web_yearly_standard" }],
      proration_behavior: "always_invoice",
      billing_cycle_anchor: { type: "now" },
      cancel_at_period_end: false,
      payment_behavior: "pending_if_incomplete",
      metadata: { plan: "web_yearly", tier: "standard", purchaseId },
      expand: ["latest_invoice.payments"],
    });
    const invoice = env.fake.state.invoices.get(sub().latest_invoice);
    assert.equal(invoice.billing_reason, "subscription_update");
    const yearlyEnd = invoice.lines.data[1].period.end;

    const slot = await read(webSlotRef());
    assert.equal(slot.productId, "web_yearly");
    assert.equal(slot.status, "active");
    assert.equal(slot.autoRenewing, true);
    assert.equal(slot.web.plan, "web_yearly");
    assert.equal(slot.web.purchaseId, purchaseId);
    assert.equal(slot.web.paidThrough.toMillis(), yearlyEnd * 1000);
    assert.equal(slot.web.cancelAtPeriodEnd, false);

    const entry = await read(ledgerRef(purchaseId));
    assert.equal(entry.status, "paid");
    assert.equal(entry.kind, "switch");
    assert.equal(entry.switchedFrom, "web_monthly");
    assert.equal(entry.plan, "web_yearly");
    assert.deepEqual([entry.amount, entry.credit, entry.tax, entry.total], [4999, quote.credit, 0, invoice.total]);
    assert.deepEqual([entry.billingCountry, entry.billingState, entry.lang], ["CA", "ON", "ar"], "billing copied from the monthly purchase");
    assert.deepEqual(entry.stripe, { customerId: sub().customer, subscriptionId, invoiceId: invoice.id, paymentIntentId: invoice.payments[0].payment.payment_intent, chargeId: entry.stripe.chargeId });
    assert.equal((await read(ledgerRef(monthlyId))).status, "paid", "the monthly purchase stays as it was");

    const rows = await outboxRows();
    assert.deepEqual(rows.map((row) => row.id).sort(), [`confirmed_${monthlyId}`, `switched_${purchaseId}`].sort());
    const email = rows.find((row) => row.kind === "switched_yearly");
    assert.deepEqual([email.lang, email.plan, email.amount, email.credit, email.tax, email.total, email.currency],
      ["ar", "web_yearly", 4999, quote.credit, 0, invoice.total, "usd"]);
    assert.equal(email.renewsAt.toMillis(), yearlyEnd * 1000);

    const view = await handleGetWebSubscription({}, caller(), env.deps);
    assert.deepEqual([view.state, view.plan, view.amount], ["active", "web_yearly", 4999]);
    // A second sync, and the purchase lock released.
    await syncWebEntitlement(UID, { firestore: db(), gateway: env.fake, notify: env.deps.notify });
    assert.equal((await outboxRows()).length, 2);
  });

  test("a stale acceptedTotal re-prices with a fresh quote; nothing is written or charged", async () => {
    const { env } = await monthly();
    const { quote } = await manage(env, { action: "quote_switch_yearly" });
    const before = await ledgerDocs();
    env.fake.resetCalls();
    const answer = await switchCall(env, { total: quote.total + 1 });
    assert.deepEqual(answer, { status: "reprice", quote });
    assert.deepEqual(updates(env.fake), []);
    assert.deepEqual(await ledgerDocs(), before);
    assert.equal((await read(webSlotRef())).productId, "web_monthly");
  });

  test("a decline leaves the slot monthly with its dates, voids the invoice at once and fails the entry", async () => {
    const { env, sub } = await monthly({}, { failsCharges: true, declineCode: "insufficient_funds" });
    const slotBefore = await read(webSlotRef());
    const { quote } = await manage(env, { action: "quote_switch_yearly" });
    const id = attemptId();
    const declined = await refused(switchCall(env, quote, id), "failed-precondition", "card_declined");
    assert.equal(declined.details.category, "insufficient_funds");
    const invoice = env.fake.state.invoices.get(sub().latest_invoice);
    assert.equal(invoice.billing_reason, "subscription_update");
    assert.equal(invoice.status, "void");
    assert.equal(sub().pending_update, null);
    assert.equal(sub().items.data[0].price.lookup_key, "web_monthly_standard");
    const slot = await read(webSlotRef());
    assert.equal(slot.productId, "web_monthly");
    assert.equal(slot.web.paidThrough.toMillis(), slotBefore.web.paidThrough.toMillis());
    assert.equal(slot.web.purchaseId, slotBefore.web.purchaseId);
    const entry = (await ledgerDocs()).find((row) => row.kind === "switch");
    assert.deepEqual([entry.status, entry.failure], ["failed", "insufficient_funds"]);
    assert.deepEqual((await outboxRows()).map((row) => row.kind), ["purchase_confirmed"]);
    // The same attempt again repeats the answer without a second charge.
    env.fake.resetCalls();
    await refused(switchCall(env, quote, id), "failed-precondition", "card_declined");
    assert.deepEqual(updates(env.fake), []);
  });

  test("a bank step: requires_action with the PaymentIntent's secret, still waiting, then finished; no needs_action meanwhile", async () => {
    const { env, sub } = await monthly({}, { requiresAction: true });
    const { quote } = await manage(env, { action: "quote_switch_yearly" });
    const answer = await switchCall(env, quote);
    assert.equal(answer.status, "requires_action");
    const invoice = env.fake.state.invoices.get(sub().latest_invoice);
    const pi = env.fake.state.paymentIntents.get(invoice.payments[0].payment.payment_intent);
    assert.equal(answer.clientSecret, pi.client_secret);

    assert.equal((await read(webSlotRef())).web.needsAction, false);
    assert.equal((await handleGetWebSubscription({}, caller(), env.deps)).state, "active");
    await refused(manage(env, { action: "authenticate" }), "failed-precondition", "no_action_required");
    assert.deepEqual(await manage(env, { action: "finish_switch_yearly", purchaseId: answer.purchaseId }), answer, "still waiting");
    await refused(switchCall(env, quote), "failed-precondition", "purchase_in_progress");

    env.fake.completeAction(pi.id);
    assert.deepEqual(await manage(env, { action: "finish_switch_yearly", purchaseId: answer.purchaseId }), { status: "succeeded", purchaseId: answer.purchaseId });
    const slot = await read(webSlotRef());
    assert.equal(slot.productId, "web_yearly");
    assert.equal(slot.web.paidThrough.toMillis(), invoice.lines.data[1].period.end * 1000);
    assert.equal((await read(ledgerRef(answer.purchaseId))).status, "paid");
    assert.equal((await outboxRows()).filter((row) => row.kind === "switched_yearly").length, 1);
  });

  test("a failed bank step voids the invoice and is refused as a decline", async () => {
    const { env, sub } = await monthly({}, { requiresAction: true });
    const { quote } = await manage(env, { action: "quote_switch_yearly" });
    const answer = await switchCall(env, quote);
    const invoiceId = sub().latest_invoice;
    env.fake.completeAction(env.fake.state.invoices.get(invoiceId).payments[0].payment.payment_intent, { succeed: false });
    const declined = await refused(manage(env, { action: "finish_switch_yearly", purchaseId: answer.purchaseId }), "failed-precondition", "card_declined");
    assert.equal(declined.details.category, "authentication_failed");
    assert.equal(env.fake.state.invoices.get(invoiceId).status, "void");
    assert.equal((await read(ledgerRef(answer.purchaseId))).status, "failed");
    assert.equal((await read(webSlotRef())).productId, "web_monthly");
    await refused(manage(env, { action: "finish_switch_yearly", purchaseId: "f".repeat(32) }), "not-found", "purchase_not_found");
  });

  test("an abandoned bank step is swept after 15 minutes: the invoice voided, the entry failed, the plan monthly", async () => {
    const { env, sub } = await monthly({}, { requiresAction: true });
    const { quote } = await manage(env, { action: "quote_switch_yearly" });
    const answer = await switchCall(env, quote);
    const invoiceId = sub().latest_invoice;
    await ageLock(answer.purchaseId, 20);
    const summary = await sweepPendingWebPurchases({ firestore: db(), gateway: env.fake, now: () => new Date() }, {
      now: new Date(), deadline: new Date(Date.now() + 60_000), operationId: "sweep",
    });
    assert.equal(summary.abandoned, 1);
    assert.equal(env.fake.state.invoices.get(invoiceId).status, "void");
    assert.equal(sub().pending_update, null);
    const entry = await read(ledgerRef(answer.purchaseId));
    assert.deepEqual([entry.status, entry.failure], ["failed", "not_completed"]);
    assert.equal((await read(webSlotRef())).productId, "web_monthly");
  });

  test("the sweep resolves an entry the call left without its invoice: named by the subscription only once paid", async () => {
    const { env, sub } = await monthly();
    const { quote } = await manage(env, { action: "quote_switch_yearly" });
    const answer = await switchCall(env, quote);
    // As if the call ended between Stripe's answer and the write, and the webhook never synced.
    await ledgerRef(answer.purchaseId).update({ status: "pending", "stripe.invoiceId": admin.firestore.FieldValue.delete(), "stripe.paymentIntentId": admin.firestore.FieldValue.delete() });
    await ageLock(answer.purchaseId, 20);
    await sweepPendingWebPurchases({ firestore: db(), gateway: env.fake, now: () => new Date() }, {
      now: new Date(), deadline: new Date(Date.now() + 60_000), operationId: "sweep",
    });
    const entry = await read(ledgerRef(answer.purchaseId));
    assert.equal(entry.status, "paid");
    assert.equal(entry.stripe.invoiceId, sub().latest_invoice);

    // One the subscription does not name was never paid: failed.
    await clearFirestore();
    const other = await monthly({}, { failsCharges: true });
    const { quote: otherQuote } = await manage(other.env, { action: "quote_switch_yearly" });
    const now = new Date(Date.now() - 20 * 60 * 1000);
    await ledgerRef("e".repeat(32)).set(ledgerEntryToData({
      purchaseId: "e".repeat(32), uid: UID, plan: "web_yearly", kind: "switch", switchedFrom: "web_monthly", tierShown: "standard",
      tierCharged: "standard", lookupKey: "web_yearly_standard", priceId: "price_web_yearly_standard", amount: 4999,
      credit: otherQuote.credit, tax: 0, total: otherQuote.total, currency: "usd", knownCountry: null, cardCountry: "US",
      cardFunding: "credit", wallet: null, billingCountry: "US", billingState: null, livemode: false, lang: "en", status: "pending",
      stripe: { customerId: other.sub().customer, subscriptionId: other.subscriptionId }, createdAt: now, updatedAt: now,
    }));
    await sweepPendingWebPurchases({ firestore: db(), gateway: other.env.fake, now: () => new Date() }, {
      now: new Date(), deadline: new Date(Date.now() + 60_000), operationId: "sweep",
    });
    assert.equal((await read(ledgerRef("e".repeat(32)))).status, "failed");
  });

  test("a repeated attemptId charges once and returns the same outcome", async () => {
    const { env } = await monthly();
    const { quote } = await manage(env, { action: "quote_switch_yearly" });
    const id = attemptId();
    const first = await switchCall(env, quote, id);
    env.fake.resetCalls();
    assert.deepEqual(await switchCall(env, quote, id), first);
    assert.deepEqual(updates(env.fake), []);
    const switchInvoices = [...env.fake.state.invoices.values()].filter((invoice) => invoice.billing_reason === "subscription_update");
    assert.equal(switchInvoices.length, 1);
  });

  test("an earlier attempt's pending change is voided before a new one, once its lock has passed", async () => {
    const { env, sub } = await monthly({}, { requiresAction: true });
    const { quote } = await manage(env, { action: "quote_switch_yearly" });
    const first = await switchCall(env, quote);
    const firstInvoice = sub().latest_invoice;
    await ageLock(first.purchaseId, 11);
    env.fake.setDefaultCard(sub().id);
    const second = await switchCall(env, (await manage(env, { action: "quote_switch_yearly" })).quote);
    assert.equal(second.status, "succeeded");
    assert.equal(env.fake.state.invoices.get(firstInvoice).status, "void");
    assert.equal((await read(ledgerRef(first.purchaseId))).status, "abandoned");
    assert.equal((await read(webSlotRef())).productId, "web_yearly");
  });

  test("a cancelled monthly subscription may switch: renewal turns back on, and only switched_yearly is sent", async () => {
    const { env, sub } = await monthly();
    await manage(env, { action: "cancel" });
    assert.equal((await read(webSlotRef())).status, "canceled");
    const { quote } = await manage(env, { action: "quote_switch_yearly" });
    const answer = await switchCall(env, quote);
    assert.equal(answer.status, "succeeded");
    assert.equal(sub().cancel_at_period_end, false);
    const slot = await read(webSlotRef());
    assert.deepEqual([slot.status, slot.autoRenewing, slot.web.cancelAtPeriodEnd, slot.productId], ["active", true, false, "web_yearly"]);
    assert.deepEqual((await outboxRows()).map((row) => row.kind).sort(), ["cancellation_confirmed", "purchase_confirmed", "switched_yearly"]);
  });

  test("a full refund of the switch payment revokes access and cancels the subscription", async () => {
    const { env, sub } = await monthly();
    const { quote } = await manage(env, { action: "quote_switch_yearly" });
    const answer = await switchCall(env, quote);
    const entry = await read(ledgerRef(answer.purchaseId));
    env.fake.refund(entry.stripe.chargeId);
    await syncWebEntitlement(UID, { firestore: db(), gateway: env.fake });
    assert.equal((await read(webSlotRef())).status, "revoked");
    assert.equal((await read(ledgerRef(answer.purchaseId))).status, "refunded");
    assert.equal(sub().status, "canceled");
  });

  test("the renewal a year later is a plain yearly invoice that moves the slot a year on", async () => {
    const { env, subscriptionId } = await monthly();
    const { quote } = await manage(env, { action: "quote_switch_yearly" });
    await switchCall(env, quote);
    env.fake.advance(366 * DAY);
    const renewal = env.fake.renew(subscriptionId);
    const invoice = env.fake.state.invoices.get(renewal.invoiceId);
    assert.deepEqual([invoice.billing_reason, invoice.total, invoice.lines.data.length], ["subscription_cycle", 4999, 1]);
    await syncWebEntitlement(UID, { firestore: db(), gateway: env.fake, notify: env.deps.notify });
    assert.equal((await read(webSlotRef())).web.paidThrough.toMillis(), invoice.lines.data[0].period.end * 1000);
    assert.equal((await outboxRows()).filter((row) => row.kind === "renewed").length, 1);
  });

  test("refusals: not_monthly, payment_due, lifetime, sales off, not a tester, throttled, a purchase in progress; bad requests", async () => {
    const yearly = await setup();
    await buy(yearly, "web_yearly");
    const notMonthly = await refused(manage(yearly, { action: "quote_switch_yearly" }), "failed-precondition", "switch_unavailable");
    assert.equal(notMonthly.details.cause, "not_monthly");

    const pastDue = await setup({ known: { storePurchase: [] } });
    const bought = await buy(pastDue, "web_monthly", { uid: OTHER });
    pastDue.fake.advance(31 * DAY);
    pastDue.fake.renew((await read(ledgerRef(bought.result.purchaseId))).stripe.subscriptionId, { paid: false });
    const due = await refused(manage(pastDue, { action: "switch_yearly", acceptedTotal: 4999, attemptId: attemptId(), lang: "en" }, OTHER),
      "failed-precondition", "switch_unavailable");
    assert.equal(due.details.cause, "payment_due");
    await clearFirestore();

    const lifetime = await setup();
    await buy(lifetime, "web_lifetime");
    await refused(manage(lifetime, { action: "quote_switch_yearly" }), "failed-precondition", "no_subscription");
    await clearFirestore();

    const { env } = await monthly({ limits: { uidPerWindow: 3, ipPerWindow: 100, windowMs: DAY * 1000 } });
    await db().collection("web_pricing").doc("config").update({ salesEnabled: false });
    await refused(manage(env, { action: "quote_switch_yearly" }), "failed-precondition", "sales_disabled");
    await refused(switchCall(env, { total: 1 }), "failed-precondition", "sales_disabled");
    await db().collection("web_pricing").doc("config").update({ salesEnabled: true, testers: [OTHER] });
    await refused(manage(env, { action: "quote_switch_yearly" }), "failed-precondition", "sales_disabled");
    await db().collection("web_pricing").doc("config").update({ testers: [UID, OTHER] });
    assert.equal((await switchCall(env, { total: 1 })).status, "reprice");
    assert.equal((await switchCall(env, { total: 1 })).status, "reprice");
    await refused(switchCall(env, { total: 1 }), "resource-exhausted", "throttled");
    for (const data of [
      { action: "switch_yearly", acceptedTotal: 1, lang: "en" },
      { action: "switch_yearly", acceptedTotal: -1, attemptId: attemptId(), lang: "en" },
      { action: "switch_yearly", acceptedTotal: 1, attemptId: "short", lang: "en" },
      { action: "switch_yearly", acceptedTotal: 1, attemptId: attemptId(), lang: "fr" },
      { action: "quote_switch_yearly", acceptedTotal: 1 },
      { action: "finish_switch_yearly", purchaseId: "nothex" },
    ]) {
      await refused(manage(env, data), "invalid-argument", "invalid_request");
    }
  });

  test("a webhook sync before the callable records the invoice: the entry ends paid with exactly one switched_yearly", async () => {
    const { env } = await monthly();
    const { quote } = await manage(env, { action: "quote_switch_yearly" });
    const update = env.fake.updateSubscription;
    env.fake.updateSubscription = async (...args) => {
      const answer = await update(...args);
      await syncWebEntitlement(UID, { firestore: db(), gateway: env.fake, notify: env.deps.notify }, { trigger: "webhook" });
      return answer;
    };
    const answer = await switchCall(env, quote);
    assert.equal(answer.status, "succeeded");
    assert.equal((await read(ledgerRef(answer.purchaseId))).status, "paid");
    await syncWebEntitlement(UID, { firestore: db(), gateway: env.fake, notify: env.deps.notify });
    assert.equal((await outboxRows()).filter((row) => row.kind === "switched_yearly").length, 1);
  });

  test("the same attempt retried while the first call is inside Stripe's update: no write, purchase_in_progress, then paid", async () => {
    const { env } = await monthly();
    const { quote } = await manage(env, { action: "quote_switch_yearly" });
    const update = env.fake.updateSubscription;
    let entered;
    let release;
    const inside = new Promise((resolve) => (entered = resolve));
    const gate = new Promise((resolve) => (release = resolve));
    env.fake.updateSubscription = async (...args) => {
      if (args[1]?.payment_behavior === "pending_if_incomplete") {
        entered();
        await gate;
      }
      return update(...args);
    };
    const id = attemptId();
    const first = switchCall(env, quote, id);
    await inside;
    const purchaseId = purchaseIdFor(UID, id);
    const before = await read(ledgerRef(purchaseId));
    await refused(switchCall(env, quote, id), "failed-precondition", "purchase_in_progress");
    assert.deepEqual(await read(ledgerRef(purchaseId)), before, "the retry wrote nothing");
    assert.equal(before.status, "pending");
    release();
    assert.deepEqual(await first, { status: "succeeded", purchaseId });
    assert.equal((await read(ledgerRef(purchaseId))).status, "paid");
    assert.equal((await outboxRows()).filter((row) => row.kind === "switched_yearly").length, 1);
  });

  test("the sweep voids the open invoice of an old pending switch with no invoice id that was never paid", async () => {
    const { env, sub } = await monthly({}, { requiresAction: true });
    const { quote } = await manage(env, { action: "quote_switch_yearly" });
    const answer = await switchCall(env, quote);
    const invoiceId = sub().latest_invoice;
    await ledgerRef(answer.purchaseId).update({
      "stripe.invoiceId": admin.firestore.FieldValue.delete(),
      "stripe.paymentIntentId": admin.firestore.FieldValue.delete(),
    });
    await ageLock(answer.purchaseId, 20);
    await sweepPendingWebPurchases({ firestore: db(), gateway: env.fake, now: () => new Date() }, {
      now: new Date(), deadline: new Date(Date.now() + 60_000), operationId: "sweep",
    });
    assert.equal(env.fake.state.invoices.get(invoiceId).status, "void");
    assert.equal(sub().pending_update, null);
    assert.equal((await read(ledgerRef(answer.purchaseId))).status, "failed");
  });

  test("a decline racing the void's webhook: the entry ends failed with its category", async () => {
    const { env } = await monthly({}, { failsCharges: true, declineCode: "insufficient_funds" });
    const { quote } = await manage(env, { action: "quote_switch_yearly" });
    const voidInvoice = env.fake.voidInvoice;
    env.fake.voidInvoice = async (...args) => {
      const voided = await voidInvoice(...args);
      await syncWebEntitlement(UID, { firestore: db(), gateway: env.fake, notify: env.deps.notify }, { trigger: "webhook" });
      return voided;
    };
    const declined = await refused(switchCall(env, quote), "failed-precondition", "card_declined");
    assert.equal(declined.details.category, "insufficient_funds");
    const entry = (await ledgerDocs()).find((row) => row.kind === "switch");
    assert.deepEqual([entry.status, entry.failure], ["failed", "insufficient_funds"]);
  });

  test("a switch entry marked failed whose invoice was paid after all is healed to paid, with one switched_yearly", async () => {
    const { env, sub } = await monthly({}, { requiresAction: true });
    const { quote } = await manage(env, { action: "quote_switch_yearly" });
    const answer = await switchCall(env, quote);
    await ledgerRef(answer.purchaseId).update({ status: "failed", failure: "declined" });
    env.fake.completeAction(env.fake.state.invoices.get(sub().latest_invoice).payments[0].payment.payment_intent);
    await syncWebEntitlement(UID, { firestore: db(), gateway: env.fake, notify: env.deps.notify });
    await syncWebEntitlement(UID, { firestore: db(), gateway: env.fake, notify: env.deps.notify });
    assert.equal((await read(ledgerRef(answer.purchaseId))).status, "paid");
    assert.equal((await read(webSlotRef())).productId, "web_yearly");
    assert.equal((await outboxRows()).filter((row) => row.kind === "switched_yearly").length, 1);
  });

  test("the manage readers treat null as not given for optional fields", async () => {
    const { env } = await monthly();
    const { quote } = await manage(env, { action: "quote_switch_yearly" });
    assert.equal((await manage(env, { action: "switch_yearly", acceptedTotal: quote.total + 1, attemptId: attemptId(), lang: null })).status, "reprice");
    assert.deepEqual(await manage(env, { action: "replace_card", confirmationToken: env.fake.addToken(), acceptedRenewalAmount: null }), { status: "succeeded" });
    await refused(manage(env, { action: "switch_yearly", acceptedTotal: null, attemptId: attemptId(), lang: "en" }), "invalid-argument", "invalid_request");
  });

  test("a purchase in progress (another tab's purchase lock) refuses the switch with nothing charged", async () => {
    const { env } = await monthly();
    const { quote } = await manage(env, { action: "quote_switch_yearly" });
    const holder = "d".repeat(32);
    const now = new Date();
    await ledgerRef(holder).set(ledgerEntryToData({
      purchaseId: holder, uid: UID, plan: "web_lifetime", tierShown: "standard", tierCharged: "standard", lookupKey: "web_lifetime_standard",
      priceId: "price_web_lifetime_standard", amount: 14999, tax: 0, total: 14999, currency: "usd", knownCountry: null, cardCountry: "US",
      cardFunding: "credit", wallet: null, billingCountry: "US", billingState: null, livemode: false, lang: "en", status: "pending",
      stripe: { customerId: "cus_x" }, createdAt: now, updatedAt: now,
    }));
    await db().collection(WEB_CUSTOMERS_COLLECTION).doc(UID).update({ activePurchase: { purchaseId: holder, startedAt: Timestamp.fromDate(now) } });
    env.fake.resetCalls();
    await refused(switchCall(env, quote), "failed-precondition", "purchase_in_progress");
    assert.deepEqual(updates(env.fake), []);
  });
});

// ---------------------------------------------------------------------------
// Review fixes
// ---------------------------------------------------------------------------

const { ensureCustomer } = require("../../lib/services/webSubscriptions/customers");
const { DELETED_ACCOUNTS_COLLECTION } = require("../../lib/services/accountDeletion/tombstone");
const { syncWebEntitlement } = require("../../lib/services/webSubscriptions/sync");
const { listLedgerEntries } = require("../../lib/services/webSubscriptions/ledger");
const { claimWebEvent, WEB_STRIPE_EVENTS_COLLECTION } = require("../../lib/services/webSubscriptions/events");
const { expireWebTestSlots } = require("../../lib/services/webSubscriptions/expireTestSlots");
const { handleReconcileSubscriptions } = require("../../lib/handlers/subscriptionReconcileHandlers");
const { webSyncDepsFromEnv } = require("../../lib/functions/webSubscriptions/deps");

describe("purchase lock (finding 1)", () => {
  test("a purchase in progress blocks a second one with nothing created at Stripe; a failed authentication releases the lock at once", async () => {
    const env = await setup();
    const first = await buy(env, "web_monthly", { token: { behavior: "requires_action" } });
    assert.equal(first.result.status, "requires_action");
    const mapping = await read(db().collection(WEB_CUSTOMERS_COLLECTION).doc(UID));
    assert.equal(mapping.activePurchase.purchaseId, first.result.purchaseId);
    env.fake.resetCalls();
    const second = await refused(buy(env, "web_yearly"), "failed-precondition", "purchase_in_progress");
    assert.equal(second.details.reason, "purchase_in_progress");
    assert.deepEqual(creates(env.fake), [], "the refused call creates nothing at Stripe");
    assert.equal((await ledgerDocs()).length, 1, "and writes no ledger entry");

    const entry = await read(ledgerRef(first.result.purchaseId));
    env.fake.completeAction(entry.stripe.paymentIntentId, { succeed: false });
    assert.equal((await handleFinishWebPurchase({ purchaseId: first.result.purchaseId }, caller(), env.deps)).status, "failed");
    const third = await buy(env, "web_yearly");
    assert.equal(third.result.status, "succeeded", "the lock released as soon as the purchase failed");
  });

  test("a dismissed challenge (PaymentIntent canceled) fails the purchase and releases the lock", async () => {
    const env = await setup();
    const first = await buy(env, "web_monthly", { token: { behavior: "requires_action" } });
    const entry = await read(ledgerRef(first.result.purchaseId));
    env.fake.state.paymentIntents.get(entry.stripe.paymentIntentId).status = "canceled";
    assert.deepEqual(await handleFinishWebPurchase({ purchaseId: first.result.purchaseId }, caller(), env.deps), {
      status: "failed",
      category: "authentication_failed",
    });
    assert.equal(env.fake.state.subscriptions.get(entry.stripe.subscriptionId).status, "canceled");
    assert.equal((await buy(env, "web_monthly")).result.status, "succeeded");
  });

  test("a lock older than ten minutes does not block, and its purchase is abandoned", async () => {
    const env = await setup();
    const first = await buy(env, "web_monthly", { token: { behavior: "requires_action" } });
    await ageLock(first.result.purchaseId, 9);
    await refused(buy(env, "web_yearly"), "failed-precondition", "purchase_in_progress");
    await ageLock(first.result.purchaseId, 11);
    assert.equal((await buy(env, "web_yearly")).result.status, "succeeded");
    assert.equal((await read(ledgerRef(first.result.purchaseId))).status, "abandoned");
  });

  test("two purchases started together: exactly one subscription and one charge", async () => {
    const env = await setup();
    const settled = await Promise.allSettled([buy(env, "web_monthly"), buy(env, "web_yearly")]);
    const ok = settled.filter((row) => row.status === "fulfilled" && row.value.result.status === "succeeded");
    const no = settled.filter((row) => row.status === "rejected");
    assert.equal(ok.length, 1);
    assert.equal(no.length, 1);
    assert.ok(["purchase_in_progress", "already_subscribed"].includes(reasonOf(no[0].reason)), reasonOf(no[0].reason));
    assert.equal(env.fake.callNames().filter((name) => name === "createSubscription").length, 1);
    assert.equal(env.fake.state.charges.size, 1);
  });

  test("a previous purchase paid between the guards and the lock makes the second call check again", async () => {
    const env = await setup();
    const first = await buy(env, "web_monthly");
    // The second call's guards ran before the first was visible: its guard sync sees no
    // subscription yet, so only the paid lock holder can stop it.
    await webSlotRef().delete();
    const original = env.fake.listSubscriptions;
    let hidden = true;
    env.fake.listSubscriptions = async (customerId) => (hidden ? ((hidden = false), []) : original(customerId));
    await refused(buy(env, "web_yearly"), "failed-precondition", "already_subscribed");
    assert.equal(hidden, false, "the guard's sync was the one that saw nothing");
    assert.equal(env.fake.callNames().filter((name) => name === "createSubscription").length, 1, "no second subscription");
    const second = (await ledgerDocs()).find((row) => row.id !== first.result.purchaseId);
    assert.equal(second.status, "abandoned");
    assert.equal(second.failure, "refused_already_subscribed");
  });

  test("an entry settled elsewhere before its confirmation is stopped, never charged", async () => {
    const env = await setup();
    const original = env.fake.createSubscription;
    env.fake.createSubscription = async (params, key) => {
      const sub = await original(params, key);
      await ledgerRef(params.metadata.purchaseId).update({ status: "abandoned" });
      return sub;
    };
    await refused(buy(env, "web_monthly"), "failed-precondition", "token_invalid");
    assert.equal(env.fake.callNames().includes("confirmPaymentIntent"), false);
    assert.equal(subscriptionsOf(env.fake)[0].status, "canceled");
    assert.equal(env.fake.state.charges.size, 0);
  });

  test("the sync cancels a second paid subscription, keeps the newest open one, and never an incomplete one", async () => {
    const env = await setup();
    const customer = await ensureCustomer(UID, { firestore: db(), gateway: env.fake });
    const older = env.fake.paySubscription({ customer });
    env.fake.advance(60);
    const newer = env.fake.paySubscription({ customer });
    env.fake.advance(60);
    const ended = env.fake.paySubscription({ customer });
    await env.fake.cancelSubscription(ended.subscriptionId);
    env.fake.advance(60);
    const inFlight = env.fake.startSubscription({ customer });
    const result = await syncWebEntitlement(UID, { firestore: db(), gateway: env.fake });
    assert.deepEqual(result.cancelled, [older.subscriptionId]);
    assert.equal((await read(webSlotRef())).web.subscriptionId, newer.subscriptionId, "the newest open one, not the newer ended one");
    assert.equal(env.fake.state.subscriptions.get(inFlight.subscriptionId).status, "incomplete");
  });

  test("a paid lifetime invoice wins over a ledger entry marked abandoned or failed", async () => {
    const env = await setup();
    const customer = await ensureCustomer(UID, { firestore: db(), gateway: env.fake });
    const paid = env.fake.payLifetime({ customer });
    await ledgerRef("a".repeat(32)).set(ledgerEntryToData({
      purchaseId: "a".repeat(32), uid: UID, plan: "web_lifetime", tierShown: "standard", tierCharged: "standard",
      lookupKey: "web_lifetime_standard", priceId: "price_web_lifetime_standard", amount: 14999, tax: 0, total: 14999,
      currency: "usd", knownCountry: null, cardCountry: "US", cardFunding: "credit", wallet: null, billingCountry: "US",
      billingState: null, livemode: false, lang: "en", status: "abandoned", failure: "x",
      stripe: { customerId: customer, invoiceId: paid.invoiceId }, createdAt: new Date(), updatedAt: new Date(),
    }));
    await syncWebEntitlement(UID, { firestore: db(), gateway: env.fake });
    const slot = await read(webSlotRef());
    assert.equal(slot.productId, "web_lifetime");
    assert.equal(slot.active, true);
    assert.equal((await read(ledgerRef("a".repeat(32)))).status, "paid");
  });
});

describe("deleted accounts (finding 2)", () => {
  test("a tombstoned uid cannot see plans or buy, and nothing recreates its customer mapping", async () => {
    const env = await setup();
    await db().collection(DELETED_ACCOUNTS_COLLECTION).doc(UID).set({ state: "pending" });
    await refused(handleGetWebPlans({}, caller(), env.deps), "permission-denied", "account_deleted");
    await refused(buy(env, "web_monthly"), "permission-denied", "account_deleted");
    await refused(ensureCustomer(UID, { firestore: db(), gateway: env.fake }), "permission-denied", "account_deleted");
    assert.equal(await read(db().collection(WEB_CUSTOMERS_COLLECTION).doc(UID)), undefined);
    assert.deepEqual(creates(env.fake), []);
  });
});

describe("stale event claims (finding 3)", () => {
  const event = { id: "evt_stale", type: "invoice.paid", created: 1, livemode: false, object: {} };
  test("a processing claim older than five minutes is taken over; a younger one or a finished one is not", async () => {
    const now = new Date();
    const ref = db().collection(WEB_STRIPE_EVENTS_COLLECTION).doc(event.id);
    assert.equal(await claimWebEvent(db(), event, "webhook", now), true);
    assert.equal(await claimWebEvent(db(), event, "webhook", new Date(now.getTime() + 60_000)), false, "still being handled");
    assert.equal(await claimWebEvent(db(), event, "reconcile", new Date(now.getTime() + 6 * 60_000)), true, "a dead handler's claim");
    assert.equal((await read(ref)).reclaimed, true);
    await ref.update({ outcome: "synced_written" });
    assert.equal(await claimWebEvent(db(), event, "reconcile", new Date(now.getTime() + 60 * 60_000)), false, "handled stays handled");
  });
});

describe("pending cleanup and the PaymentIntent (finding 4)", () => {
  test("a succeeded or processing PaymentIntent counts as paid: nothing is cancelled or voided", async () => {
    for (const status of ["succeeded", "processing"]) {
      const env = await setup();
      const customer = env.fake.addCustomer(UID);
      const started = env.fake.startSubscription({ customer });
      env.fake.state.paymentIntents.get(started.paymentIntentId).status = status;
      const paid = await stopPendingStripeSide(
        { firestore: db(), gateway: env.fake },
        { stripe: { customerId: customer, subscriptionId: started.subscriptionId, invoiceId: started.invoiceId, paymentIntentId: started.paymentIntentId } }
      );
      assert.equal(paid, true, status);
      assert.equal(env.fake.callNames().some((name) => ["cancelSubscription", "voidInvoice"].includes(name)), false, status);
    }
  });
});

describe("going live (finding 5)", () => {
  test("expireWebTestSlots: a dry run counts, apply expires the test slot and re-projects the master", async () => {
    const env = await setup();
    await buy(env, "web_monthly");
    assert.equal((await read(db().collection(SUBSCRIPTION_MASTER_COLLECTION).doc(UID))).active, true);
    const dry = await expireWebTestSlots(db(), { apply: false });
    assert.deepEqual([dry.found, dry.toExpire, dry.expired], [1, 1, 0]);
    assert.equal((await read(webSlotRef())).status, "active", "a dry run writes nothing");
    const applied = await expireWebTestSlots(db(), { apply: true });
    assert.deepEqual([applied.expired, applied.uids], [1, [UID]]);
    const slot = await read(webSlotRef());
    assert.deepEqual([slot.status, slot.active], ["expired", false]);
    const master = await read(db().collection(SUBSCRIPTION_MASTER_COLLECTION).doc(UID));
    assert.equal(master.active, false);
    assert.equal((await expireWebTestSlots(db(), { apply: true })).expired, 0, "a second run is a no-op");
  });
});

describe("reconcile with a malformed key (finding 6)", () => {
  test("the web phases report an error and the store phases still run", async () => {
    const previous = process.env.STRIPE_WEB_SECRET_KEY;
    process.env.STRIPE_WEB_SECRET_KEY = "placeholder-not-a-key";
    try {
      const summary = await handleReconcileSubscriptions({ budgetScale: 0.01, webDeps: webSyncDepsFromEnv });
      assert.deepEqual(summary.stripeEvents, { error: "stripe-key-invalid" });
      assert.deepEqual(summary.webPending, { error: "stripe-key-invalid" });
      assert.ok(summary.acknowledgements && !("error" in summary.acknowledgements), "the store phases ran");
      assert.ok(summary.appleHistoryProduction);
    } finally {
      if (previous === undefined) delete process.env.STRIPE_WEB_SECRET_KEY;
      else process.env.STRIPE_WEB_SECRET_KEY = previous;
    }
  });
});

describe("ledger paging (finding 7)", () => {
  test("every entry is read across pages, and the read stops at the cap", async () => {
    const write = (id) => ledgerRef(id).set(ledgerEntryToData({
      purchaseId: id, uid: UID, plan: "web_monthly", tierShown: "standard", tierCharged: "standard", lookupKey: "k", priceId: "p",
      amount: 0, tax: 0, total: 0, currency: "usd", knownCountry: null, cardCountry: null, cardFunding: null, wallet: null,
      billingCountry: null, billingState: null, livemode: false, lang: null, status: "failed", stripe: { customerId: "cus_1" },
      createdAt: new Date(), updatedAt: new Date(),
    }));
    for (let index = 0; index < 5; index++) await write(`${index}`.padStart(32, "0"));
    await ledgerRef("f".repeat(32)).set({ uid: OTHER, plan: "web_monthly", status: "failed", stripe: { customerId: "cus_2" } });
    assert.equal((await listLedgerEntries(db(), UID, { pageSize: 2 })).length, 5);
    assert.equal((await listLedgerEntries(db(), UID, { pageSize: 2, maxEntries: 4 })).length, 4);
    assert.equal((await listLedgerEntries(db(), UID)).length, 5);
  });
});
