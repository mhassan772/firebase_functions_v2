import * as crypto from "crypto";
import { Firestore, QueryDocumentSnapshot, Timestamp } from "firebase-admin/firestore";
import * as functions from "firebase-functions";
import { PurgeDeps, purgeAccount, PurgeResult } from "../services/accountDeletion/purge";
import {
  closeTombstone,
  DELETED_ACCOUNTS_COLLECTION,
  markTombstoneDeleted,
} from "../services/accountDeletion/tombstone";
import { readLang } from "../services/email/actionLink";
import { renderAccountDeletedEmail } from "../services/email/accountDeletedEmail";
import { senderName } from "../services/email/authEmailTemplates";
import { Mailer } from "../services/email/sesMailer";
import {
  CallerContext,
  errorCodeOf,
  hasAppCheck,
  reasonOf,
  refusal,
  requireCaller,
  requireRecentLogin,
} from "../utils/callableAuth";

/** The slice of the Admin SDK's Auth these handlers use; `admin.auth()` satisfies it. */
export interface AccountDeletionAuth {
  getUser(uid: string): Promise<{ uid: string; email?: string }>;
  deleteUser(uid: string): Promise<void>;
}

export interface AccountDeletionDeps {
  auth: AccountDeletionAuth;
  mailer: Mailer;
  purge: PurgeDeps;
  /** The purge itself, replaceable so a test can make it fail. */
  purgeAccount?: typeof purgeAccount;
}

/** Tombstones younger than this are left alone: a still-signed-in device may write for an hour. */
export const SWEEP_MIN_AGE_MS = 75 * 60 * 1000;
/** Closed tombstones are kept this long, so a late store event for the uid is still refused. */
export const CLOSED_TOMBSTONE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
/** Time the sweep keeps free at the end of its 540 s, so the running purge can finish. */
export const SWEEP_BUDGET_MS = 420 * 1000;

const SWEEP_PAGE_SIZE = 200;
const REQUEST_KEYS = ["lang"];

/** Where a non-refusal failure happened, so logs say which step broke without its message. */
type Stage = "validate" | "lookup" | "purge" | "auth_delete" | "tombstone" | "email" | "sweep";

/**
 * Deletes the signed-in account: its data, then its sign-in, then sends a confirmation.
 *
 * When the purge or the sign-in deletion fails the tombstone stays `pending` and the weekly
 * cleanup finishes the deletion.
 */
export async function handleDeleteAccount(
  data: unknown,
  context: CallerContext,
  deps: AccountDeletionDeps
): Promise<{ deleted: true }> {
  const event = "account_delete";
  const operationId = crypto.randomUUID();
  const state: { stage: Stage } = { stage: "validate" };
  try {
    const uid = requireCaller(context, { allowAnonymous: false, withReason: true });
    const lang = readRequest(data);
    requireRecentLogin(context, deps.purge.now(), "Sign in again before deleting the account.");
    logInfo(`${event}_start`, operationId, { uid, lang, appCheck: hasAppCheck(context) });

    state.stage = "lookup";
    const email = await accountEmail(deps.auth, uid);

    state.stage = "purge";
    const purge = await (deps.purgeAccount ?? purgeAccount)(uid, deps.purge, { state: "pending", email });
    if (!purge.ok) throw new PurgeIncompleteError(purge);

    state.stage = "auth_delete";
    const authDeleted = await deleteAuthUser(deps.auth, uid);

    let marked = true;
    try {
      await markTombstoneDeleted(deps.purge.firestore, uid);
    } catch (error) {
      // The Auth trigger records the same state, and the weekly cleanup does if both fail.
      marked = false;
      logFailure(`${event}_tombstone`, operationId, "tombstone", error, "warn");
    }

    let emailed = false;
    if (email) {
      try {
        const rendered = renderAccountDeletedEmail(lang);
        await deps.mailer.send({ ...rendered, to: email, fromName: senderName(lang) });
        emailed = true;
      } catch (error) {
        logFailure(`${event}_email`, operationId, "email", error, "warn");
      }
    }

    logInfo(`${event}_success`, operationId, { uid, lang, authDeleted, marked, emailed, purgeOperationId: purge.operationId });
    return { deleted: true };
  } catch (error) {
    throw toCallableError(event, operationId, state.stage, error);
  }
}

