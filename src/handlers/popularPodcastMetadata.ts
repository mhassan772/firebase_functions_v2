import { createHash } from "node:crypto";
import { RankedPodcast, podcastIndexIdOf } from "./podcastAuditHandlers";

// Pure logic that turns a ranking into entries the app can draw without calling Podcast Index.
// No firebase-admin import, so the tests load it without an app.

const PODCAST_INDEX_URL = "https://api.podcastindex.org/api/1.0/podcasts/byfeedid";
const USER_AGENT = "Mantooq/1.0 (popularPodcastsV1)";
const LOOKUP_TIMEOUT_MS = 5000;

/**
 * What the app's PopularPodcastModel reads. `title` and `image` are cast as non-null strings
 * there, so an entry without them is never written.
 */
export interface PodcastMetadata {
  title: string;
  image: string;
  podcastIndexId?: number;
  itunesId?: number;
  podcastGuid?: string;
  author?: string;
  owner?: string;
}

export type RankedPodcastEntry = RankedPodcast & PodcastMetadata & { podcastIndexId: number };

export interface PodcastIndexKeys {
  apiKey: string;
  apiSecret: string;
}

/** Fetches one podcast's metadata by feed id; null when it cannot. */
export type MetadataLookup = (podcastIndexId: number) => Promise<PodcastMetadata | null>;

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function positiveInt(value: unknown): number | undefined {
  const number = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : value;
  return typeof number === "number" && Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

/** Copies only the fields the app reads, leaving out absent ones (Firestore rejects undefined). */
function compact(metadata: {
  title: string;
  image: string;
  podcastIndexId?: number;
  itunesId?: number;
  podcastGuid?: string;
  author?: string;
  owner?: string;
}): PodcastMetadata {
  const result: PodcastMetadata = { title: metadata.title, image: metadata.image };
  for (const key of ["podcastIndexId", "itunesId", "podcastGuid", "author", "owner"] as const) {
    if (metadata[key] !== undefined) {
      (result as unknown as Record<string, unknown>)[key] = metadata[key];
    }
  }
  return result;
}

/**
 * Reads a stored item, from a curated list or a previous ranking, into metadata.
 *
 * Returns null without a title and an image, the two fields the app requires.
 */
export function metadataFrom(raw: unknown): PodcastMetadata | null {
  if (raw === null || typeof raw !== "object") {
    return null;
  }
  const item = raw as Record<string, unknown>;
  const title = nonEmptyString(item.title);
  const image = nonEmptyString(item.image);
  if (!title || !image) {
    return null;
  }
  return compact({
    title,
    image,
    podcastIndexId: podcastIndexIdOf(item.podcastIndexId) ?? undefined,
    itunesId: positiveInt(item.itunesId),
    podcastGuid: nonEmptyString(item.podcastGuid),
    author: nonEmptyString(item.author),
    owner: nonEmptyString(item.owner),
  });
}

/** Maps a Podcast Index `feed` object; `artwork` stands in for a missing `image`. */
export function metadataFromFeed(feed: unknown): PodcastMetadata | null {
  if (feed === null || typeof feed !== "object") {
    return null;
  }
  const item = feed as Record<string, unknown>;
  return metadataFrom({
    title: item.title,
    image: nonEmptyString(item.image) ?? item.artwork,
    podcastIndexId: item.id,
    itunesId: item.itunesId,
    podcastGuid: item.podcastGuid,
    author: item.author,
    owner: item.ownerName,
  });
}

/**
 * Indexes stored items by feed id. Earlier lists win, so pass the curated lists before the
 * previous ranking.
 */
export function metadataByIndexId(lists: unknown[][]): Map<number, PodcastMetadata> {
  const byId = new Map<number, PodcastMetadata>();
  for (const list of lists) {
    for (const raw of list) {
      const metadata = metadataFrom(raw);
      if (metadata?.podcastIndexId !== undefined && !byId.has(metadata.podcastIndexId)) {
        byId.set(metadata.podcastIndexId, metadata);
      }
    }
  }
  return byId;
}

/** The items of a stored list field, or an empty list. */
export function listField(data: unknown, field: string): unknown[] {
  const list = (data as Record<string, unknown> | undefined)?.[field];
  return Array.isArray(list) ? list : [];
}

/**
 * Turns a ranking into drawable entries, in ranking order, until `limit` entries are found.
 *
 * Metadata comes from the curated lists first, then yesterday's ranking, then `lookup`, which
 * is called at most `maxLookups` times. A podcast with no usable metadata is dropped and the
 * ranking is read further down to fill its place.
 */
export async function enrichRanking(
  ranking: RankedPodcast[],
  options: {
    curated: Map<number, PodcastMetadata>;
    previous: Map<number, PodcastMetadata>;
    lookup?: MetadataLookup;
    limit: number;
    maxLookups: number;
  },
): Promise<{ entries: RankedPodcastEntry[]; dropped: string[]; lookups: number }> {
  const entries: RankedPodcastEntry[] = [];
  const dropped: string[] = [];
  let lookups = 0;
  for (const ranked of ranking) {
    if (entries.length >= options.limit) {
      break;
    }
    const indexId = podcastIndexIdOf(ranked.podcast_id);
    let metadata: PodcastMetadata | null | undefined =
      indexId === null ? null : options.curated.get(indexId) ?? options.previous.get(indexId);
    if (metadata === undefined && indexId !== null && options.lookup && lookups < options.maxLookups) {
      lookups++;
      metadata = await options.lookup(indexId).catch(() => null);
    }
    if (!metadata || indexId === null) {
      dropped.push(ranked.podcast_id);
      continue;
    }
    entries.push({ podcast_id: ranked.podcast_id, users: ranked.users, ...metadata, podcastIndexId: indexId });
  }
  return { entries, dropped, lookups };
}

/** Podcast Index's auth headers: Authorization is sha1(key + secret + date in epoch seconds). */
export function podcastIndexHeaders(keys: PodcastIndexKeys, now: Date = new Date()): Record<string, string> {
  const date = String(Math.floor(now.getTime() / 1000));
  return {
    "User-Agent": USER_AGENT,
    "X-Auth-Date": date,
    "X-Auth-Key": keys.apiKey,
    Authorization: createHash("sha1").update(keys.apiKey + keys.apiSecret + date).digest("hex"),
  };
}

/** The Podcast Index keys stored in `settings_app/settings_metadata.podcast_index_keys`, if both are set. */
export function podcastIndexKeysFrom(settingsMetadata: unknown): PodcastIndexKeys | null {
  const keys = (settingsMetadata as Record<string, unknown> | undefined)?.podcast_index_keys as
    | Record<string, unknown>
    | undefined;
  const apiKey = nonEmptyString(keys?.api_key);
  const apiSecret = nonEmptyString(keys?.api_secret);
  return apiKey && apiSecret ? { apiKey, apiSecret } : null;
}

/**
 * Looks podcasts up on Podcast Index by feed id.
 *
 * Any failure, including a timeout, gives null so that podcast is only left out for the day.
 * Errors are reported through `onError` without the request, so the keys never reach a log.
 */
export function podcastIndexLookup(
  keys: PodcastIndexKeys,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number; onError?: (id: number, reason: string) => void } = {},
): MetadataLookup {
  const fetchImpl = options.fetchImpl ?? fetch;
  return async (podcastIndexId) => {
    try {
      const response = await fetchImpl(`${PODCAST_INDEX_URL}?id=${podcastIndexId}`, {
        headers: podcastIndexHeaders(keys),
        signal: AbortSignal.timeout(options.timeoutMs ?? LOOKUP_TIMEOUT_MS),
      });
      if (!response.ok) {
        options.onError?.(podcastIndexId, `HTTP ${response.status}`);
        return null;
      }
      const body = (await response.json()) as { feed?: unknown };
      const metadata = metadataFromFeed(body?.feed);
      if (!metadata) {
        options.onError?.(podcastIndexId, "no title or image");
      }
      return metadata;
    } catch (error) {
      options.onError?.(podcastIndexId, error instanceof Error ? error.name : "error");
      return null;
    }
  };
}
