const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const test = require("node:test");
const {
  enrichRanking,
  metadataByIndexId,
  metadataFrom,
  metadataFromFeed,
  podcastIndexHeaders,
  podcastIndexKeysFrom,
  podcastIndexLookup,
} = require("../lib/handlers/popularPodcastMetadata");

const KEYS = { apiKey: "FAKEKEY", apiSecret: "fake$secret" };
const item = (id, title, overrides = {}) => ({ podcastIndexId: id, title, image: `https://img/${id}.jpg`, ...overrides });

test("stored items are read into the fields the app reads, and need a title and an image", () => {
  assert.deepEqual(
    metadataFrom({
      podcastIndexId: "920666",
      title: " عنوان ",
      image: "https://img/1.jpg",
      itunesId: "123",
      podcastGuid: "guid",
      author: "",
      owner: "Owner",
      extra: true,
    }),
    { title: "عنوان", image: "https://img/1.jpg", podcastIndexId: 920666, itunesId: 123, podcastGuid: "guid", owner: "Owner" },
  );
  assert.equal(metadataFrom({ title: "t", image: "" }), null);
  assert.equal(metadataFrom({ image: "i" }), null);
  assert.equal(metadataFrom(null), null);
});

test("a Podcast Index feed is mapped, with artwork standing in for a missing image", () => {
  assert.deepEqual(
    metadataFromFeed({
      id: 75075,
      title: "Batman",
      image: "",
      artwork: "https://img/art.jpg",
      itunesId: 1441923632,
      podcastGuid: "9b024349",
      author: "Author",
      ownerName: "Owner",
      url: "https://feed",
    }),
    {
      title: "Batman",
      image: "https://img/art.jpg",
      podcastIndexId: 75075,
      itunesId: 1441923632,
      podcastGuid: "9b024349",
      author: "Author",
      owner: "Owner",
    },
  );
  assert.equal(metadataFromFeed([]), null);
});

test("curated metadata wins over yesterday's, and the API is only asked for the rest", async () => {
  const curated = metadataByIndexId([[item(1, "curated one")], [item(2, "curated two")]]);
  const previous = metadataByIndexId([[item(1, "old one"), item(3, "old three"), { podcastIndexId: 5, title: "no image" }]]);
  const asked = [];
  const lookup = async (id) => {
    asked.push(id);
    return id === 4 ? { title: "api four", image: "https://img/4.jpg", author: "A" } : null;
  };
  const ranking = [
    { podcast_id: "p-1", users: 9 },
    { podcast_id: "p-3", users: 8 },
    { podcast_id: "p-5", users: 7 }, // no usable metadata anywhere: dropped
    { podcast_id: "other-source", users: 6 }, // no feed id: dropped
    { podcast_id: "p-4", users: 5 },
    { podcast_id: "p-2", users: 4 },
    { podcast_id: "p-6", users: 3 },
  ];
  const result = await enrichRanking(ranking, { curated, previous, lookup, limit: 3, maxLookups: 30 });
  assert.deepEqual(result.entries, [
    { podcast_id: "p-1", users: 9, title: "curated one", image: "https://img/1.jpg", podcastIndexId: 1 },
    { podcast_id: "p-3", users: 8, title: "old three", image: "https://img/3.jpg", podcastIndexId: 3 },
    { podcast_id: "p-4", users: 5, title: "api four", image: "https://img/4.jpg", author: "A", podcastIndexId: 4 },
  ]);
  assert.deepEqual(result.dropped, ["p-5", "other-source"]);
  // The list is full after p-4, so p-2 and p-6 are never reached.
  assert.deepEqual(asked, [5, 4]);
});

test("lookups stop at the cap, and a failing lookup only drops that podcast", async () => {
  let calls = 0;
  const lookup = async (id) => {
    calls++;
    if (id === 1) throw new Error("boom");
    return { title: `t${id}`, image: "i" };
  };
  const ranking = [1, 2, 3, 4].map((id) => ({ podcast_id: `p-${id}`, users: 1 }));
  const result = await enrichRanking(ranking, { curated: new Map(), previous: new Map(), lookup, limit: 30, maxLookups: 2 });
  assert.equal(calls, 2);
  assert.deepEqual(result.entries.map((e) => e.podcast_id), ["p-2"]);
  assert.deepEqual(result.dropped, ["p-1", "p-3", "p-4"]);
});

test("Podcast Index headers sign key + secret + date with sha1", () => {
  const headers = podcastIndexHeaders(KEYS, new Date("2026-10-09T00:00:00.000Z"));
  assert.equal(headers["X-Auth-Date"], "1791504000");
  assert.equal(headers["X-Auth-Key"], "FAKEKEY");
  assert.equal(headers.Authorization, createHash("sha1").update("FAKEKEYfake$secret1791504000").digest("hex"));
  assert.match(headers["User-Agent"], /Mantooq/);
});

test("the keys are read from settings_metadata only when both are set", () => {
  assert.deepEqual(podcastIndexKeysFrom({ podcast_index_keys: { api_key: " k ", api_secret: "s" } }), { apiKey: "k", apiSecret: "s" });
  assert.equal(podcastIndexKeysFrom({ podcast_index_keys: { api_key: "k" } }), null);
  assert.equal(podcastIndexKeysFrom(undefined), null);
});

test("the lookup calls byfeedid and maps the feed; errors give null without the keys", async () => {
  const requests = [];
  const fakeFetch = async (url, init) => {
    requests.push({ url, init });
    if (url.endsWith("id=404")) return { ok: false, status: 404, json: async () => ({}) };
    if (url.endsWith("id=500")) throw new Error("network down");
    return { ok: true, status: 200, json: async () => ({ status: "true", feed: { id: 75075, title: "Batman", image: "https://img/b.jpg" } }) };
  };
  const errors = [];
  const lookup = podcastIndexLookup(KEYS, { fetchImpl: fakeFetch, onError: (id, reason) => errors.push([id, reason]) });

  assert.deepEqual(await lookup(75075), { title: "Batman", image: "https://img/b.jpg", podcastIndexId: 75075 });
  assert.equal(requests[0].url, "https://api.podcastindex.org/api/1.0/podcasts/byfeedid?id=75075");
  assert.equal(requests[0].init.headers["X-Auth-Key"], "FAKEKEY");
  assert.ok(requests[0].init.signal, "the request has a timeout");

  assert.equal(await lookup(404), null);
  assert.equal(await lookup(500), null);
  assert.deepEqual(errors, [[404, "HTTP 404"], [500, "Error"]]);
  assert.ok(!JSON.stringify(errors).includes("fake$secret"));

  const ranking = [{ podcast_id: "p-75075", users: 3 }, { podcast_id: "p-404", users: 2 }];
  const result = await enrichRanking(ranking, { curated: new Map(), previous: new Map(), lookup, limit: 30, maxLookups: 30 });
  assert.deepEqual(result.entries, [
    { podcast_id: "p-75075", users: 3, title: "Batman", image: "https://img/b.jpg", podcastIndexId: 75075 },
  ]);
  assert.deepEqual(result.dropped, ["p-404"]);
});
