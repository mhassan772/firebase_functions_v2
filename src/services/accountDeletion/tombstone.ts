import { DocumentData, FieldValue, Firestore, Timestamp } from "firebase-admin/firestore";

/**
 * One server-only document per deleted account, `deleted_accounts/{uid}`, holding no personal
 * field. It marks the uid as deleted for `persistVerifiedSubscription` and tells the weekly
 * cleanup which accounts still need another purge. No rules entry: clients cannot read it.
 */
export const DELETED_ACCOUNTS_COLLECTION = "deleted_accounts";

/** `pending` while the sign-in may still exist; `deleted` once Auth no longer has the user. */
export type TombstoneState = "pending" | "deleted";

export interface Tombstone {
  state: TombstoneState;
  deletedAt: Timestamp;
  lastRunAt: Timestamp;
  lastRunOk?: boolean;
  runs: number;
  closedAt?: Timestamp;
}

export function tombstoneRef(firestore: Firestore, uid: string) {
  return firestore.collection(DELETED_ACCOUNTS_COLLECTION).doc(uid);
}

/**
 * Records the start of a purge: creates the tombstone with `deletedAt` on the first run, and on
 * every run sets `lastRunAt` and counts it.
 *
 * `deleted` is never turned back into `pending`, so a late callable run cannot undo what the Auth
 * trigger recorded. A run on a closed tombstone opens it again, so the weekly cleanup checks it.
 */
export async function openTombstone(
  firestore: Firestore,
  uid: string,
  now: Timestamp,
  state?: TombstoneState
): Promise<void> {
  const ref = tombstoneRef(firestore, uid);
  await firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) {
      transaction.set(ref, { state: state ?? "pending", deletedAt: now, lastRunAt: now, runs: 1 });
      return;
    }
    const update: DocumentData = { lastRunAt: now, runs: FieldValue.increment(1) };
    if (state === "deleted") update.state = "deleted";
    if (snapshot.get("closedAt") !== undefined) update.closedAt = FieldValue.delete();
    transaction.update(ref, update);
  });
}

export async function recordTombstoneRun(firestore: Firestore, uid: string, ok: boolean): Promise<void> {
  await tombstoneRef(firestore, uid).update({ lastRunOk: ok });
}

/** Marks the sign-in as gone. Creates nothing: a tombstone exists only once a purge has started. */
export async function markTombstoneDeleted(firestore: Firestore, uid: string): Promise<void> {
  await tombstoneRef(firestore, uid).update({ state: "deleted" });
}

export async function closeTombstone(firestore: Firestore, uid: string, now: Timestamp): Promise<void> {
  await tombstoneRef(firestore, uid).update({ state: "deleted", closedAt: now });
}

export function isTombstoneOpen(data: DocumentData | undefined): boolean {
  return data !== undefined && data.closedAt === undefined;
}
