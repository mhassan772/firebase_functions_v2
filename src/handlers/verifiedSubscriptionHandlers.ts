import * as crypto from "crypto";
import { Request, Response } from "express";
import * as functions from "firebase-functions";
import {
  SUBSCRIPTION_SECRETS,
  GOOGLE_PACKAGE_NAME,
} from "../config/constants";
import {
  SubscriptionPlatform,
  StoreEvent,
  VerifiedSubscription,
} from "../types/subscriptions";
import {
  accountBindingVersion,
  deriveAccountBinding,
} from "../services/subscriptions/crypto";
import {
  asCallableError,
  isCallerRefusal,
  safeErrorCode,
  SubscriptionError,
} from "../services/subscriptions/errors";
import {
  verifyAppleNotification,
  verifyAppleSubscription,
} from "../services/subscriptions/apple";
import { verifyGoogleSubscription } from "../services/subscriptions/google";
import {
  assertCallerMayClaim,
  persistVerifiedSubscription,
  recordUnclaimedStoreEvent,
  resolveGoogleCurrentToken,
  resolvePurchaseOwner,
  resolveVerifiedOwner,
} from "../services/subscriptions/persistence";
import { requireRuntimeSecret } from "../services/subscriptions/runtimeSecrets";
import {
  DeviceAction,
  DeviceActionInput,
  DeviceManagementResponse,
  isDevicePlatform,
  manageSubscriptionDevices,
  MAX_DEVICE_ID_LENGTH,
  MAX_DEVICE_NAME_LENGTH,
  readDeviceLimits,
  USER_ACTOR,
} from "../services/subscriptions/devices";
import { DevicePlatform } from "../types/subscriptions";

export interface GoogleRtdnPayload {
  packageName?: unknown;
  eventTimeMillis?: unknown;
  subscriptionNotification?: {
    notificationType?: unknown;
    purchaseToken?: unknown;
  };
  voidedPurchaseNotification?: {
    purchaseToken?: unknown;
    productType?: unknown;
    refundType?: unknown;
  };
  pendingRefundReviewNotification?: {
    refundReason?: unknown;
  };
  oneTimeProductNotification?: unknown;
  testNotification?: unknown;
}

/** What a Play notification asks the handler to do, decided before any store or Firestore call. */
export type GoogleRtdnClassification =
  | { kind: "test" }
  | { kind: "oneTimeProduct" }
  | { kind: "pendingRefundReview"; refundReason?: number }
  | {
    kind: "store";
    notificationType: string;
    purchaseToken: string;
    refundType?: number;
  }
  | { kind: "unknown"; payloadKeys: string[] };

const MAX_LOGGED_PAYLOAD_KEYS = 10;

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
    await assertCallerMayClaim(uid, verified, accountBindingSecret);
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

export async function handleManageSubscriptionDevice(
  data: unknown,
  context: functions.https.CallableContext
): Promise<{ devices: DeviceManagementResponse }> {
  const operationId = crypto.randomUUID();
  let action: DeviceAction | undefined;
  try {
    if (!isPlainRecord(data)) {
      throw new SubscriptionError(
        "invalid-input",
        "request-body-invalid",
        "The request body is invalid."
      );
    }
    action = readDeviceAction(data.action);
    const input = readDeviceActionInput(action, data);
    const uid = requireAuthenticatedUid(context);
    logInfo("subscription_device_start", operationId, { action });
    const limits = await readDeviceLimits();
    const devices = await manageSubscriptionDevices(uid, input, limits, {
      actor: USER_ACTOR,
    });
    logInfo("subscription_device_success", operationId, {
      action,
      changed: devices.changed,
      deviceCount: devices.allowed_devices.length,
    });
    return { devices };
  } catch (error) {
    logCallableFailure("subscription_device", operationId, undefined, error);
    throw asCallableError(error);
  }
}

/**
 * Validates the exact field set of one device action. `name` is optional and
 * display-only; `platform` is required wherever a device is being added,
 * because the list is shown to the user with a platform icon.
 */
