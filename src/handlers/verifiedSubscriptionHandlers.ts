import * as crypto from "crypto";
import { Request, Response } from "express";
import * as functions from "firebase-functions";
import {
  SUBSCRIPTION_SECRETS,
  GOOGLE_PACKAGE_NAME,
} from "../config/constants";
import { SubscriptionPlatform, StoreEvent } from "../types/subscriptions";
import {
  accountBindingVersion,
  deriveAccountBinding,
} from "../services/subscriptions/crypto";
import {
  asCallableError,
  safeErrorCode,
  SubscriptionError,
} from "../services/subscriptions/errors";
import {
  verifyAppleNotification,
  verifyAppleSubscription,
} from "../services/subscriptions/apple";
import { verifyGoogleSubscription } from "../services/subscriptions/google";
import {
  persistVerifiedSubscription,
  recordUnclaimedStoreEvent,
  resolveGoogleCurrentToken,
  resolveVerifiedOwner,
} from "../services/subscriptions/persistence";
import { requireRuntimeSecret } from "../services/subscriptions/runtimeSecrets";

interface GoogleRtdnPayload {
  packageName?: unknown;
  eventTimeMillis?: unknown;
  subscriptionNotification?: {
    notificationType?: unknown;
    purchaseToken?: unknown;
  };
  voidedPurchaseNotification?: {
    purchaseToken?: unknown;
    productType?: unknown;
  };
  oneTimeProductNotification?: unknown;
  testNotification?: unknown;
}

export async function handleGetSubscriptionAccountBinding(
  data: unknown,
  context: functions.https.CallableContext
): Promise<{
  platform: SubscriptionPlatform;
  accountBindingId: string;
  version: number;
}> {
  const operationId = crypto.randomUUID();
  let platform: SubscriptionPlatform | undefined;
  try {
    platform = readPlatform(data, ["platform"]);
    logInfo("subscription_account_binding_start", operationId, { platform });
    const uid = requireAuthenticatedUid(context);
    const accountBindingId = deriveAccountBinding(
      uid,
      platform,
      requireRuntimeSecret(SUBSCRIPTION_SECRETS.accountBindingHmacKey)
    );
    logInfo("subscription_account_binding_success", operationId, { platform });
    return {
      platform,
      accountBindingId,
      version: accountBindingVersion(),
    };
  } catch (error) {
    logCallableFailure("subscription_account_binding", operationId, platform, error);
    throw asCallableError(error);
  }
}

export async function handleVerifySubscription(
  data: unknown,
  context: functions.https.CallableContext
): Promise<{ subscription: unknown }> {
  const operationId = crypto.randomUUID();
  let platform: SubscriptionPlatform | undefined;
  try {
    platform = readPlatform(data);
    assertExactKeys(
      data,
      platform === "apple"
        ? ["platform", "signedTransaction"]
        : ["platform", "purchaseToken"]
    );
    const uid = requireAuthenticatedUid(context);
    logInfo("subscription_verification_start", operationId, { platform });
    const binding = deriveAccountBinding(
      uid,
      platform,
      requireRuntimeSecret(SUBSCRIPTION_SECRETS.accountBindingHmacKey)
    );
    const request = data as Record<string, unknown>;
    const verified =
      platform === "apple"
        ? await verifyAppleSubscription(
          requirePurchaseMaterial(request.signedTransaction, "signedTransaction"),
          binding
        )
        : await verifyGoogleSubscription(
          requirePurchaseMaterial(request.purchaseToken, "purchaseToken"),
          binding
        );
    const result = await persistVerifiedSubscription(uid, verified);
    logInfo("subscription_verification_success", operationId, {
      platform,
      productId: verified.subscription.productId,
      environment: verified.subscription.environment,
      status: verified.subscription.status,
      active: verified.subscription.active,
    });
    return { subscription: result.subscription };
  } catch (error) {
    logCallableFailure("subscription_verification", operationId, platform, error);
    throw asCallableError(error);
  }
}

