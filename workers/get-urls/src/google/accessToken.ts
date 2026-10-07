import { importPKCS8, SignJWT } from "jose";
import { Env } from "../env";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

let cached: { token: string; expiresAt: number } | null = null;
let inFlight: Promise<string> | null = null;

/** Returns an OAuth access token for the service account, reused for the life of the isolate. */
export function getGoogleAccessToken(env: Env): Promise<string> {
  if (cached && cached.expiresAt - REFRESH_MARGIN_MS > Date.now()) {
    return Promise.resolve(cached.token);
  }
  inFlight ??= mintAccessToken(env).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function mintAccessToken(env: Env): Promise<string> {
  const account = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT) as ServiceAccount;
  const key = await importPKCS8(account.private_key, "RS256");
  const nowSeconds = Math.floor(Date.now() / 1000);

  const assertion = await new SignJWT({ scope: SCOPE })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(account.client_email)
    .setAudience(TOKEN_URL)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + 3600)
    .sign(key);

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!response.ok) {
    throw new Error(`Google token exchange failed with HTTP ${response.status}`);
  }

  const { access_token, expires_in } = (await response.json()) as {
    access_token: string;
    expires_in: number;
  };
  cached = { token: access_token, expiresAt: Date.now() + expires_in * 1000 };
  return access_token;
}

export function clearAccessTokenCacheForTests(): void {
  cached = null;
  inFlight = null;
}
