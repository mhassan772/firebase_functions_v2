import * as functions from "firebase-functions";
import { AggregateField, FieldPath, FieldValue, Timestamp } from "firebase-admin/firestore";
import { admin } from "../config/admin";
import {
  COMMUNITY_GOALS_COLLECTION,
  COMMUNITY_GOAL_STATS_COLLECTION,
  DAY_MS,
  LISTENING_HISTORY_COLLECTION,
  MONTHS_FIELD,
  closesAtMs,
  goalFromData,
  goalKey,
  hijriMonthBounds,
  hijriOfDay,
  newGoalFields,
  shiftHijriMonth,
  utcDay,
} from "./communityGoalHandlers";
import { recomputeUserMonth } from "./communityGoalTriggerHandlers";
import { LISTENER_TOTALS_COLLECTION } from "./listenStatsHandlers";

type Change = functions.Change<functions.firestore.DocumentSnapshot>;

/** The next month is created this many days before its first day, so the portal can set it up. */
const NEXT_MONTH_LEAD_DAYS = 10;
/** Open months summed per run; normally two, the current and the next. */
const OPEN_GOALS_LIMIT = 24;
/** Closed months whose late time is still refreshed. */
const LATE_ACTUAL_DAYS = 60;
const LATE_ACTUAL_REFRESH_MS = 24 * 60 * 60 * 1000;
/** A running recount whose progress has not moved for this long has stopped, and is resumed. */
const RECOUNT_STALE_MS = 10 * 60 * 1000;
const RECOUNT_PAGE_SIZE = 200;
/** Users recomputed at once: each is its own transaction on its own documents, so they do not contend. */
const RECOUNT_CONCURRENCY = 30;
/** Extra days a recount reaches back when its old first day is unknown (a request no trigger started). */
const ORPHAN_RECOUNT_EXTRA_DAYS = 31;

/** The progress of a recount, in `community_goal_stats/{key}.recount`. */
interface RecountState {
  state: "running" | "done" | "failed";
  requestedAt: Timestamp;
  fromDay: number;
  processed: number;
  cursor: { updatedAtMs: number; uid: string } | null;
}

const goals = () => admin.firestore().collection(COMMUNITY_GOALS_COLLECTION);
const stats = () => admin.firestore().collection(COMMUNITY_GOAL_STATS_COLLECTION);

/**
 * The hourly job: makes sure the current and the coming month exist, sums every open month,
 * closes a month once its grace period is over, refreshes the late time of recently closed
 * months once a day, and resumes recounts that ran out of time. See docs/community-goal.md.
 *
 * One step failing does not stop the others; the run fails at the end so the log shows it.
 */
export async function handleRefreshCommunityGoals(now = new Date(), deadlineMs = Date.now() + 240_000): Promise<void> {
  const failures: string[] = [];
  const step = async (name: string, work: () => Promise<void>): Promise<void> => {
    try {
      await work();
    } catch (error) {
      failures.push(name);
      functions.logger.error(`community goals: ${name} failed`, { error: String(error) });
    }
  };

  await step("create months", () => ensureMonths(now));
  const open = await goals().where("status", "==", "open").limit(OPEN_GOALS_LIMIT).get();
  for (const doc of open.docs) {
    await step(`sum ${doc.id}`, async () => {
      await refreshGoalTotals(doc.id, now);
    });
  }
  await step("late time", () => refreshLateActuals(now));
  await step("recounts", () => resumeRecounts(open.docs, now, deadlineMs));
  if (failures.length > 0) {
    throw new Error(`community goals: ${failures.join(", ")} failed`);
  }
}

/** Creates the current Hijri month, and the next from ten days before it starts, when missing. */
async function ensureMonths(now: Date): Promise<void> {
  const today = utcDay(now.getTime());
  const current = hijriOfDay(today);
  await ensureMonth(current.hijriYear, current.hijriMonth);
  const next = shiftHijriMonth(current.hijriYear, current.hijriMonth, 1);
  if (today >= hijriMonthBounds(next.hijriYear, next.hijriMonth).firstDay - NEXT_MONTH_LEAD_DAYS) {
    await ensureMonth(next.hijriYear, next.hijriMonth);
  }
}

