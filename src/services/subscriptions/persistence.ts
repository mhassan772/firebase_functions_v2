import { DocumentData, Timestamp } from "firebase-admin/firestore";
import { admin } from "../../config/admin";
import {
  NormalizedSubscription,
  OwnershipIdentity,
  PersistedSubscriptionResult,
  StoreEnvironment,
  StoreEvent,
  SubscriptionPlatform,
  SubscriptionResponse,
  VerifiedSubscription,
} from "../../types/subscriptions";
import { sha256Reference } from "./crypto";
import { SubscriptionError } from "./errors";
import { selectMasterState } from "./normalization";

export const SUBSCRIPTION_MASTER_COLLECTION = "subscription_master";
export const SUBSCRIPTION_OWNERSHIP_COLLECTION =
  "subscription_purchase_ownership";
export const SUBSCRIPTION_STATE_COLLECTION = "subscription_store_state";
export const SUBSCRIPTION_EVENT_COLLECTION = "subscription_store_events";

const STATE_SLOTS: Array<{
  platform: SubscriptionPlatform;
  environment: StoreEnvironment;
}> = [
  { platform: "apple", environment: "production" },
  { platform: "apple", environment: "sandbox" },
  { platform: "google", environment: "production" },
  { platform: "google", environment: "test" },
];

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
  const masterRef = firestore.collection(SUBSCRIPTION_MASTER_COLLECTION).doc(uid);
  const stateRefs = STATE_SLOTS.map((slot) =>
    firestore
      .collection(SUBSCRIPTION_STATE_COLLECTION)
      .doc(stateDocumentId(uid, slot.platform, slot.environment))
  );
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
    const allRefs = [
      masterRef,
      ...stateRefs,
      ...ownershipRefs,
      ...(eventRef ? [eventRef] : []),
    ];
    const snapshots = await transaction.getAll(...allRefs);
    const masterSnapshot = snapshots[0];
    const stateSnapshots = snapshots.slice(1, 1 + stateRefs.length);
    const ownershipSnapshots = snapshots.slice(
      1 + stateRefs.length,
      1 + stateRefs.length + ownershipRefs.length
    );
    const eventSnapshot = eventRef ? snapshots[snapshots.length - 1] : undefined;

    if (eventSnapshot?.exists) {
      if (!masterSnapshot.exists) {
        throw new SubscriptionError(
          "internal",
          "duplicate-event-master-missing",
          "A processed store event has no subscription projection."
        );
      }
      return {
        duplicate: true,
        subscription: masterDataToResponse(masterSnapshot.data()!),
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
    if (incomingStateIndex < 0) {
      throw new SubscriptionError(
        "invalid-store-data",
        "store-environment-unsupported",
        "The verified store environment is unsupported."
      );
    }

    const existingIncoming = stateSnapshots[incomingStateIndex];
    const existingEventAt = timestampDate(
      existingIncoming.get("lastStoreEventAt")
    );
    const isStaleEvent = !shouldApplyIncomingState(
      existingEventAt,
      verified.subscription.lastStoreEventAt,
      Boolean(event)
    );

    const states = stateSnapshots
      .map((snapshot) =>
        snapshot.exists ? stateDataToNormalized(snapshot.data()!) : undefined
      );
    if (!isStaleEvent) {
      states[incomingStateIndex] = verified.subscription;
      transaction.set(
        stateRefs[incomingStateIndex],
        stateData(
          uid,
          verified.subscription,
          existingIncoming.exists ? existingIncoming.get("createdAt") : now,
          now
        )
      );
    }

    const masterState = selectMasterState(
      states.filter(
        (state): state is NormalizedSubscription => state !== undefined
      )
    );
    if (!masterState) {
      throw new SubscriptionError(
        "internal",
        "master-state-unavailable",
        "No verified state is available for the subscription projection."
      );
    }

    const createdAt = masterSnapshot.exists
      ? masterSnapshot.get("createdAt")
      : now;
    const masterData = buildMasterProjection(masterState, createdAt, now);
    transaction.set(masterRef, masterData);
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

function stateDocumentId(
  uid: string,
  platform: SubscriptionPlatform,
  environment: StoreEnvironment
): string {
  return `${sha256Reference(uid)}_${platform}_${environment}`;
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

function stateData(
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
  return data;
}

export function buildMasterProjection(
  state: NormalizedSubscription,
  createdAt: unknown,
  updatedAt: Timestamp
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
  return data;
}

function stateDataToNormalized(data: DocumentData): NormalizedSubscription {
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
  return {
    active: data.active === true,
    status: data.status,
    platform: data.platform,
    productId: data.productId,
    expiresAt,
    autoRenewing:
      typeof data.autoRenewing === "boolean"
        ? data.autoRenewing
        : undefined,
    inGracePeriod: data.inGracePeriod === true,
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
}

function masterDataToResponse(data: DocumentData): SubscriptionResponse {
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
  return response;
}

function timestampDate(value: unknown): Date | undefined {
  return value instanceof Timestamp ? value.toDate() : undefined;
}

function timestampOr(value: unknown, fallback: Timestamp): Timestamp {
  return value instanceof Timestamp ? value : fallback;
}
