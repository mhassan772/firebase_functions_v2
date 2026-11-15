import { admin } from "../../config/admin";
import { STORAGE_BUCKET } from "../../config/constants";
import { AccountDeletionDeps } from "../../handlers/accountDeletionHandlers";
import { bucketPurgeStorage, PurgeBucket } from "../../services/accountDeletion/purge";
import { sesMailer } from "../../services/email/sesMailer";
import { deleteWebCustomer } from "../../services/webSubscriptions/accountDeletion";
import { webGatewayFromEnv } from "../webSubscriptions/deps";

let deps: AccountDeletionDeps | undefined;

/** The live Auth, SES, Firestore, Storage and Stripe, created on first use per instance. */
export function accountDeletionDeps(): AccountDeletionDeps {
  deps ??= {
    auth: admin.auth(),
    mailer: sesMailer,
    purge: {
      firestore: admin.firestore(),
      storage: bucketPurgeStorage(admin.storage().bucket(STORAGE_BUCKET) as unknown as PurgeBucket),
      now: Date.now,
      cancelWebSubscription: (uid) =>
        deleteWebCustomer(uid, { firestore: admin.firestore(), gateway: webGatewayFromEnv }),
    },
  };
  return deps;
}
