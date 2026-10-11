import {
  DocumentData,
  DocumentReference,
  DocumentSnapshot,
  Timestamp,
  Transaction,
} from "firebase-admin/firestore";
import { admin } from "../../config/admin";
import {
  MANUAL_GRANT_PRODUCT_ID,
  MANUAL_SLOT_ENABLED,
} from "../../config/constants";
import {
  ManualProjectionSummary,
  NormalizedSubscription,
  OwnershipIdentity,
  PersistedSubscriptionResult,
  SourceSummary,
  SourceSummaryResponse,
  StoreEnvironment,
  StoreEvent,
  SubscriptionResponse,
  SubscriptionSource,
  VerifiedSubscription,
} from "../../types/subscriptions";
import { sha256Hex, sha256Reference } from "./crypto";
import { DeviceLimits, devicesBlockFromMaster } from "./devices";
import { SubscriptionError } from "./errors";
import { selectMasterState } from "./normalization";

export const SUBSCRIPTION_MASTER_COLLECTION = "subscription_master";
export const SUBSCRIPTION_OWNERSHIP_COLLECTION =
  "subscription_purchase_ownership";
export const SUBSCRIPTION_STATE_COLLECTION = "subscription_store_state";
export const SUBSCRIPTION_EVENT_COLLECTION = "subscription_store_events";
/** Written by the old admin portal; now only mirrored to for app versions that still read it. */
export const LEGACY_MANUAL_COLLECTION = "subscriptions_manual";

export interface StateSlot {
  platform: SubscriptionSource;
  environment: StoreEnvironment;
}

export const MANUAL_SLOT: StateSlot = {
  platform: "manual",
  environment: "production",
};

/** Every projection slot, in a fixed order; snapshot arrays are indexed by it. */
export const STATE_SLOTS: StateSlot[] = [
  { platform: "apple", environment: "production" },
  { platform: "apple", environment: "sandbox" },
  { platform: "google", environment: "production" },
  { platform: "google", environment: "test" },
  MANUAL_SLOT,
];

export const MANUAL_SLOT_INDEX = STATE_SLOTS.indexOf(MANUAL_SLOT);

/**
 * Everything a projection decision reads, fetched in one `getAll` so that the
 * store path and the manual path touch the same documents and Firestore
 * serialises concurrent writes for one account.
 */
export interface ProjectionState {
  masterRef: DocumentReference;
  masterSnapshot: DocumentSnapshot;
  slotRefs: DocumentReference[];
  slotSnapshots: DocumentSnapshot[];
  legacyRef: DocumentReference;
  /** Present only when the read asked for the legacy document. */
  legacySnapshot?: DocumentSnapshot;
  extraSnapshots: DocumentSnapshot[];
}

export interface ReadProjectionOptions {
  /** Also read the legacy `subscriptions_manual` document. Only the manual path needs it. */
  includeLegacy?: boolean;
  extraRefs?: DocumentReference[];
}

export async function readProjectionState(
  transaction: Transaction,
  uid: string,
  options: ReadProjectionOptions = {}
): Promise<ProjectionState> {
  const firestore = admin.firestore();
  const masterRef = firestore.collection(SUBSCRIPTION_MASTER_COLLECTION).doc(uid);
  const slotRefs = STATE_SLOTS.map((slot) =>
    firestore
      .collection(SUBSCRIPTION_STATE_COLLECTION)
      .doc(stateDocumentId(uid, slot.platform, slot.environment))
  );
  const legacyRef = firestore
    .collection(LEGACY_MANUAL_COLLECTION)
    .doc(legacyManualDocumentId(uid));
  const extraRefs = options.extraRefs ?? [];
  const snapshots = await transaction.getAll(
    masterRef,
    ...slotRefs,
    ...(options.includeLegacy ? [legacyRef] : []),
    ...extraRefs
  );
  const legacyOffset = 1 + slotRefs.length;
  const extraOffset = legacyOffset + (options.includeLegacy ? 1 : 0);
  return {
    masterRef,
    masterSnapshot: snapshots[0],
    slotRefs,
    slotSnapshots: snapshots.slice(1, legacyOffset),
    legacyRef,
    legacySnapshot: options.includeLegacy ? snapshots[legacyOffset] : undefined,
    extraSnapshots: snapshots.slice(extraOffset),
  };
}

