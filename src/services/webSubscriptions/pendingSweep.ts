import { Timestamp } from "firebase-admin/firestore";
import * as functions from "firebase-functions";
import { safeErrorCode } from "../subscriptions/errors";
import { ledgerEntryFromData, listPendingEntries, WEB_PURCHASES_COLLECTION, WebPurchaseEntry } from "./ledger";
import { invoiceAmounts } from "./pricing";
import { idOf, isResourceMissing, stripeErrorCode } from "./stripeGateway";
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
 *
 * A plan switch still unpaid after the 15 minutes is stopped at once and becomes `failed`: its
 * open invoice holds a change to a subscription the buyer is still using, and the page that could
 * finish its bank step has long since given up.
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
      const isSwitch = entry.kind === "switch";
      if (!isSwitch && options.now.getTime() - entry.createdAt.getTime() < PENDING_ABANDON_AFTER_MS) continue;
      const settled = isSwitch ? { status: "failed" as const, failure: "not_completed" } : undefined;
      if (await abandonPendingPurchase(deps, entry.purchaseId, options.now, settled)) {
        summary.abandoned += 1;
        functions.logger.info(isSwitch ? "web_switch_failed" : "web_purchase_abandoned", {
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
 * Stops the Stripe side of a pending purchase and marks it abandoned (or as `settled` says); false
 * when it is no longer pending or turned out paid. Shared with the purchase callable, which
 * abandons an account's older pending purchases before charging a new one.
 */
export async function abandonPendingPurchase(
  deps: WebSyncDeps,
  purchaseId: string,
  now: Date,
  settled: { status: "abandoned" | "failed"; failure?: string } = { status: "abandoned" }
): Promise<boolean> {
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
    transaction.update(ref, { status: settled.status, ...(settled.failure ? { failure: settled.failure } : {}), updatedAt: Timestamp.fromDate(now) });
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
  if (entry.kind === "switch") return stopPendingSwitch(deps, entry);
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

/**
 * The plan switch's part of `stopPendingStripeSide`: true when its invoice is paid, otherwise the
 * open invoice is voided, which also drops the change Stripe holds for it.
 *
 * The subscription it changes is already running, so the subscription's status says nothing about
 * the switch; only the invoice does. An entry without an invoice id (the call ended between
 * Stripe's answer and the write) is named by the subscription only once paid, since Stripe applies
 * the switch's metadata with the payment: the invoice and its amounts are then recorded, so the
 * sync can mark the entry paid. Every caller passes only entries past the purchase lock, whose
 * call has ended, so an unnamed open switch invoice can be voided as theirs.
 */
async function stopPendingSwitch(deps: WebSyncDeps, entry: WebPurchaseEntry): Promise<boolean> {
  const { firestore, gateway } = deps;
  let invoiceId = entry.stripe.invoiceId;
  const resolved = !invoiceId;
  if (!invoiceId) {
    if (!entry.stripe.subscriptionId) return false;
    const subscription = await gateway.retrieveSubscription(entry.stripe.subscriptionId);
    invoiceId = idOf(subscription.latest_invoice as string | { id: string } | null);
    if (subscription.metadata?.purchaseId !== entry.purchaseId) {
      // Not paid. An open switch invoice raised since this entry was made is its own, left by the
      // call that ended: voided, so Stripe does not hold the change for its 23 hours.
      if (subscription.pending_update && invoiceId) {
        const open = await gateway.retrieveInvoice(invoiceId);
        if (open.status === "open" && open.billing_reason === "subscription_update" && open.created * 1000 >= entry.createdAt.getTime()) {
          await gateway.voidInvoice(invoiceId);
        }
      }
      return false;
    }
    if (!invoiceId) return false;
  }
  let invoice;
  try {
    invoice = await gateway.retrieveInvoice(invoiceId, ["payments"]);
  } catch (error) {
    if (isResourceMissing(error)) return false;
    throw error;
  }
  if (invoice.status === "paid") {
    if (resolved) {
      const amounts = invoiceAmounts(invoice);
      const payment = (invoice.payments?.data ?? []).find((row) => row.status === "paid") ?? invoice.payments?.data[0];
      const paymentIntentId = idOf(payment?.payment?.payment_intent ?? null);
      await firestore.collection(WEB_PURCHASES_COLLECTION).doc(entry.purchaseId).update({
        "stripe.invoiceId": invoiceId,
        ...(paymentIntentId ? { "stripe.paymentIntentId": paymentIntentId } : {}),
        amount: amounts.amount,
        credit: amounts.credit,
        tax: amounts.tax,
        total: amounts.total,
        updatedAt: Timestamp.fromDate(deps.now?.() ?? new Date()),
      });
    }
    return true;
  }
  if (invoice.status === "open") await gateway.voidInvoice(invoiceId);
  return false;
}
