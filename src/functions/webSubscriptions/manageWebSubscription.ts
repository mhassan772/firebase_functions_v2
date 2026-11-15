import * as functions from "firebase-functions";
import { REGION, STRIPE_WEB_SECRETS } from "../../config/constants";
import { handleManageWebSubscription } from "../../handlers/webManageHandlers";
import { webCallableDeps } from "./deps";

/** Cancels, resumes or changes the card of the signed-in account's web subscription. See docs/web_subscriptions.md. */
export const manageWebSubscription = functions
  .region(REGION)
  .runWith({ secrets: [STRIPE_WEB_SECRETS.secretKey], timeoutSeconds: 120 })
  .https.onCall((data, context) => handleManageWebSubscription(data, context, webCallableDeps()));
