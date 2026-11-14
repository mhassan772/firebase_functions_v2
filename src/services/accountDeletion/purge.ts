import * as crypto from "crypto";
import {
  DocumentReference,
  DocumentSnapshot,
  FieldPath,
  FieldValue,
  Firestore,
  QueryDocumentSnapshot,
  Timestamp,
} from "firebase-admin/firestore";
import * as functions from "firebase-functions";
import { AUTH_EMAIL_THROTTLE_COLLECTION, addressDocId, uidDocId } from "../authEmailThrottle";
import {
  LEGACY_MANUAL_COLLECTION,
  legacyManualDocumentId,
  STATE_SLOTS,
  stateDocumentId,
  SUBSCRIPTION_STATE_COLLECTION,
} from "../subscriptions/persistence";
import {
  FIELD_KEYED_COLLECTIONS,
  LISTENER_TOTALS_COLLECTION,
  PAYMENT_REQUEST_ANONYMISED_FIELD,
  PAYMENT_REQUEST_COLLECTIONS,
  PAYMENT_REQUEST_STRIPPED_FIELDS,
  PAYMENT_REQUEST_UID_FIELD,
  STORAGE_UID_PREFIX_FOLDERS,
  SUBSCRIPTION_UID_FIELD_COLLECTIONS,
  UID_KEYED_COLLECTIONS,
  URL_GRANTS_COLLECTION,
  URL_GRANTS_DEVICES_COLLECTION,
  WEB_CUSTOMERS_COLLECTION,
  WEB_PURCHASE_STRIPPED_FIELDS,
  WEB_PURCHASE_THROTTLE_COLLECTION,
  WEB_PURCHASE_UID_FIELD,
  WEB_PURCHASES_COLLECTION,
} from "./inventory";
import { throttleUidDocId } from "../webSubscriptions/purchaseThrottle";
import { openTombstone, recordTombstoneRun, TombstoneState } from "./tombstone";

/** A Firebase Auth uid as this project issues them. Storage deletion by prefix depends on it. */
export const PURGEABLE_UID = /^[A-Za-z0-9]{20,40}$/;

/** Documents read or written per query page; well under a batch's 500 writes. */
const PAGE_SIZE = 300;

/** The two Storage operations the purge needs; the live bucket and the tests' fake both fit. */
export interface PurgeStorage {
  /** Deletes every object whose name starts with `prefix`, and says how many. */
  deleteByPrefix(prefix: string): Promise<number>;
}

export interface PurgeDeps {
  firestore: Firestore;
  storage: PurgeStorage;
  now: () => number;
  /** Ends the account's web subscriptions at Stripe. Must return without a Stripe call when the account has no customer. */
  cancelWebSubscription: (uid: string) => Promise<void>;
}

export interface PurgeOptions {
  /** The tombstone state to record; omitted, an existing tombstone keeps its state. */
  state?: TombstoneState;
  /** The account's address, when known, so its email throttle counter goes too. */
  email?: string;
}

export type PurgeStep =
  | "tombstone"
  | "read"
  | "web_subscription"
  | "listener_totals"
  | "uid_keyed"
  | "field_keyed"
  | "url_grants_devices"
  | "subscription_records"
  | "payment_requests"
  | "storage"
  | "tombstone_result";

export interface PurgeResult {
  operationId: string;
  ok: boolean;
  /** Documents or objects each step deleted or changed. */
  counts: Partial<Record<PurgeStep, number>>;
  failedSteps: PurgeStep[];
}

export class PurgeRefusedError extends Error {
  readonly code = "invalid-uid";
  constructor() {
    super("The uid cannot be purged.");
    this.name = "PurgeRefusedError";
  }
}

/** What the purge must read before the document holding it is deleted. */
interface Collected {
  deviceIds: string[];
}

/**
 * Deletes or anonymises everything listed in `inventory.ts` for one account.
 *
 * Every step runs even when an earlier one failed, and every step can be repeated, so a later
 * run finishes what an earlier one left. The run is ok only when no step failed.
 */
