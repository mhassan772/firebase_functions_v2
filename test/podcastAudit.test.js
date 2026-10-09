const assert = require("node:assert/strict");
const test = require("node:test");
const { Timestamp } = require("firebase-admin/firestore");
const {
  auditDocId,
  canonicalPodcastId,
  podcastIndexIdOf,
  changedSince,
  collectChangedEvents,
  collectionStart,
  convertEventsForChange,
  convertEventsFromDoc,
  deniedPodcastIdsFrom,
  denyDocCountFrom,
  followEventsForChange,
  followEventsFromDoc,
  isListened,
  listenEventsFromDoc,
  parseDate,
  rankPodcastsByDistinctUsers,
  resolvePopularPodcastsSettings,
  withinRetention,
} = require("../lib/handlers/podcastAuditHandlers");

const NOW = new Date("2026-10-08T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const ago = (ms) => new Date(NOW.getTime() - ms);
const iso = (ms) => ago(ms).toISOString();
const SETTINGS = resolvePopularPodcastsSettings(undefined);

// The app stores podcast ids as `p-` plus the Podcast Index feed id.
const subscription = (podcastId, overrides = {}) => ({
  podcastId: `p-${podcastId}`,
  subscribedAt: iso(HOUR),
  updatedAt: iso(HOUR),
  deleted: false,
  position: 0,
  autoAddEnabled: false,
  ...overrides,
});

const conversion = (podcastId, overrides = {}) => ({
  podcastId: `p-${podcastId}`,
  bookGuid: `book-${podcastId}`,
  convertedAt: iso(HOUR),
  chapters: [],
  episodeMappings: {},
  lastChapterIndex: 0,
  deleted: false,
  ...overrides,
});

const episode = (episodeId, overrides = {}) => ({
  episodeId,
  podcastId: "p-100",
  positionInSeconds: 300,
  duration: 3600,
  updatedAt: Timestamp.fromDate(ago(HOUR)),
  deleted: false,
  ...overrides,
});

const ids = (result) => result.events.map((event) => event.id);
const dates = (result) => Object.fromEntries(result.events.map((event) => [event.id, event.data.timestamp.toISOString()]));

const RETENTION = 65;

test("a trigger records added follows inside retention, dated by subscribedAt", () => {
  const before = { subscriptions: [subscription("1"), subscription("2", { deleted: true })] };
  const after = {
    subscriptions: [
      subscription("1"), // already followed
      subscription("2"), // re-followed after a delete
      subscription("3"), // new
      subscription("4", { subscribedAt: iso(5 * DAY) }), // pushed days later by an offline old app
      subscription("5", { deleted: true }), // new but deleted
      subscription("6", { subscribedAt: iso(70 * DAY) }), // past retention
    ],
  };
  const result = followEventsForChange("u1", before, after, NOW, RETENTION);
  assert.deepEqual(dates(result), {
    "follow_u1_p-2": iso(HOUR),
    "follow_u1_p-3": iso(HOUR),
    "follow_u1_p-4": iso(5 * DAY),
  });
  assert.equal(result.skipped, 0);
  assert.deepEqual(result.events[1].data, {
    podcast_id: "p-3",
    user_guid: "u1",
    action: "follow",
    timestamp: ago(HOUR),
  });
});

test("a trigger adds nothing for an existing follow, an unfollow or a deleted document", () => {
  const before = { subscriptions: [subscription("1", { subscribedAt: iso(5 * DAY) })] };
  assert.deepEqual(ids(followEventsForChange("u1", before, before, NOW, RETENTION)), []);
  assert.deepEqual(
    ids(followEventsForChange("u1", before, { subscriptions: [subscription("1", { deleted: true })] }, NOW, RETENTION)),
    [],
  );
  assert.deepEqual(ids(followEventsForChange("u1", before, undefined, NOW, RETENTION)), []);
});

test("a first sync keeps only the restored follows inside retention, with their real dates", () => {
  const restored = {
    subscriptions: [subscription("1", { subscribedAt: iso(30 * DAY) }), subscription("2", { subscribedAt: iso(400 * DAY) })],
  };
  assert.deepEqual(dates(followEventsForChange("u1", undefined, restored, NOW, RETENTION)), {
    "follow_u1_p-1": iso(30 * DAY),
  });
});

test("a trigger counts only newly unreadable dates, and pulls a future date back to now", () => {
  const bad = subscription("1", { subscribedAt: "not a date" });
  assert.equal(followEventsForChange("u1", {}, { subscriptions: [bad] }, NOW, RETENTION).skipped, 1);
  assert.equal(followEventsForChange("u1", { subscriptions: [bad] }, { subscriptions: [bad] }, NOW, RETENTION).skipped, 0);
  const future = followEventsForChange(
    "u1",
    {},
    { subscriptions: [subscription("2", { subscribedAt: iso(-HOUR) })] },
    NOW,
    RETENTION,
  );
  assert.deepEqual(dates(future), { "follow_u1_p-2": NOW.toISOString() });
});

test("malformed documents produce nothing rather than throwing", () => {
  for (const after of [null, {}, { subscriptions: "x" }, { subscriptions: [null, 1, { deleted: false }] }]) {
    assert.deepEqual(ids(followEventsForChange("u1", undefined, after, NOW, RETENTION)), []);
  }
});

test("a trigger records conversions by the same rules, with their book", () => {
  const before = { convertedPodcasts: [conversion("1")] };
  const after = {
    convertedPodcasts: [
      conversion("1"),
      conversion("3"),
      conversion("4", { convertedAt: iso(5 * DAY) }),
      conversion("5", { convertedAt: iso(70 * DAY) }),
      conversion("6", { convertedAt: "bad" }),
    ],
  };
  const result = convertEventsForChange("u1", before, after, NOW, RETENTION);
  assert.deepEqual(result.events, [
    {
      collection: "converted_podcast_audit",
      id: "convert_u1_p-3",
      data: { podcast_id: "p-3", book_guid: "book-3", user_guid: "u1", action: "convert", timestamp: ago(HOUR) },
    },
    {
      collection: "converted_podcast_audit",
      id: "convert_u1_p-4",
      data: { podcast_id: "p-4", book_guid: "book-4", user_guid: "u1", action: "convert", timestamp: ago(5 * DAY) },
    },
  ]);
  assert.equal(result.skipped, 1);
});

test("follows and conversions from a stored document are dated by their own dates", () => {
  const follows = followEventsFromDoc("u1", {
    subscriptions: [
      subscription("1", { subscribedAt: iso(10 * DAY) }),
      subscription("2", { deleted: true }),
      subscription("3", { subscribedAt: "?" }),
    ],
  });
  assert.deepEqual(dates(follows), { "follow_u1_p-1": iso(10 * DAY) });
  assert.equal(follows.skipped, 1);

  const converts = convertEventsFromDoc("u1", { convertedPodcasts: [conversion("7", { convertedAt: iso(4 * DAY) })] });
  assert.deepEqual(dates(converts), { "convert_u1_p-7": iso(4 * DAY) });
});

test("any playback counts as a listen, unless the episode is deleted", () => {
  assert.equal(isListened(30, false), true);
  assert.equal(isListened(1, false), true);
  assert.equal(isListened(0, false), false);
  assert.equal(isListened(30, true), false);
});

test("one listen event per podcast, dated by its latest listened episode", () => {
  const result = listenEventsFromDoc(
    "u1",
    {
      episodes: [
        // Podcast 100: an old listen is re-dated by a newer one.
        episode("e1", { updatedAt: Timestamp.fromDate(ago(70 * DAY)) }),
        episode("e2", { updatedAt: Timestamp.fromDate(ago(2 * HOUR)) }),
        // Unplayed or deleted episodes never move the date.
        episode("e3", { positionInSeconds: 0, updatedAt: Timestamp.fromDate(ago(HOUR)) }),
        episode("e4", { deleted: true, updatedAt: Timestamp.fromDate(ago(HOUR)) }),
        // Podcast 200: 30 seconds played is enough, with an epoch-millisecond date.
        episode("e5", { podcastId: "p-200", positionInSeconds: 30, updatedAt: ago(3 * DAY).getTime() }),
        // Podcast 300: only an unreadable date.
        episode("e6", { podcastId: "p-300", updatedAt: "garbage" }),
        // No podcast id: cannot be ranked.
        episode("e7", { podcastId: null }),
      ],
      updateTimestamp: Timestamp.fromDate(NOW),
    },
  );
  assert.deepEqual(dates(result), {
    "listen_u1_p-100": iso(2 * HOUR),
    "listen_u1_p-200": iso(3 * DAY),
  });
  assert.equal(result.skipped, 1);
  assert.deepEqual(result.events[0].data, {
    podcast_id: "p-100",
    user_guid: "u1",
    action: "listen",
    timestamp: ago(2 * HOUR),
  });
});

test("re-listening to the same episode moves its podcast's date forward", () => {
  const first = listenEventsFromDoc("u1", { episodes: [episode("e1", { updatedAt: Timestamp.fromDate(ago(40 * DAY)) })] });
  const again = listenEventsFromDoc("u1", { episodes: [episode("e1", { updatedAt: Timestamp.fromDate(ago(HOUR)) })] });
  assert.deepEqual(ids(first), ids(again));
  assert.deepEqual(dates(again), { "listen_u1_p-100": iso(HOUR) });
});

test("retention drops old events and pulls future ones back to now", () => {
  const events = [
    { collection: "podcast_audit", id: "a", data: { timestamp: ago(66 * DAY) } },
    { collection: "podcast_audit", id: "b", data: { timestamp: ago(64 * DAY) } },
    { collection: "podcast_audit", id: "c", data: { timestamp: ago(-DAY) } },
  ];
  const kept = withinRetention(events, NOW, 65);
  assert.deepEqual(kept.map((e) => e.id), ["b", "c"]);
  assert.equal(kept[1].data.timestamp.getTime(), NOW.getTime());
  assert.equal(events[2].data.timestamp.getTime(), ago(-DAY).getTime(), "the input is not changed");
});

test("the daily collection reads only documents changed after since", () => {
  const since = ago(DAY);
  const docs = [
    {
      source: "episode_progress",
      uid: "u1",
      data: { episodes: [episode("e1")], updateTimestamp: Timestamp.fromDate(ago(HOUR)) },
    },
    {
      source: "episode_progress",
      uid: "u2",
      data: { episodes: [episode("e1")], updateTimestamp: Timestamp.fromDate(ago(2 * DAY)) },
    },
    {
      source: "podcast_subscriptions",
      uid: "u1",
      data: {
        subscriptions: [subscription("1", { subscribedAt: iso(40 * DAY) }), subscription("2", { subscribedAt: iso(90 * DAY) })],
        updatedAt: Timestamp.fromDate(ago(HOUR)),
      },
    },
    // Written by an old app version: no top-level updatedAt, so left to the trigger.
    { source: "podcast_subscriptions", uid: "u3", data: { subscriptions: [subscription("1")] } },
    {
      source: "converted_podcasts",
      uid: "u1",
      data: { convertedPodcasts: [conversion("9", { convertedAt: "bad" }), conversion("8")], updatedAt: Timestamp.fromDate(ago(HOUR)) },
    },
  ];
  const result = collectChangedEvents(docs, since, NOW, SETTINGS);
  assert.equal(result.documents, 3);
  assert.equal(result.skipped, 1);
  // The 90-day-old follow is past the 65-day retention.
  assert.deepEqual(dates(result), {
    "listen_u1_p-100": iso(HOUR),
    "follow_u1_p-1": iso(40 * DAY),
    "convert_u1_p-8": iso(HOUR),
  });
  assert.equal(changedSince({ source: "episode_progress", uid: "u", data: { updateTimestamp: 5 } }, NOW), false);
});

test("collection starts a day before the last run, or two days back the first time", () => {
  assert.equal(collectionStart(Timestamp.fromDate(ago(DAY)), NOW).getTime(), ago(2 * DAY).getTime());
  assert.equal(collectionStart(undefined, NOW).getTime(), ago(2 * DAY).getTime());
  assert.equal(collectionStart(Timestamp.fromDate(ago(10 * DAY)), NOW).getTime(), ago(11 * DAY).getTime());
});

test("dates are read from every stored form", () => {
  const date = new Date("2026-10-01T08:00:00.000Z");
  assert.equal(parseDate(Timestamp.fromDate(date)).getTime(), date.getTime());
  assert.equal(parseDate({ _seconds: date.getTime() / 1000, _nanoseconds: 0 }).getTime(), date.getTime());
  assert.equal(parseDate(date.getTime()).getTime(), date.getTime());
  assert.equal(parseDate(date.getTime() / 1000).getTime(), date.getTime());
  assert.equal(parseDate(String(date.getTime())).getTime(), date.getTime());
  assert.equal(parseDate(date.toISOString()).getTime(), date.getTime());
  for (const bad of [undefined, null, "", "x", NaN, {}, true]) {
    assert.equal(parseDate(bad), null);
  }
});

test("audit ids never contain a slash", () => {
  assert.equal(auditDocId("listen", "u1", "a/b/c"), "listen_u1_a_b_c");
});

test("the ranking counts distinct users, and old bare feed ids count with p- ids", () => {
  const records = [
    // One user who follows and listens counts once.
    { podcast_id: "p-1", user_guid: "a", action: "follow" },
    { podcast_id: "p-1", user_guid: "a", action: "listen" },
    { podcast_id: "p-2", user_guid: "a", action: "listen" },
    { podcast_id: "2", user_guid: "b", action: "follow" },
    { podcast_id: "p-3", user_guid: "c", action: "convert" },
  ];
  assert.deepEqual(rankPodcastsByDistinctUsers(records, new Set(), 10, new Set(["follow", "listen"])), [
    { podcast_id: "p-2", users: 2 },
    { podcast_id: "p-1", users: 1 },
  ]);
});

test("the converted ranking counts a user who converted and listened once, and ignores other actions", () => {
  const records = [
    { podcast_id: "p-1", user_guid: "a", action: "convert" },
    { podcast_id: "p-1", user_guid: "a", action: "listen" },
    { podcast_id: "p-1", user_guid: "b", action: "listen" },
    { podcast_id: "p-2", user_guid: "c", action: "convert" },
    { podcast_id: "p-3", user_guid: "d", action: "unknown" },
    { podcast_id: "p-3", user_guid: "e" },
  ];
  assert.deepEqual(rankPodcastsByDistinctUsers(records, new Set(), 10, new Set(["convert", "listen"])), [
    { podcast_id: "p-1", users: 2 },
    { podcast_id: "p-2", users: 1 },
  ]);
});

test("the ranking drops denied podcasts and malformed records, and keeps ties in feed id order", () => {
  const records = [
    { podcast_id: "p-30", user_guid: "a" },
    { podcast_id: "p-4", user_guid: "a" },
    { podcast_id: 100, user_guid: "a" },
    { podcast_id: "other-source", user_guid: "a" },
    { podcast_id: "p-920666", user_guid: "a" },
    { podcast_id: "p-920666", user_guid: "b" },
    { podcast_id: "", user_guid: "c" },
    { user_guid: "c" },
    { podcast_id: "p-5" },
  ];
  // The deny list holds bare feed ids.
  const denied = new Set(["920666"]);
  assert.deepEqual(rankPodcastsByDistinctUsers(records, denied, 10), [
    { podcast_id: "p-4", users: 1 },
    { podcast_id: "p-30", users: 1 },
    { podcast_id: "p-100", users: 1 },
    { podcast_id: "other-source", users: 1 },
  ]);
  assert.deepEqual(rankPodcastsByDistinctUsers(records.slice().reverse(), denied, 2), [
    { podcast_id: "p-4", users: 1 },
    { podcast_id: "p-30", users: 1 },
  ]);
});

test("feed ids are read from p- ids and bare numbers only", () => {
  assert.equal(podcastIndexIdOf("p-920666"), 920666);
  assert.equal(podcastIndexIdOf("920666"), 920666);
  assert.equal(podcastIndexIdOf(920666), 920666);
  for (const bad of ["p-", "p-12a", "e-12", "p--1", "0", "abc", null, undefined]) {
    assert.equal(podcastIndexIdOf(bad), null, String(bad));
  }
  assert.equal(canonicalPodcastId("920666"), "p-920666");
  assert.equal(canonicalPodcastId("other-source"), "other-source");
});

test("the deny list is read like the app reads it", () => {
  assert.equal(denyDocCountFrom({ podcasts_filtering: { number_of_admin_deny: 2 } }), 2);
  assert.equal(denyDocCountFrom({ podcasts_filtering: { number_of_admin_deny: "3" } }), 3);
  assert.equal(denyDocCountFrom({}), 0);
  assert.equal(denyDocCountFrom(undefined), 0);
  const denied = deniedPodcastIdsFrom([
    { denied_podcasts: [{ podcastIndexId: 920666, title: "x" }, { podcastIndexId: "12" }, { podcastIndexId: "p-7" }, { title: "no id" }] },
    undefined,
    { denied_podcasts: "x" },
  ]);
  assert.deepEqual([...denied].sort(), ["12", "7", "920666"]);
});

test("settings fall back to defaults and retention stays past the window", () => {
  assert.deepEqual(SETTINGS, { windowDays: 60, retentionDays: 65, listLength: 50 });
  assert.deepEqual(
    resolvePopularPodcastsSettings({
      popularPodcastsDays: 40,
      popularPodcastsAuditRetentionDays: 40,
      numberOfPopularPodcastsToReturn: 12,
    }),
    { windowDays: 40, retentionDays: 41, listLength: 12 },
  );
});
