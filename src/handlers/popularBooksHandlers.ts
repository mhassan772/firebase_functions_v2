import { DocumentData, DocumentReference, Timestamp } from "firebase-admin/firestore";
import { admin } from "../config/admin";
import { AppSettings, Book, BookDownloadRecord } from "../types/recordings";
import { getSettings } from "./recordingUrlHandlers";

// Ported from the deployed source of mostPopularBooksV3. The lodash and
// date-fns helpers it used are replaced by the native equivalents below.

/**
 * Ranks books by recent downloads, stores the ranking, then deletes old audit records.
 */
export async function handleMostPopularBooks(): Promise<void> {
  const settings = await getSettings();
  const popularBooks = await getPopularBooks(settings);
  await savePopularBooks(popularBooks);
  await deleteBookAuditRecords(settings.numberOfDaysToDeleteMostPopularBooksAfter);
}

async function getPopularBooks(settings: AppSettings): Promise<BookDownloadRecord[]> {
  const querySnapshot = await admin
    .firestore()
    .collection("books_download_audit")
    .where("timestamp", ">", daysAgo(settings.mostPopularBooksDays))
    .get();

  const downloadRecords = querySnapshot.docs.map((doc) => doc.data());
  const recordsWithCount = await groupDownloadsWithCount(downloadRecords);
  return takeFirst(recordsWithCount, settings.numberOfMostPopularBooksToReturn);
}

async function savePopularBooks(records: BookDownloadRecord[]): Promise<void> {
  const popularBooks = records.map((record) => ({
    book_guid: record.book_guid,
    num_downloads: record.num_downloads,
  }));
  await admin.firestore().collection("popular_books_v2").doc("popular_books").set({
    popular_books: popularBooks,
    date_added: Timestamp.now(),
    date_updated: Timestamp.now(),
  });
}

async function deleteBookAuditRecords(limitDays: number): Promise<void> {
  const querySnapshot = await admin
    .firestore()
    .collection("books_download_audit")
    .where("timestamp", "<", daysAgo(limitDays))
    .get();

  await batchDeleteRecords(querySnapshot.docs.map((doc) => doc.ref));
}

async function batchDeleteRecords(docs: DocumentReference[]): Promise<void> {
  const batch = admin.firestore().batch();
  docs.forEach((doc) => batch.delete(doc));
  await batch.commit();
}

/**
 * Groups audit records by book, skips books that no longer exist, and sorts by download count.
 */
async function groupDownloadsWithCount(records: DocumentData[]): Promise<BookDownloadRecord[]> {
  const countByBook = new Map<string, number>();
  for (const record of records) {
    const bookGuid = String(record.book_guid);
    countByBook.set(bookGuid, (countByBook.get(bookGuid) ?? 0) + 1);
  }

  const downloadRecords: BookDownloadRecord[] = [];
  for (const [bookGuid, count] of countByBook) {
    const book = (await admin.firestore().collection("books").doc(bookGuid).get()).data() as Book | undefined;
    if (!book) {
      continue;
    }
    downloadRecords.push({
      book_guid: bookGuid,
      author_details: {
        author_guid: book.author_details.author_guid,
        author_name: book.author_details.author_name,
      },
      book_id_reference: book.book_id_reference,
      category_details: {
        category_guid: book.category_details.category_guid,
        category_name: book.category_details.category_name,
      },
      date_added: book.date_added,
      description: book.description,
      goodreads_url: book.goodreads_url,
      is_book_hidden: book.is_book_hidden,
      name: book.name,
      narrators: book.narrators,
      num_downloads: count,
      num_votes_for_recording: book.num_votes_for_recording,
      picture_url: {
        highres_url: book.picture_url.highres_url,
        thumbnail_url: book.picture_url.thumbnail_url,
      },
      publisher: book.publisher,
      tags_list: book.tags_list,
      verification_status: book.verification_status,
    });
  }
  // Array.prototype.sort is stable, so ties keep first-seen order, as lodash orderBy did.
  return downloadRecords.sort((a, b) => b.num_downloads - a.num_downloads);
}

/** Same as date-fns `subDays(new Date(), days)`. */
function daysAgo(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
}

/** Same as lodash `take`: a missing count means 1. */
function takeFirst<T>(items: T[], count: number | undefined): T[] {
  const n = count === undefined ? 1 : Math.trunc(count);
  return n < 1 ? [] : items.slice(0, n);
}
