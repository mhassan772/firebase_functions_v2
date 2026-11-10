// The listen-time trigger, the public stats jobs and the backfill script against the Firestore
// emulator. Run with `npm run test:integration`, which starts the emulators under a demo
// project, so nothing here can reach real data.
const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { mkdtempSync, readdirSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const { beforeEach, test } = require("node:test");

assert.ok(process.env.FIRESTORE_EMULATOR_HOST, "FIRESTORE_EMULATOR_HOST must point at the emulator");

const { admin } = require("../../lib/config/admin");
const { handleBookListenTimeChange } = require("../../lib/handlers/bookListenTriggerHandlers");
const { handleCheckPublicListeners, handleRefreshPublicStats } = require("../../lib/handlers/publicStatsHandlers");

const run = promisify(execFile);
const db = () => admin.firestore();
const SCRIPT = path.join(__dirname, "../../scripts/backfill/listen-stats.mjs");

async function clearFirestore() {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  const response = await fetch(`http://${host}/emulator/v1/projects/demo-mantooq/databases/(default)/documents`, {
    method: "DELETE",
  });
  assert.ok(response.ok, `clearing Firestore failed: ${response.status}`);
}

beforeEach(async () => {
  await clearFirestore();
});

const entry = (contentId, listenTimeSeconds, lastListenAt = "2026-11-09T10:00:00.000") => ({
  contentId,
  source: "normal",
  sourceId: null,
  listenTimeSeconds,
  firstListenAt: "2026-11-01T10:00:00.000",
  lastListenAt,
});
const session = (...entries) => ({ deviceSessions: [{ deviceId: "device-0", listenTimeEntries: entries }] });
const legacySession = (listenTimes) => ({ listenTimes: [{ deviceId: "device-0", listenTimes }] });
const change = (before, after) => ({ before: { data: () => before }, after: { data: () => after } });
const sync = (uid, before, after, collection = "device_sessions_v2") =>
  handleBookListenTimeChange(change(before, after), uid, collection);

const data = async (docPath) => (await db().doc(docPath).get()).data();
const listeners = async () => (await data("public_stats/site"))?.listeners ?? 0;

test("a first sync writes book and podcast lines, the user's totals, and counts the listener once", async () => {
  const after = session(entry("book-a", 200), entry("p-1", 150));
  await sync("user-1", undefined, after);

  assert.equal((await data("book_listeners/user-1_book-a")).seconds, 200);
  const podcast = await data("podcast_listeners/user-1_p-1");
  assert.equal(podcast.seconds, 150);
  assert.equal(podcast.podcast_id, "p-1");
  assert.equal(podcast.user_guid, "user-1");
  const totals = await data("listener_totals/user-1");
  assert.equal(totals.bookSeconds, 200);
  assert.equal(totals.podcastSeconds, 150);
  assert.equal(totals.totalSeconds, 350);
  assert.equal(totals.isListener, true);
  assert.equal(await listeners(), 1);

  // The same event delivered again changes nothing.
  await sync("user-1", undefined, after);
  assert.equal((await data("listener_totals/user-1")).totalSeconds, 350);
  assert.equal(await listeners(), 1);
});

test("later syncs add only what grew, and a listener is never counted twice", async () => {
  const first = session(entry("book-a", 200), entry("p-1", 150));
  await sync("user-1", undefined, first);
  const second = session(entry("book-a", 260), entry("p-1", 150), entry("podcast-p-2", 30));
  await sync("user-1", first, second);

  assert.equal((await data("book_listeners/user-1_book-a")).seconds, 260);
  assert.equal((await data("podcast_listeners/user-1_p-1")).seconds, 150);
  assert.equal((await data("podcast_listeners/user-1_p-2")).seconds, 30);
  const totals = await data("listener_totals/user-1");
  assert.equal(totals.bookSeconds, 260);
  assert.equal(totals.podcastSeconds, 180);
  assert.equal(totals.totalSeconds, 440);
  assert.equal(await listeners(), 1);
});

test("a user is counted when their total reaches the minimum, not before", async () => {
  const first = session(entry("p-1", 100));
  await sync("user-2", undefined, first);
  assert.equal((await data("listener_totals/user-2")).isListener, false);
  assert.equal(await listeners(), 0);

  const second = session(entry("p-1", 100), entry("book-a", 250));
  await sync("user-2", first, second);
  assert.equal((await data("listener_totals/user-2")).isListener, true);
  assert.equal(await listeners(), 1);

  await sync("user-3", undefined, session(entry("book-b", 900)));
  assert.equal(await listeners(), 2);
});

test("a user with book lines from before totals existed is seeded with their whole history", async () => {
  await db().doc("book_listeners/user-4_book-a").set({ book_guid: "book-a", user_guid: "user-4", seconds: 5000, qualifies: true });
  await sync("user-4", session(entry("book-a", 5000)), session(entry("book-a", 5060)));

  assert.equal((await data("book_listeners/user-4_book-a")).seconds, 5060);
  assert.equal((await data("listener_totals/user-4")).bookSeconds, 5060);
  assert.equal(await listeners(), 1);
});

test("the older collection never adds time the newer one already holds", async () => {
  await sync("user-5", undefined, session(entry("book-a", 500), entry("p-1", 400)));
  await sync("user-5", undefined, legacySession({ "book-a": 300, "p-1": 450 }), "device_sessions");

  assert.equal((await data("book_listeners/user-5_book-a")).seconds, 500);
  assert.equal((await data("podcast_listeners/user-5_p-1")).seconds, 450);
  const totals = await data("listener_totals/user-5");
  assert.equal(totals.bookSeconds, 500);
  assert.equal(totals.podcastSeconds, 450);
  assert.equal(await listeners(), 1);
});

test("a write that grew nothing touches nothing", async () => {
  const same = session(entry("book-a", 200));
  await sync("user-6", same, same);
  assert.equal(await data("listener_totals/user-6"), undefined);
  assert.equal(await data("public_stats/site"), undefined);
});

test("the daily job sets hours, audiobooks and donors and leaves listeners alone", async () => {
  await db().doc("public_stats/site").set({ listeners: 42 });
  await db().doc("listener_totals/user-1").set({ bookSeconds: 7200, podcastSeconds: 3600, isListener: true });
  await db().doc("listener_totals/user-2").set({ bookSeconds: 3600, podcastSeconds: 1800, isListener: true });
  await db().doc("books/book-a").set({ name: "A", is_book_hidden: false });
  await db().doc("books/book-b").set({ name: "B" });
  await db().doc("books/book-c").set({ name: "C", is_book_hidden: true });
  await db().doc("DONATE_donations/one").set({ email: "a@example.com", amount: 5 });
  await db().doc("DONATE_donations/two").set({ email: " A@Example.com ", amount: 10 });
  await db().doc("DONATE_donations/three").set({ email: "b@example.com", amount: 5 });
  await db().doc("DONATE_donations/four").set({ amount: 5 });

  await handleRefreshPublicStats();

  const stats = await data("public_stats/site");
  assert.equal(stats.bookHoursListened, 3);
  assert.equal(stats.podcastHoursListened, 1);
  assert.equal(stats.hoursListened, 4);
  assert.equal(stats.audiobooks, 2);
  assert.equal(stats.donors, 2);
  assert.equal(stats.listeners, 42);
});

test("the monthly check corrects a drifted listeners count", async () => {
  await db().doc("public_stats/site").set({ listeners: 7, hoursListened: 9 });
  await db().doc("listener_totals/user-1").set({ totalSeconds: 900, isListener: true });
  await db().doc("listener_totals/user-2").set({ totalSeconds: 900, isListener: true });
  await db().doc("listener_totals/user-3").set({ totalSeconds: 10, isListener: false });

  await handleCheckPublicListeners();

  const stats = await data("public_stats/site");
  assert.equal(stats.listeners, 2);
  assert.equal(stats.hoursListened, 9);
  assert.ok(stats.listenersCheckedAt);
});

test("the backfill writes from the dry run's file, merges what triggers wrote, and sets the public numbers", async () => {
  await db().doc("device_sessions_v2/user-1").set(session(entry("book-a", 7200), entry("p-1", 3600)));
  await db().doc("device_sessions/user-1").set(legacySession({ "book-a": 100, "book-c": 3600, "podcast-p-1": 5400 }));
  await db().doc("device_sessions/user-2").set(legacySession({ "p-2": 60 }));
  await db().doc("device_sessions_v2/user-3").set({ deviceSessions: [] });

  const cwd = mkdtempSync(path.join(tmpdir(), "listen-stats-"));
  const env = { ...process.env, TZ: "UTC" };
  const dry = await run(process.execPath, [SCRIPT, "--project", "demo-mantooq"], { cwd, env });
  assert.match(dry.stdout, /Nothing was written to Firestore/);
  assert.equal(await data("listener_totals/user-1"), undefined);
  const file = readdirSync(cwd).find((name) => name.endsWith(".ndjson"));
  assert.ok(file, "the dry run saves the documents to a file");

  // Listening synced after the dry run: the trigger writes first, the commit must keep the larger values.
  await sync("user-2", legacySession({ "p-2": 60 }), legacySession({ "p-2": 400 }), "device_sessions");
  // The session documents are not read again, so removing them must not matter.
  await db().doc("device_sessions_v2/user-1").delete();
  await db().doc("device_sessions/user-1").delete();

  const commit = await run(process.execPath, [SCRIPT, "--commit", "--from", file, "--project", "demo-mantooq"], { cwd, env });
  assert.match(commit.stdout, /failed 0/);

  const user1 = await data("listener_totals/user-1");
  assert.equal(user1.bookSeconds, 7200 + 3600);
  assert.equal(user1.podcastSeconds, 5400);
  assert.equal(user1.isListener, true);
  assert.equal((await data("podcast_listeners/user-1_p-1")).seconds, 5400);
  assert.equal((await data("podcast_listeners/user-2_p-2")).seconds, 400);
  assert.equal((await data("listener_totals/user-2")).podcastSeconds, 400);
  assert.equal(await data("listener_totals/user-3"), undefined);

  const stats = await data("public_stats/site");
  assert.equal(stats.listeners, 2);
  assert.equal(stats.bookHoursListened, 3);
  assert.equal(stats.podcastHoursListened, 1);
  assert.equal(stats.hoursListened, 4);

  // Publishing on its own recounts from what is stored.
  await db().doc("public_stats/site").set({ listeners: 99, hoursListened: 0 });
  await run(process.execPath, [SCRIPT, "--publish", "--project", "demo-mantooq"], { cwd, env });
  assert.equal((await data("public_stats/site")).listeners, 2);
  assert.equal((await data("public_stats/site")).hoursListened, 4);

  // Running the commit again adds nothing.
  await run(process.execPath, [SCRIPT, "--commit", "--from", file, "--project", "demo-mantooq"], { cwd, env });
  assert.equal((await data("listener_totals/user-1")).bookSeconds, 7200 + 3600);
  assert.equal((await data("public_stats/site")).listeners, 2);
});
