import {
  DocumentData,
  DocumentReference,
  DocumentSnapshot,
  Timestamp,
} from "firebase-admin/firestore";
import { admin } from "../../config/admin";
import {
  LEGACY_MIRROR_ENABLED,
  MANUAL_GRANT_PRODUCT_ID,
  MANUAL_GRANT_TIME_ZONE,
  MANUAL_SLOT_ENABLED,
} from "../../config/constants";
import {
  ManualGrant,
  ManualGrantBase,
  ManualGrantMetadata,
  ManualGrantSource,
  ManualGrantStatus,
  NormalizedSubscription,
  NormalizedSubscriptionStatus,
  SourceSummaryResponse,
  SubscriptionResponse,
} from "../../types/subscriptions";
import { DeviceLimits } from "./devices";
import { SubscriptionError } from "./errors";
import {
  LEGACY_MANUAL_COLLECTION,
  MANUAL_SLOT,
  MANUAL_SLOT_INDEX,
  ProjectionState,
  SUBSCRIPTION_MASTER_COLLECTION,
  SUBSCRIPTION_STATE_COLLECTION,
  STATE_SLOTS,
  buildSourceSummaries,
  legacyManualDocumentId,
  masterDataToResponse,
  projectMaster,
  readProjectionState,
  slotStates,
  stateData,
  stateDataToNormalized,
  stateDocumentId,
  timestampDate,
} from "./persistence";

export const MAX_GRANT_MONTHS = 120;
export const MAX_RECENT_OPERATIONS = 50;
/** Marks legacy documents the backend wrote itself, so the migration never re-imports them. */
export const LEGACY_MIRROR_SOURCE = "subscription_master_mirror";
export const LEGACY_GRANT_PREFIX = "legacy_";

// ---------------------------------------------------------------------------
// Time, in the zone the legacy data was written in
// ---------------------------------------------------------------------------

export interface WallDate {
  year: number;
  month: number;
  day: number;
}

/** The calendar date `date` falls on in the zone. */
export function wallDateIn(date: Date, timeZone: string): WallDate {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(date);
  const read = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value);
  return { year: read("year"), month: read("month"), day: read("day") };
}

