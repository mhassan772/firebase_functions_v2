import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAppCheckKeys } from "../src/auth/appCheck";
import { clearGoogleKeyCacheForTests } from "../src/auth/googleKeys";
import { Env } from "../src/env";
import { clearAccessTokenCacheForTests } from "../src/google/accessToken";
import { decodeFields, encodeFields, EncodableValue, FirestoreTimestamp } from "../src/google/firestore";
import { handleGetUrls, resetPolicyCache } from "../src/handler";
import { buildGroupedResponse } from "../../../src/shared/getUrlsCore";
import {
  createEnv,
  createSigningKey,
  FakeGoogle,
  FakeKV,
  installFakeGoogle,
  NOW,
  NOW_SECONDS,
  recordingFields,
  signAppCheckToken,
  signIdToken,
  SigningKey,
} from "./helpers";

const DOMAIN = "https://books.good-storage.click";

describe("handleGetUrls", () => {
  let env: Env;
  let key: SigningKey;
  let google: FakeGoogle;
  let token: string;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    clearGoogleKeyCacheForTests();
    clearAccessTokenCacheForTests();
    resetPolicyCache();
    resetAppCheckKeys();

    env = await createEnv(new FakeKV());
    key = await createSigningKey("current");
    token = await signIdToken(key, { uid: "user-1" });
    google = {
      publishedKeys: [key.jwk],
      users: { "user-1": { emailVerified: true } },
      books: {
        bookA: { name: { stringValue: "Book A" }, book_id_reference: { integerValue: "643" } },
        bookB: { name: { stringValue: "Book B" } },
        bookNoRecordingsField: { name: { stringValue: "Empty" } },
      },
      recordings: [
        {
          id: "rec-a",
          fields: recordingFields("bookA", [
            { key: "2", name: "Part 2", duration: 17865, urls: { "64kb_url": "/643/64/64_2.opus" } },
            { key: "1", name: "Part 1", duration: 18874, urls: { "64kb_url": "643/64/64_1.opus" } },
          ]),
        },
        {
          id: "rec-b",
          fields: recordingFields("bookB", [
            { key: "1", name: "Only", duration: 10, urls: { "128kb_url": "b/128/1.opus" } },
          ]),
        },
        { id: "rec-empty", fields: { book_guid: { stringValue: "bookNoRecordingsField" } } },
      ],
      commits: [],
      jwksFetches: 0,
    };
    installFakeGoogle(google);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function call(
    body: unknown,
    init: { method?: string; auth?: string | null; country?: string; appCheck?: string } = {}
  ) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const auth = init.auth === undefined ? `Bearer ${token}` : init.auth;
    if (auth !== null) headers.authorization = auth;
    if (init.appCheck !== undefined) headers["X-Firebase-AppCheck"] = init.appCheck;
    const request = new Request("https://example.test/getUrls", {
        method: init.method ?? "POST",
        headers,
        body: init.method === "GET" ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      });
    // Node's Request does not populate Cloudflare metadata from RequestInit.
    if (init.country !== undefined) {
      Object.defineProperty(request, "cf", { value: { country: init.country } });
    }
    const response = await handleGetUrls(request, env);
    return { status: response.status, body: (await response.json()) as any };
  }

  it("returns URLs in chapter order with numeric durations", async () => {
    const { status, body } = await call({
      books: [{ bookGuid: "bookA", quality: 64, reason: "stream" }],
      platform: "android",
    });

    expect(status).toBe(200);
    expect(body.code).toBe(600);
    expect(body.message).toBe("success");
    expect(body.data.bookA.recordings).toEqual([
      { name: "Part 1", duration: 18874, ext: "opus", url: `${DOMAIN}/643/64/64_1.opus` },
      { name: "Part 2", duration: 17865, ext: "opus", url: `${DOMAIN}/643/64/64_2.opus` },
    ]);
    expect(body.data.bookA.expiresAt).toBe("2026-11-06T12:00:00.000Z");
  });

  it("serves m4a on iOS", async () => {
    const { body } = await call({
      books: [{ bookGuid: "bookB", quality: 128, reason: "download" }],
      platform: "iOS",
    });

    expect(body.data.bookB.recordings[0]).toMatchObject({ ext: "m4a", url: `${DOMAIN}/b/128/1.m4a` });
  });

  it.each([
    ["EG", "https://good-storage.b-cdn.net"],
    ["DZ", "https://good-storage.b-cdn.net"],
    ["LB", "https://good-storage.b-cdn.net"],
    ["US", DOMAIN],
    ["SA", DOMAIN],
    ["XX", DOMAIN],
    [undefined, DOMAIN],
  ])("selects the audio domain for country %s", async (country, domain) => {
    const { status, body } = await call({
      books: [{ bookGuid: "bookA", quality: 64, reason: "stream" }],
      platform: "ios",
    }, { country });

    expect(status).toBe(200);
    expect(body.data.bookA.recordings.map((recording: { url: string }) => recording.url)).toEqual([
      `${domain}/643/64/64_1.m4a`,
      `${domain}/643/64/64_2.m4a`,
    ]);
  });

  it("defaults to Bunny CDN for Firebase callers that do not override the domain", () => {
    const data = buildGroupedResponse({
      books: [{ bookGuid: "bookA", quality: 64, reason: "stream" }],
      platform: "android",
    }, [{
      bookExists: true,
      recordings: { "1": { name: "Part 1", duration: 10, url_list: { "64kb_url": "/a.opus" } } },
    }]);

    expect(data.bookA.recordings[0].url).toBe("https://good-storage.b-cdn.net/a.opus");
  });

  it("writes nothing to Firestore", async () => {
    const { status } = await call({
      books: [
        { bookGuid: "bookA", quality: 64, reason: "stream" },
        { bookGuid: "bookA", quality: 64, reason: "download" },
        { bookGuid: "bookB", quality: 128, reason: "sample" },
      ],
      platform: "android",
      deviceId: "device-1",
    });

    expect(status).toBe(200);
    expect(google.commits).toHaveLength(0);
  });

  it.each([
    ["a missing book", "missing", 64, { code: 601, message: "not-found-book", bookGuid: "missing" }],
    ["a missing quality", "bookA", 256, { code: 604, message: "not-found-quality" }],
    [
      "a recording doc without recordings",
      "bookNoRecordingsField",
      64,
      { code: 605, message: "not-found-recordings", bookGuid: "bookNoRecordingsField" },
    ],
  ])("answers 400 for %s and writes nothing", async (_label, bookGuid, quality, expected) => {
    const { status, body } = await call({
      books: [{ bookGuid, quality, reason: "stream" }],
      platform: "android",
    });

    expect(status).toBe(400);
    expect(body).toEqual(expected);
    expect(google.commits).toHaveLength(0);
  });

  it("answers 605 for a book with no recording doc", async () => {
    google.books.noRecordings = { name: { stringValue: "No recordings" } };

    const { status, body } = await call({
      books: [{ bookGuid: "noRecordings", quality: 64, reason: "stream" }],
      platform: "android",
    });

    expect(status).toBe(400);
    expect(body).toEqual({ code: 605, message: "not-found-recordings", bookGuid: "noRecordings" });
  });

  it("checks the account before the books", async () => {
    delete google.users["user-1"];

    const { status, body } = await call({
      books: [{ bookGuid: "missing", quality: 64, reason: "stream" }],
      platform: "android",
    });

    expect(status).toBe(400);
    expect(body).toEqual({ code: 602, message: "not-found-user" });
  });

  it("streams and samples for an account without a verified email", async () => {
    google.users["user-1"] = { emailVerified: false };

    const { status, body } = await call({
      books: [
        { bookGuid: "bookA", quality: 64, reason: "stream" },
        { bookGuid: "bookB", quality: 128, reason: "sample" },
      ],
      platform: "android",
    });

    expect(status).toBe(200);
    expect(body.data.bookA.recordings).toHaveLength(2);
    expect(body.data.bookB.recordings).toHaveLength(1);
  });

  it("serves an anonymous account, which has no email at all", async () => {
    google.users["user-1"] = {};

    const { status, body } = await call({
      books: [{ bookGuid: "bookA", quality: 64, reason: "sample" }],
      platform: "android",
    });

    expect(status).toBe(200);
    expect(body.data.bookA.recordings).toHaveLength(2);
  });

  it("answers 608 for a download when the email is not verified", async () => {
    google.users["user-1"] = { emailVerified: false };

    const { status, body } = await call({
      books: [
        { bookGuid: "bookA", quality: 64, reason: "stream" },
        { bookGuid: "bookB", quality: 64, reason: "download" },
      ],
      platform: "android",
    });

    expect(status).toBe(400);
    expect(body).toEqual({ code: 608, message: "email-not-verified" });
  });

  it("answers 401 for a disabled account", async () => {
    google.users["user-1"] = { emailVerified: true, disabled: true };

    const { status, body } = await call({
      books: [{ bookGuid: "bookA", quality: 64, reason: "stream" }],
      platform: "android",
    });

    expect(status).toBe(401);
    expect(body.code).toBe(401);
  });

  it("answers 401 when the account's sessions were revoked after the token was issued", async () => {
    google.users["user-1"] = { emailVerified: true, validSince: String(NOW_SECONDS) };

    const { status } = await call({
      books: [{ bookGuid: "bookA", quality: 64, reason: "stream" }],
      platform: "android",
    });

    expect(status).toBe(401);
  });

  it("accepts a long-expired token until the account is revoked", async () => {
    const iat = NOW_SECONDS - 400 * 24 * 60 * 60;
    const oldToken = await signIdToken(key, { uid: "user-1", iat, exp: iat + 3600 });
    const body = { books: [{ bookGuid: "bookA", quality: 64, reason: "stream" }], platform: "android" };

    expect((await call(body, { auth: `Bearer ${oldToken}` })).status).toBe(200);

    google.users["user-1"] = { emailVerified: true, validSince: String(iat + 1) };
    const revoked = await call(body, { auth: `Bearer ${oldToken}` });

    expect(revoked.status).toBe(401);
    expect(revoked.body.message).toBe("Authentication failed: token was revoked.");
  });

  it("answers 401 without a bearer token", async () => {
    const { status, body } = await call({}, { auth: null });

    expect(status).toBe(401);
    expect(body).toEqual({
      code: 401,
      message: "Missing or invalid authorization header. Expected 'Bearer <token>'.",
    });
  });

  it("answers 401 for an invalid token", async () => {
    const { status, body } = await call({}, { auth: "Bearer not-a-jwt" });

    expect(status).toBe(401);
    expect(body.message).toMatch(/^Authentication failed: /);
  });

  it("answers 405 for anything but POST", async () => {
    const { status } = await call(undefined, { method: "GET" });

    expect(status).toBe(405);
  });

  it("answers 400 with the shared validation messages", async () => {
    const { status, body } = await call({ books: [], platform: "android" });

    expect(status).toBe(400);
    expect(body).toEqual({
      code: 400,
      message: "Missing or invalid 'books' field. Expected non-empty array.",
    });
  });

  it("answers 400 for a body that is not JSON", async () => {
    const { status, body } = await call("not json");

    expect(status).toBe(400);
    expect(body).toEqual({ code: 400, message: "Invalid JSON body" });
  });
  describe("under the allowance policy", () => {
    const BUNNY = "https://good-storage.b-cdn.net";
    const DAY_MS = 24 * 60 * 60 * 1000;
    const streamA = { bookGuid: "bookA", quality: 64, reason: "stream" };
    const streamB = { bookGuid: "bookB", quality: 128, reason: "stream" };

    function seedPolicy(overrides: Record<string, EncodableValue> = {}) {
      google.docs = {
        ...google.docs,
        "settings/mantooqAppSettings": encodeFields({
          urlPolicy: {
            minBuild: 616,
            enforce: true,
            linkTtlHours: 168,
            attested: {
              guest: { books: 2, samples: 2 },
              newAccount: { books: 2, samples: 2 },
              free: { books: 3, samples: 3 },
              premium: { books: 10, samples: 10 },
            },
            unattested: {
              guest: { books: 1, samples: 1 },
              newAccount: { books: 1, samples: 1 },
              free: { books: 1, samples: 1 },
              premium: { books: 5, samples: 5 },
            },
            ...overrides,
          },
        }),
      };
    }

    async function useGuest() {
      google.users["user-1"] = { createdAt: String(NOW.getTime() - 400 * DAY_MS) };
      token = await signIdToken(key, { uid: "user-1", signInProvider: "anonymous" });
    }

    async function useFreeAccount() {
      google.users["user-1"] = { emailVerified: true, createdAt: String(NOW.getTime() - 400 * DAY_MS) };
      token = await signIdToken(key, { uid: "user-1", signInProvider: "password" });
    }

    const doc = (path: string) => decodeFields(google.docs?.[path] ?? {});
    const written = (index: number) =>
      google.commits[index].writes.map((write: any) => write.update.name.split("/documents/")[1]);

    beforeEach(() => {
      google.docs = {};
      seedPolicy();
    });

    it("gives an unattested guest one book and refuses the second in the same batch", async () => {
      await useGuest();

      const { status, body } = await call({
        books: [streamA, streamB],
        platform: "android",
        deviceId: "d1",
        build_number: "616",
      });

      expect(status).toBe(200);
      expect(body.data.bookA.recordings).toHaveLength(2);
      expect(body.data.bookB).toEqual({
        error: 609,
        retryAfterSeconds: 86400,
        allowance: 1,
        used: 1,
        kind: "books",
      });
      expect(google.beginTransactions).toBe(1);
      expect(google.commits).toHaveLength(1);
      expect(google.commits[0].transaction).toBe("tx-1");
      expect(written(0)).toEqual([
        "url_grants/user-1",
        "url_grants/user-1/books/bookA",
        "url_grants_devices/d1",
      ]);

      const ledger = doc("url_grants/user-1");
      expect(ledger).toMatchObject({
        anonymous: true,
        recentBooksCount: 1,
        recentSamplesCount: 0,
        recentBooks: [{ guid: "bookA", at: NOW.toISOString() }],
        devices: { d1: NOW.toISOString() },
        firstGrantAt: NOW.toISOString(),
        createdAt: new Date(NOW.getTime() - 400 * DAY_MS).toISOString(),
      });
      expect(doc("url_grants/user-1/books/bookA")).toEqual({
        firstAt: NOW.toISOString(),
        kind: "books",
        reason: "stream",
      });
      expect(doc("url_grants_devices/d1")).toMatchObject({
        guestUids: { "user-1": NOW.toISOString() },
        guestUidsCount: 1,
        recentBooksCount: 1,
      });

      // The same book again is known: granted, and nothing new is recorded.
      vi.setSystemTime(NOW.getTime() + 60_000);
      const again = await call({ books: [streamA], platform: "android", deviceId: "d1", build_number: "616" });

      expect(again.status).toBe(200);
      expect(again.body.data.bookA.recordings).toHaveLength(2);
      expect(written(1)).toEqual(["url_grants/user-1", "url_grants_devices/d1"]);
      expect(doc("url_grants/user-1")).toMatchObject({
        recentBooksCount: 1,
        firstGrantAt: NOW.toISOString(),
        recentBooks: [{ guid: "bookA", at: NOW.toISOString() }],
      });
      expect(doc("url_grants_devices/d1").recentBooksCount).toBe(1);
    });

    it("binds a guest by the device's list across anonymous accounts", async () => {
      await useGuest();
      await call({ books: [streamA], platform: "android", deviceId: "d1", build_number: "616" });

      google.users["user-2"] = {};
      token = await signIdToken(key, { uid: "user-2", signInProvider: "anonymous" });
      const { status, body } = await call({ books: [streamB], platform: "android", deviceId: "d1", build_number: "616" });

      expect(status).toBe(400);
      expect(body).toMatchObject({ code: 609, bookGuid: "bookB", used: 1, allowance: 1 });
      expect(doc("url_grants_devices/d1").guestUidsCount).toBe(2);
    });

    it("signs Cloudflare links for an attested free account", async () => {
      await useFreeAccount();

      const { status, body } = await call(
        { books: [streamA, streamB], platform: "android", build_number: "616" },
        { appCheck: await signAppCheckToken(env) }
      );

      expect(status).toBe(200);
      const url = new URL(body.data.bookA.recordings[0].url);
      expect(url.origin).toBe(DOMAIN);
      expect(url.pathname).toBe("/643/64/64_1.opus");
      expect(url.searchParams.get("u")).toBe("c6c289e4");
      expect(url.searchParams.get("k")).toBe("1");
      expect(url.searchParams.get("verify")).toMatch(new RegExp(`^${NOW_SECONDS}-[A-Za-z0-9_-]{43}$`));
      expect([...url.searchParams.keys()].at(-1)).toBe("verify");
      expect(body.data.bookB.recordings[0].url).toContain("verify=");
      expect(body.data.bookA.expiresAt).toBe(new Date(NOW.getTime() + 168 * 3600 * 1000).toISOString());
      expect(doc("url_grants/user-1")).toMatchObject({ anonymous: false, recentBooksCount: 2 });
    });

    it("signs Bunny links for EG", async () => {
      await useFreeAccount();

      const { body } = await call(
        { books: [streamA], platform: "android", build_number: "616" },
        { country: "EG", appCheck: await signAppCheckToken(env) }
      );

      const url = new URL(body.data.bookA.recordings[0].url);
      expect(url.origin).toBe(BUNNY);
      expect(url.searchParams.get("token")).toMatch(/^HS256-[A-Za-z0-9_-]{43}$/);
      expect(url.searchParams.get("expires")).toBe(String(NOW_SECONDS + 168 * 3600));
    });

    it("treats a free account without a valid App Check token as unattested", async () => {
      await useFreeAccount();

      const wrongProject = await signAppCheckToken(env, { aud: "projects/1" });
      const { body } = await call(
        { books: [streamA, streamB], platform: "android", build_number: "616" },
        { appCheck: wrongProject }
      );

      expect(body.data.bookA.recordings).toHaveLength(2);
      expect(body.data.bookB).toMatchObject({ error: 609, allowance: 1 });
    });

    it("gives a young account the newAccount allowance", async () => {
      await useFreeAccount();
      google.users["user-1"].createdAt = String(NOW.getTime() - 2 * DAY_MS);
      seedPolicy({ unattested: { newAccount: { books: 1 }, free: { books: 5 } } });

      const { body } = await call({ books: [streamA, streamB], platform: "android", build_number: "616" });

      expect(body.data.bookA.recordings).toHaveLength(2);
      expect(body.data.bookB).toMatchObject({ error: 609, allowance: 1 });
    });

    it("returns one recording for a sample", async () => {
      await useFreeAccount();

      const { body } = await call({
        books: [{ bookGuid: "bookA", quality: 64, reason: "sample" }],
        platform: "android",
        build_number: "616",
      });

      expect(body.data.bookA.recordings).toHaveLength(1);
      expect(body.data.bookA.recordings[0].name).toBe("Part 1");
      expect(doc("url_grants/user-1/books/bookA").kind).toBe("samples");
      expect(doc("url_grants/user-1").recentSamplesCount).toBe(1);
    });

    it("answers 400 code 609 for a single refused book", async () => {
      await useFreeAccount();
      await call({ books: [streamA], platform: "android", build_number: "616" });

      const { status, body } = await call({ books: [streamB], platform: "android", build_number: "616" });

      expect(status).toBe(400);
      expect(body).toEqual({
        code: 609,
        message: "allowance-exhausted",
        bookGuid: "bookB",
        error: 609,
        retryAfterSeconds: 86400,
        allowance: 1,
        used: 1,
        kind: "books",
      });
    });

    it("gives a build below minBuild the old unsigned response and writes nothing", async () => {
      await useGuest();

      const { status, body } = await call({
        books: [streamA, streamB],
        platform: "android",
        deviceId: "d1",
        build_number: "600",
      });

      expect(status).toBe(200);
      expect(body.data.bookA.recordings[0].url).toBe(`${DOMAIN}/643/64/64_1.opus`);
      expect(body.data.bookB.recordings[0].url).toBe(`${DOMAIN}/b/128/1.opus`);
      expect(google.beginTransactions ?? 0).toBe(0);
      expect(google.commits).toHaveLength(0);
    });

    it("grants everything when enforce is off but still keeps the ledger", async () => {
      seedPolicy({ enforce: false });
      await useGuest();

      const { status, body } = await call({
        books: [streamA, streamB],
        platform: "android",
        deviceId: "d1",
        build_number: "616",
      });

      expect(status).toBe(200);
      expect(body.data.bookA.recordings).toHaveLength(2);
      expect(body.data.bookB.recordings).toHaveLength(1);
      expect(body.data.bookB.recordings[0].url).toContain("verify=");
      expect(doc("url_grants/user-1").recentBooksCount).toBe(2);
    });

    it("retries an ABORTED commit from a fresh transaction", async () => {
      await useFreeAccount();
      google.failNextCommits = 1;

      const { status, body } = await call({ books: [streamA], platform: "android", build_number: "616" });

      expect(status).toBe(200);
      expect(body.data.bookA.recordings).toHaveLength(2);
      expect(google.beginTransactions).toBe(2);
      expect(google.commits).toHaveLength(1);
      expect(google.commits[0].transaction).toBe("tx-2");
    });

    it("answers 500 when the commit is aborted twice", async () => {
      await useFreeAccount();
      google.failNextCommits = 2;

      const { status } = await call({ books: [streamA], platform: "android", build_number: "616" });

      expect(status).toBe(500);
      expect(google.beginTransactions).toBe(2);
    });

    it("gives an active subscription the premium allowance", async () => {
      await useFreeAccount();
      seedPolicy({ unattested: { free: { books: 1 }, premium: { books: 2 } } });
      google.docs!["subscription_master/user-1"] = encodeFields({
        active: true,
        expiresAt: new FirestoreTimestamp(NOW.getTime() + DAY_MS),
      });

      const { status, body } = await call({ books: [streamA, streamB], platform: "android", build_number: "616" });

      expect(status).toBe(200);
      expect(body.data.bookA.recordings).toHaveLength(2);
      expect(body.data.bookB.recordings).toHaveLength(1);
    });

    it("treats an expired subscription as free", async () => {
      await useFreeAccount();
      seedPolicy({ unattested: { free: { books: 1 }, premium: { books: 2 } } });
      google.docs!["subscription_master/user-1"] = encodeFields({
        active: true,
        expiresAt: new FirestoreTimestamp(NOW.getTime() - 1000),
      });

      const { status, body } = await call({ books: [streamA, streamB], platform: "android", build_number: "616" });

      expect(status).toBe(200);
      expect(body.data.bookB).toMatchObject({ error: 609, allowance: 1 });
    });

    it("answers 400 for more than maxBooksPerRequest books", async () => {
      await useFreeAccount();
      const books = Array.from({ length: 41 }, () => streamA);

      const { status, body } = await call({ books, platform: "android", build_number: "616" });

      expect(status).toBe(400);
      expect(body).toEqual({ code: 400, message: "At most 40 books per request." });
      expect(google.commits).toHaveLength(0);
    });

    it("lowers the cap through the policy", async () => {
      seedPolicy({ maxBooksPerRequest: 1 });
      await useFreeAccount();

      const { status, body } = await call({ books: [streamA, streamB], platform: "android", build_number: "600" });

      expect(status).toBe(400);
      expect(body.message).toBe("At most 1 books per request.");
    });
  });
});
