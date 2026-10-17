// A stand-in for the Play Developer API: purchases by token, scripted acknowledge
// outcomes, and a log of every call, so handler paths run without a store.
const { setPlayApi } = require("../../lib/services/subscriptions/google");

/** A SubscriptionPurchaseV2 that passes validation, in the test environment. */
function playSubscription({
  state = "SUBSCRIPTION_STATE_ACTIVE",
  expiryTime,
  startTime,
  acknowledged = false,
  autoRenewing = true,
  linkedPurchaseToken,
  expiredPurchaseToken,
  expiredAccountBinding,
  basePlanId = "monthly",
} = {}) {
  const purchase = {
    kind: "androidpublisher#subscriptionPurchaseV2",
    subscriptionState: state,
    acknowledgementState: acknowledged
      ? "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED"
      : "ACKNOWLEDGEMENT_STATE_PENDING",
    startTime: (startTime ?? new Date()).toISOString(),
    testPurchase: {},
    lineItems: [
      {
        productId: "premium_access",
        expiryTime: expiryTime.toISOString(),
        autoRenewingPlan: { autoRenewEnabled: autoRenewing },
        offerDetails: { basePlanId },
      },
    ],
  };
  if (linkedPurchaseToken) purchase.linkedPurchaseToken = linkedPurchaseToken;
  if (expiredPurchaseToken || expiredAccountBinding) {
    purchase.outOfAppPurchaseContext = {
      ...(expiredPurchaseToken ? { expiredPurchaseToken } : {}),
      ...(expiredAccountBinding
        ? { expiredExternalAccountIdentifiers: { obfuscatedExternalAccountId: expiredAccountBinding } }
        : {}),
    };
  }
  return purchase;
}

/**
 * Installs the fake. `acknowledge` is a queue of outcomes per call: `undefined`
 * succeeds, a number throws an error with that HTTP status, an Error throws it.
 */
function installFakePlay({ subscriptions = {}, acknowledge = [], voided = [] } = {}) {
  const calls = { get: [], acknowledge: [], voided: [] };
  const fake = {
    subscriptions,
    calls,
    async getSubscription(token) {
      calls.get.push(token);
      const purchase = subscriptions[token];
      // A number stands for an HTTP failure Play answers with for that token.
      if (typeof purchase === "number") throw { code: purchase };
      if (!purchase) throw { code: 410 };
      return purchase;
    },
    async acknowledgeSubscription(productId, token) {
      calls.acknowledge.push({ productId, token });
      const outcome = acknowledge.length > 0 ? acknowledge.shift() : undefined;
      if (outcome instanceof Error) throw outcome;
      if (typeof outcome === "number") throw { code: outcome };
      const purchase = subscriptions[token];
      if (purchase) purchase.acknowledgementState = "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED";
    },
    async listVoidedPurchases(query) {
      calls.voided.push(query);
      const page = voided.length > 0 ? voided.shift() : {};
      if (page instanceof Error) throw page;
      if (typeof page === "number") throw { code: page };
      return page;
    },
  };
  setPlayApi(fake);
  return fake;
}

function uninstallFakePlay() {
  setPlayApi(undefined);
}

module.exports = { installFakePlay, playSubscription, uninstallFakePlay };
