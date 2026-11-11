import * as functions from "firebase-functions";
import { REGION } from "../../config/constants";
import { handleSweepDeletedAccounts } from "../../handlers/accountDeletionHandlers";
import { accountDeletionDeps } from "./accountDeletionDeps";

/**
 * Re-runs the purge for every deleted account still open, clearing what a device that stayed
 * signed in wrote afterwards, and closes each one that comes out clean. See docs/account_deletion.md.
 */
export const sweepDeletedAccounts = functions
  .region(REGION)
  .runWith({ timeoutSeconds: 540, memory: "512MB" })
  .pubsub.schedule("every monday 03:00")
  .timeZone("UTC")
  .onRun(async () => {
    await handleSweepDeletedAccounts(accountDeletionDeps());
  });
