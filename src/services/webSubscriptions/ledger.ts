import * as crypto from "crypto";
import { DocumentData, FieldPath, Firestore, Timestamp } from "firebase-admin/firestore";
import * as functions from "firebase-functions";

/**
 * `web_purchases/{purchaseId}`: one entry per purchase attempt, the record of money taken.
 *
 * It holds no email, name, card number or address line. At account deletion the entries stay
 * with `uid` removed, like the manual payment requests. Readable by portal admins only.
 */
export const WEB_PURCHASES_COLLECTION = "web_purchases";

export const WEB_PLANS = ["web_monthly", "web_yearly", "web_lifetime"] as const;
export type WebPlan = (typeof WEB_PLANS)[number];

export function isWebPlan(value: unknown): value is WebPlan {
  return typeof value === "string" && (WEB_PLANS as readonly string[]).includes(value);
}

export const WEB_PURCHASE_STATUSES = [
  "pending",
  "paid",
  "failed",
  "abandoned",
  "refunded",
  "disputed",
  "dispute_lost",
] as const;
export type WebPurchaseStatus = (typeof WEB_PURCHASE_STATUSES)[number];

/** Statuses whose Stripe objects can still change what the entry or the slot says. */
export const LEDGER_STATUSES_TO_CHECK: readonly WebPurchaseStatus[] = ["pending", "paid", "disputed"];

export interface WebPurchaseStripeRefs {
  customerId: string;
  subscriptionId?: string;
  invoiceId?: string;
  paymentIntentId?: string;
  chargeId?: string;
}

