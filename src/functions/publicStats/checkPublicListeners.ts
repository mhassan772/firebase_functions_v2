import * as functions from "firebase-functions";
import { REGION } from "../../config/constants";
import { handleCheckPublicListeners } from "../../handlers/publicStatsHandlers";

/**
 * Recounts listeners once a month and corrects `public_stats/site` if the running count kept by
 * the listen-time triggers has drifted. See docs/listening-stats.md.
 */
export const checkPublicListeners = functions
  .region(REGION)
  .runWith({ timeoutSeconds: 300, memory: "256MB" })
  .pubsub.schedule("1 of month 03:00")
  .timeZone("Europe/Berlin")
  .onRun(() => handleCheckPublicListeners());
