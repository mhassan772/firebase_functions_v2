/** A store that verifies purchases. Store-only code paths (ownership, account binding, events) use this. */
export type StorePlatform = "apple" | "google";

/** @deprecated Alias kept for the store-only call sites; new code names `StorePlatform` or `SubscriptionSource`. */
export type SubscriptionPlatform = StorePlatform;

/** Where an entitlement slot comes from: a store, or an admin grant. */
export type SubscriptionSource = StorePlatform | "manual";

export type ManualGrantSource =
  | "egypt_request"
  | "migration_restoration"
  | "admin_manual_add"
  | "legacy_import";

export interface ManualGrantMetadata {
  grantSource: ManualGrantSource;
  grantedBy?: string;
  paymentMethod?: string;
  amountPaid?: number;
  countryCode?: string;
  legacyDocId?: string;
  note?: string;
}

export type ManualGrantKind = "months" | "absolute";
export type ManualGrantBase = "extend" | "today";
export type ManualGrantStatus = "active" | "reversed" | "revoked";

/**
 * One attributable grant in the ledger kept on the manual slot.
 *
 * The slot's expiry is replayed from the active grants, never edited directly,
 * so undoing one grant can never take time that another grant provided.
 */
export interface ManualGrant {
  grantId: string;
  kind: ManualGrantKind;
  months?: number;
  expiresAt?: Date;
  base: ManualGrantBase;
  grantedAt: Date;
  grantedBy: string;
  queue?: { collection: string; id: string };
  metadata: ManualGrantMetadata;
  status: ManualGrantStatus;
  statusChangedAt?: Date;
  statusReason?: string;
}

/** Summary of the manual slot carried on the master projection. */
export interface ManualProjectionSummary {
  activeGrantCount: number;
  grantSource?: ManualGrantSource;
  ledgerRevision: number;
}

/** One row of the master's `sources` list. Activity is derived by readers from the date and status. */
export interface SourceSummary {
  platform: SubscriptionSource;
  environment: StoreEnvironment;
  status: NormalizedSubscriptionStatus;
  expiresAt: Date;
  autoRenewing?: boolean;
}

export interface SourceSummaryResponse {
  platform: SubscriptionSource;
  environment: StoreEnvironment;
  status: NormalizedSubscriptionStatus;
  expiresAt: string;
  autoRenewing?: boolean;
}

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
  platform: SubscriptionSource;
  productId: string;
  expiresAt: Date;
  autoRenewing?: boolean;
  inGracePeriod: boolean;
  environment: StoreEnvironment;
  originalTransactionId?: string;
  purchaseReference?: string;
  lastStoreEventAt: Date;
  lastVerifiedAt: Date;
  manual?: ManualProjectionSummary;
}

export interface SubscriptionResponse {
  active: boolean;
  status: NormalizedSubscriptionStatus;
  platform: SubscriptionSource;
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
  manual?: ManualProjectionSummary;
  sources?: SourceSummaryResponse[];
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
  platform: StorePlatform;
  environment: StoreEnvironment;
  eventType: string;
  eventAt: Date;
}

export interface PersistedSubscriptionResult {
  duplicate: boolean;
  subscription: SubscriptionResponse;
}
