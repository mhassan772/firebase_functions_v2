import * as functions from "firebase-functions";
import { REGION } from "../../config/constants";
import { handleCommunityGoalRecountChange } from "../../handlers/communityGoalJobHandlers";

/** Stops a minute before the timeout, so the recount saves its cursor for the hourly job. */
const TIMEOUT_SECONDS = 540;

/**
 * Recounts a community goal month when the portal changes its dates or cap, and sets
 * `recount.requestedAt`. Every other write to the month is ignored. See docs/community-goal.md.
 */
export const communityGoalRecountTrigger = functions
  .region(REGION)
  .runWith({ timeoutSeconds: TIMEOUT_SECONDS, memory: "512MB" })
  .firestore.document("community_goals/{key}")
  .onWrite((change, context) =>
    handleCommunityGoalRecountChange(change, context.params.key, Date.now() + (TIMEOUT_SECONDS - 60) * 1000),
  );
