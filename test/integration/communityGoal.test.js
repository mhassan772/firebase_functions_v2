// The community goal triggers and hourly job against the Firestore emulator. Run with
// `npm run test:integration`, which starts the emulators under a demo project, so nothing here
// can reach real data.
const assert = require("node:assert/strict");
const { beforeEach, test } = require("node:test");
const { Timestamp } = require("firebase-admin/firestore");

assert.ok(process.env.FIRESTORE_EMULATOR_HOST, "FIRESTORE_EMULATOR_HOST must point at the emulator");

const { admin } = require("../../lib/config/admin");
const { goalKey, hijriMonthBounds } = require("../../lib/handlers/communityGoalHandlers");
const { clearCommunityGoalCache, handleListeningDaysChange } = require("../../lib/handlers/communityGoalTriggerHandlers");
const {
  handleCommunityGoalRecountChange,
  handleRefreshCommunityGoals,
  refreshGoalTotals,
} = require("../../lib/handlers/communityGoalJobHandlers");
const { handleBookListenTimeChange } = require("../../lib/handlers/bookListenTriggerHandlers");

const DAY = 86_400_000;
const db = () => admin.firestore();
const data = async (docPath) => (await db().doc(docPath).get()).data();
const today = Math.floor(Date.now() / DAY);
const yearOf = (day) => new Date(day * DAY).getUTCFullYear();
const KEY = "h140001";
const LATER = () => Date.now() + 120_000;

async function clearFirestore() {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  const response = await fetch(`http://${host}/emulator/v1/projects/demo-mantooq/databases/(default)/documents`, {
    method: "DELETE",
  });
  assert.ok(response.ok, `clearing Firestore failed: ${response.status}`);
}

beforeEach(async () => {
  await clearFirestore();
  clearCommunityGoalCache();
});

const goal = (overrides = {}) => ({
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
  ...overrides,
});
const row = (d, day, cs) => ({ d, day, m: 1, cs, ss: 0, sl: 0, g: 0, u: 0 });
const chunk = (...rows) => ({ days: rows });
const change = (before, after) => ({ before: { data: () => before }, after: { data: () => after } });

/** Stores the chunk as the app would, then delivers the event for it. */
async function upload(uid, year, before, after, { store = true } = {}) {
  if (store) {
    await db().doc(`listening_history/${uid}/chunks/${year}`).set(after);
  }
  await handleListeningDaysChange(change(before, after), uid, String(year));
}
const month = async (uid, key = KEY) => (await data(`listener_totals/${uid}`))?.months?.[key];
const setGoal = (key, fields) => db().doc(`community_goals/${key}`).set(fields);

test("redelivered and out-of-order events leave the value the stored rows give", async () => {
  await setGoal(KEY, goal());
  const year = yearOf(today - 1);
  const first = chunk(row("phone", today - 1, 100));
  const second = chunk(row("phone", today - 1, 100), row("tablet", today - 1, 200), row("phone", today, 50));
  await db().doc(`listening_history/user-1/chunks/${year}`).set(second);

  // The later event first, then the earlier one, then the later one again.
  await upload("user-1", year, first, second, { store: false });
  await upload("user-1", year, undefined, first, { store: false });
  await upload("user-1", year, first, second, { store: false });
  assert.deepEqual(await month("user-1"), { c: 350, a: 350 });
});

test("a value goes down when rows shrink, and a write that changes no day reads nothing", async () => {
  await setGoal(KEY, goal());
  const year = yearOf(today);
  const big = chunk(row("phone", today, 900));
  await upload("user-1", year, undefined, big);
  assert.deepEqual(await month("user-1"), { c: 900, a: 900 });
  await upload("user-1", year, big, chunk(row("phone", today, 300)));
  assert.deepEqual(await month("user-1"), { c: 300, a: 300 });

  // Same seconds, other fields changed: the stored entry is not touched even when it is wrong.
  await db().doc("listener_totals/user-1").set({ months: { [KEY]: { c: 1, a: 1 } } });
  const same = chunk({ ...row("phone", today, 300), m: 9 });
  await upload("user-1", year, chunk(row("phone", today, 300)), same);
  assert.deepEqual(await month("user-1"), { c: 1, a: 1 });
});

