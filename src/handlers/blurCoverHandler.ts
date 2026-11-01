import * as crypto from "crypto";
import * as functions from "firebase-functions";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { requirePortalRole } from "../utils/adminRole";
import { getSecret } from "../utils/secrets";

export type BlurCoverKind = "podcast" | "episode" | "book";

export const BLURRED_COVERS_BUCKET = "mantook-book-images-pdf";
export const BLURRED_COVERS_REGION = "eu-west-1";
export const BLURRED_COVERS_PUBLIC_BASE = "https://images.mantooq.com";
export const BLURRED_COVER_CACHE_CONTROL = "public, max-age=31536000, immutable";
export const BLUR_MAX_DIMENSION = 600;
export const BLUR_SIGMA = 30;
export const BLUR_JPEG_QUALITY = 70;
/** Areas leave most of the picture sharp, so they need a larger, cleaner copy than an all-over blur. */
export const AREAS_MAX_DIMENSION = 1200;
export const AREAS_JPEG_QUALITY = 82;
/**
 * Blur strength and pixel block size at the default strength, as fractions of the copy's longer side, so
 * they look the same at any size. Other strengths scale both in proportion.
 */
export const AREAS_BLUR_SIGMA_RATIO = 0.05;
export const PIXELATE_BLOCK_RATIO = 1 / 24;
/** How strongly the picture is hidden, 1 to 10; the default is the look an all-over blur always had. */
export const MIN_STRENGTH = 1;
export const MAX_STRENGTH = 10;
export const DEFAULT_STRENGTH = 5;
/** A blurred area's edge fades out over this fraction of the longer side, outside the drawn shape. */
export const BLUR_FEATHER_RATIO = 0.01;
export const MAX_REGIONS = 20;
/** The smallest width or height of an area, as a fraction of the picture. */
export const MIN_REGION_SIZE = 0.005;
/**
 * The largest width or height of a tilted area, as a fraction of the picture. A tilted area may reach past
 * the edges, where it is cut off, so it can lie along a picture's diagonal or cover a corner.
 */
export const MAX_TILTED_REGION_SIZE = 2;
export const FETCH_TIMEOUT_MS = 15_000;
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

const KINDS = new Set<BlurCoverKind>(["podcast", "episode", "book"]);
// Podcast Index ids are numeric; book GUIDs are restricted to characters that are safe in an S3 key.
const NUMERIC_ID = /^\d{1,20}$/;
const BOOK_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_URL_LENGTH = 4096;
// Rounding slack for an area the portal clamped to the picture's edge.
const EDGE_TOLERANCE = 1e-6;
// A tilted area's centre is the sum of two numbers rounded to four decimals, so it may be off by that much.
const CENTRE_TOLERANCE = 1e-4;

export type BlurEffect = "blur" | "pixelate";
export type BlurRegionShape = "rect" | "ellipse";

/**
 * An area to hide, in fractions of the picture's width and height, so it fits the picture at any size.
 *
 * The box is the shape before it is tilted; the tilt turns it clockwise about its centre. An upright box
 * lies inside the picture. A tilted one only has its centre inside, since its corners may need to reach
 * past the edges for the shape to cover what is at the edge.
 */
export interface BlurRegion {
  shape: BlurRegionShape;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Whole degrees clockwise, -89 to 90; 0 is upright. */
  rotation: number;
}

export interface BlurCoverRequest {
  kind: BlurCoverKind;
  id: string;
  imageUrl: string;
  effect: BlurEffect;
  /** MIN_STRENGTH to MAX_STRENGTH. */
  strength: number;
  /** Empty for the whole picture. */
  regions: BlurRegion[];
  /** Returns the result instead of storing it. */
  preview: boolean;
}

export interface BlurCoverResult {
  /** The stored copy; missing for a preview. */
  url?: string;
  /** The copy as a data URL; only for a preview. */
  preview?: string;
  /** Identifies the source picture's bytes, so the portal can tell when an original changed under its areas. */
  sourceHash: string;
  /** The strength the copy was made at, so the portal can tell this callable applied strength and tilt. */
  strength: number;
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
  const { kind, id, imageUrl, effect, strength, regions, preview } = data as Record<string, unknown>;

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

