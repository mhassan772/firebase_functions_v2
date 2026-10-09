import * as functions from "firebase-functions";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { admin } from "../config/admin";
import { BATCH_WRITE_LIMIT, forEachPage } from "./auditPaging";
import {
  BOOK_LISTENERS_COLLECTION,
  ListenerRecord,
  RankedBook,
  rankBooks,
  resolvePopularBooksSettings,
} from "./bookListenHandlers";
import { getSettings } from "./recordingUrlHandlers";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Lines read per page while ranking; they are small. */
const LINE_PAGE_SIZE = 5000;
/** Lines waiting to be added to their books, read per pass. */
const PENDING_PAGE_SIZE = 1000;
/** Books checked against the catalog per read. */
const BOOK_LOOKUP_SIZE = 100;

/**
 * Adds listeners not yet counted to each book's `listeners_count`, then ranks books by people
 * who listened in the window and stores the chart.
 */
export async function handleMostPopularBooks(): Promise<void> {
  const settings = resolvePopularBooksSettings(await getSettings());
  const runStart = new Date();
  const inCatalog = catalogLookup();

  const added = await addNewListenersToBooks(inCatalog);

  const windowStart = new Date(runStart.getTime() - settings.windowDays * DAY_MS);
  const ranking = rankBooks(await readLinesSince(windowStart));
  const chart = await keepCatalogBooks(ranking, settings.listLength, inCatalog);
  const saved = chart.length >= settings.minChartSize;
  if (saved) {
    await admin.firestore().collection("popular_books_v2").doc("popular_books").set({
      popular_books: chart,
      date_added: Timestamp.now(),
      date_updated: Timestamp.now(),
    });
  } else {
    functions.logger.warn(
      `popular books: only ${chart.length} book(s) ranked, below ${settings.minChartSize}; kept the previous chart`,
    );
  }
  functions.logger.info("popular books rebuilt", {
    ...added,
    windowDays: settings.windowDays,
    rankedBooks: ranking.length,
    chart: chart.length,
    saved,
  });
}

/**
 * Adds each qualifying line not counted yet to its book once.
 *
 * The increment and the flags on the lines it counts are one batch, so a crash or a repeated run
 * never counts anyone twice. Books outside the catalog (converted podcasts, file books) get their
 * lines flagged without an increment, so they are not read again.
 */
async function addNewListenersToBooks(
  inCatalog: (guids: string[]) => Promise<Set<string>>,
): Promise<{ newListeners: number; booksIncremented: number; outsideCatalog: number }> {
  const firestore = admin.firestore();
  const query = firestore
    .collection(BOOK_LISTENERS_COLLECTION)
    .where("qualifies", "==", true)
    .where("addedToBook", "==", false)
    .select("book_guid");
  const totals = { newListeners: 0, booksIncremented: 0, outsideCatalog: 0 };
  // Each pass flags what it read, so the next pass starts from the front again.
  for (;;) {
    const snapshot = await query.limit(PENDING_PAGE_SIZE).get();
    if (snapshot.empty) {
      return totals;
    }
    const byBook = new Map<string, FirebaseFirestore.DocumentReference[]>();
    for (const doc of snapshot.docs) {
      const guid = String(doc.get("book_guid") ?? "");
      byBook.set(guid, [...(byBook.get(guid) ?? []), doc.ref]);
    }
    const catalog = await inCatalog([...byBook.keys()].filter((guid) => guid !== ""));

    let batch = firestore.batch();
    let operations = 0;
    const commits: Promise<unknown>[] = [];
    for (const [guid, refs] of byBook) {
      const counted = catalog.has(guid);
      // A batch holds the increment and the lines it counts, so a long group is split.
      for (let i = 0; i < refs.length; i += BATCH_WRITE_LIMIT - 1) {
        const chunk = refs.slice(i, i + BATCH_WRITE_LIMIT - 1);
        if (operations + chunk.length + 1 > BATCH_WRITE_LIMIT) {
          commits.push(batch.commit());
          batch = firestore.batch();
          operations = 0;
        }
        if (counted) {
          batch.update(firestore.collection("books").doc(guid), { listeners_count: FieldValue.increment(chunk.length) });
          operations++;
        }
        chunk.forEach((ref) => batch.update(ref, { addedToBook: true }));
        operations += chunk.length;
      }
      if (counted) {
        totals.newListeners += refs.length;
        totals.booksIncremented++;
      } else {
        totals.outsideCatalog += refs.length;
      }
    }
    if (operations > 0) {
      commits.push(batch.commit());
    }
    await Promise.all(commits);
    if (snapshot.size < PENDING_PAGE_SIZE) {
      return totals;
    }
  }
}

async function readLinesSince(since: Date): Promise<ListenerRecord[]> {
  const query = admin
    .firestore()
    .collection(BOOK_LISTENERS_COLLECTION)
    .where("updatedAt", ">", Timestamp.fromDate(since))
    .orderBy("updatedAt")
    // `updatedAt` must be selected: paging continues after the last document by its orderBy
    // field, and a cursor built from a document without it fails.
    .select("book_guid", "qualifies", "updatedAt");
  const records: ListenerRecord[] = [];
  await forEachPage(query, LINE_PAGE_SIZE, (docs) => {
    for (const doc of docs) {
      records.push(doc.data());
    }
  });
  return records;
}

/** The ranking without books missing from the catalog, cut to `limit`. */
async function keepCatalogBooks(
  ranking: RankedBook[],
  limit: number,
  inCatalog: (guids: string[]) => Promise<Set<string>>,
): Promise<RankedBook[]> {
  const chart: RankedBook[] = [];
  for (let i = 0; i < ranking.length && chart.length < limit; i += BOOK_LOOKUP_SIZE) {
    const page = ranking.slice(i, i + BOOK_LOOKUP_SIZE);
    const catalog = await inCatalog(page.map((entry) => entry.book_guid));
    for (const entry of page) {
      if (catalog.has(entry.book_guid) && chart.length < limit) {
        chart.push(entry);
      }
    }
  }
  return chart;
}

/**
 * Which guids have a `books` document, remembered for the run so the two steps share reads.
 *
 * Only the name is fetched; the rest of a book document is not needed.
 */
function catalogLookup(): (guids: string[]) => Promise<Set<string>> {
  const known = new Map<string, boolean>();
  return async (guids) => {
    const firestore = admin.firestore();
    const unknown = [...new Set(guids)].filter((guid) => !known.has(guid));
    // An id Firestore cannot address is never a catalog book, and reading it would throw.
    for (const guid of unknown.filter((guid) => !isDocumentId(guid))) {
      known.set(guid, false);
    }
    const readable = unknown.filter(isDocumentId);
    for (let i = 0; i < readable.length; i += BOOK_LOOKUP_SIZE) {
      const page = readable.slice(i, i + BOOK_LOOKUP_SIZE);
      const docs = await firestore.getAll(...page.map((guid) => firestore.collection("books").doc(guid)), {
        fieldMask: ["name"],
      });
      docs.forEach((doc, j) => known.set(page[j], doc.exists));
    }
    return new Set(guids.filter((guid) => known.get(guid) === true));
  };
}

function isDocumentId(id: string): boolean {
  return id !== "" && id !== "." && id !== ".." && !id.includes("/") && !/^__.*__$/.test(id);
}
