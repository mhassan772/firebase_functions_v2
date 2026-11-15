import * as functions from "firebase-functions";
import { REGION, STRIPE_WEB_SECRETS } from "../../config/constants";
import { handleDeleteAccount } from "../../handlers/accountDeletionHandlers";
import { AUTH_EMAIL_FUNCTION_SECRETS } from "../authEmails/deps";
import { accountDeletionDeps } from "./accountDeletionDeps";

/** Deletes the signed-in account and its data. See docs/account_deletion.md. */
export const deleteAccount = functions
  .region(REGION)
  .runWith({
    secrets: [...AUTH_EMAIL_FUNCTION_SECRETS, STRIPE_WEB_SECRETS.secretKey],
    timeoutSeconds: 540,
    memory: "512MB",
  })
  .https.onCall((data, context) => handleDeleteAccount(data, context, accountDeletionDeps()));
