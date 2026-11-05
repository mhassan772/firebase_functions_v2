/**
 * Signs audio file URLs so the CDNs can refuse links that expired or were made up.
 *
 * Runtime-neutral: it uses WebCrypto through `globalThis.crypto`, which Node 22 and Cloudflare
 * Workers both provide. Two formats, one per CDN:
 *
 * - Cloudflare (`books.good-storage.click`), checked by a WAF rule with
 *   `is_timed_hmac_valid_v0(secret, http.request.uri, ttl, http.request.timestamp.sec, 8, 's')`:
 *   the MAC covers the uri before `&verify=` followed directly by the 10-digit issue time, and the
 *   `verify` parameter must be last. The `'s'` flag means URL-safe base64 with no padding.
 * - Bunny (`good-storage.b-cdn.net`), checked by the zone's advanced token authentication:
 *   `HS256-` + base64url(HMAC(secret, path + expires + sortedOtherParams)).
 *
 * The `u` parameter is a short hash of the uid, so a leaked link names the account it was issued
 * to, and `k` is the key version, so a secret can rotate without breaking links already issued.
 */

export type Cdn = "cloudflare" | "bunny";

export interface SigningSecrets {
  cloudflare: string;
  bunny: string;
  keyVersion: string;
}

export interface SigningContext {
  /** First 8 hex characters of SHA-256 of the uid; see [uidHash]. */
  uidHash: string;
  /** Epoch seconds the link was issued; the Cloudflare rule counts its TTL from it. */
  issuedAtSec: number;
  ttlSec: number;
}

interface SubtleLike {
  importKey(
    format: "raw",
    keyData: Uint8Array,
    algorithm: { name: string; hash: string },
    extractable: boolean,
    keyUsages: string[]
  ): Promise<unknown>;
  sign(algorithm: string, key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
  digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer>;
}

function subtle(): SubtleLike {
  const crypto = (globalThis as { crypto?: { subtle?: SubtleLike } }).crypto;
  if (!crypto?.subtle) {
    throw new Error("WebCrypto is not available in this runtime");
  }
  return crypto.subtle;
}

const encoder = new TextEncoder();

async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const key = await subtle().importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(await subtle().sign("HMAC", key, encoder.encode(message)));
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64Url(bytes: Uint8Array): string {
  return base64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The first 8 hex characters of SHA-256(uid): enough to tell accounts apart, not to reverse. */
export async function uidHash(uid: string): Promise<string> {
  const digest = new Uint8Array(await subtle().digest("SHA-256", encoder.encode(uid)));
  return [...digest.slice(0, 4)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Returns the signed URL for [path] (no leading slash) on [publicDomain].
 *
 * The CDN is chosen by the domain's host: `b-cdn.net` hosts are Bunny, anything else Cloudflare.
 */
export async function signAudioUrl(
  publicDomain: string,
  path: string,
  context: SigningContext,
  secrets: SigningSecrets
): Promise<string> {
  const cdn: Cdn = /\.b-cdn\.net$/i.test(new URL(publicDomain).host) ? "bunny" : "cloudflare";
  const cleanPath = "/" + path.replace(/^\/+/, "");
  const base = publicDomain.replace(/\/+$/, "");
  const params = { k: secrets.keyVersion, u: context.uidHash };

  if (cdn === "cloudflare") {
    const query = `u=${params.u}&k=${params.k}`;
    const message = `${cleanPath}?${query}${context.issuedAtSec}`;
    const mac = base64Url(await hmacSha256(secrets.cloudflare, message));
    return `${base}${cleanPath}?${query}&verify=${context.issuedAtSec}-${mac}`;
  }

  const expires = context.issuedAtSec + context.ttlSec;
  const signingData = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key as keyof typeof params]}`)
    .join("&");
  const mac = base64Url(await hmacSha256(secrets.bunny, `${cleanPath}${expires}${signingData}`));
  return `${base}${cleanPath}?u=${params.u}&k=${params.k}&token=HS256-${mac}&expires=${expires}`;
}
