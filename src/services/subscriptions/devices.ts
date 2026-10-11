import * as functions from "firebase-functions";
import { DocumentData, FieldValue, Timestamp } from "firebase-admin/firestore";
import { admin } from "../../config/admin";
import {
  DeviceEntryResponse,
  DevicePlatform,
  SubscriptionDevicesResponse,
} from "../../types/subscriptions";
import { SUBSCRIPTION_MASTER_COLLECTION, withoutUndefined } from "./persistence";
import { SubscriptionError } from "./errors";

export const DEFAULT_MAX_DEVICES = 2;
export const DEFAULT_REPLACEMENT_COOLDOWN_DAYS = 7;
export const MAX_DEVICE_ID_LENGTH = 128;
export const MAX_DEVICE_NAME_LENGTH = 64;
export const MAX_DEVICE_LOG_ENTRIES = 20;
export const MAX_EXTRA_DEVICE_SEATS = 10;
/** A listed device is stamped again only when its last visit is older than this, so a daily launch writes nothing. */
export const DEVICE_TOUCH_INTERVAL_MILLIS = 24 * 60 * 60 * 1000;
/** The actor recorded for the user's own callable; admins are `admin:<uid>`. */
export const USER_ACTOR = "user";

const DAY_MILLIS = 24 * 60 * 60 * 1000;
const DEVICE_PLATFORMS: readonly DevicePlatform[] = ["ios", "android"];

export type DeviceAction = "register" | "unregister" | "replace" | "list";
export type AdminDeviceAction =
  | "listDevices"
  | "removeDevice"
  | "setExtraSeats"
  | "resetDeviceCooldown";

export interface DeviceLimits {
  maxDevices: number;
  replacementCooldownDays: number;
}

/** Display data for one seat; membership is decided by `allowedDevices` alone. */
export interface DeviceRecord {
  name: string;
  platform: DevicePlatform;
  registeredAt: Date;
  lastSeenAt: Date;
}

export interface DeviceLogEntry {
  at: Date;
  actor: string;
  action: string;
  deviceId?: string;
  removedDeviceId?: string;
  seats?: number;
}

export interface DeviceState {
  allowedDevices: string[];
  devices: Record<string, DeviceRecord>;
  deviceLog: DeviceLogEntry[];
  lastReplacedAt?: Date;
  extraSeats: number;
}

export interface DeviceDescriptor {
  deviceId: string;
  name: string;
  platform: DevicePlatform;
}

export type DeviceActionInput =
  | ({ action: "register" } & DeviceDescriptor)
  | { action: "unregister"; deviceId: string }
  | ({ action: "replace"; removeDeviceId: string } & DeviceDescriptor)
  | { action: "list" };

export interface DeviceActionOptions {
  /** Who is recorded in the log: `user`, or `admin:<uid>`. */
  actor: string;
  /** Admin removals free a seat without consuming or checking the user's cooldown. */
  ignoreCooldown?: boolean;
}

export interface DeviceActionResult {
  /** Membership, seats or the cooldown changed. */
  changed: boolean;
  /** Something must be written; a daily touch persists without changing membership. */
  persist: boolean;
  state: DeviceState;
}

export interface DeviceManagementResponse {
  action: DeviceAction | AdminDeviceAction;
  changed: boolean;
  max_number_of_devices: number;
  allowed_devices: string[];
  devices: DeviceEntryResponse[];
  last_date_replacing_device?: string;
  next_replacement_allowed_at?: string;
}

/** The public document the app reads too, so both sides show one number. */
export const DEVICE_LIMIT_SETTINGS_COLLECTION = "settings_app";
export const DEVICE_LIMIT_SETTINGS_DOCUMENT = "subscription";

/** Parses the public subscription settings document; anything missing or invalid keeps the default. */
export function resolveDeviceLimits(
  data: DocumentData | undefined
): DeviceLimits {
  return {
    maxDevices: positiveIntegerOr(
      data?.max_number_of_devices,
      DEFAULT_MAX_DEVICES
    ),
    // Zero is a real choice here: no cooldown at all.
    replacementCooldownDays: nonNegativeIntegerOr(
      data?.days_before_replacing_device,
      DEFAULT_REPLACEMENT_COOLDOWN_DAYS
    ),
  };
}