/** The parts of a deleted Auth user the cleanup reads. */
export interface DeletedUser {
  uid: string;
  email?: string;
  providerData?: readonly unknown[];
}

/**
 * Cleans up after an Auth user is deleted by any route, including app versions that delete the
 * sign-in themselves. A failure leaves the tombstone open for the weekly cleanup; nothing retries.
 *
 * A guest, with no email and no sign-in provider, is closed at once after a clean purge: it holds
 * no entitlement to re-claim, and re-purging every deleted guest each week could outgrow the
 * cleanup's time budget.
 */
export async function handleAccountDeleted(
  user: DeletedUser,
  deps: Pick<AccountDeletionDeps, "purge" | "purgeAccount">
): Promise<void> {
  const operationId = crypto.randomUUID();
  const guest = !user.email && (user.providerData?.length ?? 0) === 0;
  try {
    const purge = await (deps.purgeAccount ?? purgeAccount)(user.uid, deps.purge, {
      state: "deleted",
      email: user.email,
    });
    const closed = guest && purge.ok;
    if (closed) {
      await closeTombstone(deps.purge.firestore, user.uid, Timestamp.fromMillis(deps.purge.now()));
    }
    logInfo("account_deleted_cleanup_success", operationId, { uid: user.uid, guest, ok: purge.ok, closed });
  } catch (error) {
    // The purge logs its own outcome; this keeps a refused uid or a failed close from surfacing
    // as a crash, and the tombstone, if any, stays open for the weekly cleanup.
    logFailure("account_deleted_cleanup", operationId, "purge", error, "warn");
  }
}

export interface SweepOutcome {
  closed: number;
  failed: number;
  left: number;
  removed: number;
}

/**
 * Runs the purge again for every open tombstone at least 75 minutes old, oldest first, and closes
 * each one whose run succeeded with the sign-in gone. Stops starting new purges once the budget
 * is used; what is left waits for next week. Also deletes tombstones closed over 90 days ago.
 */
export async function handleSweepDeletedAccounts(
  deps: Pick<AccountDeletionDeps, "auth" | "purge" | "purgeAccount">,
  budgetMs: number = SWEEP_BUDGET_MS
): Promise<SweepOutcome> {
  const operationId = crypto.randomUUID();
  const db = deps.purge.firestore;
  const startedAt = deps.purge.now();
  const outcome: SweepOutcome = { closed: 0, failed: 0, left: 0, removed: 0 };
  functions.logger.info("account_sweep_start", { operationId });

  const due = await openTombstonesDue(db, startedAt - SWEEP_MIN_AGE_MS);
  for (let i = 0; i < due.length; i++) {
    if (deps.purge.now() - startedAt >= budgetMs) {
      outcome.left = due.length - i;
      break;
    }
    const uid = due[i];
    try {
      if (await sweepOne(uid, deps)) {
        outcome.closed += 1;
      } else {
        outcome.failed += 1;
      }
    } catch (error) {
      outcome.failed += 1;
      logFailure("account_sweep_item", operationId, "sweep", error, "warn");
    }
  }

  try {
    outcome.removed = await removeExpiredTombstones(db, deps.purge.now() - CLOSED_TOMBSTONE_RETENTION_MS);
  } catch (error) {
    logFailure("account_sweep_expiry", operationId, "sweep", error, "error");
  }

  functions.logger.info("account_sweep_success", { operationId, ...outcome });
  return outcome;
}

/** One tombstone: purge, delete a sign-in that survived, close when both went through. */
async function sweepOne(
  uid: string,
  deps: Pick<AccountDeletionDeps, "auth" | "purge" | "purgeAccount">
): Promise<boolean> {
  const user = await findUser(deps.auth, uid);
  const purge = await (deps.purgeAccount ?? purgeAccount)(uid, deps.purge, { email: user?.email });
  if (user) await deleteAuthUser(deps.auth, uid);
  if (!purge.ok) {
    if (user) await markTombstoneDeleted(deps.purge.firestore, uid);
    return false;
  }
  await closeTombstone(deps.purge.firestore, uid, Timestamp.fromMillis(deps.purge.now()));
  return true;
}

