// Store notifications about an older purchase, against the Firestore emulator. Run with
// `npm run test:integration`, which starts it under a demo project, so nothing here can
// reach real data or a real store.
const assert = require("node:assert/strict");
const { beforeEach, describe, test } = require("node:test");

assert.ok(process.env.FIRESTORE_EMULATOR_HOST, "FIRESTORE_EMULATOR_HOST must point at the emulator");

const { admin } = require("../../lib/config/admin");
const {
  persistVerifiedSubscription,
  stateData,
  stateDocumentId,
  SUBSCRIPTION_EVENT_COLLECTION,
  SUBSCRIPTION_MASTER_COLLECTION,
  SUBSCRIPTION_STATE_COLLECTION,
} = require("../../lib/services/subscriptions/persistence");
const { Timestamp } = require("firebase-admin/firestore");
const { sha256Reference } = require("../../lib/services/subscriptions/crypto");

const MINUTE = 60 * 1000;
const START = Date.now();
const at = (minutes) => new Date(START + minutes * MINUTE);

/** A Play purchase as `verifyGoogleSubscription` returns it, in the test environment. */
function googleVerified(token, { active, status, expiresAt, eventAt, linkedToken }) {
  return {
    subscription: {
      active,
      status,
      platform: "google",
      productId: "premium_access",
      expiresAt,
      autoRenewing: active,
      inGracePeriod: false,
      environment: "test",
      purchaseReference: sha256Reference(token),
      lastStoreEventAt: eventAt,
      lastVerifiedAt: eventAt,
    },
    ownership: [
      {
        platform: "google",
        environment: "test",
        purchaseToken: token,
        currentPurchaseToken: token,
        ...(linkedToken ? { linkedPurchaseToken: linkedToken } : {}),
      },
      ...(linkedToken
        ? [{ platform: "google", environment: "test", purchaseToken: linkedToken, currentPurchaseToken: token }]
        : []),
    ],
  };
}

const notification = (key, eventType, eventAt, extra = {}) => ({
  key,
  platform: "google",
  environment: "test",
  eventType,
  eventAt,
  ...extra,
});

async function eventDocs(eventType) {
  const snapshot = await admin
    .firestore()
    .collection(SUBSCRIPTION_EVENT_COLLECTION)
    .where("eventType", "==", eventType)
    .get();
  return snapshot.docs.map((doc) => doc.data());
}

