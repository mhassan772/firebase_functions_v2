import { Firestore } from "firebase-admin/firestore";
import * as functions from "firebase-functions";
import type Stripe from "stripe";
import { DELETED_ACCOUNTS_COLLECTION } from "../services/accountDeletion/tombstone";
import { StoreCountryStore } from "../services/storeCountry";
import { accountDeleted } from "../services/webSubscriptions/customers";
import { SubscriptionError } from "../services/subscriptions/errors";
import { PriceLookup, priceLookupFor, readWebPricingConfig, WebPricingConfig } from "../services/webSubscriptions/pricing";
import { WebPurchaseThrottle, WebPurchaseThrottledError } from "../services/webSubscriptions/purchaseThrottle";
import { shortId, stripeErrorCode, StripeGateway } from "../services/webSubscriptions/stripeGateway";
import { CallerContext, errorCodeOf, reasonOf, refusal } from "../utils/callableAuth";

/** The five web purchase callables share these dependencies; the live set is in functions/webSubscriptions/deps.ts. */
export interface WebCallableDeps {
  firestore: Firestore;
  /** Undefined when the Stripe secret key is not configured. */
  gateway: StripeGateway | undefined;
  /** `STRIPE_WEB_PUBLISHABLE_KEY`, handed to the page by `getWebPlans`. */
  publishableKey: string | undefined;
  storeCountry: Pick<StoreCountryStore, "knownCountries">;
  throttle: WebPurchaseThrottle;
  now: () => Date;
  /** Defaults to the shared ten-minute cache for the gateway. */
  prices?: PriceLookup;
  /** Waits between reads while Stripe settles a payment; tests replace it. */
  sleep?: (ms: number) => Promise<void>;
}

/** A callable context with the token claims and request the web callables read. */
export interface WebCallerContext extends CallerContext {
  auth?: {
    uid: string;
    token: {
      auth_time?: number;
      email?: string;
      email_verified?: boolean;
      firebase?: { sign_in_provider?: string };
    };
  };
  rawRequest?: { ip?: string };
}

/** Sign-in providers whose email the provider itself verified. */
const VERIFIED_EMAIL_PROVIDERS = new Set(["google.com", "apple.com"]);

/**
 * Refuses `email_unverified` unless the caller's ID token shows a verified email.
 *
 * Read from the token Firebase verified for this call, never from the request. Google and Apple
 * sign-ins count as verified; every other provider (password, phone, custom) needs
 * `email_verified` true and an email.
 */
export function requireVerifiedEmail(context: WebCallerContext): void {
  const token = context.auth?.token;
  const provider = token?.firebase?.sign_in_provider;
  if (provider && VERIFIED_EMAIL_PROVIDERS.has(provider)) return;
  if (token?.email_verified === true && typeof token.email === "string" && token.email) return;
  throw refusal("failed-precondition", "Verify the account's email address before buying.", "email_unverified");
}

/** The caller's email from the verified token, for the Stripe customer; never logged. */
export function callerEmail(context: WebCallerContext): string | undefined {
  const email = context.auth?.token?.email;
  return typeof email === "string" && email.includes("@") ? email : undefined;
}

export interface WebGate {
  gateway: StripeGateway;
  config: WebPricingConfig;
  prices: PriceLookup;
}

/**
 * The Stripe gateway and pricing config, or `sales_disabled`.
 *
 * `sales` is for starting a purchase: it also needs `salesEnabled`. Managing a purchase already
 * made (finishing it, reading it, cancelling, changing the card) needs only the key, so a buyer
 * can still cancel while sales are switched off. Starting a purchase also refuses a deleted
 * account (`account_deleted`). On a sandbox key only testers pass either way:
 * a test card must never unlock premium for anyone else.
 */
export async function openWebGate(uid: string, deps: WebCallableDeps, options: { sales: boolean }): Promise<WebGate> {
  const gateway = deps.gateway;
  const disabled = () => refusal("failed-precondition", "Web purchases are not available.", "sales_disabled");
  if (!gateway) throw disabled();
  if (options.sales) {
    // A deleted account may still hold a valid ID token for up to an hour.
    const tombstone = await deps.firestore.collection(DELETED_ACCOUNTS_COLLECTION).doc(uid).get();
    if (tombstone.exists) throw accountDeleted();
  }
  const config = await readWebPricingConfig(deps.firestore);
  if (options.sales && !config.salesEnabled) throw disabled();
  if (!gateway.livemode && !config.testers.includes(uid)) throw disabled();
  return { gateway, config, prices: deps.prices ?? priceLookupFor(gateway) };
}

