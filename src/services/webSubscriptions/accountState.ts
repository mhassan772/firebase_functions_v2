import { DocumentData, Firestore } from "firebase-admin/firestore";
import { MANUAL_SLOT_ENABLED } from "../../config/constants";
import { StorePlatform } from "../../types/subscriptions";
import {
  MANUAL_SLOT,
  STATE_SLOTS,
  SUBSCRIPTION_STATE_COLLECTION,
  stateDataToNormalized,
  stateDocumentId,
  timestampDate,
  webSlotIndex,
} from "../subscriptions/persistence";
import { isWebPlan, WebPlan } from "./ledger";

/**
 * What the purchase callables read about an account's entitlement: its web slot for the key's
 * mode, its production store slots and its manual slot. Slots are read directly, not the master,
 * because the master shows only the winning source and the guards need every one.
 */
export interface WebAccountSlots {
  web?: DocumentData;
  apple?: DocumentData;
  google?: DocumentData;
  manual?: DocumentData;
}

const STORE_PRODUCTION_SLOTS: ReadonlyArray<{ platform: StorePlatform; key: "apple" | "google" }> = [
  { platform: "apple", key: "apple" },
  { platform: "google", key: "google" },
];

export async function readWebAccountSlots(db: Firestore, uid: string, livemode: boolean): Promise<WebAccountSlots> {
  const slots = db.collection(SUBSCRIPTION_STATE_COLLECTION);
  const web = STATE_SLOTS[webSlotIndex(livemode)];
  // With the manual kill switch off the slot is not even read, as the projection ignores it.
  const [webSnap, ...otherSnaps] = await db.getAll(
    slots.doc(stateDocumentId(uid, web.platform, web.environment)),
    ...STORE_PRODUCTION_SLOTS.map((slot) => slots.doc(stateDocumentId(uid, slot.platform, "production"))),
    ...(MANUAL_SLOT_ENABLED ? [slots.doc(stateDocumentId(uid, MANUAL_SLOT.platform, MANUAL_SLOT.environment))] : [])
  );
  const storeSnaps = otherSnaps.slice(0, STORE_PRODUCTION_SLOTS.length);
  const manualSnap = otherSnaps[STORE_PRODUCTION_SLOTS.length];
  const result: WebAccountSlots = {};
  if (webSnap.exists) result.web = webSnap.data();
  storeSnaps.forEach((snapshot, index) => {
    if (snapshot.exists) result[STORE_PRODUCTION_SLOTS[index].key] = snapshot.data();
  });
  if (manualSnap?.exists) result.manual = manualSnap.data();
  return result;
}

export interface StoreSubscriptionSummary {
  platform: StorePlatform;
  autoRenewing: boolean;
}

/** A slot's state as the reader sees it now; undefined for a slot that cannot be read. */
function normalized(data: DocumentData | undefined, now: Date) {
  if (!data) return undefined;
  try {
    return stateDataToNormalized(data, now);
  } catch {
    return undefined;
  }
}

/**
 * The account's active production store subscription, an auto-renewing one first.
 *
 * Sandbox and test store slots never count: a tester's sandbox purchase is not a real
 * subscription the buyer could be charged for twice.
 */
export function storeSubscriptionOf(slots: WebAccountSlots, now: Date): StoreSubscriptionSummary | null {
  const active: StoreSubscriptionSummary[] = [];
  for (const { platform, key } of STORE_PRODUCTION_SLOTS) {
    const state = normalized(slots[key], now);
    if (state?.active) active.push({ platform, autoRenewing: state.autoRenewing === true });
  }
  return active.find((row) => row.autoRenewing) ?? active[0] ?? null;
}

export type WebAccountState =
  | "none"
  | "active"
  | "cancelling"
  | "payment_failed"
  | "needs_action"
  | "ended"
  | "lifetime";

export interface WebSlotView {
  state: WebAccountState;
  plan?: string;
  /** The Stripe subscription behind a subscription slot. */
  subscriptionId?: string;
  purchaseId?: string;
  customerId?: string;
  paidThrough?: Date;
  expiresAt?: Date;
  tier?: string;
}

/**
 * The web slot in the words the pages use.
 *
 * `needs_action` (a renewal waiting for the buyer to authenticate) is checked before
 * `payment_failed`, since authenticating is what fixes it. A subscription past due beyond its
 * grace reads `payment_failed` too: it can still be paid, so it is not ended.
 */
