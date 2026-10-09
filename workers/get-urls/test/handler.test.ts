import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearGoogleKeyCacheForTests } from "../src/auth/googleKeys";
import { Env } from "../src/env";
import { clearAccessTokenCacheForTests } from "../src/google/accessToken";
import { handleGetUrls } from "../src/handler";
import {
  createEnv,
  createSigningKey,
  FakeGoogle,
  FakeKV,
  installFakeGoogle,
  NOW,
  NOW_SECONDS,
  recordingFields,
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

  async function call(body: unknown, init: { method?: string; auth?: string | null } = {}) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const auth = init.auth === undefined ? `Bearer ${token}` : init.auth;
    if (auth !== null) headers.authorization = auth;
    const response = await handleGetUrls(
      new Request("https://example.test/getUrls", {
        method: init.method ?? "POST",
        headers,
        body: init.method === "GET" ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      }),
      env
    );
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

  it("answers 608 when the email is not verified", async () => {
    google.users["user-1"] = { emailVerified: false };

    const { status, body } = await call({
      books: [{ bookGuid: "bookA", quality: 64, reason: "stream" }],
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
});