function zoneOffsetMillis(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(instant);
  const read = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(
    read("year"),
    read("month") - 1,
    read("day"),
    read("hour"),
    read("minute"),
    read("second")
  );
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The last millisecond of the given wall date in the zone. */
export function endOfWallDay(wall: WallDate, timeZone: string): Date {
  // Guess the instant as if the zone were UTC, then correct by the zone's
  // offset at that instant. One correction suffices outside a DST transition
  // hour, and a second pass settles the transition cases.
  let guess = new Date(Date.UTC(wall.year, wall.month - 1, wall.day, 23, 59, 59, 999));
  for (let pass = 0; pass < 2; pass++) {
    const offset = zoneOffsetMillis(guess, timeZone);
    guess = new Date(
      Date.UTC(wall.year, wall.month - 1, wall.day, 23, 59, 59, 999) - offset
    );
  }
  return guess;
}

/** End of the day that contains `date`, in the zone. */
export function endOfDayInZone(date: Date, timeZone = MANUAL_GRANT_TIME_ZONE): Date {
  return endOfWallDay(wallDateIn(date, timeZone), timeZone);
}

/**
 * Adds whole months to the wall date of `base` and returns the end of that day.
 *
 * Day overflow follows JavaScript's `setMonth` (Jan 31 + 1 month = Mar 3),
 * which is what the old portal did; keeping it means a re-approval computes the
 * same date the admin saw before.
 */
export function addMonthsEndOfDay(
  base: Date,
  months: number,
  timeZone = MANUAL_GRANT_TIME_ZONE
): Date {
  const wall = wallDateIn(base, timeZone);
  const shifted = new Date(Date.UTC(wall.year, wall.month - 1 + months, wall.day));
  return endOfWallDay(
    {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
    },
    timeZone
  );
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export interface ReplayResult {
  /** Undefined when no active grant provides any time. */
  expiresAt?: Date;
  activeGrantCount: number;
  latestActive?: ManualGrant;
}

/**
 * Derives the manual expiry from the active grants, in the order they were
 * given. Store dates are never an input.
 *
 * A `months` grant counts from its own date, or from the running end when it
 * was given as an extension and that end is later. An `absolute` grant moves
 * the running end forward to its date. Undoing a grant and replaying therefore
 * preserves every other grant's purchased duration, re-anchored as if the
 * undone grant had never existed.
 */
export function replayGrants(
  grants: ManualGrant[],
  timeZone = MANUAL_GRANT_TIME_ZONE
): ReplayResult {
  const active = grants
    .filter((grant) => grant.status === "active")
    .sort((left, right) => left.grantedAt.getTime() - right.grantedAt.getTime());

  let runningEnd: Date | undefined;
  for (const grant of active) {
    let end: Date;
    if (grant.kind === "absolute") {
      end = grant.expiresAt ?? grant.grantedAt;
    } else {
      const extendFrom =
        grant.base === "extend" &&
        runningEnd &&
        runningEnd.getTime() > grant.grantedAt.getTime()
          ? runningEnd
          : grant.grantedAt;
      end = addMonthsEndOfDay(extendFrom, grant.months ?? 0, timeZone);
    }
    if (!runningEnd || end.getTime() > runningEnd.getTime()) {
      runningEnd = end;
    }
  }

  return {
    expiresAt: runningEnd,
    activeGrantCount: active.length,
    latestActive: active[active.length - 1],
  };
}

export function isLegacyGrant(grant: ManualGrant): boolean {
  return grant.grantId.startsWith(LEGACY_GRANT_PREFIX);
}

export function queueGrantIdPrefix(queue: { collection: string; id: string }): string {
  return `${queue.collection}_${queue.id}_r`;
}

/** The id for the next approval of a request: one record per approval, dated when it was given. */
export function nextQueueGrantId(
  grants: ManualGrant[],
  queue: { collection: string; id: string }
): string {
  const prefix = queueGrantIdPrefix(queue);
  const revisions = grants
    .filter((grant) => grant.grantId.startsWith(prefix))
    .map((grant) => Number(grant.grantId.slice(prefix.length)))
    .filter((revision) => Number.isInteger(revision));
  const next = revisions.length === 0 ? 1 : Math.max(...revisions) + 1;
  return `${prefix}${next}`;
}

export function activeGrantForQueue(
  grants: ManualGrant[],
  queue: { collection: string; id: string }
): ManualGrant | undefined {
  const prefix = queueGrantIdPrefix(queue);
  return grants.find(
    (grant) => grant.status === "active" && grant.grantId.startsWith(prefix)
  );
}

export function grantsFromData(value: unknown): ManualGrant[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const grants: ManualGrant[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const record = raw as Record<string, unknown>;
    const grantedAt = timestampDate(record.grantedAt);
    if (typeof record.grantId !== "string" || !grantedAt) {
      continue;
    }
    const grant: ManualGrant = {
      grantId: record.grantId,
      kind: record.kind === "absolute" ? "absolute" : "months",
      base: record.base === "today" ? "today" : "extend",
      grantedAt,
      grantedBy: typeof record.grantedBy === "string" ? record.grantedBy : "unknown",
      metadata: metadataFromData(record.metadata),
      status: statusFromData(record.status),
    };
    if (typeof record.months === "number") {
      grant.months = record.months;
    }
    const expiresAt = timestampDate(record.expiresAt);
    if (expiresAt) {
      grant.expiresAt = expiresAt;
    }
    if (
      record.queue &&
      typeof record.queue === "object" &&
      typeof (record.queue as Record<string, unknown>).collection === "string" &&
      typeof (record.queue as Record<string, unknown>).id === "string"
    ) {
      const queue = record.queue as Record<string, string>;
      grant.queue = { collection: queue.collection, id: queue.id };
    }
    const statusChangedAt = timestampDate(record.statusChangedAt);
    if (statusChangedAt) {
      grant.statusChangedAt = statusChangedAt;
    }
    if (typeof record.statusReason === "string") {
      grant.statusReason = record.statusReason;
    }
    grants.push(grant);
  }
  return grants;
}

function statusFromData(value: unknown): ManualGrantStatus {
  return value === "reversed" || value === "revoked" ? value : "active";
}

function metadataFromData(value: unknown): ManualGrantMetadata {
  const record =
    value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const metadata: ManualGrantMetadata = {
    grantSource: isGrantSource(record.grantSource)
      ? record.grantSource
      : "admin_manual_add",
  };
  for (const key of [
    "grantedBy",
    "paymentMethod",
    "countryCode",
    "legacyDocId",
    "note",
  ] as const) {
    if (typeof record[key] === "string") {
      metadata[key] = record[key] as string;
    }
  }
  if (typeof record.amountPaid === "number") {
    metadata.amountPaid = record.amountPaid;
  }
  return metadata;
}

function isGrantSource(value: unknown): value is ManualGrantSource {
  return (
    value === "egypt_request" ||
    value === "migration_restoration" ||
    value === "admin_manual_add" ||
    value === "legacy_import"
  );
}

export function grantToData(grant: ManualGrant): DocumentData {
  const data: DocumentData = {
    grantId: grant.grantId,
    kind: grant.kind,
    base: grant.base,
    grantedAt: Timestamp.fromDate(grant.grantedAt),
    grantedBy: grant.grantedBy,
    metadata: compact({ ...grant.metadata }),
    status: grant.status,
  };
  if (grant.months !== undefined) {
    data.months = grant.months;
  }
  if (grant.expiresAt) {
    data.expiresAt = Timestamp.fromDate(grant.expiresAt);
  }
  if (grant.queue) {
    data.queue = { ...grant.queue };
  }
  if (grant.statusChangedAt) {
    data.statusChangedAt = Timestamp.fromDate(grant.statusChangedAt);
  }
  if (grant.statusReason) {
    data.statusReason = grant.statusReason;
  }
  return data;
}

function compact(record: Record<string, unknown>): Record<string, unknown> {
  for (const key of Object.keys(record)) {
    if (record[key] === undefined) {
      delete record[key];
    }
  }
  return record;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

interface RecordedOperation {
  opId: string;
  action: string;
  at: Date;
  expiresAt?: Date;
  ledgerRevision: number;
}

function operationsFromData(value: unknown): RecordedOperation[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const operations: RecordedOperation[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const record = raw as Record<string, unknown>;
    const at = timestampDate(record.at);
    if (typeof record.opId !== "string" || !at) {
      continue;
    }
    operations.push({
      opId: record.opId,
      action: typeof record.action === "string" ? record.action : "unknown",
      at,
      expiresAt: timestampDate(record.expiresAt),
      ledgerRevision:
        typeof record.ledgerRevision === "number" ? record.ledgerRevision : 0,
    });
  }
  return operations;
}

function operationToData(operation: RecordedOperation): DocumentData {
  const data: DocumentData = {
    opId: operation.opId,
    action: operation.action,
    at: Timestamp.fromDate(operation.at),
    ledgerRevision: operation.ledgerRevision,
  };
  if (operation.expiresAt) {
    data.expiresAt = Timestamp.fromDate(operation.expiresAt);
  }
  return data;
}

export type GrantIntent =
  | { kind: "months"; months: number; base: ManualGrantBase }
  | { kind: "absolute"; expiresAt: Date };

export interface QueueReference {
  collection: string;
  id: string;
  /** The status the admin saw; the mutation is refused when it has moved on. */
  expectedStatus?: string;
}

export type ManualMutation =
  | {
    action: "grant";
    intent: GrantIntent;
    metadata: ManualGrantMetadata;
    queue?: QueueReference;
  }
  | {
    action: "adjust";
    grantId: string;
    targetMonths: number;
    expectedLedgerRevision: number;
  }
  | {
    action: "reverseRequest";
    grantId: string;
    reason: string;
    expectedLedgerRevision: number;
  }
  | { action: "revokeAccess"; reason: string; expectedLedgerRevision: number }
  | {
    action: "setBaseline";
    expiresAt: Date;
    reason: string;
    expectedLedgerRevision: number;
  }
  | {
    /** The one-time import of a legacy document; reads it inside the transaction. */
    action: "importLegacy";
    runId: string;
    legacyDocId: string;
  };

export interface MutationContext {
  uid: string;
  opId: string;
  /** Admin uid, or a system label for the migration. */
  actor: string;
  now?: Date;
  /**
   * Set for a caller limited to the request queue: adjust and reverseRequest
   * then accept only a grant that came from a queue request.
   */
  queueOnly?: boolean;
}

export interface ManualGrantResponse {
  grantId: string;
  kind: "months" | "absolute";
  months?: number;
  expiresAt?: string;
  base: ManualGrantBase;
  grantedAt: string;
  grantedBy: string;
  queue?: { collection: string; id: string };
  metadata: ManualGrantMetadata;
  status: ManualGrantStatus;
  statusChangedAt?: string;
  statusReason?: string;
  /** True for the baseline imported from the legacy document; it has no request of its own. */
  isLegacyBaseline: boolean;
}

export interface ManualSlotView {
  exists: boolean;
  status: NormalizedSubscriptionStatus | "none";
  expiresAt?: string;
  activeGrantCount: number;
  ledgerRevision: number;
  grants: ManualGrantResponse[];
}

export interface LegacyDocumentView {
  docId: string;
  exists: boolean;
  expires?: string;
  isMirror: boolean;
  migratedAt?: string;
}

export interface AccountSubscriptionView {
  uid: string;
  master?: SubscriptionResponse;
  /** Every slot that exists, with activity derived from the date. */
  sources: SourceSummaryResponse[];
  manual: ManualSlotView;
  legacy: LegacyDocumentView;
}

export interface ManualMutationResult {
  /** True when the operation id had already been applied and nothing changed. */
  replayedOperation: boolean;
  previousManualExpiresAt?: string;
  account: AccountSubscriptionView;
}

/**
 * Applies one admin mutation to an account's manual slot in a single
 * transaction: read everything, change the ledger, replay, write the slot,
 * re-project the master, update the request queue, mirror to the legacy
 * document. Nothing is computed before the transaction, because Firestore
 * re-runs the callback on contention and a precomputed date would be stale.
 */
export async function applyManualMutation(
  context: MutationContext,
  mutation: ManualMutation
): Promise<ManualMutationResult> {
  if (!MANUAL_SLOT_ENABLED) {
    throw new SubscriptionError(
      "precondition",
      "manual-slot-disabled",
      "Manual grants are switched off on the backend."
    );
  }
  if (!context.uid) {
    throw new SubscriptionError("invalid-input", "uid-missing", "A uid is required.");
  }
  if (!context.opId) {
    throw new SubscriptionError(
      "invalid-input",
      "op-id-missing",
      "An operation id is required."
    );
  }
  // The handler already refuses these; kept here so no other caller can widen a queue-only role.
  const queueOnlyAllowed =
    (mutation.action === "grant" && mutation.queue !== undefined) ||
    mutation.action === "adjust" ||
    mutation.action === "reverseRequest";
  if (context.queueOnly && !queueOnlyAllowed) {
    throw new SubscriptionError(
      "forbidden",
      "not-subscription-admin",
      "Only an admin may change subscriptions."
    );
  }

  const firestore = admin.firestore();
  const queue = "queue" in mutation ? mutation.queue : undefined;
  if (queue && !isPlainDocumentId(queue.id)) {
    throw new SubscriptionError(
      "invalid-input",
      "queue-id-invalid",
      "The request id is invalid."
    );
  }
  const queueRef = queue
    ? firestore.collection(queue.collection).doc(queue.id)
    : undefined;
  // The migration imports the document under its own id, which for the one
  // raw-uid document differs from the hashed id the mirror uses.
  const importRef =
    mutation.action === "importLegacy"
      ? firestore.collection(LEGACY_MANUAL_COLLECTION).doc(mutation.legacyDocId)
      : undefined;

  return firestore.runTransaction(async (transaction) => {
    const now = context.now ?? new Date();
    const nowStamp = Timestamp.fromDate(now);
    const state = await readProjectionState(transaction, context.uid, {
      includeLegacy: true,
      extraRefs: [...(queueRef ? [queueRef] : []), ...(importRef ? [importRef] : [])],
    });
    const legacySnapshot = state.legacySnapshot!;
    const manualSnapshot = state.slotSnapshots[MANUAL_SLOT_INDEX];
    const manualData = manualSnapshot.exists ? manualSnapshot.data()! : undefined;
    const grants = grantsFromData(manualData?.grants);
    const ledgerRevision =
      typeof manualData?.ledgerRevision === "number" ? manualData.ledgerRevision : 0;
    const operations = operationsFromData(manualData?.recentOperations);
    const previous = grants.length > 0 ? replayGrants(grants) : undefined;

    // A manual add's grant id is its operation id, so an existing grant with
    // that id is the same press even after it has aged out of recentOperations.
    const seenBefore =
      operations.some((operation) => operation.opId === context.opId) ||
      (mutation.action === "grant" &&
        !mutation.queue &&
        grants.some((grant) => grant.grantId === context.opId));
    if (seenBefore) {
      return {
        replayedOperation: true,
        previousManualExpiresAt: previous?.expiresAt?.toISOString(),
        account: accountViewFromState(context.uid, state, now),
      };
    }

    if ("expectedLedgerRevision" in mutation) {
      if (mutation.expectedLedgerRevision !== ledgerRevision) {
        throw new SubscriptionError(
          "precondition",
          "ledger-revision-stale",
          "The account changed since it was last loaded. Reload and try again."
        );
      }
    }

    let queueGrantRef: DocumentReference | undefined;
    let queueUpdate: DocumentData | undefined;

    if (mutation.action === "importLegacy" && importRef) {
      const importSnapshot = state.extraSnapshots[queueRef ? 1 : 0];
      importLegacyBaseline(grants, importSnapshot, mutation.legacyDocId, now);
      transaction.set(
        importRef,
        {
          migrated_at: nowStamp,
          migrated_uid: context.uid,
          migrated_run_id: mutation.runId,
        },
        { merge: true }
      );
    } else {
      bootstrapLegacyBaseline(grants, legacySnapshot, now);
    }

    switch (mutation.action) {
      case "grant": {
        const queueSnapshot = queueRef ? state.extraSnapshots[0] : undefined;
        if (mutation.queue && queueSnapshot) {
          assertQueueTransition(queueSnapshot, mutation.queue, context.uid);
          const existing = activeGrantForQueue(grants, mutation.queue);
          if (existing) {
            // A second admin approving the same request: one request, one grant.
            return {
              replayedOperation: true,
              previousManualExpiresAt: previous?.expiresAt?.toISOString(),
              account: accountViewFromState(context.uid, state, now),
            };
          }
        }
        const grant = buildGrant(
          mutation.queue ? nextQueueGrantId(grants, mutation.queue) : context.opId,
          mutation.intent,
          mutation.metadata,
          mutation.queue,
          context.actor,
          now
        );
        grants.push(grant);
        if (queueRef && mutation.queue) {
          queueGrantRef = queueRef;
          queueUpdate = { status: "approved" };
          if (grant.months !== undefined) {
            queueUpdate.approved_months = grant.months;
          }
        }
        break;
      }
      case "adjust": {
        const grant = requireAdjustableGrant(grants, mutation.grantId, context.queueOnly === true);
        if (mutation.targetMonths === grant.months) {
          throw new SubscriptionError(
            "precondition",
            "duration-unchanged",
            "The duration is unchanged."
          );
        }
        grant.months = assertMonths(mutation.targetMonths);
        grant.statusChangedAt = now;
        if (grant.queue) {
          queueGrantRef = firestore.collection(grant.queue.collection).doc(grant.queue.id);
          queueUpdate = { approved_months: grant.months };
        }
        break;
      }
      case "reverseRequest": {
        const grant = requireAdjustableGrant(grants, mutation.grantId, context.queueOnly === true);
        grant.status = "reversed";
        grant.statusChangedAt = now;
        grant.statusReason = mutation.reason;
        if (grant.queue) {
          queueGrantRef = firestore.collection(grant.queue.collection).doc(grant.queue.id);
          queueUpdate = { status: "rejected", admin_notes: mutation.reason };
        }
        break;
      }
      case "revokeAccess": {
        for (const grant of grants) {
          if (grant.status === "active") {
            grant.status = "revoked";
            grant.statusChangedAt = now;
            grant.statusReason = mutation.reason;
          }
        }
        break;
      }
      case "setBaseline": {
        const baseline = grants.find(isLegacyGrant);
        if (!baseline) {
          throw new SubscriptionError(
            "precondition",
            "baseline-missing",
            "This account has no imported legacy grant to edit."
          );
        }
        baseline.expiresAt = endOfDayInZone(mutation.expiresAt);
        baseline.status = "active";
        baseline.statusChangedAt = now;
        baseline.statusReason = mutation.reason;
        break;
      }
      case "importLegacy":
        break;
    }

    // Adjust and reverse write to the grant's request document, which was not
    // part of the first read. Read it now, still before any write, and skip
    // the update when the request has been deleted rather than fail the grant.
    if (queueGrantRef && queueUpdate && queueGrantRef.path !== queueRef?.path) {
      const queueSnapshot = await transaction.get(queueGrantRef);
      if (!queueSnapshot.exists) {
        queueGrantRef = undefined;
        queueUpdate = undefined;
      }
    }

    const replay = replayGrants(grants);
    const manualState = manualNormalizedState(grants, replay, now, ledgerRevision + 1);
    const slotData = stateData(
      context.uid,
      manualState,
      manualSnapshot.exists ? manualSnapshot.get("createdAt") : nowStamp,
      nowStamp
    );
    slotData.grants = grants.map(grantToData);
    slotData.ledgerRevision = ledgerRevision + 1;
    const recorded: RecordedOperation = {
      opId: context.opId,
      action: mutation.action,
      at: now,
      expiresAt: replay.expiresAt,
      ledgerRevision: ledgerRevision + 1,
    };
    slotData.recentOperations = [...operations, recorded]
      .slice(-MAX_RECENT_OPERATIONS)
      .map(operationToData);
    transaction.set(state.slotRefs[MANUAL_SLOT_INDEX], slotData);

    const states = slotStates(state.slotSnapshots, now);
    states[MANUAL_SLOT_INDEX] = manualState;
    const masterData = projectMaster(transaction, state, states, nowStamp);

    if (queueGrantRef && queueUpdate) {
      transaction.update(queueGrantRef, queueUpdate);
    }

    if (LEGACY_MIRROR_ENABLED && mutation.action !== "importLegacy") {
      transaction.set(
        state.legacyRef,
        {
          expires: Timestamp.fromDate(replay.expiresAt ?? now),
          user_guid: context.uid,
          created_by_admin_site: true,
          source: LEGACY_MIRROR_SOURCE,
          mirrored_at: nowStamp,
        },
        { merge: true }
      );
    }

    const presentStates = states.filter(
      (candidate): candidate is NormalizedSubscription => candidate !== undefined
    );
    return {
      replayedOperation: false,
      previousManualExpiresAt: previous?.expiresAt?.toISOString(),
      account: {
        uid: context.uid,
        master: masterDataToResponse(masterData),
        sources: sourceSummariesResponse(presentStates),
        manual: manualViewFromGrants(grants, replay, manualState, ledgerRevision + 1),
        legacy: legacyViewFromSnapshot(legacySnapshot, context.uid),
      },
    };
  });
}

function isPlainDocumentId(value: string): boolean {
  return value.length > 0 && value.length <= 1500 && !value.includes("/");
}

/** Read-only picture of an account, for the admin entitlement card. */
export async function readAccountSubscription(
  uid: string,
  now: Date = new Date(),
  deviceLimits?: DeviceLimits
): Promise<AccountSubscriptionView> {
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
  const snapshots = await firestore.getAll(masterRef, ...slotRefs, legacyRef);
  const state: ProjectionState = {
    masterRef,
    masterSnapshot: snapshots[0],
    slotRefs,
    slotSnapshots: snapshots.slice(1, 1 + slotRefs.length),
    legacyRef,
    legacySnapshot: snapshots[1 + slotRefs.length],
    extraSnapshots: [],
  };
  return accountViewFromState(uid, state, now, deviceLimits);
}

function accountViewFromState(
  uid: string,
  state: ProjectionState,
  now: Date,
  deviceLimits?: DeviceLimits
): AccountSubscriptionView {
  const states = slotStates(state.slotSnapshots, now).filter(
    (candidate): candidate is NormalizedSubscription => candidate !== undefined
  );
  const manualSnapshot = state.slotSnapshots[MANUAL_SLOT_INDEX];
  const manualData = manualSnapshot.exists ? manualSnapshot.data()! : undefined;
  const grants = grantsFromData(manualData?.grants);
  const replay = replayGrants(grants);
  const manualState = manualData ? stateDataToNormalized(manualData, now) : undefined;
  return {
    uid,
    master: state.masterSnapshot.exists
      ? masterDataToResponse(state.masterSnapshot.data()!, deviceLimits)
      : undefined,
    sources: sourceSummariesResponse(states),
    manual: manualViewFromGrants(
      grants,
      replay,
      manualState,
      typeof manualData?.ledgerRevision === "number" ? manualData.ledgerRevision : 0
    ),
    legacy: legacyViewFromSnapshot(state.legacySnapshot!, uid),
  };
}

function sourceSummariesResponse(
  states: NormalizedSubscription[]
): SourceSummaryResponse[] {
  return buildSourceSummaries(states).map((source) => {
    const row: SourceSummaryResponse = {
      platform: source.platform,
      environment: source.environment,
      status: source.status,
      expiresAt: source.expiresAt.toISOString(),
    };
    if (source.autoRenewing !== undefined) {
      row.autoRenewing = source.autoRenewing;
    }
    return row;
  });
}

function manualViewFromGrants(
  grants: ManualGrant[],
  replay: ReplayResult,
  manualState: NormalizedSubscription | undefined,
  ledgerRevision: number
): ManualSlotView {
  return {
    exists: manualState !== undefined,
    status: manualState ? manualState.status : "none",
    expiresAt: replay.expiresAt?.toISOString(),
    activeGrantCount: replay.activeGrantCount,
    ledgerRevision,
    grants: grants.map((grant) => ({
      grantId: grant.grantId,
      kind: grant.kind,
      months: grant.months,
      expiresAt: grant.expiresAt?.toISOString(),
      base: grant.base,
      grantedAt: grant.grantedAt.toISOString(),
      grantedBy: grant.grantedBy,
      queue: grant.queue,
      metadata: grant.metadata,
      status: grant.status,
      statusChangedAt: grant.statusChangedAt?.toISOString(),
      statusReason: grant.statusReason,
      isLegacyBaseline: isLegacyGrant(grant),
    })),
  };
}

export function legacyViewFromSnapshot(
  snapshot: DocumentSnapshot,
  uid: string
): LegacyDocumentView {
  const data = snapshot.exists ? snapshot.data()! : undefined;
  return {
    docId: legacyManualDocumentId(uid),
    exists: snapshot.exists,
    expires: legacyExpires(data)?.toISOString(),
    isMirror: data?.source === LEGACY_MIRROR_SOURCE,
    migratedAt: timestampDate(data?.migrated_at)?.toISOString(),
  };
}

/** Reads the legacy `expires`, tolerating the few documents that stored it differently. */
export function legacyExpires(data: DocumentData | undefined): Date | undefined {
  if (!data) {
    return undefined;
  }
  const raw = data.expires ?? data.expiresAt ?? data.expires_at;
  const stamped = timestampDate(raw);
  if (stamped) {
    return stamped;
  }
  if (typeof raw === "string") {
    const parsed = new Date(raw);
    return Number.isFinite(parsed.getTime()) ? parsed : undefined;
  }
  if (typeof raw === "number") {
    return new Date(Math.abs(raw) < 100000000000 ? raw * 1000 : raw);
  }
  return undefined;
}

/**
 * Seeds the ledger from the legacy document the first time an account is
 * touched before the migration reached it. Only a document the old portal
 * wrote counts; one the backend mirrored is output and is never read back.
 */
function bootstrapLegacyBaseline(
  grants: ManualGrant[],
  legacySnapshot: DocumentSnapshot,
  now: Date
): void {
  if (grants.length > 0 || !legacySnapshot.exists) {
    return;
  }
  const data = legacySnapshot.data()!;
  if (data.source === LEGACY_MIRROR_SOURCE) {
    return;
  }
  const expires = legacyExpires(data);
  if (!expires || expires.getTime() <= now.getTime()) {
    return;
  }
  grants.push(legacyBaselineGrant(legacySnapshot.id, data, expires, now));
}

function importLegacyBaseline(
  grants: ManualGrant[],
  legacySnapshot: DocumentSnapshot,
  legacyDocId: string,
  now: Date
): void {
  if (grants.length > 0) {
    throw new SubscriptionError(
      "precondition",
      "ledger-exists",
      "The account already has a grant ledger."
    );
  }
  if (!legacySnapshot.exists) {
    throw new SubscriptionError(
      "not-found",
      "legacy-document-missing",
      "The legacy document no longer exists."
    );
  }
  const data = legacySnapshot.data()!;
  if (data.source === LEGACY_MIRROR_SOURCE) {
    throw new SubscriptionError(
      "precondition",
      "legacy-document-is-mirror",
      "The legacy document was written by the backend mirror."
    );
  }
  const expires = legacyExpires(data);
  if (!expires || expires.getTime() <= now.getTime()) {
    throw new SubscriptionError(
      "precondition",
      "legacy-grant-expired",
      "The legacy grant has already expired."
    );
  }
  grants.push(legacyBaselineGrant(legacyDocId, data, expires, now));
}

function legacyBaselineGrant(
  legacyDocId: string,
  data: DocumentData,
  expires: Date,
  now: Date
): ManualGrant {
  const metadata: ManualGrantMetadata = {
    grantSource: "legacy_import",
    legacyDocId,
  };
  if (typeof data.payment_method === "string") {
    metadata.paymentMethod = data.payment_method;
  }
  if (typeof data.amount_paid === "number") {
    metadata.amountPaid = data.amount_paid;
  }
  if (typeof data.country_code === "string") {
    metadata.countryCode = data.country_code;
  }
  const note = [data.tag, data.name, data.type, data.admin_manual_reason]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" | ");
  if (note) {
    metadata.note = note;
  }
  return {
    grantId: `${LEGACY_GRANT_PREFIX}${legacyDocId}`,
    kind: "absolute",
    expiresAt: expires,
    base: "extend",
    grantedAt: timestampDate(data.created_at) ?? timestampDate(data.date_paid_at) ?? now,
    grantedBy: "legacy",
    metadata,
    status: "active",
  };
}

function buildGrant(
  grantId: string,
  intent: GrantIntent,
  metadata: ManualGrantMetadata,
  queue: QueueReference | undefined,
  actor: string,
  now: Date
): ManualGrant {
  const grant: ManualGrant = {
    grantId,
    kind: intent.kind,
    base: intent.kind === "months" ? intent.base : "extend",
    grantedAt: now,
    grantedBy: actor,
    metadata: { ...metadata, grantedBy: actor },
    status: "active",
  };
  if (intent.kind === "months") {
    grant.months = assertMonths(intent.months);
  } else {
    if (!Number.isFinite(intent.expiresAt.getTime())) {
      throw new SubscriptionError(
        "invalid-input",
        "expires-at-invalid",
        "The expiry date is invalid."
      );
    }
    grant.expiresAt = endOfDayInZone(intent.expiresAt);
  }
  if (queue) {
    grant.queue = { collection: queue.collection, id: queue.id };
  }
  return grant;
}

export function assertMonths(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_GRANT_MONTHS
  ) {
    throw new SubscriptionError(
      "invalid-input",
      "months-invalid",
      `Months must be a whole number between 1 and ${MAX_GRANT_MONTHS}.`
    );
  }
  return value;
}

function requireAdjustableGrant(
  grants: ManualGrant[],
  grantId: string,
  queueOnly: boolean
): ManualGrant {
  const grant = grants.find((candidate) => candidate.grantId === grantId);
  if (!grant) {
    throw new SubscriptionError(
      "not-found",
      "grant-not-found",
      "No grant with that id exists on this account."
    );
  }
  if (queueOnly && !grant.queue) {
    throw new SubscriptionError(
      "forbidden",
      "grant-not-from-request",
      "Only a grant made from a request in the queue can be changed with this role."
    );
  }
  if (isLegacyGrant(grant)) {
    throw new SubscriptionError(
      "precondition",
      "unattributed-legacy-grant",
      "This approval predates the grant ledger; edit the baseline or revoke all access instead."
    );
  }
  if (grant.status !== "active") {
    throw new SubscriptionError(
      "precondition",
      "grant-not-active",
      "This grant is no longer active."
    );
  }
  if (grant.kind !== "months") {
    throw new SubscriptionError(
      "precondition",
      "grant-not-adjustable",
      "Only grants given in months can be adjusted."
    );
  }
  return grant;
}

function assertQueueTransition(
  snapshot: DocumentSnapshot,
  queue: QueueReference,
  uid: string
): void {
  if (!snapshot.exists) {
    throw new SubscriptionError(
      "not-found",
      "queue-document-missing",
      "The request no longer exists."
    );
  }
  const data = snapshot.data()!;
  if (queue.expectedStatus !== undefined && data.status !== queue.expectedStatus) {
    throw new SubscriptionError(
      "precondition",
      "queue-status-changed",
      "The request changed since it was loaded. Reload and try again."
    );
  }
  if (data.status === "approved") {
    throw new SubscriptionError(
      "precondition",
      "queue-already-approved",
      "This request is already approved."
    );
  }
  if (typeof data.user_guid !== "string" || data.user_guid !== uid) {
    throw new SubscriptionError(
      "precondition",
      "queue-user-mismatch",
      "The request belongs to a different account."
    );
  }
}

function manualNormalizedState(
  grants: ManualGrant[],
  replay: ReplayResult,
  now: Date,
  ledgerRevision: number
): NormalizedSubscription {
  const expiresAt = replay.expiresAt ?? now;
  const active = replay.activeGrantCount > 0 && expiresAt.getTime() > now.getTime();
  const anyRevoked = grants.some((grant) => grant.status === "revoked");
  const status: NormalizedSubscriptionStatus = active
    ? "active"
    : replay.activeGrantCount === 0 && anyRevoked
      ? "revoked"
      : "expired";
  return {
    active,
    status,
    platform: MANUAL_SLOT.platform,
    productId: MANUAL_GRANT_PRODUCT_ID,
    expiresAt,
    autoRenewing: false,
    inGracePeriod: false,
    environment: MANUAL_SLOT.environment,
    lastStoreEventAt: now,
    lastVerifiedAt: now,
    manual: {
      activeGrantCount: replay.activeGrantCount,
      grantSource: replay.latestActive?.metadata.grantSource,
      ledgerRevision,
    },
  };
}
