import {
  NormalizedSubscription,
  NormalizedSubscriptionStatus,
  StoreEnvironment,
} from "../../types/subscriptions";

export interface AppleNormalizationInput {
  productId: string;
  environment: "production" | "sandbox";
  originalTransactionId: string;
  expiresAtMs: number;
  gracePeriodExpiresAtMs?: number;
  signedAtMs?: number;
  revocationAtMs?: number;
  storeStatus: number;
  autoRenewing?: boolean;
  now?: Date;
}

export interface GoogleNormalizationInput {
  productId: string;
  environment: "production" | "test";
  purchaseReference: string;
  expiryTime: string;
  subscriptionState?: string | null;
  autoRenewing?: boolean;
  eventAt?: Date;
  now?: Date;
}

function validDate(value: Date): boolean {
  return Number.isFinite(value.getTime());
}

export function normalizeAppleSubscription(
  input: AppleNormalizationInput
): NormalizedSubscription {
  const now = input.now ?? new Date();
  const paidExpiry = new Date(input.expiresAtMs);
  const graceExpiry = input.gracePeriodExpiresAtMs
    ? new Date(input.gracePeriodExpiresAtMs)
    : undefined;
  const revoked = Boolean(input.revocationAtMs);
  const graceIsCurrent =
    input.storeStatus === 4 &&
    graceExpiry !== undefined &&
    validDate(graceExpiry) &&
    graceExpiry.getTime() > now.getTime();
  const effectiveExpiry =
    graceIsCurrent && graceExpiry!.getTime() > paidExpiry.getTime()
      ? graceExpiry!
      : paidExpiry;

  let status: NormalizedSubscriptionStatus;
  let active = false;
  switch (input.storeStatus) {
    case 1:
      active = !revoked && paidExpiry.getTime() > now.getTime();
      status = active
        ? input.autoRenewing === false
          ? "canceled"
          : "active"
        : revoked
          ? "revoked"
          : "expired";
      break;
    case 2:
      status = revoked ? "revoked" : "expired";
      break;
    case 3:
      status = revoked ? "revoked" : "billing_retry";
      break;
    case 4:
      active = !revoked && graceIsCurrent;
      status = revoked ? "revoked" : active ? "grace_period" : "expired";
      break;
    case 5:
      status = "revoked";
      break;
    default:
      status = "unknown";
  }

  const eventMs = Math.max(
    input.signedAtMs ?? 0,
    input.revocationAtMs ?? 0,
    0
  );

  return {
    active,
    status,
    platform: "apple",
    productId: input.productId,
    expiresAt: effectiveExpiry,
    autoRenewing: input.autoRenewing,
    inGracePeriod: status === "grace_period",
    environment: input.environment,
    originalTransactionId: input.originalTransactionId,
    lastStoreEventAt: eventMs > 0 ? new Date(eventMs) : now,
    lastVerifiedAt: now,
  };
}

const GOOGLE_STATUS_MAP: Record<string, NormalizedSubscriptionStatus> = {
  SUBSCRIPTION_STATE_PENDING: "pending",
  SUBSCRIPTION_STATE_ACTIVE: "active",
  SUBSCRIPTION_STATE_PAUSED: "paused",
  SUBSCRIPTION_STATE_IN_GRACE_PERIOD: "grace_period",
  SUBSCRIPTION_STATE_ON_HOLD: "account_hold",
  SUBSCRIPTION_STATE_CANCELED: "canceled",
  SUBSCRIPTION_STATE_EXPIRED: "expired",
  SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED: "revoked",
};

export function normalizeGoogleSubscription(
  input: GoogleNormalizationInput
): NormalizedSubscription {
  const now = input.now ?? new Date();
  const expiresAt = new Date(input.expiryTime);
  const mapped =
    GOOGLE_STATUS_MAP[input.subscriptionState ?? ""] ?? "unknown";
  const futureExpiry =
    validDate(expiresAt) && expiresAt.getTime() > now.getTime();
  const active =
    futureExpiry &&
    (mapped === "active" ||
      mapped === "grace_period" ||
      mapped === "canceled");
  const status =
    mapped === "active" && input.autoRenewing === false
      ? "canceled"
      : mapped === "active" && !futureExpiry
        ? "expired"
        : mapped;

  return {
    active,
    status,
    platform: "google",
    productId: input.productId,
    expiresAt,
    autoRenewing: input.autoRenewing,
    inGracePeriod: status === "grace_period",
    environment: input.environment,
    purchaseReference: input.purchaseReference,
    lastStoreEventAt: input.eventAt ?? now,
    lastVerifiedAt: now,
  };
}

export function selectMasterState(
  states: NormalizedSubscription[]
): NormalizedSubscription | undefined {
  if (states.length === 0) {
    return undefined;
  }

  const activeStates = states.filter((state) => state.active);
  const candidates = activeStates.length > 0 ? activeStates : states;
  return [...candidates].sort((left, right) => {
    if (activeStates.length > 0) {
      const environmentDifference =
        environmentPriority(right.environment) -
        environmentPriority(left.environment);
      if (environmentDifference !== 0) {
        return environmentDifference;
      }
      const expiryDifference =
        right.expiresAt.getTime() - left.expiresAt.getTime();
      if (expiryDifference !== 0) {
        return expiryDifference;
      }
    }

    const verifiedDifference =
      right.lastVerifiedAt.getTime() - left.lastVerifiedAt.getTime();
    if (verifiedDifference !== 0) {
      return verifiedDifference;
    }
    return left.platform.localeCompare(right.platform);
  })[0];
}

function environmentPriority(environment: StoreEnvironment): number {
  return environment === "production" ? 2 : 1;
}
