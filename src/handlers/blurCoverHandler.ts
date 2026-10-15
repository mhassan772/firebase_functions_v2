import * as crypto from "crypto";
import * as functions from "firebase-functions";
import sharp from "sharp";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { requireAdminPortalUser } from "../utils/adminRole";
import { getSecret } from "../utils/secrets";

export type BlurCoverKind = "podcast" | "episode" | "book";

export const BLURRED_COVERS_BUCKET = "mantook-book-images-pdf";
export const BLURRED_COVERS_REGION = "eu-west-1";
export const BLURRED_COVERS_PUBLIC_BASE = "https://images.mantooq.com";
export const BLURRED_COVER_CACHE_CONTROL = "public, max-age=31536000, immutable";
export const BLUR_MAX_DIMENSION = 600;
export const BLUR_SIGMA = 30;
export const BLUR_JPEG_QUALITY = 70;
export const FETCH_TIMEOUT_MS = 15_000;
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

const KINDS = new Set<BlurCoverKind>(["podcast", "episode", "book"]);
// Podcast Index ids are numeric; book GUIDs are restricted to characters that are safe in an S3 key.
const NUMERIC_ID = /^\d{1,20}$/;
const BOOK_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_URL_LENGTH = 4096;

export interface BlurCoverRequest {
  kind: BlurCoverKind;
  id: string;
  imageUrl: string;
}

export interface BlurredCoverObject {
  Bucket: string;
  Key: string;
  Body: Buffer;
  ContentType: string;
  CacheControl: string;
}

export interface BlurCoverDeps {
  requireAdmin(uid: string): Promise<void>;
  fetchImage(url: string): Promise<Buffer>;
  putObject(object: BlurredCoverObject): Promise<void>;
}

/** Thrown by `fetchImage` when the original cannot be downloaded, so the caller can map it to a precondition. */
export class ImageFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageFetchError";
  }
}

function invalid(message: string): functions.https.HttpsError {
  return new functions.https.HttpsError("invalid-argument", message);
}

export function parseBlurCoverRequest(data: unknown): BlurCoverRequest {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw invalid("The request must be an object.");
  }
  const { kind, id, imageUrl } = data as Record<string, unknown>;

  if (typeof kind !== "string" || !KINDS.has(kind as BlurCoverKind)) {
    throw invalid("kind must be podcast, episode or book.");
  }
  if (typeof id !== "string") {
    throw invalid("id must be a string.");
  }
  const idPattern = kind === "book" ? BOOK_ID : NUMERIC_ID;
  if (!idPattern.test(id)) {
    throw invalid(kind === "book" ? "id must be a book GUID." : "id must be a Podcast Index id.");
  }

  if (typeof imageUrl !== "string" || imageUrl.trim() === "" || imageUrl.length > MAX_URL_LENGTH) {
    throw invalid("imageUrl must be a non-empty URL.");
  }
  let parsed: URL;
  try {
    parsed = new URL(imageUrl);
  } catch {
    throw invalid("imageUrl must be a valid URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw invalid("imageUrl must use http or https.");
  }

  return { kind: kind as BlurCoverKind, id, imageUrl };
}

/**
 * The key carries a hash of the source picture's bytes, so a changed picture gets a new immutable object
 * instead of a stale cached one, even when it was replaced in place under the same URL, as book covers are.
 */
export function blurredCoverKey(kind: BlurCoverKind, id: string, source: Buffer): string {
  const version = crypto.createHash("sha1").update(source).digest("hex").slice(0, 12);
  return `images/blurred/${kind}/${id}/${version}.jpg`;
}

export function blurredCoverUrl(key: string): string {
  return `${BLURRED_COVERS_PUBLIC_BASE}/${key}`;
}

export async function blurImage(input: Buffer): Promise<Buffer> {
  return sharp(input, { failOn: "error" })
    .rotate()
    .resize(BLUR_MAX_DIMENSION, BLUR_MAX_DIMENSION, { fit: "inside", withoutEnlargement: true })
    .blur(BLUR_SIGMA)
    .jpeg({ quality: BLUR_JPEG_QUALITY })
    .toBuffer();
}