/** The normalized state of every existing slot, indexed like `STATE_SLOTS`. */
export function slotStates(
  slotSnapshots: DocumentSnapshot[],
  now: Date
): Array<NormalizedSubscription | undefined> {
  return slotSnapshots.map((snapshot, index) => {
    // With the kill switch off the manual document is not even parsed, so a
    // malformed one cannot disturb the store path.
    if (index === MANUAL_SLOT_INDEX && !MANUAL_SLOT_ENABLED) {
      return undefined;
    }
    return snapshot.exists ? stateDataToNormalized(snapshot.data()!, now) : undefined;
  });
}

/**
 * Rebuilds and writes the master document from the proposed slot set.
 *
 * Takes the states the caller intends to persist, not the snapshots, because a
 * slot written earlier in the same transaction is not visible through its
 * snapshot. Only the device fields survive from the previous master.
 */
export function projectMaster(
  transaction: Transaction,
  state: ProjectionState,
  proposedStates: Array<NormalizedSubscription | undefined>,
  now: Timestamp
): DocumentData {
  const present = proposedStates.filter(
    (candidate): candidate is NormalizedSubscription => candidate !== undefined
  );
  const considered = MANUAL_SLOT_ENABLED
    ? present
    : present.filter((candidate) => candidate.platform !== "manual");
  const masterState = selectMasterState(considered);
  if (!masterState) {
    throw new SubscriptionError(
      "internal",
      "master-state-unavailable",
      "No verified state is available for the subscription projection."
    );
  }

  const existing = state.masterSnapshot.exists
    ? state.masterSnapshot.data()
    : undefined;
  const createdAt = existing ? existing.createdAt : now;
  const masterData = preserveMasterDeviceFields(
    buildMasterProjection(
      masterState,
      createdAt,
      now,
      buildSourceSummaries(considered)
    ),
    existing
  );
  transaction.set(state.masterRef, masterData);
  return masterData;
}

export async function persistVerifiedSubscription(
  uid: string,
  verified: VerifiedSubscription,
  event?: StoreEvent
): Promise<PersistedSubscriptionResult> {
  if (!uid) {
    throw new SubscriptionError(
      "internal",
      "authenticated-uid-missing",
      "Authenticated UID is unavailable."
    );
  }

  const firestore = admin.firestore();
  const ownershipById = new Map(
    verified.ownership.map((identity) => [
      ownershipDocumentId(identity),
      identity,
    ])
  );
  const ownershipRefs = [...ownershipById.keys()].map((id) =>
    firestore.collection(SUBSCRIPTION_OWNERSHIP_COLLECTION).doc(id)
  );
  const eventRef = event
    ? firestore
      .collection(SUBSCRIPTION_EVENT_COLLECTION)
      .doc(eventDocumentId(event))
    : undefined;

  return firestore.runTransaction(async (transaction) => {
    const state = await readProjectionState(transaction, uid, {
      extraRefs: [...ownershipRefs, ...(eventRef ? [eventRef] : [])],
    });
    const ownershipSnapshots = state.extraSnapshots.slice(
      0,
      ownershipRefs.length
    );
    const eventSnapshot = eventRef
      ? state.extraSnapshots[ownershipRefs.length]
      : undefined;

    if (eventSnapshot?.exists) {
      if (!state.masterSnapshot.exists) {
        throw new SubscriptionError(
          "internal",
          "duplicate-event-master-missing",
          "A processed store event has no subscription projection."
        );
      }
      return {
        duplicate: true,
        subscription: masterDataToResponse(state.masterSnapshot.data()!),
      };
    }

    assertOwnershipClaimAllowed(
      ownershipSnapshots
        .filter((snapshot) => snapshot.exists)
        .map((snapshot) => snapshot.get("uid")),
      uid
    );

    const now = Timestamp.now();
    ownershipSnapshots.forEach((snapshot, index) => {
      const identity = ownershipById.get(ownershipRefs[index].id)!;
      transaction.set(
        ownershipRefs[index],
        ownershipData(
          uid,
          identity,
          snapshot.exists ? snapshot.get("createdAt") : now,
          now
        )
      );
    });

    const incomingStateIndex = STATE_SLOTS.findIndex(
      (slot) =>
        slot.platform === verified.subscription.platform &&
        slot.environment === verified.subscription.environment
    );
    if (incomingStateIndex < 0 || incomingStateIndex === MANUAL_SLOT_INDEX) {
      throw new SubscriptionError(
        "invalid-store-data",
        "store-environment-unsupported",
        "The verified store environment is unsupported."
      );
    }

    const existingIncoming = state.slotSnapshots[incomingStateIndex];
    const existingEventAt = timestampDate(
      existingIncoming.get("lastStoreEventAt")
    );
    const isStaleEvent = !shouldApplyIncomingState(
      existingEventAt,
      verified.subscription.lastStoreEventAt,
      Boolean(event)
    );

    const states = slotStates(state.slotSnapshots, now.toDate());
    if (!isStaleEvent) {
      states[incomingStateIndex] = verified.subscription;
      transaction.set(
        state.slotRefs[incomingStateIndex],
        stateData(
          uid,
          verified.subscription,
          existingIncoming.exists ? existingIncoming.get("createdAt") : now,
          now
        )
      );
    }

    const masterData = projectMaster(transaction, state, states, now);
    if (eventRef && event) {
      transaction.create(eventRef, {
        platform: event.platform,
        environment: event.environment,
        eventType: event.eventType,
        eventAt: Timestamp.fromDate(event.eventAt),
        claimed: true,
        createdAt: now,
      });
    }

    return {
      duplicate: false,
      subscription: masterDataToResponse(masterData),
    };
  });
}

