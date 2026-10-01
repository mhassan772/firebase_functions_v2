import * as functions from "firebase-functions";
import { Response } from "express";
import { Timestamp } from "firebase-admin/firestore";
import { admin } from "../config/admin";
import { validateLegacyRequestAuthentication } from "../utils/legacyAuthentication";
import {
  AppSettings,
  Book,
  Quality,
  Recording,
  RecordingUrl,
  RecordingUrlsRequest,
  RecordingUrlsResponse,
} from "../types/recordings";

// Ported from the deployed sources of downloadHttpV3, streamHttp and sampleHttp.
// Error bodies, status codes and Firestore writes match those deployments,
// because released app versions depend on them.

const PUBLIC_DOMAIN = "https://books.good-storage.click";

type RecordingUrlsHandler = (
  body: RecordingUrlsRequest,
  uid: string,
  settings: AppSettings
) => Promise<RecordingUrlsResponse>;

/**
 * Runs the shared request flow: legacy auth, settings, handler, legacy error bodies.
 *
 * A known failure is a 400 whose body is the JSON in the HttpsError message;
 * anything else is a 500 with code 607.
 */
export async function respondWithRecordingUrls(
  request: functions.https.Request,
  response: Response,
  logLabel: string,
  handler: RecordingUrlsHandler
): Promise<void> {
  try {
    const auth = await validateLegacyRequestAuthentication(request);
    const settings = await getSettings();
    const result = await handler(request.body as RecordingUrlsRequest, auth.uid, settings);
    functions.logger.info(`${logLabel} is: ` + JSON.stringify(result));
    response.json(result).status(200);
  } catch (error) {
    if (error instanceof functions.https.HttpsError) {
      functions.logger.error(error.code, error.message, error, request.body, request.headers);
      response.status(400).send(error.message);
    } else {
      functions.logger.error(error, request.body, request.headers);
      response.status(500).send(JSON.stringify({ code: 607, message: "unexpected-error", data: error }));
    }
  }
}

/**
 * Returns every chapter URL of a book for download and records the download.
 */
export async function handleDownloadUrls(
  body: RecordingUrlsRequest,
  uid: string,
  settings: AppSettings
): Promise<RecordingUrlsResponse> {
  await ensureUserExists(uid);
  const book = await getBook(body.bookGuid);
  const { recordings } = await getRecordings(body.bookGuid, body.narratorGuid);
  await incrementCounter(body.bookGuid, "num_downloads");
  // The URLs are no longer signed, so the key is unused. The download is kept
  // because a missing key still fails the request with a 500, as deployed.
  await getCloudfrontPrivateKey(settings.storageBucketNameFirebase, settings.mp3CloudFrontSigningPrivateKeyFileName);
  const data = recordings.map((recording) => toRecordingUrl(recording, body.quality, body.platform, true));
  await addDownloadRecords(uid, body.narratorGuid, book, body.deviceId);
  return { code: 600, message: "success", data, remainingDownloads: -1, remainingHours: -1 };
}

/**
 * Returns every chapter URL of a book for streaming and counts the stream.
 */
export async function handleStreamUrls(
  body: RecordingUrlsRequest,
  uid: string
): Promise<RecordingUrlsResponse> {
  await ensureUserExists(uid);
  const { recordingId, recordings } = await getRecordings(body.bookGuid, body.narratorGuid);
  await incrementCounter(body.bookGuid, "num_streams");
  functions.logger.info(recordingId);
  const data = recordings.map((recording) => toRecordingUrl(recording, body.quality, body.platform, true));
  return { code: 600, message: "success", data };
}

/**
 * Returns the URL of a book's first chapter as a sample.
 */
export async function handleSampleUrl(
  body: RecordingUrlsRequest,
  uid: string
): Promise<RecordingUrlsResponse> {
  await ensureUserExists(uid);
  const { recordingId, recordings } = await getRecordings(body.bookGuid, body.narratorGuid);
  functions.logger.info(recordingId);
  const data = [toRecordingUrl(recordings[0], body.quality, body.platform, false)];
  return { code: 600, message: "success", data };
}

/**
 * Reads `settings/mantooqAppSettings`.
 */
