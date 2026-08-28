import * as functions from "firebase-functions";
import { DocumentData, Timestamp } from "firebase-admin/firestore";
import { admin } from "../../config/admin";
import { Settings } from "../../types";
import { SUBSCRIPTION_MASTER_COLLECTION } from "./persistence";
import { SubscriptionError } from "./errors";

export const DEFAULT_MAX_DEVICES = 2;
export const DEFAULT_REPLACEMENT_COOLDOWN_DAYS = 7;
export const MAX_DEVICE_ID_LENGTH = 128;

const DAY_MILLIS = 24 * 60 * 60 * 1000;

export type DeviceAction = "register" | "unregister";

export interface DeviceLimits {
  maxDevices: number;
  replacementCooldownDays: number;
}

export interface DeviceState {
  allowedDevices: string[];
  lastReplacedAt?: Date;
  extraSeats: number;
}

export interface DeviceActionResult {
  changed: boolean;
  allowedDevices: string[];
  lastReplacedAt?: Date;
}

export interface DeviceManagementResponse {
  action: DeviceAction;
  changed: boolean;
  allowed_devices: string[];
  max_number_of_devices: number;
  last_date_replacing_device?: string;
  next_replacement_allowed_at?: string;
}

export function resolveDeviceLimits(settings: Settings | undefined): DeviceLimits {
  return {
    maxDevices: positiveIntegerOr(
      settings?.subscription?.max_number_of_devices,
      DEFAULT_MAX_DEVICES
    ),
    replacementCooldownDays: positiveIntegerOr(
      settings?.subscription?.days_before_replacing_device,
      DEFAULT_REPLACEMENT_COOLDOWN_DAYS
    ),
  };
}

export function effectiveMaxDevices(
  limits: DeviceLimits,
  state: DeviceState
): number {
  return limits.maxDevices + state.extraSeats;
}

export function nextReplacementAllowedAt(
  lastReplacedAt: Date | undefined,
  limits: DeviceLimits
): Date | undefined {
  if (!lastReplacedAt) {
    return undefined;
  }
  return new Date(
    lastReplacedAt.getTime() + limits.replacementCooldownDays * DAY_MILLIS
  );
}

export function applyDeviceAction(
  state: DeviceState,
  action: DeviceAction,
  deviceId: string,
  limits: DeviceLimits,
  now: Date
): DeviceActionResult {
  const registered = state.allowedDevices.includes(deviceId);

  if (action === "register") {
    if (registered) {
      return {
        changed: false,
        allowedDevices: state.allowedDevices,
        lastReplacedAt: state.lastReplacedAt,
      };
    }
    const maxDevices = effectiveMaxDevices(limits, state);
    if (state.allowedDevices.length >= maxDevices) {
      throw new functions.https.HttpsError(
        "resource-exhausted",
        "The device limit for this subscription has been reached.",
        { code: "device-limit-reached", maxDevices }
      );
    }
    return {
      changed: true,
      allowedDevices: [...state.allowedDevices, deviceId],
      lastReplacedAt: state.lastReplacedAt,
    };
  }

  if (!registered) {
    return {
      changed: false,
      allowedDevices: state.allowedDevices,
      lastReplacedAt: state.lastReplacedAt,
    };
  }
  const nextAllowedAt = nextReplacementAllowedAt(state.lastReplacedAt, limits);
  if (nextAllowedAt && now.getTime() < nextAllowedAt.getTime()) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "A device was removed recently. Removing another one is not allowed yet.",
      {
        code: "device-replacement-cooldown",
        nextAllowedAt: nextAllowedAt.toISOString(),
      }
    );
  }
  return {
    changed: true,
    allowedDevices: state.allowedDevices.filter((id) => id !== deviceId),
    lastReplacedAt: now,
  };
}

export function deviceStateFromMaster(data: DocumentData): DeviceState {
  const allowedDevices = Array.isArray(data.allowed_devices)
    ? data.allowed_devices.filter(
      (value: unknown): value is string =>
        typeof value === "string" && value.length > 0
    )
    : [];
  const lastReplacedAt =
    data.last_date_replacing_device instanceof Timestamp
      ? data.last_date_replacing_device.toDate()
      : undefined;
  const extraSeats = positiveIntegerOr(data.extra_device_seats, 0);
  return { allowedDevices, lastReplacedAt, extraSeats };
}

export async function manageSubscriptionDevices(
  uid: string,
  action: DeviceAction,
  deviceId: string,
  limits: DeviceLimits
): Promise<DeviceManagementResponse> {
  if (!uid) {
    throw new SubscriptionError(
      "internal",
      "authenticated-uid-missing",
      "Authenticated UID is unavailable."
    );
  }

  const firestore = admin.firestore();
  const masterRef = firestore
    .collection(SUBSCRIPTION_MASTER_COLLECTION)
    .doc(uid);

  return firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(masterRef);
    if (!snapshot.exists) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "No subscription found for this account.",
        { code: "subscription-not-found" }
      );
    }

    const state = deviceStateFromMaster(snapshot.data()!);
    const now = new Date();
    const result = applyDeviceAction(state, action, deviceId, limits, now);

    if (result.changed) {
      const update: DocumentData = {
        allowed_devices: result.allowedDevices,
        updatedAt: Timestamp.fromDate(now),
      };
      if (action === "unregister") {
        update.last_date_replacing_device = Timestamp.fromDate(now);
      }
      transaction.update(masterRef, update);
    }

    const nextAllowedAt = nextReplacementAllowedAt(
      result.lastReplacedAt,
      limits
    );
    const response: DeviceManagementResponse = {
      action,
      changed: result.changed,
      allowed_devices: result.allowedDevices,
      max_number_of_devices: effectiveMaxDevices(limits, state),
    };
    if (result.lastReplacedAt) {
      response.last_date_replacing_device = result.lastReplacedAt.toISOString();
    }
    if (nextAllowedAt) {
      response.next_replacement_allowed_at = nextAllowedAt.toISOString();
    }
    return response;
  });
}

function positiveIntegerOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}