export async function handleAppleSubscriptionNotifications(
  req: Request,
  res: Response
): Promise<void> {
  const operationId = crypto.randomUUID();
  logInfo("apple_subscription_notification_start", operationId);

  if (req.method !== "POST") {
    logWarning("apple_subscription_notification_rejection", operationId, {
      code: "method-not-allowed",
    });
    res.status(405).json({ received: false });
    return;
  }

  try {
    assertExactKeys(req.body, ["signedPayload"]);
    const signedPayload = requirePurchaseMaterial(
      (req.body as Record<string, unknown>).signedPayload,
      "signedPayload"
    );
    const result = await verifyAppleNotification(signedPayload);
    if (!("verified" in result)) {
      await recordUnclaimedStoreEvent(result.event);
      logInfo("apple_subscription_notification_success", operationId, {
        eventType: result.event.eventType,
        environment: result.event.environment,
        claimed: false,
      });
      res.status(200).json({ received: true });
      return;
    }

    const ownerUid = await resolveVerifiedOwner(result.verified.ownership);
    if (!ownerUid) {
      await recordUnclaimedStoreEvent(result.event);
      logInfo("apple_subscription_notification_success", operationId, {
        eventType: result.event.eventType,
        environment: result.event.environment,
        claimed: false,
      });
      res.status(200).json({ received: true });
      return;
    }

    const persisted = await persistVerifiedSubscription(
      ownerUid,
      result.verified,
      result.event
    );
    logInfo("apple_subscription_notification_success", operationId, {
      eventType: result.event.eventType,
      environment: result.event.environment,
      status: result.verified.subscription.status,
      active: result.verified.subscription.active,
      duplicate: persisted.duplicate,
      claimed: true,
    });
    res.status(200).json({ received: true });
  } catch (error) {
    if (
      error instanceof SubscriptionError &&
      error.kind === "ownership-conflict"
    ) {
      logWarning("apple_subscription_notification_rejection", operationId, {
        code: error.safeCode,
      });
      res.status(200).json({ received: true });
      return;
    }
    const retryable =
      error instanceof SubscriptionError &&
      (error.retryable || error.kind === "configuration");
    logFailure("apple_subscription_notification", operationId, error);
    res.status(retryable ? 500 : 400).json({ received: false });
  }
}

