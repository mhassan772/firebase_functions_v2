import * as crypto from "crypto";
import * as functions from "firebase-functions";
import { admin } from "../config/admin";
import {
  ManualGrantMetadata,
  ManualGrantSource,
} from "../types/subscriptions";
import { asCallableError, safeErrorCode, SubscriptionError } from "../services/subscriptions/errors";
import {
  AccountSubscriptionView,
  GrantIntent,
  MAX_GRANT_MONTHS,
  ManualMutation,
  ManualMutationResult,
  QueueReference,
  applyManualMutation,
  assertMonths,
  readAccountSubscription,
} from "../services/subscriptions/manual";
import {
  ImportRow,
  MIGRATION_RUNS_COLLECTION,
  importLegacyRows,
  planLegacyMigration,
  readMigrationRun,
} from "../services/subscriptions/legacyMigration";
import {
  MANUAL_SLOT,
  SUBSCRIPTION_STATE_COLLECTION,
  timestampDate,
} from "../services/subscriptions/persistence";
import {
  ResolvedUser,
  isHexHash,
  resolveUser,
} from "../services/subscriptions/userResolution";
import {
  DeviceLimits,
  DeviceManagementResponse,
  readDeviceLimits,
} from "../services/subscriptions/devices";
import {
  AdminDeviceMutation,
  adminManageDevices,
  assertExtraSeats,
} from "../services/subscriptions/adminDevices";
import { requireSubscriptionAdmin } from "../utils/adminRole";
import {
  assertExactKeys,
  isPlainRecord,
  readDeviceId,
  requireAuthenticatedUid,
} from "./verifiedSubscriptionHandlers";

const QUEUE_COLLECTIONS = new Set([
  "subscriptions_to_be_approved",
  "subscription_migration_restoration",
]);
const GRANT_SOURCES = new Set<ManualGrantSource>([
  "egypt_request",
  "migration_restoration",
  "admin_manual_add",
]);
const MAX_LIST_LIMIT = 500;
const MAX_TEXT = 500;
const MAX_IMPORT_ROWS = 200;

type AdminAction =
  | "get"
  | "grant"
  | "adjust"
  | "reverseRequest"
  | "revokeAccess"
  | "setBaseline"
  | "listManual"
  | "migrateLegacy"
  | "importLegacyRows"
  | "getMigrationRun"
  | "listDevices"
  | "removeDevice"
  | "setExtraSeats"
  | "resetDeviceCooldown";

export interface AccountResponse {
  user: ResolvedUser;
  account: AccountSubscriptionView;
}

export interface MutationResponse extends ManualMutationResult {
  user: ResolvedUser;
}

export interface DevicesResponse {
  user: ResolvedUser;
  devices: DeviceManagementResponse;
}

/**
 * One callable for every admin action on manual grants and the legacy
 * migration. Each action validates its exact field set, resolves the account
 * through verified Auth data, and leaves the decision to the grant service.
 */
export async function handleAdminManageSubscription(
  data: unknown,
  context: functions.https.CallableContext
): Promise<unknown> {
  const operationId = crypto.randomUUID();
  let action: AdminAction | undefined;
  try {
    const request = requireRecord(data);
    action = readAction(request.action);
    const adminUid = requireAuthenticatedUid(context);
    await requireSubscriptionAdmin(adminUid);
    functions.logger.info("admin_subscription_start", { operationId, action, adminUid });

    const result = await dispatch(action, request, adminUid);

    functions.logger.info("admin_subscription_success", { operationId, action, adminUid });
    return result;
  } catch (error) {
    const code = safeErrorCode(error);
    if (
      error instanceof SubscriptionError &&
      (error.kind === "invalid-input" ||
        error.kind === "precondition" ||
        error.kind === "not-found" ||
        error.kind === "forbidden")
    ) {
      functions.logger.warn("admin_subscription_rejection", { operationId, action, code });
    } else {
      functions.logger.error("admin_subscription_failure", { operationId, action, code });
    }
    throw asCallableError(error);
  }
}