export async function recordUnclaimedStoreEvent(
  event: StoreEvent
): Promise<boolean> {
  const firestore = admin.firestore();
  const eventRef = firestore
    .collection(SUBSCRIPTION_EVENT_COLLECTION)
    .doc(eventDocumentId(event));
  return firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(eventRef);
    if (snapshot.exists) {
      return false;
    }
    transaction.create(eventRef, {
      platform: event.platform,
      environment: event.environment,
      eventType: event.eventType,
      eventAt: Timestamp.fromDate(event.eventAt),
      claimed: false,
      createdAt: Timestamp.now(),
    });
    return true;
  });
}

export async function resolveVerifiedOwner(
  ownership: OwnershipIdentity[]
): Promise<string | undefined> {
  const uniqueIds = [...new Set(ownership.map(ownershipDocumentId))];
  if (uniqueIds.length === 0) {
    return undefined;
  }
  const firestore = admin.firestore();
  const snapshots = await firestore.getAll(
    ...uniqueIds.map((id) =>
      firestore.collection(SUBSCRIPTION_OWNERSHIP_COLLECTION).doc(id)
    )
  );
  const owners = new Set<string>();
  for (const snapshot of snapshots) {
    if (!snapshot.exists) {
      continue;
    }
    const uid = snapshot.get("uid");
    if (typeof uid !== "string" || !uid) {
      throw new SubscriptionError(
        "internal",
        "ownership-record-invalid",
        "A purchase ownership record is invalid."
      );
    }
    owners.add(uid);
  }
  if (owners.size > 1) {
    throw new SubscriptionError(
      "ownership-conflict",
      "purchase-chain-owner-conflict",
      "A linked purchase chain has conflicting owners."
    );
  }
  return owners.values().next().value;
}

export async function resolveGoogleCurrentToken(
  purchaseToken: string
): Promise<string> {
  const firestore = admin.firestore();
  const ref = firestore
    .collection(SUBSCRIPTION_OWNERSHIP_COLLECTION)
    .doc(googleOwnershipDocumentId(purchaseToken));
  const snapshot = await ref.get();
  const currentToken = snapshot.get("currentPurchaseToken");
  return typeof currentToken === "string" && currentToken
    ? currentToken
    : purchaseToken;
}

