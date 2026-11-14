import { DocumentData, Firestore, Timestamp } from "firebase-admin/firestore";
import {
  projectMaster,
  readProjectionState,
  slotStates,
  STATE_SLOTS,
  stateDataToNormalized,
  SUBSCRIPTION_STATE_COLLECTION,
  timestampDate,
  webSlotIndex,
} from "../subscriptions/persistence";

export interface ExpireTestSlotsResult {
  /** `web/test` slots found. */
  found: number;
  /** Slots that still gave access or were not yet expired, and so need (or got) the write. */
  toExpire: number;
  /** Written; zero on a dry run. */
  expired: number;
  /** Owners whose master was re-projected. */
  uids: string[];
}

/**
 * Marks every `web/test` slot expired and re-projects each owner's master.
 *
 * For the switch from the sandbox key to the live one: a tester's sandbox purchase would
 * otherwise keep giving access until its paid period ends, since nothing syncs the test slot
 * once the key is live. A dry run (the default) only counts. Each owner is written in one
 * transaction with the same projection code the sync uses; a slot already expired is left alone.
 */
export async function expireWebTestSlots(
  db: Firestore,
  options: { apply: boolean; now?: Date }
): Promise<ExpireTestSlotsResult> {
  const now = options.now ?? new Date();
  const test = STATE_SLOTS[webSlotIndex(false)];
  const snapshot = await db
    .collection(SUBSCRIPTION_STATE_COLLECTION)
    .where("platform", "==", test.platform)
    .where("environment", "==", test.environment)
    .get();
  const result: ExpireTestSlotsResult = { found: snapshot.size, toExpire: 0, expired: 0, uids: [] };
  for (const doc of snapshot.docs) {
    const data = doc.data();
    const uid = typeof data.uid === "string" ? data.uid : undefined;
    if (!uid || (data.status === "expired" && data.active !== true)) continue;
    result.toExpire += 1;
    if (!options.apply) {
      result.uids.push(uid);
      continue;
    }
    const written = await db.runTransaction(async (transaction) => {
      const state = await readProjectionState(transaction, uid);
      const index = webSlotIndex(false);
      const current = state.slotSnapshots[index];
      if (!current.exists) return false;
      const stored = current.data()!;
      if (stored.status === "expired" && stored.active !== true) return false;
      const stamp = Timestamp.fromDate(now);
      const expiresAt = timestampDate(stored.expiresAt);
      const next: DocumentData = {
        ...stored,
        active: false,
        status: "expired",
        autoRenewing: false,
        inGracePeriod: false,
        expiresAt: expiresAt && expiresAt.getTime() < now.getTime() ? stored.expiresAt : stamp,
        lastVerifiedAt: stamp,
        updatedAt: stamp,
        web: { ...(stored.web ?? {}), needsAction: false, paymentFailed: false, expiredAtGoLive: stamp },
      };
      transaction.set(state.slotRefs[index], next);
      const states = slotStates(state.slotSnapshots, now);
      states[index] = stateDataToNormalized(next, now);
      projectMaster(transaction, state, states, stamp);
      return true;
    });
    if (written) {
      result.expired += 1;
      result.uids.push(uid);
    }
  }
  return result;
}