async function dispatch(
  action: AdminAction,
  request: Record<string, unknown>,
  adminUid: string
): Promise<unknown> {
  switch (action) {
    case "get": {
      assertExactKeys(request, ["action", "user"]);
      const user = await resolveUser(readUserReference(request.user));
      return {
        user,
        account: await readAccountSubscription(user.uid, new Date(), await deviceLimits()),
      } satisfies AccountResponse;
    }
    case "listDevices": {
      assertExactKeys(request, ["action", "user"]);
      return manageDevices(request, adminUid, { action: "listDevices" });
    }
    case "removeDevice": {
      assertExactKeys(request, ["action", "user", "deviceId"]);
      return manageDevices(request, adminUid, {
        action: "removeDevice",
        deviceId: readDeviceId(request.deviceId),
      });
    }
    case "setExtraSeats": {
      assertExactKeys(request, ["action", "user", "seats"]);
      return manageDevices(request, adminUid, {
        action: "setExtraSeats",
        seats: assertExtraSeats(request.seats),
      });
    }
    case "resetDeviceCooldown": {
      assertExactKeys(request, ["action", "user"]);
      return manageDevices(request, adminUid, { action: "resetDeviceCooldown" });
    }
    case "grant": {
      assertExactKeys(request, [
        "action",
        "user",
        "opId",
        "intent",
        "metadata",
        ...(request.queue !== undefined ? ["queue"] : []),
      ]);
      const mutation: ManualMutation = {
        action: "grant",
        intent: readIntent(request.intent),
        metadata: readMetadata(request.metadata),
        queue: request.queue === undefined ? undefined : readQueue(request.queue),
      };
      return mutate(request, adminUid, mutation);
    }
    case "adjust": {
      assertExactKeys(request, [
        "action",
        "user",
        "opId",
        "grantId",
        "targetMonths",
        "expectedLedgerRevision",
      ]);
      return mutate(request, adminUid, {
        action: "adjust",
        grantId: readText(request.grantId, "grantId"),
        targetMonths: assertMonths(request.targetMonths),
        expectedLedgerRevision: readRevision(request.expectedLedgerRevision),
      });
    }
    case "reverseRequest": {
      assertExactKeys(request, [
        "action",
        "user",
        "opId",
        "grantId",
        "reason",
        "expectedLedgerRevision",
      ]);
      return mutate(request, adminUid, {
        action: "reverseRequest",
        grantId: readText(request.grantId, "grantId"),
        reason: readText(request.reason, "reason"),
        expectedLedgerRevision: readRevision(request.expectedLedgerRevision),
      });
    }
    case "revokeAccess": {
      assertExactKeys(request, ["action", "user", "opId", "reason", "expectedLedgerRevision"]);
      return mutate(request, adminUid, {
        action: "revokeAccess",
        reason: readText(request.reason, "reason"),
        expectedLedgerRevision: readRevision(request.expectedLedgerRevision),
      });
    }
    case "setBaseline": {
      assertExactKeys(request, [
        "action",
        "user",
        "opId",
        "expiresAt",
        "reason",
        "expectedLedgerRevision",
      ]);
      return mutate(request, adminUid, {
        action: "setBaseline",
        expiresAt: readDate(request.expiresAt, "expiresAt"),
        reason: readText(request.reason, "reason"),
        expectedLedgerRevision: readRevision(request.expectedLedgerRevision),
      });
    }
    case "listManual": {
      assertExactKeys(request, [
        "action",
        ...(request.limit !== undefined ? ["limit"] : []),
        ...(request.startAfterUpdatedAt !== undefined ? ["startAfterUpdatedAt"] : []),
      ]);
      return listManualSlots(
        request.limit === undefined ? 100 : readLimit(request.limit),
        request.startAfterUpdatedAt === undefined
          ? undefined
          : readText(request.startAfterUpdatedAt, "startAfterUpdatedAt")
      );
    }
    case "migrateLegacy": {
      // The planner. It only ever runs dry; a live import takes the reviewed rows.
      assertExactKeys(request, ["action", "runId", "dryRun"]);
      if (request.dryRun !== true) {
        throw invalid(
          "dryRun-invalid",
          "migrateLegacy only plans; import the reviewed rows with importLegacyRows."
        );
      }
      return planLegacyMigration({ runId: readRunId(request.runId), actor: adminUid });
    }
    case "importLegacyRows": {
      assertExactKeys(request, ["action", "runId", "rows"]);
      return importLegacyRows({
        runId: readRunId(request.runId),
        rows: readImportRows(request.rows),
        actor: adminUid,
      });
    }
    case "getMigrationRun": {
      assertExactKeys(request, ["action", "runId"]);
      const report = await readMigrationRun(readRunId(request.runId));
      if (!report) {
        throw new SubscriptionError(
          "not-found",
          "migration-run-not-found",
          `No run exists in ${MIGRATION_RUNS_COLLECTION} with that id.`
        );
      }
      return report;
    }
  }
}

async function manageDevices(
  request: Record<string, unknown>,
  adminUid: string,
  mutation: AdminDeviceMutation
): Promise<DevicesResponse> {
  const user = await resolveUser(readUserReference(request.user));
  const devices = await adminManageDevices(
    { uid: user.uid, adminUid },
    mutation,
    await deviceLimits()
  );
  return { user, devices };
}

