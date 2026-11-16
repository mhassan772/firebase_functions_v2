// The web purchase callables' rules that need no Firestore: the verified-email rule, decline
// categories, token checks, the slot views and blockers, and refusals that come before any
// read. The flows themselves run against the emulator in test/integration/webPurchase.test.js.
const assert = require("node:assert/strict");
const { describe, test } = require("node:test");
const { Timestamp } = require("firebase-admin/firestore");
const { createFakeStripe } = require("./helpers/fakeStripeGateway");
const {
  declineCategory,
  isCardError,
  isTokenError,
  readConfirmationToken,
  requireVerifiedEmail,
} = require("../lib/handlers/webCallableCommon");
const { existingPremium, purchaseBlockers, readWebAccountSlots, storeSubscriptionOf, webSlotView } = require("../lib/services/webSubscriptions/accountState");
const constants = require("../lib/config/constants");
const { stateDocumentId } = require("../lib/services/subscriptions/persistence");
const { handleStartWebPurchase, handleGetWebPlans, handleFinishWebPurchase, paidButNotShown, PURCHASE_LOCK_MS } = require("../lib/handlers/webPurchaseHandlers");
const { handleGetWebSubscription, handleManageWebSubscription } = require("../lib/handlers/webManageHandlers");
const { reasonOf } = require("../lib/utils/callableAuth");

const NOW = new Date(Date.UTC(2026, 10, 14, 12));
const DAY = 24 * 60 * 60 * 1000;
const untouchable = new Proxy({}, { get: () => assert.fail("Firestore was touched") });

function context({ provider = "password", verified = true, email = "a@example.com" } = {}) {
  return { auth: { uid: "Buyer0000000000000000001", token: { email, email_verified: verified, firebase: { sign_in_provider: provider } } } };
}

function slot(fields, web = {}) {
  const stamp = Timestamp.fromDate(NOW);
  return {
    active: true,
    status: "active",
    platform: "web",
    productId: "web_monthly",
    expiresAt: Timestamp.fromMillis(NOW.getTime() + 10 * DAY),
    inGracePeriod: false,
    environment: "test",
    autoRenewing: true,
    lastStoreEventAt: stamp,
    lastVerifiedAt: stamp,
    createdAt: stamp,
    updatedAt: stamp,
    web: { customerId: "cus_1", subscriptionId: "sub_1", purchaseId: "p".repeat(32), paidThrough: Timestamp.fromMillis(NOW.getTime() + 10 * DAY), cancelAtPeriodEnd: false, needsAction: false, paymentFailed: false, ...web },
    ...fields,
  };
}

describe("verified email", () => {
  test("password accounts need email_verified true; Google and Apple count as verified; nothing comes from the request", () => {
    assert.doesNotThrow(() => requireVerifiedEmail(context()));
    assert.doesNotThrow(() => requireVerifiedEmail(context({ provider: "google.com", verified: null })));
    assert.doesNotThrow(() => requireVerifiedEmail(context({ provider: "apple.com", verified: false, email: null })));
    for (const ctx of [
      context({ verified: false }),
      context({ verified: "true" }),
      context({ verified: true, email: null }),
      context({ provider: "phone", verified: null, email: null }),
      context({ provider: "custom", verified: null }),
    ]) {
      assert.throws(() => requireVerifiedEmail(ctx), (error) => reasonOf(error) === "email_unverified");
    }
  });
});