/** Reads the limits from `settings_app/subscription`; one read per call. */
export async function readDeviceLimits(): Promise<DeviceLimits> {
  const snapshot = await admin
    .firestore()
    .collection(DEVICE_LIMIT_SETTINGS_COLLECTION)
    .doc(DEVICE_LIMIT_SETTINGS_DOCUMENT)
    .get();
  return resolveDeviceLimits(snapshot.data());
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

/**
 * Decides one device action against the parsed state and returns the state to
 * write. Pure, so the transaction can retry it and the admin path can reuse it.
 *
 * `replace` is an unregister followed by a register on the same state, so a
 * refused register leaves the removed seat untouched: nothing is written.
 */
export function applyDeviceAction(
  state: DeviceState,
  input: DeviceActionInput,
  limits: DeviceLimits,
  now: Date,
  options: DeviceActionOptions
): DeviceActionResult {
  switch (input.action) {
    case "list":
      return { changed: false, persist: false, state };
    case "register": {
      const result = registerDevice(state, input, limits, now);
      if (!result.changed) {
        return result;
      }
      return {
        ...result,
        state: appendLog(result.state, {
          at: now,
          actor: options.actor,
          action: "register",
          deviceId: input.deviceId,
        }),
      };
    }
    case "unregister": {
      const result = unregisterDevice(
        state,
        input.deviceId,
        limits,
        now,
        options.ignoreCooldown === true
      );
      if (!result.changed) {
        return { changed: false, persist: false, state };
      }
      return {
        changed: true,
        persist: true,
        state: appendLog(result.state, {
          at: now,
          actor: options.actor,
          action: "unregister",
          deviceId: input.deviceId,
        }),
      };
    }
    case "replace": {
      const removed = unregisterDevice(
        state,
        input.removeDeviceId,
        limits,
        now,
        options.ignoreCooldown === true
      );
      const added = registerDevice(removed.state, input, limits, now);
      const changed = removed.changed || added.changed;
      if (!changed) {
        return added;
      }
      return {
        changed: true,
        persist: true,
        state: appendLog(added.state, {
          at: now,
          actor: options.actor,
          action: "replace",
          deviceId: input.deviceId,
          removedDeviceId: input.removeDeviceId,
        }),
      };
    }
  }
}

function registerDevice(
  state: DeviceState,
  device: DeviceDescriptor,
  limits: DeviceLimits,
  now: Date
): DeviceActionResult {
  const existing = state.devices[device.deviceId];
  if (state.allowedDevices.includes(device.deviceId)) {
    const stale =
      !existing ||
      now.getTime() - existing.lastSeenAt.getTime() >= DEVICE_TOUCH_INTERVAL_MILLIS;
    if (!stale) {
      return { changed: false, persist: false, state };
    }
    // A touch refreshes what the user sees; the platform never changes and
    // the registration date is kept so the list stays in registration order.
    const record: DeviceRecord = {
      name: device.name,
      platform: existing?.platform ?? device.platform,
      registeredAt: existing?.registeredAt ?? now,
      lastSeenAt: now,
    };
    return {
      changed: false,
      persist: true,
      state: { ...state, devices: { ...state.devices, [device.deviceId]: record } },
    };
  }

  const maxDevices = effectiveMaxDevices(limits, state);
  if (state.allowedDevices.length >= maxDevices) {
    // The refused device shows the holders and, when a removal is still
    // blocked, says until when, so the sheet needs no second round trip.
    const nextAllowedAt = nextReplacementAllowedAt(state.lastReplacedAt, limits);
    throw new functions.https.HttpsError(
      "resource-exhausted",
      "The device limit for this subscription has been reached.",
      {
        code: "device-limit-reached",
        maxDevices,
        devices: deviceEntries(state),
        ...(nextAllowedAt && now.getTime() < nextAllowedAt.getTime()
          ? { nextAllowedAt: nextAllowedAt.toISOString() }
          : {}),
      }
    );
  }
  return {
    changed: true,
    persist: true,
    state: {
      ...state,
      allowedDevices: [...state.allowedDevices, device.deviceId],
      devices: {
        ...state.devices,
        [device.deviceId]: {
          name: device.name,
          platform: device.platform,
          registeredAt: now,
          lastSeenAt: now,
        },
      },
    },
  };
}

function unregisterDevice(
  state: DeviceState,
  deviceId: string,
  limits: DeviceLimits,
  now: Date,
  ignoreCooldown: boolean
): { changed: boolean; state: DeviceState } {
  if (!state.allowedDevices.includes(deviceId)) {
    return { changed: false, state };
  }
  if (!ignoreCooldown) {
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
  }
  const devices = { ...state.devices };
  delete devices[deviceId];
  return {
    changed: true,
    state: {
      ...state,
      allowedDevices: state.allowedDevices.filter((id) => id !== deviceId),
      devices,
      // An admin freeing a seat is not the user juggling seats, so it does
      // not start the user's cooldown.
      lastReplacedAt: ignoreCooldown ? state.lastReplacedAt : now,
    },
  };
}

export function appendLog(state: DeviceState, entry: DeviceLogEntry): DeviceState {
  return {
    ...state,
    deviceLog: [...state.deviceLog, entry].slice(-MAX_DEVICE_LOG_ENTRIES),
  };
}

/**
 * Registering needs a live entitlement: the master must say `active` and its
 * expiry must be ahead. A lapsed manual grant keeps `active: true` on the
 * master with no write to flip it, so the date is checked as well.
 */
export function assertMasterActive(data: DocumentData, now: Date): void {
  const expiresAt =
    data.expiresAt instanceof Timestamp ? data.expiresAt.toDate() : undefined;
  if (data.active !== true || !expiresAt || expiresAt.getTime() <= now.getTime()) {
    throw new SubscriptionError(
      "precondition",
      "subscription-not-active",
      "The subscription is not active."
    );
  }
}

export function subscriptionNotFound(): SubscriptionError {
  return new SubscriptionError(
    "precondition",
    "subscription-not-found",
    "No subscription found for this account."
  );
}

/** Reads the device fields off a master document; anything missing or malformed reads as empty. */
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
  return {
    allowedDevices,
    devices: devicesFromData(data.devices),
    deviceLog: deviceLogFromData(data.device_log),
    lastReplacedAt,
    extraSeats,
  };
}

