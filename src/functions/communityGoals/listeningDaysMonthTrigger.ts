import * as functions from "firebase-functions";
import { REGION } from "../../config/constants";
import { handleListeningDaysChange } from "../../handlers/communityGoalTriggerHandlers";

/**
 * Keeps each user's value for the community goal months in `listener_totals/{uid}.months` as the
 * app uploads its listening days. See docs/community-goal.md.
 */
export const listeningDaysMonthTrigger = functions
  .region(REGION)
  .firestore.document("listening_history/{uid}/chunks/{year}")
  .onWrite((change, context) => handleListeningDaysChange(change, context.params.uid, context.params.year));
