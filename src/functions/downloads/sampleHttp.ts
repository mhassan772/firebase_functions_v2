import * as functions from "firebase-functions";
import { REGION } from "../../config/constants";
import { handleSampleUrl, respondWithRecordingUrls } from "../../handlers/recordingUrlHandlers";

export const sampleHttp = functions.region(REGION).https.onRequest(
  (request, response) => respondWithRecordingUrls(request, response, "Sample URL", handleSampleUrl)
);
