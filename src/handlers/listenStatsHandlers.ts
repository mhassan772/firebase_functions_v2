import { BookSeconds, secondsByBook, secondsByContent } from "./bookListenHandlers";

// Pure logic shared by the listen-time triggers, the public stats jobs and the backfill script.
// Like bookListenHandlers, it must not import firebase-admin at runtime. See docs/listening-stats.md.

/** One document per user and podcast: how long they have listened to it. */
export const PODCAST_LISTENERS_COLLECTION = "podcast_listeners";

/** One document per user: their lifetime listening, books and podcasts. */
export const LISTENER_TOTALS_COLLECTION = "listener_totals";

/** The one document anyone may read: the numbers the donation site shows. */
export const PUBLIC_STATS_PATH = "public_stats/site";

/** A user's lifetime listening, as stored in `listener_totals`, with dates still as Date. */
export interface ListenerTotals {
  user_guid: string;
  bookSeconds: number;
  podcastSeconds: number;
  totalSeconds: number;
  lastListenAt: Date | null;
  /** Whether the total has reached the minimum; a listener is counted once, when this turns true. */
  isListener: boolean;
}

/** The stored fields of a `listener_totals` document that an update reads. */
export interface StoredListenerTotals {
  bookSeconds?: unknown;
  podcastSeconds?: unknown;
  lastListenAt?: unknown;
  isListener?: unknown;
}

/** The fields of a `podcast_listeners` document, with dates still as Date. */
export interface PodcastListenerLine {
  podcast_id: string;
  user_guid: string;
  seconds: number;
  updatedAt: Date | null;
}

/**
 * The podcast a session entry was recorded against, as `p-<feedId>`, or null when the entry is
 * not a podcast.
 *
 * The app also strips a `podcast-` in front of `p-…`, which early builds may have synced, so one
 * podcast is never split in two. Any other `podcast-…` id is kept as it is.
 */
export function podcastIdOf(contentId: unknown): string | null {
  if (typeof contentId !== "string") {
    return null;
  }
  const id = contentId.trim();
  if (id.startsWith("podcast-p-")) {
    return id.substring("podcast-".length);
  }
  return id.startsWith("p-") || id.startsWith("podcast-") ? id : null;
}

/** Total listening per podcast in one user's session document; all episodes of a podcast together. */
export function secondsByPodcast(data: unknown): Map<string, BookSeconds> {
  return secondsByContent(data, podcastIdOf);
}

/** `/` is the only character Firestore forbids in an id. */
export function podcastListenerDocId(uid: string, podcastId: string): string {
  return `${uid}_${podcastId.replace(/\//g, "_")}`;
}

/**
 * The fields to merge into a `podcast_listeners` document after a podcast's listening grew, or
 * null when the stored total is already as high.
 *
 * The two session collections both hold lifetime totals, so the larger total wins. `updatedAt`
 * is when the user last listened, as the app recorded it, else `now`, and never later than `now`:
 * the app writes local time without a zone, so it can read a few hours ahead.
 */
export function nextPodcastLine(
  stored: { seconds?: unknown; updatedAt?: unknown } | undefined,
  uid: string,
  grown: { podcastId: string; seconds: number; lastListenAt: Date | null },
  now: Date,
): PodcastListenerLine | null {
  const storedSeconds = Number(stored?.seconds);
  if (grown.seconds <= (Number.isFinite(storedSeconds) ? storedSeconds : 0)) {
    return null;
  }
  const listenedAt = grown.lastListenAt && grown.lastListenAt < now ? grown.lastListenAt : now;
  const storedUpdatedAt = stored?.updatedAt instanceof Date ? stored.updatedAt : null;
  return {
    podcast_id: grown.podcastId,
    user_guid: uid,
    seconds: grown.seconds,
    updatedAt: storedUpdatedAt && storedUpdatedAt > listenedAt ? storedUpdatedAt : listenedAt,
  };
}

function sumSeconds(totals: Map<string, BookSeconds>): number {
  let seconds = 0;
  for (const total of totals.values()) {
    seconds += total.seconds;
  }
  return seconds;
}

function latest(...dates: (Date | null | undefined)[]): Date | null {
  let result: Date | null = null;
  for (const date of dates) {
    if (date && !Number.isNaN(date.getTime()) && (!result || date > result)) {
      result = date;
    }
  }
  return result;
}

function latestOf(totals: Map<string, BookSeconds>): Date | null {
  return latest(...[...totals.values()].map((total) => total.lastListenAt));
}

