import { DocumentData, Query, QueryDocumentSnapshot, Timestamp } from "firebase-admin/firestore";
import { admin } from "../config/admin";

/** Firestore's limit on writes in one batch. */
export const BATCH_WRITE_LIMIT = 500;

/** Deletes records older than `cutoff` in batches, so any backlog size fits Firestore's limits. */
export async function deleteRecordsBefore(collection: string, cutoff: Date): Promise<number> {
  const firestore = admin.firestore();
  const query = firestore
    .collection(collection)
    .where("timestamp", "<", Timestamp.fromDate(cutoff))
    .orderBy("timestamp")
    .select();
  let deleted = 0;
  // Each page is deleted before the next is read, so paging restarts from the front.
  for (;;) {
    const snapshot = await query.limit(BATCH_WRITE_LIMIT).get();
    if (snapshot.empty) {
      return deleted;
    }
    const batch = firestore.batch();
    snapshot.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    deleted += snapshot.size;
    if (snapshot.size < BATCH_WRITE_LIMIT) {
      return deleted;
    }
  }
}

export async function forEachPage(
  query: Query<DocumentData>,
  pageSize: number,
  visit: (docs: QueryDocumentSnapshot<DocumentData>[]) => void | Promise<void>,
): Promise<void> {
  let last: QueryDocumentSnapshot<DocumentData> | undefined;
  for (;;) {
    const page = last ? query.startAfter(last) : query;
    const snapshot = await page.limit(pageSize).get();
    await visit(snapshot.docs);
    if (snapshot.size < pageSize) {
      return;
    }
    last = snapshot.docs[snapshot.docs.length - 1];
  }
}