/** Counts one attempt that can reach Stripe with a card, by uid and by the caller's IP. */
export async function consumeWebThrottle(
  deps: WebCallableDeps,
  uid: string,
  context: WebCallerContext
): Promise<void> {
  const ip = typeof context.rawRequest?.ip === "string" && context.rawRequest.ip ? context.rawRequest.ip : undefined;
  try {
    await deps.throttle.consume({ uid, ip, nowMs: deps.now().getTime() });
  } catch (error) {
    if (error instanceof WebPurchaseThrottledError) {
      throw new functions.https.HttpsError("resource-exhausted", "Too many attempts. Try again tomorrow.", {
        reason: "throttled",
        limit: error.reason,
      });
    }
    throw error;
  }
}

/** A refusal with more than its reason in `details`. */
export function refusalWith(
  code: functions.https.FunctionsErrorCode,
  message: string,
  reason: string,
  extra: Record<string, string>
): functions.https.HttpsError {
  return new functions.https.HttpsError(code, message, { reason, ...extra });
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function invalidRequest(): functions.https.HttpsError {
  return refusal("invalid-argument", "The request is not valid.", "invalid_request");
}

/** The request as an object holding only `allowed` keys (null data counts as `{}`), or `invalid_request`. */
export function readRequestObject(data: unknown, allowed: readonly string[]): Record<string, unknown> {
  const request = data === null || data === undefined ? {} : data;
  if (!isPlainObject(request)) throw invalidRequest();
  for (const key of Object.keys(request)) {
    if (!allowed.includes(key)) throw invalidRequest();
  }
  return request;
}

export function optionalString(value: unknown, pattern: RegExp): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !pattern.test(value)) throw invalidRequest();
  return value;
}

export function requiredString(value: unknown, pattern: RegExp): string {
  const text = optionalString(value, pattern);
  if (text === undefined) throw invalidRequest();
  return text;
}

/** Integer cents. */
export function optionalCents(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw invalidRequest();
  return value;
}

/** `ar` or `en`; anything else is invalid, and nothing means Arabic. */
export function readWebLang(value: unknown): "ar" | "en" {
  if (value === undefined || value === null) return "ar";
  if (value !== "ar" && value !== "en") throw invalidRequest();
  return value;
}

export const CONFIRMATION_TOKEN_PATTERN = /^ctoken_[A-Za-z0-9]{6,200}$/;

// ---------------------------------------------------------------------------
// Stripe answers
// ---------------------------------------------------------------------------

export type DeclineCategory = "declined" | "insufficient_funds" | "expired_card" | "incorrect_details" | "authentication_failed";

const INCORRECT_DETAILS = new Set([
  "incorrect_cvc",
  "invalid_cvc",
  "incorrect_number",
  "invalid_number",
  "invalid_expiry_month",
  "invalid_expiry_year",
  "incorrect_zip",
]);

function errorField(error: unknown, field: string): string | undefined {
  const value = (error as Record<string, unknown> | null)?.[field];
  return typeof value === "string" ? value : undefined;
}

/** A Stripe card error: the card was refused, so nothing was charged. */
export function isCardError(error: unknown): boolean {
  const type = errorField(error, "type");
  const rawType = errorField(error, "rawType");
  return type === "card_error" || type === "StripeCardError" || rawType === "card_error";
}

/** Stripe refused the request itself, so nothing happened at Stripe. */
export function isInvalidRequestError(error: unknown): boolean {
  const type = errorField(error, "type");
  const rawType = errorField(error, "rawType");
  return type === "invalid_request_error" || type === "StripeInvalidRequestError" || rawType === "invalid_request_error";
}

/** A refused request about the confirmation token: missing, expired, used or mismatched. */
export function isTokenError(error: unknown): boolean {
  const code = stripeErrorCode(error) ?? "";
  const param = errorField(error, "param") ?? "";
  return isInvalidRequestError(error) && (code.includes("confirmation_token") || param.includes("confirmation_token"));
}