function devicesFromData(value: unknown): Record<string, DeviceRecord> {
  const devices: Record<string, DeviceRecord> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return devices;
  }
  for (const [deviceId, row] of Object.entries(value as Record<string, unknown>)) {
    const record = deviceRecordFromData(row);
    if (deviceId && record) {
      devices[deviceId] = record;
    }
  }
  return devices;
}

function deviceRecordFromData(value: unknown): DeviceRecord | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const row = value as Record<string, unknown>;
  const registeredAt =
    row.registeredAt instanceof Timestamp ? row.registeredAt.toDate() : undefined;
  const lastSeenAt =
    row.lastSeenAt instanceof Timestamp ? row.lastSeenAt.toDate() : undefined;
  if (!isDevicePlatform(row.platform) || !registeredAt || !lastSeenAt) {
    return undefined;
  }
  return {
    name: typeof row.name === "string" ? row.name : "",
    platform: row.platform,
    registeredAt,
    lastSeenAt,
  };
}

function deviceLogFromData(value: unknown): DeviceLogEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const entries: DeviceLogEntry[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const row = item as Record<string, unknown>;
    if (
      !(row.at instanceof Timestamp) ||
      typeof row.actor !== "string" ||
      typeof row.action !== "string"
    ) {
      continue;
    }
    entries.push(
      withoutUndefined({
        at: row.at.toDate(),
        actor: row.actor,
        action: row.action,
        deviceId: typeof row.deviceId === "string" ? row.deviceId : undefined,
        removedDeviceId:
          typeof row.removedDeviceId === "string" ? row.removedDeviceId : undefined,
        seats: typeof row.seats === "number" ? row.seats : undefined,
      })
    );
  }
  return entries.slice(-MAX_DEVICE_LOG_ENTRIES);
}

export function isDevicePlatform(value: unknown): value is DevicePlatform {
  return DEVICE_PLATFORMS.includes(value as DevicePlatform);
}

/**
 * The fields to write after an action, diffed against the state that was read
 * so a user action never writes `extra_device_seats` and an admin seat change
 * never rewrites the cooldown.
 */
