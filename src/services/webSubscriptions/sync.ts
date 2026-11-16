import * as crypto from "crypto";
import { DocumentData, Firestore, Timestamp } from "firebase-admin/firestore";
import * as functions from "firebase-functions";
import type Stripe from "stripe";
import { NormalizedSubscription, NormalizedSubscriptionStatus } from "../../types/subscriptions";
import { DELETED_ACCOUNTS_COLLECTION } from "../accountDeletion/tombstone";
import { safeErrorCode } from "../subscriptions/errors";
import {
  projectMaster,
  readProjectionState,
  slotStates,
  STATE_SLOTS,
  stateData,
  stateDataToNormalized,
  timestampDate,
  webSlotIndex,
} from "../subscriptions/persistence";
import { customerIdFor, mappingFromData, WEB_CUSTOMERS_COLLECTION } from "./customers";
import {
  ChargeFacts,
  DisputeState,
  InvoiceFacts,
  isWebPlan,
  LEDGER_STATUSES_TO_CHECK,
  ledgerEntryFromData,
  ledgerUpdate,
  listLedgerEntries,
  WEB_PURCHASES_COLLECTION,
  WebPurchaseEntry,
} from "./ledger";
import { idOf, shortId, stripeErrorCode, StripeGateway } from "./stripeGateway";

export const WEB_LIFETIME_YEARS = 99;
const HOUR_MS = 60 * 60 * 1000;
/** An active subscription stays on this long past its paid period, for the renewal invoice to be paid. */
export const WEB_RENEWAL_SLACK_MS = 6 * HOUR_MS;
/** A failed renewal keeps access this long past the paid period. */
export const WEB_GRACE_MS = 7 * 24 * HOUR_MS;

const ENDED_SUBSCRIPTION_STATUSES = new Set(["canceled", "incomplete_expired"]);
/** A ledger entry moving to `paid` from these was paid for the first time (not a won dispute). */
const FIRST_PAYMENT_FROM = new Set(["pending", "failed", "abandoned"]);
/** Statuses a subscription reaches only after its first invoice was paid, and leaves only by ending. */
const STARTED_OPEN_SUBSCRIPTION_STATUSES = new Set(["active", "trialing", "past_due", "unpaid", "paused"]);

export interface WebSyncDeps {
  firestore: Firestore;
  gateway: StripeGateway;
  now?: () => Date;
  /**
   * Told about each committed change, to queue the billing emails. Called after the commit,
   * never inside it; a failure is logged and never fails the sync.
   */
  notify?: (notice: WebSyncNotice) => Promise<void>;
}

/** What a committed sync changed, for `notify`. */
export interface WebSyncNotice {
  uid: string;
  livemode: boolean;
  operationId: string;
  now: Date;
  /** The slot document before the sync; undefined when there was none. */
  previous?: DocumentData;
  /** The slot document after it; the previous one when only the ledger changed. */
  next?: DocumentData;
  /** Entries this sync moved to `paid` from pending, failed or abandoned: first payments. */
  becamePaid: WebPurchaseEntry[];
  /** Every entry the sync read, for the purchase's language. */
  entries: WebPurchaseEntry[];
  /** The chosen subscription's facts, when there is one. */
  subscription?: WebSubscriptionFacts;
}

/** The `web` map on a web slot. */
export interface WebSlotSummary {
  customerId: string;
  subscriptionId?: string;
  purchaseId?: string;
  lastPaidInvoiceId?: string;
  paidThrough?: Date;
  plan: string;
  tier?: string;
  cancelAtPeriodEnd: boolean;
  needsAction: boolean;
  paymentFailed: boolean;
}

export interface DerivedWebSlot {
  active: boolean;
  status: NormalizedSubscriptionStatus;
  productId: string;
  expiresAt: Date;
  autoRenewing: boolean;
  inGracePeriod: boolean;
  /** The subscription id, or the invoice id for lifetime. */
  purchaseReference?: string;
  web: WebSlotSummary;
}