export async function purgeAccount(uid: string, deps: PurgeDeps, options: PurgeOptions = {}): Promise<PurgeResult> {
  const operationId = crypto.randomUUID();
  if (typeof uid !== "string" || !PURGEABLE_UID.test(uid)) {
    functions.logger.error("account_purge_failure", { operationId, code: "invalid-uid" });
    throw new PurgeRefusedError();
  }
  const db = deps.firestore;
  const result: PurgeResult = { operationId, ok: true, counts: {}, failedSteps: [] };
  functions.logger.info("account_purge_start", { operationId, uid, state: options.state ?? null });

  const run = async (step: PurgeStep, work: (fail: (target: string, error: unknown) => void) => Promise<number>) => {
    let failed = false;
    const fail = (target: string, error: unknown) => {
      failed = true;
      logStepFailure(operationId, step, error, target);
    };
    try {
      result.counts[step] = await work(fail);
    } catch (error) {
      failed = true;
      logStepFailure(operationId, step, error);
    }
    if (failed) {
      result.ok = false;
      result.failedSteps.push(step);
    }
  };

  const now = Timestamp.fromMillis(deps.now());
  const collected: Collected = { deviceIds: [] };

  await run("tombstone", async () => {
    await openTombstone(db, uid, now, options.state);
    return 1;
  });

  let devicesRead = false;
  await run("read", async () => {
    collected.deviceIds = await readDeviceIds(db, uid);
    devicesRead = true;
    return collected.deviceIds.length;
  });

  let webDone = false;
  await run("web_subscription", async () => {
    await deps.cancelWebSubscription(uid);
    webDone = true;
    return 0;
  });

  await run("listener_totals", () => deleteDocuments(db, [db.collection(LISTENER_TOTALS_COLLECTION).doc(uid)]));

  let devicesDone = false;
  await run("url_grants_devices", async (fail) => {
    let count = 0;
    let failed = false;
    for (const deviceId of collected.deviceIds) {
      try {
        if (await removeGuest(db, deviceId, uid)) count += 1;
      } catch (error) {
        failed = true;
        fail(URL_GRANTS_DEVICES_COLLECTION, error);
      }
    }
    devicesDone = !failed;
    return count;
  });

  await run("uid_keyed", async (fail) => {
    let count = 0;
    const roots = UID_KEYED_COLLECTIONS.map((collection) => db.collection(collection).doc(uid));
    // A root's subcollections are found whether or not the root itself exists, so its own
    // existence is read only to count it.
    let existing = new Set(roots.map((root) => root.path));
    try {
      existing = new Set(
        (await db.getAll(...roots)).filter((snapshot) => snapshot.exists).map((snapshot) => snapshot.ref.path)
      );
    } catch (error) {
      fail("roots", error);
    }
    for (const root of roots) {
      // The device ids live only here; without them a later run could not clear the devices.
      if (root.parent.id === URL_GRANTS_COLLECTION && !(devicesRead && devicesDone)) {
        fail(URL_GRANTS_COLLECTION, new Error("url_grants kept for the next run"));
        continue;
      }
      try {
        count += await deleteRecursively(db, root, existing.has(root.path));
      } catch (error) {
        fail(root.parent.id, error);
      }
    }
    const webCustomer = db.collection(WEB_CUSTOMERS_COLLECTION).doc(uid);
    if (webDone) {
      try {
        count += await deleteDocuments(db, [webCustomer, db.collection(WEB_PURCHASE_THROTTLE_COLLECTION).doc(throttleUidDocId(uid))]);
      } catch (error) {
        fail(WEB_CUSTOMERS_COLLECTION, error);
      }
    } else {
      fail(WEB_CUSTOMERS_COLLECTION, new Error("web_customers kept for the next run"));
    }
    const throttle = db.collection(AUTH_EMAIL_THROTTLE_COLLECTION);
    const throttleRefs = [throttle.doc(uidDocId(uid)), ...(options.email ? [throttle.doc(addressDocId(options.email))] : [])];
    try {
      count += await deleteDocuments(db, throttleRefs);
    } catch (error) {
      fail(AUTH_EMAIL_THROTTLE_COLLECTION, error);
    }
    return count;
  });

  await run("field_keyed", async (fail) => {
    let count = 0;
    for (const { collection, field } of FIELD_KEYED_COLLECTIONS) {
      try {
        count += await deleteWhere(db, collection, field, uid);
      } catch (error) {
        fail(collection, error);
      }
    }
    return count;
  });

  await run("subscription_records", async (fail) => {
    let count = 0;
    const slotRefs = STATE_SLOTS.map((slot) =>
      db.collection(SUBSCRIPTION_STATE_COLLECTION).doc(stateDocumentId(uid, slot.platform, slot.environment))
    );
    const manual = db.collection(LEGACY_MANUAL_COLLECTION);
    try {
      count += await deleteDocuments(db, [...slotRefs, manual.doc(legacyManualDocumentId(uid)), manual.doc(uid)]);
    } catch (error) {
      fail("slots", error);
    }
    for (const { collection, field } of SUBSCRIPTION_UID_FIELD_COLLECTIONS) {
      try {
        count += await deleteWhere(db, collection, field, uid);
      } catch (error) {
        fail(collection, error);
      }
    }
    return count;
  });

  await run("payment_requests", async (fail) => {
    let count = 0;
    for (const collection of PAYMENT_REQUEST_COLLECTIONS) {
      try {
        count += await anonymiseWhere(db, collection, PAYMENT_REQUEST_UID_FIELD, PAYMENT_REQUEST_STRIPPED_FIELDS, uid, now);
      } catch (error) {
        fail(collection, error);
      }
    }
    try {
      count += await anonymiseWhere(db, WEB_PURCHASES_COLLECTION, WEB_PURCHASE_UID_FIELD, WEB_PURCHASE_STRIPPED_FIELDS, uid, now);
    } catch (error) {
      fail(WEB_PURCHASES_COLLECTION, error);
    }
    return count;
  });

  await run("storage", async (fail) => {
    let count = 0;
    for (const folder of STORAGE_UID_PREFIX_FOLDERS) {
      try {
        count += await deps.storage.deleteByPrefix(`${folder}/${uid}_`);
      } catch (error) {
        fail(folder, error);
      }
    }
    return count;
  });

  const okBeforeResult = result.ok;
  await run("tombstone_result", async () => {
    await recordTombstoneRun(db, uid, okBeforeResult);
    return 1;
  });

  const fields = { operationId, uid, counts: result.counts };
  if (result.ok) {
    functions.logger.info("account_purge_success", fields);
  } else {
    functions.logger.error("account_purge_failure", { ...fields, failedSteps: result.failedSteps });
  }
  return result;
}

