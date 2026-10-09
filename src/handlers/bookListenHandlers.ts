import type { AppSettings } from "../types/recordings";
import { parseDate } from "./podcastAuditHandlers";

// Pure logic shared by the book listen-time triggers, mostPopularBooksV3 and the backfill
// script. It must not import firebase-admin at runtime: the backfill script loads it from lib/
// before it has initialized its own app for the project it was given.

/** One document per user and book: how long they have listened to it, and whether it counted. */
export const BOOK_LISTENERS_COLLECTION = "book_listeners";

/** The listening-time documents the app syncs: 90.3 and later, and the versions before. */
export const SESSION_COLLECTIONS = ["device_sessions_v2", "device_sessions"] as const;

export const DEFAULT_POPULAR_BOOKS_SETTINGS: PopularBooksSettings = {
  windowDays: 30,
  listLength: 100,
  minListenSeconds: 300,
  minChartSize: 20,
};

export interface PopularBooksSettings {
  windowDays: number;
  listLength: number;
  /** Lifetime listening on one book, across devices, that makes someone its listener. */
  minListenSeconds: number;
  /** Below this many books the previous chart is kept, so a bad run never empties Home. */
  minChartSize: number;
}

/** A user's total listening on one book, and when they last listened, if the data says. */
export interface BookSeconds {
  seconds: number;
  lastListenAt: Date | null;
}

/** A book whose total listening grew in one write. */
export interface GrownBook extends BookSeconds {
  bookGuid: string;
}

/** The stored fields of a `book_listeners` document that the update reads. */
export interface StoredListenerLine {
  seconds?: unknown;
  updatedAt?: unknown;
  listenedBeforeSessions?: unknown;
}

/** The fields of a `book_listeners` document, with dates still as Date. */
export interface ListenerLine {
  book_guid: string;
  user_guid: string;
  seconds: number;
  updatedAt: Date | null;
  listenedBeforeSessions: boolean;
  qualifies: boolean;
}

/** One entry of the popular books chart. */
export interface RankedBook {
  book_guid: string;
  listeners: number;
}

/** The fields the ranking needs from a `book_listeners` document. */
export interface ListenerRecord {
  book_guid?: unknown;
  qualifies?: unknown;
}

/** `/` is the only character Firestore forbids in an id; book guids never contain one. */
export function bookListenerDocId(uid: string, bookGuid: string): string {
  return `${uid}_${bookGuid.replace(/\//g, "_")}`;
}

/**
 * Whether a session entry is a catalog, converted or file book.
 *
 * Podcasts are recorded against `p-<feedId>` (older builds `podcast-`), and `backfill` entries
 * are milestone credits the app made up, not listening.
 */
export function isBookContentId(contentId: unknown): contentId is string {
  return (
    typeof contentId === "string" &&
    contentId.trim() !== "" &&
    contentId !== "backfill" &&
    !contentId.startsWith("p-") &&
    !contentId.startsWith("podcast-")
  );
}

/**
 * Total listening per book in one user's session document, summed over devices and play
 * sources.
 *
 * Reads all three formats the app has written:
 * - `device_sessions_v2`: `deviceSessions[].listenTimeEntries[]`, one counter per book and source
 * - `device_sessions`: `listenTimes[].listenTimes`, a map of book to seconds
 * - `device_sessions` before Feb 2026: `listenTimes[].listenTimeByBooks`, the same map
 *
 * Each play source keeps its own counter from 0, so adding them never counts time twice.
 */
