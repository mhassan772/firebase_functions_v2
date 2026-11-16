import { DocumentData, Firestore, Timestamp } from "firebase-admin/firestore";
import * as functions from "firebase-functions";
import { DELETED_ACCOUNTS_COLLECTION } from "../accountDeletion/tombstone";
import { safeErrorCode } from "../subscriptions/errors";
import {
  stateDocumentId,
  STATE_SLOTS,
  SUBSCRIPTION_STATE_COLLECTION,
  timestampDate,
  webSlotIndex,
} from "../subscriptions/persistence";
import { customerIdFor, readCustomerMapping } from "./customers";
import { isWebPlan, ledgerEntryFromData, WEB_PURCHASES_COLLECTION, WebPurchaseEntry } from "./ledger";
import { savedCardOf } from "./pricing";
import { idOf, stripeErrorCode } from "./stripeGateway";
import { syncWebEntitlement, WebSyncDeps, WebSyncNotice } from "./sync";

/**
 * `web_email_outbox/{id}`: billing emails waiting for `sendWebBillingEmail`.
 *
 * Nothing that talks to Stripe sends mail: it writes here, and one Firestore trigger sends.
 * Each occurrence has a deterministic id and is written with `create()`, so a replayed event,
 * a second sync or a retried call never queues it twice. Server-only (the rules' catch-all
 * deny). No email address, name or card detail is stored; the sender looks the address up.
 */
export const WEB_EMAIL_OUTBOX_COLLECTION = "web_email_outbox";
export const WEB_EMAIL_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export const BILLING_EMAIL_KINDS = [
  "purchase_confirmed",
  "renewed",
  "payment_failed",
  "payment_failed_final",
  "action_required",
  "renewal_reminder",
  "cancellation_confirmed",
  "switched_yearly",
] as const;
export type BillingEmailKind = (typeof BILLING_EMAIL_KINDS)[number];
export type BillingEmailLang = "ar" | "en";

/** What a billing email says, beyond its kind. Amounts are integer cents. */
export interface BillingEmailFields {
  plan?: string;
  amount?: number;
  /** The credit for unused time (a plan switch, an upgrade to lifetime), a positive number. */
  credit?: number;
  /** An upgrade to lifetime: the plan whose unused time was credited and which has stopped. */
  creditedPlan?: string;
  tax?: number;
  total?: number;
  currency?: string;
  renewsAt?: Date;
  endsAt?: Date;
  graceEndsAt?: Date;
  cardExpiresFirst?: boolean;
}

export interface BillingEmail {
  id: string;
  uid: string;
  kind: BillingEmailKind;
  lang: BillingEmailLang;
  livemode: boolean;
  fields: BillingEmailFields;
}

const epochSeconds = (date: Date) => Math.floor(date.getTime() / 1000);

export const outboxIds = {
  confirmed: (purchaseId: string) => `confirmed_${purchaseId}`,
  renewed: (invoiceId: string) => `renewed_${invoiceId}`,
  failed: (invoiceId: string) => `failed_${invoiceId}`,
  failedFinal: (subscriptionId: string, graceEndsAt: Date) => `failed_final_${subscriptionId}_${epochSeconds(graceEndsAt)}`,
  action: (invoiceId: string) => `action_${invoiceId}`,
  reminder: (subscriptionId: string, renewsAt: Date) => `reminder_${subscriptionId}_${epochSeconds(renewsAt)}`,
  cancelled: (subscriptionId: string, paidThrough: Date) => `cancelled_${subscriptionId}_${epochSeconds(paidThrough)}`,
  switched: (purchaseId: string) => `switched_${purchaseId}`,
};