  if (effect !== undefined && effect !== "blur" && effect !== "pixelate") {
    throw invalid("effect must be blur or pixelate.");
  }
  if (
    strength !== undefined &&
    (typeof strength !== "number" || !Number.isInteger(strength) || strength < MIN_STRENGTH || strength > MAX_STRENGTH)
  ) {
    throw invalid(`strength must be a whole number from ${MIN_STRENGTH} to ${MAX_STRENGTH}.`);
  }
  if (preview !== undefined && typeof preview !== "boolean") {
    throw invalid("preview must be true or false.");
  }

  return {
    kind: kind as BlurCoverKind,
    id,
    imageUrl,
    effect: effect ?? "blur",
    strength: (strength as number | undefined) ?? DEFAULT_STRENGTH,
    regions: parseRegions(regions),
    preview: preview ?? false,
  };
}

// Four decimals is a tenth of a pixel on a 1200-pixel copy, and keeps the key stable for the same areas.
const round4 = (value: number) => Math.round(value * 10_000) / 10_000;

/** Both shapes look the same turned half a turn, so every tilt folds into -89 to 90 whole degrees. */
function normalizeRotation(degrees: number): number {
  const folded = ((Math.round(degrees) % 180) + 180) % 180;
  return folded > 90 ? folded - 180 : folded;
}

function parseRegions(value: unknown): BlurRegion[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw invalid("regions must be a list.");
  if (value.length > MAX_REGIONS) throw invalid(`At most ${MAX_REGIONS} areas can be hidden.`);
  return value.map((raw, index) => {
    const where = `Area ${index + 1}`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw invalid(`${where} must be an object.`);
    const { shape, x, y, w, h, rotation } = raw as Record<string, unknown>;
    if (shape !== "rect" && shape !== "ellipse") throw invalid(`${where}: shape must be rect or ellipse.`);
    if (rotation !== undefined && (typeof rotation !== "number" || !Number.isFinite(rotation) || Math.abs(rotation) > 360)) {
      throw invalid(`${where}: rotation must be a number of degrees.`);
    }
    const numbers = [x, y, w, h];
    if (!numbers.every((n) => typeof n === "number" && Number.isFinite(n))) {
      throw invalid(`${where}: x, y, w and h must be numbers.`);
    }
    const [nx, ny, nw, nh] = numbers as number[];
    const tilt = normalizeRotation((rotation as number | undefined) ?? 0);
    if (nw < MIN_REGION_SIZE || nh < MIN_REGION_SIZE) throw invalid(`${where} must have a size.`);
    if (tilt !== 0) {
      if (nw > MAX_TILTED_REGION_SIZE || nh > MAX_TILTED_REGION_SIZE) {
        throw invalid(`${where} must be at most ${MAX_TILTED_REGION_SIZE} times the picture's size.`);
      }
      const cx = nx + nw / 2;
      const cy = ny + nh / 2;
      if (cx < -CENTRE_TOLERANCE || cx > 1 + CENTRE_TOLERANCE || cy < -CENTRE_TOLERANCE || cy > 1 + CENTRE_TOLERANCE) {
        throw invalid(`${where} must have its centre inside the picture.`);
      }
      return { shape, x: round4(nx), y: round4(ny), w: round4(nw), h: round4(nh), rotation: tilt };
    }
    if (nx < 0 || ny < 0) throw invalid(`${where} must start inside the picture.`);
    if (nx + nw > 1 + EDGE_TOLERANCE || ny + nh > 1 + EDGE_TOLERANCE) {
      throw invalid(`${where} must end inside the picture.`);
    }
    return {
      shape,
      x: round4(nx),
      y: round4(ny),
      w: round4(Math.min(nw, 1 - nx)),
      h: round4(Math.min(nh, 1 - ny)),
      rotation: 0,
    };
  });
}

export type BlurOptions = Pick<BlurCoverRequest, "effect" | "strength" | "regions">;

/** Whether the request is the original all-over blur, which keeps its original size, format and key. */
export function isWholePictureBlur(request: BlurOptions): boolean {
  return request.effect === "blur" && request.strength === DEFAULT_STRENGTH && request.regions.length === 0;
}

export function sourceHash(source: Buffer): string {
  return crypto.createHash("sha1").update(source).digest("hex").slice(0, 12);
}