/** Creates one month from the one before it. A month that exists is never touched. */
async function ensureMonth(hijriYear: number, hijriMonth: number): Promise<void> {
  const key = goalKey(hijriYear, hijriMonth);
  const previous = shiftHijriMonth(hijriYear, hijriMonth, -1);
  const ref = goals().doc(key);
  const fields = await admin.firestore().runTransaction(async (transaction) => {
    if ((await transaction.get(ref)).exists) {
      return null;
    }
    const before = await transaction.get(goals().doc(goalKey(previous.hijriYear, previous.hijriMonth)));
    const created = newGoalFields(hijriYear, hijriMonth, hijriMonthBounds(hijriYear, hijriMonth), before.data());
    transaction.create(ref, created);
    return created;
  });
  if (fields) {
    functions.logger.info(`community goal ${key} created`, { key, firstDay: fields.firstDay, lastDay: fields.lastDay });
  }
}

/** Sums one field of every user's entry for a month; one aggregate per query, which needs no composite index. */
async function sumOf(key: string, field: "c" | "a"): Promise<number> {
  const result = await admin
    .firestore()
    .collection(LISTENER_TOTALS_COLLECTION)
    .aggregate({ seconds: AggregateField.sum(`${MONTHS_FIELD}.${key}.${field}`) })
    .get();
  return Number(result.data().seconds) || 0;
}

/**
 * Sums a month and writes the numbers. While it is open the goal document gets the total, and the
 * participant count only while `show.participants` is on; once now reaches closesAt the same write
 * closes it with the final numbers. A closed month's goal document is never changed again: only
 * its late time in the stats document moves.
 */
export async function refreshGoalTotals(key: string, now: Date): Promise<void> {
  const counted = `${MONTHS_FIELD}.${key}.c`;
  const [totalSeconds, actualSeconds, participants] = await Promise.all([
    sumOf(key, "c"),
    sumOf(key, "a"),
    admin.firestore().collection(LISTENER_TOTALS_COLLECTION).where(counted, ">", 0).count().get().then((r) => r.data().count),
  ]);
  const at = Timestamp.fromDate(now);
  const closed = await admin.firestore().runTransaction(async (transaction) => {
    const goalRef = goals().doc(key);
    const snapshot = await transaction.get(goalRef);
    if (!snapshot.exists) {
      return false;
    }
    const data = snapshot.data() ?? {};
    if (data.status === "closed") {
      transaction.set(stats().doc(key), { actualSeconds, actualUpdatedAt: at }, { merge: true });
      return false;
    }
    const goal = goalFromData(key, data);
    const closing = goal !== null && now.getTime() >= closesAtMs(goal);
    transaction.update(goalRef, {
      totalSeconds,
      totalUpdatedAt: at,
      participants: data.show?.participants === true ? participants : FieldValue.delete(),
      ...(closing ? { status: "closed", closedAt: at } : {}),
    });
    transaction.set(
      stats().doc(key),
      { totalSeconds, participants, actualSeconds, updatedAt: at, actualUpdatedAt: at },
      { merge: true },
    );
    return closing;
  });
  functions.logger.info(`community goal ${key} summed${closed ? " and closed" : ""}`, {
    key,
    totalSeconds,
    actualSeconds,
    participants,
  });
}

/** Months closed in the last 60 days: their late time, once a day. */
async function refreshLateActuals(now: Date): Promise<void> {
  const cutoff = Timestamp.fromMillis(now.getTime() - LATE_ACTUAL_DAYS * DAY_MS);
  const closed = await goals().where("closedAt", ">=", cutoff).limit(OPEN_GOALS_LIMIT).get();
  for (const doc of closed.docs) {
    if (doc.get("status") !== "closed") {
      continue;
    }
    const last = (await stats().doc(doc.id).get()).get("actualUpdatedAt");
    if (last instanceof Timestamp && now.getTime() - last.toMillis() < LATE_ACTUAL_REFRESH_MS) {
      continue;
    }
    const actualSeconds = await sumOf(doc.id, "a");
    await stats().doc(doc.id).set({ actualSeconds, actualUpdatedAt: Timestamp.fromDate(now) }, { merge: true });
    functions.logger.info(`community goal ${doc.id}: late time refreshed`, { key: doc.id, actualSeconds });
  }
}

/**
 * Resumes recounts that stopped, and starts any request no trigger picked up.
 *
 * A request is picked up here only after ten minutes, so it never races the trigger that should
 * have started it. Its old first day is lost by then, so it reaches back a month further.
 */
