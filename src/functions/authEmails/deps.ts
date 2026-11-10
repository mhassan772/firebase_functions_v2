import { admin } from "../../config/admin";
import { AUTH_EMAIL_SECRETS } from "../../config/constants";
import { AuthEmailDeps } from "../../handlers/authEmailHandlers";
import { firestoreAuthEmailThrottle } from "../../services/authEmailThrottle";
import { sesMailer } from "../../services/email/sesMailer";

/** Secrets every account-email callable is deployed with. */
export const AUTH_EMAIL_FUNCTION_SECRETS = [AUTH_EMAIL_SECRETS.sesAccessKeyId, AUTH_EMAIL_SECRETS.sesSecretAccessKey];

let deps: AuthEmailDeps | undefined;

/** The live Auth, SES and Firestore throttle, created on first use per instance. */
export function authEmailDeps(): AuthEmailDeps {
  deps ??= {
    auth: admin.auth(),
    mailer: sesMailer,
    throttle: firestoreAuthEmailThrottle(() => admin.firestore()),
    now: Date.now,
  };
  return deps;
}
