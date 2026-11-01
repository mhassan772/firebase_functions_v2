import { admin } from "../config/admin";
import { GetUrlsRequest, GetUrlsResponse, Recording, Settings } from "../types";
import {
  allowsUnverifiedEmail,
  BookSource,
  buildGroupedResponse,
  buildSuccessResponse,
  emailNotVerifiedError,
  notFoundUserError,
} from "../shared/getUrlsCore";

export async function handleGetUrls(
  request: GetUrlsRequest,
  authId: string,
  publicDomain?: string
): Promise<GetUrlsResponse> {
  await verifyUserEmail(authId, request);

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
  return buildSuccessResponse(buildGroupedResponse(request, sources, publicDomain));
}

async function verifyUserEmail(authId: string, request: GetUrlsRequest): Promise<void> {
  try {
    const user = await admin.auth().getUser(authId);
    // Listening comes before the account is in force; only a download waits on the verified email.
    if (!user.emailVerified && !allowsUnverifiedEmail(request.books)) {
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

export async function getSettings(): Promise<Settings> {
  const docSnapshot = await admin
    .firestore()
    .collection("settings")
    .doc("mantooqAppSettings")
    .get();
  return (docSnapshot.data() as Settings) || {};
}
