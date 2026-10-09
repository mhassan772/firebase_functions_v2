import * as functions from "firebase-functions";
import { REGION } from "../../config/constants";
import { handleBookListenTimeChange } from "../../handlers/bookListenTriggerHandlers";

/**
 * Records growth in a user's listening time per book from `device_sessions_v2`, which app
 * versions 90.3 and later sync. mostPopularBooksV3 counts listeners from what it writes.
 */
export const bookListenTimeTrigger = functions
  .region(REGION)
  .firestore.document("device_sessions_v2/{uid}")
  .onWrite((change, context) => handleBookListenTimeChange(change, context.params.uid, "device_sessions_v2"));
