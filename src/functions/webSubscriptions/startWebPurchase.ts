import * as functions from "firebase-functions";
import { REGION, STRIPE_WEB_SECRETS } from "../../config/constants";
import { handleStartWebPurchase } from "../../handlers/webPurchaseHandlers";
import { webCallableDeps } from "./deps";

/** Buys a web plan with a Payment Element confirmation token. See docs/web_subscriptions.md. */
export const startWebPurchase = functions
  .region(REGION)
  .runWith({ secrets: [STRIPE_WEB_SECRETS.secretKey], timeoutSeconds: 120 })
  .https.onCall((data, context) => handleStartWebPurchase(data, context, webCallableDeps()));
