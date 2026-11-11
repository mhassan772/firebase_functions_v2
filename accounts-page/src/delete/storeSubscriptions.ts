/// Store subscriptions that keep renewing after the account is gone, read from
/// `subscription_master/{uid}` through the Firestore REST API (no Firestore SDK).

export type Store = "apple" | "google";

/// The cancel page of each store, for whichever account is signed in to the store.
export const STORE_SUBSCRIPTION_LINKS: Readonly<Record<Store, string>> = {
  apple: "https://apps.apple.com/account/subscriptions",
  google: "https://play.google.com/store/account/subscriptions",
};

const FIRESTORE_REST_ORIGIN = "https://firestore.googleapis.com";

type RestValue = Record<string, unknown>;

function field(fields: unknown, name: string): RestValue | undefined {
  if (!fields || typeof fields !== "object") return undefined;
  const value = (fields as Record<string, unknown>)[name];
  return value && typeof value === "object" ? (value as RestValue) : undefined;
}

/// Stores with a row that is not revoked, still runs, and renews by itself, in a fixed order.
///
/// Rows mirror the backend's `sources[]`: `platform`, `environment`, `status`, `expiresAt` and an
/// optional `autoRenewing`. Anything malformed counts as no row, which leaves the page's general text.
export function renewingStores(document: unknown, nowMs: number): Store[] {
  const fields = field(document, "fields");
  const values = field(field(fields, "sources"), "arrayValue")?.values;
  if (!Array.isArray(values)) return [];
  const found = new Set<Store>();
  for (const value of values) {
    const row = field(field(value, "mapValue"), "fields");
    const platform = field(row, "platform")?.stringValue;
    if (platform !== "apple" && platform !== "google") continue;
    if (field(row, "status")?.stringValue === "revoked") continue;
    if (field(row, "autoRenewing")?.booleanValue !== true) continue;
    const expiresAt = field(row, "expiresAt")?.timestampValue;
    const expiresMs = typeof expiresAt === "string" ? Date.parse(expiresAt) : NaN;
    if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) continue;
    found.add(platform);
  }
  return (["apple", "google"] as const).filter((store) => found.has(store));
}

/// Reads the owner's master document once; any failure means "nothing specific to say".
export async function fetchRenewingStores(options: {
  projectId: string;
  uid: string;
  idToken: string;
  /// Firestore emulator URL in local runs.
  emulator?: string;
  now?: () => number;
}): Promise<Store[]> {
  const origin = options.emulator ?? FIRESTORE_REST_ORIGIN;
  const path = `/v1/projects/${encodeURIComponent(options.projectId)}/databases/(default)/documents/subscription_master/${encodeURIComponent(options.uid)}`;
  try {
    const response = await fetch(`${origin}${path}`, {
      headers: { Authorization: `Bearer ${options.idToken}` },
      cache: "no-store",
    });
    if (!response.ok) return [];
    return renewingStores(await response.json(), (options.now ?? Date.now)());
  } catch {
    return [];
  }
}
