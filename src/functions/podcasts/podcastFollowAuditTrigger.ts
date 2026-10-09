import * as functions from "firebase-functions";
import { REGION } from "../../config/constants";
import { handleFollowAuditChange } from "../../handlers/podcastAuditTriggerHandlers";

/**
 * Writes an event to `podcast_audit` when a synced subscription list gains a podcast.
 *
 * Temporary: it exists for app versions older than the release that writes a top-level
 * `updatedAt` on `podcast_subscriptions`, which popularPodcastsV1 collects from
 * instead. Turn it off as described in docs/podcast-charts.md, "Turn off after about 6 months".
 */
export const podcastFollowAuditTrigger = functions
  .region(REGION)
  .firestore.document("podcast_subscriptions/{uid}")
  .onWrite((change, context) => handleFollowAuditChange(change, context.params.uid));