export function outboxData(email: BillingEmail, now: Date): DocumentData {
  const data: DocumentData = {
    uid: email.uid,
    kind: email.kind,
    lang: email.lang,
    livemode: email.livemode,
    status: "queued",
    attempts: 0,
    createdAt: Timestamp.fromDate(now),
    expiresAt: Timestamp.fromMillis(now.getTime() + WEB_EMAIL_RETENTION_MS),
  };
  for (const [key, value] of Object.entries(email.fields)) {
    if (value === undefined) continue;
    data[key] = value instanceof Date ? Timestamp.fromDate(value) : value;
  }
  return data;
}

export type QueueOutcome = "queued" | "exists" | "account_deleted";

/**
 * Queues one email. An account with a tombstone queues nothing; an occurrence already queued
 * (the same id) is left as it is and reported `exists`.
 */
export async function queueBillingEmail(db: Firestore, email: BillingEmail, now: Date): Promise<QueueOutcome> {
  if ((await db.collection(DELETED_ACCOUNTS_COLLECTION).doc(email.uid).get()).exists) return "account_deleted";
  try {
    await db.collection(WEB_EMAIL_OUTBOX_COLLECTION).doc(email.id).create(outboxData(email, now));
    return "queued";
  } catch (error) {
    // gRPC ALREADY_EXISTS: this occurrence was queued before.
    if ((error as { code?: unknown } | null)?.code === 6) return "exists";
    throw error;
  }
}

/** Queues each email on its own; one failure is logged and does not stop the others. */
export async function queueBillingEmails(
  db: Firestore,
  emails: BillingEmail[],
  now: Date,
  operationId: string
): Promise<QueueOutcome[]> {
  const outcomes: QueueOutcome[] = [];
  for (const email of emails) {
    try {
      const outcome = await queueBillingEmail(db, email, now);
      outcomes.push(outcome);
      functions.logger.info("web_email_queue", { operationId, uid: email.uid, kind: email.kind, id: email.id, outcome });
    } catch (error) {
      functions.logger.error("web_email_queue_failure", { operationId, uid: email.uid, kind: email.kind, code: safeErrorCode(error) });
    }
  }
  return outcomes;
}

// ---------------------------------------------------------------------------
// Emails decided from a change in the slot
// ---------------------------------------------------------------------------

interface SlotView {
  status?: string;
  productId?: string;
  expiresAt?: Date;
  subscriptionId?: string;
  purchaseId?: string;
  lastPaidInvoiceId?: string;
  paidThrough?: Date;
  cancelAtPeriodEnd: boolean;
  needsAction: boolean;
  paymentFailed: boolean;
}

function slotView(data: DocumentData | undefined): SlotView {
  const web = (data?.web ?? {}) as DocumentData;
  const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
  return {
    status: text(data?.status),
    productId: text(data?.productId),
    expiresAt: timestampDate(data?.expiresAt),
    subscriptionId: text(web.subscriptionId),
    purchaseId: text(web.purchaseId),
    lastPaidInvoiceId: text(web.lastPaidInvoiceId),
    paidThrough: timestampDate(web.paidThrough),
    cancelAtPeriodEnd: web.cancelAtPeriodEnd === true,
    needsAction: web.needsAction === true,
    paymentFailed: web.paymentFailed === true,
  };
}

export function langOfEntry(entry: Pick<WebPurchaseEntry, "lang"> | undefined): BillingEmailLang {
  return entry?.lang === "en" ? "en" : "ar";
}

/**
 * The emails one committed sync calls for, from the slot before and after it and the entries it
 * marked paid. Pure, so every row of the stage E table is tested without Firestore.
 *
 * Nothing is queued once access is revoked (a refund or a dispute), and a change on a different
 * subscription than before (a rebuilt or replaced slot) queues only first-payment confirmations.
 * A renewal that needs the bank's confirmation gets `action_required` instead of
 * `payment_failed`, and neither is sent once the grace has passed. A paid plan switch gets
 * `switched_yearly` in place of `purchase_confirmed`; the renewal it turns back on sends nothing
 * more, since the switch's own email says the plan renews. An upgrade to lifetime gets
 * `purchase_confirmed` with its credit and the stopped plan; the subscription it stops sends
 * nothing, since the slot moves to lifetime and no longer names it.
 */
