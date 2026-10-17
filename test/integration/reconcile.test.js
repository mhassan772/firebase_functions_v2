// The scheduled recovery pass, against the Firestore emulator with fake store feeds.
// Run with `npm run test:integration`.
const assert = require("node:assert/strict");
const { afterEach, beforeEach, describe, test } = require("node:test");

assert.ok(process.env.FIRESTORE_EMULATOR_HOST, "FIRESTORE_EMULATOR_HOST must point at the emulator");

const { admin } = require("../../lib/config/admin");
const {
  appleHistoryPhase,
  googleVoidedPhase,
  handleReconcileSubscriptions,
  runFeedPhase,
  SUBSCRIPTION_RECONCILE_COLLECTION,
} = require("../../lib/handlers/subscriptionReconcileHandlers");
const { setAppleHistoryApi } = require("../../lib/services/subscriptions/apple");
const { verifyGoogleSubscription } = require("../../lib/services/subscriptions/google");
const { sha256Reference } = require("../../lib/services/subscriptions/crypto");
const { SubscriptionError } = require("../../lib/services/subscriptions/errors");
const {
  persistVerifiedSubscription,
  recordUnclaimedStoreEvent,
  storeEventExists,
  SUBSCRIPTION_MASTER_COLLECTION,
} = require("../../lib/services/subscriptions/persistence");
const { installFakePlay, playSubscription, uninstallFakePlay } = require("./fakePlay");

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const at = (minutes) => new Date(Date.now() + minutes * MINUTE);
const soon = () => new Date(Date.now() + MINUTE);

