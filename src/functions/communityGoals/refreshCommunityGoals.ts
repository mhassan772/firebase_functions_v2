import * as functions from "firebase-functions";
import { REGION } from "../../config/constants";
import { handleRefreshCommunityGoals } from "../../handlers/communityGoalJobHandlers";

/** Stops a minute before the timeout, so a recount it resumes saves its cursor. */
const TIMEOUT_SECONDS = 300;

/**
 * Creates the coming community goal months, sums the open ones, closes them and resumes
 * recounts, every hour. See docs/community-goal.md.
 */
export const refreshCommunityGoals = functions
  .region(REGION)
  .runWith({ timeoutSeconds: TIMEOUT_SECONDS, memory: "256MB" })
  .pubsub.schedule("every 60 minutes")
  .timeZone("Europe/Berlin")
  .onRun(() => handleRefreshCommunityGoals(new Date(), Date.now() + (TIMEOUT_SECONDS - 60) * 1000));
