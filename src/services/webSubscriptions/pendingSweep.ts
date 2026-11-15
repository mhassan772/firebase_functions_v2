import { Timestamp } from "firebase-admin/firestore";
import * as functions from "firebase-functions";
import { safeErrorCode } from "../subscriptions/errors";
import { ledgerEntryFromData, listPendingEntries, WEB_PURCHASES_COLLECTION, WebPurchaseEntry } from "./ledger";
import { isResourceMissing, stripeErrorCode } from "./stripeGateway";
import { syncWebEntitlement, WebSyncDeps } from "./sync";

/** A purchase still pending this long is synced; the purchase callable settles most within seconds. */
export const PENDING_SYNC_AFTER_MS = 15 * 60 * 1000;
/** A purchase still unpaid this long is abandoned; Stripe expires an unpaid first invoice after 23 h. */
export const PENDING_ABANDON_AFTER_MS = 24 * 60 * 60 * 1000;

/** Statuses a subscription reaches only once its first invoice was paid. */
const STARTED_SUBSCRIPTION_STATUSES = new Set(["active", "past_due", "unpaid", "trialing", "paused"]);

export interface PendingSweepSummary {
  examined: number;
  synced: number;
  abandoned: number;
  failed: number;
  /** False when time ran out before every entry was looked at. */
  completed: boolean;
}

/**
 * Settles purchases a closed page or a lost connection left pending.
 *
 * Each account with an entry pending for more than 15 minutes is synced, which marks a purchase
 * Stripe has since been paid for. An entry still pending after 24 hours has its incomplete
 * subscription cancelled or its one-off invoice voided, so a payment can no longer complete
 * behind it, and becomes `abandoned`.
 */
export async function sweepPendingWebPurchases(
  deps: WebSyncDeps,
  options: { now: Date; deadline: Date; operationId: string }
): Promise<PendingSweepSummary> {
  const { firestore, gateway } = deps;
  const summary: PendingSweepSummary = { examined: 0, synced: 0, abandoned: 0, failed: 0, completed: false };
  const entries = (
    await listPendingEntries(firestore, new Date(options.now.getTime() - PENDING_SYNC_AFTER_MS))
  ).filter((entry) => entry.livemode === gateway.livemode && entry.uid);
  const outOfTime = () => Date.now() >= options.deadline.getTime();
  const synced = new Set<string>();

  for (const entry of entries) {
    if (outOfTime()) return summary;
    summary.examined += 1;
    const uid = entry.uid!;
    try {
      if (!synced.has(uid)) {
        synced.add(uid);
        await syncWebEntitlement(uid, deps, { operationId: options.operationId, trigger: "pending_sweep" });
        summary.synced += 1;
      }
      if (options.now.getTime() - entry.createdAt.getTime() < PENDING_ABANDON_AFTER_MS) continue;
      if (await abandonPendingPurchase(deps, entry.purchaseId, options.now)) {
        summary.abandoned += 1;
        functions.logger.info("web_purchase_abandoned", {
          operationId: options.operationId,
          uid,
          purchaseId: entry.purchaseId,
          plan: entry.plan,
        });
      }
    } catch (error) {
      summary.failed += 1;
      functions.logger.error("web_pending_sweep_item_failure", {
        operationId: options.operationId,
        purchaseId: entry.purchaseId,
        code: stripeErrorCode(error) ?? safeErrorCode(error),
      });
    }
  }
  summary.completed = true;
  return summary;
}

/**
 * Stops the Stripe side of a pending purchase and marks it abandoned; false when it is no longer
 * pending or turned out paid. Shared with the purchase callable, which abandons an account's
 * older pending purchases before charging a new one.
 */
export async function abandonPendingPurchase(deps: WebSyncDeps, purchaseId: string, now: Date): Promise<boolean> {
  const { firestore } = deps;
  const ref = firestore.collection(WEB_PURCHASES_COLLECTION).doc(purchaseId);
  const current = ledgerEntryFromData(purchaseId, (await ref.get()).data());
  if (!current || current.status !== "pending") return false;
  if (await stopPendingStripeSide(deps, current)) {
    // Paid after all: the sync marks the entry and grants access.
    if (current.uid) await syncWebEntitlement(current.uid, deps, { trigger: "pending_paid" });
    return false;
  }
  return firestore.runTransaction(async (transaction) => {
    const entry = ledgerEntryFromData(purchaseId, (await transaction.get(ref)).data());
    if (!entry || entry.status !== "pending") return false;
    transaction.update(ref, { status: "abandoned", updatedAt: Timestamp.fromDate(now) });
    return true;
  });
}

/**
 * Cancels or voids what could still take a payment; true when the purchase turned out paid.
 *
 * A PaymentIntent that succeeded or is processing is paid, and nothing is stopped: the caller
 * syncs instead.
 *
 * A subscription that has started (active, past due and the like) was paid, even when the
 * invoice read just before still looked open: the payment landed between the two reads. It is
 * never cancelled, and the caller leaves its entry for the sync to mark paid.
 */
export async function stopPendingStripeSide(deps: WebSyncDeps, entry: WebPurchaseEntry): Promise<boolean> {
  const { gateway } = deps;
  // The PaymentIntent first: it is the first to say a payment went through, before the invoice
  // and the subscription catch up. Succeeded or still processing counts as paid.
  if (entry.stripe.paymentIntentId) {
    try {
      const intent = await gateway.retrievePaymentIntent(entry.stripe.paymentIntentId);
      if (intent.status === "succeeded" || intent.status === "processing") return true;
    } catch (error) {
      if (!isResourceMissing(error)) throw error;
    }
  }
  const invoiceId = entry.stripe.invoiceId;
  if (!invoiceId) return false;
  let invoice;
  try {
    invoice = await gateway.retrieveInvoice(invoiceId);
  } catch (error) {
    if (isResourceMissing(error)) return false;
    throw error;
  }
  if (invoice.status === "paid") return true;
  if (entry.stripe.subscriptionId) {
    const subscription = await gateway.retrieveSubscription(entry.stripe.subscriptionId);
    if (subscription.status === "incomplete") {
      await gateway.cancelSubscription(subscription.id);
      return false;
    }
    return STARTED_SUBSCRIPTION_STATUSES.has(subscription.status);
  }
  if (invoice.status === "open") await gateway.voidInvoice(invoiceId);
  else if (invoice.status === "draft") await gateway.deleteInvoice(invoiceId);
  return false;
}