export function decideSlotEmails(notice: WebSyncNotice): BillingEmail[] {
  const previous = slotView(notice.previous);
  const next = slotView(notice.next);
  if (next.status === "revoked") return [];
  const langOf = (purchaseId: string | undefined) =>
    langOfEntry(notice.entries.find((entry) => entry.purchaseId === purchaseId));
  const base = { uid: notice.uid, livemode: notice.livemode };
  const emails: BillingEmail[] = [];

  for (const entry of notice.becamePaid) {
    const subscriptionPlan = entry.plan !== "web_lifetime";
    const sameSubscription = subscriptionPlan && next.subscriptionId !== undefined &&
      (next.subscriptionId === entry.stripe.subscriptionId || next.purchaseId === entry.purchaseId);
    if (entry.kind === "switch") {
      emails.push({
        ...base,
        id: outboxIds.switched(entry.purchaseId),
        kind: "switched_yearly",
        lang: langOfEntry(entry),
        fields: {
          plan: entry.plan,
          amount: entry.amount,
          credit: entry.credit ?? 0,
          tax: entry.tax,
          total: entry.total,
          currency: entry.currency,
          ...(sameSubscription && next.paidThrough ? { renewsAt: next.paidThrough } : {}),
        },
      });
      continue;
    }
    emails.push({
      ...base,
      id: outboxIds.confirmed(entry.purchaseId),
      kind: "purchase_confirmed",
      lang: langOfEntry(entry),
      fields: {
        plan: entry.plan,
        amount: entry.amount,
        tax: entry.tax,
        total: entry.total,
        currency: entry.currency,
        ...(sameSubscription && next.paidThrough ? { renewsAt: next.paidThrough } : {}),
        // An upgrade to lifetime says what was credited and that the subscription has stopped.
        ...(entry.kind === "upgrade" ? { credit: entry.credit ?? 0, creditedPlan: entry.switchedFrom } : {}),
      },
    });
  }

  const subscriptionId = next.subscriptionId;
  if (!subscriptionId || previous.subscriptionId !== subscriptionId) return emails;
  const lang = langOf(next.purchaseId);
  const plan = next.productId;
  const facts = notice.subscription?.id === subscriptionId ? notice.subscription : undefined;
  const graceEndsAt = next.status === "grace_period" ? next.expiresAt : undefined;
  const inGrace = graceEndsAt !== undefined && graceEndsAt.getTime() > notice.now.getTime();

  const latestPaid = facts?.latestPaid;
  if (
    next.lastPaidInvoiceId && previous.lastPaidInvoiceId && next.lastPaidInvoiceId !== previous.lastPaidInvoiceId &&
    latestPaid?.id === next.lastPaidInvoiceId && latestPaid.billingReason === "subscription_cycle"
  ) {
    emails.push({
      ...base,
      id: outboxIds.renewed(latestPaid.id),
      kind: "renewed",
      lang,
      fields: { plan, amount: latestPaid.amountPaid, currency: latestPaid.currency, renewsAt: next.paidThrough },
    });
  }

  const open = facts?.latestOpen;
  if (!previous.needsAction && next.needsAction && open && open.billingReason === "subscription_cycle" && inGrace) {
    emails.push({ ...base, id: outboxIds.action(open.id), kind: "action_required", lang, fields: { plan, graceEndsAt } });
  } else if (!previous.paymentFailed && next.paymentFailed && !next.needsAction && open && inGrace) {
    emails.push({ ...base, id: outboxIds.failed(open.id), kind: "payment_failed", lang, fields: { plan, graceEndsAt } });
  }

  if (!previous.cancelAtPeriodEnd && next.cancelAtPeriodEnd && next.paidThrough && next.paidThrough.getTime() > notice.now.getTime()) {
    emails.push({
      ...base,
      id: outboxIds.cancelled(subscriptionId, next.paidThrough),
      kind: "cancellation_confirmed",
      lang,
      fields: { plan, endsAt: next.paidThrough },
    });
  }
  return emails;
}