export function secondsByBook(data: unknown): Map<string, BookSeconds> {
  const totals = new Map<string, BookSeconds>();
  const add = (contentId: unknown, seconds: unknown, lastListenAt: unknown): void => {
    if (!isBookContentId(contentId)) {
      return;
    }
    const value = Number(seconds);
    if (!Number.isFinite(value) || value <= 0) {
      return;
    }
    const date = parseDate(lastListenAt);
    const current = totals.get(contentId) ?? { seconds: 0, lastListenAt: null };
    current.seconds += value;
    if (date && (!current.lastListenAt || date > current.lastListenAt)) {
      current.lastListenAt = date;
    }
    totals.set(contentId, current);
  };

  const record = asRecord(data);
  const sessions = [...asArray(record?.deviceSessions), ...asArray(record?.listenTimes)];
  for (const session of sessions) {
    const fields = asRecord(session);
    if (!fields) {
      continue;
    }
    for (const entry of asArray(fields.listenTimeEntries)) {
      const entryFields = asRecord(entry);
      add(entryFields?.contentId, entryFields?.listenTimeSeconds, entryFields?.lastListenAt);
    }
    for (const map of [fields.listenTimes, fields.listenTimeByBooks]) {
      const byBook = asRecord(map);
      if (byBook && !Array.isArray(map)) {
        for (const [contentId, seconds] of Object.entries(byBook)) {
          add(contentId, seconds, null);
        }
      }
    }
  }
  return totals;
}

/** The books whose total grew between two versions of a session document. */
export function grownBooks(before: Map<string, BookSeconds>, after: Map<string, BookSeconds>): GrownBook[] {
  const grown: GrownBook[] = [];
  for (const [bookGuid, total] of after) {
    if (total.seconds > (before.get(bookGuid)?.seconds ?? 0)) {
      grown.push({ bookGuid, ...total });
    }
  }
  return grown;
}

/**
 * The fields to merge into a `book_listeners` document after a book's listening grew, or null
 * when the stored total is already as high.
 *
 * - The two session collections both hold lifetime totals, and v2 usually includes the older
 *   one's time, so the larger total wins and they are never added together.
 * - `updatedAt` is when the user last listened, as the app recorded it, else `now`. It is
 *   capped at `now`: the app writes local time without a zone, so it can read a few hours ahead.
 * - `listenedBeforeSessions` is cleared once sessions alone reach the minimum, and never earlier,
 *   so a line that qualifies never stops qualifying.
 * - `addedToBook` is left to the nightly job, except that a new line starts at false.
 */
export function nextListenerLine(
  stored: StoredListenerLine | undefined,
  uid: string,
  grown: GrownBook,
  now: Date,
  minListenSeconds: number,
): (ListenerLine & { addedToBook?: false }) | null {
  const storedSeconds = Number(stored?.seconds);
  const previous = Number.isFinite(storedSeconds) ? storedSeconds : 0;
  if (grown.seconds <= previous) {
    return null;
  }
  const listenedAt = grown.lastListenAt && grown.lastListenAt < now ? grown.lastListenAt : now;
  const storedUpdatedAt = parseDate(stored?.updatedAt);
  const updatedAt = storedUpdatedAt && storedUpdatedAt > listenedAt ? storedUpdatedAt : listenedAt;
  const listenedBeforeSessions = grown.seconds >= minListenSeconds ? false : stored?.listenedBeforeSessions === true;
  const line: ListenerLine & { addedToBook?: false } = {
    book_guid: grown.bookGuid,
    user_guid: uid,
    seconds: grown.seconds,
    updatedAt,
    listenedBeforeSessions,
    qualifies: grown.seconds >= minListenSeconds || listenedBeforeSessions,
  };
  if (!stored) {
    line.addedToBook = false;
  }
  return line;
}

/** Listeners per book among the lines read for the window, most first; ties keep a fixed order. */
export function rankBooks(records: ListenerRecord[]): RankedBook[] {
  const listeners = new Map<string, number>();
  for (const record of records) {
    if (record.qualifies !== true || typeof record.book_guid !== "string" || record.book_guid === "") {
      continue;
    }
    listeners.set(record.book_guid, (listeners.get(record.book_guid) ?? 0) + 1);
  }
  return [...listeners]
    .map(([book_guid, count]) => ({ book_guid, listeners: count }))
    .sort((a, b) => b.listeners - a.listeners || (a.book_guid < b.book_guid ? -1 : a.book_guid > b.book_guid ? 1 : 0));
}