/** Per content, the larger of two lifetime totals; the two session collections overlap, so they are never added. */
export function largerPerContent(a: Map<string, BookSeconds>, b: Map<string, BookSeconds>): Map<string, BookSeconds> {
  const merged = new Map<string, BookSeconds>();
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const first = a.get(key);
    const second = b.get(key);
    merged.set(key, {
      seconds: Math.max(first?.seconds ?? 0, second?.seconds ?? 0),
      lastListenAt: latest(first?.lastListenAt, second?.lastListenAt),
    });
  }
  return merged;
}

/** A user's totals from their listening per book and per podcast. */
export function totalsOf(
  uid: string,
  books: Map<string, BookSeconds>,
  podcasts: Map<string, BookSeconds>,
  minListenSeconds: number,
): ListenerTotals {
  const bookSeconds = sumSeconds(books);
  const podcastSeconds = sumSeconds(podcasts);
  return {
    user_guid: uid,
    bookSeconds,
    podcastSeconds,
    totalSeconds: bookSeconds + podcastSeconds,
    lastListenAt: latest(latestOf(books), latestOf(podcasts)),
    isListener: bookSeconds + podcastSeconds >= minListenSeconds,
  };
}

/** A user's totals as one session document alone shows them, for a user who has none stored yet. */
export function totalsFromSession(uid: string, data: unknown, minListenSeconds: number): ListenerTotals {
  return totalsOf(uid, secondsByBook(data), secondsByPodcast(data), minListenSeconds);
}

/**
 * Stored totals after listening grew by the given seconds.
 *
 * `becameListener` is true only for the update that takes the user from below the minimum to
 * it. Inside a transaction that makes exactly one update per user the one that adds them to the
 * public listeners count. Totals only grow, so a listener never stops being one.
 */
export function grownTotals(
  stored: StoredListenerTotals,
  uid: string,
  growth: { bookSeconds: number; podcastSeconds: number; lastListenAt: Date | null },
  minListenSeconds: number,
): ListenerTotals & { becameListener: boolean } {
  const number = (value: unknown): number => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0);
  const bookSeconds = number(stored.bookSeconds) + Math.max(0, growth.bookSeconds);
  const podcastSeconds = number(stored.podcastSeconds) + Math.max(0, growth.podcastSeconds);
  const wasListener = stored.isListener === true;
  const isListener = wasListener || bookSeconds + podcastSeconds >= minListenSeconds;
  return {
    user_guid: uid,
    bookSeconds,
    podcastSeconds,
    totalSeconds: bookSeconds + podcastSeconds,
    lastListenAt: latest(stored.lastListenAt instanceof Date ? stored.lastListenAt : null, growth.lastListenAt),
    isListener,
    becameListener: isListener && !wasListener,
  };
}

/**
 * Totals from the backfill merged into ones already stored, by the triggers since the dry run or
 * by an earlier commit. Both are lifetime totals of the same listening, so the larger wins.
 */
export function mergedTotals(
  stored: StoredListenerTotals,
  fromFile: ListenerTotals,
  minListenSeconds: number,
): ListenerTotals {
  const number = (value: unknown): number => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0);
  const bookSeconds = Math.max(number(stored.bookSeconds), fromFile.bookSeconds);
  const podcastSeconds = Math.max(number(stored.podcastSeconds), fromFile.podcastSeconds);
  return {
    user_guid: fromFile.user_guid,
    bookSeconds,
    podcastSeconds,
    totalSeconds: bookSeconds + podcastSeconds,
    lastListenAt: latest(stored.lastListenAt instanceof Date ? stored.lastListenAt : null, fromFile.lastListenAt),
    isListener: stored.isListener === true || bookSeconds + podcastSeconds >= minListenSeconds,
  };
}

/**
 * One user's documents for the backfill: a line per podcast and their totals, from both session
 * documents. Null totals mean the user has no listening at all and gets no document.
 */
export function backfillUser(
  uid: string,
  sessionsV2: unknown,
  sessionsLegacy: unknown,
  minListenSeconds: number,
): { podcasts: PodcastListenerLine[]; totals: ListenerTotals | null } {
  const books = largerPerContent(secondsByBook(sessionsV2), secondsByBook(sessionsLegacy));
  const podcasts = largerPerContent(secondsByPodcast(sessionsV2), secondsByPodcast(sessionsLegacy));
  const totals = totalsOf(uid, books, podcasts, minListenSeconds);
  return {
    podcasts: [...podcasts].map(([podcast_id, total]) => ({
      podcast_id,
      user_guid: uid,
      seconds: total.seconds,
      updatedAt: total.lastListenAt,
    })),
    totals: totals.totalSeconds > 0 ? totals : null,
  };
}

/** Whole hours in a number of seconds, for the public numbers. */
export function wholeHours(seconds: number): number {
  return Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds / 3600) : 0;
}
