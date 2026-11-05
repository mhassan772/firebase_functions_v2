import {
  allowsUnverifiedEmail,
  ApiErrorBody,
  assertSourcesComplete,
  BookSource,
  buildGroupedResponse,
  buildPolicyResponse,
  buildSuccessResponse,
  DEFAULT_MAX_BOOKS_PER_REQUEST,
  emailNotVerifiedError,
  GetUrlsError,
  notFoundUserError,
  audioDomainForCountry,
  validateGetUrlsRequest,
} from "../../../src/shared/getUrlsCore";
import { uidHash } from "../../../src/shared/audioSigning";
import {
  allowanceFor,
  GrantReason,
  parseUrlPolicy,
  policyApplies,
  summarizeGrants,
  UrlPolicy,
} from "../../../src/shared/urlPolicy";
import { GetUrlsRequest, Recording } from "../../../src/types";
import { isAttestedRequest } from "./auth/appCheck";
import { AuthError, verifyFirebaseIdToken } from "./auth/firebaseIdToken";
import { Env } from "./env";
import { lookupAccount } from "./google/identityToolkit";
import {
  batchGet,
  decodeFields,
  documentName,
  encodeValue,
  FirestoreFields,
  runQuery,
} from "./google/firestore";
import { masterSaysPremium, runGrantTransaction } from "./urlGrants";

/** Firestore allows at most 30 values in an IN filter. */
const IN_FILTER_LIMIT = 30;

const SETTINGS_PATH = "settings/mantooqAppSettings";
const SETTINGS_CACHE_MS = 60_000;
let settingsCache: { at: number; policy: UrlPolicy | null } | null = null;

/** Drops the cached policy; tests use it. */
export function resetPolicyCache(): void {
  settingsCache = null;
}

/**
 * Serves getUrls with the same request and responses as the Firebase function.
 *
 * Under the allowance policy it also keeps the `url_grants` ledger, through the same shared
 * decision as the function, and signs the links it returns.
 */
export async function handleGetUrls(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return json(405, { code: 405, message: "Method not allowed. Use POST." });
  }

  const authHeader = request.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return json(401, {
      code: 401,
      message: "Missing or invalid authorization header. Expected 'Bearer <token>'.",
    });
  }
  const idToken = authHeader.split("Bearer ")[1];
  if (!idToken) {
    return json(401, { code: 401, message: "Missing ID token in authorization header." });
  }

  let uid: string;
  let issuedAt: number;
  let signInProvider: string | undefined;
  try {
    ({ uid, issuedAt, signInProvider } = await verifyFirebaseIdToken(idToken, env));
  } catch (error) {
    if (error instanceof AuthError) {
      return json(401, { code: 401, message: "Authentication failed: " + error.message });
    }
    return unexpected(error);
  }

  let body: Partial<GetUrlsRequest>;
  try {
    body = ((await request.json()) ?? {}) as Partial<GetUrlsRequest>;
  } catch {
    return json(400, { code: 400, message: "Invalid JSON body" });
  }

  try {
    const policy = await readPolicy(env);
    const { books, platform, deviceId, build_number } = body;
    const validationError = validateGetUrlsRequest(
      books,
      platform,
      policy?.maxBooksPerRequest ?? DEFAULT_MAX_BOOKS_PER_REQUEST
    );
    if (validationError) {
      return json(400, validationError);
    }
    const getUrlsRequest: GetUrlsRequest = {
      books: books!,
      platform: platform!,
      deviceId,
      build_number: build_number === undefined ? undefined : String(build_number),
    };
    const applies = policyApplies(policy, getUrlsRequest.build_number);

    // The account and the books are read together; the account is still checked first so the
    // error precedence matches the Firebase function.
    const bookGuids = getUrlsRequest.books.map((book) => book.bookGuid);
    const [account, bookDocs, recordingsByGuid, master, attested] = await Promise.all([
      lookupAccount(uid, env),
      readBooks(env, bookGuids),
      readRecordings(env, bookGuids),
      applies ? readMaster(env, uid) : Promise.resolve(null),
      applies ? isAttestedRequest(request, env) : Promise.resolve(false),
    ]);

    if (!account) {
      throw notFoundUserError();
    }
    if (account.disabled) {
      return json(401, { code: 401, message: "Authentication failed: user is disabled." });
    }
    if (account.validSince !== null && issuedAt < account.validSince) {
      return json(401, { code: 401, message: "Authentication failed: token was revoked." });
    }
    // Listening comes before the account is in force; only a download waits on the verified email.
    if (!account.emailVerified && !allowsUnverifiedEmail(getUrlsRequest.books)) {
      throw emailNotVerifiedError();
    }

    const sources: BookSource[] = bookGuids.map((guid) => ({
      bookExists: bookDocs.get(guid) != null,
      recordings: recordingsByGuid.get(guid) ?? null,
    }));
    // Country comes from Cloudflare's IP geolocation, not the request body.
    // Unknown locations use the original domain.
    const publicDomain = audioDomainForCountry(request.cf?.country);

    if (!applies || !policy) {
      return json(200, buildSuccessResponse(buildGroupedResponse(getUrlsRequest, sources, publicDomain)));
    }

    // A request that fails on the catalogue spends nothing.
    assertSourcesComplete(getUrlsRequest, sources);

    const nowMs = Date.now();
    const anonymous = signInProvider === "anonymous";
    const identity = {
      anonymous,
      createdAtMs: account.createdAtMs,
      premium: masterSaysPremium(master, nowMs),
      attested,
    };
    const { tier, attested: attestedTier, allowance } = allowanceFor(identity, policy, nowMs);

    const result = await runGrantTransaction(env, {
      uid,
      deviceId,
      anonymous,
      createdAtMs: account.createdAtMs,
      books: getUrlsRequest.books.map((book) => ({ guid: book.bookGuid, reason: book.reason as GrantReason })),
      allowance,
      enforce: policy.enforce,
      nowMs,
    });
    console.log(
      JSON.stringify({
        event: "getUrls.allowance",
        uid,
        tier,
        attested: attestedTier,
        anonymous,
        build: getUrlsRequest.build_number,
        enforce: policy.enforce,
        ...summarizeGrants(result),
      })
    );

    const data = await buildPolicyResponse(getUrlsRequest, sources, publicDomain, {
      decisions: result.decisions,
      signing: { uidHash: await uidHash(uid), issuedAtSec: Math.floor(nowMs / 1000), ttlSec: policy.linkTtlHours * 3600 },
      secrets: {
        cloudflare: env.AUDIO_SIGN_CF ?? "",
        bunny: env.AUDIO_SIGN_BUNNY ?? "",
        keyVersion: policy.keyVersion,
      },
    });
    return json(200, buildSuccessResponse(data));
  } catch (error) {
    if (error instanceof GetUrlsError) {
      return json(400, error.body);
    }
    return unexpected(error);
  }
}