export interface WebSubscriptionFacts {
  id: string;
  status: string;
  created: Date;
  /** Set to end at the period's end, by the customer or a scheduled `cancel_at`. */
  cancelling: boolean;
  endedAt?: Date;
  productId: string;
  purchaseId?: string;
  tier?: string;
  /** The newest invoice of the subscription whose status is `paid`. */
  latestPaid?: InvoiceFacts;
  /** The latest invoice is open and its payment waits for the customer to authenticate. */
  needsAction: boolean;
  /** The latest invoice when it is open (a payment due): the billing emails' id and reason. */
  latestOpen?: { id: string; billingReason?: string };
}

export interface WebLifetimeFacts {
  purchaseId: string;
  tier: string;
  invoice: InvoiceFacts;
}

/** Everything the derivation reads, gathered from Stripe before any write. */
export interface WebStripeFacts {
  customerId: string;
  customerDeleted: boolean;
  lifetimes: WebLifetimeFacts[];
  /** A lifetime purchase the ledger already records as refunded or lost to a dispute. */
  lifetimeRevokedInLedger: boolean;
  /** The newest subscription that ever started; incomplete ones never did. */
  subscription?: WebSubscriptionFacts;
  /** Subscriptions not yet ended, incomplete ones included: what a lifetime purchase cancels. */
  openSubscriptionIds: string[];
  /**
   * Started, open subscriptions other than the chosen one: the customer is paying twice.
   * Cancelled at Stripe, never an incomplete one, which belongs to a purchase in flight.
   */
  duplicateSubscriptionIds: string[];
  /** Facts per invoice id, for the ledger entries. */
  invoices: Map<string, InvoiceFacts>;
}

export type WebDerivation =
  | { kind: "slot"; slot: DerivedWebSlot; cancel: string[] }
  | { kind: "nothing"; cancel: string[] };

/** Whether an invoice's charge keeps the access it paid for. */
function chargeRevoked(charge: ChargeFacts | undefined): boolean {
  return charge !== undefined && (charge.fullyRefunded || charge.dispute !== "none");
}

const addYears = (date: Date, years: number): Date => {
  const result = new Date(date.getTime());
  result.setUTCFullYear(result.getUTCFullYear() + years);
  return result;
};

/**
 * Derives the web slot from what Stripe holds now. First match wins:
 *
 * 1. A paid lifetime invoice whose charge is neither refunded in full nor disputed (open or
 *    lost): active for 99 years from payment. Every subscription not yet ended is cancelled.
 * 2. The newest subscription that started, by the table in the stage D spec. Access runs to
 *    the end of the latest paid invoice's line period, never to the item's current period,
 *    which Stripe advances at renewal whether or not the renewal is paid.
 * 3. Nothing: no slot, which the caller turns into an expired one when a slot exists.
 *
 * A lifetime purchase that was refunded or disputed, with no subscription to fall back on,
 * reads as `revoked` rather than nothing, so the slot says why access ended.
 */
