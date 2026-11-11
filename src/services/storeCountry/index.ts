import { DocumentData, Firestore, Timestamp } from "firebase-admin/firestore";
import { toAlpha2 } from "../../utils/countryCodes";
import { SUBSCRIPTION_STATE_COLLECTION, stateDocumentId } from "../subscriptions/persistence";

/** Server-only: Firestore rules have no entry for it, so the catch-all deny covers clients. */
export const USER_STORE_COUNTRY_COLLECTION = "user_store_country";

/** The pricing config `knownCountries` reads its switch from. It may not exist. */
export const WEB_PRICING_CONFIG_PATH = { collection: "web_pricing", doc: "config" } as const;

export const STORE_COUNTRY_SOURCES = ["apple_storefront", "play_billing", "sim"] as const;
export type StoreCountrySource = (typeof STORE_COUNTRY_SOURCES)[number];

export const STORE_COUNTRY_HISTORY_LIMIT = 5;

/** An unchanged report refreshes `lastReportAt` at most this often, so a daily launch costs one write. */
export const LAST_REPORT_REFRESH_MS = 24 * 60 * 60 * 1000;

/** One accepted call, already validated. */
export interface StoreCountryReport {
  /** Two-letter, upper case. */
  country: string;
  /** As sent, upper-cased. */
  raw: string;
  source: StoreCountrySource;
  attested: boolean;
}

export interface StoreCountryHistoryEntry {
  country: string;
  source: StoreCountrySource;
  attested: boolean;
  at: Date;
}

export interface StoreCountryDocument {
  country: string;
  raw: string;
  source: StoreCountrySource;
  attested: boolean;
  firstReportedAt: Date;
  updatedAt: Date;
  lastReportAt: Date;
  /** Newest last. */
  history: StoreCountryHistoryEntry[];
}

export type StoreCountryDecision =
  | { write: false }
  | { write: true; document: StoreCountryDocument; replaced: boolean };

/**
 * Applies the replacement rule to one report.
 *
 * An attested report always wins, so a forged unattested call cannot displace evidence that came
 * with App Check; it is still kept in the history for review. When nothing would change but
 * `lastReportAt`, the write is skipped unless the stored time is more than a day old, so an app
 * that reports on every launch costs at most one write a day.
 */
export function nextStoreCountryDocument(
  stored: StoreCountryDocument | undefined,
  report: StoreCountryReport,
  now: Date
): StoreCountryDecision {
  const entry: StoreCountryHistoryEntry = {
    country: report.country,
    source: report.source,
    attested: report.attested,
    at: now,
  };
  if (!stored) {
    return {
      write: true,
      replaced: true,
      document: {
        country: report.country,
        raw: report.raw,
        source: report.source,
        attested: report.attested,
        firstReportedAt: now,
        updatedAt: now,
        lastReportAt: now,
        history: [entry],
      },
    };
  }

  const identical = sameEvidence(stored, report);
  const replaces = !identical && (report.attested || !stored.attested);
  // An identical report never touches the history, even when the newest entry is an unattested
  // report that did not replace the current evidence.
  const previous = stored.history[stored.history.length - 1];
  const history = identical || (previous && sameEvidence(previous, report))
    ? stored.history
    : [...stored.history, entry].slice(-STORE_COUNTRY_HISTORY_LIMIT);

  if (!replaces && history === stored.history) {
    if (now.getTime() - stored.lastReportAt.getTime() <= LAST_REPORT_REFRESH_MS) {
      return { write: false };
    }
    return { write: true, replaced: false, document: { ...stored, lastReportAt: now } };
  }

  const document: StoreCountryDocument = replaces
    ? {
      ...stored,
      country: report.country,
      raw: report.raw,
      source: report.source,
      attested: report.attested,
      updatedAt: now,
      lastReportAt: now,
      history,
    }
    : { ...stored, lastReportAt: now, history };
  return { write: true, replaced: replaces, document };
}

function sameEvidence(
  a: { country: string; source: string; attested: boolean },
  b: { country: string; source: string; attested: boolean }
): boolean {
  return a.country === b.country && a.source === b.source && a.attested === b.attested;
}

export interface KnownCountries {
  /** The current app report's country, only when it counts as pricing evidence. */
  appReport?: string;
  /** Distinct countries saved on the account's production store slots, Apple first. */
  storePurchase: string[];
}

/**
 * Whether an app report counts as pricing evidence.
 *
 * An unattested `sim` report counts only behind the pricing switch: Direct builds may never
 * carry an App Check token, and that is decided once a release build has been checked.
 */
export function appReportCounts(document: StoreCountryDocument, allowUnattestedSim: boolean): boolean {
  return document.attested || (document.source === "sim" && allowUnattestedSim);
}

