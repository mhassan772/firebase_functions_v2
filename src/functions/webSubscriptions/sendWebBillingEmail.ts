import * as functions from "firebase-functions";
import { admin } from "../../config/admin";
import { REGION } from "../../config/constants";
import { BillingEmailSenderDeps, handleWebBillingEmail } from "../../handlers/webBillingEmailHandlers";
import { sesMailer } from "../../services/email/sesMailer";
import { WEB_EMAIL_OUTBOX_COLLECTION } from "../../services/webSubscriptions/billingEmails";
import { AUTH_EMAIL_FUNCTION_SECRETS } from "../authEmails/deps";

let deps: BillingEmailSenderDeps | undefined;

function senderDeps(): BillingEmailSenderDeps {
  deps ??= { firestore: admin.firestore(), auth: admin.auth(), mailer: sesMailer, now: () => new Date() };
  return deps;
}

/**
 * Sends each billing email queued in `web_email_outbox`. The only web subscription code that
 * holds the SES secrets; retried by the platform on a transient failure. See
 * docs/web_subscriptions.md.
 */
export const sendWebBillingEmail = functions
  .region(REGION)
  .runWith({ secrets: AUTH_EMAIL_FUNCTION_SECRETS, timeoutSeconds: 60, failurePolicy: true })
  .firestore.document(`${WEB_EMAIL_OUTBOX_COLLECTION}/{id}`)
  .onCreate(async (snapshot) => {
    await handleWebBillingEmail(snapshot.id, senderDeps());
  });
