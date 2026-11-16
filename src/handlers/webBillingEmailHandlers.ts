import { DocumentData, Firestore, Timestamp } from "firebase-admin/firestore";
import * as functions from "firebase-functions";
import { DELETED_ACCOUNTS_COLLECTION } from "../services/accountDeletion/tombstone";
import { senderName } from "../services/email/authEmailTemplates";
import { BillingEmailIncompleteError, BillingKind, renderBillingEmail } from "../services/email/billingEmailTemplates";
import { Mailer } from "../services/email/sesMailer";
import { safeErrorCode } from "../services/subscriptions/errors";
import { BILLING_EMAIL_KINDS, WEB_EMAIL_OUTBOX_COLLECTION } from "../services/webSubscriptions/billingEmails";
import { readWebPricingConfig } from "../services/webSubscriptions/pricing";
import { timestampDate } from "../services/subscriptions/persistence";
import { errorCodeOf } from "../utils/callableAuth";

/** The slice of the Admin SDK's Auth the sender reads; `admin.auth()` satisfies it. */
export interface BillingEmailAuth {
  getUser(uid: string): Promise<{ uid: string; email?: string }>;
}

export interface BillingEmailSenderDeps {
  firestore: Firestore;
  auth: BillingEmailAuth;
  mailer: Mailer;
  now: () => Date;
}

/** Sends this many times at most; the platform retries a thrown attempt. */
export const BILLING_EMAIL_MAX_ATTEMPTS = 5;
/** An email queued longer ago than this is no longer worth sending. */
export const BILLING_EMAIL_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** SES answers that will not change on a retry. */
const PERMANENT_SES_ERRORS = new Set([
  "MessageRejected",
  "BadRequestException",
  "NotFoundException",
  "MailFromDomainNotVerifiedException",
]);

/** Thrown so the platform retries the delivery; the attempt is already counted. */
export class BillingEmailRetry extends Error {
  constructor(readonly attempts: number) {
    super(`Billing email send failed, attempt ${attempts}; retrying.`);
    this.name = "BillingEmailRetry";
  }
}

export type BillingEmailSendOutcome = "sent" | "skipped" | "failed" | "not_queued";

/**
 * Sends one queued billing email, for the `sendWebBillingEmail` trigger.
 *
 * Skipped (and marked with a reason) when emails are switched off, the account was deleted,
 * the Auth user or its address is gone, or the email waited more than a day. A transient SES
 * failure counts an attempt and throws, so the platform retries; after five attempts, or on a
 * permanent failure, the email is marked `failed`. A document no longer `queued` is left as
 * it is, so a retried delivery never sends twice once one attempt was marked `sent`.
 */
export async function handleWebBillingEmail(id: string, deps: BillingEmailSenderDeps): Promise<BillingEmailSendOutcome> {
  const ref = deps.firestore.collection(WEB_EMAIL_OUTBOX_COLLECTION).doc(id);
  const snapshot = await ref.get();
  const data = snapshot.data();
  const fields = { id, kind: typeof data?.kind === "string" ? data.kind : null, uid: typeof data?.uid === "string" ? data.uid : null };
  if (!data || data.status !== "queued") {
    functions.logger.info("web_email_send_outcome", { ...fields, outcome: "not_queued", status: data?.status ?? null });
    return "not_queued";
  }
  const now = deps.now();
  const settle = async (status: "sent" | "skipped" | "failed", reason?: string): Promise<BillingEmailSendOutcome> => {
    await deps.firestore.runTransaction(async (transaction) => {
      const current = await transaction.get(ref);
      if (current.get("status") !== "queued") return;
      transaction.update(ref, {
        status,
        ...(reason ? { reason } : {}),
        ...(status === "sent" ? { sentAt: Timestamp.fromDate(now) } : {}),
      });
    });
    const log = status === "failed" ? functions.logger.error : functions.logger.info;
    log("web_email_send_outcome", { ...fields, outcome: status, reason: reason ?? null });
    return status;
  };

  const uid = fields.uid;
  const kind = fields.kind;
  if (!uid || !kind || !(BILLING_EMAIL_KINDS as readonly string[]).includes(kind)) return settle("failed", "malformed");
  if (!(await readWebPricingConfig(deps.firestore)).emailsEnabled) return settle("skipped", "emails_disabled");
  if ((await deps.firestore.collection(DELETED_ACCOUNTS_COLLECTION).doc(uid).get()).exists) {
    return settle("skipped", "account_deleted");
  }
  let email: string | undefined;
  try {
    email = (await deps.auth.getUser(uid)).email;
  } catch (error) {
    if (errorCodeOf(error) === "auth/user-not-found") return settle("skipped", "no_user");
    throw error;
  }
  if (!email) return settle("skipped", "no_email");
  const createdAt = timestampDate(data.createdAt);
  if (!createdAt || now.getTime() - createdAt.getTime() > BILLING_EMAIL_MAX_AGE_MS) return settle("skipped", "stale");

  const lang = data.lang === "en" ? "en" : "ar";
  let rendered;
  try {
    rendered = renderBillingEmail(kind as BillingKind, lang, contentOf(data));
  } catch (error) {
    if (error instanceof BillingEmailIncompleteError) return settle("failed", `incomplete_${error.field}`);
    throw error;
  }

  try {
    await deps.mailer.send({ ...rendered, to: email, fromName: senderName(lang) });
  } catch (error) {
    const name = error instanceof Error ? error.name : "unknown";
    if (PERMANENT_SES_ERRORS.has(name)) return settle("failed", `ses_${name}`);
    const attempts = await deps.firestore.runTransaction(async (transaction) => {
      const current = await transaction.get(ref);
      const count = (typeof current.get("attempts") === "number" ? current.get("attempts") : 0) + 1;
      if (current.get("status") === "queued") transaction.update(ref, { attempts: count });
      return count;
    });
    functions.logger.warn("web_email_send_retry", { ...fields, attempts, errorName: name, code: safeErrorCode(error) });
    if (attempts >= BILLING_EMAIL_MAX_ATTEMPTS) return settle("failed", "retries_exhausted");
    throw new BillingEmailRetry(attempts);
  }
  return settle("sent");
}

function contentOf(data: DocumentData) {
  const cents = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
  return {
    plan: typeof data.plan === "string" ? data.plan : undefined,
    amount: cents(data.amount),
    credit: cents(data.credit),
    creditedPlan: typeof data.creditedPlan === "string" ? data.creditedPlan : undefined,
    tax: cents(data.tax),
    total: cents(data.total),
    currency: typeof data.currency === "string" ? data.currency : undefined,
    renewsAt: timestampDate(data.renewsAt),
    endsAt: timestampDate(data.endsAt),
    graceEndsAt: timestampDate(data.graceEndsAt),
    cardExpiresFirst: data.cardExpiresFirst === true,
    livemode: data.livemode === true,
  };
}
