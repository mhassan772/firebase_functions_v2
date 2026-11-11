// Account deletion against the Firestore and Auth emulators. Run with `npm run test:integration`,
// which starts them under a demo project, so nothing here can reach real data. Storage is a fake.
const assert = require("node:assert/strict");
const { beforeEach, describe, test } = require("node:test");

assert.ok(process.env.FIRESTORE_EMULATOR_HOST, "FIRESTORE_EMULATOR_HOST must point at the emulator");
assert.ok(process.env.FIREBASE_AUTH_EMULATOR_HOST, "FIREBASE_AUTH_EMULATOR_HOST must point at the emulator");

const { admin } = require("../../lib/config/admin");
const { Timestamp } = require("firebase-admin/firestore");
const { purgeAccount } = require("../../lib/services/accountDeletion/purge");
const inventory = require("../../lib/services/accountDeletion/inventory");
const { DELETED_ACCOUNTS_COLLECTION } = require("../../lib/services/accountDeletion/tombstone");
const {
  handleAccountDeleted,
  handleDeleteAccount,
  handleSweepDeletedAccounts,
  SWEEP_MIN_AGE_MS,
  CLOSED_TOMBSTONE_RETENTION_MS,
} = require("../../lib/handlers/accountDeletionHandlers");
const { addressDocId, uidDocId } = require("../../lib/services/authEmailThrottle");
const {
  legacyManualDocumentId,
  persistVerifiedSubscription,
  stateDocumentId,
} = require("../../lib/services/subscriptions/persistence");
const { asCallableError, SubscriptionError } = require("../../lib/services/subscriptions/errors");
const { storeEventDocumentId } = require("../../lib/services/subscriptions/persistence");
const { verifyGoogleSubscription } = require("../../lib/services/subscriptions/google");
const { applyGoogleStoreEvent, applyVerifiedAppleNotification } = require("../../lib/handlers/verifiedSubscriptionHandlers");
const { installFakePlay, playSubscription, uninstallFakePlay } = require("./fakePlay");
const { clearCommunityGoalCache, handleListeningDaysChange } = require("../../lib/handlers/communityGoalTriggerHandlers");

const db = () => admin.firestore();
const A = "AccountAaaaaaaaaaaaaaaaaa01";
const B = "AccountBbbbbbbbbbbbbbbbbbb02";
const EMAIL_A = "a.deleted@example.com";
const EMAIL_B = "b.kept@example.com";
const DAY = 86_400_000;
const today = Math.floor(Date.now() / DAY);
const YEAR = new Date(today * DAY).getUTCFullYear();
const GOAL_KEY = "h140001";