export function deriveWebSlot(facts: WebStripeFacts, now: Date): WebDerivation {
  if (facts.customerDeleted) return { kind: "nothing", cancel: [] };

  const lifetime = facts.lifetimes
    .filter((entry) => entry.invoice.status === "paid" && entry.invoice.paidAt && !chargeRevoked(entry.invoice.charge))
    .sort((left, right) => left.invoice.paidAt!.getTime() - right.invoice.paidAt!.getTime())[0];
  if (lifetime) {
    const expiresAt = addYears(lifetime.invoice.paidAt!, WEB_LIFETIME_YEARS);
    return {
      kind: "slot",
      cancel: [...facts.openSubscriptionIds],
      slot: {
        active: true,
        status: "active",
        productId: "web_lifetime",
        expiresAt,
        autoRenewing: false,
        inGracePeriod: false,
        purchaseReference: lifetime.invoice.id,
        web: {
          customerId: facts.customerId,
          purchaseId: lifetime.purchaseId,
          lastPaidInvoiceId: lifetime.invoice.id,
          paidThrough: expiresAt,
          plan: "web_lifetime",
          tier: lifetime.tier || undefined,
          cancelAtPeriodEnd: false,
          needsAction: false,
          paymentFailed: false,
        },
      },
    };
  }

  const subscription = facts.subscription;
  if (!subscription) {
    const revokedLifetime =
      facts.lifetimeRevokedInLedger ||
      facts.lifetimes.find((entry) => entry.invoice.status === "paid" && chargeRevoked(entry.invoice.charge));
    if (!revokedLifetime) return { kind: "nothing", cancel: [] };
    const invoice = typeof revokedLifetime === "object" ? revokedLifetime.invoice : undefined;
    return {
      kind: "slot",
      cancel: [],
      slot: {
        active: false,
        status: "revoked",
        productId: "web_lifetime",
        expiresAt: invoice?.paidAt ?? now,
        autoRenewing: false,
        inGracePeriod: false,
        purchaseReference: invoice?.id,
        web: {
          customerId: facts.customerId,
          purchaseId: typeof revokedLifetime === "object" ? revokedLifetime.purchaseId : undefined,
          lastPaidInvoiceId: invoice?.id,
          plan: "web_lifetime",
          tier: typeof revokedLifetime === "object" ? revokedLifetime.tier || undefined : undefined,
          cancelAtPeriodEnd: false,
          needsAction: false,
          paymentFailed: false,
        },
      },
    };
  }

  const duplicates = facts.duplicateSubscriptionIds.filter((id) => id !== subscription.id);
  const paid = subscription.latestPaid;
  const paidThrough = paid?.periodEnd;
  const ended = ENDED_SUBSCRIPTION_STATUSES.has(subscription.status);
  const web: WebSlotSummary = {
    customerId: facts.customerId,
    subscriptionId: subscription.id,
    purchaseId: subscription.purchaseId,
    lastPaidInvoiceId: paid?.id,
    paidThrough,
    plan: subscription.productId,
    tier: subscription.tier,
    cancelAtPeriodEnd: subscription.cancelling,
    needsAction: subscription.needsAction,
    paymentFailed: false,
  };
  const row = (
    status: NormalizedSubscriptionStatus,
    active: boolean,
    expiresAt: Date,
    autoRenewing: boolean,
    cancel: string[] = []
  ): WebDerivation => ({
    kind: "slot",
    cancel: [...new Set([...cancel, ...duplicates])],
    slot: {
      active,
      status,
      productId: subscription.productId,
      expiresAt,
      autoRenewing,
      inGracePeriod: status === "grace_period",
      purchaseReference: subscription.id,
      web,
    },
  });

  if (!paid || !paidThrough) {
    // Started without a paid invoice: no access, whatever the status says.
    return row("expired", false, subscription.endedAt ?? subscription.created, false);
  }
  const charge = paid.charge;
  const revokedAt = paid.paidAt ?? subscription.created;
  const cancelIfOpen = ended ? [] : [subscription.id];
  if (charge?.fullyRefunded || charge?.dispute === "lost") {
    return row("revoked", false, revokedAt, false, cancelIfOpen);
  }
  if (charge?.dispute === "open") {
    return row("revoked", false, revokedAt, false);
  }

  switch (subscription.status) {
    case "active":
    case "trialing":
      return subscription.cancelling
        ? row("canceled", true, paidThrough, false)
        : row("active", true, new Date(paidThrough.getTime() + WEB_RENEWAL_SLACK_MS), true);
    case "past_due": {
      web.paymentFailed = true;
      const graceEnd = new Date(paidThrough.getTime() + WEB_GRACE_MS);
      if (now.getTime() < graceEnd.getTime()) {
        return row("grace_period", true, graceEnd, !subscription.cancelling);
      }
      return row("billing_retry", false, paidThrough, !subscription.cancelling);
    }
    case "unpaid":
      web.paymentFailed = true;
      return row("billing_retry", false, paidThrough, !subscription.cancelling);
    case "canceled": {
      const endedAt = subscription.endedAt ?? paidThrough;
      return row("expired", false, new Date(Math.min(paidThrough.getTime(), endedAt.getTime())), false);
    }
    case "paused":
      return row("paused", false, paidThrough, false);
    default:
      return row("unknown", false, paidThrough, false);
  }
}

// ---------------------------------------------------------------------------
// Reading Stripe
// ---------------------------------------------------------------------------

function disputeState(disputes: Stripe.Dispute[]): DisputeState {
  let state: DisputeState = "none";
  for (const dispute of disputes) {
    const status = String(dispute.status);
    if (status === "lost" || status.startsWith("appeal_")) return "lost";
    if (status === "needs_response" || status === "under_review") state = "open";
  }
  return state;
}

