import * as functions from "firebase-functions";
import { REGION } from "../../config/constants";
import { handleRefreshPublicStats } from "../../handlers/publicStatsHandlers";

/**
 * Rebuilds hours listened, audiobooks and donors in `public_stats/site`, which the donation site
 * shows. See docs/listening-stats.md.
 */
export const refreshPublicStats = functions
  .region(REGION)
  .runWith({ timeoutSeconds: 300, memory: "256MB" })
  .pubsub.schedule("every day 00:35")
  .timeZone("Europe/Berlin")
  .onRun(() => handleRefreshPublicStats());
