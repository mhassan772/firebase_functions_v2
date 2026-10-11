import * as functions from "firebase-functions";

export type SubscriptionErrorKind =
  | "invalid-input"
  | "invalid-store-data"
  | "account-binding-mismatch"
  | "ownership-conflict"
  | "store-unavailable"
  | "configuration"
  | "internal"
  // Admin API kinds: the message is safe to show and the code is passed in details.
  | "precondition"
  | "not-found"
  | "forbidden";

export class SubscriptionError extends Error {
  constructor(
    public readonly kind: SubscriptionErrorKind,
    public readonly safeCode: string,
    message: string,
    public readonly retryable = false
  ) {
    super(message);
    this.name = "SubscriptionError";
  }
}

export function asCallableError(error: unknown): functions.https.HttpsError {
  if (error instanceof functions.https.HttpsError) {
    return error;
  }

  if (error instanceof SubscriptionError) {
    const details = { code: error.safeCode };
    switch (error.kind) {
      case "precondition":
        return new functions.https.HttpsError(
          "failed-precondition",
          error.message,
          details
        );
      case "not-found":
        return new functions.https.HttpsError("not-found", error.message, details);
      case "forbidden":
        return new functions.https.HttpsError(
          "permission-denied",
          error.message,
          details
        );
      case "invalid-input":
        return new functions.https.HttpsError(
          "invalid-argument",
          "The purchase verification request is invalid.",
          details
        );
      case "invalid-store-data":
        return new functions.https.HttpsError(
          "failed-precondition",
          "The store could not verify this subscription."
        );
      case "account-binding-mismatch":
        return new functions.https.HttpsError(
          "permission-denied",
          "This purchase is bound to a different account."
        );
      case "ownership-conflict":
        return new functions.https.HttpsError(
          "already-exists",
          "This purchase is already assigned to another account."
        );
      case "store-unavailable":
        return new functions.https.HttpsError(
          "unavailable",
          "The subscription store is temporarily unavailable."
        );
      case "configuration":
      case "internal":
        return new functions.https.HttpsError(
          "internal",
          "Subscription verification is temporarily unavailable."
        );
    }
  }

  return new functions.https.HttpsError(
    "internal",
    "Subscription verification failed."
  );
}

export function safeErrorCode(error: unknown): string {
  if (error instanceof SubscriptionError) {
    return error.safeCode;
  }
  if (error instanceof functions.https.HttpsError) {
    // Device errors carry their safe code in details, like the admin API does.
    const details = error.details as { code?: unknown } | undefined;
    return typeof details?.code === "string" ? details.code : error.code;
  }
  return "unexpected";
}

/** True for a callable refusal the caller caused, which is logged as a rejection rather than a failure. */
export function isCallerRefusal(error: unknown): boolean {
  if (error instanceof SubscriptionError) {
    return (
      error.kind === "invalid-input" ||
      error.kind === "invalid-store-data" ||
      error.kind === "account-binding-mismatch" ||
      error.kind === "ownership-conflict" ||
      error.kind === "precondition" ||
      error.kind === "not-found" ||
      error.kind === "forbidden"
    );
  }
  return (
    error instanceof functions.https.HttpsError &&
    (error.code === "resource-exhausted" ||
      error.code === "failed-precondition" ||
      error.code === "invalid-argument" ||
      error.code === "unauthenticated")
  );
}
