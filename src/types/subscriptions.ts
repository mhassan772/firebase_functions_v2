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

/** The operating system a registered device reported. The app never sends another value. */
export type DevicePlatform = "ios" | "android";

/**
 * One registered device as callers see it.
 *
 * A seat registered before devices carried metadata has an id and nothing
 * else, so the name is empty, the platform `unknown` and the dates absent.
 */
export interface DeviceEntryResponse {
  id: string;
  name: string;
  platform: DevicePlatform | "unknown";
  registered_at?: string;
  last_seen_at?: string;
}

/** The device block of a subscription response; membership is `allowed_devices`. */
export interface SubscriptionDevicesResponse {
  allowed_devices: string[];
  devices: DeviceEntryResponse[];
  /** Present only when the caller read the app settings; the limit lives there. */
  max_number_of_devices?: number;
  extra_device_seats: number;
  last_date_replacing_device?: string;
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
  devices: SubscriptionDevicesResponse;
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

/**
 * What Play reports about the current token beyond its state. Read by the
 * handlers for acknowledgement and ownership; never persisted or returned.
 */
export interface GooglePurchaseMetadata {
  acknowledgementState?: string;
  subscriptionState?: string;
  startTime?: Date;
  /** The last expired token for this product, set on a Play Store resubscription. */
  expiredPurchaseToken?: string;
  /** The account binding that expired purchase carried, when the app set one. */
  expiredAccountBinding?: string;
}

export interface VerifiedSubscription {
  subscription: NormalizedSubscription;
  ownership: OwnershipIdentity[];
  google?: GooglePurchaseMetadata;
}

export interface StoreEvent {
  key: string;
  platform: StorePlatform;
  environment: StoreEnvironment;
  eventType: string;
  eventAt: Date;
  /** The Play purchase the event is about, as a reference; never the token. */
  purchaseReference?: string;
  /** The Apple purchase the event is about. */
  originalTransactionId?: string;
  /** Play's refund type on a voided purchase. */
  refundType?: number;
}

export interface PersistedSubscriptionResult {
  duplicate: boolean;
  /** False when the verified state was too old, or about a purchase the slot no longer holds. */
  stateApplied: boolean;
  /**
   * True when an active state took the slot from a different purchase that was
   * still active and unexpired. The user then holds two living purchases on
   * one store, which is the one case the slot model cannot represent.
   */
  displacedLivingPurchase: boolean;
  subscription: SubscriptionResponse;
}
