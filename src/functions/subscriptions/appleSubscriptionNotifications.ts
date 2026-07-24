import * as functions from "firebase-functions";
import {
  REGION,
  SUBSCRIPTION_SECRETS,
  SUBSCRIPTION_SERVICE_ACCOUNT,
} from "../../config/constants";
import { handleAppleSubscriptionNotifications } from "../../handlers/verifiedSubscriptionHandlers";

export const appleSubscriptionNotifications = functions
  .region(REGION)
  .runWith({
    serviceAccount: SUBSCRIPTION_SERVICE_ACCOUNT,
    secrets: [
      SUBSCRIPTION_SECRETS.appleIssuerId,
      SUBSCRIPTION_SECRETS.appleKeyId,
      SUBSCRIPTION_SECRETS.applePrivateKey,
    ],
    timeoutSeconds: 120,
  })
  .https.onRequest(handleAppleSubscriptionNotifications);