/** The device limit lives in the public subscription settings; one read per admin call. */
async function deviceLimits(): Promise<DeviceLimits> {
  return readDeviceLimits();
}

async function mutate(
  request: Record<string, unknown>,
  adminUid: string,
  mutation: ManualMutation
): Promise<MutationResponse> {
  const user = await resolveUser(readUserReference(request.user));
  const result = await applyManualMutation(
    { uid: user.uid, opId: readOpId(request.opId), actor: adminUid },
    mutation
  );
  return { user, ...result };
}

export interface ManualSlotListRow {
  uid: string;
  email?: string;
  status: string;
  expiresAt?: string;
  activeGrantCount: number;
  ledgerRevision: number;
  grantSource?: string;
  updatedAt?: string;
}

/**
 * Pages manual slots by `updatedAt` then document id, so equal timestamps can
 * neither skip nor repeat a row. The cursor is `"<iso>|<docId>"`.
 */
async function listManualSlots(
  limit: number,
  cursor: string | undefined
): Promise<{ rows: ManualSlotListRow[]; nextStartAfterUpdatedAt?: string }> {
  const firestore = admin.firestore();
  let query = firestore
    .collection(SUBSCRIPTION_STATE_COLLECTION)
    .where("platform", "==", MANUAL_SLOT.platform)
    .orderBy("updatedAt", "desc")
    .orderBy(admin.firestore.FieldPath.documentId(), "desc")
    .limit(limit);
  if (cursor) {
    const [iso, docId] = cursor.split("|");
    query = query.startAfter(readDate(iso, "startAfterUpdatedAt"), docId ?? "");
  }
  const page = await query.get();
  const rows: ManualSlotListRow[] = page.docs.map((snapshot) => {
    const data = snapshot.data();
    const grants = Array.isArray(data.grants) ? data.grants : [];
    const active = grants.filter((grant) => grant && grant.status === "active");
    const latest = active[active.length - 1];
    return {
      uid: typeof data.uid === "string" ? data.uid : "",
      status: typeof data.status === "string" ? data.status : "unknown",
      expiresAt: timestampDate(data.expiresAt)?.toISOString(),
      activeGrantCount: active.length,
      ledgerRevision: typeof data.ledgerRevision === "number" ? data.ledgerRevision : 0,
      grantSource: latest?.metadata?.grantSource,
      updatedAt: timestampDate(data.updatedAt)?.toISOString(),
    };
  });

  const uids = rows.map((row) => row.uid).filter((uid) => uid.length > 0);
  for (let start = 0; start < uids.length; start += 100) {
    const batch = uids.slice(start, start + 100).map((uid) => ({ uid }));
    const found = await admin.auth().getUsers(batch);
    const emails = new Map(found.users.map((user) => [user.uid, user.email]));
    for (const row of rows) {
      if (emails.has(row.uid)) {
        row.email = emails.get(row.uid);
      }
    }
  }

  const lastDoc = page.docs[page.docs.length - 1];
  const lastUpdatedAt = lastDoc ? timestampDate(lastDoc.get("updatedAt")) : undefined;
  return {
    rows,
    nextStartAfterUpdatedAt:
      page.size === limit && lastDoc && lastUpdatedAt
        ? `${lastUpdatedAt.toISOString()}|${lastDoc.id}`
        : undefined,
  };
}

// ---------------------------------------------------------------------------
// Input readers
// ---------------------------------------------------------------------------

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isPlainRecord(value)) {
    throw invalid("request-body-invalid", "The request body is invalid.");
  }
  return value;
}

function readAction(value: unknown): AdminAction {
  switch (value) {
    case "get":
    case "grant":
    case "adjust":
    case "reverseRequest":
    case "revokeAccess":
    case "setBaseline":
    case "listManual":
    case "migrateLegacy":
    case "importLegacyRows":
    case "getMigrationRun":
    case "listDevices":
    case "removeDevice":
    case "setExtraSeats":
    case "resetDeviceCooldown":
      return value;
    default:
      throw invalid("action-invalid", "The action is not supported.");
  }
}

/**
 * `{ uid }` or `{ email }`, plus an optional `hashedId` the user pasted, which
 * only confirms the account found. A hash never finds an account by itself.
 */
function readUserReference(value: unknown): { uid?: string; email?: string; hashedId?: string } {
  const record = requireRecord(value);
  const lookupKeys = Object.keys(record).filter((key) => key !== "hashedId");
  if (lookupKeys.length !== 1 || !["uid", "email"].includes(lookupKeys[0])) {
    throw invalid("user-reference-invalid", "user must carry exactly one of uid or email.");
  }
  const key = lookupKeys[0] as "uid" | "email";
  const reference: { uid?: string; email?: string; hashedId?: string } = {
    [key]: readText(record[key], key),
  };
  if (record.hashedId !== undefined) {
    const hashedId = readText(record.hashedId, "hashedId").toLowerCase();
    if (!isHexHash(hashedId)) {
      throw invalid("hashed-id-invalid", "hashedId must be 64 hexadecimal characters.");
    }
    reference.hashedId = hashedId;
  }
  return reference;
}

