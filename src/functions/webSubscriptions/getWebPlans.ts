import * as functions from "firebase-functions";
import { REGION, STRIPE_WEB_SECRETS } from "../../config/constants";
import { handleGetWebPlans } from "../../handlers/webPurchaseHandlers";
import { webCallableDeps } from "./deps";

/** The plans and prices /subscribe shows the signed-in account. See docs/web_subscriptions.md. */
export const getWebPlans = functions
  .region(REGION)
  .runWith({ secrets: [STRIPE_WEB_SECRETS.secretKey, STRIPE_WEB_SECRETS.publishableKey], timeoutSeconds: 30 })
  .https.onCall((data, context) => handleGetWebPlans(data, context, webCallableDeps()));
