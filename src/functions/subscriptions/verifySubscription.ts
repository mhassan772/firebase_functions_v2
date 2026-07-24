import * as functions from "firebase-functions";
import {
  REGION,
  SUBSCRIPTION_SECRETS,
  SUBSCRIPTION_SERVICE_ACCOUNT,
} from "../../config/constants";
import { handleVerifySubscription } from "../../handlers/verifiedSubscriptionHandlers";

export const verifySubscription = functions
  .region(REGION)
  .runWith({
    serviceAccount: SUBSCRIPTION_SERVICE_ACCOUNT,
    secrets: [
      SUBSCRIPTION_SECRETS.accountBindingHmacKey,
      SUBSCRIPTION_SECRETS.appleIssuerId,
      SUBSCRIPTION_SECRETS.appleKeyId,
      SUBSCRIPTION_SECRETS.applePrivateKey,
    ],
    timeoutSeconds: 120,
  })
  .https.onCall(handleVerifySubscription);