/** The `notify` dependency of `syncWebEntitlement`: decides and queues. Never throws. */
export function billingNotifier(db: Firestore): (notice: WebSyncNotice) => Promise<void> {
  return async (notice) => {
    try {
      const emails = decideSlotEmails(notice);
      if (emails.length > 0) await queueBillingEmails(db, emails, notice.now, notice.operationId);
    } catch (error) {
      functions.logger.error("web_email_notify_failure", { operationId: notice.operationId, uid: notice.uid, code: safeErrorCode(error) });
    }
  };
}

// ---------------------------------------------------------------------------
// The renewal reminder (invoice.upcoming)
// ---------------------------------------------------------------------------

async function langOfPurchase(db: Firestore, purchaseId: string | undefined): Promise<BillingEmailLang> {
  if (!purchaseId) return "ar";
  try {
    return langOfEntry(ledgerEntryFromData(purchaseId, (await db.collection(WEB_PURCHASES_COLLECTION).doc(purchaseId).get()).data()));
  } catch {
    return "ar";
  }
}

/** True when a card valid through `expMonth`/`expYear` stops working before `date`. */
export function cardExpiresBefore(expMonth: number | undefined, expYear: number | undefined, date: Date): boolean {
  if (!expMonth || !expYear) return false;
  // Valid through the last day of its month: it stops at the first instant of the next one.
  return Date.UTC(expYear, expMonth, 1) <= date.getTime();
}

export type ReminderOutcome =
  | "queued"
  | "exists"
  | "account_deleted"
  | "not_ours"
  | "not_yearly"
  | "cancelling"
  | "not_active"
  | "renewal_passed";

/**
 * Queues the yearly renewal reminder for an `invoice.upcoming` event: only for a yearly plan
 * that is active and not cancelling, and only while the renewal is still ahead (the recovery
 * pass replays a month of events). The subscription is read from Stripe, never from the
 * event. No sync is needed.
 */
export async function queueRenewalReminder(
  deps: WebSyncDeps,
  uid: string,
  subscriptionId: string,
  upcoming: { total?: number; currency?: string },
  operationId: string
): Promise<ReminderOutcome> {
  const { firestore, gateway } = deps;
  const now = deps.now?.() ?? new Date();
  const customerId = customerIdFor(await readCustomerMapping(firestore, uid), gateway.livemode);
  const subscription = await gateway.retrieveSubscription(subscriptionId);
  if (!customerId || idOf(subscription.customer as string | { id: string }) !== customerId) return "not_ours";
  const item = subscription.items.data[0];
  const product = idOf(item?.price?.product as string | { id: string } | null);
  if (product !== "web_yearly") return "not_yearly";
  if (subscription.cancel_at_period_end || typeof subscription.cancel_at === "number") return "cancelling";
  if (subscription.status !== "active" && subscription.status !== "trialing") return "not_active";

  const slot = (await firestore
    .collection(SUBSCRIPTION_STATE_COLLECTION)
    .doc(slotDocId(uid, gateway.livemode))
    .get()).data();
  const view = slotView(slot);
  const renewsAt = view.subscriptionId === subscription.id && view.paidThrough
    ? view.paidThrough
    : new Date((item.current_period_end ?? 0) * 1000);
  if (renewsAt.getTime() <= now.getTime()) return "renewal_passed";

  const card = await savedCardOf(gateway, idOf(subscription.default_payment_method as string | { id: string } | null), customerId);
  const cardExpiresFirst = cardExpiresBefore(card?.expMonth ?? undefined, card?.expYear ?? undefined, renewsAt);
  const amount = typeof upcoming.total === "number" ? upcoming.total : item.price?.unit_amount ?? undefined;
  const email: BillingEmail = {
    id: outboxIds.reminder(subscription.id, renewsAt),
    uid,
    kind: "renewal_reminder",
    lang: await langOfPurchase(firestore, subscription.metadata?.purchaseId || view.purchaseId),
    livemode: gateway.livemode,
    fields: {
      plan: product,
      ...(typeof amount === "number" ? { amount, total: amount } : {}),
      currency: upcoming.currency ?? item.price?.currency,
      renewsAt,
      cardExpiresFirst,
    },
  };
  const outcome = await queueBillingEmail(firestore, email, now);
  functions.logger.info("web_email_queue", { operationId, uid, kind: email.kind, id: email.id, outcome, cardExpiresFirst });
  return outcome;
}