async function clearFirestore() {
  const response = await fetch(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-mantooq/databases/(default)/documents`,
    { method: "DELETE" }
  );
  assert.ok(response.ok, `clearing Firestore failed: ${response.status}`);
}

async function clearAuth() {
  const response = await fetch(
    `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/emulator/v1/projects/demo-mantooq/accounts`,
    { method: "DELETE" }
  );
  assert.ok(response.ok, `clearing Auth failed: ${response.status}`);
}

/** An in-memory bucket. */
function fakeStorage(names) {
  const objects = new Set(names);
  return {
    objects,
    async deleteByPrefix(prefix) {
      let count = 0;
      for (const name of [...objects]) {
        if (name.startsWith(prefix)) {
          objects.delete(name);
          count += 1;
        }
      }
      return count;
    },
  };
}

const storageNames = (uid) => [
  `subscriptions/${uid}_1700000000000_receipt.jpg`,
  `restoreSubscriptionMigration/${uid}_1700000000000_old.jpg`,
  `reportingIssues/${uid}_1700000000000_screen.png`,
  `logFiles/${uid}_1700000000000_log.txt`,
];

const at = Timestamp.fromMillis(Date.UTC(2026, 9, 1));
const chunkRow = (cs) => ({ d: "phone", day: today, m: 1, cs, ss: 0, sl: 0, g: 0, u: 0 });

/**
 * Writes one account in every shape the inventory knows. Returns the paths it wrote that belong
 * to the account alone, and the shared ones, which a purge of the account must keep.
 */
async function seedAccount(uid, email, sharedDevice) {
  const own = [];
  const set = async (path, data) => {
    await db().doc(path).set(data);
    own.push(path);
  };
  await set(`listener_totals/${uid}`, { seconds: 3600, months: { [GOAL_KEY]: { c: 600, a: 600 } } });
  for (const collection of inventory.UID_KEYED_COLLECTIONS) {
    await set(`${collection}/${uid}`, { owner: uid, n: 1 });
  }
  // Subcollections, one of them under a parent document that does not exist.
  await set(`users/${uid}/downloaded_books/book-1`, { at });
  await set(`playback_progress_v2/${uid}/chunks/0`, { items: [uid] });
  await set(`episodes_lists/${uid}/lists/list-1`, { name: "x" });
  await set(`playlists/${uid}/book_playlists/p1`, { name: "x" });
  await set(`listening_history/${uid}/chunks/${YEAR}`, { days: [chunkRow(600)] });
  await set(`listening_history/${uid}/completions/${YEAR}`, { n: 1 });
  await set(`bookmarks/${uid}/bookmarks_chunk/0`, { n: 1 });
  await set(`bookmarks/${uid}/tags/t1`, { n: 1 });
  await set(`bookmarks/${uid}/book_bookmarks/b1`, { n: 1 });
  await set(`user_books/${uid}/user_books_chunk/0`, { books: [] });
  await set(`url_grants/${uid}/books/guid-1`, { kind: "books" });
  await set(`routine_activity/${uid}/days/2026-11-01/entries/e1`, { n: 1 });
  // The older likes and flags, nested under the uid with no user_guid field.
  await set(`re_user_liked_comments/${uid}/book-1/commenter-1`, { liked: true });
  await set(`re_user_flagged_comments/${uid}/book-1/commenter-1`, { flagged: true });
  await db().doc(`url_grants/${uid}`).set({ devices: { [sharedDevice]: at, [`solo-${uid}`]: at } }, { merge: true });
  // A device only this account used: the device's own allowance stays, the account leaves it.
  await db().doc(`url_grants_devices/solo-${uid}`).set({ guestUids: { [uid]: at }, guestUidsCount: 1, recentBooks: [] });
  await set(`auth_email_throttle/${uidDocId(uid)}`, { count: 1 });
  await set(`auth_email_throttle/${addressDocId(email)}`, { count: 1 });

  for (const { collection, field } of inventory.FIELD_KEYED_COLLECTIONS) {
    await set(`${collection}/${collection}-${uid}-1`, { [field]: uid, value: 1 });
    await set(`${collection}/${collection}-${uid}-2`, { [field]: uid, value: 2 });
  }
  // A's report points at B's upload: paths on documents are never followed.
  await set(`reporting_issues/report-${uid}`, {
    user_guid: uid,
    media_link: `reportingIssues/${uid === A ? B : uid}_1700000000000_screen.png`,
    log_file_link: `logFiles/${uid}_1700000000000_log.txt`,
  });

  for (const slot of [
    { platform: "apple", environment: "production" },
    { platform: "manual", environment: "production" },
  ]) {
    await set(`subscription_store_state/${stateDocumentId(uid, slot.platform, slot.environment)}`, { uid, ...slot });
  }
  await set(`subscriptions_manual/${legacyManualDocumentId(uid)}`, { expiry: at });
  await set(`subscriptions_manual/${uid}`, { expiry: at });
  await set(`subscription_acknowledgements/ack-${uid}`, { uid, status: "pending" });
  await set(`subscription_purchase_ownership/apple_owner-${uid}`, { uid, platform: "apple" });

  const payments = [];
  for (const collection of inventory.PAYMENT_REQUEST_COLLECTIONS) {
    // Auto ids in production, so the id never names the payer.
    const path = `${collection}/request-${uid.slice(-2)}`;
    await db().doc(path).set({
      user_guid: uid,
      subscription_id: `hash-of-${uid}`,
      phone_number_sent_from: "01000000000",
      notes: `from ${uid}`,
      admin_notes: "checked",
      photo_link: `${collection === "subscriptions_to_be_approved" ? "subscriptions" : "restoreSubscriptionMigration"}/${uid}_1700000000000_receipt.jpg`,
      amount_paid: 150,
      payment_method: "vodafone_cash",
      duration: "yearly",
      status: "approved",
      country_code: "EG",
      created_at: at,
    });
    payments.push(path);
  }
  return { own, payments };
}

async function seedBoth() {
  const shared = "device-shared";
  await db().doc(`url_grants_devices/${shared}`).set({
    guestUids: { [A]: at, [B]: at },
    guestUidsCount: 2,
    recentBooks: [{ guid: "g", at }],
  });
  const a = await seedAccount(A, EMAIL_A, shared);
  const b = await seedAccount(B, EMAIL_B, shared);
  const storage = fakeStorage([...storageNames(A), ...storageNames(B)]);
  return { a, b, shared, storage };
}

/** Every document in the database, by path. */
async function dumpAll() {
  const out = new Map();
  const walk = async (collections) => {
    for (const collection of collections) {
      const refs = await collection.listDocuments();
      for (const ref of refs) {
        const snapshot = await ref.get();
        if (snapshot.exists) out.set(ref.path, snapshot.data());
        await walk(await ref.listCollections());
      }
    }
  };
  await walk(await db().listCollections());
  return out;
}

const purgeDeps = (storage, now = Date.now) => ({
  firestore: db(),
  storage,
  now,
  cancelWebSubscription: async () => {},
});

describe("purgeAccount", () => {
  beforeEach(clearFirestore);

  test("removes everything of one account, anonymises its payments, keeps the other account whole", async () => {
    const { a, b, shared, storage } = await seedBoth();
    const before = await dumpAll();

    const first = await purgeAccount(A, purgeDeps(storage), { state: "pending", email: EMAIL_A });
    assert.equal(first.ok, true, JSON.stringify(first.failedSteps));
    assert.ok(first.counts.uid_keyed > inventory.UID_KEYED_COLLECTIONS.length);

    const after = await dumpAll();
    for (const path of a.own) assert.equal(after.has(path), false, `${path} remains`);
    for (const path of [
      `re_banned_users/${A}`,
      `re_user_liked_comments/${A}/book-1/commenter-1`,
      `re_user_flagged_comments/${A}/book-1/commenter-1`,
      `re_user_liked_comments/re_user_liked_comments-${A}-1`,
      `users/users-${A}-1`,
    ]) {
      assert.ok(a.own.includes(path), `${path} was seeded`);
      assert.equal(after.has(path), false, `${path} remains`);
    }
    for (const path of [
      `re_banned_users/${B}`,
      `re_user_liked_comments/${B}/book-1/commenter-1`,
      `re_user_flagged_comments/${B}/book-1/commenter-1`,
      `users/users-${B}-1`,
    ]) {
      assert.ok(after.has(path), `${path} was touched`);
    }

    // Nothing anywhere still names the account, apart from its tombstone and its shared device id.
    for (const [path, data] of after) {
      if (path === `${DELETED_ACCOUNTS_COLLECTION}/${A}` || path === `url_grants_devices/solo-${A}`) continue;
      const text = `${path} ${JSON.stringify(data)}`;
      assert.ok(!text.includes(A) && !text.includes(A.toLowerCase()), `${path} still names the account`);
    }

    for (const path of a.payments) {
      const data = after.get(path);
      assert.ok(data, `${path} was deleted instead of anonymised`);
      for (const field of inventory.PAYMENT_REQUEST_STRIPPED_FIELDS) assert.equal(field in data, false, `${path}.${field}`);
      assert.ok(data.anonymised_at instanceof Timestamp);
      const original = before.get(path);
      for (const field of ["amount_paid", "payment_method", "duration", "status", "country_code"]) {
        assert.deepEqual(data[field], original[field], `${path}.${field}`);
      }
      assert.ok(data.created_at.isEqual(original.created_at));
    }

    const device = after.get(`url_grants_devices/${shared}`);
    assert.deepEqual(Object.keys(device.guestUids), [B]);
    assert.equal(device.guestUidsCount, 1);
    assert.deepEqual(device.recentBooks.map((e) => e.guid), ["g"]);
    const solo = after.get(`url_grants_devices/solo-${A}`);
    assert.deepEqual(solo, { guestUids: {}, guestUidsCount: 0, recentBooks: [] });

    for (const path of [...b.own, ...b.payments]) assert.deepEqual(after.get(path), before.get(path), path);
    // B's upload stays even though A's report pointed at it.
    assert.deepEqual([...storage.objects].sort(), storageNames(B).sort());

    const tombstone = after.get(`${DELETED_ACCOUNTS_COLLECTION}/${A}`);
    assert.equal(tombstone.state, "pending");
    assert.equal(tombstone.runs, 1);
    assert.equal(tombstone.lastRunOk, true);
    assert.deepEqual(Object.keys(tombstone).sort(), ["deletedAt", "lastRunAt", "lastRunOk", "runs", "state"]);

    const second = await purgeAccount(A, purgeDeps(storage), { email: EMAIL_A });
    assert.equal(second.ok, true);
    for (const step of [
      "read",
      "listener_totals",
      "uid_keyed",
      "field_keyed",
      "url_grants_devices",
      "subscription_records",
      "payment_requests",
      "storage",
    ]) {
      assert.equal(second.counts[step], 0, step);
    }
    const again = await dumpAll();
    assert.deepEqual(
      [...again.keys()].filter((path) => !path.startsWith(DELETED_ACCOUNTS_COLLECTION)).sort(),
      [...after.keys()].filter((path) => !path.startsWith(DELETED_ACCOUNTS_COLLECTION)).sort()
    );
    const reopened = again.get(`${DELETED_ACCOUNTS_COLLECTION}/${A}`);
    assert.equal(reopened.runs, 2);
    assert.ok(reopened.deletedAt.isEqual(tombstone.deletedAt), "deletedAt is set once");
  });

  test("a failing device update keeps url_grants for the next run, which finishes both", async () => {
    const { shared, storage } = await seedBoth();
    // The emulator's Firestore, except that updates to device documents fail inside transactions.
    const failingDevices = new Proxy(db(), {
      get(target, property) {
        if (property === "runTransaction") {
          return (work, options) =>
            target.runTransaction(
              (transaction) =>
                work(
                  new Proxy(transaction, {
                    get(tx, name) {
                      if (name === "update") {
                        return (ref, ...rest) => {
                          if (ref.parent.id === inventory.URL_GRANTS_DEVICES_COLLECTION) throw new Error("injected");
                          return tx.update(ref, ...rest);
                        };
                      }
                      const value = Reflect.get(tx, name, tx);
                      return typeof value === "function" ? value.bind(tx) : value;
                    },
                  })
                ),
              options
            );
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const first = await purgeAccount(A, { ...purgeDeps(storage), firestore: failingDevices });
    assert.equal(first.ok, false);
    assert.ok(first.failedSteps.includes("url_grants_devices"));
    assert.ok(first.failedSteps.includes("uid_keyed"));
    assert.equal((await db().doc(`url_grants/${A}`).get()).exists, true, "kept for the next run");
    assert.equal((await db().doc(`url_grants/${A}/books/guid-1`).get()).exists, true);
    assert.equal((await db().doc(`users/${A}`).get()).exists, false, "the other uid-keyed documents still went");
    assert.ok((await db().doc(`url_grants_devices/${shared}`).get()).get(`guestUids.${A}`));
    assert.equal((await db().doc(`${DELETED_ACCOUNTS_COLLECTION}/${A}`).get()).get("lastRunOk"), false);

    const second = await purgeAccount(A, purgeDeps(storage));
    assert.equal(second.ok, true, JSON.stringify(second.failedSteps));
    assert.equal(second.counts.url_grants_devices, 2);
    assert.equal((await db().doc(`url_grants/${A}`).get()).exists, false);
    assert.equal((await db().doc(`url_grants/${A}/books/guid-1`).get()).exists, false);
    assert.deepEqual(Object.keys((await db().doc(`url_grants_devices/${shared}`).get()).get("guestUids")), [B]);
    assert.equal((await db().doc(`${DELETED_ACCOUNTS_COLLECTION}/${A}`).get()).get("lastRunOk"), true);
  });

  test("a later deleted state sticks; pending never replaces it", async () => {
    const storage = fakeStorage([]);
    await purgeAccount(A, purgeDeps(storage), { state: "deleted" });
    await purgeAccount(A, purgeDeps(storage), { state: "pending" });
    const tombstone = (await db().doc(`${DELETED_ACCOUNTS_COLLECTION}/${A}`).get()).data();
    assert.equal(tombstone.state, "deleted");
  });

  test("the chunk trigger finds nothing to write back once the purge has run", async () => {
    clearCommunityGoalCache();
    await db().doc(`community_goals/${GOAL_KEY}`).set({
      hijriYear: 1400,
      hijriMonth: 1,
      firstDay: today - 5,
      lastDay: today + 20,
      targetHours: null,
      dailyCapSeconds: 43_200,
      closeAfterDays: 3,
      show: { participants: false, pace: false, target: false, history: true },
      auto: true,
      status: "open",
      totalSeconds: 0,
    });
    const { storage } = await seedBoth();
    const chunk = { days: [chunkRow(600)] };
    const deletedChunk = { before: { data: () => chunk }, after: { data: () => undefined } };

    await purgeAccount(A, purgeDeps(storage));
    // What listeningDaysMonthTrigger delivers for the chunk the purge deleted.
    await handleListeningDaysChange(deletedChunk, A, String(YEAR));
    assert.equal((await db().doc(`listener_totals/${A}`).get()).exists, false);

    // Without the purge's order, the same event rewrites a total that still exists.
    await db().doc(`listening_history/${B}/chunks/${YEAR}`).delete();
    await handleListeningDaysChange(deletedChunk, B, String(YEAR));
    assert.deepEqual((await db().doc(`listener_totals/${B}`).get()).get(`months.${GOAL_KEY}`), { c: 0, a: 0 });
  });
});

describe("deleteAccount callable", () => {
  beforeEach(async () => {
    await clearFirestore();
    await clearAuth();
  });

  test("purges, deletes the Auth user, marks the tombstone deleted and emails the address", async () => {
    const { b, storage } = await seedBoth();
    await admin.auth().createUser({ uid: A, email: EMAIL_A });
    await admin.auth().createUser({ uid: B, email: EMAIL_B });
    const sent = [];
    const deps = {
      auth: admin.auth(),
      mailer: { send: async (message) => void sent.push(message) },
      purge: purgeDeps(storage),
    };
    const context = {
      auth: { uid: A, token: { auth_time: Math.floor(Date.now() / 1000) - 30, firebase: { sign_in_provider: "password" } } },
    };

    assert.deepEqual(await handleDeleteAccount({ lang: "en" }, context, deps), { deleted: true });
    await assert.rejects(admin.auth().getUser(A), (error) => error.code === "auth/user-not-found");
    assert.equal((await admin.auth().getUser(B)).email, EMAIL_B);
    assert.equal((await db().doc(`${DELETED_ACCOUNTS_COLLECTION}/${A}`).get()).get("state"), "deleted");
    assert.deepEqual(sent.map((m) => m.to), [EMAIL_A]);
    assert.equal((await db().doc(`users/${A}`).get()).exists, false);
    assert.equal((await db().doc(b.own[0]).get()).exists, true);
  });
});

describe("persistVerifiedSubscription after deletion", () => {
  beforeEach(clearFirestore);

  const verified = () => ({
    subscription: {
      active: true,
      status: "active",
      platform: "apple",
      productId: "monthly_sub",
      expiresAt: new Date(Date.now() + 30 * DAY),
      autoRenewing: true,
      inGracePeriod: false,
      environment: "production",
      originalTransactionId: "2000000000000099",
      lastStoreEventAt: new Date(),
      lastVerifiedAt: new Date(),
    },
    ownership: [{ platform: "apple", environment: "production", originalTransactionId: "2000000000000099" }],
  });

  for (const state of ["pending", "deleted"]) {
    test(`refuses a ${state} tombstoned account before writing anything`, async () => {
      await db().doc(`${DELETED_ACCOUNTS_COLLECTION}/${A}`).set({ state, deletedAt: Timestamp.now(), runs: 1 });
      await assert.rejects(persistVerifiedSubscription(A, verified()), (error) => {
        assert.ok(error instanceof SubscriptionError);
        assert.equal(error.kind, "forbidden");
        assert.equal(error.safeCode, "account-deleted");
        return true;
      });
      const written = [...(await dumpAll()).keys()];
      assert.deepEqual(written, [`${DELETED_ACCOUNTS_COLLECTION}/${A}`]);
    });
  }

  test("an account without a tombstone is persisted as before", async () => {
    const result = await persistVerifiedSubscription(B, verified());
    assert.equal(result.stateApplied, true);
  });
});

describe("sweepDeletedAccounts", () => {
  beforeEach(async () => {
    await clearFirestore();
    await clearAuth();
  });

  const NOW = Date.UTC(2026, 10, 16, 3, 0, 0);
  const uid = (n) => `Sweepaccount${String(n).padStart(12, "0")}`;
  const tombstone = (ageMs, extra = {}) => ({
    state: "deleted",
    deletedAt: Timestamp.fromMillis(NOW - ageMs),
    lastRunAt: Timestamp.fromMillis(NOW - ageMs),
    runs: 1,
    lastRunOk: false,
    ...extra,
  });

  function sweepDeps({ failing = new Set(), clock } = {}) {
    const purged = [];
    return {
      purged,
      deps: {
        auth: admin.auth(),
        purge: purgeDeps(fakeStorage([]), clock ?? (() => NOW)),
        async purgeAccount(id, deps, options) {
          purged.push(id);
          // The real purge's tombstone bookkeeping, without the rest.
          await db().doc(`${DELETED_ACCOUNTS_COLLECTION}/${id}`).update({ runs: 2 });
          return { operationId: "op", ok: !failing.has(id), counts: {}, failedSteps: failing.has(id) ? ["storage"] : [] };
        },
      },
    };
  }

  test("purges open tombstones over 75 minutes old, oldest first, and closes only clean runs", async () => {
    await db().doc(`${DELETED_ACCOUNTS_COLLECTION}/${uid(1)}`).set(tombstone(3 * DAY));
    await db().doc(`${DELETED_ACCOUNTS_COLLECTION}/${uid(2)}`).set(tombstone(9 * DAY));
    await db().doc(`${DELETED_ACCOUNTS_COLLECTION}/${uid(3)}`).set(tombstone(SWEEP_MIN_AGE_MS - 60_000));
    await db().doc(`${DELETED_ACCOUNTS_COLLECTION}/${uid(4)}`).set(tombstone(5 * DAY, { closedAt: Timestamp.fromMillis(NOW - DAY) }));
    await db().doc(`${DELETED_ACCOUNTS_COLLECTION}/${uid(5)}`).set(tombstone(2 * DAY));
    const { deps, purged } = sweepDeps({ failing: new Set([uid(5)]) });

    const outcome = await handleSweepDeletedAccounts(deps);
    assert.deepEqual(purged, [uid(2), uid(1), uid(5)]);
    assert.deepEqual(outcome, { closed: 2, failed: 1, left: 0, removed: 0 });
    const read = async (n) => (await db().doc(`${DELETED_ACCOUNTS_COLLECTION}/${uid(n)}`).get()).data();
    assert.equal((await read(1)).closedAt.toMillis(), NOW);
    assert.equal((await read(2)).closedAt.toMillis(), NOW);
    assert.equal((await read(3)).closedAt, undefined, "too recent");
    assert.equal((await read(5)).closedAt, undefined, "failed run stays open");
  });

  test("deletes a surviving sign-in and marks the tombstone deleted", async () => {
    await admin.auth().createUser({ uid: uid(1) });
    await admin.auth().createUser({ uid: uid(2) });
    await db().doc(`${DELETED_ACCOUNTS_COLLECTION}/${uid(1)}`).set(tombstone(DAY, { state: "pending" }));
    await db().doc(`${DELETED_ACCOUNTS_COLLECTION}/${uid(2)}`).set(tombstone(DAY, { state: "pending" }));
    const { deps } = sweepDeps({ failing: new Set([uid(2)]) });

    await handleSweepDeletedAccounts(deps);
    for (const n of [1, 2]) {
      await assert.rejects(admin.auth().getUser(uid(n)), (error) => error.code === "auth/user-not-found");
      assert.equal((await db().doc(`${DELETED_ACCOUNTS_COLLECTION}/${uid(n)}`).get()).get("state"), "deleted");
    }
    assert.ok((await db().doc(`${DELETED_ACCOUNTS_COLLECTION}/${uid(1)}`).get()).get("closedAt"));
    assert.equal((await db().doc(`${DELETED_ACCOUNTS_COLLECTION}/${uid(2)}`).get()).get("closedAt"), undefined);
  });

  test("stops starting purges when the budget is used and counts what is left", async () => {
    for (let n = 1; n <= 4; n++) {
      await db().doc(`${DELETED_ACCOUNTS_COLLECTION}/${uid(n)}`).set(tombstone((10 - n) * DAY));
    }
    let clock = NOW;
    const { deps, purged } = sweepDeps({ clock: () => clock });
    const purge = deps.purgeAccount;
    deps.purgeAccount = async (...args) => {
      clock += 100_000;
      return purge(...args);
    };

    const outcome = await handleSweepDeletedAccounts(deps, 250_000);
    assert.deepEqual(purged, [uid(1), uid(2), uid(3)]);
    assert.deepEqual(outcome, { closed: 3, failed: 0, left: 1, removed: 0 });
  });

  test("removes tombstones closed more than 90 days ago and keeps younger ones", async () => {
    const closedAgo = (ms) => tombstone(ms + DAY, { closedAt: Timestamp.fromMillis(NOW - ms) });
    await db().doc(`${DELETED_ACCOUNTS_COLLECTION}/${uid(1)}`).set(closedAgo(CLOSED_TOMBSTONE_RETENTION_MS + DAY));
    await db().doc(`${DELETED_ACCOUNTS_COLLECTION}/${uid(2)}`).set(closedAgo(CLOSED_TOMBSTONE_RETENTION_MS - DAY));
    const { deps, purged } = sweepDeps();

    const outcome = await handleSweepDeletedAccounts(deps);
    assert.deepEqual(purged, []);
    assert.equal(outcome.removed, 1);
    assert.equal((await db().doc(`${DELETED_ACCOUNTS_COLLECTION}/${uid(1)}`).get()).exists, false);
    assert.equal((await db().doc(`${DELETED_ACCOUNTS_COLLECTION}/${uid(2)}`).get()).exists, true);
  });
});

describe("accountDeletedCleanup", () => {
  beforeEach(clearFirestore);

  const tombstoneOf = async (uid) => (await db().doc(`${DELETED_ACCOUNTS_COLLECTION}/${uid}`).get()).data();
  const deps = (purge) => ({ purge: purgeDeps(fakeStorage([])), ...(purge ? { purgeAccount: purge } : {}) });

  test("a guest is closed in the same run when its purge is ok", async () => {
    await db().doc(`users/${A}`).set({ owner: A });
    await handleAccountDeleted({ uid: A, providerData: [] }, deps());
    const tombstone = await tombstoneOf(A);
    assert.equal(tombstone.state, "deleted");
    assert.equal(tombstone.lastRunOk, true);
    assert.ok(tombstone.closedAt instanceof Timestamp);
    assert.equal((await db().doc(`users/${A}`).get()).exists, false);
  });

  test("a guest whose purge failed a step stays open", async () => {
    const failing = async (uid, purgeDependencies, options) => {
      const result = await purgeAccount(uid, purgeDependencies, options);
      return { ...result, ok: false, failedSteps: ["storage"] };
    };
    await handleAccountDeleted({ uid: A, providerData: [] }, deps(failing));
    const tombstone = await tombstoneOf(A);
    assert.equal(tombstone.state, "deleted");
    assert.equal(tombstone.closedAt, undefined);
  });

  test("an account with an email or a provider is left open for the weekly cleanup", async () => {
    await handleAccountDeleted({ uid: A, email: EMAIL_A, providerData: [{ providerId: "password" }] }, deps());
    await handleAccountDeleted({ uid: B, providerData: [{ providerId: "phone" }] }, deps());
    for (const uid of [A, B]) {
      const tombstone = await tombstoneOf(uid);
      assert.equal(tombstone.lastRunOk, true);
      assert.equal(tombstone.closedAt, undefined, uid);
    }
  });
});

describe("store notifications for a deleted owner", () => {
  beforeEach(clearFirestore);

  const eventDoc = async (platform, environment, key) =>
    (await db().doc(`subscription_store_events/${storeEventDocumentId(platform, environment, key)}`).get()).data();

  test("Apple: the event is recorded unclaimed and the path returns as for an unowned purchase", async () => {
    const verified = () => ({
      subscription: {
        active: true,
        status: "active",
        platform: "apple",
        productId: "monthly_sub",
        expiresAt: new Date(Date.now() + 30 * DAY),
        autoRenewing: true,
        inGracePeriod: false,
        environment: "sandbox",
        originalTransactionId: "2000000000000777",
        lastStoreEventAt: new Date(),
        lastVerifiedAt: new Date(),
      },
      ownership: [{ platform: "apple", environment: "sandbox", originalTransactionId: "2000000000000777" }],
    });
    await persistVerifiedSubscription(A, verified());
    await db().doc(`${DELETED_ACCOUNTS_COLLECTION}/${A}`).set({ state: "pending", deletedAt: Timestamp.now(), runs: 1 });
    const masterBefore = (await db().doc(`subscription_master/${A}`).get()).data();
    const event = { key: "uuid-after-delete", platform: "apple", environment: "sandbox", eventType: "DID_RENEW", eventAt: new Date() };

    const outcome = await applyVerifiedAppleNotification({ decoded: {}, verified: verified(), event }, "op-a", "test_event");
    assert.deepEqual(outcome, { claimed: false, duplicate: false, stateApplied: false });
    assert.equal((await eventDoc("apple", "sandbox", event.key)).claimed, false);
    assert.deepEqual((await db().doc(`subscription_master/${A}`).get()).data(), masterBefore);

    const again = await applyVerifiedAppleNotification({ decoded: {}, verified: verified(), event }, "op-b", "test_event");
    assert.deepEqual(again, { claimed: false, duplicate: true, stateApplied: false });
  });

  test("Google: the event is recorded unclaimed with its acknowledgement waiting for an owner", async () => {
    const token = "token-of-deleted-owner";
    const fake = installFakePlay({ subscriptions: { [token]: playSubscription({ expiryTime: new Date(Date.now() + 30 * DAY) }) } });
    try {
      await persistVerifiedSubscription(A, await verifyGoogleSubscription(token));
      await db().doc(`${DELETED_ACCOUNTS_COLLECTION}/${A}`).set({ state: "deleted", deletedAt: Timestamp.now(), runs: 1 });

      const outcome = await applyGoogleStoreEvent({
        purchaseToken: token,
        eventType: "SUBSCRIPTION_RENEWED",
        eventKey: "msg-after-delete",
        eventAt: new Date(),
        operationId: "op-g",
        logEvent: "test_event",
      });
      assert.deepEqual(outcome, { claimed: false, duplicate: false, stateApplied: false });
      assert.equal((await eventDoc("google", "test", "msg-after-delete")).claimed, false);
      assert.equal(fake.calls.acknowledge.length, 0);
    } finally {
      uninstallFakePlay();
    }
  });

  test("the verifySubscription path still gets the refusal", async () => {
    await db().doc(`${DELETED_ACCOUNTS_COLLECTION}/${A}`).set({ state: "deleted", deletedAt: Timestamp.now(), runs: 1 });
    const token = "token-for-callable";
    installFakePlay({ subscriptions: { [token]: playSubscription({ expiryTime: new Date(Date.now() + 30 * DAY) }) } });
    try {
      const error = await persistVerifiedSubscription(A, await verifyGoogleSubscription(token)).catch((e) => e);
      assert.equal(asCallableError(error).code, "permission-denied");
      assert.deepEqual(asCallableError(error).details, { code: "account-deleted" });
    } finally {
      uninstallFakePlay();
    }
  });
});