async function clearFirestore() {
  const response = await fetch(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-mantooq/databases/(default)/documents`,
    { method: "DELETE" }
  );
  assert.ok(response.ok, `clearing Firestore failed: ${response.status}`);
}

async function reconcileState(source) {
  const snapshot = await admin.firestore().collection(SUBSCRIPTION_RECONCILE_COLLECTION).doc(source).get();
  return snapshot.data();
}

async function master(uid) {
  const snapshot = await admin.firestore().collection(SUBSCRIPTION_MASTER_COLLECTION).doc(uid).get();
  return snapshot.data();
}

const voidedEntry = (purchaseToken, orderId, minutesAgo = 10, reason = 7) => ({
  purchaseToken,
  ...(orderId ? { orderId } : {}),
  voidedTimeMillis: String(at(-minutesAgo).getTime()),
  voidedReason: reason,
  voidedSource: 1,
});

beforeEach(async () => {
  await clearFirestore();
});
afterEach(() => {
  uninstallFakePlay();
  setAppleHistoryApi(undefined);
});

describe("replaying Play's voided purchases", () => {
  const uid = "user-voided";
  const tokenV = "token-V-charged-back";
  const tokenW = "token-W-rejected-by-play";
  const tokenX = "token-X-play-outage";
  const tokenY = "token-Y-second-page";

  test("pages are applied in full, rejected tokens are dropped, outages are retained, and the checkpoint lands on the window's end", async () => {
    const fake = installFakePlay({
      subscriptions: {
        [tokenV]: playSubscription({ expiryTime: at(20), acknowledged: true }),
        [tokenW]: 400,
        [tokenX]: 503,
        [tokenY]: playSubscription({ state: "SUBSCRIPTION_STATE_EXPIRED", expiryTime: at(-30), acknowledged: true, autoRenewing: false }),
      },
      voided: [
        { voidedPurchases: [voidedEntry(tokenV, "GPA.1", -1), voidedEntry(tokenW, undefined), voidedEntry(tokenX, "GPA.3")], tokenPagination: { nextPageToken: "page-2" } },
        { voidedPurchases: [voidedEntry(tokenY, "GPA.4")] },
      ],
    });
    await persistVerifiedSubscription(uid, await verifyGoogleSubscription(tokenV));
    assert.equal((await master(uid)).active, true);
    // Play now reports V charged back.
    fake.subscriptions[tokenV] = playSubscription({ state: "SUBSCRIPTION_STATE_EXPIRED", expiryTime: at(-10), acknowledged: true, autoRenewing: false });

    const now = new Date();
    const summary = await runFeedPhase(googleVoidedPhase("op-1"), now, soon());
    assert.deepEqual(summary, { pages: 2, processed: 4, applied: 1, skipped: 1, dropped: 1, retained: 1, completed: true });

    const after = await master(uid);
    assert.equal(after.active, false);
    assert.equal(after.status, "revoked");
    assert.equal(await storeEventExists("google", "test", "voided:GPA.1"), true);
    // Y had no owner: recorded unclaimed under its order key.
    assert.equal(await storeEventExists("google", "test", "voided:GPA.4"), true);

    const state = await reconcileState("google-voided");
    assert.equal(state.checkpointAt.toMillis(), now.getTime());
    assert.equal(state.window, undefined);
    assert.equal(state.retained.length, 1);
    assert.equal(state.retained[0].key, "voided:GPA.3");
    assert.equal(state.retained[0].code, "google-api-unavailable");
    assert.deepEqual(fake.calls.voided.map((call) => call.pageToken), [undefined, "page-2"]);
    assert.equal(fake.calls.voided[0].startTimeMillis, now.getTime() - 29 * DAY);
    assert.equal(fake.calls.voided[0].endTimeMillis, now.getTime());

    // Next run: the retained item is retried first, and the window starts at the checkpoint.
    fake.subscriptions[tokenX] = playSubscription({ state: "SUBSCRIPTION_STATE_EXPIRED", expiryTime: at(-5), acknowledged: true, autoRenewing: false });
    fake.voided = [];
    const later = new Date(now.getTime() + 6 * 60 * MINUTE);
    const second = await runFeedPhase(googleVoidedPhase("op-2"), later, new Date(later.getTime() + MINUTE));
    assert.deepEqual(second, { pages: 1, processed: 1, applied: 0, skipped: 1, dropped: 0, retained: 0, completed: true });
    const afterSecond = await reconcileState("google-voided");
    assert.equal(afterSecond.retained.length, 0);
    assert.equal(afterSecond.checkpointAt.toMillis(), later.getTime());
    assert.equal(fake.calls.voided[2].startTimeMillis, now.getTime());
  });

  test("a failing page keeps the window and its token for the next run", async () => {
    const fake = installFakePlay({
      subscriptions: { [tokenY]: playSubscription({ state: "SUBSCRIPTION_STATE_EXPIRED", expiryTime: at(-30), acknowledged: true, autoRenewing: false }) },
      voided: [
        { voidedPurchases: [voidedEntry(tokenY, "GPA.10")], tokenPagination: { nextPageToken: "page-2" } },
        503,
      ],
    });
    const now = new Date();
    const first = await runFeedPhase(googleVoidedPhase("op-3"), now, soon());
    assert.equal(first.completed, false);
    assert.equal(first.pages, 1);
    let state = await reconcileState("google-voided");
    assert.equal(state.checkpointAt, undefined);
    assert.equal(state.window.pageToken, "page-2");
    assert.equal(state.window.endAt.toMillis(), now.getTime());

    fake.voided = [{ voidedPurchases: [] }];
    const later = new Date(now.getTime() + 6 * 60 * MINUTE);
    const second = await runFeedPhase(googleVoidedPhase("op-4"), later, new Date(later.getTime() + MINUTE));
    assert.equal(second.completed, true);
    // The resumed page keeps the original window; the time filters are ignored with a token anyway.
    const resumedCall = fake.calls.voided[1];
    assert.equal(resumedCall.pageToken, "page-2");
    assert.equal(resumedCall.endTimeMillis, now.getTime());
    state = await reconcileState("google-voided");
    assert.equal(state.checkpointAt.toMillis(), now.getTime());
    assert.equal(state.window, undefined);
  });

  test("when the retry list is full the run stops instead of forgetting a failure", async () => {
    installFakePlay({
      subscriptions: { [tokenX]: 503, "token-Z-outage": 503 },
      voided: [{ voidedPurchases: [voidedEntry(tokenX, "GPA.20"), voidedEntry("token-Z-outage", "GPA.21")] }],
    });
    const phase = { ...googleVoidedPhase("op-5"), maxRetained: 1 };
    const summary = await runFeedPhase(phase, new Date(), soon());
    assert.equal(summary.completed, false);
    assert.equal(summary.retained, 1);
    const state = await reconcileState("google-voided");
    assert.equal(state.checkpointAt, undefined);
    assert.equal(state.window.pageToken, undefined);
    assert.equal(state.retained.length, 1);
  });

  test("a checkpoint older than the feed keeps is clamped and the gap is a run-level fact", async () => {
    const fake = installFakePlay({ voided: [{ voidedPurchases: [] }] });
    const now = new Date();
    await admin.firestore().collection(SUBSCRIPTION_RECONCILE_COLLECTION).doc("google-voided").set({
      checkpointAt: admin.firestore.Timestamp.fromMillis(now.getTime() - 40 * DAY),
    });
    const summary = await runFeedPhase(googleVoidedPhase("op-6"), now, soon());
    assert.equal(summary.completed, true);
    assert.equal(fake.calls.voided[0].startTimeMillis, now.getTime() - 29 * DAY);
  });
});

describe("replaying Apple's notification history", () => {
  const encode = (payload) =>
    `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
  const item = (uuid, environment = "Sandbox") => ({ signedPayload: encode({ notificationUUID: uuid, data: { environment } }) });

  function installFakeApple(pages) {
    const calls = [];
    setAppleHistoryApi({
      async getNotificationHistory(environment, paginationToken, range) {
        calls.push({ environment, paginationToken, range });
        const page = pages.shift() ?? {};
        if (page instanceof Error) throw page;
        return page;
      },
    });
    return calls;
  }

  test("seen notifications are skipped by their id, unseen ones go through the verified path, failures are retained", async () => {
    await recordUnclaimedStoreEvent({ key: "uuid-seen", platform: "apple", environment: "sandbox", eventType: "DID_RENEW", eventAt: at(-5) });
    const calls = installFakeApple([
      { notificationHistory: [item("uuid-seen"), item("uuid-new"), item("uuid-production", "Production")], hasMore: true, paginationToken: "apple-page-2" },
      { notificationHistory: [item("uuid-failing")], hasMore: false },
    ]);
    const applied = [];
    const apply = async (signedPayload) => {
      applied.push(signedPayload);
      if (signedPayload === item("uuid-failing").signedPayload) {
        throw new SubscriptionError("store-unavailable", "apple-api-unavailable", "down", true);
      }
      return { stateApplied: true };
    };
    const now = new Date();
    const summary = await runFeedPhase(appleHistoryPhase("sandbox", "op-7", apply), now, soon());
    assert.deepEqual(summary, { pages: 2, processed: 4, applied: 1, skipped: 2, dropped: 0, retained: 1, completed: true });
    assert.deepEqual(applied, [item("uuid-new").signedPayload, item("uuid-failing").signedPayload]);
    assert.deepEqual(calls.map((call) => call.paginationToken), [undefined, "apple-page-2"]);
    assert.equal(calls[0].range.startDate, now.getTime() - 179 * DAY);
    assert.equal(calls[0].environment, "sandbox");

    const state = await reconcileState("apple-history-sandbox");
    assert.equal(state.checkpointAt.toMillis(), now.getTime());
    assert.equal(state.retained[0].key, "uuid-failing");
    assert.equal(state.retained[0].item.signedPayload, item("uuid-failing").signedPayload);
  });

  test("when Apple refuses the start date the window moves forward until accepted, and the checkpoint still lands", async () => {
    const { APPLE_HISTORY_START_TOO_EARLY_CODE } = require("../../lib/services/subscriptions/apple");
    const calls = [];
    const now = new Date();
    setAppleHistoryApi({
      async getNotificationHistory(environment, paginationToken, range) {
        calls.push(range.startDate);
        if (range.startDate < now.getTime() - 30 * DAY - 1000) {
          throw new SubscriptionError("invalid-store-data", APPLE_HISTORY_START_TOO_EARLY_CODE, "too early");
        }
        return { notificationHistory: [item("uuid-recent")], hasMore: false };
      },
    });
    const applied = [];
    const summary = await runFeedPhase(appleHistoryPhase("sandbox", "op-9", async (payload) => { applied.push(payload); return { stateApplied: true }; }), now, soon());
    assert.equal(summary.completed, true);
    assert.equal(summary.applied, 1);
    assert.deepEqual(calls, [now.getTime() - 179 * DAY, now.getTime() - 90 * DAY, now.getTime() - 30 * DAY]);
    const state = await reconcileState("apple-history-sandbox");
    assert.equal(state.checkpointAt.toMillis(), now.getTime());
    assert.equal(state.window, undefined);
  });

  test("a payload Apple rejects is dropped, not retained", async () => {
    installFakeApple([{ notificationHistory: [item("uuid-bad")], hasMore: false }]);
    const apply = async () => {
      throw new SubscriptionError("invalid-store-data", "apple-signature-or-data-invalid", "bad");
    };
    const summary = await runFeedPhase(appleHistoryPhase("sandbox", "op-8", apply), new Date(), soon());
    assert.deepEqual(summary, { pages: 1, processed: 1, applied: 0, skipped: 0, dropped: 1, retained: 0, completed: true });
    assert.equal((await reconcileState("apple-history-sandbox")).retained.length, 0);
  });
});

describe("the whole pass", () => {
  test("one phase failing leaves the others running, and the summary says which failed", async () => {
    installFakePlay({ voided: [500] });
    setAppleHistoryApi({
      async getNotificationHistory() {
        throw new Error("apple down");
      },
    });
    const summary = await handleReconcileSubscriptions({ budgetScale: 0.01 });
    assert.deepEqual(summary.acknowledgements, { examined: 0, acknowledged: 0, retried: 0, abandoned: 0, claimed: 0 });
    assert.equal(summary.googleVoided.completed, false);
    assert.equal(summary.googleVoided.pages, 0);
    assert.equal(summary.appleHistoryProduction.completed, false);
    assert.equal(summary.appleHistorySandbox.completed, false);
    assert.ok(summary.durationMs >= 0);
    assert.ok(typeof summary.operationId === "string");
  });
});