/** The charge an invoice was paid with, through its paid invoice payment. */
export async function chargeOfInvoice(gateway: StripeGateway, invoice: Stripe.Invoice): Promise<ChargeFacts | undefined> {
  const payments = invoice.payments?.data ?? [];
  const payment = payments.find((row) => row.status === "paid") ?? payments.find((row) => row.is_default);
  const paymentIntentId = idOf(payment?.payment?.payment_intent ?? null);
  if (!paymentIntentId) return undefined;
  const paymentIntent = await gateway.retrievePaymentIntent(paymentIntentId, ["latest_charge"]);
  const latest = paymentIntent.latest_charge;
  const charge = latest && typeof latest === "object" ? latest : latest ? await gateway.retrieveCharge(latest) : undefined;
  const facts: ChargeFacts = {
    paymentIntentId,
    paymentIntentStatus: paymentIntent.status,
    fullyRefunded: false,
    amountRefunded: 0,
    dispute: "none",
  };
  if (!charge) return facts;
  facts.chargeId = charge.id;
  facts.amount = charge.amount;
  facts.fullyRefunded = charge.refunded === true;
  facts.amountRefunded = charge.amount_refunded ?? 0;
  if (charge.disputed) facts.dispute = disputeState(await gateway.listDisputes({ charge: charge.id }));
  return facts;
}

/**
 * The end of the service an invoice pays for: the latest `period.end` across its lines.
 *
 * Never the first line's, nor the invoice's own period: a plan switch's invoice lists the credit
 * for the unused monthly days first, and only its yearly line runs to the new period's end.
 */
export function servicePeriodEnd(invoice: Pick<Stripe.Invoice, "lines">): Date | undefined {
  const ends = (invoice.lines?.data ?? []).map((line) => line.period?.end).filter((end): end is number => typeof end === "number");
  return ends.length > 0 ? new Date(Math.max(...ends) * 1000) : undefined;
}

async function readInvoiceFacts(gateway: StripeGateway, invoice: Stripe.Invoice): Promise<InvoiceFacts> {
  const periodEnd = servicePeriodEnd(invoice);
  const paidAt = invoice.status_transitions?.paid_at;
  const facts: InvoiceFacts = { id: invoice.id!, status: invoice.status ?? null };
  if (typeof paidAt === "number") facts.paidAt = new Date(paidAt * 1000);
  if (invoice.billing_reason) facts.billingReason = invoice.billing_reason;
  if (typeof invoice.amount_paid === "number") facts.amountPaid = invoice.amount_paid;
  if (invoice.currency) facts.currency = invoice.currency;
  if (periodEnd) facts.periodEnd = periodEnd;
  // Only a paid invoice's charge can carry a refund or a dispute.
  if (invoice.status === "paid") facts.charge = await chargeOfInvoice(gateway, invoice);
  return facts;
}

function subscriptionProduct(subscription: Stripe.Subscription): string | undefined {
  for (const item of subscription.items?.data ?? []) {
    const product = idOf(item.price?.product as string | { id: string } | null);
    if (isWebPlan(product) && product !== "web_lifetime") return product;
  }
  return undefined;
}

/**
 * Gathers the facts for one customer: its subscriptions, its lifetime invoices, and the invoice
 * behind every ledger entry that can still change. Reads only; nothing is written.
 */