test("the daily cap applies per day across devices, and days after tomorrow are left out", async () => {
  await setGoal(KEY, goal({ dailyCapSeconds: 1000 }));
  const rows = [row("phone", today - 2, 800), row("tablet", today - 2, 800), row("phone", today + 1, 10), row("phone", today + 2, 500)];
  // today + 2 may fall in the next year's chunk; only rows of this year's chunk are read for it.
  const year = yearOf(today - 2);
  await upload("user-1", year, undefined, chunk(...rows.filter((r) => yearOf(r.day) === year)));
  const expected = 1000 + (yearOf(today + 1) === year ? 10 : 0);
  assert.deepEqual(await month("user-1"), { c: expected, a: expected });
});

test("after closing, c stays frozen and a still follows the rows", async () => {
  const lastDay = today - 10;
  await setGoal(KEY, goal({ firstDay: lastDay - 20, lastDay, status: "closed", closedAt: Timestamp.now() }));
  await db().doc("listener_totals/user-1").set({ months: { [KEY]: { c: 100, a: 100 } } });
  const year = yearOf(lastDay);
  await upload("user-1", year, chunk(row("phone", lastDay, 100)), chunk(row("phone", lastDay, 400)));
  assert.deepEqual(await month("user-1"), { c: 100, a: 400 });

  // A user with nothing stored gets only a.
  await upload("user-2", year, undefined, chunk(row("phone", lastDay, 70)));
  assert.deepEqual(await month("user-2"), { a: 70 });
});

test("a month crossing 1 January reads both years, whichever chunk the event came from", async () => {
  const firstDay = Date.UTC(2025, 11, 30) / DAY;
  await setGoal(KEY, goal({ firstDay, lastDay: firstDay + 5, closeAfterDays: 5000 }));
  await db().doc("listening_history/user-1/chunks/2025").set(chunk(row("phone", firstDay, 100), row("phone", firstDay - 1, 999)));
  await upload("user-1", 2026, undefined, chunk(row("phone", firstDay + 3, 200)));
  assert.deepEqual(await month("user-1"), { c: 300, a: 300 });
});

test("a 61st month removes the oldest from the user's map", async () => {
  await setGoal(KEY, goal());
  const months = {};
  for (let i = 0; i < 60; i++) {
    months[goalKey(1300 + Math.floor(i / 12), (i % 12) + 1)] = { c: 1, a: 1 };
  }
  await db().doc("listener_totals/user-1").set({ months });
  await upload("user-1", yearOf(today), undefined, chunk(row("phone", today, 60)));
  const stored = (await data("listener_totals/user-1")).months;
  assert.equal(Object.keys(stored).length, 60);
  assert.equal(stored.h130001, undefined);
  assert.deepEqual(stored[KEY], { c: 60, a: 60 });
});

test("the hourly job creates the current and next month, copying settings, and never overwrites one", async () => {
  const shaban = hijriMonthBounds(1448, 8);
  const ramadan = hijriMonthBounds(1448, 9);
  await setGoal("h144807", goal({ hijriYear: 1448, hijriMonth: 7, ...hijriMonthBounds(1448, 7), targetHours: 900, dailyCapSeconds: 7200, closeAfterDays: 2, show: { participants: true } }));

  // Eleven days before Ramadan: Sha'ban only.
  await handleRefreshCommunityGoals(new Date((ramadan.firstDay - 11) * DAY), LATER());
  const created = await data("community_goals/h144808");
  assert.equal(created.firstDay, shaban.firstDay);
  assert.equal(created.lastDay, shaban.lastDay);
  assert.equal(created.targetHours, 900);
  assert.equal(created.dailyCapSeconds, 7200);
  assert.equal(created.closeAfterDays, 2);
  assert.deepEqual(created.show, { participants: true, pace: false, target: false, history: false });
  assert.equal(created.auto, true);
  assert.equal(created.status, "open");
  assert.equal(await data("community_goals/h144809"), undefined);

  // The portal edits Sha'ban; the next runs leave it as edited, and Ramadan starts after its new end.
  await db().doc("community_goals/h144808").update({ lastDay: shaban.lastDay + 1, targetHours: 50, auto: false });
  await handleRefreshCommunityGoals(new Date((ramadan.firstDay - 10) * DAY), LATER());
  const edited = await data("community_goals/h144808");
  assert.equal(edited.lastDay, shaban.lastDay + 1);
  assert.equal(edited.targetHours, 50);
  assert.equal(edited.auto, false);
  const next = await data("community_goals/h144809");
  assert.equal(next.firstDay, shaban.lastDay + 2);
  assert.equal(next.lastDay, ramadan.lastDay);
  assert.equal(next.targetHours, 50);

  await db().doc("community_goals/h144809").update({ targetHours: 1 });
  await handleRefreshCommunityGoals(new Date((ramadan.firstDay - 5) * DAY), LATER());
  assert.equal((await data("community_goals/h144809")).targetHours, 1);
});

