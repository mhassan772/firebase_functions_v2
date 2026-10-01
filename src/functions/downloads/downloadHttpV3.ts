import * as functions from "firebase-functions";
import { REGION } from "../../config/constants";
import { handleDownloadUrls, respondWithRecordingUrls } from "../../handlers/recordingUrlHandlers";

export const downloadHttpV3 = functions.region(REGION).https.onRequest(
  (request, response) => respondWithRecordingUrls(request, response, "DownloadUrls", handleDownloadUrls)
);
