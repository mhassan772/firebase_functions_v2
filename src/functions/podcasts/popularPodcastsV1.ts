import * as functions from "firebase-functions";
import { REGION } from "../../config/constants";
import { handlePopularPodcasts } from "../../handlers/popularPodcastsHandlers";

/**
 * Collects podcast engagement synced since the last run, rebuilds the two rankings in
 * `popular_podcasts_v2`, and prunes old audit records. See docs/podcast-charts.md.
 *
 * Runs after mostPopularBooksV3 so the two jobs do not overlap.
 */
export const popularPodcastsV1 = functions
  .region(REGION)
  .runWith({ timeoutSeconds: 540, memory: "512MB" })
  .pubsub.schedule("every day 00:15")
  .timeZone("Europe/Berlin")
  .onRun(() => handlePopularPodcasts());
