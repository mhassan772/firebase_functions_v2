import * as functions from "firebase-functions";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
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
import {
  LISTENER_TOTALS_COLLECTION,
  ListenerTotals,
  PODCAST_LISTENERS_COLLECTION,
  PUBLIC_STATS_PATH,
  grownTotals,
  nextPodcastLine,
  podcastListenerDocId,
  secondsByPodcast,
  totalsFromSession,
} from "./listenStatsHandlers";
import { getSettings } from "./recordingUrlHandlers";

type Change = functions.Change<functions.firestore.DocumentSnapshot>;

/** How long an instance reuses the settings it read; they change rarely. */
const SETTINGS_TTL_MS = 10 * 60 * 1000;
/** Lines updated in one transaction, so a first sync of a long history stays well inside its limits. */
const LINES_PER_TRANSACTION = 100;

let cachedMinSeconds: { seconds: number; readAt: number } | undefined;

/** A book or podcast whose listening grew in one write. */
type GrownContent = GrownBook & { kind: "book" | "podcast" };

/**
 * Records the listening that grew in a session document write:
 * - raises the `book_listeners` line of every book that grew (the popular books chart reads these)
 * - raises the `podcast_listeners` line of every podcast that grew
 * - adds the growth to the user's `listener_totals`, and adds them to the public listeners count
 *   the first time their total reaches the minimum
 *
 * The before and after data come with the event, so a push that adds nothing reads nothing.
 * See docs/book-chart.md and docs/listening-stats.md.
 */
export async function handleBookListenTimeChange(change: Change, uid: string, collection: string): Promise<void> {
  const before = change.before.data();
  const after = change.after.data();
  const grown: GrownContent[] = [
    ...grownBooks(secondsByBook(before), secondsByBook(after)).map((book) => ({ ...book, kind: "book" as const })),
    ...grownBooks(secondsByPodcast(before), secondsByPodcast(after)).map((podcast) => ({ ...podcast, kind: "podcast" as const })),
  ];
  if (grown.length === 0) {
    return;
  }
  const minListenSeconds = await minSeconds();
  const now = new Date();
  let written = 0;
  let totalsSeeded = false;
  // One transaction after another: they all update the same totals document.
  for (let i = 0; i < grown.length; i += LINES_PER_TRANSACTION) {
    const result = await applyGrowth(uid, grown.slice(i, i + LINES_PER_TRANSACTION), after, now, minListenSeconds, totalsSeeded);
    written += result.written;
    totalsSeeded = totalsSeeded || result.totalsSeeded;
  }
  functions.logger.info(`listen time: ${written} of ${grown.length} grown line(s) written`, { uid, collection });
}

/**
 * Writes the lines that grew and the user's totals together, so the totals always move by
 * exactly what the lines moved by, however often the event is delivered.
 *
 * A user with no lifetime totals yet is seeded from the whole session document instead, because their
 * book lines already hold the listening from before totals existed. `totalsSeeded` says an
 * earlier transaction of the same event did that, so this one must not add its growth again.
 */
function applyGrowth(
  uid: string,
  grown: GrownContent[],
  session: unknown,
  now: Date,
  minListenSeconds: number,
  totalsSeeded: boolean,
): Promise<{ written: number; totalsSeeded: boolean }> {
  const firestore = admin.firestore();
  const totalsRef = firestore.collection(LISTENER_TOTALS_COLLECTION).doc(uid);
  const lineRefs = grown.map((content) =>
    content.kind === "book"
      ? firestore.collection(BOOK_LISTENERS_COLLECTION).doc(bookListenerDocId(uid, content.bookGuid))
      : firestore.collection(PODCAST_LISTENERS_COLLECTION).doc(podcastListenerDocId(uid, content.bookGuid)),
  );
  return firestore.runTransaction(async (transaction) => {
    const [totalsSnapshot, ...lineSnapshots] = await transaction.getAll(totalsRef, ...lineRefs);
    const growth = { bookSeconds: 0, podcastSeconds: 0, lastListenAt: null as Date | null };
    let written = 0;
    grown.forEach((content, i) => {
      const stored = lineSnapshots[i].exists ? lineSnapshots[i].data() : undefined;
      const previous = Number.isFinite(Number(stored?.seconds)) ? Number(stored?.seconds) : 0;
      let line: { seconds: number; updatedAt: Date | null } | null;
      if (content.kind === "book") {
        line = nextListenerLine(stored, uid, content, now, minListenSeconds);
        growth.bookSeconds += line ? line.seconds - previous : 0;
      } else {
        line = nextPodcastLine(
          { seconds: stored?.seconds, updatedAt: toDate(stored?.updatedAt) },
          uid,
          { podcastId: content.bookGuid, seconds: content.seconds, lastListenAt: content.lastListenAt },
          now,
        );
        growth.podcastSeconds += line ? line.seconds - previous : 0;
      }
      if (!line) {
        return;
      }
      const { updatedAt, ...fields } = line;
      transaction.set(lineRefs[i], { ...fields, updatedAt: updatedAt ? Timestamp.fromDate(updatedAt) : null }, { merge: true });
      if (updatedAt && (!growth.lastListenAt || updatedAt > growth.lastListenAt)) {
        growth.lastListenAt = updatedAt;
      }
      written++;
    });

    let totals: (ListenerTotals & { becameListener: boolean }) | null = null;
    let seeded = false;
    // No lifetime totals yet: the community goal trigger can create the document first, with only `months`.
    if (totalsSnapshot.get("totalSeconds") === undefined && !totalsSeeded) {
      const fromSession = totalsFromSession(uid, session, minListenSeconds);
      const lastListenAt = fromSession.lastListenAt && fromSession.lastListenAt < now ? fromSession.lastListenAt : now;
      totals = { ...fromSession, lastListenAt, becameListener: fromSession.isListener };
      seeded = true;
    } else if (!totalsSeeded && growth.bookSeconds + growth.podcastSeconds > 0) {
      const stored = totalsSnapshot.data() ?? {};
      totals = grownTotals({ ...stored, lastListenAt: toDate(stored.lastListenAt) }, uid, growth, minListenSeconds);
    }
    if (totals) {
      const { becameListener, lastListenAt, ...fields } = totals;
      transaction.set(totalsRef, { ...fields, lastListenAt: lastListenAt ? Timestamp.fromDate(lastListenAt) : null }, { merge: true });
      if (becameListener) {
        // Once per user, ever: the write that takes them to the minimum.
        transaction.set(firestore.doc(PUBLIC_STATS_PATH), { listeners: FieldValue.increment(1) }, { merge: true });
      }
    }
    return { written, totalsSeeded: seeded };
  });
}

function toDate(value: unknown): Date | null {
  return value instanceof Timestamp ? value.toDate() : value instanceof Date ? value : null;
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
