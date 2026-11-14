import * as functions from "firebase-functions";
import { admin } from "../../config/admin";
import { REGION, STRIPE_WEB_SECRETS } from "../../config/constants";
import { handleStripeWebhook } from "../../handlers/webSubscriptionEventHandlers";
import { webGatewayFromEnv, webhookSecretFromEnv } from "./deps";

/**
 * Stripe's webhook for the web subscriptions account. Every handled event syncs the account it
 * is about from Stripe; see docs/web_subscriptions.md.
 */
export const stripeWebEvents = functions
  .region(REGION)
  .runWith({ secrets: [STRIPE_WEB_SECRETS.secretKey, STRIPE_WEB_SECRETS.webhookSecret], timeoutSeconds: 120 })
  .https.onRequest(async (req, res) => {
    const result = await handleStripeWebhook(
      { method: req.method, rawBody: req.rawBody, header: (name) => req.header(name) },
      { firestore: admin.firestore(), gateway: webGatewayFromEnv(), webhookSecret: webhookSecretFromEnv() }
    );
    res.status(result.status).json(result.body);
  });
