import * as functions from "firebase-functions";
import { BulkWriter, DocumentData, Timestamp } from "firebase-admin/firestore";
import { admin } from "../config/admin";
import { deleteRecordsBefore, forEachPage } from "./auditPaging";
import {
  AUDIT_SOURCES,
  AuditEvent,
  AuditRecord,
  AuditSource,
  CONVERTED_PODCAST_AUDIT_COLLECTION,
  PODCAST_AUDIT_COLLECTION,
  PopularPodcastsSettings,
  RankedPodcast,
  collectChangedEvents,
  collectionStart,
  denyDocCountFrom,
  deniedPodcastIdsFrom,
  rankPodcastsByDistinctUsers,
  resolvePopularPodcastsSettings,
} from "./podcastAuditHandlers";
import {
  MetadataLookup,
  PodcastMetadata,
  RankedPodcastEntry,
  enrichRanking,
  listField,
  metadataByIndexId,
  podcastIndexKeysFrom,
  podcastIndexLookup,
} from "./popularPodcastMetadata";
import { getSettings } from "./recordingUrlHandlers";

const RANKING_COLLECTION = "popular_podcasts_v2";
const RANKING_DOCS = ["popular_podcasts", "popular_converted_podcasts"] as const;
const STATE_DOC = "podcast_audit_state/daily";
const POPULAR_ACTIONS: ReadonlySet<string> = new Set(["follow", "listen"]);
/** A conversion, or a listen to a converted podcast that the app writes itself. */
const CONVERTED_ACTIONS: ReadonlySet<string> = new Set(["convert", "listen"]);

/** Source documents read per page; episode_progress documents can be large. */
const SOURCE_PAGE_SIZE = 200;
/** Audit records read per page while counting; they are small. */
const AUDIT_PAGE_SIZE = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Collects engagement synced since the last run, ranks podcasts by distinct users who followed
 * or listened and converted podcasts by distinct users who converted them, stores both
 * rankings, then prunes audit records past retention.
 */
export async function handlePopularPodcasts(): Promise<void> {
  const settings = resolvePopularPodcastsSettings(await getSettings());
  const runStart = new Date();

  const collected = await collectNewEvents(settings, runStart);

  const windowStart = new Date(runStart.getTime() - settings.windowDays * DAY_MS);
  const settingsMetadata = (await admin.firestore().doc("settings_app/settings_metadata").get()).data();
  const denied = await getDeniedPodcastIds(settingsMetadata);
  // Unlimited here: entries without metadata are dropped later and the list is filled from below.
  const popularRanking = rankPodcastsByDistinctUsers(
    await readRecordsSince(PODCAST_AUDIT_COLLECTION, windowStart),
    denied,
    Number.MAX_SAFE_INTEGER,
    POPULAR_ACTIONS,
  );
  const convertedRanking = rankPodcastsByDistinctUsers(
    await readRecordsSince(CONVERTED_PODCAST_AUDIT_COLLECTION, windowStart),
    denied,
    Number.MAX_SAFE_INTEGER,
    CONVERTED_ACTIONS,
  );

  const curated = metadataByIndexId(await readCuratedLists(settingsMetadata));
  const previous = metadataByIndexId(await readPreviousRankings());
  const lookup = cachedLookup(settingsMetadata);
  const enrich = async (docId: string, ranking: RankedPodcast[]): Promise<RankedPodcastEntry[]> => {
    const result = await enrichRanking(ranking, {
      curated,
      previous,
      lookup,
      limit: settings.listLength,
      maxLookups: settings.listLength,
    });
    if (result.dropped.length > 0) {
      functions.logger.warn(`${docId}: left out podcasts without a title and image`, { podcasts: result.dropped });
    }
    return result.entries;
  };
  const popular = await enrich("popular_podcasts", popularRanking);
  const converted = await enrich("popular_converted_podcasts", convertedRanking);
  await saveRanking("popular_podcasts", popular);
  await saveRanking("popular_converted_podcasts", converted);

  const cutoff = new Date(runStart.getTime() - settings.retentionDays * DAY_MS);
  const pruned =
    (await deleteRecordsBefore(PODCAST_AUDIT_COLLECTION, cutoff)) +
    (await deleteRecordsBefore(CONVERTED_PODCAST_AUDIT_COLLECTION, cutoff));
  functions.logger.info("popular podcasts rebuilt", {
    ...collected,
    popular: popular.length,
    converted: converted.length,
    denied: denied.size,
    pruned,
  });
}

/**
 * Writes events for every source document changed since the last run, then moves the
 * last-run mark to `runStart`.
 *
 * The mark moves only when every write succeeded, so a failed run is collected again next time.
 */
