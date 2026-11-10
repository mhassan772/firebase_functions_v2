import * as crypto from "crypto";
import * as functions from "firebase-functions";
import { ActionLinkError, ActionMode, AuthEmailLang, readLang, rewriteActionLink } from "../services/email/actionLink";
import { AuthEmailKind, renderAuthEmail, senderName } from "../services/email/authEmailTemplates";
import { Mailer } from "../services/email/sesMailer";
import { AuthEmailThrottle, AuthEmailThrottledError, normalizeAddress } from "../services/authEmailThrottle";

/** How recent a sign-in must be before the address on the account may change. */
export const RECENT_LOGIN_MS = 5 * 60 * 1000;

export interface AuthEmailUser {
  uid: string;
  email?: string;
  emailVerified: boolean;
  disabled: boolean;
}

/** The slice of the Admin SDK's Auth these handlers use; `admin.auth()` satisfies it. */
export interface AuthEmailAdmin {
  getUser(uid: string): Promise<AuthEmailUser>;
  getUserByEmail(email: string): Promise<AuthEmailUser>;
  generatePasswordResetLink(email: string): Promise<string>;
  generateEmailVerificationLink(email: string): Promise<string>;
  generateVerifyAndChangeEmailLink(email: string, newEmail: string): Promise<string>;
}

export interface AuthEmailDeps {
  auth: AuthEmailAdmin;
  mailer: Mailer;
  throttle: AuthEmailThrottle;
  now: () => number;
}

/** The parts of a callable context these handlers read; a real CallableContext fits it. */
export interface AuthEmailCallContext {
  auth?: {
    uid: string;
    token: { auth_time?: number; firebase?: { sign_in_provider?: string } };
  };
  app?: unknown;
}

type Ok = { ok: true };
const OK: Ok = { ok: true };

/** Where a non-refusal failure happened, so logs say which dependency broke without its message. */
type Stage = "validate" | "throttle" | "lookup" | "link" | "send";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
const MAX_EMAIL_LENGTH = 254;

/**
 * Sends a password reset link to the account that owns `email`.
 *
 * The reply is the same whether or not such an account exists, so the call cannot be used to learn
 * who has a Mantooq account. The address is still counted against the throttle either way.
 */
export async function handleRequestPasswordResetEmail(
  data: unknown,
  context: AuthEmailCallContext,
  deps: AuthEmailDeps
): Promise<Ok> {
  const event = "auth_email_password_reset";
  const operationId = crypto.randomUUID();
  const state: { stage: Stage } = { stage: "validate" };
  try {
    const uid = requireCaller(context, { allowAnonymous: true });
    const input = asRecord(data);
    const lang = readLang(input.lang);
    const email = readEmail(input.email, "email");
    logInfo(`${event}_start`, operationId, { uid, lang, appCheck: hasAppCheck(context) });

    state.stage = "throttle";
    await deps.throttle.consume({ uid, address: email, nowMs: deps.now() });

    state.stage = "lookup";
    const user = await findUserByEmail(deps.auth, email);
    if (!user || !user.email) {
      logInfo(`${event}_skipped`, operationId, { uid, reason: "user_not_found" });
      return OK;
    }
    if (user.disabled) {
      logInfo(`${event}_skipped`, operationId, { uid, reason: "user_disabled" });
      return OK;
    }

    state.stage = "link";
    let adminLink: string;
    try {
      adminLink = await deps.auth.generatePasswordResetLink(user.email);
    } catch (error) {
      // The account went away between the lookup and the link.
      if (isAuthCode(error, "auth/email-not-found", "auth/user-not-found")) {
        logInfo(`${event}_skipped`, operationId, { uid, reason: "user_not_found" });
        return OK;
      }
      throw error;
    }

    state.stage = "send";
    await sendAuthEmail(deps, "passwordReset", lang, user.email, adminLink, "resetPassword");
    logInfo(`${event}_success`, operationId, { uid, lang });
    return OK;
  } catch (error) {
    throw toCallableError(event, operationId, state.stage, error);
  }
}