export async function handleGoogleSubscriptionNotifications(
  message: functions.pubsub.Message,
  context: functions.EventContext
): Promise<void> {
  const operationId = crypto.randomUUID();
  logInfo("google_subscription_notification_start", operationId);

  try {
    const payload = parseRtdnPayload(message);
    if (payload.packageName !== GOOGLE_PACKAGE_NAME) {
      logWarning("google_subscription_notification_rejection", operationId, {
        code: "google-package-mismatch",
      });
      return;
    }

    const eventAt = parseGoogleEventTime(
      payload.eventTimeMillis,
      context.timestamp
    );
    const eventId = context.eventId;
    if (!eventId) {
      throw invalidNotification("google-event-id-missing");
    }

    if (payload.testNotification) {
      const event: StoreEvent = {
        key: eventId,
        platform: "google",
        environment: "test",
        eventType: "TEST",
        eventAt,
      };
      await recordUnclaimedStoreEvent(event);
      logInfo("google_subscription_notification_success", operationId, {
        eventType: event.eventType,
        environment: event.environment,
        claimed: false,
      });
      return;
    }

    if (payload.oneTimeProductNotification) {
      logWarning("google_subscription_notification_rejection", operationId, {
        code: "google-one-time-product-ignored",
      });
      return;
    }

    const notificationType = googleNotificationType(payload);
    const purchaseToken = googleNotificationPurchaseToken(payload);
    const currentToken = await resolveGoogleCurrentToken(purchaseToken);
    const verified = await verifyGoogleSubscription(
      currentToken,
      undefined,
      eventAt
    );
    if (
      (notificationType === "SUBSCRIPTION_REVOKED" ||
        notificationType === "VOIDED_PURCHASE") &&
      !verified.subscription.active
    ) {
      verified.subscription.status = "revoked";
    }

    const event: StoreEvent = {
      key: eventId,
      platform: "google",
      environment: verified.subscription.environment,
      eventType: notificationType,
      eventAt,
    };
    const ownerUid = await resolveVerifiedOwner(verified.ownership);
    if (!ownerUid) {
      await recordUnclaimedStoreEvent(event);
      logInfo("google_subscription_notification_success", operationId, {
        eventType: notificationType,
        environment: event.environment,
        claimed: false,
      });
      return;
    }

    const persisted = await persistVerifiedSubscription(
      ownerUid,
      verified,
      event
    );
    logInfo("google_subscription_notification_success", operationId, {
      eventType: notificationType,
      environment: event.environment,
      status: verified.subscription.status,
      active: verified.subscription.active,
      duplicate: persisted.duplicate,
      claimed: true,
    });
  } catch (error) {
    if (
      error instanceof SubscriptionError &&
      (error.kind === "invalid-input" ||
        error.kind === "invalid-store-data" ||
        error.kind === "ownership-conflict")
    ) {
      logWarning("google_subscription_notification_rejection", operationId, {
        code: error.safeCode,
      });
      return;
    }
    logFailure("google_subscription_notification", operationId, error);
    throw new Error(`Google subscription notification retry: ${safeErrorCode(error)}`);
  }
}

function requireAuthenticatedUid(
  context: functions.https.CallableContext
): string {
  if (!context.auth?.uid) {
    throw new functions.https.HttpsError(
      "unauthenticated",
      "Firebase Authentication is required."
    );
  }
  return context.auth.uid;
}

function readPlatform(
  data: unknown,
  exactKeys?: string[]
): SubscriptionPlatform {
  if (!isPlainRecord(data)) {
    throw new SubscriptionError(
      "invalid-input",
      "request-body-invalid",
      "The request body is invalid."
    );
  }
  if (exactKeys) {
    assertExactKeys(data, exactKeys);
  }
  if (data.platform !== "apple" && data.platform !== "google") {
    throw new SubscriptionError(
      "invalid-input",
      "platform-invalid",
      "The subscription platform is invalid."
    );
  }
  return data.platform;
}