async function collectNewEvents(
  settings: PopularPodcastsSettings,
  runStart: Date,
): Promise<{ since: string; documents: number; events: number; skipped: number }> {
  const firestore = admin.firestore();
  const state = await firestore.doc(STATE_DOC).get();
  const since = collectionStart(state.get("lastRunAt"), runStart);

  const writer = firestore.bulkWriter();
  let failed = 0;
  const totals = { documents: 0, events: 0, skipped: 0 };
  for (const source of Object.keys(AUDIT_SOURCES) as AuditSource[]) {
    const field = AUDIT_SOURCES[source];
    const query = firestore.collection(source).where(field, ">", Timestamp.fromDate(since)).orderBy(field);
    await forEachPage(query, SOURCE_PAGE_SIZE, async (docs) => {
      const result = collectChangedEvents(
        docs.map((doc) => ({ source, uid: doc.id, data: doc.data() })),
        since,
        runStart,
        settings,
      );
      totals.documents += result.documents;
      totals.events += result.events.length;
      totals.skipped += result.skipped;
      for (const event of result.events) {
        writeEvent(writer, event).catch((error) => {
          failed++;
          functions.logger.error(`podcast audit write failed: ${event.collection}/${event.id}`, error);
        });
      }
      // Bounds what the writer holds to one page of events.
      await writer.flush();
    });
  }
  await writer.close();
  if (failed > 0) {
    throw new Error(`${failed} podcast audit write(s) failed; the last-run mark was not moved`);
  }

  await firestore.doc(STATE_DOC).set({ lastRunAt: Timestamp.fromDate(runStart) });
  return { since: since.toISOString(), ...totals };
}

function writeEvent(writer: BulkWriter, event: AuditEvent): Promise<unknown> {
  const ref = admin.firestore().collection(event.collection).doc(event.id);
  return writer.set(ref, { ...event.data, timestamp: Timestamp.fromDate(event.data.timestamp) });
}

/**
 * Feed ids an admin denied, read the way the app reads them.
 *
 * Only the explicit deny list applies: category blocking needs each podcast's categories from
 * Podcast Index, which this job does not fetch for every ranked podcast.
 */
async function getDeniedPodcastIds(settingsMetadata: DocumentData | undefined): Promise<Set<string>> {
  const firestore = admin.firestore();
  const count = denyDocCountFrom(settingsMetadata);
  if (count === 0) {
    return new Set();
  }
  const refs = Array.from({ length: count }, (_, i) => firestore.collection("settings_app").doc(`admin_deny${i + 1}`));
  const docs = await firestore.getAll(...refs);
  return deniedPodcastIdsFrom(docs.map((doc) => doc.data()));
}

async function readRecordsSince(collection: string, since: Date): Promise<AuditRecord[]> {
  const query = admin
    .firestore()
    .collection(collection)
    .where("timestamp", ">", Timestamp.fromDate(since))
    .orderBy("timestamp")
    // `timestamp` must be selected: paging continues after the last document by
    // its orderBy field, and a cursor built from a document without it fails.
    .select("podcast_id", "user_guid", "action", "timestamp");
  const records: AuditRecord[] = [];
  await forEachPage(query, AUDIT_PAGE_SIZE, (docs) => {
    for (const doc of docs) {
      records.push(doc.data());
    }
  });
  return records;
}

/**
 * The hand-picked lists the app showed before these rankings, as metadata sources.
 *
 * The chunk counts default to 1 when absent, as the app reads them.
 */
async function readCuratedLists(settingsMetadata: DocumentData | undefined): Promise<unknown[][]> {
  const featured = (settingsMetadata?.podcasts_featured ?? {}) as Record<string, unknown>;
  const chunks = (value: unknown): number => {
    const number = Number(value);
    return Number.isInteger(number) && number >= 0 ? number : 1;
  };
  const sources = [
    { prefix: "popular_podcasts", field: "popular_podcasts", count: chunks(featured.number_of_popular_podcasts) },
    {
      prefix: "popular_converted_podcasts",
      field: "popular_converted_podcasts",
      count: chunks(featured.number_of_popular_converted_podcasts),
    },
  ];
  const firestore = admin.firestore();
  const refs = sources.flatMap(({ prefix, field, count }) =>
    Array.from({ length: count }, (_, i) => ({ ref: firestore.doc(`settings_app/${prefix}_${i + 1}`), field })),
  );
  if (refs.length === 0) {
    return [];
  }
  const docs = await firestore.getAll(...refs.map(({ ref }) => ref));
  return docs.map((doc, i) => listField(doc.data(), refs[i].field));
}

/** Yesterday's entries, so a podcast that stays ranked is looked up only once. */
async function readPreviousRankings(): Promise<unknown[][]> {
  const firestore = admin.firestore();
  const docs = await firestore.getAll(...RANKING_DOCS.map((id) => firestore.doc(`${RANKING_COLLECTION}/${id}`)));
  return docs.map((doc) => listField(doc.data(), "popular_podcasts"));
}

/** Podcast Index lookups shared by both rankings, or none when the keys are missing. */
function cachedLookup(settingsMetadata: DocumentData | undefined): MetadataLookup | undefined {
  const keys = podcastIndexKeysFrom(settingsMetadata);
  if (!keys) {
    functions.logger.warn("popular podcasts: no Podcast Index keys in settings_app/settings_metadata; no lookups");
    return undefined;
  }
  const lookup = podcastIndexLookup(keys, {
    onError: (id, reason) => functions.logger.warn(`popular podcasts: Podcast Index lookup failed for ${id}: ${reason}`),
  });
  const cache = new Map<number, Promise<PodcastMetadata | null>>();
  return (id) => {
    let result = cache.get(id);
    if (!result) {
      result = lookup(id);
      cache.set(id, result);
    }
    return result;
  };
}

async function saveRanking(docId: string, ranking: RankedPodcastEntry[]): Promise<void> {
  await admin.firestore().collection(RANKING_COLLECTION).doc(docId).set({
    popular_podcasts: ranking,
    date_added: Timestamp.now(),
    date_updated: Timestamp.now(),
  });
}
