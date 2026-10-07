import { exportJWK, exportPKCS8, generateKeyPair, JWK, SignJWT } from "jose";
import { vi } from "vitest";
import { Env } from "../src/env";
import { FirestoreFields } from "../src/google/firestore";

export const PROJECT_ID = "mantooq-test";
export const NOW = new Date("2026-10-06T12:00:00Z");
export const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const DOCS = `projects/${PROJECT_ID}/databases/(default)/documents`;

export class FakeKV {
  readonly store = new Map<string, string>();

  async get(key: string, type?: "json") {
    const value = this.store.get(key) ?? null;
    return value !== null && type === "json" ? JSON.parse(value) : value;
  }

  async put(key: string, value: string) {
    this.store.set(key, value);
  }
}

export interface SigningKey {
  kid: string;
  jwk: JWK;
  privateKey: CryptoKey;
}

export async function createSigningKey(kid: string): Promise<SigningKey> {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" };
  return { kid, jwk, privateKey };
}

export async function createEnv(kv: FakeKV): Promise<Env> {
  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  return {
    GOOGLE_KEYS: kv as unknown as KVNamespace,
    GOOGLE_SERVICE_ACCOUNT: JSON.stringify({
      client_email: "get-urls@mantooq-test.iam.gserviceaccount.com",
      private_key: await exportPKCS8(privateKey),
    }),
    FIREBASE_PROJECT_ID: PROJECT_ID,
  };
}

export async function signIdToken(
  key: SigningKey,
  overrides: { uid?: string; iat?: number; exp?: number | null; aud?: string; iss?: string } = {}
): Promise<string> {
  const iat = overrides.iat ?? NOW_SECONDS - 60;
  const jwt = new SignJWT({ auth_time: iat, user_id: overrides.uid ?? "user-1" })
    .setProtectedHeader({ alg: "RS256", kid: key.kid })
    .setIssuer(overrides.iss ?? `https://securetoken.google.com/${PROJECT_ID}`)
    .setAudience(overrides.aud ?? PROJECT_ID)
    .setSubject(overrides.uid ?? "user-1")
    .setIssuedAt(iat);
  // null leaves the expiry out, which no Firebase-issued token does.
  if (overrides.exp !== null) jwt.setExpirationTime(overrides.exp ?? iat + 3600);
  return jwt.sign(key.privateKey);
}

export interface FakeGoogle {
  /** Keys Google currently publishes. */
  publishedKeys: JWK[];
  users: Record<string, { emailVerified?: boolean; disabled?: boolean; validSince?: string }>;
  books: Record<string, FirestoreFields>;
  recordings: { id: string; fields: FirestoreFields }[];
  commits: { writes: any[] }[];
  jwksFetches: number;
}

/** Replaces global fetch with an in-memory Google: JWKS, OAuth, Identity Toolkit and Firestore. */
export function installFakeGoogle(google: FakeGoogle): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body && typeof init.body === "string" ? JSON.parse(init.body) : undefined;

    if (url.includes("securetoken@system.gserviceaccount.com")) {
      google.jwksFetches++;
      return Response.json({ keys: google.publishedKeys });
    }
    if (url === "https://oauth2.googleapis.com/token") {
      return Response.json({ access_token: "access-token", expires_in: 3600 });
    }
    if (url.endsWith("accounts:lookup")) {
      const user = google.users[body.localId[0]];
      return Response.json(user ? { users: [{ localId: body.localId[0], ...user }] } : {});
    }
    if (url.endsWith("documents:batchGet")) {
      return Response.json(
        body.documents.map((name: string) => {
          const guid = name.split("/").pop()!;
          const fields = google.books[guid];
          return fields ? { found: { name, fields } } : { missing: name };
        })
      );
    }
    if (url.endsWith("documents:runQuery")) {
      const guids = body.structuredQuery.where.fieldFilter.value.arrayValue.values.map(
        (value: { stringValue: string }) => value.stringValue
      );
      const matches = google.recordings
        .filter((doc) => guids.includes((doc.fields.book_guid as { stringValue: string }).stringValue))
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((doc) => ({ document: { name: `${DOCS}/book_recordings/${doc.id}`, fields: doc.fields } }));
      return Response.json(matches.length ? matches : [{ readTime: NOW.toISOString() }]);
    }
    if (url.endsWith("documents:commit")) {
      google.commits.push(body);
      return Response.json({});
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

export function fakeContext() {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
  return { ctx, settle: () => Promise.all(pending) };
}

export function recordingFields(
  bookGuid: string,
  chapters: { key: string; name: string; duration: number; urls: Record<string, string> }[]
): FirestoreFields {
  const recordings: FirestoreFields = {};
  for (const chapter of chapters) {
    const urlList: FirestoreFields = {};
    for (const [quality, path] of Object.entries(chapter.urls)) {
      urlList[quality] = { stringValue: path };
    }
    recordings[chapter.key] = {
      mapValue: {
        fields: {
          duration: { integerValue: String(chapter.duration) },
          name: { stringValue: chapter.name },
          url_list: { mapValue: { fields: urlList } },
        },
      },
    };
  }
  return {
    book_guid: { stringValue: bookGuid },
    recordings: { mapValue: { fields: recordings } },
  };
}