/** Uids of open tombstones whose deletion started before `cutoffMs`, oldest first. */
async function openTombstonesDue(db: Firestore, cutoffMs: number): Promise<string[]> {
  const uids: string[] = [];
  let last: QueryDocumentSnapshot | undefined;
  for (;;) {
    let query = db
      .collection(DELETED_ACCOUNTS_COLLECTION)
      .where("deletedAt", "<=", Timestamp.fromMillis(cutoffMs))
      .orderBy("deletedAt")
      .select("deletedAt", "closedAt")
      .limit(SWEEP_PAGE_SIZE);
    if (last) query = query.startAfter(last);
    const snapshot = await query.get();
    for (const doc of snapshot.docs) {
      if (doc.get("closedAt") === undefined) uids.push(doc.id);
    }
    if (snapshot.size < SWEEP_PAGE_SIZE) return uids;
    last = snapshot.docs[snapshot.docs.length - 1];
  }
}

async function removeExpiredTombstones(db: Firestore, cutoffMs: number): Promise<number> {
  let removed = 0;
  for (;;) {
    const snapshot = await db
      .collection(DELETED_ACCOUNTS_COLLECTION)
      .where("closedAt", "<=", Timestamp.fromMillis(cutoffMs))
      .limit(SWEEP_PAGE_SIZE)
      .get();
    if (snapshot.empty) return removed;
    const batch = db.batch();
    snapshot.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    removed += snapshot.size;
    if (snapshot.size < SWEEP_PAGE_SIZE) return removed;
  }
}

class PurgeIncompleteError extends Error {
  constructor(readonly result: PurgeResult) {
    super("The account purge did not finish.");
    this.name = "PurgeIncompleteError";
  }
}

function readRequest(data: unknown): "ar" | "en" {
  if (!isPlainObject(data)) throw invalidRequest();
  if (!Object.keys(data).every((key) => REQUEST_KEYS.includes(key))) throw invalidRequest();
  if (data.lang !== undefined && typeof data.lang !== "string") throw invalidRequest();
  return readLang(data.lang);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalidRequest() {
  return refusal("invalid-argument", "The request may only carry lang, as a string.", "invalid_request");
}

async function accountEmail(auth: AccountDeletionAuth, uid: string): Promise<string | undefined> {
  return (await findUser(auth, uid))?.email || undefined;
}

async function findUser(auth: AccountDeletionAuth, uid: string): Promise<{ email?: string } | undefined> {
  try {
    return await auth.getUser(uid);
  } catch (error) {
    if (errorCodeOf(error) === "auth/user-not-found") return undefined;
    throw error;
  }
}

/** Deletes the sign-in; false when it was already gone, which is not an error. */
async function deleteAuthUser(auth: AccountDeletionAuth, uid: string): Promise<boolean> {
  try {
    await auth.deleteUser(uid);
    return true;
  } catch (error) {
    if (errorCodeOf(error) === "auth/user-not-found") return false;
    throw error;
  }
}

/**
 * Turns any failure into the callable error the app sees, logging it once.
 *
 * Only codes and the stage are logged, never a message: Auth and Firestore messages can carry
 * the address or document paths.
 */
function toCallableError(
  event: string,
  operationId: string,
  stage: Stage,
  error: unknown
): functions.https.HttpsError {
  if (error instanceof functions.https.HttpsError) {
    functions.logger.warn(`${event}_rejection`, {
      operationId,
      code: error.code,
      ...(reasonOf(error) ? { reason: reasonOf(error) } : {}),
    });
    return error;
  }
  logFailure(event, operationId, stage, error, "error");
  return new functions.https.HttpsError("internal", "The account could not be deleted.");
}

function logFailure(event: string, operationId: string, stage: Stage, error: unknown, level: "warn" | "error"): void {
  const code = (error as { code?: unknown } | null)?.code;
  functions.logger[level](`${event}_failure`, {
    operationId,
    stage,
    errorName: error instanceof Error ? error.name : typeof error,
    ...(errorCodeOf(error) ? { errorCode: errorCodeOf(error) } : {}),
    ...(typeof code === "number" && Number.isInteger(code) ? { grpcCode: code } : {}),
    ...(error instanceof PurgeIncompleteError ? { failedSteps: error.result.failedSteps } : {}),
  });
}

function logInfo(event: string, operationId: string, fields: Record<string, unknown> = {}): void {
  functions.logger.info(event, { operationId, ...fields });
}
