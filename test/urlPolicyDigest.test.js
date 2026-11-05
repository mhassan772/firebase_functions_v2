const assert = require("node:assert/strict");
const test = require("node:test");

// Keep the Admin SDK out of the handler's import; the test passes its own db.
const adminPath = require.resolve("../lib/config/admin");
require.cache[adminPath] = { id: adminPath, filename: adminPath, loaded: true, exports: { admin: {} } };
const { buildUrlPolicyDigest, handleUrlPolicyDigest } = require("../lib/handlers/urlPolicyDigestHandlers");

const ms = (value) => (typeof value?.toMillis === "function" ? value.toMillis() : value);
const ops = { "==": (a, b) => a === b, ">": (a, b) => a > b, ">=": (a, b) => a >= b, "<": (a, b) => a < b };

/** A query over an in-memory collection supporting only the calls the digest makes. */
function fakeQuery(rows, filters = [], order = null, max = Infinity) {
  const run = () => {
    let out = rows.filter((r) => filters.every(([f, op, v]) => r.data[f] !== undefined && ops[op](ms(r.data[f]), ms(v))));
    // The digest only orders descending.
    if (order) out = [...out].sort((a, b) => b.data[order] - a.data[order]);
    return out.slice(0, max);
  };
  return {
    where: (f, op, v) => fakeQuery(rows, [...filters, [f, op, v]], order, max),
    orderBy: (f) => fakeQuery(rows, filters, f, max),
    limit: (n) => fakeQuery(rows, filters, order, n),
    count: () => ({ get: async () => ({ data: () => ({ count: run().length }) }) }),
    get: async () => ({ docs: run().map((r) => ({ id: r.id, get: (f) => r.data[f] })) }),
  };
}

function fakeDb(collections) {
  const writes = {};
  return {
    writes,
    collection: (name) => ({
      ...fakeQuery(collections[name] ?? []),
      doc: (id) => ({ set: async (value) => { writes[`${name}/${id}`] = value; } }),
    }),
  };
}

const now = new Date("2026-11-05T03:00:00Z");
const hoursAgo = (h) => now.getTime() - h * 3600 * 1000;

const grants = [
  { id: "heavy", data: { anonymous: false, recentBooksCount: 60, recentSamplesCount: 4, updatedAt: hoursAgo(1), firstGrantAt: hoursAgo(500) } },
  { id: "guest-today", data: { anonymous: true, recentBooksCount: 2, recentSamplesCount: 1, updatedAt: hoursAgo(1), firstGrantAt: hoursAgo(2) } },
  { id: "guest-yesterday", data: { anonymous: true, recentBooksCount: 7, recentSamplesCount: 0, updatedAt: hoursAgo(5), firstGrantAt: hoursAgo(10) } },
  { id: "idle", data: { anonymous: false, recentBooksCount: 0, recentSamplesCount: 0, updatedAt: hoursAgo(2), firstGrantAt: hoursAgo(900) } },
  { id: "stale", data: { anonymous: false, recentBooksCount: 99, recentSamplesCount: 0, updatedAt: hoursAgo(30), firstGrantAt: hoursAgo(900) } },
];
const devices = [
  { id: "d-many", data: { guestUidsCount: 5 } },
  { id: "d-three", data: { guestUidsCount: 3 } },
  { id: "d-two", data: { guestUidsCount: 2 } },
];

test("the digest ranks active accounts, counts today's guests, flags shared devices and buckets counts", async () => {
  const digest = await buildUrlPolicyDigest(fakeDb({ url_grants: grants, url_grants_devices: devices }), now);

  assert.equal(digest.day, "20261105");
  assert.deepEqual(digest.topAccounts.map((a) => a.uid), ["heavy", "guest-yesterday", "guest-today", "idle"]);
  assert.deepEqual(digest.topAccounts[0], { uid: "heavy", anonymous: false, recentBooksCount: 60, recentSamplesCount: 4 });
  assert.equal(digest.guestLedgersFirstSeen, 1);
  assert.deepEqual(digest.devicesWithManyGuests, [
    { deviceId: "d-many", guestUidsCount: 5 },
    { deviceId: "d-three", guestUidsCount: 3 },
  ]);
  assert.deepEqual(digest.histogram, { "0": 1, "1-2": 1, "3-5": 0, "6-10": 1, "11-25": 0, "26-50": 0, "51+": 1 });
  assert.equal(digest.generatedAt.toMillis(), now.getTime());
});

test("the digest is stored under the UTC day of the run", async () => {
  const db = fakeDb({});
  await handleUrlPolicyDigest(db, new Date("2026-11-05T23:59:00Z"));
  assert.deepEqual(Object.keys(db.writes), ["url_policy_digest/20261105"]);
  assert.deepEqual(db.writes["url_policy_digest/20261105"].topAccounts, []);
  assert.equal(db.writes["url_policy_digest/20261105"].histogram["51+"], 0);
});
