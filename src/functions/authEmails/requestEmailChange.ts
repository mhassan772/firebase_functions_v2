import * as functions from "firebase-functions";
import { REGION } from "../../config/constants";
import { handleRequestEmailChange } from "../../handlers/authEmailHandlers";
import { AUTH_EMAIL_FUNCTION_SECRETS, authEmailDeps } from "./deps";

export const requestEmailChange = functions
  .region(REGION)
  .runWith({ secrets: AUTH_EMAIL_FUNCTION_SECRETS, timeoutSeconds: 30 })
  .https.onCall((data, context) => handleRequestEmailChange(data, context, authEmailDeps()));
