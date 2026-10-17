import * as functions from "firebase-functions";
import {
  GOOGLE_PLAY_SUBSCRIPTION_TOPIC,
  REGION,
  SUBSCRIPTION_SECRETS,
  SUBSCRIPTION_SERVICE_ACCOUNT,
} from "../../config/constants";
import { handleGoogleSubscriptionNotifications } from "../../handlers/verifiedSubscriptionHandlers";

export const googleSubscriptionNotifications = functions
  .region(REGION)
  .runWith({
    serviceAccount: SUBSCRIPTION_SERVICE_ACCOUNT,
    // A Play Store resubscription is claimed through the binding its expired
    // purchase carried, which only the secret can derive.
    secrets: [SUBSCRIPTION_SECRETS.accountBindingHmacKey],
    timeoutSeconds: 120,
    failurePolicy: true,
  })
  .pubsub.topic(GOOGLE_PLAY_SUBSCRIPTION_TOPIC)
  .onPublish(handleGoogleSubscriptionNotifications);