describe("Stripe answers", () => {
  test("decline categories", () => {
    const card = (decline_code, code = "card_declined") => ({ type: "StripeCardError", code, decline_code });
    assert.equal(declineCategory(card("generic_decline")), "declined");
    assert.equal(declineCategory(card("insufficient_funds")), "insufficient_funds");
    assert.equal(declineCategory(card(undefined, "expired_card")), "expired_card");
    assert.equal(declineCategory(card(undefined, "incorrect_cvc")), "incorrect_details");
    assert.equal(declineCategory(card(undefined, "incorrect_number")), "incorrect_details");
    assert.equal(declineCategory(card("authentication_required")), "authentication_failed");
    assert.equal(declineCategory({ code: "payment_intent_authentication_failure" }), "authentication_failed");
    assert.equal(declineCategory(card("stolen_card")), "declined");
    assert.equal(isCardError(card("x")), true);
    assert.equal(isCardError({ type: "StripeInvalidRequestError" }), false);
    assert.equal(isTokenError({ type: "StripeInvalidRequestError", code: "payment_intent_confirmation_token_invalid" }), true);
    assert.equal(isTokenError({ type: "StripeInvalidRequestError", code: "resource_missing", param: "confirmation_token" }), true);
    assert.equal(isTokenError({ type: "StripeInvalidRequestError", code: "resource_missing", param: "price" }), false);
  });

  test("a token is refused when missing, expired, used, or with the wrong setup_future_usage", async () => {
    const fake = createFakeStripe({ nowSec: Math.floor(NOW.getTime() / 1000) });
    const problems = [];
    const read = (id, usage = "off_session") => readConfirmationToken(fake, id, NOW, usage, (problem) => problems.push(problem));
    const good = fake.addToken();
    assert.equal((await read(good)).id, good);
    const refusedWith = async (promise) => {
      await assert.rejects(promise, (error) => reasonOf(error) === "token_invalid" && error.code === "failed-precondition");
    };
    await refusedWith(read("ctoken_missing"));
    await refusedWith(read(fake.addToken({ expiresInSec: 0 })));
    const used = fake.addToken();
    fake.state.tokens.get(used).setup_intent = "seti_1";
    await refusedWith(read(used));
    await refusedWith(read(good, null));
    await refusedWith(read(fake.addToken({ setupFutureUsage: null })));
    assert.deepEqual(problems, ["resource_missing", "expired", "used", "setup_future_usage", "setup_future_usage"]);
    assert.equal((await read(fake.addToken({ setupFutureUsage: null }), null)).setup_future_usage, null);
  });
});

describe("slot views and blockers", () => {
  test("the web slot in the pages' words", () => {
    assert.equal(webSlotView(undefined, NOW).state, "none");
    assert.equal(webSlotView(slot({}), NOW).state, "active");
    assert.equal(webSlotView(slot({ status: "canceled", autoRenewing: false }, { cancelAtPeriodEnd: true }), NOW).state, "cancelling");
    assert.equal(webSlotView(slot({ status: "grace_period", inGracePeriod: true }, { paymentFailed: true }), NOW).state, "payment_failed");
    assert.equal(webSlotView(slot({ status: "billing_retry", active: false, expiresAt: Timestamp.fromMillis(NOW.getTime() - DAY) }), NOW).state, "payment_failed");
    assert.equal(webSlotView(slot({ status: "grace_period" }, { needsAction: true, paymentFailed: true }), NOW).state, "needs_action");
    assert.equal(webSlotView(slot({ status: "expired", active: false }), NOW).state, "ended");
    assert.equal(webSlotView(slot({ expiresAt: Timestamp.fromMillis(NOW.getTime() - 1) }), NOW).state, "ended", "past its date is ended whatever it says");
    assert.equal(webSlotView(slot({ status: "revoked", active: false }), NOW).state, "ended");
    assert.equal(webSlotView(slot({ productId: "web_lifetime", autoRenewing: false }), NOW).state, "lifetime");
    assert.equal(webSlotView(slot({ productId: "web_lifetime", status: "revoked", active: false }), NOW).state, "ended");
  });

  test("blockers per plan, and only an auto-renewing production store slot blocks", () => {
    const store = (platform, autoRenewing, active = true) => ({ ...slot({ platform, autoRenewing, active, environment: "production" }), web: undefined });
    assert.deepEqual(purchaseBlockers({}, NOW).blockers, []);
    assert.deepEqual(purchaseBlockers({ web: slot({}) }, NOW, "web_yearly").blockers, ["already_subscribed"]);
    assert.deepEqual(purchaseBlockers({ web: slot({}) }, NOW, "web_lifetime").blockers, ["already_subscribed"], "a running subscription upgrades on /manage");
    assert.deepEqual(purchaseBlockers({ web: slot({ status: "canceled" }) }, NOW, "web_lifetime").blockers, ["already_subscribed"], "cancelled but running too");
    const pastDue = slot({ status: "grace_period", inGracePeriod: true }, { paymentFailed: true });
    assert.deepEqual(purchaseBlockers({ web: pastDue }, NOW, "web_lifetime").blockers, [], "a failed renewal has no unused time: lifetime stays purchasable");
    assert.deepEqual(purchaseBlockers({ web: pastDue }, NOW, "web_yearly").blockers, ["already_subscribed"]);
    assert.deepEqual(purchaseBlockers({ web: slot({ productId: "web_lifetime" }) }, NOW, "web_lifetime").blockers, ["lifetime_active"]);
    assert.deepEqual(purchaseBlockers({ google: store("google", true) }, NOW, "web_monthly").blockers, ["store_subscription_active"]);
    assert.deepEqual(purchaseBlockers({ google: store("google", true) }, NOW, "web_lifetime").blockers, []);
    assert.deepEqual(purchaseBlockers({ apple: store("apple", false) }, NOW, "web_monthly").blockers, []);
    assert.deepEqual(storeSubscriptionOf({ apple: store("apple", false), google: store("google", true) }, NOW), { platform: "google", autoRenewing: true });
    assert.equal(storeSubscriptionOf({ apple: store("apple", true, false) }, NOW), null);
  });
});