/** Device ids from `url_grants/{uid}.devices`, kept only when usable as a document id. */
async function readDeviceIds(db: Firestore, uid: string): Promise<string[]> {
  const devices = (await db.collection(URL_GRANTS_COLLECTION).doc(uid).get()).get("devices");
  if (!devices || typeof devices !== "object") return [];
  return Object.keys(devices).filter(
    (id) => id.length > 0 && id.length <= 512 && !id.includes("/") && id !== "." && id !== ".." && !/^__.*__$/.test(id)
  );
}

/** Deletes the documents that exist among `refs` and says how many did. */
async function deleteDocuments(db: Firestore, refs: DocumentReference[]): Promise<number> {
  const snapshots = await db.getAll(...refs);
  const present = snapshots.filter((snapshot: DocumentSnapshot) => snapshot.exists);
  if (present.length === 0) return 0;
  const batch = db.batch();
  present.forEach((snapshot) => batch.delete(snapshot.ref));
  await batch.commit();
  return present.length;
}

/** Deletes a document with every subcollection below it, counting only what existed. */
async function deleteRecursively(db: Firestore, ref: DocumentReference, rootExists: boolean): Promise<number> {
  const writer = db.bulkWriter();
  let writes = 0;
  writer.onWriteResult(() => {
    writes += 1;
  });
  try {
    await db.recursiveDelete(ref, writer);
  } finally {
    await writer.close();
  }
  // recursiveDelete always deletes the root, present or not.
  return Math.max(0, writes - (rootExists ? 0 : 1));
}

