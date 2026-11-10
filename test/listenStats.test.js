const assert = require("node:assert/strict");
const test = require("node:test");
const { secondsByBook } = require("../lib/handlers/bookListenHandlers");
const {
  backfillUser,
  grownTotals,
  largerPerContent,
  mergedTotals,
  nextPodcastLine,
  podcastIdOf,
  podcastListenerDocId,
  secondsByPodcast,
  totalsFromSession,
  wholeHours,
} = require("../lib/handlers/listenStatsHandlers");

const NOW = new Date("2026-11-10T12:00:00.000Z");
const MIN = 300;

const entry = (contentId, listenTimeSeconds, lastListenAt = "2026-11-09T10:00:00.000", source = "normal") => ({
  contentId,
  source,
  sourceId: null,
  listenTimeSeconds,
  firstListenAt: "2026-11-01T10:00:00.000",
  lastListenAt,
});
const v2Doc = (...devices) => ({
  deviceSessions: devices.map((entries, i) => ({ deviceId: `device-${i}`, listenTimeEntries: entries })),
});
const legacyDoc = (...maps) => ({ listenTimes: maps.map((listenTimes, i) => ({ deviceId: `device-${i}`, listenTimes })) });

test("podcastIdOf keeps p- ids, joins the old podcast-p- form to them, and rejects books", () => {
  assert.equal(podcastIdOf("p-534524"), "p-534524");
  assert.equal(podcastIdOf("podcast-p-534524"), "p-534524");
  assert.equal(podcastIdOf("podcast-534524"), "podcast-534524");
  assert.equal(podcastIdOf("book-a"), null);
  assert.equal(podcastIdOf("backfill"), null);
  assert.equal(podcastIdOf(""), null);
  assert.equal(podcastIdOf(42), null);
});

test("secondsByPodcast sums a podcast across devices, sources and both id forms, and skips books", () => {
  const totals = secondsByPodcast(
    v2Doc(
      [entry("p-1", 200), entry("p-1", 40, "2026-11-09T11:00:00.000", "playlist"), entry("book-a", 999)],
      [entry("podcast-p-1", 100), entry("p-2", 20), entry("backfill", 5000)],
    ),
  );
  assert.deepEqual([...totals.keys()].sort(), ["p-1", "p-2"]);
  assert.deepEqual(totals.get("p-1"), { seconds: 340, lastListenAt: new Date("2026-11-09T11:00:00.000") });
  assert.equal(totals.get("p-2").seconds, 20);
});

test("secondsByPodcast reads the older map format, and secondsByBook still leaves podcasts out", () => {
  const doc = legacyDoc({ "p-1": 60, "book-a": 120 }, { "p-1": 30 });
  assert.equal(secondsByPodcast(doc).get("p-1").seconds, 90);
  assert.deepEqual([...secondsByBook(doc).keys()], ["book-a"]);
});

test("podcastListenerDocId is the user and podcast, with no slash", () => {
  assert.equal(podcastListenerDocId("user-1", "p-1"), "user-1_p-1");
  assert.equal(podcastListenerDocId("user-1", "p/1"), "user-1_p_1");
});

test("nextPodcastLine raises a line only when listening grew, and never dates it in the future", () => {
  const grown = { podcastId: "p-1", seconds: 500, lastListenAt: new Date("2026-11-10T15:00:00.000Z") };
  assert.deepEqual(nextPodcastLine(undefined, "user-1", grown, NOW), {
    podcast_id: "p-1",
    user_guid: "user-1",
    seconds: 500,
    updatedAt: NOW,
  });
  assert.equal(nextPodcastLine({ seconds: 500 }, "user-1", grown, NOW), null);
  assert.equal(nextPodcastLine({ seconds: 900 }, "user-1", grown, NOW), null);
  const earlier = { ...grown, lastListenAt: new Date("2026-11-08T09:00:00.000Z") };
  const stored = { seconds: 100, updatedAt: new Date("2026-11-09T09:00:00.000Z") };
  assert.deepEqual(nextPodcastLine(stored, "user-1", earlier, NOW).updatedAt, stored.updatedAt);
});