export function webSlotView(data: DocumentData | undefined, now: Date): WebSlotView {
  const state = normalized(data, now);
  if (!data || !state) return { state: "none" };
  const web = (data.web ?? {}) as DocumentData;
  const view: WebSlotView = {
    state: "ended",
    plan: typeof data.productId === "string" ? data.productId : undefined,
    subscriptionId: typeof web.subscriptionId === "string" ? web.subscriptionId : undefined,
    purchaseId: typeof web.purchaseId === "string" ? web.purchaseId : undefined,
    customerId: typeof web.customerId === "string" ? web.customerId : undefined,
    paidThrough: timestampDate(web.paidThrough),
    expiresAt: state.expiresAt,
    tier: typeof web.tier === "string" ? web.tier : undefined,
  };
  if (view.plan === "web_lifetime") {
    view.state = state.active ? "lifetime" : "ended";
    return view;
  }
  const pastDue = state.status === "grace_period" || state.status === "billing_retry";
  if (web.needsAction === true && (state.active || pastDue)) view.state = "needs_action";
  else if (pastDue) view.state = "payment_failed";
  else if (state.active && state.status === "canceled") view.state = "cancelling";
  else if (state.active) view.state = "active";
  return view;
}

export type WebPurchaseBlocker = "lifetime_active" | "already_subscribed" | "store_subscription_active";

/**
 * Why a purchase of `plan` would be refused now, in the order the purchase checks them.
 *
 * A web subscription that is active, cancelling, past due or waiting for authentication blocks
 * monthly and yearly; lifetime may still be bought, and the subscription is cancelled once it
 * is paid. An auto-renewing production store subscription blocks monthly and yearly only.
 * With no plan, every blocker that applies to some plan is listed.
 */
export function purchaseBlockers(
  slots: WebAccountSlots,
  now: Date,
  plan?: WebPlan
): { blockers: WebPurchaseBlocker[]; storeSubscription: StoreSubscriptionSummary | null } {
  const blockers: WebPurchaseBlocker[] = [];
  const view = webSlotView(slots.web, now);
  const storeSubscription = storeSubscriptionOf(slots, now);
  const recurring = plan === undefined || plan !== "web_lifetime";
  if (view.state === "lifetime") blockers.push("lifetime_active");
  if (recurring && ["active", "cancelling", "payment_failed", "needs_action"].includes(view.state)) {
    blockers.push("already_subscribed");
  }
  if (recurring && storeSubscription?.autoRenewing) blockers.push("store_subscription_active");
  return { blockers, storeSubscription };
}

/** One source of premium the account holds now, as `/subscribe` lists it. */
export interface PremiumSource {
  source: "web" | StorePlatform | "manual";
  /** `lifetime` is web only; `grant` is manual only. */
  kind: "subscription" | "lifetime" | "grant";
  /** Web only. */
  plan?: WebPlan;
  state: "active" | "cancelling" | "payment_failed" | "needs_action";
  /** True only when it will charge again on its own. */
  renews: boolean;
  /** ISO 8601: the renewal date when `renews`, else the day premium ends. Absent for lifetime. */
  until?: string;
}

const LISTED_WEB_STATES: ReadonlyArray<WebAccountState> = ["active", "cancelling", "payment_failed", "needs_action"];

/**
 * Every source of premium the account holds now, in the order web, Apple, Google, manual.
 *
 * The one reader of the slots for what the purchase page lists and what a purchase must be
 * confirmed over. A source is listed only while it gives premium, except a web subscription
 * whose renewal failed or waits for authentication: it still renews once paid. The web date is
 * `paidThrough`, not `expiresAt`, which carries the grace margin the buyer never paid for.
 */
export function existingPremium(slots: WebAccountSlots, now: Date): PremiumSource[] {
  const sources: PremiumSource[] = [];
  const view = webSlotView(slots.web, now);
  if (view.state === "lifetime") {
    sources.push({ source: "web", kind: "lifetime", plan: "web_lifetime", state: "active", renews: false });
  } else if (LISTED_WEB_STATES.includes(view.state)) {
    sources.push({
      source: "web",
      kind: "subscription",
      ...(isWebPlan(view.plan) ? { plan: view.plan } : {}),
      state: view.state as PremiumSource["state"],
      renews: view.state !== "cancelling",
      ...(view.paidThrough ? { until: view.paidThrough.toISOString() } : {}),
    });
  }
  for (const { platform, key } of STORE_PRODUCTION_SLOTS) {
    const state = normalized(slots[key], now);
    if (!state?.active) continue;
    const renews = state.autoRenewing === true;
    sources.push({
      source: platform,
      kind: "subscription",
      state: renews ? "active" : "cancelling",
      renews,
      until: state.expiresAt.toISOString(),
    });
  }
  const manual = normalized(slots.manual, now);
  if (manual?.active) {
    sources.push({ source: "manual", kind: "grant", state: "active", renews: false, until: manual.expiresAt.toISOString() });
  }
  return sources;
}