test("the hourly job sums totals and participants; the goal shows participants only when switched on", async () => {
  const now = new Date();
  await setGoal(KEY, goal());
  await db().doc("listener_totals/user-1").set({ totalSeconds: 5, months: { [KEY]: { c: 100, a: 150 } } });
  await db().doc("listener_totals/user-2").set({ months: { [KEY]: { c: 200, a: 200 }, h139912: { c: 999, a: 999 } } });
  await db().doc("listener_totals/user-3").set({ months: { [KEY]: { c: 0, a: 30 } } });
  await db().doc("listener_totals/user-4").set({ totalSeconds: 900 });

  await refreshGoalTotals(KEY, now);
  let stored = await data(`community_goals/${KEY}`);
  assert.equal(stored.totalSeconds, 300);
  assert.ok(stored.totalUpdatedAt);
  assert.equal("participants" in stored, false);
  assert.equal(stored.status, "open");
  const stats = await data(`community_goal_stats/${KEY}`);
  assert.equal(stats.totalSeconds, 300);
  assert.equal(stats.actualSeconds, 380);
  assert.equal(stats.participants, 2);

  await db().doc(`community_goals/${KEY}`).update({ "show.participants": true });
  await refreshGoalTotals(KEY, now);
  assert.equal((await data(`community_goals/${KEY}`)).participants, 2);

  await db().doc(`community_goals/${KEY}`).update({ "show.participants": false });
  await refreshGoalTotals(KEY, now);
  stored = await data(`community_goals/${KEY}`);
  assert.equal("participants" in stored, false);
  assert.equal((await data(`community_goal_stats/${KEY}`)).participants, 2);
});

test("a month closes once now reaches closesAt, with its final numbers", async () => {
  const lastDay = today - 3;
  await setGoal(KEY, goal({ firstDay: lastDay - 20, lastDay, closeAfterDays: 3 }));
  await db().doc("listener_totals/user-1").set({ months: { [KEY]: { c: 100, a: 100 } } });

  await handleRefreshCommunityGoals(new Date((lastDay + 4) * DAY - 1), LATER());
  assert.equal((await data(`community_goals/${KEY}`)).status, "open");

  await handleRefreshCommunityGoals(new Date((lastDay + 4) * DAY), LATER());
  const closed = await data(`community_goals/${KEY}`);
  assert.equal(closed.status, "closed");
  assert.ok(closed.closedAt);
  assert.equal(closed.totalSeconds, 100);
});

test("late time is refreshed once a day after closing while the goal's total stays", async () => {
  const lastDay = today - 10;
  const now = new Date();
  await setGoal(KEY, goal({ firstDay: lastDay - 20, lastDay, status: "closed", closedAt: Timestamp.fromMillis(now.getTime() - 5 * DAY), totalSeconds: 100 }));
  await db().doc(`community_goal_stats/${KEY}`).set({
    totalSeconds: 100,
    actualSeconds: 100,
    actualUpdatedAt: Timestamp.fromMillis(now.getTime() - 2 * 3600_000),
  });
  await db().doc("listener_totals/user-1").set({ months: { [KEY]: { c: 100, a: 160 } } });

  await handleRefreshCommunityGoals(now, LATER());
  assert.equal((await data(`community_goal_stats/${KEY}`)).actualSeconds, 100, "refreshed at most once a day");

  await db().doc(`community_goal_stats/${KEY}`).update({ actualUpdatedAt: Timestamp.fromMillis(now.getTime() - 25 * 3600_000) });
  await handleRefreshCommunityGoals(now, LATER());
  const stats = await data(`community_goal_stats/${KEY}`);
  assert.equal(stats.actualSeconds, 160);
  assert.equal(stats.totalSeconds, 100);
  const stored = await data(`community_goals/${KEY}`);
  assert.equal(stored.totalSeconds, 100);
  assert.equal(stored.status, "closed");

  // Closed more than 60 days ago: left alone.
  await db().doc(`community_goals/${KEY}`).update({ closedAt: Timestamp.fromMillis(now.getTime() - 61 * DAY) });
  await db().doc("listener_totals/user-1").set({ months: { [KEY]: { c: 100, a: 999 } } });
  await db().doc(`community_goal_stats/${KEY}`).update({ actualUpdatedAt: Timestamp.fromMillis(now.getTime() - 25 * 3600_000) });
  await handleRefreshCommunityGoals(now, LATER());
  assert.equal((await data(`community_goal_stats/${KEY}`)).actualSeconds, 160);
});