/** Sends a verification link to the signed-in account's own address. */
export async function handleRequestVerificationEmail(
  data: unknown,
  context: AuthEmailCallContext,
  deps: AuthEmailDeps
): Promise<Ok> {
  const event = "auth_email_verification";
  const operationId = crypto.randomUUID();
  const state: { stage: Stage } = { stage: "validate" };
  try {
    const uid = requireCaller(context, { allowAnonymous: false });
    const lang = readLang(asRecord(data).lang);
    logInfo(`${event}_start`, operationId, { uid, lang, appCheck: hasAppCheck(context) });

    state.stage = "lookup";
    const user = await deps.auth.getUser(uid);
    if (!user.email) throw refusal("failed-precondition", "The account has no email address.", "no_email");
    if (user.emailVerified) {
      throw refusal("failed-precondition", "The email address is already verified.", "already_verified");
    }

    state.stage = "throttle";
    await deps.throttle.consume({ uid, address: user.email, nowMs: deps.now() });

    state.stage = "link";
    const adminLink = await deps.auth.generateEmailVerificationLink(user.email);

    state.stage = "send";
    await sendAuthEmail(deps, "verification", lang, user.email, adminLink, "verifyEmail");
    logInfo(`${event}_success`, operationId, { uid, lang });
    return OK;
  } catch (error) {
    throw toCallableError(event, operationId, state.stage, error);
  }
}

/**
 * Sends a link to `newEmail` that moves the signed-in account onto it once opened.
 *
 * The account keeps its current address until then, so a typo cannot lock anyone out.
 */
export async function handleRequestEmailChange(
  data: unknown,
  context: AuthEmailCallContext,
  deps: AuthEmailDeps
): Promise<Ok> {
  const event = "auth_email_change";
  const operationId = crypto.randomUUID();
  const state: { stage: Stage } = { stage: "validate" };
  try {
    const uid = requireCaller(context, { allowAnonymous: false });
    const input = asRecord(data);
    const lang = readLang(input.lang);
    const newEmail = readEmail(input.newEmail, "newEmail");
    logInfo(`${event}_start`, operationId, { uid, lang, appCheck: hasAppCheck(context) });
    requireRecentLogin(context, deps.now());

    state.stage = "lookup";
    const user = await deps.auth.getUser(uid);
    if (!user.email) throw refusal("failed-precondition", "The account has no email address.", "no_email");
    if (normalizeAddress(user.email) === normalizeAddress(newEmail)) {
      throw new functions.https.HttpsError("invalid-argument", "The new email is the account's current email.");
    }

    // Counted before the ownership check, so the call cannot be used to probe addresses freely.
    state.stage = "throttle";
    await deps.throttle.consume({ uid, address: newEmail, nowMs: deps.now() });

    state.stage = "lookup";
    const owner = await findUserByEmail(deps.auth, newEmail);
    if (owner && owner.uid !== uid) throw emailInUse();

    state.stage = "link";
    let adminLink: string;
    try {
      adminLink = await deps.auth.generateVerifyAndChangeEmailLink(user.email, newEmail);
    } catch (error) {
      if (isAuthCode(error, "auth/email-already-exists")) throw emailInUse();
      throw error;
    }

    state.stage = "send";
    await sendAuthEmail(deps, "emailChange", lang, newEmail, adminLink, "verifyAndChangeEmail");
    logInfo(`${event}_success`, operationId, { uid, lang });
    return OK;
  } catch (error) {
    throw toCallableError(event, operationId, state.stage, error);
  }
}

async function sendAuthEmail(
  deps: AuthEmailDeps,
  kind: AuthEmailKind,
  lang: AuthEmailLang,
  to: string,
  adminLink: string,
  mode: ActionMode
): Promise<void> {
  const link = rewriteActionLink(adminLink, lang, mode);
  const rendered = renderAuthEmail(kind, lang, { link, email: to });
  await deps.mailer.send({ ...rendered, to, fromName: senderName(lang) });
}

