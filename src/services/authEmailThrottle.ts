import * as crypto from "crypto";
import { Firestore, Timestamp } from "firebase-admin/firestore";

/**
 * Server-only counters for account emails. Firestore rules deny clients everything here, and a
 * TTL policy on `expiresAt` removes documents once their day window has passed.
 */
export const AUTH_EMAIL_THROTTLE_COLLECTION = "auth_email_throttle";

export interface AuthEmailThrottleLimits {
  /** Shortest gap between two emails to the same address. */
  addressIntervalMs: number;
  addressPerWindow: number;
  uidPerWindow: number;
  windowMs: number;
}

export const DEFAULT_AUTH_EMAIL_LIMITS: AuthEmailThrottleLimits = {
  addressIntervalMs: 60_000,
  addressPerWindow: 5,
  uidPerWindow: 10,
  windowMs: 24 * 60 * 60 * 1000,
};

export type AuthEmailThrottleReason = "address_minute" | "address_day" | "uid_day";

export class AuthEmailThrottledError extends Error {
  constructor(readonly reason: AuthEmailThrottleReason) {
    super(`Too many account emails (${reason}).`);
    this.name = "AuthEmailThrottledError";
  }
}

export interface CounterState {
  windowStartMs: number;
  count: number;
  lastSentMs: number;
}

export type ThrottleDecision =
  | { allowed: true; address: CounterState; uid: CounterState }
  | { allowed: false; reason: AuthEmailThrottleReason };

export interface AuthEmailThrottle {
  /** Counts one email to `address` for `uid`, or throws AuthEmailThrottledError and counts nothing. */
  consume(input: { uid: string; address: string; nowMs: number }): Promise<void>;
}

/** Trimmed and lower-cased, so one mailbox is one counter however it is typed. */
export function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

export function hashAddress(address: string): string {
  return crypto.createHash("sha256").update(normalizeAddress(address), "utf8").digest("hex");
}

/** Decides one send against both counters; a counter whose day window has passed starts again. */
export function evaluateThrottle(
  address: CounterState | undefined,
  uid: CounterState | undefined,
  nowMs: number,
  limits: AuthEmailThrottleLimits = DEFAULT_AUTH_EMAIL_LIMITS
): ThrottleDecision {
  const current = (state: CounterState | undefined): CounterState => {
    if (!state || nowMs - state.windowStartMs >= limits.windowMs || nowMs < state.windowStartMs) {
      return { windowStartMs: nowMs, count: 0, lastSentMs: state?.lastSentMs ?? 0 };
    }
    return state;
  };
  const addressState = current(address);
  const uidState = current(uid);

  if (address && nowMs - address.lastSentMs < limits.addressIntervalMs) {
    return { allowed: false, reason: "address_minute" };
  }
  if (addressState.count >= limits.addressPerWindow) return { allowed: false, reason: "address_day" };
  if (uidState.count >= limits.uidPerWindow) return { allowed: false, reason: "uid_day" };

  return {
    allowed: true,
    address: { ...addressState, count: addressState.count + 1, lastSentMs: nowMs },
    uid: { ...uidState, count: uidState.count + 1, lastSentMs: nowMs },
  };
}

export function addressDocId(address: string): string {
  return `address_${hashAddress(address)}`;
}

export function uidDocId(uid: string): string {
  // Encoded so a custom uid with a slash cannot form a nested path.
  return `uid_${encodeURIComponent(uid)}`;
}

/** Counters kept in Firestore, checked and updated in one transaction so parallel calls cannot overshoot. */
export function firestoreAuthEmailThrottle(
  db: () => Firestore,
  limits: AuthEmailThrottleLimits = DEFAULT_AUTH_EMAIL_LIMITS
): AuthEmailThrottle {
  return {
    async consume({ uid, address, nowMs }) {
      const firestore = db();
      const collection = firestore.collection(AUTH_EMAIL_THROTTLE_COLLECTION);
      const addressRef = collection.doc(addressDocId(address));
      const uidRef = collection.doc(uidDocId(uid));

      await firestore.runTransaction(async (transaction) => {
        const [addressSnap, uidSnap] = await transaction.getAll(addressRef, uidRef);
        const decision = evaluateThrottle(
          readState(addressSnap.data()),
          readState(uidSnap.data()),
          nowMs,
          limits
        );
        if (!decision.allowed) throw new AuthEmailThrottledError(decision.reason);

        transaction.set(addressRef, toDocument("address", decision.address, limits));
        transaction.set(uidRef, toDocument("uid", decision.uid, limits));
      });
    },
  };
}

function readState(data: FirebaseFirestore.DocumentData | undefined): CounterState | undefined {
  if (!data) return undefined;
  const millis = (value: unknown): number => (value instanceof Timestamp ? value.toMillis() : 0);
  return {
    windowStartMs: millis(data.windowStart),
    count: typeof data.count === "number" ? data.count : 0,
    lastSentMs: millis(data.lastSentAt),
  };
}

function toDocument(kind: "address" | "uid", state: CounterState, limits: AuthEmailThrottleLimits) {
  const expiresMs = Math.max(state.windowStartMs + limits.windowMs, state.lastSentMs + limits.addressIntervalMs);
  return {
    kind,
    count: state.count,
    windowStart: Timestamp.fromMillis(state.windowStartMs),
    lastSentAt: Timestamp.fromMillis(state.lastSentMs),
    expiresAt: Timestamp.fromMillis(expiresMs),
  };
}
