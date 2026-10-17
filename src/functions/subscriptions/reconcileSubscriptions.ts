import * as functions from "firebase-functions";
import {
  REGION,
  SUBSCRIPTION_SECRETS,
  SUBSCRIPTION_SERVICE_ACCOUNT,
} from "../../config/constants";
import { handleReconcileSubscriptions } from "../../handlers/subscriptionReconcileHandlers";

/**
 * Recovers what the live notification paths missed: retries Play
 * acknowledgements before their deadline, replays Play's voided purchases and
 * Apple's notification history from the last checkpoint. See
 * docs/subscription_backend_versions.md for the version this shipped in.
 */
export const reconcileSubscriptions = functions
  .region(REGION)
  .runWith({
    serviceAccount: SUBSCRIPTION_SERVICE_ACCOUNT,
    secrets: [
      SUBSCRIPTION_SECRETS.accountBindingHmacKey,
      SUBSCRIPTION_SECRETS.appleIssuerId,
      SUBSCRIPTION_SECRETS.appleKeyId,
      SUBSCRIPTION_SECRETS.applePrivateKey,
    ],
    timeoutSeconds: 540,
  })
  .pubsub.schedule("every 6 hours")
  .onRun(async () => {
    await handleReconcileSubscriptions();
  });
