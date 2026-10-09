const assert = require("node:assert/strict");
const test = require("node:test");
const {
  backfillLines,
  bookListenerDocId,
  completedBookGuids,
  grownBooks,
  isBookContentId,
  listenedByProgress,
  nextListenerLine,
  rankBooks,
  resolvePopularBooksSettings,
  secondsByBook,
} = require("../lib/handlers/bookListenHandlers");

const NOW = new Date("2026-10-09T12:00:00.000Z");
const MIN = 300;

const v2Entry = (contentId, listenTimeSeconds, lastListenAt = "2026-10-08T10:00:00.000", source = "normal") => ({
  contentId,
  source,
  sourceId: null,
  listenTimeSeconds,
  firstListenAt: "2026-10-01T10:00:00.000",
  lastListenAt,
});
const v2Doc = (...devices) => ({
  deviceSessions: devices.map((entries, i) => ({ deviceId: `device-${i}`, deviceName: "Phone", listenTimeEntries: entries })),
});

test("secondsByBook sums a book across devices and play sources in device_sessions_v2", () => {
  const totals = secondsByBook(
    v2Doc(
      [v2Entry("book-a", 200), v2Entry("book-a", 40, "2026-10-08T11:00:00.000", "playlist")],
      [v2Entry("book-a", 100, "2026-10-07T09:00:00.000"), v2Entry("book-b", 20)],
    ),
  );
  assert.deepEqual(totals.get("book-a"), { seconds: 340, lastListenAt: new Date("2026-10-08T11:00:00.000") });
  assert.equal(totals.get("book-b").seconds, 20);
});

test("secondsByBook reads both legacy device_sessions formats, undated", () => {
  const totals = secondsByBook({
    listenTimes: [
      { deviceId: "a", listenTimes: { "book-a": 3260 } },
      { deviceId: "b", listenTimeByBooks: { "book-a": 40, "book-b": 5905 } },
    ],
  });
  assert.deepEqual(totals.get("book-a"), { seconds: 3300, lastListenAt: null });
  assert.deepEqual(totals.get("book-b"), { seconds: 5905, lastListenAt: null });
});

test("secondsByBook skips podcasts, milestone credits and unusable values", () => {
  const totals = secondsByBook(
    v2Doc([
      v2Entry("p-522811", 3960),
      v2Entry("podcast-9", 100),
      v2Entry("backfill", 900),
      v2Entry("book-a", "not a number"),
      v2Entry("book-b", -20),
      v2Entry("", 60),
    ]),
  );
  assert.equal(totals.size, 0);
  assert.equal(isBookContentId("b905fa09-fb8b-4845-8ca6-2004e48395e1"), true);
  assert.equal(secondsByBook(undefined).size, 0);
  assert.equal(secondsByBook({ deviceSessions: "bad" }).size, 0);
});

test("grownBooks returns only books whose total went up", () => {
  const before = secondsByBook(v2Doc([v2Entry("book-a", 200), v2Entry("book-b", 300), v2Entry("book-c", 100)]));
  const after = secondsByBook(v2Doc([v2Entry("book-a", 220), v2Entry("book-b", 300), v2Entry("book-c", 80), v2Entry("book-d", 20)]));
  assert.deepEqual(
    grownBooks(before, after).map(({ bookGuid, seconds }) => [bookGuid, seconds]),
    [
      ["book-a", 220],
      ["book-d", 20],
    ],
  );
  assert.equal(grownBooks(after, after).length, 0);
});

test("a new line starts uncounted and qualifies at the minimum", () => {
  const grown = { bookGuid: "book-a", seconds: 300, lastListenAt: new Date("2026-10-08T10:00:00Z") };
  assert.deepEqual(nextListenerLine(undefined, "user-1", grown, NOW, MIN), {
    book_guid: "book-a",
    user_guid: "user-1",
    seconds: 300,
    updatedAt: new Date("2026-10-08T10:00:00Z"),
    listenedBeforeSessions: false,
    qualifies: true,
    addedToBook: false,
  });
  assert.equal(nextListenerLine(undefined, "user-1", { ...grown, seconds: 280 }, NOW, MIN).qualifies, false);
});

test("a line never goes down and is not rewritten when the stored total is as high", () => {
  const grown = { bookGuid: "book-a", seconds: 400, lastListenAt: null };
  assert.equal(nextListenerLine({ seconds: 400 }, "user-1", grown, NOW, MIN), null);
  assert.equal(nextListenerLine({ seconds: 900 }, "user-1", grown, NOW, MIN), null);
  const line = nextListenerLine({ seconds: 100, updatedAt: new Date("2026-09-01T00:00:00Z") }, "user-1", grown, NOW, MIN);
  assert.equal(line.seconds, 400);
  assert.equal("addedToBook" in line, false, "an existing line keeps its counted flag");
});

