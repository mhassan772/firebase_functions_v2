import { Firestore, Timestamp } from "firebase-admin/firestore";
import type Stripe from "stripe";

/**
 * `web_stripe_events/{eventId}`: one document per Stripe event handled, by the webhook or the
 * reconcile run. Created with `create()`, so an existing document means the event was already
 * handled; a TTL policy on `expiresAt` removes it after 90 days, well past Stripe's 30 days of
 * event history and its three days of webhook retries. Server-only.
 */
export const WEB_STRIPE_EVENTS_COLLECTION = "web_stripe_events";
export const WEB_EVENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** The event types that can change an entitlement; at most 20, the limit of one `events.list`. */
export const HANDLED_WEB_EVENT_TYPES = [
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.payment_action_required",
  "invoice.voided",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "charge.refunded",
  "refund.created",
  "refund.updated",
  "charge.dispute.created",
  "charge.dispute.updated",
  "charge.dispute.closed",
  "charge.dispute.funds_withdrawn",
  "charge.dispute.funds_reinstated",
  // Queues the yearly renewal reminder; no sync.
  "invoice.upcoming",
] as const;

export function isHandledWebEventType(type: string): boolean {
  return (HANDLED_WEB_EVENT_TYPES as readonly string[]).includes(type);
}

export type WebEventSource = "webhook" | "reconcile";

/**
 * The part of an event the handler reads: its identity, and the ids that lead to a customer.
 *
 * The reconcile run keeps failed events in its state document for the next run, so only this
 * much is stored there, never a whole Stripe object.
 */
export interface WebEventRef {
  id: string;
  type: string;
  created: number;
  livemode: boolean;
  object: {
    object?: string;
    id?: string;
    customer?: string;
    charge?: string;
    /** An invoice's subscription, for `invoice.upcoming`, whose preview has no id of its own. */
    subscription?: string;
    total?: number;
    currency?: string;
  };
}

export function webEventRef(event: Stripe.Event): WebEventRef {
  const object = (event.data?.object ?? {}) as unknown as Record<string, unknown>;
  const idOf = (value: unknown): string | undefined =>
    typeof value === "string" ? value : value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string"
      ? (value as { id: string }).id
      : undefined;
  const ref: WebEventRef = {
    id: event.id,
    type: event.type,
    created: event.created,
    livemode: event.livemode,
    object: {},
  };
  if (typeof object.object === "string") ref.object.object = object.object;
  const id = idOf(object.id);
  if (id) ref.object.id = id;
  const customer = idOf(object.customer);
  if (customer) ref.object.customer = customer;
  const charge = idOf(object.charge);
  if (charge) ref.object.charge = charge;
  if (object.object === "invoice") {
    const parent = object.parent as { subscription_details?: { subscription?: unknown } } | null | undefined;
    const subscription = idOf(parent?.subscription_details?.subscription) ?? idOf(object.subscription);
    if (subscription) ref.object.subscription = subscription;
    if (typeof object.total === "number") ref.object.total = object.total;
    if (typeof object.currency === "string") ref.object.currency = object.currency;
  }
  return ref;
}

export function webEventRefFromData(data: Record<string, unknown>): WebEventRef {
  const object = (data.object && typeof data.object === "object" ? data.object : {}) as WebEventRef["object"];
  return {
    id: String(data.id),
    type: String(data.type),
    created: typeof data.created === "number" ? data.created : 0,
    livemode: data.livemode === true,
    object: { ...object },
  };
}

/**
 * A `processing` claim older than this belongs to a handler that died (a timeout or a crash
 * before it could release the claim) and may be taken over. The webhook's timeout is 120 s.
 */
export const WEB_EVENT_STALE_CLAIM_MS = 5 * 60 * 1000;

/**
 * Claims an event; false when it was already handled, or is being handled right now.
 *
 * Decided in a transaction on the event document, so two deliveries never both claim it. A
 * claim still `processing` after `WEB_EVENT_STALE_CLAIM_MS` is taken over, so a handler that
 * died mid-way does not lose the event for good.
 */
export async function claimWebEvent(
  db: Firestore,
  event: WebEventRef,
  source: WebEventSource,
  now: Date
): Promise<boolean> {
  const ref = db.collection(WEB_STRIPE_EVENTS_COLLECTION).doc(event.id);
  const claim = {
    type: event.type,
    created: Timestamp.fromMillis(event.created * 1000),
    receivedAt: Timestamp.fromDate(now),
    source,
    outcome: "processing",
    expiresAt: Timestamp.fromMillis(now.getTime() + WEB_EVENT_RETENTION_MS),
  };
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) {
      transaction.create(ref, claim);
      return true;
    }
    const receivedAt = snapshot.get("receivedAt");
    const claimedMs = receivedAt instanceof Timestamp ? receivedAt.toMillis() : 0;
    if (snapshot.get("outcome") === "processing" && now.getTime() - claimedMs >= WEB_EVENT_STALE_CLAIM_MS) {
      transaction.set(ref, { ...claim, reclaimed: true });
      return true;
    }
    return false;
  });
}

export async function recordWebEventOutcome(db: Firestore, eventId: string, outcome: string): Promise<void> {
  await db.collection(WEB_STRIPE_EVENTS_COLLECTION).doc(eventId).update({ outcome });
}

/** Releases a claim so Stripe's retry, or the next reconcile run, handles the event again. */
export async function releaseWebEvent(db: Firestore, eventId: string): Promise<void> {
  await db.collection(WEB_STRIPE_EVENTS_COLLECTION).doc(eventId).delete();
}
