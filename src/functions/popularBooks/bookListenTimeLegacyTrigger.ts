import * as functions from "firebase-functions";
import { REGION } from "../../config/constants";
import { handleBookListenTimeChange } from "../../handlers/bookListenTriggerHandlers";

/**
 * Records growth in a user's listening time per book from `device_sessions`, which app
 * versions before 90.3 sync. It can be turned off once almost nobody uses those versions.
 */
export const bookListenTimeLegacyTrigger = functions
  .region(REGION)
  .firestore.document("device_sessions/{uid}")
  .onWrite((change, context) => handleBookListenTimeChange(change, context.params.uid, "device_sessions"));
