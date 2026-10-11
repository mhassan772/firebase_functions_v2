import { admin } from "../config/admin";
import { SubscriptionError } from "../services/subscriptions/errors";

export const ADMIN_USERS_COLLECTION = "users_adminv2";

/** The portal roles that may change subscriptions. Managers and viewers may not. */
const SUBSCRIPTION_ADMIN_ROLES = new Set(["admin"]);

export async function adminRoleOf(uid: string): Promise<string | undefined> {
  const snapshot = await admin
    .firestore()
    .collection(ADMIN_USERS_COLLECTION)
    .doc(uid)
    .get();
  const role = snapshot.get("role");
  return typeof role === "string" ? role : undefined;
}

/** Any active portal user. Matches the check the upload endpoint has always made. */
export async function requireAdminPortalUser(uid: string): Promise<void> {
  const snapshot = await admin
    .firestore()
    .collection(ADMIN_USERS_COLLECTION)
    .doc(uid)
    .get();
  if (!snapshot.exists) {
    throw new SubscriptionError(
      "forbidden",
      "not-admin-portal-user",
      "This account is not an admin portal user."
    );
  }
}

/** A portal user whose role may grant or revoke subscriptions. */
export async function requireSubscriptionAdmin(uid: string): Promise<string> {
  const role = await adminRoleOf(uid);
  if (!role || !SUBSCRIPTION_ADMIN_ROLES.has(role)) {
    throw new SubscriptionError(
      "forbidden",
      "not-subscription-admin",
      "Only an admin may change subscriptions."
    );
  }
  return role;
}
