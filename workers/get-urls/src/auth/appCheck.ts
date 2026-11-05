import { createRemoteJWKSet, jwtVerify } from "jose";
import { Env } from "../env";

const APP_CHECK_JWKS = "https://firebaseappcheck.googleapis.com/v1/jwks";

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

/** Drops the cached key set; tests use it. */
export function resetAppCheckKeys(): void {
  jwks = null;
}

/**
 * Whether the request carried a valid Firebase App Check token.
 *
 * The token only raises the allowance, so any failure counts as "no token": a device that cannot
 * reach Google never has one, and must still be served.
 */
export async function isAttestedRequest(request: Request, env: Env): Promise<boolean> {
  const token = request.headers.get("X-Firebase-AppCheck");
  if (!token) return false;
  try {
    jwks ??= createRemoteJWKSet(new URL(APP_CHECK_JWKS));
    await jwtVerify(token, jwks, {
      algorithms: ["RS256"],
      issuer: `https://firebaseappcheck.googleapis.com/${env.FIREBASE_PROJECT_NUMBER}`,
      audience: `projects/${env.FIREBASE_PROJECT_NUMBER}`,
    });
    return true;
  } catch {
    return false;
  }
}
