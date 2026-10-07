import { beforeEach, describe, expect, it } from "vitest";
import { AuthError, verifyFirebaseIdToken } from "../src/auth/firebaseIdToken";
import { clearGoogleKeyCacheForTests } from "../src/auth/googleKeys";
import { Env } from "../src/env";
import {
  createEnv,
  createSigningKey,
  FakeGoogle,
  FakeKV,
  installFakeGoogle,
  NOW,
  NOW_SECONDS,
  signIdToken,
  SigningKey,
} from "./helpers";

const DAY = 24 * 60 * 60;

describe("verifyFirebaseIdToken", () => {
  let kv: FakeKV;
  let env: Env;
  let key: SigningKey;
  let google: FakeGoogle;

  beforeEach(async () => {
    clearGoogleKeyCacheForTests();
    kv = new FakeKV();
    env = await createEnv(kv);
    key = await createSigningKey("current");
    google = { publishedKeys: [key.jwk], users: {}, books: {}, recordings: [], commits: [], jwksFetches: 0 };
    installFakeGoogle(google);
  });

  it("accepts a fresh token and returns its uid and issue time", async () => {
    const token = await signIdToken(key, { uid: "abc" });

    const result = await verifyFirebaseIdToken(token, env, NOW);

    expect(result).toEqual({ uid: "abc", issuedAt: NOW_SECONDS - 60 });
  });

  it("accepts a token that expired a year ago", async () => {
    const iat = NOW_SECONDS - 365 * DAY;
    const token = await signIdToken(key, { iat, exp: iat + 3600 });

    await expect(verifyFirebaseIdToken(token, env, NOW)).resolves.toEqual({ uid: "user-1", issuedAt: iat });
  });

  it("rejects a token without an expiry", async () => {
    const token = await signIdToken(key, { exp: null });

    await expect(verifyFirebaseIdToken(token, env, NOW)).rejects.toBeInstanceOf(AuthError);
  });

  it("rejects a token for another project", async () => {
    const token = await signIdToken(key, { aud: "other-project" });

    await expect(verifyFirebaseIdToken(token, env, NOW)).rejects.toBeInstanceOf(AuthError);
  });

  it("rejects a token from another issuer", async () => {
    const token = await signIdToken(key, { iss: "https://securetoken.google.com/other-project" });

    await expect(verifyFirebaseIdToken(token, env, NOW)).rejects.toBeInstanceOf(AuthError);
  });

  it("rejects a token issued in the future", async () => {
    const token = await signIdToken(key, { iat: NOW_SECONDS + 3600 });

    await expect(verifyFirebaseIdToken(token, env, NOW)).rejects.toBeInstanceOf(AuthError);
  });

  it("rejects a token signed by a key Google never published", async () => {
    const forged = await createSigningKey("forged");
    const token = await signIdToken(forged);

    await expect(verifyFirebaseIdToken(token, env, NOW)).rejects.toBeInstanceOf(AuthError);
  });

  it("rejects a token whose key ID matches but whose signature does not", async () => {
    const impostor = await createSigningKey("current");
    const token = await signIdToken(impostor);

    await expect(verifyFirebaseIdToken(token, env, NOW)).rejects.toBeInstanceOf(AuthError);
  });

  it("accepts a token signed by a retired key that is still in KV", async () => {
    const retired = await createSigningKey("retired");
    await kv.put(`securetoken-jwk:${retired.kid}`, JSON.stringify(retired.jwk));
    const iat = NOW_SECONDS - 10 * DAY;
    const token = await signIdToken(retired, { iat, exp: iat + 3600 });

    await expect(verifyFirebaseIdToken(token, env, NOW)).resolves.toMatchObject({ uid: "user-1" });
    expect(google.jwksFetches).toBe(0);
  });

  it("fetches Google's keys once when the key is not yet in KV, and stores them", async () => {
    const token = await signIdToken(key);

    await verifyFirebaseIdToken(token, env, NOW);
    await verifyFirebaseIdToken(token, env, NOW);

    expect(google.jwksFetches).toBe(1);
    expect(kv.store.has("securetoken-jwk:current")).toBe(true);
  });
});
