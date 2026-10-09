import * as functions from "firebase-functions";
import { REGION } from "../../config/constants";
import { handleConvertAuditChange } from "../../handlers/podcastAuditTriggerHandlers";

/**
 * Writes an event to `converted_podcast_audit` when a synced conversion list gains a podcast.
 *
 * Temporary: it exists for app versions older than the release that writes a top-level
 * `updatedAt` on `converted_podcasts`, which popularPodcastsV1 collects from
 * instead. Turn it off as described in docs/podcast-charts.md, "Turn off after about 6 months".
 */
export const podcastConvertAuditTrigger = functions
  .region(REGION)
  .firestore.document("converted_podcasts/{uid}")
  .onWrite((change, context) => handleConvertAuditChange(change, context.params.uid));