describe("a paid purchase the slot does not show yet", () => {
  const nowMs = NOW.getTime();
  const holder = (fields = {}) => ({ purchaseId: "p".repeat(32), plan: "web_monthly", status: "paid", livemode: false, ...fields });
  const view = (state, purchaseId = "p".repeat(32)) => ({ state, purchaseId });

  test("blocks while paid, younger than the lock, and not on the slot", () => {
    assert.equal(paidButNotShown(holder(), nowMs - 1000, nowMs, { state: "none" }, false), true);
    assert.equal(paidButNotShown(holder(), nowMs - 1000, nowMs, view("ended"), false), true);
    assert.equal(paidButNotShown(holder(), nowMs - 1000, nowMs, view("active", "q".repeat(32)), false), true, "the slot names another purchase");
    assert.equal(paidButNotShown(holder({ plan: "web_lifetime" }), nowMs - 1000, nowMs, view("active", "q".repeat(32)), false), true);
  });

  test("never blocks once the slot shows it, after the lock, for a switch or an upgrade, or for an entry that is not paid", () => {
    for (const state of ["active", "cancelling", "payment_failed", "needs_action"]) {
      assert.equal(paidButNotShown(holder(), nowMs - 1000, nowMs, view(state), false), false, state);
    }
    assert.equal(paidButNotShown(holder({ plan: "web_lifetime" }), nowMs - 1000, nowMs, view("lifetime"), false), false);
    assert.equal(paidButNotShown(holder(), nowMs - PURCHASE_LOCK_MS, nowMs, { state: "none" }, false), false);
    assert.equal(paidButNotShown(holder({ kind: "switch" }), nowMs - 1000, nowMs, { state: "none" }, false), false);
    assert.equal(paidButNotShown(holder({ kind: "upgrade", plan: "web_lifetime" }), nowMs - 1000, nowMs, view("active"), false), false);
    for (const status of ["refunded", "failed", "abandoned", "pending", "disputed"]) {
      assert.equal(paidButNotShown(holder({ status }), nowMs - 1000, nowMs, { state: "none" }, false), false, status);
    }
    assert.equal(paidButNotShown(undefined, nowMs - 1000, nowMs, { state: "none" }, false), false);
    assert.equal(paidButNotShown(holder(), nowMs - 1000, nowMs, { state: "none" }, true), false, "a sandbox purchase never blocks a live one");
    assert.equal(paidButNotShown(holder({ livemode: true }), nowMs - 1000, nowMs, { state: "none" }, false), false, "nor the other way round");
  });
});