/** The decline category the pages explain; Stripe's own message never reaches them. */
export function declineCategory(error: unknown): DeclineCategory {
  const code = errorField(error, "decline_code") ?? errorField(error, "code") ?? "";
  const fallback = errorField(error, "code") ?? "";
  for (const value of [code, fallback]) {
    if (value === "insufficient_funds") return "insufficient_funds";
    if (value === "expired_card") return "expired_card";
    if (INCORRECT_DETAILS.has(value)) return "incorrect_details";
    if (value.includes("authentication")) return "authentication_failed";
  }
  return "declined";
}

/** The category of a PaymentIntent or SetupIntent error left after a failed authentication. */
export function categoryOfLastError(lastError: { code?: string | null; decline_code?: string | null } | null | undefined): DeclineCategory {
  if (!lastError) return "declined";
  return declineCategory({ code: lastError.code ?? undefined, decline_code: lastError.decline_code ?? undefined });
}

export function cardDeclined(category: DeclineCategory): functions.https.HttpsError {
  return refusalWith("failed-precondition", "The card was declined.", "card_declined", { category });
}

export function tokenInvalid(): functions.https.HttpsError {
  return refusal("failed-precondition", "The card details expired. Enter them again.", "token_invalid");
}

/**
 * Retrieves a confirmation token that can still confirm, or `token_invalid`.
 *
 * Reading a token does not use it up. A token already used, past its 12 hours, or made with the
 * wrong `setup_future_usage` is refused before anything is created at Stripe: Stripe would
 * otherwise reject it only at confirmation, after the subscription or invoice exists.
 */
export async function readConfirmationToken(
  gateway: StripeGateway,
  tokenId: string,
  now: Date,
  setupFutureUsage: "off_session" | null,
  log: (problem: string) => void
): Promise<Stripe.ConfirmationToken> {
  let token: Stripe.ConfirmationToken;
  try {
    token = await gateway.retrieveConfirmationToken(tokenId);
  } catch (error) {
    if (isInvalidRequestError(error)) {
      log(stripeErrorCode(error) ?? "invalid_request");
      throw tokenInvalid();
    }
    throw error;
  }
  if (typeof token.expires_at === "number" && token.expires_at * 1000 <= now.getTime()) {
    log("expired");
    throw tokenInvalid();
  }
  if (token.payment_intent || token.setup_intent) {
    log("used");
    throw tokenInvalid();
  }
  if ((token.setup_future_usage ?? null) !== setupFutureUsage) {
    log("setup_future_usage");
    throw tokenInvalid();
  }
  return token;
}

// ---------------------------------------------------------------------------
// Errors and logs
// ---------------------------------------------------------------------------

/**
 * Turns any failure into the callable error the page sees, logging it once.
 *
 * A refusal passes through. Anything else is `internal` with a fixed message: Stripe's own
 * messages can quote ids, amounts or a token and never reach the caller or the log; only their
 * machine code does.
 */
export function toWebCallableError(event: string, operationId: string, stage: string, error: unknown): functions.https.HttpsError {
  if (error instanceof functions.https.HttpsError) {
    const details = error.details as Record<string, unknown> | undefined;
    functions.logger.warn(`${event}_rejection`, {
      operationId,
      stage,
      code: error.code,
      ...(reasonOf(error) ? { reason: reasonOf(error) } : {}),
      ...(typeof details?.category === "string" ? { category: details.category } : {}),
    });
    return error;
  }
  functions.logger.error(`${event}_failure`, {
    operationId,
    stage,
    errorName: error instanceof Error ? error.name : typeof error,
    ...(error instanceof SubscriptionError ? { safeCode: error.safeCode } : {}),
    ...(stripeErrorCode(error) ? { stripeCode: stripeErrorCode(error) } : {}),
    ...(!stripeErrorCode(error) && errorCodeOf(error) ? { errorCode: errorCodeOf(error) } : {}),
  });
  return new functions.https.HttpsError("internal", "Something went wrong. Try again later.");
}

export function logWebInfo(event: string, operationId: string, fields: Record<string, unknown> = {}): void {
  functions.logger.info(event, { operationId, ...fields });
}

/** A confirmation token id fit for a log line. */
export const tokenForLog = (id: string): string | undefined => shortId(id);