function slotDocId(uid: string, livemode: boolean): string {
  const slot = STATE_SLOTS[webSlotIndex(livemode)];
  return stateDocumentId(uid, slot.platform, slot.environment);
}

// ---------------------------------------------------------------------------
// The last warning (recovery pass)
// ---------------------------------------------------------------------------

/** A grace that ends within this long gets the last warning. */
export const FINAL_WARNING_WINDOW_MS = 48 * 60 * 60 * 1000;

export interface FinalWarningSummary {
  examined: number;
  queued: number;
  failed: number;
  completed: boolean;
}

/**
 * Queues `payment_failed_final` for every web slot of the key's mode in `grace_period` with a
 * failed payment whose grace ends within 48 hours. Each account is synced first, so a card
 * replaced since the last event is not warned about. Equality-only query, no composite index.
 */
export async function sweepFinalPaymentWarnings(
  deps: WebSyncDeps,
  options: { now: Date; deadline: Date; operationId: string }
): Promise<FinalWarningSummary> {
  const { firestore, gateway } = deps;
  const environment = STATE_SLOTS[webSlotIndex(gateway.livemode)].environment;
  const summary: FinalWarningSummary = { examined: 0, queued: 0, failed: 0, completed: false };
  const snapshot = await firestore
    .collection(SUBSCRIPTION_STATE_COLLECTION)
    .where("platform", "==", "web")
    .where("status", "==", "grace_period")
    .get();
  const within = (data: DocumentData | undefined) => {
    const view = slotView(data);
    const ends = view.expiresAt?.getTime();
    return view.status === "grace_period" && view.paymentFailed && view.subscriptionId !== undefined &&
      ends !== undefined && ends > options.now.getTime() && ends - options.now.getTime() <= FINAL_WARNING_WINDOW_MS;
  };
  for (const doc of snapshot.docs) {
    if (Date.now() >= options.deadline.getTime()) return summary;
    const data = doc.data();
    const uid = typeof data.uid === "string" ? data.uid : undefined;
    if (!uid || data.environment !== environment || !within(data)) continue;
    summary.examined += 1;
    try {
      await syncWebEntitlement(uid, deps, { operationId: options.operationId, trigger: "final_warning" });
      const current = (await doc.ref.get()).data();
      if (!within(current)) continue;
      const view = slotView(current);
      const outcome = await queueBillingEmail(firestore, {
        id: outboxIds.failedFinal(view.subscriptionId!, view.expiresAt!),
        uid,
        kind: "payment_failed_final",
        lang: await langOfPurchase(firestore, view.purchaseId),
        livemode: gateway.livemode,
        fields: { plan: isWebPlan(view.productId) ? view.productId : undefined, graceEndsAt: view.expiresAt },
      }, options.now);
      if (outcome === "queued") summary.queued += 1;
    } catch (error) {
      summary.failed += 1;
      functions.logger.error("web_final_warning_item_failure", {
        operationId: options.operationId,
        uid,
        code: stripeErrorCode(error) ?? safeErrorCode(error),
      });
    }
  }
  summary.completed = true;
  return summary;
}
