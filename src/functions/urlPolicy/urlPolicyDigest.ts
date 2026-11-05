import * as functions from "firebase-functions";
import { REGION } from "../../config/constants";
import { handleUrlPolicyDigest } from "../../handlers/urlPolicyDigestHandlers";

/**
 * Records the day's audio URL allowance picture in `url_policy_digest` for the
 * admin portal: the heaviest accounts, new guest ledgers, devices shared by many
 * guests and a histogram of recent book counts.
 */
export const urlPolicyDigest = functions
  .region(REGION)
  .runWith({ timeoutSeconds: 120 })
  .pubsub.schedule("every day 03:00")
  .timeZone("UTC")
  .onRun(async () => {
    await handleUrlPolicyDigest();
  });