function requireCaller(context: AuthEmailCallContext, options: { allowAnonymous: boolean }): string {
  const auth = context.auth;
  if (!auth?.uid) {
    throw new functions.https.HttpsError("unauthenticated", "Firebase Authentication is required.");
  }
  if (!options.allowAnonymous && auth.token?.firebase?.sign_in_provider === "anonymous") {
    throw new functions.https.HttpsError("unauthenticated", "A signed-in account is required.");
  }
  return auth.uid;
}

function requireRecentLogin(context: AuthEmailCallContext, nowMs: number): void {
  const authTime = context.auth?.token?.auth_time;
  const authTimeMs = typeof authTime === "number" ? authTime * 1000 : NaN;
  if (!Number.isFinite(authTimeMs) || nowMs - authTimeMs > RECENT_LOGIN_MS) {
    throw refusal("permission-denied", "Sign in again before changing the email.", "recent_login_required");
  }
}

function readEmail(value: unknown, field: string): string {
  const email = typeof value === "string" ? value.trim() : "";
  if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
    throw new functions.https.HttpsError("invalid-argument", `${field} must be a valid email address.`);
  }
  return email;
}

function asRecord(data: unknown): Record<string, unknown> {
  return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
}

function hasAppCheck(context: AuthEmailCallContext): boolean {
  return context.app !== undefined && context.app !== null;
}

async function findUserByEmail(auth: AuthEmailAdmin, email: string): Promise<AuthEmailUser | undefined> {
  try {
    // Auth keeps addresses lower-cased, so the lookup is too.
    return await auth.getUserByEmail(normalizeAddress(email));
  } catch (error) {
    if (isAuthCode(error, "auth/user-not-found")) return undefined;
    throw error;
  }
}

function isAuthCode(error: unknown, ...codes: string[]): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && codes.includes(code);
}

function refusal(code: functions.https.FunctionsErrorCode, message: string, reason: string) {
  return new functions.https.HttpsError(code, message, { reason });
}

function emailInUse() {
  return new functions.https.HttpsError("already-exists", "The new email belongs to another account.");
}

/**
 * Turns any failure into the callable error the app sees, logging it once.
 *
 * Only codes and the stage are logged: SES and Auth messages can carry the address itself.
 */
function toCallableError(
  event: string,
  operationId: string,
  stage: Stage,
  error: unknown
): functions.https.HttpsError {
  if (error instanceof functions.https.HttpsError) {
    functions.logger.warn(`${event}_rejection`, {
      operationId,
      code: error.code,
      ...(reasonOf(error) ? { reason: reasonOf(error) } : {}),
    });
    return error;
  }
  if (error instanceof AuthEmailThrottledError) {
    functions.logger.warn(`${event}_rejection`, { operationId, code: "resource-exhausted", reason: error.reason });
    return new functions.https.HttpsError("resource-exhausted", "Too many emails were requested. Try again later.", {
      reason: error.reason,
    });
  }
  functions.logger.error(`${event}_failure`, {
    operationId,
    stage,
    errorName: error instanceof Error ? error.name : typeof error,
    ...(error instanceof ActionLinkError ? { reason: error.reason } : {}),
    ...(errorCodeOf(error) ? { errorCode: errorCodeOf(error) } : {}),
  });
  return new functions.https.HttpsError("internal", "The email could not be sent.");
}

/** A short machine code such as "auth/internal-error"; never the message. */
function errorCodeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[\w/.-]{1,64}$/.test(code) ? code : undefined;
}

function reasonOf(error: functions.https.HttpsError): string | undefined {
  const details = error.details as { reason?: unknown } | undefined;
  return typeof details?.reason === "string" ? details.reason : undefined;
}

function logInfo(event: string, operationId: string, fields: Record<string, unknown> = {}): void {
  functions.logger.info(event, { operationId, ...fields });
}
