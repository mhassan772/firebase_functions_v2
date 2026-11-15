import * as crypto from "crypto";
import { DocumentData, Firestore, Timestamp } from "firebase-admin/firestore";

/**
 * Server-only counters for purchase attempts, one per uid and one per caller IP.
 *
 * Built like `auth_email_throttle`: a day window per counter, checked and counted in one
 * transaction, and a TTL policy on `expiresAt` removes a document once its window has passed.
 * It bounds card testing through the purchase callable: each attempt can reach Stripe.
 */
export const WEB_PURCHASE_THROTTLE_COLLECTION = "web_purchase_throttle";

export interface WebPurchaseThrottleLimits {
  uidPerWindow: number;
  ipPerWindow: number;
  windowMs: number;
}

export const DEFAULT_WEB_PURCHASE_LIMITS: WebPurchaseThrottleLimits = {
  uidPerWindow: 10,
  ipPerWindow: 30,
  windowMs: 24 * 60 * 60 * 1000,
};

export type WebPurchaseThrottleReason = "uid_day" | "ip_day";

export class WebPurchaseThrottledError extends Error {
  constructor(readonly reason: WebPurchaseThrottleReason) {
    super(`Too many purchase attempts (${reason}).`);
    this.name = "WebPurchaseThrottledError";
  }
}

export interface AttemptCounter {
  windowStartMs: number;
  count: number;
  lastAttemptMs: number;
}

export type WebPurchaseThrottleDecision =
  | { allowed: true; uid: AttemptCounter; ip?: AttemptCounter }
  | { allowed: false; reason: WebPurchaseThrottleReason };

export interface WebPurchaseThrottle {
  /** Counts one attempt, or throws WebPurchaseThrottledError and counts nothing. */
  consume(input: { uid: string; ip?: string; nowMs: number }): Promise<void>;
}

/** Decides one attempt against both counters; a counter whose day window has passed starts again. */
export function evaluatePurchaseThrottle(
  uid: AttemptCounter | undefined,
  ip: AttemptCounter | undefined,
  hasIp: boolean,
  nowMs: number,
  limits: WebPurchaseThrottleLimits = DEFAULT_WEB_PURCHASE_LIMITS
): WebPurchaseThrottleDecision {
  const current = (state: AttemptCounter | undefined): AttemptCounter => {
    if (!state || nowMs - state.windowStartMs >= limits.windowMs || nowMs < state.windowStartMs) {
      return { windowStartMs: nowMs, count: 0, lastAttemptMs: state?.lastAttemptMs ?? 0 };
    }
    return state;
  };
  const uidState = current(uid);
  if (uidState.count >= limits.uidPerWindow) return { allowed: false, reason: "uid_day" };
  const next = (state: AttemptCounter): AttemptCounter => ({ ...state, count: state.count + 1, lastAttemptMs: nowMs });
  if (!hasIp) return { allowed: true, uid: next(uidState) };
  const ipState = current(ip);
  if (ipState.count >= limits.ipPerWindow) return { allowed: false, reason: "ip_day" };
  return { allowed: true, uid: next(uidState), ip: next(ipState) };
}

export function throttleUidDocId(uid: string): string {
  // Encoded so a custom uid with a slash cannot form a nested path.
  return `uid_${encodeURIComponent(uid)}`;
}

/** The IP is stored only as its hash. */
export function throttleIpDocId(ip: string): string {
  return `ip_${crypto.createHash("sha256").update(ip.trim(), "utf8").digest("hex")}`;
}

export function firestoreWebPurchaseThrottle(
  db: () => Firestore,
  limits: WebPurchaseThrottleLimits = DEFAULT_WEB_PURCHASE_LIMITS
): WebPurchaseThrottle {
  return {
    async consume({ uid, ip, nowMs }) {
      const firestore = db();
      const collection = firestore.collection(WEB_PURCHASE_THROTTLE_COLLECTION);
      const uidRef = collection.doc(throttleUidDocId(uid));
      const ipRef = ip ? collection.doc(throttleIpDocId(ip)) : undefined;
      await firestore.runTransaction(async (transaction) => {
        const [uidSnap, ipSnap] = await transaction.getAll(uidRef, ...(ipRef ? [ipRef] : []));
        const decision = evaluatePurchaseThrottle(
          readCounter(uidSnap.data()),
          readCounter(ipSnap?.data()),
          ipRef !== undefined,
          nowMs,
          limits
        );
        if (!decision.allowed) throw new WebPurchaseThrottledError(decision.reason);
        transaction.set(uidRef, toDocument("uid", decision.uid, limits));
        if (ipRef && decision.ip) transaction.set(ipRef, toDocument("ip", decision.ip, limits));
      });
    },
  };
}

function readCounter(data: DocumentData | undefined): AttemptCounter | undefined {
  if (!data) return undefined;
  const millis = (value: unknown): number => (value instanceof Timestamp ? value.toMillis() : 0);
  return {
    windowStartMs: millis(data.windowStart),
    count: typeof data.count === "number" ? data.count : 0,
    lastAttemptMs: millis(data.lastAttemptAt),
  };
}

function toDocument(kind: "uid" | "ip", state: AttemptCounter, limits: WebPurchaseThrottleLimits) {
  return {
    kind,
    count: state.count,
    windowStart: Timestamp.fromMillis(state.windowStartMs),
    lastAttemptAt: Timestamp.fromMillis(state.lastAttemptMs),
    expiresAt: Timestamp.fromMillis(state.windowStartMs + limits.windowMs),
  };
}