export function deviceStateUpdate(
  before: DeviceState,
  after: DeviceState,
  now: Date
): DocumentData {
  const devices: DocumentData = {};
  for (const deviceId of after.allowedDevices) {
    const record = after.devices[deviceId];
    if (record) {
      devices[deviceId] = {
        name: record.name,
        platform: record.platform,
        registeredAt: Timestamp.fromDate(record.registeredAt),
        lastSeenAt: Timestamp.fromDate(record.lastSeenAt),
      };
    }
  }
  const update: DocumentData = {
    allowed_devices: after.allowedDevices,
    devices,
    device_log: after.deviceLog.slice(-MAX_DEVICE_LOG_ENTRIES).map((entry) =>
      withoutUndefined({
        at: Timestamp.fromDate(entry.at),
        actor: entry.actor,
        action: entry.action,
        deviceId: entry.deviceId,
        removedDeviceId: entry.removedDeviceId,
        seats: entry.seats,
      })
    ),
    updatedAt: Timestamp.fromDate(now),
  };
  if (before.lastReplacedAt?.getTime() !== after.lastReplacedAt?.getTime()) {
    update.last_date_replacing_device = after.lastReplacedAt
      ? Timestamp.fromDate(after.lastReplacedAt)
      : FieldValue.delete();
  }
  if (before.extraSeats !== after.extraSeats) {
    update.extra_device_seats = after.extraSeats;
  }
  return update;
}

/** One row per listed id, in registration order; a bare legacy id has no metadata. */
export function deviceEntries(state: DeviceState): DeviceEntryResponse[] {
  return state.allowedDevices.map((id) => {
    const record = state.devices[id];
    if (!record) {
      return { id, name: "", platform: "unknown" };
    }
    return {
      id,
      name: record.name,
      platform: record.platform,
      registered_at: record.registeredAt.toISOString(),
      last_seen_at: record.lastSeenAt.toISOString(),
    };
  });
}

export function buildDeviceResponse(
  action: DeviceAction | AdminDeviceAction,
  changed: boolean,
  state: DeviceState,
  limits: DeviceLimits
): DeviceManagementResponse {
  const nextAllowedAt = nextReplacementAllowedAt(state.lastReplacedAt, limits);
  return withoutUndefined({
    action,
    changed,
    max_number_of_devices: effectiveMaxDevices(limits, state),
    allowed_devices: state.allowedDevices,
    devices: deviceEntries(state),
    last_date_replacing_device: state.lastReplacedAt?.toISOString(),
    next_replacement_allowed_at: nextAllowedAt?.toISOString(),
  });
}

/** The device block carried on every subscription response; the limit is included only when the settings were read. */
export function devicesBlockFromMaster(
  data: DocumentData,
  limits?: DeviceLimits
): SubscriptionDevicesResponse {
  const state = deviceStateFromMaster(data);
  return withoutUndefined({
    allowed_devices: state.allowedDevices,
    devices: deviceEntries(state),
    max_number_of_devices: limits ? effectiveMaxDevices(limits, state) : undefined,
    extra_device_seats: state.extraSeats,
    last_date_replacing_device: state.lastReplacedAt?.toISOString(),
  });
}

export interface ManageDevicesOptions extends DeviceActionOptions {
  /** Test seam; production uses the clock inside each transaction attempt. */
  now?: Date;
}

export async function manageSubscriptionDevices(
  uid: string,
  input: DeviceActionInput,
  limits: DeviceLimits,
  options: ManageDevicesOptions = { actor: USER_ACTOR }
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
      throw subscriptionNotFound();
    }
    const data = snapshot.data()!;
    const now = options.now ?? new Date();
    if (input.action === "register" || input.action === "replace") {
      assertMasterActive(data, now);
    }

    const state = deviceStateFromMaster(data);
    const result = applyDeviceAction(state, input, limits, now, options);
    if (result.persist) {
      transaction.update(masterRef, deviceStateUpdate(state, result.state, now));
    }
    return buildDeviceResponse(input.action, result.changed, result.state, limits);
  });
}

function positiveIntegerOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

function nonNegativeIntegerOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : fallback;
}