export function ownershipDocumentId(identity: OwnershipIdentity): string {
  if (identity.platform === "apple") {
    return `apple_${sha256Reference(
      `${identity.environment}:${identity.originalTransactionId}`
    )}`;
  }
  return googleOwnershipDocumentId(identity.purchaseToken);
}

export function googleOwnershipDocumentId(purchaseToken: string): string {
  return `google_${sha256Reference(purchaseToken)}`;
}

export function assertOwnershipClaimAllowed(
  ownerUids: unknown[],
  claimingUid: string
): void {
  for (const ownerUid of ownerUids) {
    if (typeof ownerUid !== "string" || !ownerUid) {
      throw new SubscriptionError(
        "internal",
        "ownership-record-invalid",
        "A purchase ownership record is invalid."
      );
    }
    if (ownerUid !== claimingUid) {
      throw new SubscriptionError(
        "ownership-conflict",
        "purchase-owned-by-another-user",
        "The verified purchase belongs to another Firebase account."
      );
    }
  }
}

export function shouldApplyIncomingState(
  existingEventAt: Date | undefined,
  incomingEventAt: Date,
  isNotification: boolean
): boolean {
  return !(
    isNotification &&
    existingEventAt &&
    incomingEventAt.getTime() < existingEventAt.getTime()
  );
}

export function stateDocumentId(
  uid: string,
  platform: SubscriptionSource,
  environment: StoreEnvironment
): string {
  return `${sha256Reference(uid)}_${platform}_${environment}`;
}

/** The legacy collection keys by the hex sha256 of the uid, which is what old app versions compute. */
export function legacyManualDocumentId(uid: string): string {
  return sha256Hex(uid);
}

function eventDocumentId(event: StoreEvent): string {
  return `${event.platform}_${sha256Reference(
    `${event.environment}:${event.key}`
  )}`;
}

function ownershipData(
  uid: string,
  identity: OwnershipIdentity,
  createdAt: unknown,
  updatedAt: Timestamp
): DocumentData {
  if (identity.platform === "apple") {
    return {
      uid,
      platform: identity.platform,
      environment: identity.environment,
      originalTransactionId: identity.originalTransactionId,
      createdAt: timestampOr(createdAt, updatedAt),
      updatedAt,
    };
  }

  const data: DocumentData = {
    uid,
    platform: identity.platform,
    environment: identity.environment,
    purchaseToken: identity.purchaseToken,
    currentPurchaseToken: identity.currentPurchaseToken,
    purchaseReference: sha256Reference(identity.purchaseToken),
    currentPurchaseReference: sha256Reference(identity.currentPurchaseToken),
    createdAt: timestampOr(createdAt, updatedAt),
    updatedAt,
  };
  if (identity.linkedPurchaseToken) {
    data.linkedPurchaseToken = identity.linkedPurchaseToken;
    data.linkedPurchaseReference = sha256Reference(
      identity.linkedPurchaseToken
    );
  }
  return data;
}

export function stateData(
  uid: string,
  state: NormalizedSubscription,
  createdAt: unknown,
  updatedAt: Timestamp
): DocumentData {
  const data: DocumentData = {
    uid,
    active: state.active,
    status: state.status,
    platform: state.platform,
    productId: state.productId,
    expiresAt: Timestamp.fromDate(state.expiresAt),
    inGracePeriod: state.inGracePeriod,
    environment: state.environment,
    lastStoreEventAt: Timestamp.fromDate(state.lastStoreEventAt),
    lastVerifiedAt: Timestamp.fromDate(state.lastVerifiedAt),
    createdAt: timestampOr(createdAt, updatedAt),
    updatedAt,
  };
  if (state.autoRenewing !== undefined) {
    data.autoRenewing = state.autoRenewing;
  }
  if (state.originalTransactionId) {
    data.originalTransactionId = state.originalTransactionId;
  }
  if (state.purchaseReference) {
    data.purchaseReference = state.purchaseReference;
  }
  if (state.manual) {
    data.manual = withoutUndefined({ ...state.manual });
  }
  return data;
}

