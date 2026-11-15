import * as functions from "firebase-functions";
import { REGION, STRIPE_WEB_SECRETS } from "../../config/constants";
import { handleAccountDeleted } from "../../handlers/accountDeletionHandlers";
import { accountDeletionDeps } from "./accountDeletionDeps";

/**
 * Purges an account's data whenever its Auth user is deleted, by any route. No retry: a failed
 * run leaves the tombstone open for `sweepDeletedAccounts`. See docs/account_deletion.md.
 */
export const accountDeletedCleanup = functions
  .region(REGION)
  // A bulk deletion, or Firebase's automatic clean-up of anonymous users, must not fan out into
  // hundreds of purges at once.
  .runWith({ secrets: [STRIPE_WEB_SECRETS.secretKey], timeoutSeconds: 540, memory: "512MB", maxInstances: 5 })
  .auth.user()
  .onDelete((user) => handleAccountDeleted(
      { uid: user.uid, email: user.email, providerData: user.providerData },
      accountDeletionDeps()
    ));