/** Users with rows and an index stamped `updatedAt`, as the app writes them. */
async function seedUser(uid, rows, updatedAtMs = Date.now()) {
  const byYear = new Map();
  for (const r of rows) {
    byYear.set(yearOf(r.day), [...(byYear.get(yearOf(r.day)) ?? []), r]);
  }
  for (const [year, yearRows] of byYear) {
    await db().doc(`listening_history/${uid}/chunks/${year}`).set(chunk(...yearRows));
  }
  await db().doc(`listening_history/${uid}`).set({ years: [...byYear.keys()], updatedAt: Timestamp.fromMillis(updatedAtMs) });
}

/** Saves the portal's edit with a recount request, then delivers its event. */
async function requestRecount(key, before, edit) {
  const requestedAt = Timestamp.now();
  const after = { ...before, ...edit, recount: { requestedAt, requestedBy: "admin-1" } };
  await setGoal(key, after);
  await handleCommunityGoalRecountChange(change(before, after), key, LATER());
  return requestedAt;
}

test("a recount after the start moves earlier counts the new days", async () => {
  const before = goal({ firstDay: today - 5 });
  await setGoal(KEY, before);
  await seedUser("user-1", [row("p", today - 8, 100), row("p", today - 2, 50)]);
  await db().doc("listener_totals/user-1").set({ months: { [KEY]: { c: 50, a: 50 } } });
  // Uploaded only before the old start: still found, because the search starts from the new start.
  await seedUser("user-2", [row("p", today - 9, 70)], (today - 8) * DAY);
  // Uploaded long before either start: not found, and has nothing in the window.
  await seedUser("user-3", [row("p", today - 40, 70)], (today - 40) * DAY);

  await requestRecount(KEY, before, { firstDay: today - 10 });
  assert.deepEqual(await month("user-1"), { c: 150, a: 150 });
  assert.deepEqual(await month("user-2"), { c: 70, a: 70 });
  assert.equal(await month("user-3"), undefined);
  const stats = await data(`community_goal_stats/${KEY}`);
  assert.equal(stats.recount.state, "done");
  assert.equal(stats.recount.processed, 2);
  assert.equal(stats.recount.fromDay, today - 11);
  assert.equal(stats.totalSeconds, 220);
  assert.equal((await data(`community_goals/${KEY}`)).totalSeconds, 220);
});

test("a recount after the start moves later writes 0 for a user left with nothing", async () => {
  const before = goal({ firstDay: today - 10 });
  await setGoal(KEY, before);
  await seedUser("user-1", [row("p", today - 8, 100)], (today - 7) * DAY);
  await db().doc("listener_totals/user-1").set({ months: { [KEY]: { c: 100, a: 100 } } });
  await seedUser("user-2", [row("p", today - 8, 100), row("p", today - 1, 40)]);
  await db().doc("listener_totals/user-2").set({ months: { [KEY]: { c: 140, a: 140 } } });

  await requestRecount(KEY, before, { firstDay: today - 5 });
  assert.deepEqual(await month("user-1"), { c: 0, a: 0 });
  assert.deepEqual(await month("user-2"), { c: 40, a: 40 });
  const stats = await data(`community_goal_stats/${KEY}`);
  assert.equal(stats.participants, 1);
  assert.equal(stats.totalSeconds, 40);
});

test("a recount after the cap drops lowers every value, and a repeated event does not run it again", async () => {
  const before = goal({ dailyCapSeconds: 43_200 });
  await setGoal(KEY, before);
  await seedUser("user-1", [row("p", today - 2, 5000), row("q", today - 2, 5000), row("p", today - 1, 100)]);
  await db().doc("listener_totals/user-1").set({ months: { [KEY]: { c: 10_100, a: 10_100 } } });

  const requestedAt = await requestRecount(KEY, before, { dailyCapSeconds: 3600 });
  assert.deepEqual(await month("user-1"), { c: 3700, a: 3700 });
  const done = (await data(`community_goal_stats/${KEY}`)).recount;
  assert.equal(done.state, "done");

  const after = await data(`community_goals/${KEY}`);
  await handleCommunityGoalRecountChange(change(before, after), KEY, LATER());
  assert.ok((await data(`community_goal_stats/${KEY}`)).recount.finishedAt.isEqual(done.finishedAt));
  // The hourly totals written to the goal are not a request.
  await handleCommunityGoalRecountChange(change(after, { ...after, totalSeconds: 1 }), KEY, LATER());
  assert.ok((await data(`community_goal_stats/${KEY}`)).recount.requestedAt.isEqual(requestedAt));
});

