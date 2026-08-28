import * as functions from "firebase-functions";
import { REGION, SUBSCRIPTION_SERVICE_ACCOUNT } from "../../config/constants";
import { handleManageSubscriptionDevice } from "../../handlers/verifiedSubscriptionHandlers";

export const manageSubscriptionDevice = functions
  .region(REGION)
  .runWith({
    serviceAccount: SUBSCRIPTION_SERVICE_ACCOUNT,
    timeoutSeconds: 60,
  })
  .https.onCall(handleManageSubscriptionDevice);
