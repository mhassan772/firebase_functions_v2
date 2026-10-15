import * as functions from "firebase-functions";
import { REGION } from "../../config/constants";
import { handleAdminBlurCover } from "../../handlers/blurCoverHandler";

// sharp decodes the full-size original in memory before resizing, so the default 256MB is too tight for a 15 MB source.
export const adminBlurCover = functions
  .region(REGION)
  .runWith({
    timeoutSeconds: 60,
    memory: "1GB",
  })
  .https.onCall(handleAdminBlurCover);