/**
 * The key carries a hash of the source picture's bytes, so a changed picture gets a new immutable object
 * instead of a stale cached one, even when it was replaced in place under the same URL, as book covers are.
 *
 * Any other effect or set of areas is hashed in as well: copies are cached for a year, so an edited
 * blur must never reuse an earlier copy's URL. An all-over blur keeps the original key, so it is the
 * same object it always was.
 */
export function blurredCoverKey(
  kind: BlurCoverKind,
  id: string,
  source: Buffer,
  options: BlurOptions = { effect: "blur", strength: DEFAULT_STRENGTH, regions: [] },
  extension: "jpg" | "png" = "jpg"
): string {
  if (isWholePictureBlur(options)) {
    return `images/blurred/${kind}/${id}/${sourceHash(source)}.${extension}`;
  }
  // Defaults are left out, so a copy keeps the key it had before strength and tilt existed.
  const spec = JSON.stringify({
    effect: options.effect,
    ...(options.strength !== DEFAULT_STRENGTH && { strength: options.strength }),
    regions: options.regions.map(({ shape, x, y, w, h, rotation }) => (rotation ? [shape, x, y, w, h, rotation] : [shape, x, y, w, h])),
  });
  const version = crypto.createHash("sha1").update(source).update("\n").update(spec).digest("hex").slice(0, 12);
  return `images/blurred/${kind}/${id}/${version}.${extension}`;
}

export function blurredCoverUrl(key: string): string {
  return `${BLURRED_COVERS_PUBLIC_BASE}/${key}`;
}

/**
 * Blurs and shrinks a whole cover.
 *
 * sharp is loaded here rather than at the top: index.js loads every handler in
 * every function's cold start, and only this callable needs the native library.
 */
export async function blurImage(input: Buffer): Promise<Buffer> {
  const { default: sharp } = await import("sharp");
  return sharp(input, { failOn: "error" })
    .rotate()
    .resize(BLUR_MAX_DIMENSION, BLUR_MAX_DIMENSION, { fit: "inside", withoutEnlargement: true })
    .blur(BLUR_SIGMA)
    .jpeg({ quality: BLUR_JPEG_QUALITY })
    .toBuffer();
}

export interface RenderedCover {
  body: Buffer;
  contentType: "image/jpeg" | "image/png";
  extension: "jpg" | "png";
}