/** Calls `handle` with each page of documents whose `field` equals `value`. */
async function forEachPage(
  db: Firestore,
  collection: string,
  field: string,
  value: string,
  handle: (docs: QueryDocumentSnapshot[]) => Promise<void> | void
): Promise<number> {
  let total = 0;
  let last: QueryDocumentSnapshot | undefined;
  for (;;) {
    let query = db.collection(collection).where(field, "==", value).limit(PAGE_SIZE);
    if (last) query = query.startAfter(last);
    const snapshot = await query.get();
    if (snapshot.empty) break;
    await handle(snapshot.docs);
    total += snapshot.size;
    if (snapshot.size < PAGE_SIZE) break;
    last = snapshot.docs[snapshot.docs.length - 1];
  }
  return total;
}

async function deleteWhere(db: Firestore, collection: string, field: string, uid: string): Promise<number> {
  return forEachPage(db, collection, field, uid, async (docs) => {
    const batch = db.batch();
    docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
  });
}

/** Strips the payer's identity from each payment record of `uid` and stamps when. */
async function anonymiseWhere(
  db: Firestore,
  collection: string,
  uidField: string,
  strippedFields: readonly string[],
  uid: string,
  now: Timestamp
): Promise<number> {
  const update: Record<string, unknown> = { [PAYMENT_REQUEST_ANONYMISED_FIELD]: now };
  for (const field of strippedFields) update[field] = FieldValue.delete();
  return forEachPage(db, collection, uidField, uid, async (docs) => {
    const batch = db.batch();
    docs.forEach((doc) => batch.update(doc.ref, update));
    await batch.commit();
  });
}

/**
 * Removes the uid from one shared device document, keeping every other guest on it.
 *
 * Read and written in one transaction, so a guest added at the same moment is counted.
 */
async function removeGuest(db: Firestore, deviceId: string, uid: string): Promise<boolean> {
  const ref = db.collection(URL_GRANTS_DEVICES_COLLECTION).doc(deviceId);
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const guests = snapshot.get("guestUids");
    if (!snapshot.exists || !guests || typeof guests !== "object" || !(uid in guests)) return false;
    const remaining = Object.keys(guests).filter((guest) => guest !== uid).length;
    transaction.update(ref, new FieldPath("guestUids", uid), FieldValue.delete(), "guestUidsCount", remaining);
    return true;
  });
}

function logStepFailure(operationId: string, step: PurgeStep, error: unknown, target?: string): void {
  const code = (error as { code?: unknown } | null)?.code;
  functions.logger.error("account_purge_step_failure", {
    operationId,
    step,
    ...(target ? { target } : {}),
    errorName: error instanceof Error ? error.name : typeof error,
    ...(typeof code === "number" || (typeof code === "string" && /^[\w/.-]{1,64}$/.test(code)) ? { errorCode: code } : {}),
  });
}

/** The structural slice of a Cloud Storage bucket `bucketPurgeStorage` uses. */
export interface PurgeBucket {
  getFiles(query: {
    prefix: string;
    maxResults: number;
    autoPaginate: false;
  }): Promise<[{ name: string; delete(): Promise<unknown> }[], ...unknown[]]>;
}

/** The live Storage operations on a bucket. */
export function bucketPurgeStorage(bucket: PurgeBucket): PurgeStorage {
  const isNotFound = (error: unknown) => (error as { code?: unknown } | null)?.code === 404;
  return {
    async deleteByPrefix(prefix) {
      let count = 0;
      // Listed again from the start each time: what was deleted is no longer listed.
      for (;;) {
        const [files] = await bucket.getFiles({ prefix, maxResults: PAGE_SIZE, autoPaginate: false });
        if (files.length === 0) return count;
        let deleted = 0;
        for (const file of files) {
          try {
            await file.delete();
            deleted += 1;
          } catch (error) {
            if (!isNotFound(error)) throw error;
          }
        }
        count += deleted;
        // A page that deleted nothing would be listed again forever.
        if (files.length < PAGE_SIZE || deleted === 0) return count;
      }
    },
  };
}