export async function readWebStripeFacts(
  gateway: StripeGateway,
  customerId: string,
  entries: WebPurchaseEntry[]
): Promise<WebStripeFacts> {
  const facts: WebStripeFacts = {
    customerId,
    customerDeleted: false,
    lifetimes: [],
    lifetimeRevokedInLedger: false,
    openSubscriptionIds: [],
    duplicateSubscriptionIds: [],
    invoices: new Map(),
  };
  const customer = await gateway.retrieveCustomer(customerId);
  if ("deleted" in customer && customer.deleted) {
    facts.customerDeleted = true;
    return facts;
  }

  const invoiceById = async (invoiceId: string): Promise<InvoiceFacts | undefined> => {
    const known = facts.invoices.get(invoiceId);
    if (known) return known;
    const invoice = await gateway.retrieveInvoice(invoiceId, ["payments"]);
    if (idOf(invoice.customer as string | { id: string } | null) !== customerId) return undefined;
    const read = await readInvoiceFacts(gateway, invoice);
    facts.invoices.set(invoiceId, read);
    return read;
  };

  const own = entries.filter(
    (entry) => entry.livemode === gateway.livemode && entry.stripe.customerId === customerId
  );
  for (const entry of own) {
    if (entry.plan === "web_lifetime" && (entry.status === "refunded" || entry.status === "dispute_lost")) {
      facts.lifetimeRevokedInLedger = true;
    }
    // A lifetime invoice is read whatever its entry says: a paid invoice at Stripe wins over a
    // ledger marked abandoned or failed, and the sync corrects the entry.
    // A charge made from `/manage` is read whatever its entry says too: a decline racing a bank
    // step completed in another tab marks it failed while its invoice is paid.
    const checked = entry.plan === "web_lifetime" || entry.kind !== undefined || LEDGER_STATUSES_TO_CHECK.includes(entry.status);
    if (!entry.stripe.invoiceId || !checked) continue;
    const invoice = await invoiceById(entry.stripe.invoiceId);
    if (invoice && entry.plan === "web_lifetime") {
      facts.lifetimes.push({ purchaseId: entry.purchaseId, tier: entry.tierCharged, invoice });
    }
  }

  const subscriptions = (await gateway.listSubscriptions(customerId))
    .map((subscription) => ({ subscription, product: subscriptionProduct(subscription) }))
    .filter((row): row is { subscription: Stripe.Subscription; product: string } => row.product !== undefined);
  facts.openSubscriptionIds = subscriptions
    .filter((row) => !ENDED_SUBSCRIPTION_STATUSES.has(row.subscription.status))
    .map((row) => row.subscription.id);
  // The newest started subscription not yet ended, else the newest that ended after starting.
  const chosen =
    subscriptions.find((row) => STARTED_OPEN_SUBSCRIPTION_STATUSES.has(row.subscription.status)) ??
    subscriptions.find((row) => row.subscription.status === "canceled");
  facts.duplicateSubscriptionIds = subscriptions
    .filter((row) => row !== chosen && STARTED_OPEN_SUBSCRIPTION_STATUSES.has(row.subscription.status))
    .map((row) => row.subscription.id);
  if (chosen) {
    const subscription = chosen.subscription;
    const [latestPaidInvoice] = await gateway.listInvoices({
      subscription: subscription.id,
      status: "paid",
      limit: 1,
      expand: ["data.payments"],
    });
    let latestPaid: InvoiceFacts | undefined;
    // Kept with the ledger's invoices, so any entry naming it is corrected, whatever its status:
    // a plan switch marked failed or abandoned while its payment went through (a decline racing
    // the payment, or the void's own webhook) becomes paid, at no extra read.
    if (latestPaidInvoice?.id) {
      latestPaid = facts.invoices.get(latestPaidInvoice.id) ?? (await readInvoiceFacts(gateway, latestPaidInvoice));
      facts.invoices.set(latestPaidInvoice.id, latestPaid);
    }
    const latestInvoiceId = idOf(subscription.latest_invoice as string | { id: string } | null);
    let needsAction = false;
    let latestOpen: WebSubscriptionFacts["latestOpen"];
    if (latestInvoiceId && latestInvoiceId !== latestPaid?.id) {
      const latest = await gateway.retrieveInvoice(latestInvoiceId, ["payments"]);
      // A plan switch waiting for its payment leaves an open `subscription_update` invoice while
      // the subscription stays as it was: that is not a renewal in trouble, and the page's
      // verify button would otherwise act on the switch's payment under the older purchase.
      if (latest.status === "open" && latest.billing_reason !== "subscription_update") {
        latestOpen = { id: latestInvoiceId, ...(latest.billing_reason ? { billingReason: latest.billing_reason } : {}) };
        const payment = (latest.payments?.data ?? []).find((row) => row.status === "open" || row.is_default);
        const paymentIntentId = idOf(payment?.payment?.payment_intent ?? null);
        if (paymentIntentId) {
          needsAction = (await gateway.retrievePaymentIntent(paymentIntentId)).status === "requires_action";
        }
      }
    }
    facts.subscription = {
      id: subscription.id,
      status: subscription.status,
      created: new Date(subscription.created * 1000),
      cancelling: subscription.cancel_at_period_end === true || typeof subscription.cancel_at === "number",
      endedAt: typeof subscription.ended_at === "number" ? new Date(subscription.ended_at * 1000) : undefined,
      productId: chosen.product,
      purchaseId: subscription.metadata?.purchaseId || undefined,
      tier: subscription.metadata?.tier || undefined,
      latestPaid,
      needsAction,
      latestOpen,
    };
  }
  return facts;
}

