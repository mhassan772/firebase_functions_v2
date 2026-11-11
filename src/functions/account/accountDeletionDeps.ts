import { admin } from "../../config/admin";
import { STORAGE_BUCKET } from "../../config/constants";
import { AccountDeletionDeps } from "../../handlers/accountDeletionHandlers";
import { bucketPurgeStorage, PurgeBucket } from "../../services/accountDeletion/purge";
import { sesMailer } from "../../services/email/sesMailer";

let deps: AccountDeletionDeps | undefined;

/** The live Auth, SES, Firestore and Storage, created on first use per instance. */
export function accountDeletionDeps(): AccountDeletionDeps {
  deps ??= {
    auth: admin.auth(),
    mailer: sesMailer,
    purge: {
      firestore: admin.firestore(),
      storage: bucketPurgeStorage(admin.storage().bucket(STORAGE_BUCKET) as unknown as PurgeBucket),
      now: Date.now,
      // Stage D supplies the web subscription cancel; until then there is nothing to cancel.
      cancelWebSubscription: async () => undefined,
    },
  };
  return deps;
}