test("a stopped recount is resumed from its cursor by the hourly job", async () => {
  const stored = goal({ dailyCapSeconds: 3600, recount: { requestedAt: Timestamp.fromMillis(Date.now() - 3600_000), requestedBy: "admin-1" } });
  await setGoal(KEY, stored);
  const base = (today - 1) * DAY;
  for (const [i, uid] of ["user-a", "user-b", "user-c", "user-d"].entries()) {
    await seedUser(uid, [row("p", today - 1, 9000)], base + i * 1000);
    await db().doc(`listener_totals/${uid}`).set({ months: { [KEY]: { c: 9000, a: 9000 } } });
  }
  // The first run did user-a and user-b, then stopped twenty minutes ago.
  const old = Timestamp.fromMillis(Date.now() - 20 * 60_000);
  await db().doc(`community_goal_stats/${KEY}`).set({
    recount: {
      state: "running",
      requestedAt: stored.recount.requestedAt,
      startedAt: old,
      progressAt: old,
      finishedAt: null,
      processed: 2,
      fromDay: today - 6,
      cursor: { updatedAtMs: base + 1000, uid: "user-b" },
    },
  });

  await handleRefreshCommunityGoals(new Date(), LATER());
  // Before the cursor: not recomputed. After it: recomputed.
  assert.deepEqual(await month("user-a"), { c: 9000, a: 9000 });
  assert.deepEqual(await month("user-b"), { c: 9000, a: 9000 });
  assert.deepEqual(await month("user-c"), { c: 3600, a: 3600 });
  assert.deepEqual(await month("user-d"), { c: 3600, a: 3600 });
  const recount = (await data(`community_goal_stats/${KEY}`)).recount;
  assert.equal(recount.state, "done");
  assert.equal(recount.processed, 4);
  assert.deepEqual(recount.cursor, { updatedAtMs: base + 3000, uid: "user-d" });
});

test("a recount that moved recently is left to the run still going", async () => {
  await setGoal(KEY, goal({ recount: { requestedAt: Timestamp.now(), requestedBy: "admin-1" } }));
  const recent = Timestamp.fromMillis(Date.now() - 60_000);
  await db().doc(`community_goal_stats/${KEY}`).set({
    recount: { state: "running", requestedAt: (await data(`community_goals/${KEY}`)).recount.requestedAt, startedAt: recent, progressAt: recent, processed: 0, fromDay: today - 6, cursor: null },
  });
  await handleRefreshCommunityGoals(new Date(), LATER());
  assert.equal((await data(`community_goal_stats/${KEY}`)).recount.state, "running");
});

test("a recount is refused on a closed month", async () => {
  const before = goal({ firstDay: today - 30, lastDay: today - 10, status: "closed", closedAt: Timestamp.now() });
  await setGoal(KEY, before);
  await seedUser("user-1", [row("p", today - 20, 100)]);
  await db().doc("listener_totals/user-1").set({ months: { [KEY]: { c: 100, a: 100 } } });

  await requestRecount(KEY, before, { dailyCapSeconds: 10 });
  const recount = (await data(`community_goal_stats/${KEY}`)).recount;
  assert.equal(recount.state, "failed");
  assert.match(recount.error, /closed/);
  assert.deepEqual(await month("user-1"), { c: 100, a: 100 });
});

test("a totals document holding only months still gets lifetime totals from the first session event", async () => {
  await db().doc("listener_totals/user-1").set({ months: { [KEY]: { c: 60, a: 60 } } });
  const entry = (contentId, listenTimeSeconds) => ({
    contentId,
    source: "normal",
    sourceId: null,
    listenTimeSeconds,
    firstListenAt: "2026-11-01T10:00:00.000",
    lastListenAt: "2026-11-09T10:00:00.000",
  });
  const session = { deviceSessions: [{ deviceId: "device-0", listenTimeEntries: [entry("book-a", 200), entry("p-1", 150)] }] };
  await handleBookListenTimeChange(change(undefined, session), "user-1", "device_sessions_v2");
  await handleBookListenTimeChange(change(undefined, session), "user-1", "device_sessions_v2");

  const totals = await data("listener_totals/user-1");
  assert.equal(totals.bookSeconds, 200);
  assert.equal(totals.podcastSeconds, 150);
  assert.equal(totals.totalSeconds, 350);
  assert.equal(totals.isListener, true);
  assert.deepEqual(totals.months, { [KEY]: { c: 60, a: 60 } });
  assert.equal((await data("public_stats/site")).listeners, 1);
});