async function resumeRecounts(open: FirebaseFirestore.QueryDocumentSnapshot[], now: Date, deadlineMs: number): Promise<void> {
  const running = await stats().where("recount.state", "==", "running").limit(OPEN_GOALS_LIMIT).get();
  for (const doc of running.docs) {
    const recount = doc.get("recount") ?? {};
    const progressAt = recount.progressAt instanceof Timestamp ? recount.progressAt : recount.startedAt;
    if (progressAt instanceof Timestamp && now.getTime() - progressAt.toMillis() < RECOUNT_STALE_MS) {
      continue;
    }
    if (!(recount.requestedAt instanceof Timestamp) || Date.now() > deadlineMs) {
      continue;
    }
    functions.logger.info(`community goal ${doc.id}: resuming recount`, { key: doc.id, processed: recount.processed });
    await runRecount(doc.id, recount.requestedAt, deadlineMs);
  }

  for (const doc of open) {
    const requestedAt = doc.get("recount.requestedAt");
    if (!(requestedAt instanceof Timestamp) || now.getTime() - requestedAt.toMillis() < RECOUNT_STALE_MS) {
      continue;
    }
    const started = (await stats().doc(doc.id).get()).get("recount.requestedAt");
    if (started instanceof Timestamp && started.isEqual(requestedAt)) {
      continue;
    }
    const goal = goalFromData(doc.id, doc.data());
    if (!goal || Date.now() > deadlineMs) {
      continue;
    }
    functions.logger.warn(`community goal ${doc.id}: starting a recount no trigger started`, { key: doc.id });
    await startRecount(doc.id, requestedAt, goal.firstDay - 1 - ORPHAN_RECOUNT_EXTRA_DAYS, now, deadlineMs);
  }
}

/**
 * Reacts to a portal request to recount a month, written as a new `recount.requestedAt` on the
 * goal document. Every other write to the document, the hourly totals included, is ignored.
 *
 * Users are found through their history index: anyone who uploaded a day of the window, under the
 * old dates or the new, has an `updatedAt` on or after the day before the earlier first day.
 */
export async function handleCommunityGoalRecountChange(change: Change, key: string, deadlineMs: number): Promise<void> {
  const after = change.after.data();
  const requestedAt = after?.recount?.requestedAt;
  if (!(requestedAt instanceof Timestamp)) {
    return;
  }
  const previous = change.before.data()?.recount?.requestedAt;
  if (previous instanceof Timestamp && previous.isEqual(requestedAt)) {
    return;
  }
  const firstDays = [goalFromData(key, change.before.data()), goalFromData(key, after)].flatMap((goal) =>
    goal ? [goal.firstDay] : [],
  );
  if (firstDays.length === 0) {
    await failRecount(key, requestedAt, "the month has no valid dates");
    return;
  }
  await startRecount(key, requestedAt, Math.min(...firstDays) - 1, new Date(), deadlineMs);
}

/**
 * Records a new recount as running and runs it. A request already recorded (a repeated event)
 * is left to the run that recorded it; a closed month is refused.
 */
async function startRecount(key: string, requestedAt: Timestamp, fromDay: number, now: Date, deadlineMs: number): Promise<void> {
  const at = Timestamp.fromDate(now);
  const outcome = await admin.firestore().runTransaction(async (transaction) => {
    const [goalSnapshot, statsSnapshot] = await transaction.getAll(goals().doc(key), stats().doc(key));
    const recorded = statsSnapshot.get("recount.requestedAt");
    if (recorded instanceof Timestamp && recorded.isEqual(requestedAt)) {
      return "recorded" as const;
    }
    const current = goalSnapshot.get("recount.requestedAt");
    if (!(current instanceof Timestamp) || !current.isEqual(requestedAt)) {
      // A newer request replaced this one; its own event starts it.
      return "replaced" as const;
    }
    const goal = goalFromData(key, goalSnapshot.data());
    const closed = goalSnapshot.get("status") === "closed" || (goal !== null && now.getTime() >= closesAtMs(goal));
    const base = { requestedAt, startedAt: at, processed: 0, fromDay, cursor: null, progressAt: at };
    if (closed) {
      transaction.set(
        stats().doc(key),
        { recount: { ...base, state: "failed", finishedAt: at, error: "the month is closed" } },
        { merge: true },
      );
      return "refused" as const;
    }
    transaction.set(stats().doc(key), { recount: { ...base, state: "running", finishedAt: null } }, { merge: true });
    return "started" as const;
  });
  functions.logger.info(`community goal ${key}: recount ${outcome}`, { key, fromDay });
  if (outcome === "started") {
    await runRecount(key, requestedAt, deadlineMs);
  }
}

