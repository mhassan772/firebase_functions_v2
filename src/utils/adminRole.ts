import { admin } from "../config/admin";
import { SubscriptionError } from "../services/subscriptions/errors";

export const ADMIN_USERS_COLLECTION = "users_adminv2";

/** The role that grants every other role. */
export const PORTAL_ADMIN_ROLE = "admin";

/**
 * The effective roles of a users_adminv2 document's data, by the same rule as firestore.rules:
 * a `roles` list alone decides; otherwise the single `role` string; otherwise none.
 */
export function portalRolesFromData(data: Record<string, unknown> | undefined): string[] {
  if (!data) {
    return [];
  }
  if (Array.isArray(data.roles)) {
    return data.roles.filter((role): role is string => typeof role === "string");
  }
  return typeof data.role === "string" ? [data.role] : [];
}

/** True when `roles` holds `role`, or holds admin, which implies every role. */
export function hasPortalRole(roles: readonly string[], role: string): boolean {
  return roles.includes(PORTAL_ADMIN_ROLE) || roles.includes(role);
}

/** The effective roles of a portal user; empty for a uid with no users_adminv2 document. */
export async function portalRolesOf(uid: string): Promise<string[]> {
  const snapshot = await admin
    .firestore()
    .collection(ADMIN_USERS_COLLECTION)
    .doc(uid)
    .get();
  return snapshot.exists ? portalRolesFromData(snapshot.data()) : [];
}

/** A portal user who holds `role` or admin. Returns the caller's effective roles. */
export async function requirePortalRole(uid: string, role: string): Promise<string[]> {
  const roles = await portalRolesOf(uid);
  if (!hasPortalRole(roles, role)) {
    throw new SubscriptionError(
      "forbidden",
      "missing-portal-role",
      "This account does not have the portal role this action needs."
    );
  }
  return roles;
}

/** A portal user who may grant or revoke subscriptions: admins only. */
export async function requireSubscriptionAdmin(uid: string): Promise<string[]> {
  const roles = await portalRolesOf(uid);
  if (!hasPortalRole(roles, PORTAL_ADMIN_ROLE)) {
    throw new SubscriptionError(
      "forbidden",
      "not-subscription-admin",
      "Only an admin may change subscriptions."
    );
  }
  return roles;
}
