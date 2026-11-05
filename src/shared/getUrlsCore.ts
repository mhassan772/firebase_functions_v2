/**
 * Runtime-independent logic of the getUrls endpoints.
 *
 * Shared by the Firebase functions and the Cloudflare Worker in `workers/get-urls`, so both
 * share response construction. Must not import firebase-admin or any Node-only module.
 */
import {
  BookItem,
  BookUrlData,
  GetUrlsData,
  GetUrlsRequest,
  GetUrlsResponse,
  Quality,
  Recording,
  RecordingUrl,
} from "../types";
import { signAudioUrl, SigningContext, SigningSecrets } from "./audioSigning";
import { BookDecision, refusalEntry } from "./urlPolicy";

// export const PUBLIC_DOMAIN = "https://books.good-storage.click";
export const PUBLIC_DOMAIN = "https://good-storage.b-cdn.net";
export const ORIGINAL_PUBLIC_DOMAIN = "https://books.good-storage.click";

export function audioDomainForCountry(country: unknown): string {
  return country === "EG" || country === "DZ" || country === "LB"
    ? PUBLIC_DOMAIN
    : ORIGINAL_PUBLIC_DOMAIN;
}

const VALID_REASONS = ["download", "stream", "sample"];

/** The cap applies to every build; the policy block can lower it. */
export const DEFAULT_MAX_BOOKS_PER_REQUEST = 40;

export interface ApiErrorBody {
  code: number;
  message: string;
  bookGuid?: string;
  /** Set on code 609: the refusal fields of `BookRefusal`. */
  retryAfterSeconds?: number;
  allowance?: number;
  used?: number;
  kind?: "books" | "samples";
  error?: 609;
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

/** The 400 body for a single-book request the allowance refused; the fields match [BookRefusal]. */
export const allowanceExhaustedError = (bookGuid: string, decision: BookDecision) =>
  new GetUrlsError({
    code: 609,
    message: "allowance-exhausted",
    bookGuid,
    ...refusalEntry(decision),
  });

/**
 * Whether an account without a verified email may have [books]' URLs.
 *
 * A guest's anonymous account and an email account not confirmed yet listen before having an
 * account in force: streams and samples are theirs. A download belongs to an account, so it
 * still needs the verified email.
 */
export function allowsUnverifiedEmail(books: { reason?: string }[]): boolean {
  return books.every((book) => book.reason !== "download");
}

/** Returns the 400 body for an invalid request, or null when the request is valid. */
export function validateGetUrlsRequest(
  books: BookItem[] | undefined,
  platform: string | undefined,
  maxBooks: number = DEFAULT_MAX_BOOKS_PER_REQUEST
): ApiErrorBody | null {
  if (!books || !Array.isArray(books) || books.length === 0) {
    return { code: 400, message: "Missing or invalid 'books' field. Expected non-empty array." };
  }

  if (books.length > maxBooks) {
    return { code: 400, message: `At most ${maxBooks} books per request.` };
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
  sources: BookSource[],
  publicDomain: string = PUBLIC_DOMAIN
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
      recordings: buildPublicUrls(recordings, bookItem.quality, request.platform, publicDomain),
      expiresAt,
    };
  }

  return result;
}

/**
 * Fails like [buildGroupedResponse] on a missing book, recording set or quality, in request
 * order, without building anything.
 *
 * The policy path runs it before the ledger transaction, so a request that would fail anyway
 * spends no allowance.
 */
export function assertSourcesComplete(request: GetUrlsRequest, sources: BookSource[]): void {
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
    const qualityKey = `${bookItem.quality}kb_url`;
    for (const recording of Object.values(source.recordings)) {
      if (!recording.url_list?.[qualityKey]) {
        throw new GetUrlsError({ code: 604, message: "not-found-quality" });
      }
    }
  }
}

/** How the policy path signs and limits the links of a request. */
export interface PolicyResponseOptions {
  /** One decision per distinct guid, from `decideGrants`. */
  decisions: BookDecision[];
  signing: SigningContext;
  secrets: SigningSecrets;
}

/**
 * Builds the `data` map under the allowance policy.
 *
 * Like [buildGroupedResponse] it fails the whole request on a missing book, recording set or
 * quality. A granted book gets signed links that expire with the token; a sample gets chapter 1
 * only; a refused book gets a refusal entry. A single-book request that is refused throws the
 * 609 error instead, so older error handling still sees one code.
 */
export async function buildPolicyResponse(
  request: GetUrlsRequest,
  sources: BookSource[],
  publicDomain: string,
  options: PolicyResponseOptions
): Promise<GetUrlsData> {
  const decisionByGuid = new Map(options.decisions.map((decision) => [decision.guid, decision]));
  const expiresAt = new Date((options.signing.issuedAtSec + options.signing.ttlSec) * 1000).toISOString();
  const singleBook = new Set(request.books.map((book) => book.bookGuid)).size === 1;
  const result: GetUrlsData = {};

  for (let i = 0; i < request.books.length; i++) {
    const bookItem = request.books[i];
    const source = sources[i];
    const decision = decisionByGuid.get(bookItem.bookGuid);

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
    if (!decision) {
      throw new Error(`No allowance decision for ${bookItem.bookGuid}`);
    }

    if (!decision.granted) {
      if (singleBook) {
        throw allowanceExhaustedError(bookItem.bookGuid, decision);
      }
      result[bookItem.bookGuid] = refusalEntry(decision);
      continue;
    }

    // A full grant in the same request covers a sample of the same book; a sample alone is chapter 1.
    const recordings = Object.values(source.recordings);
    const wanted = decision.kind === "samples" ? recordings.slice(0, 1) : recordings;
    const plain = buildPublicUrls(wanted, bookItem.quality, request.platform, publicDomain);
    const signed = await Promise.all(
      plain.map(async (recording) => ({
        ...recording,
        url: await signAudioUrl(
          publicDomain,
          recording.url.slice(publicDomain.length + 1),
          options.signing,
          options.secrets
        ),
      }))
    );
    result[bookItem.bookGuid] = { recordings: signed, expiresAt };
  }

  return result;
}

function buildPublicUrls(
  recordings: Recording[],
  quality: Quality,
  platform: string,
  publicDomain: string
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
        ? `${publicDomain}/${path.replace("opus", "m4a")}`
        : `${publicDomain}/${path}`;

    return {
      name: recording.name,
      duration: recording.duration,
      ext: url.split(".").pop() || "",
      url,
    };
  });
}

export function buildSuccessResponse(data: GetUrlsData): GetUrlsResponse {
  return { code: 600, message: "success", data };
}

function getExpiryTimestamp(): string {
  const expiresAt = new Date();
  expiresAt.setMonth(expiresAt.getMonth() + 1);
  return expiresAt.toISOString();
}