export async function getSettings(): Promise<AppSettings> {
  const docSnapshot = await admin.firestore().collection("settings").doc("mantooqAppSettings").get();
  return docSnapshot.data() as AppSettings;
}

function legacyError(code: number, message: string): functions.https.HttpsError {
  const errMessage = JSON.stringify({ code, message });
  functions.logger.error(errMessage);
  return new functions.https.HttpsError("internal", errMessage);
}

/** Fails with 602 when the account does not exist. An unverified email is only logged. */
async function ensureUserExists(uid: string): Promise<void> {
  let user;
  try {
    user = await admin.auth().getUser(uid);
  } catch (error) {
    functions.logger.error(error);
    throw legacyError(602, "not-found-user");
  }
  if (!user.emailVerified) {
    functions.logger.error(JSON.stringify({ code: 608, message: "email-not-verified" }));
  }
}

async function getBook(guid: string): Promise<Book> {
  const book = (await admin.firestore().collection("books").doc(guid).get()).data();
  if (book === undefined) {
    throw legacyError(601, "not-found-book");
  }
  return { ...book, guid } as Book;
}

/**
 * Returns the chapters of the first `book_recordings` document for the book and narrator.
 */
async function getRecordings(
  bookGuid: string,
  narratorGuid: string
): Promise<{ recordingId: string; recordings: Recording[] }> {
  const querySnapshot = await admin
    .firestore()
    .collection("book_recordings")
    .where("book_guid", "==", bookGuid)
    .where("narrator_details.narrator_guid", "==", narratorGuid)
    .get();

  const docSnapshot = querySnapshot.docs[0];
  const recordings = docSnapshot?.exists ? docSnapshot.data().recordings : undefined;
  if (recordings === undefined) {
    throw legacyError(605, "not-found-recordings");
  }
  return { recordingId: docSnapshot.id, recordings: Object.values(recordings) as Recording[] };
}

// Read-then-write, not FieldValue.increment, to keep the deployed behaviour.
async function incrementCounter(bookGuid: string, field: "num_downloads" | "num_streams"): Promise<void> {
  const docRef = admin.firestore().collection("books").doc(bookGuid);
  const current = (await docRef.get()).data()?.[field] ?? 0;
  await docRef.update({ [field]: current + 1 });
}

// The deployed version also checked file.exists(), but tested the returned
// array instead of its value, so error 606 never fired.
async function getCloudfrontPrivateKey(bucketName: string, fileName: string): Promise<string> {
  const content = await admin.storage().bucket(bucketName).file(fileName).download();
  return content[0].toString();
}

/**
 * Builds the public URL of one chapter. iOS gets the m4a variant of opus files.
 */
function toRecordingUrl(recording: Recording, quality: Quality, platform: string | undefined, includeExt: boolean): RecordingUrl {
  const path = recording.url_list[`${quality}kb_url`];
  if (path == undefined) {
    throw new functions.https.HttpsError("internal", JSON.stringify({ code: 604, message: "not-found-quality" }));
  }

  const normalizedPath = path.replace(/^\/+/, "");
  const url = (platform ?? "android") == "ios"
    ? `${PUBLIC_DOMAIN}/${normalizedPath.replace("opus", "m4a")}`
    : `${PUBLIC_DOMAIN}/${normalizedPath}`;

  return includeExt
    ? { name: recording.name, duration: recording.duration, ext: url.split(".").pop(), url }
    : { name: recording.name, duration: recording.duration, url };
}

async function addDownloadRecords(uid: string, narratorGuid: string, book: Book, deviceId = ""): Promise<void> {
  const firestore = admin.firestore();
  const audit = {
    book_guid: book.guid,
    book_name: book.name,
    narrator_guid: narratorGuid,
    book_id_reference: book.book_id_reference,
    timestamp: Timestamp.now(),
    user_guid: uid,
  };

  await Promise.all([
    firestore.collection(`users/${uid}/downloaded_books`).add({
      book_guid: book.guid,
      book_name: book.name,
      book_picture_thumbnail_url: book.picture_url.thumbnail_url,
      download_status: "1",
      device_id: deviceId,
      timestamp: Timestamp.now(),
    }),
    firestore.collection("books_download_audit").add(audit),
    firestore.collection("books_download_audit_long_term").add(audit),
  ]);
}
