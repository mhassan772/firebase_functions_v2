import * as functions from "firebase-functions";
import {
  REGION,
  STRIPE_WEB_SECRETS,
  SUBSCRIPTION_SECRETS,
  SUBSCRIPTION_SERVICE_ACCOUNT,
} from "../../config/constants";
import { handleReconcileSubscriptions } from "../../handlers/subscriptionReconcileHandlers";
import { webSyncDepsFromEnv } from "../webSubscriptions/deps";

/**
 * Recovers what the live notification paths missed: retries Play
 * acknowledgements before their deadline, replays Play's voided purchases and
 * Apple's notification history from the last checkpoint, and Stripe's event
 * history for web subscriptions, then settles stale pending web purchases. See
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
      STRIPE_WEB_SECRETS.secretKey,
    ],
    timeoutSeconds: 540,
  })
  .pubsub.schedule("every 6 hours")
  .onRun(async () => {
    // Built inside the run, so a malformed Stripe key fails the web phases only.
    await handleReconcileSubscriptions({ webDeps: webSyncDepsFromEnv });
  });