/** The `urlPolicy` block of the settings document, cached per isolate for a minute. */
async function readPolicy(env: Env): Promise<UrlPolicy | null> {
  const now = Date.now();
  if (settingsCache && now - settingsCache.at < SETTINGS_CACHE_MS) return settingsCache.policy;
  const name = documentName(env, SETTINGS_PATH);
  const docs = await batchGet(env, [name]);
  const fields = docs.get(name);
  const policy = fields ? parseUrlPolicy(decodeFields(fields).urlPolicy) : null;
  settingsCache = { at: now, policy };
  return policy;
}

async function readMaster(env: Env, uid: string): Promise<FirestoreFields | null> {
  const name = documentName(env, `subscription_master/${uid}`);
  return (await batchGet(env, [name])).get(name) ?? null;
}

async function readBooks(
  env: Env,
  guids: string[]
): Promise<Map<string, FirestoreFields | null>> {
  const uniqueGuids = [...new Set(guids)];
  const byName = await batchGet(
    env,
    uniqueGuids.map((guid) => documentName(env, `books/${guid}`))
  );
  return new Map(uniqueGuids.map((guid) => [guid, byName.get(documentName(env, `books/${guid}`)) ?? null]));
}

/**
 * Returns the `recordings` map of each book's first `book_recordings` doc by document name,
 * which is the doc the Firebase function's unordered equality query returns first.
 */
async function readRecordings(
  env: Env,
  guids: string[]
): Promise<Map<string, Record<string, Recording> | undefined>> {
  const uniqueGuids = [...new Set(guids)];
  const chunks: string[][] = [];
  for (let i = 0; i < uniqueGuids.length; i += IN_FILTER_LIMIT) {
    chunks.push(uniqueGuids.slice(i, i + IN_FILTER_LIMIT));
  }

  const results = await Promise.all(
    chunks.map((chunk) =>
      runQuery(env, {
        from: [{ collectionId: "book_recordings" }],
        where: {
          fieldFilter: {
            field: { fieldPath: "book_guid" },
            op: "IN",
            value: { arrayValue: { values: chunk.map((guid) => encodeValue(guid)) } },
          },
        },
        orderBy: [{ field: { fieldPath: "__name__" }, direction: "ASCENDING" }],
      })
    )
  );

  const recordings = new Map<string, Record<string, Recording> | undefined>();
  for (const document of results.flat()) {
    const fields = decodeFields(document.fields ?? {});
    const guid = fields.book_guid as string;
    if (!recordings.has(guid)) {
      recordings.set(guid, fields.recordings as Record<string, Recording> | undefined);
    }
  }
  return recordings;
}

function unexpected(error: unknown): Response {
  console.error(JSON.stringify({ event: "getUrls.failed", error: String(error) }));
  return json(500, { code: 500, message: "Unexpected error" });
}

function json(status: number, body: ApiErrorBody | object): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
