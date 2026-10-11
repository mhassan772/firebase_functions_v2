import * as functions from "firebase-functions";
import { REGION } from "../../config/constants";
import { handleAdminManageSubscription } from "../../handlers/adminSubscriptionHandlers";

// Runs as the default service account: it lists Firebase Auth users to map
// hashed ids back to accounts, which the subscription verifier identity cannot.
export const adminManageSubscription = functions
  .region(REGION)
  .runWith({
    timeoutSeconds: 540,
    memory: "512MB",
  })
  .https.onCall(handleAdminManageSubscription);
