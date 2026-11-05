/**
 * The allowance ledger behind `getUrls`, kept with the Admin SDK.
 *
 * The Cloudflare Worker keeps the same documents through the REST API (`workers/get-urls/src/
 * urlGrants.ts`); both take their decision from `shared/urlPolicy.ts`, so the fallback endpoint
 * can never run a different policy from the primary.
 */
import { Timestamp } from "firebase-admin/firestore";
import { admin } from "../config/admin";
import { Settings } from "../types";
import {
  Allowance,
  decideGrants,
  DeviceState,
  GrantResult,
  LedgerState,
  RecentEntry,
  RequestedBook,
} from "../shared/urlPolicy";

export const LEDGER_COLLECTION = "url_grants";
export const LEDGER_BOOKS_SUBCOLLECTION = "books";
export const DEVICE_LEDGER_COLLECTION = "url_grants_devices";

export interface GrantTransactionInput {
  uid: string;
  deviceId?: string;
  anonymous: boolean;
  createdAtMs: number | null;
  books: RequestedBook[];
  allowance: Allowance;
  enforce: boolean;
  nowMs: number;
}

/** Issues the request's books against the ledger in one transaction and returns the decisions. */
export async function runGrantTransaction(input: GrantTransactionInput): Promise<GrantResult> {
  const db = admin.firestore();
  const ledgerRef = db.collection(LEDGER_COLLECTION).doc(input.uid);
  const uniqueGuids = [...new Set(input.books.map((book) => book.guid))];
  const bookRefs = uniqueGuids.map((guid) =>
    ledgerRef.collection(LEDGER_BOOKS_SUBCOLLECTION).doc(guid)
  );
  const deviceRef =
    input.anonymous && input.deviceId
      ? db.collection(DEVICE_LEDGER_COLLECTION).doc(input.deviceId)
      : null;
  const now = Timestamp.fromMillis(input.nowMs);

  return db.runTransaction(async (tx) => {
    const snapshots = await tx.getAll(ledgerRef, ...bookRefs, ...(deviceRef ? [deviceRef] : []));
    const ledgerDoc = snapshots[0].data() ?? {};
    const bookDocs = snapshots.slice(1, 1 + bookRefs.length);
    const deviceDoc = deviceRef ? snapshots[1 + bookRefs.length].data() ?? {} : null;

    const knownBooks = new Set<string>();
    const knownSamples = new Set<string>();
    bookDocs.forEach((snapshot, i) => {
      if (!snapshot.exists) return;
      (snapshot.data()?.kind === "samples" ? knownSamples : knownBooks).add(uniqueGuids[i]);
    });

    const ledger: LedgerState = {
      knownBooks,
      knownSamples,
      recentBooks: readRecent(ledgerDoc.recentBooks),
      recentSamples: readRecent(ledgerDoc.recentSamples),
    };
    const device: DeviceState | null = deviceDoc
      ? { recentBooks: readRecent(deviceDoc.recentBooks), recentSamples: readRecent(deviceDoc.recentSamples) }
      : null;

    const result = decideGrants({
      books: input.books,
      ledger,
      device,
      allowance: input.allowance,
      enforce: input.enforce,
      nowMs: input.nowMs,
    });

    const ledgerUpdate: Record<string, unknown> = {
      anonymous: input.anonymous,
      recentBooks: writeRecent(result.ledger.recentBooks),
      recentSamples: writeRecent(result.ledger.recentSamples),
      recentBooksCount: result.ledger.recentBooks.length,
      recentSamplesCount: result.ledger.recentSamples.length,
      updatedAt: now,
    };
    if (!ledgerDoc.firstGrantAt) ledgerUpdate.firstGrantAt = now;
    if (!ledgerDoc.createdAt && input.createdAtMs !== null) {
      ledgerUpdate.createdAt = Timestamp.fromMillis(input.createdAtMs);
    }
    if (input.deviceId) ledgerUpdate.devices = { [input.deviceId]: now };
    tx.set(ledgerRef, ledgerUpdate, { merge: true });

    for (const entry of result.newEntries) {
      tx.set(ledgerRef.collection(LEDGER_BOOKS_SUBCOLLECTION).doc(entry.guid), {
        firstAt: now,
        kind: entry.kind,
        reason: entry.reason,
      });
    }

    if (deviceRef && result.device) {
      const guestUids = { ...((deviceDoc?.guestUids as Record<string, unknown>) ?? {}), [input.uid]: now };
      tx.set(
        deviceRef,
        {
          guestUids: { [input.uid]: now },
          guestUidsCount: Object.keys(guestUids).length,
          recentBooks: writeRecent(result.device.recentBooks),
          recentSamples: writeRecent(result.device.recentSamples),
          recentBooksCount: result.device.recentBooks.length,
          recentSamplesCount: result.device.recentSamples.length,
          updatedAt: now,
        },
        { merge: true }
      );
    }

    return result;
  });
}

function readRecent(raw: unknown): RecentEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: RecentEntry[] = [];
  for (const item of raw) {
    const guid = item?.guid;
    const at = item?.at;
    if (typeof guid !== "string") continue;
    const ms = at instanceof Timestamp ? at.toMillis() : typeof at === "number" ? at : NaN;
    if (Number.isFinite(ms)) entries.push({ guid, at: ms });
  }
  return entries;
}

function writeRecent(entries: RecentEntry[]): { guid: string; at: Timestamp }[] {
  return entries.map((entry) => ({ guid: entry.guid, at: Timestamp.fromMillis(entry.at) }));
}

/** Whether `subscription_master/{uid}` says the account is premium right now. */
export async function isPremiumAccount(uid: string, nowMs: number): Promise<boolean> {
  const snapshot = await admin.firestore().collection("subscription_master").doc(uid).get();
  return masterSaysPremium(snapshot.data(), nowMs);
}

export function masterSaysPremium(master: Record<string, unknown> | undefined, nowMs: number): boolean {
  if (!master || master.active !== true) return false;
  const expiresAt = master.expiresAt;
  const expiresMs =
    expiresAt instanceof Timestamp
      ? expiresAt.toMillis()
      : typeof expiresAt === "string"
        ? Date.parse(expiresAt)
        : NaN;
  return !Number.isFinite(expiresMs) || expiresMs > nowMs;
}

/** True when the request carried a valid App Check token; any failure counts as unattested. */
export async function isAttestedRequest(appCheckHeader: string | undefined): Promise<boolean> {
  if (!appCheckHeader) return false;
  try {
    await admin.appCheck().verifyToken(appCheckHeader);
    return true;
  } catch {
    return false;
  }
}

const SETTINGS_CACHE_MS = 60_000;
let settingsCache: { at: number; settings: Settings } | null = null;

/** `settings/mantooqAppSettings`, cached per instance for a minute. */
export async function getCachedSettings(nowMs: number = Date.now()): Promise<Settings> {
  if (settingsCache && nowMs - settingsCache.at < SETTINGS_CACHE_MS) return settingsCache.settings;
  const snapshot = await admin.firestore().collection("settings").doc("mantooqAppSettings").get();
  const settings = (snapshot.data() as Settings) || {};
  settingsCache = { at: nowMs, settings };
  return settings;
}

/** Drops the cached settings; tests use it. */
export function resetSettingsCache(): void {
  settingsCache = null;
}