describe("existing premium", () => {
  const iso = (ms) => new Date(ms).toISOString();
  const store = (platform, autoRenewing, fields = {}) => ({ ...slot({ platform, productId: "monthly_sub", autoRenewing, environment: "production", ...fields }), web: undefined });
  const manual = (days) => ({ ...slot({ platform: "manual", productId: "manual_grant", environment: "production", autoRenewing: false, expiresAt: Timestamp.fromMillis(NOW.getTime() + days * DAY) }), web: undefined });

  test("each source alone", () => {
    assert.deepEqual(existingPremium({}, NOW), []);
    // paidThrough, not expiresAt, which carries the grace margin.
    const web = slot({ expiresAt: Timestamp.fromMillis(NOW.getTime() + 10 * DAY + 6 * 3600 * 1000) });
    assert.deepEqual(existingPremium({ web }, NOW), [
      { source: "web", kind: "subscription", plan: "web_monthly", state: "active", renews: true, until: iso(NOW.getTime() + 10 * DAY) },
    ]);
    assert.deepEqual(existingPremium({ web: slot({ status: "canceled", autoRenewing: false }, { cancelAtPeriodEnd: true }) }, NOW)[0], {
      source: "web", kind: "subscription", plan: "web_monthly", state: "cancelling", renews: false, until: iso(NOW.getTime() + 10 * DAY),
    });
    assert.equal(existingPremium({ web: slot({ status: "billing_retry", active: false, expiresAt: Timestamp.fromMillis(NOW.getTime() - DAY) }) }, NOW)[0].state, "payment_failed", "listed although it gives no premium now");
    assert.deepEqual(existingPremium({ web: slot({ status: "grace_period" }, { needsAction: true }) }, NOW).map((row) => [row.state, row.renews]), [["needs_action", true]]);
    assert.deepEqual(existingPremium({ web: slot({ status: "expired", active: false }) }, NOW), []);
    assert.deepEqual(existingPremium({ web: slot({ productId: "web_lifetime", autoRenewing: false }) }, NOW), [
      { source: "web", kind: "lifetime", plan: "web_lifetime", state: "active", renews: false },
    ]);
    assert.deepEqual(existingPremium({ apple: store("apple", true) }, NOW), [
      { source: "apple", kind: "subscription", state: "active", renews: true, until: iso(NOW.getTime() + 10 * DAY) },
    ]);
    assert.deepEqual(existingPremium({ manual: manual(30) }, NOW), [
      { source: "manual", kind: "grant", state: "active", renews: false, until: iso(NOW.getTime() + 30 * DAY) },
    ]);
  });

  test("a store subscription cancelled but still running is listed as cancelling; an ended one is not", () => {
    assert.deepEqual(existingPremium({ google: store("google", false, { status: "canceled" }) }, NOW), [
      { source: "google", kind: "subscription", state: "cancelling", renews: false, until: iso(NOW.getTime() + 10 * DAY) },
    ]);
    assert.deepEqual(existingPremium({ google: store("google", true, { active: false, status: "expired" }) }, NOW), []);
  });

  test("an expired or revoked manual grant is not listed", () => {
    assert.deepEqual(existingPremium({ manual: manual(-1) }, NOW), []);
    assert.deepEqual(existingPremium({ manual: { ...manual(30), status: "revoked" } }, NOW), []);
  });

  test("combined, in the order web, apple, google, manual; the blockers are unchanged", () => {
    const slots = { manual: manual(30), google: store("google", false), apple: store("apple", true), web: slot({ productId: "web_lifetime", autoRenewing: false }) };
    assert.deepEqual(existingPremium(slots, NOW).map((row) => row.source), ["web", "apple", "google", "manual"]);
    assert.deepEqual(purchaseBlockers(slots, NOW).blockers, ["lifetime_active", "store_subscription_active"]);
    assert.deepEqual(purchaseBlockers({ manual: manual(30) }, NOW).blockers, [], "a manual grant blocks nothing");
  });

  test("the slots read: the web slot of the mode, the production store slots, and the manual slot unless switched off", async () => {
    const uid = "Buyer0000000000000000001";
    const stored = new Map([
      [stateDocumentId(uid, "manual", "production"), manual(30)],
      [stateDocumentId(uid, "apple", "sandbox"), store("apple", true, { environment: "sandbox" })],
    ]);
    let requested = [];
    const db = {
      collection: () => ({ doc: (id) => ({ id }) }),
      getAll: async (...refs) => {
        requested = refs.map((ref) => ref.id);
        return refs.map((ref) => ({ exists: stored.has(ref.id), data: () => stored.get(ref.id) }));
      },
    };
    const slots = await readWebAccountSlots(db, uid, false);
    assert.deepEqual(requested, ["web_test", "apple_production", "google_production", "manual_production"].map((suffix) => `${stateDocumentId(uid, ...suffix.split("_"))}`));
    assert.deepEqual(Object.keys(slots), ["manual"], "a sandbox store slot is never read");
    assert.deepEqual(existingPremium(slots, NOW).map((row) => row.source), ["manual"]);
    const enabled = constants.MANUAL_SLOT_ENABLED;
    constants.MANUAL_SLOT_ENABLED = false;
    try {
      const off = await readWebAccountSlots(db, uid, true);
      assert.equal(requested.length, 3);
      assert.equal(requested[0], stateDocumentId(uid, "web", "production"));
      assert.deepEqual(existingPremium(off, NOW), []);
    } finally {
      constants.MANUAL_SLOT_ENABLED = enabled;
    }
  });
});

