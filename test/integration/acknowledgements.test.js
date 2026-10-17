// Play acknowledgement from the backend, against the Firestore emulator and a fake
// Play API. Run with `npm run test:integration`.
const assert = require("node:assert/strict");
const { afterEach, beforeEach, describe, test } = require("node:test");

assert.ok(process.env.FIRESTORE_EMULATOR_HOST, "FIRESTORE_EMULATOR_HOST must point at the emulator");

const { admin } = require("../../lib/config/admin");
const {
  acknowledgeNow,
  runAcknowledgementPhase,
  SUBSCRIPTION_ACKNOWLEDGEMENT_COLLECTION,
} = require("../../lib/services/subscriptions/acknowledgements");
const { verifyGoogleSubscription } = require("../../lib/services/subscriptions/google");
const {
  persistVerifiedSubscription,
  recordUnclaimedStoreEvent,
  SUBSCRIPTION_MASTER_COLLECTION,
} = require("../../lib/services/subscriptions/persistence");
const { applyGoogleStoreEvent } = require("../../lib/handlers/verifiedSubscriptionHandlers");
const { sha256Reference } = require("../../lib/services/subscriptions/crypto");
const { installFakePlay, playSubscription, uninstallFakePlay } = require("./fakePlay");

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const at = (minutes) => new Date(Date.now() + minutes * MINUTE);
const NO_DELAYS = [0, 0];