// ---------------------------------------------------------------------------
// The slot document
// ---------------------------------------------------------------------------

export function webSummaryToData(web: WebSlotSummary, readAt: Timestamp): DocumentData {
  const data: DocumentData = {
    customerId: web.customerId,
    plan: web.plan,
    cancelAtPeriodEnd: web.cancelAtPeriodEnd,
    needsAction: web.needsAction,
    paymentFailed: web.paymentFailed,
    // When the Stripe reads behind this write began; an older read never overwrites it.
    readAt,
  };
  if (web.subscriptionId) data.subscriptionId = web.subscriptionId;
  if (web.purchaseId) data.purchaseId = web.purchaseId;
  if (web.lastPaidInvoiceId) data.lastPaidInvoiceId = web.lastPaidInvoiceId;
  if (web.paidThrough) data.paidThrough = Timestamp.fromDate(web.paidThrough);
  if (web.tier) data.tier = web.tier;
  return data;
}

/** The fields whose change is a change of entitlement; times of writing and reading are left out. */
export function comparableWebSlot(data: DocumentData | undefined): string | undefined {
  if (!data) return undefined;
  const millis = (value: unknown) => timestampDate(value)?.getTime() ?? null;
  const web = (data.web ?? {}) as DocumentData;
  return JSON.stringify([
    data.active === true,
    data.status ?? null,
    data.productId ?? null,
    millis(data.expiresAt),
    data.autoRenewing ?? null,
    data.inGracePeriod === true,
    data.environment ?? null,
    data.purchaseReference ?? null,
    web.customerId ?? null,
    web.subscriptionId ?? null,
    web.purchaseId ?? null,
    web.lastPaidInvoiceId ?? null,
    millis(web.paidThrough),
    web.plan ?? null,
    web.tier ?? null,
    web.cancelAtPeriodEnd === true,
    web.needsAction === true,
    web.paymentFailed === true,
  ]);
}

function slotDocument(
  uid: string,
  slot: DerivedWebSlot,
  livemode: boolean,
  existing: DocumentData | undefined,
  now: Timestamp,
  readAt: Timestamp
): DocumentData {
  const environment = STATE_SLOTS[webSlotIndex(livemode)].environment;
  const state: NormalizedSubscription = {
    active: slot.active,
    status: slot.status,
    platform: "web",
    productId: slot.productId,
    expiresAt: slot.expiresAt,
    autoRenewing: slot.autoRenewing,
    inGracePeriod: slot.inGracePeriod,
    environment,
    purchaseReference: slot.purchaseReference,
    lastStoreEventAt: now.toDate(),
    lastVerifiedAt: now.toDate(),
  };
  const data = stateData(uid, state, existing?.createdAt ?? now, now);
  data.web = webSummaryToData(slot.web, readAt);
  return data;
}

/**
 * The slot a derivation of nothing leaves: an existing slot becomes expired, keeping what it
 * last showed, no later than now. One already expired is left exactly as it is.
 */
function expiredFrom(existing: DocumentData, now: Timestamp, readAt: Timestamp): DocumentData {
  if (existing.status === "expired" && existing.active !== true) return existing;
  const expiresAt = timestampDate(existing.expiresAt);
  const data: DocumentData = {
    ...existing,
    active: false,
    status: "expired",
    autoRenewing: false,
    inGracePeriod: false,
    expiresAt: expiresAt && expiresAt.getTime() < now.toMillis() ? existing.expiresAt : now,
    lastStoreEventAt: now,
    lastVerifiedAt: now,
    updatedAt: now,
  };
  data.web = { ...(existing.web ?? {}), needsAction: false, paymentFailed: false, readAt };
  return data;
}

// ---------------------------------------------------------------------------
// The operation
// ---------------------------------------------------------------------------

