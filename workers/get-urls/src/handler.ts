import {
  ApiErrorBody,
  BookSource,
  buildAuditFields,
  buildGroupedResponse,
  buildSuccessResponse,
  emailNotVerifiedError,
  getCounterField,
  GetUrlsError,
  notFoundUserError,
  validateGetUrlsRequest,
} from "../../../src/shared/getUrlsCore";
import { BookItem, GetUrlsRequest, Recording } from "../../../src/types";
import { AuthError, verifyFirebaseIdToken } from "./auth/firebaseIdToken";
import { Env } from "./env";
import { lookupAccount } from "./google/identityToolkit";
import {
  autoId,
  batchGet,
  commit,
  decodeFields,
  documentName,
  encodeValue,
  FirestoreFields,
  runQuery,
} from "./google/firestore";

/** Firestore allows at most 30 values in an IN filter. */
const IN_FILTER_LIMIT = 30;

/**
 * Serves getUrls with the same request, responses and Firestore writes as the Firebase function.
 *
 * The usage writes run after the response is sent, so a write failure is only logged.
 */
export async function handleGetUrls(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
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
  try {
    ({ uid, issuedAt } = await verifyFirebaseIdToken(idToken, env));
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

  const { books, platform, deviceId } = body;
  const validationError = validateGetUrlsRequest(books, platform);
  if (validationError) {
    return json(400, validationError);
  }
  const getUrlsRequest: GetUrlsRequest = { books: books!, platform: platform!, deviceId };

  try {
    // The account and the books are read together; the account is still checked first so the
    // error precedence matches the Firebase function.
    const bookGuids = getUrlsRequest.books.map((book) => book.bookGuid);
    const [account, bookDocs, recordingsByGuid] = await Promise.all([
      lookupAccount(uid, env),
      readBooks(env, bookGuids),
      readRecordings(env, bookGuids),
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
    if (!account.emailVerified) {
      throw emailNotVerifiedError();
    }

    const sources: BookSource[] = bookGuids.map((guid) => ({
      bookExists: bookDocs.get(guid) != null,
      recordings: recordingsByGuid.get(guid) ?? null,
    }));
    const data = buildGroupedResponse(getUrlsRequest, sources);

    ctx.waitUntil(
      recordUsage(env, getUrlsRequest, bookDocs, uid).catch((error) =>
        console.error(JSON.stringify({ event: "getUrls.recordUsage.failed", uid, error: String(error) }))
      )
    );

    return json(200, buildSuccessResponse(data));
  } catch (error) {
    if (error instanceof GetUrlsError) {
      return json(400, error.body);
    }
    return unexpected(error);
  }
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

/** Increments each book's counter for each distinct reason and writes one audit doc per item. */
async function recordUsage(
  env: Env,
  request: GetUrlsRequest,
  bookDocs: Map<string, FirestoreFields | null>,
  uid: string
): Promise<void> {
  const counterFields = new Map<string, Set<string>>();
  for (const item of request.books) {
    const fields = counterFields.get(item.bookGuid) ?? new Set<string>();
    fields.add(getCounterField(item.reason));
    counterFields.set(item.bookGuid, fields);
  }

  const counterWrites = [...counterFields].map(([guid, fields]) => ({
    transform: {
      document: documentName(env, `books/${guid}`),
      fieldTransforms: [...fields].map((fieldPath) => ({
        fieldPath,
        increment: { integerValue: "1" },
      })),
    },
    currentDocument: { exists: true },
  }));

  const auditWrites = request.books.map((item: BookItem) => {
    const book = decodeFields(bookDocs.get(item.bookGuid) ?? {});
    const fields = buildAuditFields(
      item.bookGuid,
      book.name as string,
      book.book_id_reference as string | number | undefined,
      item.reason,
      uid,
      request.deviceId
    );
    return {
      update: {
        name: documentName(env, `books_download_audit/${autoId()}`),
        fields: Object.fromEntries(
          Object.entries(fields).map(([key, value]) => [key, encodeValue(value)])
        ),
      },
      updateTransforms: [{ fieldPath: "timestamp", setToServerValue: "REQUEST_TIME" }],
      currentDocument: { exists: false },
    };
  });

  await commit(env, [...counterWrites, ...auditWrites]);
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
