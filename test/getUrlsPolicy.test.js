const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const { Timestamp } = require("firebase-admin/firestore");

// An in-memory Admin SDK covering only the calls getUrls and its ledger make.
const store = new Map();
const users = new Map();
let commits = 0;

function docRef(path) {
  return {
    path,
    collection: (name) => collectionRef(`${path}/${name}`),
    get: async () => snapshot(path),
  };
}

function collectionRef(path) {
  return {
    doc: (id) => docRef(`${path}/${id}`),
    where: (field, _op, value) => ({
      get: async () => ({
        docs: [...store.entries()]
          .filter(([key, data]) => key.startsWith(`${path}/`) && data[field] === value)
          .map(([key]) => snapshot(key)),
      }),
    }),
  };
}

function snapshot(path) {
  const data = store.get(path);
  return { exists: data !== undefined, data: () => (data === undefined ? undefined : { ...data }) };
}

const fakeAdmin = {
  auth: () => ({
    getUser: async (uid) => {
      const user = users.get(uid);
      if (!user) throw Object.assign(new Error("no user"), { code: "auth/user-not-found" });
      return user;
    },
  }),
  firestore: () => ({
    collection: collectionRef,
    getAll: async (...refs) => refs.map((ref) => snapshot(ref.path)),
    runTransaction: async (body) => {
      const writes = [];
      const result = await body({
        getAll: async (...refs) => refs.map((ref) => snapshot(ref.path)),
        set: (ref, data, options) => writes.push({ ref, data, options }),
      });
      for (const { ref, data, options } of writes) {
        store.set(ref.path, options?.merge ? { ...(store.get(ref.path) ?? {}), ...data } : data);
      }
      commits++;
      return result;
    },
  }),
  appCheck: () => ({ verifyToken: async () => ({}) }),
};

const adminPath = require.resolve("../lib/config/admin");
require.cache[adminPath] = { id: adminPath, filename: adminPath, loaded: true, exports: { admin: fakeAdmin } };
const { handleGetUrls } = require("../lib/handlers/downloadHandlers");
const { GetUrlsError, buildPolicyResponse } = require("../lib/shared/getUrlsCore");

const NOW = Date.parse("2026-11-05T12:00:00Z");
const DOMAIN = "https://books.good-storage.click";
const SECRETS = { cloudflare: "cf-secret", bunny: "bunny-secret" };
const UID_HASH = crypto.createHash("sha256").update("user-1").digest("hex").slice(0, 8);

const POLICY = {
  minBuild: 616,
  enforce: true,
  linkTtlHours: 24,
  attested: { free: { books: 2, samples: 1 } },
  unattested: { free: { books: 1, samples: 1 } },
};

function seed() {
  store.clear();
  users.clear();
  commits = 0;
  users.set("user-1", {
    uid: "user-1",
    emailVerified: true,
    providerData: [{ providerId: "password" }],
    metadata: { creationTime: new Date(NOW - 400 * 86400000).toUTCString() },
  });
  for (const guid of ["b1", "b2", "b3"]) {
    store.set(`books/${guid}`, { name: guid });
    store.set(`book_recordings/rec-${guid}`, {
      book_guid: guid,
      recordings: {
        1: { name: "Part 1", duration: 10, url_list: { "64kb_url": `/${guid}/64/1.opus` } },
        2: { name: "Part 2", duration: 20, url_list: { "64kb_url": `/${guid}/64/2.opus` } },
      },
    });
  }
}

const book = (guid, reason = "stream") => ({ bookGuid: guid, quality: 64, reason });
const request = (books, build = "616") => ({ books, platform: "android", build_number: build });
const context = (urlPolicy, attested = false) => ({
  settings: urlPolicy ? { urlPolicy } : {},
  attested,
  secrets: SECRETS,
  nowMs: NOW,
});

test("with no urlPolicy the response and the ledger are unchanged", async () => {
  seed();
  const response = await handleGetUrls(request([book("b1")]), "user-1", DOMAIN, context(null));
  assert.equal(response.data.b1.recordings[0].url, `${DOMAIN}/b1/64/1.opus`);
  assert.equal(commits, 0);
  assert.equal([...store.keys()].some((key) => key.startsWith("url_grants")), false);
});

test("without a policy context the old response is returned", async () => {
  seed();
  const response = await handleGetUrls(request([book("b1")]), "user-1", DOMAIN);
  assert.equal(response.data.b1.recordings[1].url, `${DOMAIN}/b1/64/2.opus`);
  assert.equal(commits, 0);
});

