import * as functions from "firebase-functions";

/** How recent a sign-in must be before a sensitive account change is allowed. */
export const RECENT_LOGIN_MS = 5 * 60 * 1000;

/** The parts of a callable context the caller checks read; a real CallableContext fits it. */
export interface CallerContext {
  auth?: {
    uid: string;
    token: { auth_time?: number; firebase?: { sign_in_provider?: string } };
  };
  app?: unknown;
}

export interface RequireCallerOptions {
  allowAnonymous: boolean;
  /**
   * Adds `details.reason` (`signed_out` or `anonymous`) to the refusal. The account-email
   * callables shipped without it, so it is opt-in to keep their replies as they were.
   */
  withReason?: boolean;
}

/** The caller's uid, or an `unauthenticated` refusal. */
export function requireCaller(context: CallerContext, options: RequireCallerOptions): string {
  const auth = context.auth;
  if (!auth?.uid) {
    throw unauthenticated("Firebase Authentication is required.", "signed_out", options.withReason);
  }
  if (!options.allowAnonymous && auth.token?.firebase?.sign_in_provider === "anonymous") {
    throw unauthenticated("A signed-in account is required.", "anonymous", options.withReason);
  }
  return auth.uid;
}

/** Refuses with `recent_login_required` unless the caller signed in within `RECENT_LOGIN_MS`. */
export function requireRecentLogin(context: CallerContext, nowMs: number, message: string): void {
  const authTime = context.auth?.token?.auth_time;
  const authTimeMs = typeof authTime === "number" ? authTime * 1000 : NaN;
  if (!Number.isFinite(authTimeMs) || nowMs - authTimeMs > RECENT_LOGIN_MS) {
    throw refusal("permission-denied", message, "recent_login_required");
  }
}

/**
 * Whether the call carried a verified App Check token.
 *
 * Recorded rather than enforced: the app sends the token only while the remote flag
 * `app_check_header` is on, and enforcing would refuse every call while it is off.
 */
export function hasAppCheck(context: CallerContext): boolean {
  return context.app !== undefined && context.app !== null;
}

/** A refusal the app tells apart from others with the same code by `details.reason`. */
export function refusal(code: functions.https.FunctionsErrorCode, message: string, reason: string) {
  return new functions.https.HttpsError(code, message, { reason });
}

/** The `details.reason` of a refusal, when it has one. */
export function reasonOf(error: functions.https.HttpsError): string | undefined {
  const details = error.details as { reason?: unknown } | undefined;
  return typeof details?.reason === "string" ? details.reason : undefined;
}

/** A short machine code such as "auth/internal-error"; never the message. */
export function errorCodeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[\w/.-]{1,64}$/.test(code) ? code : undefined;
}

function unauthenticated(message: string, reason: string, withReason: boolean | undefined) {
  return withReason
    ? refusal("unauthenticated", message, reason)
    : new functions.https.HttpsError("unauthenticated", message);
}