export interface StoreCountryStore {
  /** Applies one report in a transaction and returns what was decided. */
  record(uid: string, report: StoreCountryReport, nowMs: number): Promise<StoreCountryDecision>;
  knownCountries(uid: string): Promise<KnownCountries>;
}

const PRODUCTION_STORE_SLOTS = [
  { platform: "apple", environment: "production" },
  { platform: "google", environment: "production" },
] as const;

/** The store-country document and reader backed by Firestore. */
export function firestoreStoreCountry(db: () => Firestore): StoreCountryStore {
  return {
    async record(uid, report, nowMs) {
      const firestore = db();
      const ref = firestore.collection(USER_STORE_COUNTRY_COLLECTION).doc(uid);
      return firestore.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(ref);
        const decision = nextStoreCountryDocument(
          snapshot.exists ? storeCountryFromData(snapshot.data()!) : undefined,
          report,
          new Date(nowMs)
        );
        if (decision.write) transaction.set(ref, storeCountryToData(decision.document));
        return decision;
      });
    },

    async knownCountries(uid) {
      const firestore = db();
      const slots = firestore.collection(SUBSCRIPTION_STATE_COLLECTION);
      const [reportSnap, configSnap, ...slotSnaps] = await firestore.getAll(
        firestore.collection(USER_STORE_COUNTRY_COLLECTION).doc(uid),
        firestore.collection(WEB_PRICING_CONFIG_PATH.collection).doc(WEB_PRICING_CONFIG_PATH.doc),
        ...PRODUCTION_STORE_SLOTS.map((slot) => slots.doc(stateDocumentId(uid, slot.platform, slot.environment)))
      );

      const result: KnownCountries = { storePurchase: [] };
      const document = reportSnap.exists ? storeCountryFromData(reportSnap.data()!) : undefined;
      const allowUnattestedSim = configSnap.exists && configSnap.get("allowUnattestedSim") === true;
      if (document && appReportCounts(document, allowUnattestedSim)) {
        result.appReport = document.country;
      }
      for (const snapshot of slotSnaps) {
        const stored = snapshot.exists ? snapshot.get("storeCountry") : undefined;
        const country = typeof stored === "string" ? toAlpha2(stored) : undefined;
        if (country && !result.storePurchase.includes(country)) result.storePurchase.push(country);
      }
      return result;
    },
  };
}

export function storeCountryToData(document: StoreCountryDocument): DocumentData {
  return {
    country: document.country,
    raw: document.raw,
    source: document.source,
    attested: document.attested,
    firstReportedAt: Timestamp.fromDate(document.firstReportedAt),
    updatedAt: Timestamp.fromDate(document.updatedAt),
    lastReportAt: Timestamp.fromDate(document.lastReportAt),
    history: document.history.map((entry) => ({
      country: entry.country,
      source: entry.source,
      attested: entry.attested,
      at: Timestamp.fromDate(entry.at),
    })),
  };
}

/**
 * Reads a stored document back, or undefined when its current evidence is unreadable.
 *
 * A broken document is then treated as absent and the next report replaces it, which is safer
 * than refusing every report from that account.
 */
export function storeCountryFromData(data: DocumentData): StoreCountryDocument | undefined {
  const country = typeof data.country === "string" ? toAlpha2(data.country) : undefined;
  const source = isSource(data.source) ? data.source : undefined;
  const firstReportedAt = dateOf(data.firstReportedAt);
  const updatedAt = dateOf(data.updatedAt);
  const lastReportAt = dateOf(data.lastReportAt);
  if (!country || !source || typeof data.attested !== "boolean" || !firstReportedAt || !updatedAt || !lastReportAt) {
    return undefined;
  }
  const history: StoreCountryHistoryEntry[] = [];
  for (const item of Array.isArray(data.history) ? data.history : []) {
    const at = dateOf(item?.at);
    const entryCountry = typeof item?.country === "string" ? toAlpha2(item.country) : undefined;
    if (at && entryCountry && isSource(item.source) && typeof item.attested === "boolean") {
      history.push({ country: entryCountry, source: item.source, attested: item.attested, at });
    }
  }
  return {
    country,
    raw: typeof data.raw === "string" ? data.raw : country,
    source,
    attested: data.attested,
    firstReportedAt,
    updatedAt,
    lastReportAt,
    history,
  };
}

function isSource(value: unknown): value is StoreCountrySource {
  return typeof value === "string" && (STORE_COUNTRY_SOURCES as readonly string[]).includes(value);
}

function dateOf(value: unknown): Date | undefined {
  return value instanceof Timestamp ? value.toDate() : undefined;
}
