import { Timestamp } from "firebase-admin/firestore";
import { admin } from "../config/admin";
import { GetUrlsRequest, GetUrlsResponse, Book, Recording, Settings, BookItem } from "../types";
import {
  BookSource,
  buildAuditFields,
  buildGroupedResponse,
  buildSuccessResponse,
  emailNotVerifiedError,
  getCounterField,
  notFoundUserError,
} from "../shared/getUrlsCore";

export async function handleGetUrls(
  request: GetUrlsRequest,
  authId: string
): Promise<GetUrlsResponse> {
  await verifyUserEmail(authId);

  const bookGuids = request.books.map((b) => b.bookGuid);

  const [books, recordingSnapshots] = await Promise.all([
    getBooksInBatch(bookGuids),
    getRecordingsInBatch(bookGuids),
  ]);

  const sources: BookSource[] = books.map((bookDoc, i) => {
    const recordingDoc = recordingSnapshots[i].docs[0];
    return {
      bookExists: bookDoc.exists,
      recordings: recordingDoc?.exists
        ? (recordingDoc.data()?.recordings as Record<string, Recording> | undefined)
        : null,
    };
  });
  const result = buildGroupedResponse(request, sources);

  await Promise.all([
    incrementCountersBatch(request.books),
    addDownloadAuditBatch(books, request.books, authId, request.deviceId),
  ]);

  return buildSuccessResponse(result);
}

async function verifyUserEmail(authId: string): Promise<void> {
  try {
    const user = await admin.auth().getUser(authId);
    if (!user.emailVerified) {
      throw emailNotVerifiedError();
    }
  } catch (error: any) {
    if (error.code === "auth/user-not-found") {
      throw notFoundUserError();
    }
    throw error;
  }
}

async function getBooksInBatch(
  guids: string[]
): Promise<FirebaseFirestore.DocumentSnapshot[]> {
  if (guids.length === 0) return [];

  const bookRefs = guids.map((guid) =>
    admin.firestore().collection("books").doc(guid)
  );
  return admin.firestore().getAll(...bookRefs);
}

async function getRecordingsInBatch(
  bookGuids: string[]
): Promise<FirebaseFirestore.QuerySnapshot[]> {
  if (bookGuids.length === 0) return [];

  const queries = bookGuids.map((bookGuid) =>
    admin
      .firestore()
      .collection("book_recordings")
      .where("book_guid", "==", bookGuid)
      .get()
  );
  return Promise.all(queries);
}

async function incrementCountersBatch(bookItems: BookItem[]): Promise<void> {
  if (bookItems.length === 0) return;

  await admin.firestore().runTransaction(async (transaction) => {
    const bookRefs = bookItems.map((item) =>
      admin.firestore().collection("books").doc(item.bookGuid)
    );
    const docs = await transaction.getAll(...bookRefs);

    docs.forEach((doc, i) => {
      if (doc.exists) {
        const reason = bookItems[i].reason;
        const counterField = getCounterField(reason);
        const currentCount = doc.data()?.[counterField] ?? 0;
        transaction.update(bookRefs[i], { [counterField]: currentCount + 1 });
      }
    });
  });
}

async function addDownloadAuditBatch(
  books: FirebaseFirestore.DocumentSnapshot[],
  bookItems: BookItem[],
  authId: string,
  deviceId?: string
): Promise<void> {
  if (books.length === 0) return;

  const batch = admin.firestore().batch();
  const timestamp = Timestamp.now();

  books.forEach((bookDoc, i) => {
    if (!bookDoc.exists) return;

    const bookData = bookDoc.data() as Book;
    const reason = bookItems[i].reason;
    const auditRef = admin.firestore().collection("books_download_audit").doc();

    batch.set(auditRef, {
      ...buildAuditFields(
        bookDoc.id,
        bookData.name,
        bookData.book_id_reference,
        reason,
        authId,
        deviceId
      ),
      timestamp,
    });
  });

  await batch.commit();
}

export async function getSettings(): Promise<Settings> {
  const docSnapshot = await admin
    .firestore()
    .collection("settings")
    .doc("mantooqAppSettings")
    .get();
  return (docSnapshot.data() as Settings) || {};
}
