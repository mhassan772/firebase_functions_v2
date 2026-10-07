/**
 * Runtime-independent logic of the getUrls endpoints.
 *
 * Shared by the Firebase functions and the Cloudflare Worker in `workers/get-urls`, so both
 * return identical responses. Must not import firebase-admin or any Node-only module.
 */
import {
  BookItem,
  BookUrlData,
  GetUrlsRequest,
  GetUrlsResponse,
  Quality,
  Reason,
  Recording,
  RecordingUrl,
} from "../types";

export const PUBLIC_DOMAIN = "https://books.good-storage.click";

const VALID_REASONS = ["download", "stream", "sample"];

export interface ApiErrorBody {
  code: number;
  message: string;
  bookGuid?: string;
}

/**
 * An error whose body is sent to the client as-is.
 *
 * The message is the JSON body, so the Firebase entry points, which parse `error.message`,
 * keep answering with HTTP 400 and the same body.
 */
export class GetUrlsError extends Error {
  constructor(readonly body: ApiErrorBody) {
    super(JSON.stringify(body));
  }
}

export const notFoundUserError = () => new GetUrlsError({ code: 602, message: "not-found-user" });

export const emailNotVerifiedError = () =>
  new GetUrlsError({ code: 608, message: "email-not-verified" });

/** Returns the 400 body for an invalid request, or null when the request is valid. */
export function validateGetUrlsRequest(
  books: BookItem[] | undefined,
  platform: string | undefined
): ApiErrorBody | null {
  if (!books || !Array.isArray(books) || books.length === 0) {
    return { code: 400, message: "Missing or invalid 'books' field. Expected non-empty array." };
  }

  if (!platform) {
    return { code: 400, message: "Missing required field: platform" };
  }

  for (const book of books) {
    if (!book.bookGuid) {
      return { code: 400, message: "Each book must have a 'bookGuid' field" };
    }
    if (!book.quality) {
      return { code: 400, message: "Each book must have a 'quality' field" };
    }
    if (!book.reason || !VALID_REASONS.includes(book.reason)) {
      return {
        code: 400,
        message: "Each book must have a 'reason' field with value: download, stream, or sample",
      };
    }
  }

  return null;
}

/** What the backend read for one requested book, in request order. */
export interface BookSource {
  bookExists: boolean;
  /** The `recordings` map of the first matching `book_recordings` doc, if any. */
  recordings: Record<string, Recording> | null | undefined;
}

/**
 * Builds the `data` map of the response.
 *
 * Throws on the first missing book, recording set or quality, in request order, because one
 * failure fails the whole request.
 */
export function buildGroupedResponse(
  request: GetUrlsRequest,
  sources: BookSource[]
): Record<string, BookUrlData> {
  const result: Record<string, BookUrlData> = {};
  const expiresAt = getExpiryTimestamp();

  for (let i = 0; i < request.books.length; i++) {
    const bookItem = request.books[i];
    const source = sources[i];

    if (!source.bookExists) {
      throw new GetUrlsError({ code: 601, message: "not-found-book", bookGuid: bookItem.bookGuid });
    }

    if (!source.recordings) {
      throw new GetUrlsError({
        code: 605,
        message: "not-found-recordings",
        bookGuid: bookItem.bookGuid,
      });
    }

    const recordings = Object.values(source.recordings);
    result[bookItem.bookGuid] = {
      recordings: buildPublicUrls(recordings, bookItem.quality, request.platform),
      expiresAt,
    };
  }

  return result;
}

function buildPublicUrls(
  recordings: Recording[],
  quality: Quality,
  platform: string
): RecordingUrl[] {
  const normalizedPlatform = platform?.toLowerCase() || "android";

  return recordings.map((recording) => {
    const qualityKey = `${quality}kb_url`;
    let path = recording.url_list[qualityKey];

    if (!path) {
      throw new GetUrlsError({ code: 604, message: "not-found-quality" });
    }

    path = path.replace(/^\/+/, "");

    // Only the first "opus" is replaced; released apps rely on these exact URLs.
    const url =
      normalizedPlatform === "ios"
        ? `${PUBLIC_DOMAIN}/${path.replace("opus", "m4a")}`
        : `${PUBLIC_DOMAIN}/${path}`;

    return {
      name: recording.name,
      duration: recording.duration,
      ext: url.split(".").pop() || "",
      url,
    };
  });
}

export function buildSuccessResponse(data: Record<string, BookUrlData>): GetUrlsResponse {
  return { code: 600, message: "success", data };
}

export function getCounterField(reason: Reason | string): string {
  switch (reason) {
    case "download":
      return "num_downloads";
    case "stream":
      return "num_streams";
    case "sample":
      return "num_samples";
    default:
      return "num_downloads";
  }
}

/** Audit fields for one requested book, without the timestamp, whose type is runtime-specific. */
export function buildAuditFields(
  bookGuid: string,
  bookName: string,
  bookIdReference: string | number | undefined | null,
  reason: Reason,
  authId: string,
  deviceId?: string
) {
  return {
    book_guid: bookGuid,
    book_name: bookName,
    book_id_reference: bookIdReference || null,
    user_guid: authId,
    device_id: deviceId || null,
    reason,
  };
}

function getExpiryTimestamp(): string {
  const expiresAt = new Date();
  expiresAt.setMonth(expiresAt.getMonth() + 1);
  return expiresAt.toISOString();
}