export type WebSyncOutcome = "written" | "unchanged" | "account_deleted" | "no_mapping" | "stale";

export interface WebSyncResult {
  outcome: WebSyncOutcome;
  /** The slot as it stands after the sync; undefined when there is none. */
  slot?: { status: string; active: boolean; expiresAt: Date; productId: string; web?: DocumentData };
  ledgerUpdates: number;
  cancelled: string[];
}

/**
 * Rebuilds the account's web slot from what Stripe holds now. The only writer of the web slot.
 *
 * Stripe is read first, then everything is written in one transaction modelled on
 * `applyManualMutation`: the slot, the master projection and the ledger statuses. Nothing is
 * written when the account has a tombstone, when it has no customer mapping for the gateway's
 * mode, or when the derived slot equals the stored one, so a webhook replay or a second sync
 * costs no writes. A read that began before the one behind the stored slot never overwrites it:
 * Stripe delivers events out of order, and the later read is the truer one.
 *
 * Subscriptions the derivation says to cancel are cancelled at Stripe after the commit. A failed
 * cancel is thrown after the slot is written, so the webhook or reconcile run retries it.
 */
export async function syncWebEntitlement(
  uid: string,
  deps: WebSyncDeps,
  options: { operationId?: string; trigger?: string } = {}
): Promise<WebSyncResult> {
  const operationId = options.operationId ?? crypto.randomUUID();
  const clock = deps.now ?? (() => new Date());
  const { firestore, gateway } = deps;
  const mappingRef = firestore.collection(WEB_CUSTOMERS_COLLECTION).doc(uid);
  const tombstoneRef = firestore.collection(DELETED_ACCOUNTS_COLLECTION).doc(uid);
  const fields = { operationId, uid, livemode: gateway.livemode, trigger: options.trigger ?? null };
  try {
    const [tombstone, mappingSnapshot] = await firestore.getAll(tombstoneRef, mappingRef);
    if (tombstone.exists) return finish({ outcome: "account_deleted", ledgerUpdates: 0, cancelled: [] });
    const customerId = customerIdFor(mappingFromData(mappingSnapshot.data()), gateway.livemode);
    if (!customerId) return finish({ outcome: "no_mapping", ledgerUpdates: 0, cancelled: [] });

    const readStarted = clock();
    const entries = await listLedgerEntries(firestore, uid);
    const facts = await readWebStripeFacts(gateway, customerId, entries);
    const now = clock();
    const derivation = deriveWebSlot(facts, now);

    const slotIndex = webSlotIndex(gateway.livemode);
    const ledgerRefs = entries.map((entry) => firestore.collection(WEB_PURCHASES_COLLECTION).doc(entry.purchaseId));
    const committed = await firestore.runTransaction(async (transaction) => {
      const nowStamp = Timestamp.fromDate(now);
      const readAt = Timestamp.fromDate(readStarted);
      const state = await readProjectionState(transaction, uid, {
        extraRefs: [tombstoneRef, mappingRef, ...ledgerRefs],
      });
      const [tombstoneNow, mappingNow, ...ledgerSnapshots] = state.extraSnapshots;
      if (tombstoneNow.exists) return { outcome: "account_deleted" as const, ledgerUpdates: 0 };
      if (customerIdFor(mappingFromData(mappingNow.data()), gateway.livemode) !== customerId) {
        return { outcome: "no_mapping" as const, ledgerUpdates: 0 };
      }

      const storedSnapshot = state.slotSnapshots[slotIndex];
      const stored = storedSnapshot.exists ? storedSnapshot.data()! : undefined;
      let next: DocumentData | undefined;
      if (derivation.kind === "slot") {
        next = slotDocument(uid, derivation.slot, gateway.livemode, stored, nowStamp, readAt);
      } else if (stored) {
        next = expiredFrom(stored, nowStamp, readAt);
      }
      const slotChanged = next !== undefined && comparableWebSlot(next) !== comparableWebSlot(stored);
      const storedReadAt = timestampDate(stored?.web?.readAt);
      if (slotChanged && storedReadAt && storedReadAt.getTime() > readStarted.getTime()) {
        return { outcome: "stale" as const, ledgerUpdates: 0, slot: stored };
      }

      const updates: Array<{ index: number; update: DocumentData }> = [];
      const becamePaid: WebPurchaseEntry[] = [];
      ledgerSnapshots.forEach((snapshot, index) => {
        const entry = ledgerEntryFromData(snapshot.id, snapshot.data());
        if (!entry || entry.uid !== uid || !entry.stripe.invoiceId) return;
        const update = ledgerUpdate(entry, facts.invoices.get(entry.stripe.invoiceId), now);
        if (update) updates.push({ index, update });
        if (update?.status === "paid" && FIRST_PAYMENT_FROM.has(entry.status)) becamePaid.push({ ...entry, status: "paid" });
      });

      if (slotChanged && next) {
        transaction.set(state.slotRefs[slotIndex], next);
        const states = slotStates(state.slotSnapshots, now);
        states[slotIndex] = stateDataToNormalized(next, now);
        projectMaster(transaction, state, states, nowStamp);
      }
      for (const { index, update } of updates) transaction.update(ledgerRefs[index], update);
      return {
        outcome: slotChanged ? ("written" as const) : ("unchanged" as const),
        ledgerUpdates: updates.length,
        slot: slotChanged ? next : stored,
        previous: stored,
        becamePaid,
      };
    });

    // After the commit and before the cancellations, which can throw: the change is real now.
    const becamePaid = ("becamePaid" in committed && committed.becamePaid) || [];
    if (deps.notify && (committed.outcome === "written" || (committed.outcome === "unchanged" && becamePaid.length > 0))) {
      try {
        await deps.notify({
          uid,
          livemode: gateway.livemode,
          operationId,
          now,
          previous: "previous" in committed ? committed.previous : undefined,
          next: "slot" in committed ? committed.slot : undefined,
          becamePaid,
          entries,
          subscription: facts.subscription,
        });
      } catch (error) {
        functions.logger.error("web_sync_notify_failure", {
          ...fields,
          code: safeErrorCode(error),
          errorName: error instanceof Error ? error.name : typeof error,
        });
      }
    }

    const cancelled: string[] = [];
    if (committed.outcome === "written" || committed.outcome === "unchanged") {
      const lifetime = derivation.kind === "slot" && derivation.slot.productId === "web_lifetime";
      for (const subscriptionId of derivation.cancel) {
        await gateway.cancelSubscription(subscriptionId);
        cancelled.push(subscriptionId);
        if (!lifetime && facts.duplicateSubscriptionIds.includes(subscriptionId)) {
          // A second paid subscription: the customer was charged twice, which needs a person.
          functions.logger.error("web_duplicate_subscription_cancelled", {
            ...fields,
            subscriptionId: shortId(subscriptionId),
            kept: derivation.kind === "slot" ? shortId(derivation.slot.web.subscriptionId) : null,
            customerId: shortId(customerId),
          });
          continue;
        }
        functions.logger.info("web_subscription_cancelled_at_stripe", {
          ...fields,
          subscriptionId,
          reason: lifetime ? "lifetime" : "revoked",
        });
      }
    }
    return finish({
      outcome: committed.outcome,
      ledgerUpdates: committed.ledgerUpdates,
      cancelled,
      slot: summarise("slot" in committed ? committed.slot : undefined),
    });
  } catch (error) {
    functions.logger.error("web_sync_failure", {
      ...fields,
      code: stripeErrorCode(error) ?? safeErrorCode(error),
      errorName: error instanceof Error ? error.name : typeof error,
    });
    throw error;
  }

  function finish(result: WebSyncResult): WebSyncResult {
    functions.logger.info("web_sync_success", {
      ...fields,
      outcome: result.outcome,
      status: result.slot?.status ?? null,
      active: result.slot?.active ?? null,
      expiresAt: result.slot?.expiresAt.toISOString() ?? null,
      ledgerUpdates: result.ledgerUpdates,
      cancelled: result.cancelled.length,
    });
    return result;
  }
}

function summarise(data: DocumentData | undefined): WebSyncResult["slot"] {
  const expiresAt = timestampDate(data?.expiresAt);
  if (!data || !expiresAt) return undefined;
  return {
    status: String(data.status),
    active: data.active === true,
    expiresAt,
    productId: String(data.productId),
    web: data.web,
  };
}
