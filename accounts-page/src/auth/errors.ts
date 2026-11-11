/// How a sign-in or re-authentication failure is shown, from the Auth error code alone.

/// `cancelled` shows nothing: the user closed the provider window on purpose.
export type SignInFailure =
  | "cancelled"
  | "wrongCredentials"
  | "tooMany"
  | "network"
  | "popupBlocked"
  | "providerDisabled"
  | "otherMethod"
  | "differentAccount"
  | "disabled"
  | "generic";

export function signInFailureFrom(error: unknown): SignInFailure {
  const code = typeof (error as { code?: unknown } | null)?.code === "string" ? (error as { code: string }).code : "";
  switch (code) {
    case "auth/popup-closed-by-user":
    case "auth/cancelled-popup-request":
    case "auth/user-cancelled":
      return "cancelled";
    case "auth/invalid-credential":
    case "auth/invalid-login-credentials":
    case "auth/wrong-password":
    case "auth/user-not-found":
    case "auth/invalid-email":
      return "wrongCredentials";
    case "auth/too-many-requests":
      return "tooMany";
    case "auth/network-request-failed":
    case "auth/timeout":
      return "network";
    case "auth/popup-blocked":
      return "popupBlocked";
    case "auth/operation-not-allowed":
      return "providerDisabled";
    case "auth/account-exists-with-different-credential":
      return "otherMethod";
    case "auth/user-mismatch":
      return "differentAccount";
    case "auth/user-disabled":
      return "disabled";
    default:
      return "generic";
  }
}