export interface WebPurchaseEntry {
  purchaseId: string;
  /** Absent once the account was deleted. */
  uid?: string;
  plan: WebPlan;
  tierShown: string;
  tierCharged: string;
  lookupKey: string;
  priceId: string;
  /** Integer cents. */
  amount: number;
  tax: number;
  total: number;
  currency: string;
  knownCountry: string | null;
  cardCountry: string | null;
  cardFunding: string | null;
  wallet: string | null;
  billingCountry: string | null;
  billingState: string | null;
  livemode: boolean;
  lang: string | null;
  status: WebPurchaseStatus;
  failure?: string;
  /** Cents refunded when a refund did not cover the whole charge. */
  partialRefund?: number;
  stripe: WebPurchaseStripeRefs;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The entry id for one purchase: sha256 of `uid:confirmationTokenId`, hex, first 32 characters.
 *
 * A confirmation token is single use, so one id is one attempt, and a retried call with the same
 * token lands on the same entry instead of charging again.
 */
export function purchaseIdFor(uid: string, confirmationTokenId: string): string {
  return crypto.createHash("sha256").update(`${uid}:${confirmationTokenId}`, "utf8").digest("hex").slice(0, 32);
}

export function ledgerEntryToData(entry: WebPurchaseEntry): DocumentData {
  const stripe: DocumentData = { customerId: entry.stripe.customerId };
  for (const key of ["subscriptionId", "invoiceId", "paymentIntentId", "chargeId"] as const) {
    if (entry.stripe[key]) stripe[key] = entry.stripe[key];
  }
  const data: DocumentData = {
    plan: entry.plan,
    tierShown: entry.tierShown,
    tierCharged: entry.tierCharged,
    lookupKey: entry.lookupKey,
    priceId: entry.priceId,
    amount: entry.amount,
    tax: entry.tax,
    total: entry.total,
    currency: entry.currency,
    knownCountry: entry.knownCountry,
    cardCountry: entry.cardCountry,
    cardFunding: entry.cardFunding,
    wallet: entry.wallet,
    billingCountry: entry.billingCountry,
    billingState: entry.billingState,
    livemode: entry.livemode,
    lang: entry.lang,
    status: entry.status,
    stripe,
    createdAt: Timestamp.fromDate(entry.createdAt),
    updatedAt: Timestamp.fromDate(entry.updatedAt),
  };
  if (entry.uid) data.uid = entry.uid;
  if (entry.failure) data.failure = entry.failure;
  if (entry.partialRefund !== undefined) data.partialRefund = entry.partialRefund;
  return data;
}

/** Reads an entry back; undefined when it is not one this backend wrote. */
export function ledgerEntryFromData(purchaseId: string, data: DocumentData | undefined): WebPurchaseEntry | undefined {
  if (!data || !isWebPlan(data.plan) || !(WEB_PURCHASE_STATUSES as readonly string[]).includes(data.status)) {
    return undefined;
  }
  const stripe = data.stripe && typeof data.stripe === "object" ? (data.stripe as Record<string, unknown>) : {};
  if (typeof stripe.customerId !== "string") return undefined;
  const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
  const cents = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const date = (value: unknown): Date => (value instanceof Timestamp ? value.toDate() : new Date(0));
  const refs: WebPurchaseStripeRefs = { customerId: stripe.customerId };
  for (const key of ["subscriptionId", "invoiceId", "paymentIntentId", "chargeId"] as const) {
    if (typeof stripe[key] === "string" && stripe[key]) refs[key] = stripe[key] as string;
  }
  const entry: WebPurchaseEntry = {
    purchaseId,
    plan: data.plan,
    tierShown: text(data.tierShown) ?? "",
    tierCharged: text(data.tierCharged) ?? "",
    lookupKey: text(data.lookupKey) ?? "",
    priceId: text(data.priceId) ?? "",
    amount: cents(data.amount),
    tax: cents(data.tax),
    total: cents(data.total),
    currency: text(data.currency) ?? "usd",
    knownCountry: text(data.knownCountry),
    cardCountry: text(data.cardCountry),
    cardFunding: text(data.cardFunding),
    wallet: text(data.wallet),
    billingCountry: text(data.billingCountry),
    billingState: text(data.billingState),
    livemode: data.livemode === true,
    lang: text(data.lang),
    status: data.status,
    stripe: refs,
    createdAt: date(data.createdAt),
    updatedAt: date(data.updatedAt),
  };
  if (typeof data.uid === "string" && data.uid) entry.uid = data.uid;
  if (typeof data.failure === "string") entry.failure = data.failure;
  if (typeof data.partialRefund === "number") entry.partialRefund = data.partialRefund;
  return entry;
}

export const LEDGER_PAGE_SIZE = 200;
/** More entries than an account can make in half a year of throttled attempts; past it, something is wrong. */
export const LEDGER_MAX_ENTRIES = 2000;

/**
 * Every entry of an account, paged in document-id order.
 *
 * Equality on `uid` ordered by document id needs no composite index, and reading every page
 * means a paid lifetime entry can never fall out of the read however many failed attempts
 * came after it. Past `LEDGER_MAX_ENTRIES` the read stops and logs an error.
 */
export async function listLedgerEntries(
  db: Firestore,
  uid: string,
  options: { pageSize?: number; maxEntries?: number } = {}
): Promise<WebPurchaseEntry[]> {
  const pageSize = options.pageSize ?? LEDGER_PAGE_SIZE;
  const maxEntries = options.maxEntries ?? LEDGER_MAX_ENTRIES;
  const entries: WebPurchaseEntry[] = [];
  let last: string | undefined;
  let read = 0;
  for (;;) {
    let query = db.collection(WEB_PURCHASES_COLLECTION).where("uid", "==", uid).orderBy(FieldPath.documentId()).limit(pageSize);
    if (last) query = query.startAfter(last);
    const snapshot = await query.get();
    for (const doc of snapshot.docs) {
      const entry = ledgerEntryFromData(doc.id, doc.data());
      if (entry) entries.push(entry);
    }
    read += snapshot.size;
    if (snapshot.size < pageSize) return entries;
    if (read >= maxEntries) {
      functions.logger.error("web_ledger_read_capped", { uid, read, maxEntries });
      return entries;
    }
    last = snapshot.docs[snapshot.docs.length - 1].id;
  }
}

/**
 * Pending entries created before `createdBefore`, oldest first.
 *
 * Filtered on `status` alone and dated in memory, so the query needs no composite index; pending
 * entries are few, since each is settled within a call or by the next reconcile run.
 */
export async function listPendingEntries(
  db: Firestore,
  createdBefore: Date,
  limit = 200
): Promise<WebPurchaseEntry[]> {
  const snapshot = await db.collection(WEB_PURCHASES_COLLECTION).where("status", "==", "pending").limit(limit).get();
  return snapshot.docs
    .map((doc) => ledgerEntryFromData(doc.id, doc.data()))
    .filter((entry): entry is WebPurchaseEntry => entry !== undefined && entry.createdAt.getTime() < createdBefore.getTime())
    .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
}

/** What Stripe says about the charge behind one invoice. */
export interface ChargeFacts {
  chargeId?: string;
  paymentIntentId?: string;
  paymentIntentStatus?: string;
  /** Stripe's own `refunded`: true only once the whole charge is refunded. */
  fullyRefunded: boolean;
  amountRefunded: number;
  dispute: DisputeState;
}

/**
 * The worst dispute on a charge.
 *
 * `open` (needs response, under review) and `lost` (including an appeal after losing) take
 * access away. `none` covers no dispute, one that was won, and the warning and prevented stages,
 * which take no money.
 */
export type DisputeState = "none" | "open" | "lost";

export interface InvoiceFacts {
  id: string;
  status: string | null;
  paidAt?: Date;
  /** The latest `lines.data[].period.end`: the end of the service the invoice paid for. */
  periodEnd?: Date;
  charge?: ChargeFacts;
}

/**
 * The status an entry moves to given its invoice, or the current one when nothing moved it.
 *
 * Follows Stripe: a paid invoice is `paid` unless its charge is refunded in full or disputed;
 * a won dispute returns it to `paid`. An open invoice leaves the entry as it was, since the
 * purchase callable owns `failed`. A voided invoice abandons an entry still pending.
 */
export function nextLedgerStatus(current: WebPurchaseStatus, invoice: InvoiceFacts | undefined): WebPurchaseStatus {
  if (!invoice) return current;
  if (invoice.status === "paid") {
    if (current === "refunded" || current === "dispute_lost") return current;
    const charge = invoice.charge;
    if (charge?.dispute === "lost") return "dispute_lost";
    if (charge?.dispute === "open") return "disputed";
    if (charge?.fullyRefunded) return "refunded";
    return "paid";
  }
  if ((invoice.status === "void" || invoice.status === "uncollectible") && current === "pending") {
    return "abandoned";
  }
  return current;
}

/** The ledger fields one sync changes, or undefined when it changes none. */
export function ledgerUpdate(
  entry: WebPurchaseEntry,
  invoice: InvoiceFacts | undefined,
  now: Date
): DocumentData | undefined {
  const update: DocumentData = {};
  const status = nextLedgerStatus(entry.status, invoice);
  if (status !== entry.status) update.status = status;
  const charge = invoice?.charge;
  if (charge && !charge.fullyRefunded && charge.amountRefunded > 0 && entry.partialRefund !== charge.amountRefunded) {
    update.partialRefund = charge.amountRefunded;
  }
  if (charge?.chargeId && entry.stripe.chargeId !== charge.chargeId) update["stripe.chargeId"] = charge.chargeId;
  if (charge?.paymentIntentId && entry.stripe.paymentIntentId !== charge.paymentIntentId) {
    update["stripe.paymentIntentId"] = charge.paymentIntentId;
  }
  if (Object.keys(update).length === 0) return undefined;
  update.updatedAt = Timestamp.fromDate(now);
  return update;
}