test("a build below minBuild gets the old response", async () => {
  seed();
  const response = await handleGetUrls(request([book("b1")], "615"), "user-1", DOMAIN, context(POLICY));
  assert.equal(response.data.b1.recordings[0].url, `${DOMAIN}/b1/64/1.opus`);
  assert.equal(commits, 0);
});

test("a sample returns chapter 1 only, signed", async () => {
  seed();
  const response = await handleGetUrls(request([book("b1", "sample")]), "user-1", DOMAIN, context(POLICY));
  const recordings = response.data.b1.recordings;
  assert.equal(recordings.length, 1);
  assert.match(recordings[0].url, new RegExp(`^${DOMAIN}/b1/64/1\\.opus\\?u=${UID_HASH}&k=1&verify=${Math.floor(NOW / 1000)}-`));
  assert.equal(store.get("url_grants/user-1/books/b1").kind, "samples");
});

test("a batch refuses the book past the allowance and signs the rest; the ledger is written", async () => {
  seed();
  const response = await handleGetUrls(
    request([book("b1"), book("b2"), book("b3")]),
    "user-1",
    DOMAIN,
    context(POLICY, true)
  );
  assert.equal(response.code, 600);
  assert.equal(response.data.b1.recordings.length, 2);
  assert.match(response.data.b2.recordings[0].url, /&verify=/);
  assert.deepEqual(response.data.b3, { error: 609, retryAfterSeconds: 86400, allowance: 2, used: 2, kind: "books" });
  assert.equal(response.data.b1.expiresAt, new Date(Math.floor(NOW / 1000) * 1000 + 24 * 3600 * 1000).toISOString());

  const ledger = store.get("url_grants/user-1");
  assert.equal(ledger.recentBooksCount, 2);
  assert.equal(ledger.recentSamplesCount, 0);
  assert.equal(ledger.anonymous, false);
  assert.deepEqual(ledger.recentBooks.map((e) => e.guid), ["b1", "b2"]);
  assert.ok(ledger.recentBooks[0].at instanceof Timestamp);
  assert.equal(store.get("url_grants/user-1/books/b1").reason, "stream");
  assert.ok(store.has("url_grants/user-1/books/b2"));
  assert.equal(store.has("url_grants/user-1/books/b3"), false);

  // Asking again for a book it has costs nothing.
  const again = await handleGetUrls(request([book("b1")]), "user-1", DOMAIN, context(POLICY, true));
  assert.equal(again.data.b1.recordings.length, 2);
  assert.equal(store.get("url_grants/user-1").recentBooksCount, 2);
});

test("a single refused book throws 609 with the refusal fields", async () => {
  seed();
  await handleGetUrls(request([book("b1")]), "user-1", DOMAIN, context(POLICY));
  await assert.rejects(
    handleGetUrls(request([book("b2")]), "user-1", DOMAIN, context(POLICY)),
    (error) => {
      assert.ok(error instanceof GetUrlsError);
      assert.deepEqual(error.body, {
        code: 609,
        message: "allowance-exhausted",
        bookGuid: "b2",
        error: 609,
        retryAfterSeconds: 86400,
        allowance: 1,
        used: 1,
        kind: "books",
      });
      assert.deepEqual(JSON.parse(error.message), error.body);
      return true;
    }
  );
});

test("an active subscription gets the premium allowance", async () => {
  seed();
  store.set("subscription_master/user-1", { active: true, expiresAt: Timestamp.fromMillis(NOW + 86400000) });
  const policy = { ...POLICY, unattested: { free: { books: 1 }, premium: { books: 3 } } };
  const response = await handleGetUrls(request([book("b1"), book("b2"), book("b3")]), "user-1", DOMAIN, context(policy));
  assert.ok(["b1", "b2", "b3"].every((guid) => response.data[guid].recordings));
});

test("buildPolicyResponse signs Bunny links and sets expiresAt from the TTL", async () => {
  const data = await buildPolicyResponse(
    request([book("b1")]),
    [{ bookExists: true, recordings: { 1: { name: "P", duration: 1, url_list: { "64kb_url": "b1/1.opus" } } } }],
    "https://good-storage.b-cdn.net",
    {
      decisions: [{ guid: "b1", kind: "books", granted: true, known: false, allowance: 5, used: 1 }],
      signing: { uidHash: UID_HASH, issuedAtSec: 1762300000, ttlSec: 3600 },
      secrets: { ...SECRETS, keyVersion: "1" },
    }
  );
  assert.match(data.b1.recordings[0].url, /^https:\/\/good-storage\.b-cdn\.net\/b1\/1\.opus\?u=c6c289e4&k=1&token=HS256-[\w-]+&expires=1762303600$/);
  assert.equal(data.b1.expiresAt, new Date(1762303600 * 1000).toISOString());
});