export function createBlurCoverHandler(deps: BlurCoverDeps) {
  return async (
    data: unknown,
    context: functions.https.CallableContext
  ): Promise<{ url: string }> => {
    const uid = context.auth?.uid;
    if (!uid) {
      throw new functions.https.HttpsError("unauthenticated", "Firebase Authentication is required.");
    }
    try {
      await deps.requireAdmin(uid);
    } catch {
      throw new functions.https.HttpsError("permission-denied", "This account is not an admin portal user.");
    }

    const request = parseBlurCoverRequest(data);
    functions.logger.info("admin_blur_cover_start", { uid, kind: request.kind, id: request.id });

    let key: string | undefined;
    try {
      let source: Buffer;
      try {
        source = await deps.fetchImage(request.imageUrl);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new functions.https.HttpsError("failed-precondition", `The image could not be fetched: ${message}`);
      }

      let blurred: Buffer;
      try {
        blurred = await blurImage(source);
      } catch {
        throw new functions.https.HttpsError("failed-precondition", "The image could not be decoded.");
      }

      key = blurredCoverKey(request.kind, request.id, source);
      await deps.putObject({
        Bucket: BLURRED_COVERS_BUCKET,
        Key: key,
        Body: blurred,
        ContentType: "image/jpeg",
        CacheControl: BLURRED_COVER_CACHE_CONTROL,
      });
      const url = blurredCoverUrl(key);
      functions.logger.info("admin_blur_cover_success", { uid, key, bytes: blurred.length });
      return { url };
    } catch (error) {
      const detail = { uid, key, error: error instanceof Error ? error.message : String(error) };
      // A bad source picture is the admin's to fix; only storage failures are ours.
      if (error instanceof functions.https.HttpsError) {
        functions.logger.warn("admin_blur_cover_rejection", detail);
        throw error;
      }
      functions.logger.error("admin_blur_cover_failure", detail);
      throw new functions.https.HttpsError("internal", "The blurred cover could not be stored.");
    }
  };
}

/** Reads the body in chunks so an oversized or lying Content-Length cannot exhaust the function's memory. */
export async function fetchImageWithLimits(
  url: string,
  timeoutMs = FETCH_TIMEOUT_MS,
  maxBytes = MAX_IMAGE_BYTES
): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetch(url, { signal: controller.signal, redirect: "follow" });
    } catch (error) {
      throw new ImageFetchError(controller.signal.aborted ? "timed out" : (error as Error).message);
    }
    if (!response.ok || !response.body) {
      throw new ImageFetchError(`HTTP ${response.status}`);
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new ImageFetchError("image is too large");
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = response.body.getReader();
    for (;;) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch {
        throw new ImageFetchError(controller.signal.aborted ? "timed out" : "download interrupted");
      }
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ImageFetchError("image is too large");
      }
      chunks.push(result.value);
    }
    if (total === 0) {
      throw new ImageFetchError("empty response");
    }
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timer);
  }
}

let s3ClientPromise: Promise<S3Client> | undefined;

// Built once per instance; the secrets are the ones admin_upload_to_S3 signs with.
function s3Client(): Promise<S3Client> {
  if (!s3ClientPromise) {
    s3ClientPromise = Promise.all([getSecret("aws_access_key_id"), getSecret("aws_secret_access_key")])
      .then(([accessKeyId, secretAccessKey]) =>
        new S3Client({ region: BLURRED_COVERS_REGION, credentials: { accessKeyId, secretAccessKey } })
      )
      .catch((error) => {
        s3ClientPromise = undefined;
        throw error;
      });
  }
  return s3ClientPromise;
}

async function putBlurredCover(object: BlurredCoverObject): Promise<void> {
  const client = await s3Client();
  await client.send(new PutObjectCommand(object));
}

export const handleAdminBlurCover = createBlurCoverHandler({
  requireAdmin: requireAdminPortalUser,
  fetchImage: fetchImageWithLimits,
  putObject: putBlurredCover,
});
