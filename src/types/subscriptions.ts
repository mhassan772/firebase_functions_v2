export type SubscriptionPlatform = "apple" | "google";

export type StoreEnvironment = "production" | "sandbox" | "test";

export type NormalizedSubscriptionStatus =
  | "active"
  | "canceled"
  | "grace_period"
  | "billing_retry"
  | "account_hold"
  | "paused"
  | "pending"
  | "expired"
  | "revoked"
  | "unknown";

export interface NormalizedSubscription {
  active: boolean;
  status: NormalizedSubscriptionStatus;
  platform: SubscriptionPlatform;
  productId: string;
  expiresAt: Date;
  autoRenewing?: boolean;
  inGracePeriod: boolean;
  environment: StoreEnvironment;
  originalTransactionId?: string;
  purchaseReference?: string;
  lastStoreEventAt: Date;
  lastVerifiedAt: Date;
}

export interface SubscriptionResponse {
  active: boolean;
  status: NormalizedSubscriptionStatus;
  platform: SubscriptionPlatform;
  productId: string;
  expiresAt: string;
  autoRenewing?: boolean;
  inGracePeriod: boolean;
  environment: StoreEnvironment;
  originalTransactionId?: string;
  purchaseReference?: string;
  lastStoreEventAt: string;
  lastVerifiedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface AppleOwnershipIdentity {
  platform: "apple";
  environment: "production" | "sandbox";
  originalTransactionId: string;
}

export interface GoogleOwnershipIdentity {
  platform: "google";
  environment: "production" | "test";
  purchaseToken: string;
  linkedPurchaseToken?: string;
  currentPurchaseToken: string;
}

export type OwnershipIdentity =
  | AppleOwnershipIdentity
  | GoogleOwnershipIdentity;

export interface VerifiedSubscription {
  subscription: NormalizedSubscription;
  ownership: OwnershipIdentity[];
}

export interface StoreEvent {
  key: string;
  platform: SubscriptionPlatform;
  environment: StoreEnvironment;
  eventType: string;
  eventAt: Date;
}

export interface PersistedSubscriptionResult {
  duplicate: boolean;
  subscription: SubscriptionResponse;
}
