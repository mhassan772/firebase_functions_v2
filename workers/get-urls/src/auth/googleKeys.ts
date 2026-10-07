import { importJWK, JWK } from "jose";

const JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const KV_PREFIX = "securetoken-jwk:";

/** Stops forged tokens with random key IDs from making every request call Google. */
const MIN_REFETCH_INTERVAL_MS = 60_000;

const importedKeys = new Map<string, CryptoKey>();
let lastFetchAt = 0;
let inFlightFetch: Promise<JWK[]> | null = null;

/**
 * Fetches Google's current signing keys and stores each one in KV.
 *
 * Keys are kept with no expiry, because expired tokens are accepted for as long as their account
 * is not revoked, and a token is only verifiable while the key that signed it is still known.
 */
export function refreshGoogleKeys(kv: KVNamespace): Promise<JWK[]> {
  inFlightFetch ??= fetchAndStore(kv).finally(() => {
    inFlightFetch = null;
  });
  return inFlightFetch;
}

async function fetchAndStore(kv: KVNamespace): Promise<JWK[]> {
  lastFetchAt = Date.now();
  const response = await fetch(JWKS_URL);
  if (!response.ok) {
    throw new Error(`Fetching Google signing keys failed with HTTP ${response.status}`);
  }

  const { keys } = (await response.json()) as { keys: JWK[] };
  await Promise.all(
    keys.filter((key) => key.kid).map((key) => kv.put(KV_PREFIX + key.kid, JSON.stringify(key)))
  );
  return keys;
}

/** Returns the verification key for `kid`, or null when Google never published it. */
export async function getGoogleKey(kid: string, kv: KVNamespace): Promise<CryptoKey | null> {
  const cached = importedKeys.get(kid);
  if (cached) return cached;

  let jwk = await kv.get<JWK>(KV_PREFIX + kid, "json");
  if (!jwk && Date.now() - lastFetchAt >= MIN_REFETCH_INTERVAL_MS) {
    const keys = await refreshGoogleKeys(kv);
    jwk = keys.find((key) => key.kid === kid) ?? null;
  }
  if (!jwk) return null;

  const key = (await importJWK(jwk, "RS256")) as CryptoKey;
  importedKeys.set(kid, key);
  return key;
}

export function clearGoogleKeyCacheForTests(): void {
  importedKeys.clear();
  lastFetchAt = 0;
  inFlightFetch = null;
}
