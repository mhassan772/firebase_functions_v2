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
const { purchaseBlockers, storeSubscriptionOf, webSlotView } = require("../lib/services/webSubscriptions/accountState");
const { handleStartWebPurchase, handleGetWebPlans, handleFinishWebPurchase } = require("../lib/handlers/webPurchaseHandlers");
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
    assert.deepEqual(purchaseBlockers({ web: slot({}) }, NOW, "web_lifetime").blockers, [], "lifetime may be bought over a subscription");
    assert.deepEqual(purchaseBlockers({ web: slot({ productId: "web_lifetime" }) }, NOW, "web_lifetime").blockers, ["lifetime_active"]);
    assert.deepEqual(purchaseBlockers({ google: store("google", true) }, NOW, "web_monthly").blockers, ["store_subscription_active"]);
    assert.deepEqual(purchaseBlockers({ google: store("google", true) }, NOW, "web_lifetime").blockers, []);
    assert.deepEqual(purchaseBlockers({ apple: store("apple", false) }, NOW, "web_monthly").blockers, []);
    assert.deepEqual(storeSubscriptionOf({ apple: store("apple", false), google: store("google", true) }, NOW), { platform: "google", autoRenewing: true });
    assert.equal(storeSubscriptionOf({ apple: store("apple", true, false) }, NOW), null);
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
    await assert.rejects(handleGetWebPlans({}, context(), deps), (error) => reasonOf(error) === "sales_disabled");
    await assert.rejects(handleFinishWebPurchase({ purchaseId: "a".repeat(32) }, context(), deps), (error) => reasonOf(error) === "sales_disabled");
    await assert.rejects(handleGetWebSubscription({}, context({ verified: false }), deps), (error) => reasonOf(error) === "sales_disabled");
    await assert.rejects(handleManageWebSubscription({ action: "cancel" }, context({ verified: false }), deps), (error) => reasonOf(error) === "sales_disabled");
  });
});
