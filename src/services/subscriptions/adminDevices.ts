import { admin } from "../../config/admin";
import { SUBSCRIPTION_MASTER_COLLECTION } from "./persistence";
import { SubscriptionError } from "./errors";
import {
  AdminDeviceAction,
  DeviceActionResult,
  DeviceLimits,
  DeviceManagementResponse,
  DeviceState,
  MAX_EXTRA_DEVICE_SEATS,
  appendLog,
  applyDeviceAction,
  buildDeviceResponse,
  deviceStateFromMaster,
  deviceStateUpdate,
  subscriptionNotFound,
} from "./devices";

export type AdminDeviceMutation =
  | { action: "listDevices" }
  | { action: "removeDevice"; deviceId: string }
  | { action: "setExtraSeats"; seats: number }
  | { action: "resetDeviceCooldown" };

export interface AdminDeviceContext {
  uid: string;
  adminUid: string;
  /** Test seam; production uses the clock inside each transaction attempt. */
  now?: Date;
}

export function adminActor(adminUid: string): string {
  return `admin:${adminUid}`;
}

export function assertExtraSeats(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > MAX_EXTRA_DEVICE_SEATS
  ) {
    throw new SubscriptionError(
      "invalid-input",
      "seats-invalid",
      `seats must be an integer between 0 and ${MAX_EXTRA_DEVICE_SEATS}.`
    );
  }
  return value;
}

/**
 * Decides one admin device action. Every change is recorded in the device log
 * under `admin:<uid>`; there is no operation id because each action is
 * idempotent by nature, so a retried press changes nothing the second time.
 */
export function applyAdminDeviceAction(
  state: DeviceState,
  mutation: AdminDeviceMutation,
  limits: DeviceLimits,
  now: Date,
  adminUid: string
): DeviceActionResult {
  const actor = adminActor(adminUid);
  switch (mutation.action) {
    case "listDevices":
      return { changed: false, persist: false, state };
    case "removeDevice":
      return applyDeviceAction(
        state,
        { action: "unregister", deviceId: mutation.deviceId },
        limits,
        now,
        { actor, ignoreCooldown: true }
      );
    case "setExtraSeats": {
      const seats = assertExtraSeats(mutation.seats);
      if (seats === state.extraSeats) {
        return { changed: false, persist: false, state };
      }
      return {
        changed: true,
        persist: true,
        state: appendLog(
          { ...state, extraSeats: seats },
          { at: now, actor, action: "setExtraSeats", seats }
        ),
      };
    }
    case "resetDeviceCooldown": {
      if (!state.lastReplacedAt) {
        return { changed: false, persist: false, state };
      }
      return {
        changed: true,
        persist: true,
        state: appendLog(
          { ...state, lastReplacedAt: undefined },
          { at: now, actor, action: "resetDeviceCooldown" }
        ),
      };
    }
  }
}

/** Reads the master, applies the admin action and writes the device fields in one transaction. */
export async function adminManageDevices(
  context: AdminDeviceContext,
  mutation: AdminDeviceMutation,
  limits: DeviceLimits
): Promise<DeviceManagementResponse> {
  if (!context.uid) {
    throw new SubscriptionError("invalid-input", "uid-missing", "A uid is required.");
  }
  if (mutation.action === "setExtraSeats") {
    assertExtraSeats(mutation.seats);
  }

  const firestore = admin.firestore();
  const masterRef = firestore.collection(SUBSCRIPTION_MASTER_COLLECTION).doc(context.uid);

  return firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(masterRef);
    if (!snapshot.exists) {
      throw subscriptionNotFound();
    }
    const now = context.now ?? new Date();
    const state = deviceStateFromMaster(snapshot.data()!);
    const result = applyAdminDeviceAction(state, mutation, limits, now, context.adminUid);
    if (result.persist) {
      transaction.update(masterRef, deviceStateUpdate(state, result.state, now));
    }
    return buildDeviceResponse(
      mutation.action as AdminDeviceAction,
      result.changed,
      result.state,
      limits
    );
  });
}