describe("refusals before any read", () => {
  const deps = { firestore: untouchable, gateway: undefined, publishableKey: undefined, storeCountry: untouchable, throttle: untouchable, now: () => NOW };

  test("each callable refuses signed-out and anonymous callers, and bad requests, before touching anything", async () => {
    const anonymous = { auth: { uid: "x", token: { firebase: { sign_in_provider: "anonymous" } } } };
    const calls = [
      (data, ctx) => handleGetWebPlans(data, ctx, deps),
      (data, ctx) => handleStartWebPurchase(data, ctx, deps),
      (data, ctx) => handleFinishWebPurchase(data, ctx, deps),
      (data, ctx) => handleGetWebSubscription(data, ctx, deps),
      (data, ctx) => handleManageWebSubscription(data, ctx, deps),
    ];
    for (const call of calls) {
      await assert.rejects(call({}, {}), (error) => error.code === "unauthenticated" && reasonOf(error) === "signed_out");
      await assert.rejects(call({}, anonymous), (error) => error.code === "unauthenticated" && reasonOf(error) === "anonymous");
      await assert.rejects(call({ unknown: true }, context()), (error) => reasonOf(error) === "invalid_request");
      await assert.rejects(call("text", context()), (error) => reasonOf(error) === "invalid_request");
    }
  });

  test("with no Stripe key every callable refuses sales_disabled; buying asks for a verified email first", async () => {
    const start = { plan: "web_monthly", confirmationToken: "ctoken_abcdefgh", acceptedTotal: 499 };
    await assert.rejects(handleStartWebPurchase(start, context({ verified: false }), deps), (error) => reasonOf(error) === "email_unverified");
    await assert.rejects(handleGetWebPlans({}, context({ verified: false }), deps), (error) => reasonOf(error) === "email_unverified");
    await assert.rejects(handleStartWebPurchase(start, context(), deps), (error) => reasonOf(error) === "sales_disabled");
    await assert.rejects(handleStartWebPurchase({ ...start, acknowledgeExisting: "yes" }, context(), deps), (error) => reasonOf(error) === "invalid_request");
    // The callable SDK sends an unset field as null: it must read as "not given", not as a bad request.
    await assert.rejects(handleStartWebPurchase({ ...start, acknowledgeExisting: null }, context(), deps), (error) => reasonOf(error) === "sales_disabled");
    await assert.rejects(handleGetWebPlans({}, context(), deps), (error) => reasonOf(error) === "sales_disabled");
    await assert.rejects(handleFinishWebPurchase({ purchaseId: "a".repeat(32) }, context(), deps), (error) => reasonOf(error) === "sales_disabled");
    await assert.rejects(handleGetWebSubscription({}, context({ verified: false }), deps), (error) => reasonOf(error) === "sales_disabled");
    await assert.rejects(handleManageWebSubscription({ action: "cancel" }, context({ verified: false }), deps), (error) => reasonOf(error) === "sales_disabled");
  });
});