export function readDeviceActionInput(
  action: DeviceAction,
  request: Record<string, unknown>
): DeviceActionInput {
  const nameKey = request.name !== undefined ? ["name"] : [];
  switch (action) {
    case "list":
      assertExactKeys(request, ["action"]);
      return { action };
    case "unregister":
      assertExactKeys(request, ["action", "deviceId"]);
      return { action, deviceId: readDeviceId(request.deviceId) };
    case "register":
      assertExactKeys(request, ["action", "deviceId", "platform", ...nameKey]);
      return {
        action,
        deviceId: readDeviceId(request.deviceId),
        name: readDeviceName(request.name),
        platform: readDevicePlatform(request.platform),
      };
    case "replace": {
      assertExactKeys(request, [
        "action",
        "deviceId",
        "removeDeviceId",
        "platform",
        ...nameKey,
      ]);
      const deviceId = readDeviceId(request.deviceId);
      const removeDeviceId = readDeviceId(request.removeDeviceId);
      if (deviceId === removeDeviceId) {
        throw new SubscriptionError(
          "invalid-input",
          "device-id-invalid",
          "A device cannot replace itself."
        );
      }
      return {
        action,
        deviceId,
        removeDeviceId,
        name: readDeviceName(request.name),
        platform: readDevicePlatform(request.platform),
      };
    }
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
      stateApplied: persisted.stateApplied,
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

    const classification = classifyGoogleRtdn(payload);
    if (classification.kind === "test") {
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

    if (classification.kind === "oneTimeProduct") {
      logWarning("google_subscription_notification_rejection", operationId, {
        code: "google-one-time-product-ignored",
      });
      return;
    }

    if (classification.kind === "pendingRefundReview") {
      // Play decides the chargeback itself when nobody answers through
      // orders.reviewRefund; the outcome arrives later as a voided purchase.
      logInfo("google_subscription_notification_ignored", operationId, {
        kind: classification.kind,
        refundReason: classification.refundReason,
      });
      return;
    }

    if (classification.kind === "unknown") {
      logWarning("google_subscription_notification_rejection", operationId, {
        code: "google-subscription-notification-missing",
        payloadKeys: classification.payloadKeys,
      });
      return;
    }

    await applyGoogleStoreEvent({
      purchaseToken: classification.purchaseToken,
      eventType: classification.notificationType,
      eventKey: eventId,
      eventAt,
      refundType: classification.refundType,
      operationId,
      logEvent: "google_subscription_notification_success",
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

export interface GoogleStoreEventInput {
  purchaseToken: string;
  /** The RTDN type name, or `VOIDED_PURCHASE` for a voided-purchases entry. */
  eventType: string;
  /** Dedupe key: the Pub/Sub event id, or `voided:<orderId>` from the voided list. */
  eventKey: string;
  eventAt: Date;
  refundType?: number;
  operationId: string;
  /** The success log's event name, so each caller's logs stay distinguishable. */
  logEvent: string;
}

export interface GoogleStoreEventOutcome {
  claimed: boolean;
  duplicate: boolean;
  stateApplied: boolean;
}

/**
 * Applies one Play store event: the notification handler and the recovery
 * pass both go through here, so a replayed event is treated exactly like a
 * live one. Verifies the chain's current token, maps a void or revoke onto a
 * lapsed state, resolves the owner (through the expired token for a Play
 * Store resubscription), then persists or records the event unclaimed.
 */
export async function applyGoogleStoreEvent(
  input: GoogleStoreEventInput
): Promise<GoogleStoreEventOutcome> {
  const currentToken = await resolveGoogleCurrentToken(input.purchaseToken);
  const verified = await verifyGoogleSubscription(
    currentToken,
    undefined,
    input.eventAt
  );
  if (
    (input.eventType === "SUBSCRIPTION_REVOKED" ||
      input.eventType === "VOIDED_PURCHASE") &&
    !verified.subscription.active
  ) {
    verified.subscription.status = "revoked";
  }

  const event: StoreEvent = {
    key: input.eventKey,
    platform: "google",
    environment: verified.subscription.environment,
    eventType: input.eventType,
    eventAt: input.eventAt,
    purchaseReference: verified.subscription.purchaseReference,
    ...(input.refundType !== undefined ? { refundType: input.refundType } : {}),
  };
  const ownerUid = await resolvePurchaseOwner(verified, accountBindingSecret);
  if (!ownerUid) {
    const recorded = await recordUnclaimedStoreEvent(event);
    logInfo(input.logEvent, input.operationId, {
      eventType: input.eventType,
      environment: event.environment,
      ...googleStateLogFields(verified, input.refundType),
      duplicate: !recorded,
      claimed: false,
    });
    return { claimed: false, duplicate: !recorded, stateApplied: false };
  }

  const persisted = await persistVerifiedSubscription(ownerUid, verified, event);
  logInfo(input.logEvent, input.operationId, {
    eventType: input.eventType,
    environment: event.environment,
    status: verified.subscription.status,
    active: verified.subscription.active,
    ...googleStateLogFields(verified, input.refundType),
    duplicate: persisted.duplicate,
    stateApplied: persisted.stateApplied,
    claimed: true,
  });
  return {
    claimed: true,
    duplicate: persisted.duplicate,
    stateApplied: persisted.stateApplied,
  };
}

/** Read on demand: only a resubscription whose expired purchase carried a binding needs it. */
function accountBindingSecret(): string {
  return requireRuntimeSecret(SUBSCRIPTION_SECRETS.accountBindingHmacKey);
}

export function requireAuthenticatedUid(
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

function readDeviceAction(value: unknown): DeviceAction {
  if (
    value !== "register" &&
    value !== "unregister" &&
    value !== "replace" &&
    value !== "list"
  ) {
    throw new SubscriptionError(
      "invalid-input",
      "device-action-invalid",
      "The device action is invalid."
    );
  }
  return value;
}

export function readDeviceId(value: unknown): string {
  const deviceId = typeof value === "string" ? value.trim() : "";
  if (!deviceId || deviceId.length > MAX_DEVICE_ID_LENGTH) {
    throw new SubscriptionError(
      "invalid-input",
      "device-id-invalid",
      "The deviceId field is invalid."
    );
  }
  return deviceId;
}

function readDeviceName(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  if (typeof value !== "string") {
    throw deviceNameInvalid();
  }
  const name = value.trim();
  if (name.length > MAX_DEVICE_NAME_LENGTH) {
    throw deviceNameInvalid();
  }
  return name;
}

function deviceNameInvalid(): SubscriptionError {
  return new SubscriptionError(
    "invalid-input",
    "device-name-invalid",
    `The name field must be a string of at most ${MAX_DEVICE_NAME_LENGTH} characters.`
  );
}

function readDevicePlatform(value: unknown): DevicePlatform {
  if (!isDevicePlatform(value)) {
    throw new SubscriptionError(
      "invalid-input",
      "device-platform-invalid",
      "The platform field must be ios or android."
    );
  }
  return value;
}

export function assertExactKeys(data: unknown, allowedKeys: string[]): void {
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

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
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

/**
 * Sorts a Play notification into what the handler does with it.
 *
 * The checks keep the handler's original order. A payload with none of the
 * known fields comes back as unknown with its top-level key names, never
 * their values, so the log can say what Play sent without carrying tokens.
 */
export function classifyGoogleRtdn(
  payload: GoogleRtdnPayload
): GoogleRtdnClassification {
  if (payload.testNotification) {
    return { kind: "test" };
  }
  if (payload.oneTimeProductNotification) {
    return { kind: "oneTimeProduct" };
  }
  if (payload.pendingRefundReviewNotification) {
    return {
      kind: "pendingRefundReview",
      refundReason: optionalInteger(
        payload.pendingRefundReviewNotification.refundReason
      ),
    };
  }
  if (payload.subscriptionNotification) {
    const type = payload.subscriptionNotification.notificationType;
    if (typeof type !== "number" || !Number.isInteger(type)) {
      throw invalidNotification("google-notification-type-invalid");
    }
    return {
      kind: "store",
      notificationType:
        GOOGLE_NOTIFICATION_TYPES[type] ?? `SUBSCRIPTION_${type}`,
      purchaseToken: requireNotificationToken(
        payload.subscriptionNotification.purchaseToken
      ),
    };
  }
  if (payload.voidedPurchaseNotification) {
    if (payload.voidedPurchaseNotification.productType !== 1) {
      throw invalidNotification("google-voided-product-not-subscription");
    }
    return {
      kind: "store",
      notificationType: "VOIDED_PURCHASE",
      purchaseToken: requireNotificationToken(
        payload.voidedPurchaseNotification.purchaseToken
      ),
      refundType: optionalInteger(
        payload.voidedPurchaseNotification.refundType
      ),
    };
  }
  return {
    kind: "unknown",
    payloadKeys: Object.keys(payload)
      .filter((key) => /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(key))
      .sort()
      .slice(0, MAX_LOGGED_PAYLOAD_KEYS),
  };
}

function requireNotificationToken(token: unknown): string {
  if (typeof token !== "string" || !token) {
    throw invalidNotification("google-purchase-token-missing");
  }
  return token;
}

function optionalInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : undefined;
}

/** Store state behind a notification, so a void followed by a renewal can be read back from the logs. */
function googleStateLogFields(
  verified: VerifiedSubscription,
  refundType: number | undefined
): Record<string, unknown> {
  return {
    purchaseReference: verified.subscription.purchaseReference,
    expiresAt: verified.subscription.expiresAt.toISOString(),
    autoRenewing: verified.subscription.autoRenewing,
    ...(refundType !== undefined ? { refundType } : {}),
  };
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
  if (isCallerRefusal(error)) {
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
