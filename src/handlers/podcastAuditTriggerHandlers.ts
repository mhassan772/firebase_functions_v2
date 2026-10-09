import * as functions from "firebase-functions";
import { Timestamp } from "firebase-admin/firestore";
import { admin } from "../config/admin";
import {
  AuditEventsResult,
  convertEventsForChange,
  followEventsForChange,
  resolvePopularPodcastsSettings,
  withinRetention,
} from "./podcastAuditHandlers";
import { getSettings } from "./recordingUrlHandlers";

type Change = functions.Change<functions.firestore.DocumentSnapshot>;

/** How long an instance reuses the settings it read; they change rarely. */
const SETTINGS_TTL_MS = 10 * 60 * 1000;

let cachedRetention: { days: number; readAt: number } | undefined;

/** Records follows added in a `podcast_subscriptions/{uid}` write. */
export function handleFollowAuditChange(change: Change, uid: string): Promise<void> {
  const now = new Date();
  return writeAuditEvents(
    "follow",
    uid,
    now,
    followEventsForChange(uid, change.before.data(), change.after.data(), now, Number.POSITIVE_INFINITY),
  );
}

/** Records conversions added in a `converted_podcasts/{uid}` write. */
export function handleConvertAuditChange(change: Change, uid: string): Promise<void> {
  const now = new Date();
  return writeAuditEvents(
    "convert",
    uid,
    now,
    convertEventsForChange(uid, change.before.data(), change.after.data(), now, Number.POSITIVE_INFINITY),
  );
}

/**
 * Writes the added items still within retention.
 *
 * Most writes add nothing, so the settings are read only once something was added.
 */
async function writeAuditEvents(action: string, uid: string, now: Date, candidates: AuditEventsResult): Promise<void> {
  if (candidates.skipped > 0) {
    functions.logger.warn(`podcast ${action} audit: ${candidates.skipped} item(s) skipped for unreadable data`, { uid });
  }
  if (candidates.events.length === 0) {
    return;
  }
  const events = withinRetention(candidates.events, now, await retentionDays());
  if (events.length === 0) {
    return;
  }
  const firestore = admin.firestore();
  // The id is fixed, so a repeat only rewrites the same date.
  await Promise.all(
    events.map((event) =>
      firestore
        .collection(event.collection)
        .doc(event.id)
        .set({ ...event.data, timestamp: Timestamp.fromDate(event.data.timestamp) }),
    ),
  );
  functions.logger.info(`podcast ${action} audit: ${events.length} written`, { uid });
}

async function retentionDays(): Promise<number> {
  if (!cachedRetention || Date.now() - cachedRetention.readAt > SETTINGS_TTL_MS) {
    cachedRetention = { days: resolvePopularPodcastsSettings(await getSettings()).retentionDays, readAt: Date.now() };
  }
  return cachedRetention.days;
}
