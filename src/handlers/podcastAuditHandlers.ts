import type { AppSettings } from "../types/recordings";

// Pure logic shared by popularPodcastsV1, the temporary audit triggers and the backfill script.
// It must not import firebase-admin at runtime: the backfill script loads it from lib/
// before it has initialized its own app for the project it was given.

export const PODCAST_AUDIT_COLLECTION = "podcast_audit";
export const CONVERTED_PODCAST_AUDIT_COLLECTION = "converted_podcast_audit";

/** The per-user documents the app syncs, and the top-level field that says when each last changed. */
export const AUDIT_SOURCES = {
  podcast_subscriptions: "updatedAt",
  converted_podcasts: "updatedAt",
  episode_progress: "updateTimestamp",
} as const;

export type AuditSource = keyof typeof AUDIT_SOURCES;

/** How far back the daily job's first run looks; the backfill script covers anything older. */
export const FIRST_RUN_LOOKBACK_DAYS = 2;

export const DEFAULT_POPULAR_PODCASTS_SETTINGS: PopularPodcastsSettings = {
  windowDays: 60,
  retentionDays: 65,
  listLength: 50,
};

const DAY_MS = 24 * 60 * 60 * 1000;

export type PodcastAuditAction = "follow" | "listen";

export interface PodcastAuditData {
  podcast_id: string;
  user_guid: string;
  action: PodcastAuditAction;
  timestamp: Date;
}

export interface ConvertedPodcastAuditData {
  podcast_id: string;
  book_guid: string;
  user_guid: string;
  action: "convert";
  timestamp: Date;
}

/** One audit document to write with set(): the latest engagement of one user with one podcast. */
export type AuditEvent =
  | { collection: typeof PODCAST_AUDIT_COLLECTION; id: string; data: PodcastAuditData }
  | { collection: typeof CONVERTED_PODCAST_AUDIT_COLLECTION; id: string; data: ConvertedPodcastAuditData };

/** Events to write, plus the number of items left out because their data could not be read. */
export interface AuditEventsResult {
  events: AuditEvent[];
  skipped: number;
}

export interface PopularPodcastsSettings {
  windowDays: number;
  retentionDays: number;
  listLength: number;
}

/** One entry of a ranking document. */
export interface RankedPodcast {
  podcast_id: string;
  users: number;
}

/** The fields the ranking needs from an audit document. */
export interface AuditRecord {
  podcast_id?: unknown;
  user_guid?: unknown;
  action?: unknown;
}

/** A source document as read from Firestore. */
export interface SourceDoc {
  source: AuditSource;
  uid: string;
  data: unknown;
}

/**
 * Builds the fixed id that keeps one document per user, podcast and action.
 *
 * `/` is the only character Firestore forbids in an id; podcast ids never contain one, so it
 * is replaced only as a guard.
 */
export function auditDocId(action: string, uid: string, podcastId: string): string {
  return `${action}_${uid}_${podcastId.replace(/\//g, "_")}`;
}

/**
 * Reads a date stored by any app version: a Firestore Timestamp, a Date, epoch seconds or
 * milliseconds, or an ISO string. Returns null when the value is not a usable date.
 */
