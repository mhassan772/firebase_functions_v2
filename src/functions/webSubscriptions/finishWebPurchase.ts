import * as functions from "firebase-functions";
import { REGION, STRIPE_WEB_SECRETS } from "../../config/constants";
import { handleFinishWebPurchase } from "../../handlers/webPurchaseHandlers";
import { webCallableDeps } from "./deps";

/** Settles a web purchase after the page handled a card authentication. See docs/web_subscriptions.md. */
export const finishWebPurchase = functions
  .region(REGION)
  .runWith({ secrets: [STRIPE_WEB_SECRETS.secretKey], timeoutSeconds: 60 })
  .https.onCall((data, context) => handleFinishWebPurchase(data, context, webCallableDeps()));
