import {
  Allowance,
  decideGrants,
  DeviceState,
  GrantResult,
  LedgerState,
  RecentEntry,
  RequestedBook,
} from "../../../src/shared/urlPolicy";
import { Env } from "./env";
import {
  batchGet,
  decodeFields,
  documentName,
  encodeFields,
  EncodableValue,
  FirestoreFields,
  FirestoreTimestamp,
  FirestoreWrite,
  timestampMillis,
} from "./google/firestore";
import { runTransaction } from "./google/transaction";

/**
 * The allowance ledger behind the Worker, kept through the Firestore REST API.
 *
 * The Firebase `getUrls` function keeps the same documents with the Admin SDK
 * (`src/services/urlGrantsLedger.ts`); the shapes must stay identical.
 */
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

export async function runGrantTransaction(env: Env, input: GrantTransactionInput): Promise<GrantResult> {
  const ledgerName = documentName(env, `url_grants/${input.uid}`);
  const uniqueGuids = [...new Set(input.books.map((book) => book.guid))];
  const bookNames = uniqueGuids.map((guid) => documentName(env, `url_grants/${input.uid}/books/${guid}`));
  const deviceName =
    input.anonymous && input.deviceId ? documentName(env, `url_grants_devices/${input.deviceId}`) : null;
  const now = new FirestoreTimestamp(input.nowMs);

  return runTransaction(env, async (transaction) => {
    const docs = await batchGet(env, [ledgerName, ...bookNames, ...(deviceName ? [deviceName] : [])], transaction);
    const ledgerDoc = decodeFields(docs.get(ledgerName) ?? {});
    const deviceDoc = deviceName ? decodeFields(docs.get(deviceName) ?? {}) : null;

    const knownBooks = new Set<string>();
    const knownSamples = new Set<string>();
    uniqueGuids.forEach((guid, i) => {
      const fields = docs.get(bookNames[i]);
      if (!fields) return;
      (decodeFields(fields).kind === "samples" ? knownSamples : knownBooks).add(guid);
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

    const writes: FirestoreWrite[] = [];

    // Full-document writes, so the values read above are carried forward by hand.
    const devices = { ...asMap(ledgerDoc.devices) };
    if (input.deviceId) devices[input.deviceId] = now;
    const ledgerFields: Record<string, EncodableValue> = {
      ...carry(ledgerDoc, ["createdAt", "firstGrantAt"]),
      anonymous: input.anonymous,
      recentBooks: writeRecent(result.ledger.recentBooks),
      recentSamples: writeRecent(result.ledger.recentSamples),
      recentBooksCount: result.ledger.recentBooks.length,
      recentSamplesCount: result.ledger.recentSamples.length,
      devices,
      updatedAt: now,
    };
    if (!ledgerFields.firstGrantAt) ledgerFields.firstGrantAt = now;
    if (!ledgerFields.createdAt && input.createdAtMs !== null) {
      ledgerFields.createdAt = new FirestoreTimestamp(input.createdAtMs);
    }
    writes.push({ update: { name: ledgerName, fields: encodeFields(ledgerFields) } });

    for (const entry of result.newEntries) {
      writes.push({
        update: {
          name: documentName(env, `url_grants/${input.uid}/books/${entry.guid}`),
          fields: encodeFields({ firstAt: now, kind: entry.kind, reason: entry.reason }),
        },
      });
    }

    if (deviceName && result.device) {
      const guestUids = { ...asMap(deviceDoc?.guestUids), [input.uid]: now };
      writes.push({
        update: {
          name: deviceName,
          fields: encodeFields({
            guestUids,
            guestUidsCount: Object.keys(guestUids).length,
            recentBooks: writeRecent(result.device.recentBooks),
            recentSamples: writeRecent(result.device.recentSamples),
            recentBooksCount: result.device.recentBooks.length,
            recentSamplesCount: result.device.recentSamples.length,
            updatedAt: now,
          }),
        },
      });
    }

    return { writes, result };
  });
}

function readRecent(raw: unknown): RecentEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: RecentEntry[] = [];
  for (const item of raw as { guid?: unknown; at?: unknown }[]) {
    const at = timestampMillis(item?.at);
    if (typeof item?.guid === "string" && at !== null) entries.push({ guid: item.guid, at });
  }
  return entries;
}

function writeRecent(entries: RecentEntry[]): EncodableValue[] {
  return entries.map((entry) => ({ guid: entry.guid, at: new FirestoreTimestamp(entry.at) }));
}

/** Decoded timestamp strings become timestamps again when written back. */
function asMap(raw: unknown): Record<string, EncodableValue> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result: Record<string, EncodableValue> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const millis = timestampMillis(value);
    result[key] = millis !== null ? new FirestoreTimestamp(millis) : (value as EncodableValue);
  }
  return result;
}

function carry(doc: Record<string, unknown>, keys: string[]): Record<string, EncodableValue> {
  const result: Record<string, EncodableValue> = {};
  for (const key of keys) {
    const millis = timestampMillis(doc[key]);
    if (millis !== null) result[key] = new FirestoreTimestamp(millis);
  }
  return result;
}

/** Whether `subscription_master/{uid}` says the account is premium right now. */
export function masterSaysPremium(fields: FirestoreFields | null | undefined, nowMs: number): boolean {
  if (!fields) return false;
  const master = decodeFields(fields);
  if (master.active !== true) return false;
  const expiresMs = timestampMillis(master.expiresAt);
  return expiresMs === null || expiresMs > nowMs;
}
