import * as functions from "firebase-functions";
import { REGION, STRIPE_WEB_SECRETS } from "../../config/constants";
import { handleGetWebSubscription } from "../../handlers/webManageHandlers";
import { webCallableDeps } from "./deps";

/** The signed-in account's web purchase, for /manage. See docs/web_subscriptions.md. */
export const getWebSubscription = functions
  .region(REGION)
  .runWith({ secrets: [STRIPE_WEB_SECRETS.secretKey, STRIPE_WEB_SECRETS.publishableKey], timeoutSeconds: 60 })
  .https.onCall((data, context) => handleGetWebSubscription(data, context, webCallableDeps()));