/** The SVG mask of the areas: white where the effect shows, black where the original does. */
function regionsMask(regions: BlurRegion[], width: number, height: number, grow: number): string {
  const shapes = regions.map(({ shape, x, y, w, h, rotation }) => {
    const left = x * width - grow;
    const top = y * height - grow;
    const rw = w * width + 2 * grow;
    const rh = h * height + 2 * grow;
    const cx = left + rw / 2;
    const cy = top + rh / 2;
    // Turned in pixels about the centre, so a tilt keeps its angle on a picture of any proportions.
    const tilt = rotation ? ` transform="rotate(${rotation} ${cx} ${cy})"` : "";
    return shape === "ellipse"
      ? `<ellipse cx="${cx}" cy="${cy}" rx="${rw / 2}" ry="${rh / 2}"${tilt} fill="#fff"/>`
      : `<rect x="${left}" y="${top}" width="${rw}" height="${rh}"${tilt} fill="#fff"/>`;
  });
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<rect width="${width}" height="${height}" fill="#000"/>${shapes.join("")}</svg>`
  );
}

/**
 * Applies the effect to the whole picture or only to its areas.
 *
 * An area is cut from a fully blurred or pixelated copy and laid over the original, so a blurred area
 * draws on its surroundings the way a whole blur does and pixel blocks line up across areas. A blurred
 * area fades out just outside its outline, so the area itself stays fully hidden. A picture with
 * transparency stays PNG: as JPEG its transparent parts would turn black.
 */
export async function renderCover(input: Buffer, options: BlurOptions): Promise<RenderedCover> {
  if (isWholePictureBlur(options)) {
    return { body: await blurImage(input), contentType: "image/jpeg", extension: "jpg" };
  }
  const { default: sharp } = await import("sharp");
  const { data: original, info } = await sharp(input, { failOn: "error" })
    .rotate()
    .resize(AREAS_MAX_DIMENSION, AREAS_MAX_DIMENSION, { fit: "inside", withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const raw = { raw: { width, height, channels: 4 as const } };
  const longer = Math.max(width, height);
  const scale = options.strength / DEFAULT_STRENGTH;

  let effected: Buffer;
  if (options.effect === "pixelate") {
    const block = Math.max(4, Math.round(longer * PIXELATE_BLOCK_RATIO * scale));
    const smallWidth = Math.max(1, Math.ceil(width / block));
    const smallHeight = Math.max(1, Math.ceil(height / block));
    const small = await sharp(original, raw).resize(smallWidth, smallHeight, { fit: "fill" }).raw().toBuffer();
    effected = await sharp(small, { raw: { width: smallWidth, height: smallHeight, channels: 4 } })
      .resize(width, height, { fit: "fill", kernel: "nearest" })
      .raw()
      .toBuffer();
  } else {
    effected = await sharp(original, raw).blur(Math.max(1, longer * AREAS_BLUR_SIGMA_RATIO * scale)).raw().toBuffer();
  }

  let pixels = effected;
  if (options.regions.length > 0) {
    // Pixel blocks keep hard edges; a blur's edge is grown and then softened, so the fade lies outside the shape.
    const feather = options.effect === "blur" ? Math.max(1, Math.round(longer * BLUR_FEATHER_RATIO)) : 0;
    let mask = sharp(Buffer.from(regionsMask(options.regions, width, height, feather)));
    if (feather > 0) mask = mask.blur(feather / 2);
    const coverage = await mask.flatten({ background: "#000" }).extractChannel(0).raw().toBuffer();
    pixels = Buffer.alloc(original.length);
    for (let i = 0, p = 0; p < coverage.length; p++, i += 4) {
      const m = coverage[p];
      for (let c = 0; c < 4; c++) {
        pixels[i + c] = Math.round((original[i + c] * (255 - m) + effected[i + c] * m) / 255);
      }
    }
  }

  let hasTransparency = false;
  for (let i = 3; i < pixels.length; i += 4) {
    if (pixels[i] < 255) {
      hasTransparency = true;
      break;
    }
  }
  const image = sharp(pixels, raw);
  return hasTransparency
    ? { body: await image.png().toBuffer(), contentType: "image/png", extension: "png" }
    : { body: await image.removeAlpha().jpeg({ quality: AREAS_JPEG_QUALITY }).toBuffer(), contentType: "image/jpeg", extension: "jpg" };
}

export function createBlurCoverHandler(deps: BlurCoverDeps) {
  return async (
    data: unknown,
    context: functions.https.CallableContext
  ): Promise<BlurCoverResult> => {
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
    functions.logger.info("admin_blur_cover_start", {
      uid,
      kind: request.kind,
      id: request.id,
      effect: request.effect,
      strength: request.strength,
      regions: request.regions.length,
      preview: request.preview,
    });

    let key: string | undefined;
    try {
      let source: Buffer;
      try {
        source = await deps.fetchImage(request.imageUrl);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new functions.https.HttpsError("failed-precondition", `The image could not be fetched: ${message}`);
      }

      let rendered: RenderedCover;
      try {
        rendered = await renderCover(source, request);
      } catch {
        throw new functions.https.HttpsError("failed-precondition", "The image could not be decoded.");
      }

      if (request.preview) {
        functions.logger.info("admin_blur_cover_preview", { uid, bytes: rendered.body.length });
        return {
          preview: `data:${rendered.contentType};base64,${rendered.body.toString("base64")}`,
          sourceHash: sourceHash(source),
          strength: request.strength,
        };
      }

      key = blurredCoverKey(request.kind, request.id, source, request, rendered.extension);
      await deps.putObject({
        Bucket: BLURRED_COVERS_BUCKET,
        Key: key,
        Body: rendered.body,
        ContentType: rendered.contentType,
        CacheControl: BLURRED_COVER_CACHE_CONTROL,
      });
      const url = blurredCoverUrl(key);
      functions.logger.info("admin_blur_cover_success", { uid, key, bytes: rendered.body.length });
      return { url, sourceHash: sourceHash(source), strength: request.strength };
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
  // Content managers blur covers; admins pass too, which covers ContentReports.
  requireAdmin: async (uid: string) => {
    await requirePortalRole(uid, "content-manager");
  },
  fetchImage: fetchImageWithLimits,
  putObject: putBlurredCover,
});