function assertExactKeys(data: unknown, allowedKeys: string[]): void {
  if (!isPlainRecord(data)) {
    throw new SubscriptionError(
      "invalid-input",
      "request-body-invalid",
      "The request body is invalid."
    );
  }
  const actual = Object.keys(data).sort();
  const expected = [...allowedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new SubscriptionError(
      "invalid-input",
      "request-fields-invalid",
      "The request contains unsupported fields."
    );
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function requirePurchaseMaterial(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) {
    throw new SubscriptionError(
      "invalid-input",
      `${field}-invalid`,
      `The ${field} field is invalid.`
    );
  }
  return value;
}

function parseRtdnPayload(
  message: functions.pubsub.Message
): GoogleRtdnPayload {
  let value: unknown;
  try {
    value = message.json;
  } catch {
    throw invalidNotification("google-pubsub-json-invalid");
  }
  if (!isPlainRecord(value)) {
    throw invalidNotification("google-pubsub-payload-invalid");
  }
  return value as GoogleRtdnPayload;
}

function parseGoogleEventTime(value: unknown, fallback: string): Date {
  const millis =
    typeof value === "string" && /^\d+$/.test(value)
      ? Number(value)
      : Number.NaN;
  const parsed = Number.isSafeInteger(millis)
    ? new Date(millis)
    : new Date(fallback);
  if (!Number.isFinite(parsed.getTime())) {
    throw invalidNotification("google-event-time-invalid");
  }
  return parsed;
}

function googleNotificationType(payload: GoogleRtdnPayload): string {
  if (payload.subscriptionNotification) {
    const type = payload.subscriptionNotification.notificationType;
    if (typeof type !== "number" || !Number.isInteger(type)) {
      throw invalidNotification("google-notification-type-invalid");
    }
    return GOOGLE_NOTIFICATION_TYPES[type] ?? `SUBSCRIPTION_${type}`;
  }
  if (payload.voidedPurchaseNotification) {
    if (payload.voidedPurchaseNotification.productType !== 1) {
      throw invalidNotification("google-voided-product-not-subscription");
    }
    return "VOIDED_PURCHASE";
  }
  throw invalidNotification("google-subscription-notification-missing");
}

function googleNotificationPurchaseToken(
  payload: GoogleRtdnPayload
): string {
  const token =
    payload.subscriptionNotification?.purchaseToken ??
    payload.voidedPurchaseNotification?.purchaseToken;
  if (typeof token !== "string" || !token) {
    throw invalidNotification("google-purchase-token-missing");
  }
  return token;
}

const GOOGLE_NOTIFICATION_TYPES: Record<number, string> = {
  1: "SUBSCRIPTION_RECOVERED",
  2: "SUBSCRIPTION_RENEWED",
  3: "SUBSCRIPTION_CANCELED",
  4: "SUBSCRIPTION_PURCHASED",
  5: "SUBSCRIPTION_ON_HOLD",
  6: "SUBSCRIPTION_IN_GRACE_PERIOD",
  7: "SUBSCRIPTION_RESTARTED",
  8: "SUBSCRIPTION_PRICE_CHANGE_CONFIRMED",
  9: "SUBSCRIPTION_DEFERRED",
  10: "SUBSCRIPTION_PAUSED",
  11: "SUBSCRIPTION_PAUSE_SCHEDULE_CHANGED",
  12: "SUBSCRIPTION_REVOKED",
  13: "SUBSCRIPTION_EXPIRED",
  17: "SUBSCRIPTION_ITEMS_CHANGED",
  18: "SUBSCRIPTION_CANCELLATION_SCHEDULED",
  19: "SUBSCRIPTION_PRICE_CHANGE_UPDATED",
  20: "SUBSCRIPTION_PENDING_PURCHASE_CANCELED",
  22: "SUBSCRIPTION_PRICE_STEP_UP_CONSENT_UPDATED",
};

function invalidNotification(code: string): SubscriptionError {
  return new SubscriptionError(
    "invalid-store-data",
    code,
    "The store notification is invalid."
  );
}

function logCallableFailure(
  eventPrefix: string,
  operationId: string,
  platform: SubscriptionPlatform | undefined,
  error: unknown
): void {
  const fields = {
    ...(platform ? { platform } : {}),
    code: safeErrorCode(error),
  };
  if (
    error instanceof SubscriptionError &&
    (error.kind === "invalid-input" ||
      error.kind === "invalid-store-data" ||
      error.kind === "account-binding-mismatch" ||
      error.kind === "ownership-conflict")
  ) {
    logWarning(`${eventPrefix}_rejection`, operationId, fields);
  } else {
    logFailure(eventPrefix, operationId, error, fields);
  }
}

function logInfo(
  event: string,
  operationId: string,
  fields: Record<string, unknown> = {}
): void {
  functions.logger.info(event, { operationId, ...fields });
}

function logWarning(
  event: string,
  operationId: string,
  fields: Record<string, unknown> = {}
): void {
  functions.logger.warn(event, { operationId, ...fields });
}

function logFailure(
  eventPrefix: string,
  operationId: string,
  error: unknown,
  fields: Record<string, unknown> = {}
): void {
  functions.logger.error(`${eventPrefix}_failure`, {
    operationId,
    code: safeErrorCode(error),
    ...fields,
  });
}
