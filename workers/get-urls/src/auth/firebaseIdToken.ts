import { compactVerify, decodeProtectedHeader } from "jose";
import { Env } from "../env";
import { getGoogleKey } from "./googleKeys";

const CLOCK_SKEW_SECONDS = 300;

export class AuthError extends Error {}

export interface VerifiedToken {
  uid: string;
  /** Seconds since the epoch, compared with the account's `validSince` to detect revocation. */
  issuedAt: number;
}

/**
 * Verifies a Firebase ID token the way the Admin SDK does, except that expiry is not enforced.
 *
 * Users who cannot reach Google cannot refresh their token, so they keep sending the last one for
 * as long as they stay blocked. A token stays usable until its account is deleted, disabled or has
 * its sessions revoked, which the caller must check before trusting the result.
 */
export async function verifyFirebaseIdToken(
  token: string,
  env: Env,
  now: Date = new Date()
): Promise<VerifiedToken> {
  const projectId = env.FIREBASE_PROJECT_ID;
  const nowSeconds = Math.floor(now.getTime() / 1000);

  let header;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    throw new AuthError("Malformed token.");
  }
  if (header.alg !== "RS256" || !header.kid) {
    throw new AuthError("Token has an unexpected algorithm or no key ID.");
  }

  const key = await getGoogleKey(header.kid, env.GOOGLE_KEYS);
  if (!key) {
    throw new AuthError("Token was not signed by a known Google key.");
  }

  let payload: Record<string, unknown>;
  try {
    const verified = await compactVerify(token, key, { algorithms: ["RS256"] });
    payload = JSON.parse(new TextDecoder().decode(verified.payload));
  } catch (error) {
    throw new AuthError(error instanceof Error ? error.message : "Invalid token.");
  }

  const { iss, aud, sub, iat, exp } = payload;
  const authTime = payload.auth_time;
  if (iss !== `https://securetoken.google.com/${projectId}`) {
    throw new AuthError("Token has an unexpected issuer.");
  }
  if (aud !== projectId) {
    throw new AuthError("Token has an unexpected audience.");
  }
  if (typeof sub !== "string" || sub.length === 0 || sub.length > 128) {
    throw new AuthError("Token has no valid subject.");
  }
  if (typeof iat !== "number" || iat > nowSeconds + CLOCK_SKEW_SECONDS) {
    throw new AuthError("Token was issued in the future.");
  }
  if (typeof authTime !== "number" || authTime > nowSeconds + CLOCK_SKEW_SECONDS) {
    throw new AuthError("Token has an invalid auth_time.");
  }
  // Every Firebase ID token has an expiry; one without it was not issued by Firebase Auth.
  if (typeof exp !== "number") {
    throw new AuthError("Token has no expiry.");
  }

  return { uid: sub, issuedAt: iat };
}
