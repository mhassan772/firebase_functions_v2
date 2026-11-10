import * as functions from "firebase-functions";
import { AggregateField, FieldValue } from "firebase-admin/firestore";
import { admin } from "../config/admin";
import { LISTENER_TOTALS_COLLECTION, PUBLIC_STATS_PATH, wholeHours } from "./listenStatsHandlers";

/** Donation records, written by the donation site's Stripe webhook and its import script. */
const DONATIONS_COLLECTION = "DONATE_donations";
const DONATIONS_PAGE_SIZE = 2000;

/**
 * Rebuilds the numbers in `public_stats/site` that are cheap to recount, once a day:
 * - `hoursListened` (with `bookHoursListened` and `podcastHoursListened`): the sum of every
 *   user's `listener_totals`
 * - `audiobooks`: catalog books that are not hidden
 * - `donors`: distinct emails across all donations
 *
 * It never writes `listeners`: the listen-time triggers add to that as people reach the
 * minimum, and the monthly check corrects it. See docs/listening-stats.md.
 */
export async function handleRefreshPublicStats(): Promise<void> {
  const firestore = admin.firestore();
  const books = firestore.collection("books");
  const totals = firestore.collection(LISTENER_TOTALS_COLLECTION);
  // One field per query: summing two fields in one query needs a composite index.
  const [bookTotal, podcastTotal, allBooks, hiddenBooks, donors] = await Promise.all([
    totals.aggregate({ seconds: AggregateField.sum("bookSeconds") }).get(),
    totals.aggregate({ seconds: AggregateField.sum("podcastSeconds") }).get(),
    books.count().get(),
    // Counted and subtracted, because a book that was never hidden may not have the field at all.
    books.where("is_book_hidden", "==", true).count().get(),
    countDonors(),
  ]);
  const bookSeconds = Number(bookTotal.data().seconds) || 0;
  const podcastSeconds = Number(podcastTotal.data().seconds) || 0;
  const stats = {
    hoursListened: wholeHours(bookSeconds + podcastSeconds),
    bookHoursListened: wholeHours(bookSeconds),
    podcastHoursListened: wholeHours(podcastSeconds),
    audiobooks: Math.max(0, allBooks.data().count - hiddenBooks.data().count),
    donors,
  };
  await firestore.doc(PUBLIC_STATS_PATH).set({ ...stats, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  functions.logger.info("public stats refreshed", stats);
}

/** Distinct donor emails. Only the email field is fetched, a page at a time. */
async function countDonors(): Promise<number> {
  const emails = new Set<string>();
  const collection = admin.firestore().collection(DONATIONS_COLLECTION);
  let last: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  for (;;) {
    let query = collection.orderBy("__name__").select("email").limit(DONATIONS_PAGE_SIZE);
    if (last) {
      query = query.startAfter(last);
    }
    const snapshot = await query.get();
    for (const doc of snapshot.docs) {
      const email = String(doc.get("email") ?? "").trim().toLowerCase();
      if (email !== "") {
        emails.add(email);
      }
    }
    if (snapshot.size < DONATIONS_PAGE_SIZE) {
      return emails.size;
    }
    last = snapshot.docs[snapshot.docs.length - 1];
  }
}

/**
 * Counts every user whose total has reached the minimum and corrects `listeners` in
 * `public_stats/site` if the running count kept by the triggers has drifted from it.
 *
 * A listener who crosses the minimum between the count and the write is off by one until the
 * next check; the triggers keep adding from whatever value is stored.
 */
export async function handleCheckPublicListeners(): Promise<void> {
  const firestore = admin.firestore();
  const statsRef = firestore.doc(PUBLIC_STATS_PATH);
  const [counted, stats] = await Promise.all([
    firestore.collection(LISTENER_TOTALS_COLLECTION).where("isListener", "==", true).count().get(),
    statsRef.get(),
  ]);
  const actual = counted.data().count;
  const stored = Number(stats.get("listeners")) || 0;
  if (actual !== stored) {
    functions.logger.warn(`public listeners drifted: stored ${stored}, counted ${actual}; corrected`, { stored, actual });
  } else {
    functions.logger.info(`public listeners match the count: ${actual}`);
  }
  await statsRef.set(
    { ...(actual !== stored ? { listeners: actual } : {}), listenersCheckedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
}
