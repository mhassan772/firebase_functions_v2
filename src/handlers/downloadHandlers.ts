import { Timestamp } from "firebase-admin/firestore";
import { admin } from "../config/admin";
import {
  GetUrlsRequest,
  GetUrlsResponse,
  Book,
  Recording,
  BookUrlData,
  RecordingUrl,
  Quality,
  Settings,
  BookItem,
} from "../types";

const PUBLIC_DOMAIN = "https://books.good-storage.click";

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

  const result = buildGroupedResponse(books, recordingSnapshots, request);

  await Promise.all([
    incrementCountersBatch(request.books),
    addDownloadAuditBatch(books, request.books, authId, request.deviceId),
  ]);

  return {
    code: 600,
    message: "success",
    data: result,
  };
}

async function verifyUserEmail(authId: string): Promise<void> {
  try {
    const user = await admin.auth().getUser(authId);
    if (!user.emailVerified) {
      const errMessage = JSON.stringify({
        code: 608,
        message: "email-not-verified",
      });
      throw new Error(errMessage);
    }
  } catch (error: any) {
    if (error.code === "auth/user-not-found") {
      const errMessage = JSON.stringify({
        code: 602,
        message: "not-found-user",
      });
      throw new Error(errMessage);
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

function buildGroupedResponse(
  books: FirebaseFirestore.DocumentSnapshot[],
  recordingSnapshots: FirebaseFirestore.QuerySnapshot[],
  request: GetUrlsRequest
): Record<string, BookUrlData> {
  const result: Record<string, BookUrlData> = {};
  const expiresAt = getExpiryTimestamp();

  for (let i = 0; i < request.books.length; i++) {
    const bookItem = request.books[i];
    const bookDoc = books[i];
    const recordingSnapshot = recordingSnapshots[i];

    if (!bookDoc.exists) {
      const errMessage = JSON.stringify({
        code: 601,
        message: "not-found-book",
        bookGuid: bookItem.bookGuid,
      });
      throw new Error(errMessage);
    }

    const recordingDoc = recordingSnapshot.docs[0];
    if (!recordingDoc?.exists) {
      const errMessage = JSON.stringify({
        code: 605,
        message: "not-found-recordings",
        bookGuid: bookItem.bookGuid,
      });
      throw new Error(errMessage);
    }

    const recordingsData = recordingDoc.data()?.recordings;
    if (!recordingsData) {
      const errMessage = JSON.stringify({
        code: 605,
        message: "not-found-recordings",
        bookGuid: bookItem.bookGuid,
      });
      throw new Error(errMessage);
    }

    const recordings = Object.values(recordingsData) as Recording[];
    const urls = buildPublicUrls(
      recordings,
      bookItem.quality,
      request.platform
    );

    result[bookItem.bookGuid] = {
      recordings: urls,
      expiresAt,
    };
  }

  return result;
}

function buildPublicUrls(
  recordings: Recording[],
  quality: Quality,
  platform: string
): RecordingUrl[] {
  const normalizedPlatform = platform?.toLowerCase() || "android";

  return recordings.map((recording) => {
    const qualityKey = `${quality}kb_url`;
    let path = recording.url_list[qualityKey];

    if (!path) {
      const errMessage = JSON.stringify({
        code: 604,
        message: "not-found-quality",
      });
      throw new Error(errMessage);
    }

    path = (path || "").replace(/^\/+/, "");

    let url: string;
    if (normalizedPlatform === "ios") {
      url = `${PUBLIC_DOMAIN}/${path.replace("opus", "m4a")}`;
    } else {
      url = `${PUBLIC_DOMAIN}/${path}`;
    }

    return {
      name: recording.name,
      duration: recording.duration,
      ext: url.split(".").pop() || "",
      url,
    };
  });
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

function getCounterField(reason: string): string {
  switch (reason) {
    case "download":
      return "num_downloads";
    case "stream":
      return "num_streams";
    case "sample":
      return "num_samples";
    default:
      return "num_downloads";
  }
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
      book_guid: bookDoc.id,
      book_name: bookData.name,
      book_id_reference: bookData.book_id_reference || null,
      timestamp,
      user_guid: authId,
      device_id: deviceId || null,
      reason,
    });
  });

  await batch.commit();
}

function getExpiryTimestamp(): string {
  const expiresAt = new Date();
  expiresAt.setMonth(expiresAt.getMonth() + 1);
  return expiresAt.toISOString();
}

export async function getSettings(): Promise<Settings> {
  const docSnapshot = await admin
    .firestore()
    .collection("settings")
    .doc("mantooqAppSettings")
    .get();
  return (docSnapshot.data() as Settings) || {};
}