test("updatedAt is the listen time, else now, never ahead of now or behind the stored date", () => {
  const book = (lastListenAt) => ({ bookGuid: "book-a", seconds: 400, lastListenAt });
  assert.deepEqual(nextListenerLine(undefined, "u", book(null), NOW, MIN).updatedAt, NOW);
  assert.deepEqual(nextListenerLine(undefined, "u", book(new Date("2026-10-09T15:00:00Z")), NOW, MIN).updatedAt, NOW);
  const stored = { seconds: 100, updatedAt: new Date("2026-10-08T00:00:00Z") };
  assert.deepEqual(
    nextListenerLine(stored, "u", book(new Date("2026-10-01T00:00:00Z")), NOW, MIN).updatedAt,
    new Date("2026-10-08T00:00:00Z"),
  );
});

test("the old-data flag is cleared once sessions alone reach the minimum, and not before", () => {
  const stored = { seconds: 0, listenedBeforeSessions: true };
  const below = nextListenerLine(stored, "u", { bookGuid: "b", seconds: 20, lastListenAt: null }, NOW, MIN);
  assert.equal(below.listenedBeforeSessions, true);
  assert.equal(below.qualifies, true);
  const reached = nextListenerLine(stored, "u", { bookGuid: "b", seconds: 300, lastListenAt: null }, NOW, MIN);
  assert.equal(reached.listenedBeforeSessions, false);
  assert.equal(reached.qualifies, true);
});

test("rankBooks counts qualifying people per book, most first, ties by guid", () => {
  const ranking = rankBooks([
    { book_guid: "b", qualifies: true },
    { book_guid: "a", qualifies: true },
    { book_guid: "c", qualifies: true },
    { book_guid: "c", qualifies: true },
    { book_guid: "c", qualifies: false },
    { book_guid: "", qualifies: true },
    { qualifies: true },
  ]);
  assert.deepEqual(ranking, [
    { book_guid: "c", listeners: 2 },
    { book_guid: "a", listeners: 1 },
    { book_guid: "b", listeners: 1 },
  ]);
});

test("listenedByProgress: finished, or chapter positions adding up to the minimum", () => {
  assert.equal(listenedByProgress({ bookGuid: "a", isCompleted: true, allChaptersProgressById: {} }, MIN), true);
  assert.equal(listenedByProgress({ bookGuid: "a", allChaptersProgressById: { "c:0": 200, "c:1": 100 } }, MIN), true);
  assert.equal(listenedByProgress({ bookGuid: "a", allChaptersProgressById: { "c:0": 299 } }, MIN), false);
  // Builds before chapter ids keep positions by index only.
  assert.equal(listenedByProgress({ bookGuid: "a", allChaptersProgress: { 0: 3000 } }, MIN), true);
  assert.equal(listenedByProgress({ bookGuid: "a", deleted: true, isCompleted: true }, MIN), false);
  assert.equal(listenedByProgress({ isCompleted: true }, MIN), false);
});

test("completedBookGuids reads both finished-books lists", () => {
  assert.deepEqual(
    completedBookGuids({ books: [{ bookGuid: "a", deleted: false }, { bookGuid: "b", deleted: true }, { bookGuid: "" }] }),
    ["a"],
  );
  assert.deepEqual(completedBookGuids({ books: ["a", "", 3] }), ["a"]);
  assert.deepEqual(completedBookGuids(undefined), []);
});

test("backfillLines keeps the larger of the two session totals and flags old data only where needed", () => {
  const v2 = new Map([
    ["a", { seconds: 600, lastListenAt: new Date("2026-10-01T00:00:00Z") }],
    ["b", { seconds: 100, lastListenAt: new Date("2026-10-02T00:00:00Z") }],
  ]);
  const legacy = new Map([
    ["a", { seconds: 500, lastListenAt: null }],
    ["c", { seconds: 3720, lastListenAt: null }],
  ]);
  const lines = Object.fromEntries(
    backfillLines("user-1", v2, legacy, new Set(["a", "b", "d"]), MIN).map((line) => [line.book_guid, line]),
  );
  assert.deepEqual(lines.a, {
    book_guid: "a",
    user_guid: "user-1",
    seconds: 600,
    updatedAt: new Date("2026-10-01T00:00:00Z"),
    listenedBeforeSessions: false,
    qualifies: true,
  });
  assert.equal(lines.b.listenedBeforeSessions, true);
  assert.equal(lines.b.qualifies, true);
  assert.deepEqual([lines.c.seconds, lines.c.updatedAt, lines.c.qualifies], [3720, null, true]);
  assert.deepEqual([lines.d.seconds, lines.d.updatedAt, lines.d.listenedBeforeSessions], [0, null, true]);
});

test("settings default when missing or unusable", () => {
  assert.deepEqual(resolvePopularBooksSettings(undefined), {
    windowDays: 30,
    listLength: 100,
    minListenSeconds: 300,
    minChartSize: 20,
  });
  assert.deepEqual(
    resolvePopularBooksSettings({ mostPopularBooksDays: 14, numberOfMostPopularBooksToReturn: 0, popularBooksMinListenSeconds: "x" }),
    { windowDays: 14, listLength: 100, minListenSeconds: 300, minChartSize: 20 },
  );
});

test("line ids are the user then the book", () => {
  assert.equal(bookListenerDocId("user-1", "book-a"), "user-1_book-a");
});