test("totalsFromSession adds books and podcasts and leaves out made-up backfill entries", () => {
  const totals = totalsFromSession("user-1", v2Doc([entry("book-a", 200), entry("p-1", 150), entry("backfill", 9000)]), MIN);
  assert.equal(totals.bookSeconds, 200);
  assert.equal(totals.podcastSeconds, 150);
  assert.equal(totals.totalSeconds, 350);
  assert.equal(totals.isListener, true);
  assert.deepEqual(totals.lastListenAt, new Date("2026-11-09T10:00:00.000"));
});

test("grownTotals adds growth and reports becoming a listener exactly once", () => {
  const first = grownTotals({}, "user-1", { bookSeconds: 100, podcastSeconds: 100, lastListenAt: NOW }, MIN);
  assert.equal(first.totalSeconds, 200);
  assert.equal(first.isListener, false);
  assert.equal(first.becameListener, false);

  const second = grownTotals(first, "user-1", { bookSeconds: 0, podcastSeconds: 100, lastListenAt: NOW }, MIN);
  assert.equal(second.totalSeconds, 300);
  assert.equal(second.isListener, true);
  assert.equal(second.becameListener, true);

  const third = grownTotals(second, "user-1", { bookSeconds: 40, podcastSeconds: 0, lastListenAt: null }, MIN);
  assert.equal(third.bookSeconds, 140);
  assert.equal(third.isListener, true);
  assert.equal(third.becameListener, false);
  assert.deepEqual(third.lastListenAt, NOW);
});

test("grownTotals ignores bad stored values and negative growth", () => {
  const totals = grownTotals({ bookSeconds: "x", podcastSeconds: -5 }, "user-1", { bookSeconds: -10, podcastSeconds: 20, lastListenAt: null }, MIN);
  assert.equal(totals.bookSeconds, 0);
  assert.equal(totals.podcastSeconds, 20);
});

test("largerPerContent takes the larger total per content and never adds the two collections", () => {
  const merged = largerPerContent(
    secondsByBook(v2Doc([entry("book-a", 500), entry("book-b", 10)])),
    secondsByBook(legacyDoc({ "book-a": 300, "book-c": 70 })),
  );
  assert.equal(merged.get("book-a").seconds, 500);
  assert.equal(merged.get("book-b").seconds, 10);
  assert.equal(merged.get("book-c").seconds, 70);
});

test("backfillUser builds a line per podcast and totals from both session documents", () => {
  const result = backfillUser(
    "user-1",
    v2Doc([entry("book-a", 500), entry("p-1", 100)]),
    legacyDoc({ "book-a": 300, "book-c": 70, "podcast-p-1": 250, "p-2": 40 }),
    MIN,
  );
  assert.deepEqual(
    result.podcasts.map((line) => [line.podcast_id, line.seconds]).sort(),
    [["p-1", 250], ["p-2", 40]],
  );
  assert.equal(result.totals.bookSeconds, 570);
  assert.equal(result.totals.podcastSeconds, 290);
  assert.equal(result.totals.totalSeconds, 860);
  assert.equal(result.totals.isListener, true);
});

test("backfillUser gives no totals to a user with no listening", () => {
  assert.deepEqual(backfillUser("user-1", { deviceSessions: [] }, undefined, MIN), { podcasts: [], totals: null });
  assert.equal(backfillUser("user-1", v2Doc([entry("backfill", 9000)]), undefined, MIN).totals, null);
});

test("mergedTotals keeps the larger of stored and file totals and never un-makes a listener", () => {
  const fromFile = { user_guid: "user-1", bookSeconds: 1000, podcastSeconds: 50, totalSeconds: 1050, lastListenAt: null, isListener: true };
  const merged = mergedTotals({ bookSeconds: 20, podcastSeconds: 400, isListener: false, lastListenAt: NOW }, fromFile, MIN);
  assert.equal(merged.bookSeconds, 1000);
  assert.equal(merged.podcastSeconds, 400);
  assert.equal(merged.totalSeconds, 1400);
  assert.equal(merged.isListener, true);
  assert.deepEqual(merged.lastListenAt, NOW);

  const small = { ...fromFile, bookSeconds: 10, podcastSeconds: 0, totalSeconds: 10, isListener: false };
  assert.equal(mergedTotals({ isListener: true }, small, MIN).isListener, true);
});

test("wholeHours rounds down and treats bad input as zero", () => {
  assert.equal(wholeHours(7199), 1);
  assert.equal(wholeHours(7200), 2);
  assert.equal(wholeHours(-5), 0);
  assert.equal(wholeHours(NaN), 0);
});