/** Firestore rejects `undefined`; optional summary fields are dropped rather than written. */
export function withoutUndefined<T extends Record<string, unknown>>(record: T): T {
  for (const key of Object.keys(record)) {
    if (record[key] === undefined) {
      delete record[key];
    }
  }
  return record;
}

export function buildMasterProjection(
  state: NormalizedSubscription,
  createdAt: unknown,
  updatedAt: Timestamp,
  sources?: SourceSummary[]
): DocumentData {
  const data: DocumentData = {
    active: state.active,
    status: state.status,
    platform: state.platform,
    productId: state.productId,
    expiresAt: Timestamp.fromDate(state.expiresAt),
    inGracePeriod: state.inGracePeriod,
    environment: state.environment,
    lastStoreEventAt: Timestamp.fromDate(state.lastStoreEventAt),
    lastVerifiedAt: Timestamp.fromDate(state.lastVerifiedAt),
    createdAt: timestampOr(createdAt, updatedAt),
    updatedAt,
  };
  if (state.autoRenewing !== undefined) {
    data.autoRenewing = state.autoRenewing;
  }
  if (state.platform === "apple" && state.originalTransactionId) {
    data.originalTransactionId = state.originalTransactionId;
  }
  if (state.platform === "google" && state.purchaseReference) {
    data.purchaseReference = state.purchaseReference;
  }
  if (state.platform === "manual" && state.manual) {
    data.manual = withoutUndefined({ ...state.manual });
  }
  if (sources) {
    data.sources = sources.map((source) => {
      const row: DocumentData = {
        platform: source.platform,
        environment: source.environment,
        status: source.status,
        expiresAt: Timestamp.fromDate(source.expiresAt),
      };
      if (source.autoRenewing !== undefined) {
        row.autoRenewing = source.autoRenewing;
      }
      return row;
    });
  }
  return data;
}

/**
 * One row per existing slot, so a client that may only read the master still
 * sees every source. Activity is deliberately not stored: a manual grant lapses
 * with no write to flip it, so readers derive it from the date and status.
 */
export function buildSourceSummaries(
  states: NormalizedSubscription[]
): SourceSummary[] {
  return states.map((state) => ({
    platform: state.platform,
    environment: state.environment,
    status: state.status,
    expiresAt: state.expiresAt,
    autoRenewing: state.autoRenewing,
  }));
}

// Device management fields live on the master doc but are owned by the
// device callable and the admin device actions, not the store projection;
// renewals and manual grants must not erase them.
export const MASTER_DEVICE_FIELDS = [
  "allowed_devices",
  "devices",
  "device_log",
  "last_date_replacing_device",
  "extra_device_seats",
] as const;

export function preserveMasterDeviceFields(
  masterData: DocumentData,
  existing: DocumentData | undefined
): DocumentData {
  if (!existing) {
    return masterData;
  }
  for (const field of MASTER_DEVICE_FIELDS) {
    if (existing[field] !== undefined) {
      masterData[field] = existing[field];
    }
  }
  return masterData;
}

/**
 * Reads a slot document back into a normalized state.
 *
 * A manual slot has no store event to re-verify it, so its `active` flag is
 * never trusted from the document: it is derived here from the status and the
 * expiry, and a lapsed grant reads as `expired`.
 */
export function stateDataToNormalized(
  data: DocumentData,
  now: Date = new Date()
): NormalizedSubscription {
  const expiresAt = timestampDate(data.expiresAt);
  const lastStoreEventAt = timestampDate(data.lastStoreEventAt);
  const lastVerifiedAt = timestampDate(data.lastVerifiedAt);
  if (!expiresAt || !lastStoreEventAt || !lastVerifiedAt) {
    throw new SubscriptionError(
      "internal",
      "store-state-timestamp-invalid",
      "A stored subscription state is invalid."
    );
  }
  const isManual = data.platform === "manual";
  let active = data.active === true;
  let status = data.status;
  if (isManual) {
    const revoked = status === "revoked";
    const inFuture = expiresAt.getTime() > now.getTime();
    active = !revoked && inFuture;
    status = revoked ? "revoked" : inFuture ? "active" : "expired";
  }
  const normalized: NormalizedSubscription = {
    active,
    status,
    platform: data.platform,
    productId: isManual ? MANUAL_GRANT_PRODUCT_ID : data.productId,
    expiresAt,
    autoRenewing: isManual
      ? false
      : typeof data.autoRenewing === "boolean"
        ? data.autoRenewing
        : undefined,
    inGracePeriod: !isManual && data.inGracePeriod === true,
    environment: data.environment,
    originalTransactionId:
      typeof data.originalTransactionId === "string"
        ? data.originalTransactionId
        : undefined,
    purchaseReference:
      typeof data.purchaseReference === "string"
        ? data.purchaseReference
        : undefined,
    lastStoreEventAt,
    lastVerifiedAt,
  };
  if (isManual) {
    normalized.manual = manualSummaryFromData(data.manual);
  }
  return normalized;
}