async function clearFirestore() {
  const response = await fetch(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-mantooq/databases/(default)/documents`,
    { method: "DELETE" }
  );
  assert.ok(response.ok, `clearing Firestore failed: ${response.status}`);
}

async function ackDoc(token) {
  const snapshot = await admin
    .firestore()
    .collection(SUBSCRIPTION_ACKNOWLEDGEMENT_COLLECTION)
    .doc(sha256Reference(token))
    .get();
  return snapshot.exists ? snapshot.data() : undefined;
}

async function master(uid) {
  const snapshot = await admin.firestore().collection(SUBSCRIPTION_MASTER_COLLECTION).doc(uid).get();
  return snapshot.data();
}

const notification = (key, eventType, eventAt) => ({ key, platform: "google", environment: "test", eventType, eventAt });

beforeEach(async () => {
  await clearFirestore();
});
afterEach(() => {
  uninstallFakePlay();
});

describe("acknowledging a Play purchase from the backend", () => {
  const uid = "user-ack";
  const token = "token-ack-1";

  test("a pending purchase queues nothing until its payment completes", async () => {
    const fake = installFakePlay({
      subscriptions: { [token]: playSubscription({ state: "SUBSCRIPTION_STATE_PENDING", expiryTime: at(30) }) },
    });
    const verified = await verifyGoogleSubscription(token);
    assert.equal(verified.subscription.active, false);
    const result = await persistVerifiedSubscription(uid, verified);
    assert.equal(result.acknowledgementPending, false);
    assert.equal(await ackDoc(token), undefined);
    assert.equal(fake.calls.acknowledge.length, 0);
  });

  test("an owned purchase is acknowledged right after its entitlement commits", async () => {
    const fake = installFakePlay({ subscriptions: { [token]: playSubscription({ expiryTime: at(30) }) } });
    const result = await persistVerifiedSubscription(uid, await verifyGoogleSubscription(token));
    assert.equal(result.acknowledgementPending, true);
    let doc = await ackDoc(token);
    assert.equal(doc.status, "pending");
    assert.equal(doc.uid, uid);
    assert.equal(doc.deadlineAt.toMillis() - doc.purchasedAt.toMillis(), 3 * DAY);

    assert.equal(await acknowledgeNow(sha256Reference(token), NO_DELAYS), "done");
    doc = await ackDoc(token);
    assert.equal(doc.status, "done");
    assert.equal(doc.attempts, 1);
    assert.ok(!Object.hasOwn(doc, "nextAttemptAt"));
    assert.deepEqual(fake.calls.acknowledge, [{ productId: "premium_access", token }]);

    // A renewal arrives acknowledged and queues nothing new.
    fake.subscriptions[token] = playSubscription({ expiryTime: at(60), acknowledged: true });
    const renewal = await persistVerifiedSubscription(uid, await verifyGoogleSubscription(token, undefined, at(1)), notification("renew-1", "SUBSCRIPTION_RENEWED", at(1)));
    assert.equal(renewal.acknowledgementPending, false);
    assert.equal((await ackDoc(token)).status, "done");
  });

  test("outages are retried promptly, then by the pass with backoff, until Play accepts", async () => {
    const fake = installFakePlay({
      subscriptions: { [token]: playSubscription({ expiryTime: at(30) }) },
      acknowledge: [503, 503, 503, 409],
    });
    await persistVerifiedSubscription(uid, await verifyGoogleSubscription(token));
    assert.equal(await acknowledgeNow(sha256Reference(token), NO_DELAYS), "transient");
    let doc = await ackDoc(token);
    assert.equal(doc.status, "pending");
    assert.equal(doc.attempts, 3);
    assert.ok(doc.nextAttemptAt.toMillis() > Date.now());

    // Not due yet: the pass leaves it alone.
    let summary = await runAcknowledgementPhase(new Date(), new Date(Date.now() + MINUTE));
    assert.equal(summary.examined, 0);

    // Due: a conflict is retried, the next pass succeeds.
    summary = await runAcknowledgementPhase(new Date(doc.nextAttemptAt.toMillis()), new Date(Date.now() + MINUTE));
    assert.deepEqual(summary, { examined: 1, acknowledged: 0, retried: 1, abandoned: 0, claimed: 0 });
    doc = await ackDoc(token);
    assert.equal(doc.attempts, 4);
    summary = await runAcknowledgementPhase(new Date(doc.nextAttemptAt.toMillis()), new Date(Date.now() + MINUTE));
    assert.deepEqual(summary, { examined: 1, acknowledged: 1, retried: 0, abandoned: 0, claimed: 0 });
    assert.equal((await ackDoc(token)).status, "done");
    assert.equal(fake.calls.acknowledge.length, 5);
  });

  test("a rejection is final unless Play already shows the purchase acknowledged", async () => {
    const fake = installFakePlay({
      subscriptions: {
        [token]: playSubscription({ expiryTime: at(30) }),
        "token-ack-2": playSubscription({ expiryTime: at(30) }),
      },
      acknowledge: [400, 400],
    });
    await persistVerifiedSubscription(uid, await verifyGoogleSubscription(token));
    assert.equal(await acknowledgeNow(sha256Reference(token), NO_DELAYS), "permanent");
    const abandoned = await ackDoc(token);
    assert.equal(abandoned.status, "abandoned");
    assert.equal(abandoned.abandonReason, "http-400");
    assert.ok(!Object.hasOwn(abandoned, "nextAttemptAt"));

    // The app acknowledged first: Play rejects ours but reports it acknowledged.
    await persistVerifiedSubscription("user-ack-2", await verifyGoogleSubscription("token-ack-2"));
    fake.subscriptions["token-ack-2"].acknowledgementState = "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED";
    assert.equal(await acknowledgeNow(sha256Reference("token-ack-2"), NO_DELAYS), "done");
    assert.equal((await ackDoc("token-ack-2")).status, "done");
  });

  test("an unowned purchase waits for its owner, is acknowledged once claimed, and abandoned at the deadline", async () => {
    const fake = installFakePlay({ subscriptions: { [token]: playSubscription({ expiryTime: at(30) }) } });
    const verified = await verifyGoogleSubscription(token, undefined, at(-1));
    assert.equal(await recordUnclaimedStoreEvent(notification("purchase-1", "SUBSCRIPTION_PURCHASED", at(-1)), verified), true);
    let doc = await ackDoc(token);
    assert.equal(doc.status, "awaiting-owner");
    assert.ok(!Object.hasOwn(doc, "uid"));
    assert.equal(await acknowledgeNow(sha256Reference(token), NO_DELAYS), "skipped");

    // Before the deadline and still unclaimed: the pass only reschedules.
    let summary = await runAcknowledgementPhase(new Date(), new Date(Date.now() + MINUTE));
    assert.deepEqual(summary, { examined: 1, acknowledged: 0, retried: 1, abandoned: 0, claimed: 0 });
    assert.equal(fake.calls.acknowledge.length, 0);

    // The app verifies: the claim flips the queued acknowledgement in the same commit.
    const claimed = await persistVerifiedSubscription(uid, verified);
    assert.equal(claimed.acknowledgementPending, true);
    doc = await ackDoc(token);
    assert.equal(doc.status, "pending");
    assert.equal(doc.uid, uid);
    summary = await runAcknowledgementPhase(new Date(doc.nextAttemptAt.toMillis()), new Date(Date.now() + MINUTE));
    assert.equal(summary.acknowledged, 1);
    assert.equal((await ackDoc(token)).status, "done");

    // Another unowned purchase nobody ever claims is abandoned once its deadline passes.
    fake.subscriptions["token-orphan"] = playSubscription({ expiryTime: at(30), startTime: new Date(Date.now() - 4 * DAY) });
    const orphan = await verifyGoogleSubscription("token-orphan", undefined, at(-1));
    await recordUnclaimedStoreEvent(notification("purchase-orphan", "SUBSCRIPTION_PURCHASED", at(-1)), orphan);
    summary = await runAcknowledgementPhase(new Date(), new Date(Date.now() + MINUTE));
    assert.deepEqual(summary, { examined: 1, acknowledged: 0, retried: 0, abandoned: 1, claimed: 0 });
    const abandoned = await ackDoc("token-orphan");
    assert.equal(abandoned.status, "abandoned");
    assert.equal(abandoned.abandonReason, "owner-unresolved");
    assert.equal(fake.calls.acknowledge.length, 1);
  });

  test("the pass claims an awaiting-owner purchase itself once an ownership record exists", async () => {
    const fake = installFakePlay({ subscriptions: { [token]: playSubscription({ expiryTime: at(30) }) } });
    const verified = await verifyGoogleSubscription(token, undefined, at(-1));
    await recordUnclaimedStoreEvent(notification("purchase-2", "SUBSCRIPTION_PURCHASED", at(-1)), verified);
    // Entitlement committed by a claim that did not touch the acknowledgement doc
    // (a build before this one, say): the ownership record is what the pass reads.
    fake.subscriptions[token].acknowledgementState = "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED";
    await persistVerifiedSubscription(uid, await verifyGoogleSubscription(token));
    fake.subscriptions[token].acknowledgementState = "ACKNOWLEDGEMENT_STATE_PENDING";
    const summary = await runAcknowledgementPhase(new Date(), new Date(Date.now() + MINUTE));
    assert.deepEqual(summary, { examined: 1, acknowledged: 1, retried: 0, abandoned: 0, claimed: 1 });
    const doc = await ackDoc(token);
    assert.equal(doc.status, "done");
    assert.equal(doc.uid, uid);
  });
});

describe("the Play store path through the handler", () => {
  const uid = "user-handler";
  const tokenB = "token-B-monthly";
  const tokenC = "token-C-yearly";

  test("the lab timeline: void, resubscribe, re-delivered void, with every purchase acknowledged once", async () => {
    const fake = installFakePlay({
      subscriptions: { [tokenB]: playSubscription({ expiryTime: at(20), startTime: at(-12) }) },
    });
    // The app verifies B.
    await persistVerifiedSubscription(uid, await verifyGoogleSubscription(tokenB));
    await acknowledgeNow(sha256Reference(tokenB), NO_DELAYS);
    assert.equal((await master(uid)).active, true);

    // B is charged back: Play reports it expired and sends VOIDED_PURCHASE.
    fake.subscriptions[tokenB] = playSubscription({ state: "SUBSCRIPTION_STATE_EXPIRED", expiryTime: at(-5), acknowledged: true, autoRenewing: false });
    const voided = await applyGoogleStoreEvent({
      purchaseToken: tokenB, eventType: "VOIDED_PURCHASE", eventKey: "msg-1", eventAt: at(1), refundType: 2,
      operationId: "op-1", logEvent: "test_event",
    });
    assert.deepEqual(voided, { claimed: true, duplicate: false, stateApplied: true });
    assert.equal((await master(uid)).status, "revoked");

    // The user buys C; the app verifies it.
    fake.subscriptions[tokenC] = playSubscription({ expiryTime: at(30), startTime: at(-2) });
    await persistVerifiedSubscription(uid, await verifyGoogleSubscription(tokenC));
    await acknowledgeNow(sha256Reference(tokenC), NO_DELAYS);
    assert.equal((await master(uid)).purchaseReference, sha256Reference(tokenC));

    // Play re-delivers B's void with a new message id and a newer time.
    const redelivered = await applyGoogleStoreEvent({
      purchaseToken: tokenB, eventType: "VOIDED_PURCHASE", eventKey: "msg-2", eventAt: at(3), refundType: 2,
      operationId: "op-2", logEvent: "test_event",
    });
    assert.deepEqual(redelivered, { claimed: true, duplicate: false, stateApplied: false });
    const after = await master(uid);
    assert.equal(after.active, true);
    assert.equal(after.purchaseReference, sha256Reference(tokenC));

    // The same message again is a duplicate.
    const again = await applyGoogleStoreEvent({
      purchaseToken: tokenB, eventType: "VOIDED_PURCHASE", eventKey: "msg-2", eventAt: at(3),
      operationId: "op-3", logEvent: "test_event",
    });
    assert.equal(again.duplicate, true);
    assert.deepEqual(fake.calls.acknowledge.map((call) => call.token), [tokenB, tokenC]);
  });

  test("a Play Store resubscription is claimed for the expired purchase's owner and acknowledged", async () => {
    const tokenNew = "token-new-from-store";
    const fake = installFakePlay({
      subscriptions: {
        [tokenB]: playSubscription({ state: "SUBSCRIPTION_STATE_EXPIRED", expiryTime: at(-100), acknowledged: true, autoRenewing: false }),
      },
    });
    await persistVerifiedSubscription(uid, await verifyGoogleSubscription(tokenB));
    assert.equal((await master(uid)).active, false);

    fake.subscriptions[tokenNew] = playSubscription({ expiryTime: at(30), expiredPurchaseToken: tokenB });
    const purchased = await applyGoogleStoreEvent({
      purchaseToken: tokenNew, eventType: "SUBSCRIPTION_PURCHASED", eventKey: "msg-10", eventAt: at(0),
      operationId: "op-10", logEvent: "test_event",
    });
    assert.deepEqual(purchased, { claimed: true, duplicate: false, stateApplied: true });
    const after = await master(uid);
    assert.equal(after.active, true);
    assert.equal(after.purchaseReference, sha256Reference(tokenNew));
    const doc = await ackDoc(tokenNew);
    assert.equal(doc.status, "done");
    assert.equal(doc.uid, uid);
    assert.deepEqual(fake.calls.acknowledge, [{ productId: "premium_access", token: tokenNew }]);
  });

  test("a resubscription whose expired purchase nobody verified stays unclaimed and waits for its owner", async () => {
    const tokenNew = "token-new-unknown-past";
    const fake = installFakePlay({
      subscriptions: { [tokenNew]: playSubscription({ expiryTime: at(30), expiredPurchaseToken: "token-never-seen" }) },
    });
    const purchased = await applyGoogleStoreEvent({
      purchaseToken: tokenNew, eventType: "SUBSCRIPTION_PURCHASED", eventKey: "msg-20", eventAt: at(0),
      operationId: "op-20", logEvent: "test_event",
    });
    assert.deepEqual(purchased, { claimed: false, duplicate: false, stateApplied: false });
    assert.equal((await ackDoc(tokenNew)).status, "awaiting-owner");
    assert.equal(fake.calls.acknowledge.length, 0);
  });
});
