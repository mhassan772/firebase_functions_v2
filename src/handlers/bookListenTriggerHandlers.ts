import * as functions from "firebase-functions";
import { Timestamp } from "firebase-admin/firestore";
import { admin } from "../config/admin";
import {
  BOOK_LISTENERS_COLLECTION,
  GrownBook,
  bookListenerDocId,
  grownBooks,
  nextListenerLine,
  resolvePopularBooksSettings,
  secondsByBook,
} from "./bookListenHandlers";
import { getSettings } from "./recordingUrlHandlers";

type Change = functions.Change<functions.firestore.DocumentSnapshot>;

/** How long an instance reuses the settings it read; they change rarely. */
const SETTINGS_TTL_MS = 10 * 60 * 1000;
/** Lines updated at once, so a first sync of a long history does not open hundreds of transactions together. */
const CONCURRENT_UPDATES = 10;

let cachedMinSeconds: { seconds: number; readAt: number } | undefined;

/**
 * Raises the `book_listeners` line of every book whose listening grew in a session document
 * write.
 *
 * The before and after data come with the event, so a push that adds nothing reads nothing.
 */
export async function handleBookListenTimeChange(change: Change, uid: string, collection: string): Promise<void> {
  const grown = grownBooks(secondsByBook(change.before.data()), secondsByBook(change.after.data()));
  if (grown.length === 0) {
    return;
  }
  const minListenSeconds = await minSeconds();
  const now = new Date();
  let written = 0;
  for (let i = 0; i < grown.length; i += CONCURRENT_UPDATES) {
    const results = await Promise.all(
      grown.slice(i, i + CONCURRENT_UPDATES).map((book) => updateLine(uid, book, now, minListenSeconds)),
    );
    written += results.filter(Boolean).length;
  }
  functions.logger.info(`book listen time: ${written} of ${grown.length} grown book(s) written`, { uid, collection });
}

/** Returns whether the line changed; another write may already hold a higher total. */
function updateLine(uid: string, book: GrownBook, now: Date, minListenSeconds: number): Promise<boolean> {
  const firestore = admin.firestore();
  const ref = firestore.collection(BOOK_LISTENERS_COLLECTION).doc(bookListenerDocId(uid, book.bookGuid));
  return firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const line = nextListenerLine(snapshot.exists ? snapshot.data() : undefined, uid, book, now, minListenSeconds);
    if (!line) {
      return false;
    }
    const { updatedAt, ...fields } = line;
    transaction.set(ref, { ...fields, updatedAt: updatedAt ? Timestamp.fromDate(updatedAt) : null }, { merge: true });
    return true;
  });
}

async function minSeconds(): Promise<number> {
  if (!cachedMinSeconds || Date.now() - cachedMinSeconds.readAt > SETTINGS_TTL_MS) {
    cachedMinSeconds = {
      seconds: resolvePopularBooksSettings(await getSettings()).minListenSeconds,
      readAt: Date.now(),
    };
  }
  return cachedMinSeconds.seconds;
}
