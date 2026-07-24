import * as functions from "firebase-functions";

export type SubscriptionErrorKind =
  | "invalid-input"
  | "invalid-store-data"
  | "account-binding-mismatch"
  | "ownership-conflict"
  | "store-unavailable"
  | "configuration"
  | "internal";

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
    switch (error.kind) {
      case "invalid-input":
        return new functions.https.HttpsError(
          "invalid-argument",
          "The purchase verification request is invalid."
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
    return error.code;
  }
  return "unexpected";
}
