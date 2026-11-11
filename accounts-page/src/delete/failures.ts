/// What the delete page does after `deleteAccount` fails, decided from the error alone.

/// - `reauth`: the sign-in is too old for the backend; confirm it again and retry.
/// - `signedOut`: the backend sees no usable sign-in; sign out and show the sign-in view.
/// - `noAnswer`: no answer came back, so the deletion may have gone through; check before saying so.
/// - `retry`: the backend answered with a failure; show it with a retry, keep the sign-in.
export type DeletionFailure = "reauth" | "signedOut" | "noAnswer" | "retry";

const SDK_ONLY_MESSAGE = /^internal(?: \[\d+\])?$/;

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "";
}

export function deletionFailureFrom(error: unknown): DeletionFailure {
  const code = codeOf(error);
  const details = (error as { details?: { reason?: unknown } } | null)?.details;
  switch (code) {
    case "functions/permission-denied":
      return details?.reason === "recent_login_required" ? "reauth" : "retry";
    case "functions/unauthenticated":
      return "signedOut";
    case "functions/deadline-exceeded":
    case "functions/unavailable":
    case "auth/network-request-failed":
      return "noAnswer";
    case "functions/internal":
      // The SDK reports a failed request (network, or a crash with no readable answer) as
      // `internal` with only the code, and from 12.19 the HTTP status, as its message: "internal"
      // or "internal [0]". The backend's own `internal` carries its own message.
      return SDK_ONLY_MESSAGE.test(String((error as { message?: unknown }).message)) ? "noAnswer" : "retry";
    default:
      return "retry";
  }
}

/// After no answer: whether reloading the user proves the account is gone.
/// `exists` when the reload worked, `gone` when Auth no longer knows the user, else `unknown`.
export type AccountCheck = "exists" | "gone" | "unknown";

export function accountCheckFrom(error: unknown): AccountCheck {
  if (error === undefined) return "exists";
  const code = codeOf(error);
  return code === "auth/user-not-found" || code === "auth/user-token-expired" ? "gone" : "unknown";
}