/**
 * Whether a synced progress entry shows the book was listened to before listening time was
 * tracked: finished, or chapter positions adding up to the minimum.
 *
 * Positions say where the listener is, not how long they listened, so this is used only as a
 * yes or no for the one-time backfill, never as seconds.
 */
export function listenedByProgress(book: unknown, minListenSeconds: number): boolean {
  const fields = asRecord(book);
  if (!fields || fields.deleted === true || typeof fields.bookGuid !== "string" || fields.bookGuid === "") {
    return false;
  }
  if (fields.isCompleted === true) {
    return true;
  }
  const byId = asRecord(fields.allChaptersProgressById);
  const positions = byId && Object.keys(byId).length > 0 ? byId : asRecord(fields.allChaptersProgress);
  let total = 0;
  for (const value of Object.values(positions ?? {})) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds > 0) {
      total += seconds;
    }
  }
  return total >= minListenSeconds;
}

/**
 * Book guids a user finished, from either finished-books list older versions synced:
 * `completed_books_v2` (`books: [{bookGuid, deleted}]`) or `completed_book` (`books: [guid]`).
 */
export function completedBookGuids(data: unknown): string[] {
  const guids: string[] = [];
  for (const entry of asArray(asRecord(data)?.books)) {
    if (typeof entry === "string" && entry !== "") {
      guids.push(entry);
      continue;
    }
    const fields = asRecord(entry);
    if (fields && fields.deleted !== true && typeof fields.bookGuid === "string" && fields.bookGuid !== "") {
      guids.push(fields.bookGuid);
    }
  }
  return guids;
}

/**
 * One user's lines for the backfill, from both session documents and the books old data shows
 * they listened to.
 *
 * Old data only sets `listenedBeforeSessions`, and only where sessions alone fall short of the
 * minimum, so the flag marks people who count only because of it.
 */
export function backfillLines(
  uid: string,
  sessionsV2: Map<string, BookSeconds>,
  sessionsLegacy: Map<string, BookSeconds>,
  listenedBefore: Set<string>,
  minListenSeconds: number,
): ListenerLine[] {
  const guids = new Set([...sessionsV2.keys(), ...sessionsLegacy.keys(), ...listenedBefore]);
  const lines: ListenerLine[] = [];
  for (const bookGuid of guids) {
    const v2 = sessionsV2.get(bookGuid);
    const legacy = sessionsLegacy.get(bookGuid);
    const seconds = Math.max(v2?.seconds ?? 0, legacy?.seconds ?? 0);
    const listenedBeforeSessions = seconds < minListenSeconds && listenedBefore.has(bookGuid);
    lines.push({
      book_guid: bookGuid,
      user_guid: uid,
      seconds,
      // Only v2 records when someone listened; the older format has no dates.
      updatedAt: v2?.lastListenAt ?? null,
      listenedBeforeSessions,
      qualifies: seconds >= minListenSeconds || listenedBeforeSessions,
    });
  }
  return lines;
}

/** The chart settings from `settings/mantooqAppSettings`, with defaults for missing values. */
export function resolvePopularBooksSettings(settings: Partial<AppSettings> | undefined): PopularBooksSettings {
  const positive = (value: unknown, fallback: number): number => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
  };
  const defaults = DEFAULT_POPULAR_BOOKS_SETTINGS;
  return {
    windowDays: positive(settings?.mostPopularBooksDays, defaults.windowDays),
    listLength: positive(settings?.numberOfMostPopularBooksToReturn, defaults.listLength),
    minListenSeconds: positive(settings?.popularBooksMinListenSeconds, defaults.minListenSeconds),
    minChartSize: positive(settings?.popularBooksMinChartSize, defaults.minChartSize),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