function readImportRows(value: unknown): ImportRow[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_IMPORT_ROWS) {
    throw invalid("rows-invalid", `rows must hold 1 to ${MAX_IMPORT_ROWS} entries.`);
  }
  const seen = new Set<string>();
  return value.map((entry) => {
    const record = requireRecord(entry);
    assertExactKeys(record, ["docId", "uid"]);
    const docId = readText(record.docId, "rows.docId");
    if (docId.includes("/") || seen.has(docId)) {
      throw invalid("rows-invalid", "rows carry an invalid or repeated docId.");
    }
    seen.add(docId);
    return { docId, uid: readText(record.uid, "rows.uid") };
  });
}

function readIntent(value: unknown): GrantIntent {
  const record = requireRecord(value);
  if (record.kind === "months") {
    assertExactKeys(record, ["kind", "months", "base"]);
    if (record.base !== "extend" && record.base !== "today") {
      throw invalid("base-invalid", "base must be extend or today.");
    }
    return { kind: "months", months: assertMonths(record.months), base: record.base };
  }
  if (record.kind === "absolute") {
    assertExactKeys(record, ["kind", "expiresAt"]);
    return { kind: "absolute", expiresAt: readDate(record.expiresAt, "expiresAt") };
  }
  throw invalid("intent-invalid", "intent.kind must be months or absolute.");
}

function readMetadata(value: unknown): ManualGrantMetadata {
  const record = requireRecord(value);
  if (!GRANT_SOURCES.has(record.grantSource as ManualGrantSource)) {
    throw invalid("grant-source-invalid", "metadata.grantSource is not supported.");
  }
  const metadata: ManualGrantMetadata = {
    grantSource: record.grantSource as ManualGrantSource,
  };
  for (const key of ["paymentMethod", "countryCode", "note"] as const) {
    if (record[key] !== undefined) {
      metadata[key] = readText(record[key], key);
    }
  }
  if (record.amountPaid !== undefined) {
    if (typeof record.amountPaid !== "number" || !Number.isFinite(record.amountPaid)) {
      throw invalid("amount-paid-invalid", "metadata.amountPaid must be a number.");
    }
    metadata.amountPaid = record.amountPaid;
  }
  return metadata;
}

function readQueue(value: unknown): QueueReference {
  const record = requireRecord(value);
  assertExactKeys(record, [
    "collection",
    "id",
    ...(record.expectedStatus !== undefined ? ["expectedStatus"] : []),
  ]);
  const collection = readText(record.collection, "queue.collection");
  if (!QUEUE_COLLECTIONS.has(collection)) {
    throw invalid("queue-collection-invalid", "queue.collection is not a request queue.");
  }
  return {
    collection,
    id: readText(record.id, "queue.id"),
    expectedStatus:
      record.expectedStatus === undefined
        ? undefined
        : readText(record.expectedStatus, "queue.expectedStatus"),
  };
}

function readText(value: unknown, field: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > MAX_TEXT) {
    throw invalid(`${field}-invalid`, `The ${field} field is invalid.`);
  }
  return text;
}

function readOpId(value: unknown): string {
  const text = readText(value, "opId");
  if (!/^[A-Za-z0-9_:-]{8,128}$/.test(text)) {
    throw invalid("opId-invalid", "opId must be 8 to 128 url-safe characters.");
  }
  return text;
}

function readRunId(value: unknown): string {
  const text = readText(value, "runId");
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(text)) {
    throw invalid("runId-invalid", "runId must be 8 to 64 url-safe characters.");
  }
  return text;
}

function readRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw invalid("ledger-revision-invalid", "expectedLedgerRevision must be a non-negative integer.");
  }
  return value;
}

function readLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_LIST_LIMIT) {
    throw invalid("limit-invalid", `limit must be between 1 and ${MAX_LIST_LIMIT}.`);
  }
  return value;
}

function readDate(value: unknown, field: string): Date {
  const parsed = typeof value === "string" ? new Date(value) : new Date(Number.NaN);
  if (!Number.isFinite(parsed.getTime())) {
    throw invalid(`${field}-invalid`, `The ${field} field must be an ISO-8601 date.`);
  }
  return parsed;
}

function invalid(code: string, message: string): SubscriptionError {
  return new SubscriptionError("invalid-input", code, message);
}

export { MAX_GRANT_MONTHS };