function manualSummaryFromData(value: unknown): ManualProjectionSummary {
  const record =
    value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const summary: ManualProjectionSummary = {
    activeGrantCount:
      typeof record.activeGrantCount === "number" ? record.activeGrantCount : 0,
    ledgerRevision:
      typeof record.ledgerRevision === "number" ? record.ledgerRevision : 0,
  };
  if (typeof record.grantSource === "string") {
    summary.grantSource = record.grantSource as ManualProjectionSummary["grantSource"];
  }
  return summary;
}

/**
 * Converts a master document for callers. The device block is always present;
 * its `max_number_of_devices` only when the caller read the app settings.
 */
export function masterDataToResponse(
  data: DocumentData,
  deviceLimits?: DeviceLimits
): SubscriptionResponse {
  const expiresAt = timestampDate(data.expiresAt);
  const lastStoreEventAt = timestampDate(data.lastStoreEventAt);
  const lastVerifiedAt = timestampDate(data.lastVerifiedAt);
  const createdAt = timestampDate(data.createdAt);
  const updatedAt = timestampDate(data.updatedAt);
  if (
    !expiresAt ||
    !lastStoreEventAt ||
    !lastVerifiedAt ||
    !createdAt ||
    !updatedAt
  ) {
    throw new SubscriptionError(
      "internal",
      "master-timestamp-invalid",
      "The subscription projection is invalid."
    );
  }

  const response: SubscriptionResponse = {
    active: data.active === true,
    status: data.status,
    platform: data.platform,
    productId: data.productId,
    expiresAt: expiresAt.toISOString(),
    inGracePeriod: data.inGracePeriod === true,
    environment: data.environment,
    lastStoreEventAt: lastStoreEventAt.toISOString(),
    lastVerifiedAt: lastVerifiedAt.toISOString(),
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
    devices: devicesBlockFromMaster(data, deviceLimits),
  };
  if (typeof data.autoRenewing === "boolean") {
    response.autoRenewing = data.autoRenewing;
  }
  if (typeof data.originalTransactionId === "string") {
    response.originalTransactionId = data.originalTransactionId;
  }
  if (typeof data.purchaseReference === "string") {
    response.purchaseReference = data.purchaseReference;
  }
  if (data.manual && typeof data.manual === "object") {
    response.manual = manualSummaryFromData(data.manual);
  }
  if (Array.isArray(data.sources)) {
    response.sources = data.sources
      .map((row: DocumentData): SourceSummaryResponse | undefined => {
        const rowExpiresAt = timestampDate(row.expiresAt);
        if (!rowExpiresAt) {
          return undefined;
        }
        const summary: SourceSummaryResponse = {
          platform: row.platform,
          environment: row.environment,
          status: row.status,
          expiresAt: rowExpiresAt.toISOString(),
        };
        if (typeof row.autoRenewing === "boolean") {
          summary.autoRenewing = row.autoRenewing;
        }
        return summary;
      })
      .filter((row): row is SourceSummaryResponse => row !== undefined);
  }
  return response;
}

export function timestampDate(value: unknown): Date | undefined {
  return value instanceof Timestamp ? value.toDate() : undefined;
}

export function timestampOr(value: unknown, fallback: Timestamp): Timestamp {
  return value instanceof Timestamp ? value : fallback;
}