async function clearFirestore() {
  const response = await fetch(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-mantooq/databases/(default)/documents`,
    { method: "DELETE" }
  );
  assert.ok(response.ok, `clearing Firestore failed: ${response.status}`);
}

async function master(uid) {
  const snapshot = await admin.firestore().collection(SUBSCRIPTION_MASTER_COLLECTION).doc(uid).get();
  return snapshot.data();
}

beforeEach(async () => {
  await clearFirestore();
});

describe("a resubscription followed by a late notification for the old token", () => {
  const uid = "user-resubscribed";
  const tokenB = "token-B-monthly-charged-back";
  const tokenC = "token-C-yearly";
  const voidedB = (eventAt) =>
    googleVerified(tokenB, { active: false, status: "revoked", expiresAt: at(-5), eventAt });
  const activeC = (eventAt, expiresAt = at(30)) =>
    googleVerified(tokenC, { active: true, status: "active", expiresAt, eventAt });

  async function resubscribe() {
    // B bought, then charged back; C bought later as a separate purchase with no link to B.
    await persistVerifiedSubscription(
      uid,
      googleVerified(tokenB, { active: true, status: "active", expiresAt: at(20), eventAt: at(-12) })
    );
    await persistVerifiedSubscription(uid, voidedB(at(-5)), notification("void-B-1", "VOIDED_PURCHASE", at(-5)));
    assert.equal((await master(uid)).active, false);
    await persistVerifiedSubscription(uid, activeC(at(-2)));
    const resubscribed = await master(uid);
    assert.equal(resubscribed.active, true);
    assert.equal(resubscribed.purchaseReference, sha256Reference(tokenC));
  }

  test("a re-delivered void for the old token keeps the account on the new purchase", async () => {
    await resubscribe();

    // Play re-delivers B's void with a new message id and a newer event time.
    const redelivered = await persistVerifiedSubscription(
      uid,
      voidedB(at(0)),
      notification("void-B-2", "VOIDED_PURCHASE", at(0), {
        purchaseReference: sha256Reference(tokenB),
        refundType: 2,
      })
    );
    assert.equal(redelivered.duplicate, false);
    assert.equal(redelivered.stateApplied, false);
    assert.equal(redelivered.displacedLivingPurchase, false);

    // The event doc says which purchase it was about and that it changed nothing.
    const skipped = (await eventDocs("VOIDED_PURCHASE")).find((doc) => doc.refundType === 2);
    assert.equal(skipped.claimed, true);
    assert.equal(skipped.stateApplied, false);
    assert.equal(skipped.purchaseReference, sha256Reference(tokenB));
    assert.ok(!Object.hasOwn(skipped, "purchaseToken"));
    assert.equal(redelivered.subscription.active, true);
    const after = await master(uid);
    assert.equal(after.active, true);
    assert.equal(after.status, "active");
    assert.equal(after.purchaseReference, sha256Reference(tokenC));
    assert.equal(after.expiresAt.toDate().toISOString(), at(30).toISOString());
    assert.deepEqual(after.sources.map((row) => row.status), ["active"]);

    // The skipped void did not move the slot's event clock, so C's own renewal still lands.
    const renewal = await persistVerifiedSubscription(
      uid,
      activeC(at(-1), at(60)),
      notification("renew-C-1", "SUBSCRIPTION_RENEWED", at(-1))
    );
    assert.equal(renewal.stateApplied, true);
    assert.equal((await master(uid)).expiresAt.toDate().toISOString(), at(60).toISOString());
  });

  test("the new purchase's own void still revokes it", async () => {
    await resubscribe();
    const voidedC = await persistVerifiedSubscription(
      uid,
      googleVerified(tokenC, { active: false, status: "revoked", expiresAt: at(0), eventAt: at(0) }),
      notification("void-C-1", "VOIDED_PURCHASE", at(0))
    );
    assert.equal(voidedC.stateApplied, true);
    const after = await master(uid);
    assert.equal(after.active, false);
    assert.equal(after.status, "revoked");
    assert.equal(after.purchaseReference, sha256Reference(tokenC));
  });

  test("an upgrade that replaced the new purchase through linkedPurchaseToken still takes its slot", async () => {
    await resubscribe();
    const tokenD = "token-D-upgrade";
    const upgraded = await persistVerifiedSubscription(
      uid,
      googleVerified(tokenD, {
        active: false,
        status: "revoked",
        expiresAt: at(0),
        eventAt: at(0),
        linkedToken: tokenC,
      }),
      notification("revoke-D-1", "SUBSCRIPTION_REVOKED", at(0))
    );
    assert.equal(upgraded.stateApplied, true);
    const after = await master(uid);
    assert.equal(after.active, false);
    assert.equal(after.purchaseReference, sha256Reference(tokenD));
  });
});

/** An Apple purchase as `verifyAppleSubscription` returns it, in the sandbox. */
function appleVerified(originalTransactionId, { active, status, expiresAt, eventAt }) {
  return {
    subscription: {
      active,
      status,
      platform: "apple",
      productId: "monthly_sub",
      expiresAt,
      autoRenewing: active,
      inGracePeriod: false,
      environment: "sandbox",
      originalTransactionId,
      lastStoreEventAt: eventAt,
      lastVerifiedAt: eventAt,
    },
    ownership: [{ platform: "apple", environment: "sandbox", originalTransactionId }],
  };
}

async function eventCount() {
  const snapshot = await admin.firestore().collection(SUBSCRIPTION_EVENT_COLLECTION).count().get();
  return snapshot.data().count;
}

describe("the guard around the purchase a slot holds", () => {
  const uid = "user-guarded";
  const tokenA = "token-A-older";
  const tokenB = "token-B-current";
  const lapsedA = (eventAt, expiresAt = at(-10)) =>
    googleVerified(tokenA, { active: false, status: "expired", expiresAt, eventAt });
  const activeB = (eventAt, expiresAt = at(30)) =>
    googleVerified(tokenB, { active: true, status: "active", expiresAt, eventAt });

  test("an iOS restore that presents an old original transaction leaves the active one in place", async () => {
    // StoreKit restore delivers every past transaction, so the verify path sees lapsed
    // purchases under other original transaction ids with no store event behind them.
    await persistVerifiedSubscription(
      uid,
      appleVerified("original-2", { active: true, status: "active", expiresAt: at(30), eventAt: at(-2) })
    );
    const restored = await persistVerifiedSubscription(
      uid,
      appleVerified("original-1", { active: false, status: "expired", expiresAt: at(-100), eventAt: at(0) })
    );
    assert.equal(restored.duplicate, false);
    assert.equal(restored.stateApplied, false);
    assert.equal(restored.subscription.active, true);
    const after = await master(uid);
    assert.equal(after.active, true);
    assert.equal(after.originalTransactionId, "original-2");
    assert.equal(await eventCount(), 0);
  });

  test("a slot document with no purchase identity is replaced as it was before the guard", async () => {
    // Written by hand the way an older build left it: a store slot with no reference.
    const now = Timestamp.now();
    const data = stateData(uid, activeB(at(-2)).subscription, now, now);
    delete data.purchaseReference;
    await admin
      .firestore()
      .collection(SUBSCRIPTION_STATE_COLLECTION)
      .doc(stateDocumentId(uid, "google", "test"))
      .set(data);

    const lapsed = await persistVerifiedSubscription(uid, lapsedA(at(0)), notification("expire-A-1", "SUBSCRIPTION_EXPIRED", at(0)));
    assert.equal(lapsed.stateApplied, true);
    const after = await master(uid);
    assert.equal(after.active, false);
    assert.equal(after.purchaseReference, sha256Reference(tokenA));
  });

  test("renewal window: between a stored expiry and its renewal, only a purchase that ran later can take the slot", async () => {
    // Between the stored expiry and the renewal notice the guard treats the purchase as
    // lapsed. An older purchase's event still loses to it on expiry; a purchase that
    // ended later wins, and the renewal takes the slot back either way.
    await persistVerifiedSubscription(uid, activeB(at(-20), at(-1)));
    const inWindow = await persistVerifiedSubscription(uid, lapsedA(at(0)), notification("expire-A-2", "SUBSCRIPTION_EXPIRED", at(0)));
    assert.equal(inWindow.stateApplied, false);
    assert.equal((await master(uid)).purchaseReference, sha256Reference(tokenB));
    const laterLapse = await persistVerifiedSubscription(
      uid,
      googleVerified("token-X-later", { active: false, status: "expired", expiresAt: at(0), eventAt: at(0) }),
      notification("expire-X-1", "SUBSCRIPTION_EXPIRED", at(0))
    );
    assert.equal(laterLapse.stateApplied, true);
    assert.equal((await master(uid)).purchaseReference, sha256Reference("token-X-later"));

    const renewed = await persistVerifiedSubscription(uid, activeB(at(1), at(40)), notification("renew-B-1", "SUBSCRIPTION_RENEWED", at(1)));
    assert.equal(renewed.stateApplied, true);
    const after = await master(uid);
    assert.equal(after.active, true);
    assert.equal(after.purchaseReference, sha256Reference(tokenB));
    assert.equal(after.expiresAt.toDate().toISOString(), at(40).toISOString());
  });

  test("the current purchase's own events apply in order and an older one is still rejected", async () => {
    const purchased = await persistVerifiedSubscription(uid, activeB(at(-10), at(20)));
    assert.equal(purchased.stateApplied, true);
    const renewed = await persistVerifiedSubscription(uid, activeB(at(-8), at(50)), notification("renew-B-2", "SUBSCRIPTION_RENEWED", at(-8)));
    assert.equal(renewed.stateApplied, true);
    const canceled = await persistVerifiedSubscription(
      uid,
      googleVerified(tokenB, { active: true, status: "canceled", expiresAt: at(50), eventAt: at(-6) }),
      notification("cancel-B-1", "SUBSCRIPTION_CANCELED", at(-6))
    );
    assert.equal(canceled.stateApplied, true);
    assert.equal((await master(uid)).status, "canceled");
    assert.equal((await master(uid)).active, true);

    // A re-delivered renewal from before the cancel carries an older event time.
    const stale = await persistVerifiedSubscription(uid, activeB(at(-8), at(50)), notification("renew-B-3", "SUBSCRIPTION_RENEWED", at(-8)));
    assert.equal(stale.duplicate, false);
    assert.equal(stale.stateApplied, false);
    assert.equal((await master(uid)).status, "canceled");

    const expired = await persistVerifiedSubscription(
      uid,
      googleVerified(tokenB, { active: false, status: "expired", expiresAt: at(50), eventAt: at(51) }),
      notification("expire-B-1", "SUBSCRIPTION_EXPIRED", at(51))
    );
    assert.equal(expired.stateApplied, true);
    const after = await master(uid);
    assert.equal(after.active, false);
    assert.equal(after.status, "expired");
    assert.equal(after.purchaseReference, sha256Reference(tokenB));
  });

  test("a delayed notification for the new purchase still applies after an older purchase's later-dated void", async () => {
    await persistVerifiedSubscription(
      uid,
      googleVerified(tokenA, { active: false, status: "revoked", expiresAt: at(-10), eventAt: at(0) }),
      notification("void-A-1", "VOIDED_PURCHASE", at(0))
    );
    const delayed = await persistVerifiedSubscription(uid, activeB(at(-1)), notification("purchase-B-1", "SUBSCRIPTION_PURCHASED", at(-1)));
    assert.equal(delayed.stateApplied, true);
    const after = await master(uid);
    assert.equal(after.active, true);
    assert.equal(after.purchaseReference, sha256Reference(tokenB));
  });

  test("a current purchase on account hold is not displaced by an older purchase's lapsed event", async () => {
    await persistVerifiedSubscription(uid, activeB(at(-30), at(-2)));
    const onHold = await persistVerifiedSubscription(
      uid,
      googleVerified(tokenB, { active: false, status: "account_hold", expiresAt: at(-2), eventAt: at(-2) }),
      notification("hold-B-1", "SUBSCRIPTION_ON_HOLD", at(-2))
    );
    assert.equal(onHold.stateApplied, true);
    const older = await persistVerifiedSubscription(uid, lapsedA(at(0), at(-50)), notification("expire-A-3", "SUBSCRIPTION_EXPIRED", at(0)));
    assert.equal(older.stateApplied, false);
    const held = await master(uid);
    assert.equal(held.status, "account_hold");
    assert.equal(held.purchaseReference, sha256Reference(tokenB));

    const recovered = await persistVerifiedSubscription(uid, activeB(at(1), at(40)), notification("recover-B-1", "SUBSCRIPTION_RECOVERED", at(1)));
    assert.equal(recovered.stateApplied, true);
    assert.equal((await master(uid)).active, true);
  });

  test("two living purchases are counted once, an upgrade through the chain is not", async () => {
    await persistVerifiedSubscription(uid, activeB(at(-5), at(30)));
    const second = await persistVerifiedSubscription(
      uid,
      googleVerified("token-A2-second-account", { active: true, status: "active", expiresAt: at(20), eventAt: at(-1) }),
      notification("purchase-A2-1", "SUBSCRIPTION_PURCHASED", at(-1))
    );
    assert.equal(second.stateApplied, true);
    assert.equal(second.displacedLivingPurchase, true);

    const upgrade = await persistVerifiedSubscription(
      uid,
      googleVerified("token-D-upgrade", {
        active: true,
        status: "active",
        expiresAt: at(60),
        eventAt: at(0),
        linkedToken: "token-A2-second-account",
      }),
      notification("purchase-D-1", "SUBSCRIPTION_PURCHASED", at(0))
    );
    assert.equal(upgrade.stateApplied, true);
    assert.equal(upgrade.displacedLivingPurchase, false);
  });

  test("an upgrade's delayed notice applies after the old token's later-dated expiry", async () => {
    await persistVerifiedSubscription(uid, activeB(at(-10), at(30)));
    // Play expires the old token at once on an upgrade; its notice lands first here.
    const oldExpired = await persistVerifiedSubscription(
      uid,
      googleVerified(tokenB, { active: false, status: "expired", expiresAt: at(-1), eventAt: at(0) }),
      notification("expire-B-upgrade", "SUBSCRIPTION_EXPIRED", at(0))
    );
    assert.equal(oldExpired.stateApplied, true);
    const delayedUpgrade = await persistVerifiedSubscription(
      uid,
      googleVerified("token-D-upgrade", {
        active: true,
        status: "active",
        expiresAt: at(60),
        eventAt: at(-1),
        linkedToken: tokenB,
      }),
      notification("purchase-D-2", "SUBSCRIPTION_PURCHASED", at(-1))
    );
    assert.equal(delayedUpgrade.stateApplied, true);
    const after = await master(uid);
    assert.equal(after.active, true);
    assert.equal(after.purchaseReference, sha256Reference("token-D-upgrade"));
  });
});
