import * as functions from "firebase-functions";
import { FieldValue } from "firebase-admin/firestore";
import { admin } from "../config/admin";
import {
  COMMUNITY_GOALS_COLLECTION,
  GoalWindow,
  LISTENING_HISTORY_CHUNKS,
  LISTENING_HISTORY_COLLECTION,
  MAX_MONTHS,
  MONTHS_FIELD,
  boundedMonths,
  changedDays,
  goalFromData,
  isGoalOpen,
  mergeDays,
  monthValue,
  nextMonthEntry,
  secondsByDay,
  touchedGoals,
  utcDay,
  yearsOfWindow,
} from "./communityGoalHandlers";
import { LISTENER_TOTALS_COLLECTION } from "./listenStatsHandlers";

type Change = functions.Change<functions.firestore.DocumentSnapshot>;

/** How long an instance reuses the goals it read; the portal edits them rarely. */
const GOALS_TTL_MS = 10 * 60 * 1000;
/** Goals read into the cache: the newest by first day, as many as a user's months map keeps. */
const CACHED_GOALS = MAX_MONTHS;

let cachedGoals: { goals: GoalWindow[]; readAt: number } | undefined;

/**
 * Updates the user's value for every month a write to one of their days documents touches.
 *
 * The before and after data come with the event, so a write that changes no day inside a goal
 * reads nothing. The value itself is computed from fresh reads, never from the event, so a
 * repeated or out-of-order delivery writes the same result. See docs/community-goal.md.
 */
export async function handleListeningDaysChange(change: Change, uid: string, year: string): Promise<void> {
  const now = new Date();
  const before = change.before.data();
  const after = change.after.data();
  const today = utcDay(now.getTime());
  // Nothing changed at all: not even the goals are read.
  if (![...changedDays(before, after)].some((day) => day <= today + 1)) {
    return;
  }
  const touched = touchedGoals(await goals(), before, after, today);
  if (touched.length === 0) {
    return;
  }
  const results: string[] = [];
  for (const goal of touched) {
    const result = await recomputeUserMonth(uid, goal.key, now);
    results.push(`${goal.key}: ${result.written ? result.value : "unchanged"}`);
  }
  functions.logger.info(`community goal: ${touched.length} month(s) recomputed`, { uid, year, results });
}

/**
 * Recomputes one user's value for one month from their days documents as stored now, and
 * merges it into `listener_totals/{uid}.months.<key>`.
 *
 * One transaction reads the goal, the year documents its window spans and the totals, so the
 * value matches the rows and the window at the moment it is written. Shared by the listening
 * trigger and the recount.
 *
 * The recount passes the goal it read for the page as [known], so thousands of users in a row
 * neither read the goal document each nor hold it against the hourly job's write to it.
 */
export async function recomputeUserMonth(
  uid: string,
  key: string,
  now: Date,
  known?: GoalWindow,
): Promise<{ value: number; written: boolean }> {
  const firestore = admin.firestore();
  const goalRef = firestore.collection(COMMUNITY_GOALS_COLLECTION).doc(key);
  const totalsRef = firestore.collection(LISTENER_TOTALS_COLLECTION).doc(uid);
  const chunks = firestore.collection(LISTENING_HISTORY_COLLECTION).doc(uid).collection(LISTENING_HISTORY_CHUNKS);
  return firestore.runTransaction(async (transaction) => {
    const goal = known ?? goalFromData(key, (await transaction.get(goalRef)).data());
    if (!goal) {
      return { value: 0, written: false };
    }
    const years = yearsOfWindow(goal);
    const [totalsSnapshot, ...chunkSnapshots] = await transaction.getAll(
      totalsRef,
      ...years.map((year) => chunks.doc(String(year))),
    );
    const days = mergeDays(...chunkSnapshots.map((snapshot, i) => secondsByDay(snapshot.data(), years[i])));
    const value = monthValue(days, goal, utcDay(now.getTime()));
    const months = totalsSnapshot.get(MONTHS_FIELD);
    const stored = months && typeof months === "object" ? (months as Record<string, unknown>) : {};
    const entry = nextMonthEntry(stored[key], value, isGoalOpen(goal, now.getTime()));
    if (!entry) {
      return { value, written: false };
    }
    const bounded = boundedMonths(Object.keys(stored), key);
    if (!bounded.write) {
      return { value, written: false };
    }
    const update: Record<string, unknown> = { [key]: entry };
    for (const old of bounded.remove) {
      update[old] = FieldValue.delete();
    }
    transaction.set(totalsRef, { [MONTHS_FIELD]: update }, { merge: true });
    return { value, written: true };
  });
}

async function goals(): Promise<GoalWindow[]> {
  if (!cachedGoals || Date.now() - cachedGoals.readAt > GOALS_TTL_MS) {
    const snapshot = await admin
      .firestore()
      .collection(COMMUNITY_GOALS_COLLECTION)
      .orderBy("firstDay", "desc")
      .limit(CACHED_GOALS)
      .get();
    cachedGoals = {
      goals: snapshot.docs.flatMap((doc) => goalFromData(doc.id, doc.data()) ?? []),
      readAt: Date.now(),
    };
  }
  return cachedGoals.goals;
}

/** Forgets the cached goals; for tests, which edit goals between events. */
export function clearCommunityGoalCache(): void {
  cachedGoals = undefined;
}