async function failRecount(key: string, requestedAt: Timestamp, error: string): Promise<void> {
  const at = Timestamp.now();
  await stats()
    .doc(key)
    .set(
      { recount: { state: "failed", requestedAt, startedAt: at, finishedAt: at, processed: 0, cursor: null, error } },
      { merge: true },
    );
  functions.logger.warn(`community goal ${key}: recount refused, ${error}`, { key });
}

/**
 * Recomputes the month for every user found, a page at a time, saving the cursor after each
 * page. It stops before the deadline and leaves the state running, for the hourly job to resume;
 * a run whose request was replaced stops at its next save. When the last page is done it sums
 * the month again and marks the recount done.
 */
async function runRecount(key: string, requestedAt: Timestamp, deadlineMs: number): Promise<void> {
  const statsRef = stats().doc(key);
  const state = (await statsRef.get()).get("recount") as RecountState | undefined;
  if (!state || state.state !== "running" || !(state.requestedAt instanceof Timestamp) || !state.requestedAt.isEqual(requestedAt)) {
    return;
  }
  let processed = Number(state.processed) || 0;
  // In memory the exact time is kept; the saved cursor is whole milliseconds, so a resumed run may
  // redo the last few users of a page, which writes nothing new.
  let cursor: { updatedAt: Timestamp; uid: string } | null = state.cursor
    ? { updatedAt: Timestamp.fromMillis(state.cursor.updatedAtMs), uid: state.cursor.uid }
    : null;
  const from = Timestamp.fromMillis(state.fromDay * DAY_MS);
  try {
    for (;;) {
      if (Date.now() > deadlineMs) {
        functions.logger.info(`community goal ${key}: recount paused at ${processed}`, { key, processed });
        return;
      }
      let query = admin
        .firestore()
        .collection(LISTENING_HISTORY_COLLECTION)
        .where("updatedAt", ">=", from)
        .orderBy("updatedAt")
        .orderBy(FieldPath.documentId())
        .select("updatedAt")
        .limit(RECOUNT_PAGE_SIZE);
      if (cursor) {
        query = query.startAfter(cursor.updatedAt, cursor.uid);
      }
      // Read once per page: fresh enough, since a newer request replaces this run at its next save.
      const [page, goalSnapshot] = await Promise.all([query.get(), goals().doc(key).get()]);
      const goal = goalFromData(key, goalSnapshot.data());
      if (!goal) {
        throw new Error("the month has no valid dates");
      }
      await inBatches(page.docs, RECOUNT_CONCURRENCY, (doc) => recomputeUserMonth(doc.id, key, new Date(), goal));
      processed += page.size;
      const last = page.docs[page.docs.length - 1];
      if (last) {
        cursor = { updatedAt: last.get("updatedAt") as Timestamp, uid: last.id };
      }
      const finished = page.size < RECOUNT_PAGE_SIZE;
      if (!(await saveProgress(key, requestedAt, processed, cursor, false))) {
        functions.logger.info(`community goal ${key}: recount replaced by a newer request`, { key });
        return;
      }
      if (finished) {
        await refreshGoalTotals(key, new Date());
        await saveProgress(key, requestedAt, processed, cursor, true);
        functions.logger.info(`community goal ${key}: recount done, ${processed} user(s)`, { key, processed });
        return;
      }
    }
  } catch (error) {
    await statsRef.update({ "recount.error": String(error) }).catch(() => undefined);
    throw error;
  }
}

/** Saves a recount's progress if it is still the current one; false when a newer request took over. */
function saveProgress(
  key: string,
  requestedAt: Timestamp,
  processed: number,
  cursor: { updatedAt: Timestamp; uid: string } | null,
  done: boolean,
): Promise<boolean> {
  const statsRef = stats().doc(key);
  return admin.firestore().runTransaction(async (transaction) => {
    const current = (await transaction.get(statsRef)).get("recount");
    if (current?.state !== "running" || !(current.requestedAt instanceof Timestamp) || !current.requestedAt.isEqual(requestedAt)) {
      return false;
    }
    const at = Timestamp.now();
    transaction.update(statsRef, {
      "recount.processed": processed,
      "recount.cursor": cursor ? { updatedAtMs: Math.floor(cursor.updatedAt.toMillis()), uid: cursor.uid } : null,
      "recount.progressAt": at,
      ...(done ? { "recount.state": "done", "recount.finishedAt": at, "recount.error": FieldValue.delete() } : {}),
    });
    return true;
  });
}

/** Runs the work over the items, at most `size` at a time. */
async function inBatches<T>(items: T[], size: number, work: (item: T) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(work));
  }
}