export function parseDate(value: unknown): Date | null {
  if (value === null || value === undefined) {
    return null;
  }
  let date: Date | null = null;
  if (value instanceof Date) {
    date = new Date(value.getTime());
  } else if (typeof value === "number") {
    // Ten-digit values are seconds; anything from 2001 on in milliseconds has 12 or more.
    date = new Date(value < 1e11 ? value * 1000 : value);
  } else if (typeof value === "string") {
    if (value.trim() === "") {
      return null;
    }
    date = /^\d+$/.test(value.trim()) ? parseDate(Number(value.trim())) : new Date(value);
  } else if (typeof value === "object") {
    const candidate = value as { toDate?: unknown; seconds?: unknown; _seconds?: unknown; nanoseconds?: unknown; _nanoseconds?: unknown };
    if (typeof candidate.toDate === "function") {
      date = (candidate.toDate as () => Date).call(value);
    } else {
      const seconds = candidate.seconds ?? candidate._seconds;
      const nanos = candidate.nanoseconds ?? candidate._nanoseconds ?? 0;
      if (typeof seconds === "number" && typeof nanos === "number") {
        date = new Date(seconds * 1000 + Math.floor(nanos / 1e6));
      }
    }
  }
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

/** Prefix the app puts before a Podcast Index feed id to form its podcast ids (`p-920666`). */
export const PODCAST_ID_PREFIX = "p-";

/**
 * The Podcast Index feed id inside an app podcast id: `p-920666` or a bare `920666`.
 *
 * Returns null for anything else, such as a podcast that did not come from Podcast Index.
 */
export function podcastIndexIdOf(podcastId: unknown): number | null {
  const id = asId(podcastId);
  if (id === null) {
    return null;
  }
  const digits = id.startsWith(PODCAST_ID_PREFIX) ? id.slice(PODCAST_ID_PREFIX.length) : id;
  if (!/^\d+$/.test(digits)) {
    return null;
  }
  const number = Number(digits);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

/**
 * The app's form of a podcast id, so a bare feed id from older data and `p-` ids count as one.
 */
export function canonicalPodcastId(value: unknown): string | null {
  const indexId = podcastIndexIdOf(value);
  return indexId !== null ? `${PODCAST_ID_PREFIX}${indexId}` : asId(value);
}

function asId(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "string" && value.trim() !== "") {
    return value.trim();
  }
  return null;
}

function asList(data: unknown, field: string): Record<string, unknown>[] {
  const list = (data as Record<string, unknown> | undefined)?.[field];
  return Array.isArray(list) ? list.filter((item) => item !== null && typeof item === "object") : [];
}

function asNumber(value: unknown): number {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : 0;
}

/** Items that are present and not deleted, keyed by podcast id to the first such item. */
function activeById(items: Record<string, unknown>[]): Map<string, Record<string, unknown>> {
  const active = new Map<string, Record<string, unknown>>();
  for (const item of items) {
    const id = canonicalPodcastId(item.podcastId);
    if (id !== null && item.deleted !== true && !active.has(id)) {
      active.set(id, item);
    }
  }
  return active;
}

function followEvent(uid: string, podcastId: string, timestamp: Date): AuditEvent {
  return {
    collection: PODCAST_AUDIT_COLLECTION,
    id: auditDocId("follow", uid, podcastId),
    data: { podcast_id: podcastId, user_guid: uid, action: "follow", timestamp },
  };
}

function convertEvent(uid: string, podcastId: string, bookGuid: string, timestamp: Date): AuditEvent {
  return {
    collection: CONVERTED_PODCAST_AUDIT_COLLECTION,
    id: auditDocId("convert", uid, podcastId),
    data: { podcast_id: podcastId, book_guid: bookGuid, user_guid: uid, action: "convert", timestamp },
  };
}

/** Follow events for every active subscription in a stored document, each dated by its `subscribedAt`. */
export function followEventsFromDoc(uid: string, data: unknown): AuditEventsResult {
  const events: AuditEvent[] = [];
  let skipped = 0;
  for (const [podcastId, item] of activeById(asList(data, "subscriptions"))) {
    const date = parseDate(item.subscribedAt);
    if (date === null) {
      skipped++;
      continue;
    }
    events.push(followEvent(uid, podcastId, date));
  }
  return { events, skipped };
}

/** Convert events for every active conversion in a stored document, each dated by its `convertedAt`. */
export function convertEventsFromDoc(uid: string, data: unknown): AuditEventsResult {
  const events: AuditEvent[] = [];
  let skipped = 0;
  for (const [podcastId, item] of activeById(asList(data, "convertedPodcasts"))) {
    const date = parseDate(item.convertedAt);
    const bookGuid = asId(item.bookGuid);
    if (date === null || bookGuid === null) {
      skipped++;
      continue;
    }
    events.push(convertEvent(uid, podcastId, bookGuid, date));
  }
  return { events, skipped };
}

/** Whether an episode counts as listened: any playback at all, on an episode not deleted. */
export function isListened(positionInSeconds: number, deleted: boolean): boolean {
  return !deleted && positionInSeconds > 0;
}

/**
 * One listen event per podcast in a stored `episode_progress/{uid}` document, dated by the
 * latest `updatedAt` among its listened episodes, so a recent listen re-dates an old one.
 *
 * Episodes without a podcast id are left out silently; they cannot be ranked.
 */
export function listenEventsFromDoc(uid: string, data: unknown): AuditEventsResult {
  const latestByPodcast = new Map<string, Date>();
  let skipped = 0;
  for (const item of asList(data, "episodes")) {
    const podcastId = canonicalPodcastId(item.podcastId);
    if (podcastId === null || asId(item.episodeId) === null) {
      continue;
    }
    if (!isListened(asNumber(item.positionInSeconds), item.deleted === true)) {
      continue;
    }
    const date = parseDate(item.updatedAt);
    if (date === null) {
      skipped++;
      continue;
    }
    const latest = latestByPodcast.get(podcastId);
    if (!latest || date > latest) {
      latestByPodcast.set(podcastId, date);
    }
  }
  const events: AuditEvent[] = [...latestByPodcast].map(([podcastId, timestamp]) => ({
    collection: PODCAST_AUDIT_COLLECTION,
    id: auditDocId("listen", uid, podcastId),
    data: { podcast_id: podcastId, user_guid: uid, action: "listen", timestamp },
  }));
  return { events, skipped };
}

/** Events for one source document, whatever its age. */
export function eventsFromSourceDoc(doc: SourceDoc): AuditEventsResult {
  switch (doc.source) {
    case "podcast_subscriptions":
      return followEventsFromDoc(doc.uid, doc.data);
    case "converted_podcasts":
      return convertEventsFromDoc(doc.uid, doc.data);
    case "episode_progress":
      return listenEventsFromDoc(doc.uid, doc.data);
  }
}

/** Whether a source document's top-level change field is later than `since`. */
export function changedSince(doc: SourceDoc, since: Date): boolean {
  const changedAt = parseDate((doc.data as Record<string, unknown> | undefined)?.[AUDIT_SOURCES[doc.source]]);
  return changedAt !== null && changedAt > since;
}

/**
 * Keeps events dated within retention and pulls future dates back to `now`.
 *
 * A device clock running ahead would otherwise date an event that never ages out.
 */
export function withinRetention(events: AuditEvent[], now: Date, retentionDays: number): AuditEvent[] {
  const start = now.getTime() - retentionDays * DAY_MS;
  const kept: AuditEvent[] = [];
  for (const event of events) {
    const time = event.data.timestamp.getTime();
    if (time < start) {
      continue;
    }
    kept.push(time > now.getTime() ? ({ ...event, data: { ...event.data, timestamp: new Date(now) } } as AuditEvent) : event);
  }
  return kept;
}

/**
 * Events from the source documents that changed after `since`, kept within retention.
 *
 * The daily job's query already filters on the change field; checking again here keeps the
 * selection testable and guards against a query returning more than asked.
 */
export function collectChangedEvents(
  docs: SourceDoc[],
  since: Date,
  now: Date,
  settings: PopularPodcastsSettings,
): AuditEventsResult & { documents: number } {
  const events: AuditEvent[] = [];
  let skipped = 0;
  let documents = 0;
  for (const doc of docs) {
    if (!changedSince(doc, since)) {
      continue;
    }
    documents++;
    const result = eventsFromSourceDoc(doc);
    events.push(...withinRetention(result.events, now, settings.retentionDays));
    skipped += result.skipped;
  }
  return { events, skipped, documents };
}

/**
 * Where the daily collection starts: a day before the last run, since the change fields
 * written by the app use the device clock, or two days back on the first run.
 */
export function collectionStart(lastRunAt: unknown, now: Date): Date {
  const last = parseDate(lastRunAt);
  return last ? new Date(last.getTime() - DAY_MS) : new Date(now.getTime() - FIRST_RUN_LOOKBACK_DAYS * DAY_MS);
}

/**
 * Events for items active in `after` but not in `before`, dated by their own dates and kept
 * within retention.
 *
 * An old app can push days after the user acted, so any date inside retention counts. Old
 * history restored by a sync cannot pass as recent, because each event keeps its real date.
 * Only items newly unreadable in this change are counted, so one bad item is not reported on
 * every sync.
 */
function newlyActive(
  after: AuditEventsResult,
  before: AuditEventsResult,
  now: Date,
  retentionDays: number,
): AuditEventsResult {
  const existing = new Set(before.events.map((event) => event.id));
  const events = after.events.filter((event) => !existing.has(event.id));
  return {
    events: withinRetention(events, now, retentionDays),
    skipped: Math.max(0, after.skipped - before.skipped),
  };
}

/** Follow events for a write to `podcast_subscriptions/{uid}`: follows added by this write. */
export function followEventsForChange(
  uid: string,
  before: unknown,
  after: unknown,
  now: Date,
  retentionDays: number,
): AuditEventsResult {
  return newlyActive(followEventsFromDoc(uid, after), followEventsFromDoc(uid, before), now, retentionDays);
}

/** Convert events for a write to `converted_podcasts/{uid}`: conversions added by this write. */
export function convertEventsForChange(
  uid: string,
  before: unknown,
  after: unknown,
  now: Date,
  retentionDays: number,
): AuditEventsResult {
  return newlyActive(convertEventsFromDoc(uid, after), convertEventsFromDoc(uid, before), now, retentionDays);
}

/**
 * Ranks podcasts by how many distinct users have a record for them.
 *
 * Counting users rather than records means one user following and listening adds one.
 * Ties are ordered by podcast id so the list does not reshuffle daily.
 */
export function rankPodcastsByDistinctUsers(
  records: Iterable<AuditRecord>,
  deniedPodcastIds: ReadonlySet<string>,
  limit: number,
  actions?: ReadonlySet<string>,
): RankedPodcast[] {
  const usersByPodcast = new Map<string, Set<string>>();
  for (const record of records) {
    if (actions && !actions.has(String(record.action))) {
      continue;
    }
    const podcastId = canonicalPodcastId(record.podcast_id);
    const uid = asId(record.user_guid);
    if (podcastId === null || uid === null || isDenied(podcastId, deniedPodcastIds)) {
      continue;
    }
    let users = usersByPodcast.get(podcastId);
    if (!users) {
      users = new Set();
      usersByPodcast.set(podcastId, users);
    }
    users.add(uid);
  }
  return [...usersByPodcast]
    .map(([podcastId, users]) => ({ podcast_id: podcastId, users: users.size }))
    .sort((a, b) => b.users - a.users || comparePodcastIds(a.podcast_id, b.podcast_id))
    .slice(0, Math.max(0, Math.trunc(limit)));
}

/** The deny list holds bare feed ids; other podcasts can only match their exact id. */
function isDenied(podcastId: string, deniedPodcastIds: ReadonlySet<string>): boolean {
  const indexId = podcastIndexIdOf(podcastId);
  return deniedPodcastIds.has(indexId !== null ? String(indexId) : podcastId);
}

/** Feed ids compare as numbers, anything else as plain strings after them. */
function comparePodcastIds(a: string, b: string): number {
  const indexA = podcastIndexIdOf(a);
  const indexB = podcastIndexIdOf(b);
  if (indexA !== null && indexB !== null) {
    return indexA - indexB;
  }
  if (indexA !== null || indexB !== null) {
    return indexA !== null ? -1 : 1;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Feed ids from the admin deny documents (`settings_app/admin_deny{n}`), as the app reads them.
 */
export function deniedPodcastIdsFrom(denyDocs: unknown[]): Set<string> {
  const denied = new Set<string>();
  for (const doc of denyDocs) {
    for (const entry of asList(doc, "denied_podcasts")) {
      const indexId = podcastIndexIdOf(entry.podcastIndexId);
      const id = indexId !== null ? String(indexId) : asId(entry.podcastIndexId);
      if (id !== null) {
        denied.add(id);
      }
    }
  }
  return denied;
}

/** How many `admin_deny{n}` documents `settings_app/settings_metadata` says exist. */
export function denyDocCountFrom(settingsMetadata: unknown): number {
  const filtering = (settingsMetadata as Record<string, unknown> | undefined)?.podcasts_filtering;
  const count = asNumber((filtering as Record<string, unknown> | undefined)?.number_of_admin_deny);
  return Math.max(0, Math.trunc(count));
}

/**
 * Settings for the podcast rankings, with code defaults for absent or invalid fields.
 *
 * Retention stays at least a day past the window, or pruning would delete records still counted.
 */
export function resolvePopularPodcastsSettings(settings: Partial<AppSettings> | undefined): PopularPodcastsSettings {
  const positive = (value: unknown, fallback: number): number => {
    const number = asNumber(value);
    return number > 0 ? number : fallback;
  };
  const defaults = DEFAULT_POPULAR_PODCASTS_SETTINGS;
  const windowDays = positive(settings?.popularPodcastsDays, defaults.windowDays);
  return {
    windowDays,
    retentionDays: Math.max(windowDays + 1, positive(settings?.popularPodcastsAuditRetentionDays, defaults.retentionDays)),
    listLength: Math.trunc(positive(settings?.numberOfPopularPodcastsToReturn, defaults.listLength)),
  };
}
