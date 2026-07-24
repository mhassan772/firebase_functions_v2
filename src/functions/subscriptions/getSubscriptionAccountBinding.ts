import * as functions from "firebase-functions";
import {
  REGION,
  SUBSCRIPTION_SECRETS,
  SUBSCRIPTION_SERVICE_ACCOUNT,
} from "../../config/constants";
import { handleGetSubscriptionAccountBinding } from "../../handlers/verifiedSubscriptionHandlers";

export const getSubscriptionAccountBinding = functions
  .region(REGION)
  .runWith({
    serviceAccount: SUBSCRIPTION_SERVICE_ACCOUNT,
    secrets: [SUBSCRIPTION_SECRETS.accountBindingHmacKey],
    timeoutSeconds: 60,
  })
  .https.onCall(handleGetSubscriptionAccountBinding);
