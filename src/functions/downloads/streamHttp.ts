import * as functions from "firebase-functions";
import { REGION } from "../../config/constants";
import { handleStreamUrls, respondWithRecordingUrls } from "../../handlers/recordingUrlHandlers";

export const streamHttp = functions.region(REGION).https.onRequest(
  (request, response) => respondWithRecordingUrls(request, response, "DownloadUrls", handleStreamUrls)
);
