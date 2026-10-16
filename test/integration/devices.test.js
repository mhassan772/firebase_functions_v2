// Device seats against the Firestore and Auth emulators. Run with
// `npm run test:integration`, which starts both under a demo project, so nothing here can
// reach real data or a real store.
const assert = require("node:assert/strict");
const { beforeEach, describe, test } = require("node:test");

assert.ok(process.env.FIRESTORE_EMULATOR_HOST, "FIRESTORE_EMULATOR_HOST must point at the emulator");
assert.ok(process.env.FIREBASE_AUTH_EMULATOR_HOST, "FIREBASE_AUTH_EMULATOR_HOST must point at the emulator");

const { admin } = require("../../lib/config/admin");
const {
  persistVerifiedSubscription,
  SUBSCRIPTION_MASTER_COLLECTION,
} = require("../../lib/services/subscriptions/persistence");
const { manageSubscriptionDevices } = require("../../lib/services/subscriptions/devices");
const { adminManageDevices } = require("../../lib/services/subscriptions/adminDevices");
const { applyManualMutation } = require("../../lib/services/subscriptions/manual");
const { SubscriptionError } = require("../../lib/services/subscriptions/errors");

const db = () => admin.firestore();
const DAY = 24 * 60 * 60 * 1000;
const LIMITS = { maxDevices: 2, replacementCooldownDays: 7 };
const USER = { actor: "user" };

function googleVerified(uid, expiresAt, eventAt = new Date()) {
  return {
    subscription: {
      active: expiresAt.getTime() > Date.now(),
      status: expiresAt.getTime() > Date.now() ? "active" : "expired",
      platform: "google",
      productId: "premium_access",
      expiresAt,
      autoRenewing: true,
      inGracePeriod: false,
      environment: "production",
      purchaseReference: `ref-${uid}`,
      lastStoreEventAt: eventAt,
      lastVerifiedAt: eventAt,
    },
    ownership: [
      {
        platform: "google",
        environment: "production",
        purchaseToken: `token-${uid}`,
        currentPurchaseToken: `token-${uid}`,
      },
    ],
  };
}

async function clearFirestore() {
  const response = await fetch(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-mantooq/databases/(default)/documents`,
    { method: "DELETE" }
  );
  assert.ok(response.ok, `clearing Firestore failed: ${response.status}`);
}

async function ensureUser(uid, email) {
  try {
    await admin.auth().getUser(uid);
  } catch {
    await admin.auth().createUser({ uid, email });
  }
}

async function master(uid) {
  const snapshot = await db().collection(SUBSCRIPTION_MASTER_COLLECTION).doc(uid).get();
  return snapshot.exists ? snapshot.data() : undefined;
}

const register = (uid, deviceId, name, platform, options = USER) =>
  manageSubscriptionDevices(uid, { action: "register", deviceId, name, platform }, LIMITS, options);
const replace = (uid, removeDeviceId, deviceId, name, platform) =>
  manageSubscriptionDevices(uid, { action: "replace", removeDeviceId, deviceId, name, platform }, LIMITS, USER);
const list = (uid) => manageSubscriptionDevices(uid, { action: "list" }, LIMITS, USER);
const ids = (response) => response.devices.map((device) => device.id);
const names = (response) => response.devices.map((device) => device.name);

const safeCode = (code) => (error) => error instanceof SubscriptionError && error.safeCode === code;

beforeEach(async () => {
  await clearFirestore();
});

describe("device seats on an active subscription", () => {
  const uid = "user-devices";

  test("two devices register, the third is refused with the list, replace swaps once per cooldown, admin resets it", async () => {
    await ensureUser(uid, "devices@example.test");
    await persistVerifiedSubscription(uid, googleVerified(uid, new Date(Date.now() + 400 * DAY)));

    const first = await register(uid, "phone-a", "iPhone", "ios");
    assert.equal(first.changed, true);
    assert.deepEqual(first.allowed_devices, ["phone-a"]);
    assert.equal(first.max_number_of_devices, 2);
    assert.equal(first.devices[0].platform, "ios");
    assert.ok(first.devices[0].registered_at);

    const second = await register(uid, "phone-b", "Pixel 7", "android");
    assert.deepEqual(second.allowed_devices, ["phone-a", "phone-b"]);
    assert.deepEqual(names(second), ["iPhone", "Pixel 7"]);

    // The same device again within the day writes nothing.
    const before = await master(uid);
    const again = await register(uid, "phone-a", "Renamed", "ios");
    assert.equal(again.changed, false);
    assert.deepEqual(names(again), ["iPhone", "Pixel 7"]);
    assert.deepEqual(await master(uid), before);

    // A third device is refused and told what holds the seats.
    await assert.rejects(
      register(uid, "tablet-c", "iPad", "ios"),
      (error) =>
        error.code === "resource-exhausted" &&
        error.details.code === "device-limit-reached" &&
        error.details.maxDevices === 2 &&
        error.details.devices.map((device) => device.id).join(",") === "phone-a,phone-b" &&
        error.details.devices[1].name === "Pixel 7"
    );
    assert.deepEqual((await master(uid)).allowed_devices, ["phone-a", "phone-b"]);

    // Replace takes the seat in one step.
    const replaced = await replace(uid, "phone-a", "tablet-c", "iPad", "ios");
    assert.equal(replaced.changed, true);
    assert.deepEqual(replaced.allowed_devices, ["phone-b", "tablet-c"]);
    assert.deepEqual(names(replaced), ["Pixel 7", "iPad"]);
    assert.ok(replaced.last_date_replacing_device);
    assert.ok(replaced.next_replacement_allowed_at > replaced.last_date_replacing_device);
    const stored = await master(uid);
    assert.deepEqual(Object.keys(stored.devices).sort(), ["phone-b", "tablet-c"]);
    assert.deepEqual(
      stored.device_log.map((row) => [row.actor, row.action, row.deviceId, row.removedDeviceId]),
      [
        ["user", "register", "phone-a", undefined],
        ["user", "register", "phone-b", undefined],
        ["user", "replace", "tablet-c", "phone-a"],
      ]
    );

    // A second replace inside the window is refused and writes nothing.
    await assert.rejects(
      replace(uid, "phone-b", "phone-d", "Galaxy", "android"),
      (error) =>
        error.code === "failed-precondition" &&
        error.details.code === "device-replacement-cooldown" &&
        error.details.nextAllowedAt === replaced.next_replacement_allowed_at
    );
    assert.deepEqual(ids(await list(uid)), ["phone-b", "tablet-c"]);

    // The admin clears the cooldown; the user can replace again.
    const reset = await adminManageDevices({ uid, adminUid: "admin-1" }, { action: "resetDeviceCooldown" }, LIMITS);
    assert.equal(reset.changed, true);
    assert.equal(reset.action, "resetDeviceCooldown");
    assert.ok(!Object.hasOwn(reset, "last_date_replacing_device"));
    assert.ok(!Object.hasOwn(reset, "next_replacement_allowed_at"));
    assert.ok(!Object.hasOwn(await master(uid), "last_date_replacing_device"));
    const swapped = await replace(uid, "phone-b", "phone-d", "Galaxy", "android");
    assert.deepEqual(swapped.allowed_devices, ["tablet-c", "phone-d"]);
    assert.equal((await master(uid)).device_log.at(-2).actor, "admin:admin-1");

    // Admin actions: the list, one more seat, a removal that ignores the cooldown and leaves it alone.
    const listed = await adminManageDevices({ uid, adminUid: "admin-1" }, { action: "listDevices" }, LIMITS);
    assert.equal(listed.changed, false);
    assert.deepEqual(ids(listed), ["tablet-c", "phone-d"]);
    const seats = await adminManageDevices({ uid, adminUid: "admin-1" }, { action: "setExtraSeats", seats: 1 }, LIMITS);
    assert.equal(seats.max_number_of_devices, 3);
    assert.equal((await master(uid)).extra_device_seats, 1);
    const third = await register(uid, "phone-e", "Third", "android");
    assert.equal(third.allowed_devices.length, 3);
    const removed = await adminManageDevices(
      { uid, adminUid: "admin-1" },
      { action: "removeDevice", deviceId: "tablet-c" },
      LIMITS
    );
    assert.deepEqual(removed.allowed_devices, ["phone-d", "phone-e"]);
    assert.equal(removed.last_date_replacing_device, swapped.last_date_replacing_device);
    await assert.rejects(
      adminManageDevices({ uid, adminUid: "admin-1" }, { action: "setExtraSeats", seats: 11 }, LIMITS),
      safeCode("seats-invalid")
    );
  });

  test("a store renewal and a manual grant keep the device list and its log", async () => {
    await ensureUser(uid, "devices@example.test");
    const start = new Date();
    await persistVerifiedSubscription(uid, googleVerified(uid, new Date(start.getTime() + 400 * DAY), start));
    await register(uid, "phone-a", "iPhone", "ios");
    await register(uid, "phone-b", "Pixel 7", "android");
    // Stands in for a device field added after the writing build: the
    // projection must not erase what it does not know.
    await db().collection(SUBSCRIPTION_MASTER_COLLECTION).doc(uid).update({ future_device_field: "kept" });
    const before = await master(uid);

    const later = new Date(start.getTime() + 60 * 1000);
    await persistVerifiedSubscription(uid, googleVerified(uid, new Date(start.getTime() + 430 * DAY), later), {
      key: "renewal-1",
      platform: "google",
      environment: "production",
      eventType: "SUBSCRIPTION_RENEWED",
      eventAt: later,
    });
    const renewed = await master(uid);
    assert.deepEqual(renewed.allowed_devices, before.allowed_devices);
    assert.deepEqual(renewed.devices, before.devices);
    assert.deepEqual(renewed.device_log, before.device_log);
    assert.equal(renewed.future_device_field, "kept");

    const granted = await applyManualMutation(
      { uid, opId: "op-grant-devices", actor: "admin-1" },
      {
        action: "grant",
        intent: { kind: "months", months: 1, base: "today" },
        metadata: { grantSource: "admin_manual_add", note: "test" },
      }
    );
    assert.deepEqual(granted.account.master.devices.allowed_devices, ["phone-a", "phone-b"]);
    assert.deepEqual(granted.account.master.devices.devices.map((device) => device.name), ["iPhone", "Pixel 7"]);
    const afterGrant = await master(uid);
    assert.deepEqual(afterGrant.devices, before.devices);
    assert.deepEqual(afterGrant.device_log, before.device_log);
    assert.equal(afterGrant.future_device_field, "kept");
    assert.deepEqual(ids(await list(uid)), ["phone-a", "phone-b"]);
  });
});

describe("device seats without an active subscription", () => {
  test("registering needs a master that is active and unexpired; listing does not", async () => {
    const uid = "user-lapsed";
    await ensureUser(uid, "lapsed@example.test");
    await assert.rejects(list(uid), safeCode("subscription-not-found"));
    await assert.rejects(
      adminManageDevices({ uid, adminUid: "admin-1" }, { action: "listDevices" }, LIMITS),
      safeCode("subscription-not-found")
    );

    const start = new Date(Date.now() - 100 * DAY);
    await persistVerifiedSubscription(uid, googleVerified(uid, new Date(Date.now() - DAY), start));
    await assert.rejects(register(uid, "phone-a", "iPhone", "ios"), safeCode("subscription-not-active"));
    await assert.rejects(replace(uid, "phone-x", "phone-a", "iPhone", "ios"), safeCode("subscription-not-active"));
    const listed = await list(uid);
    assert.deepEqual(listed.allowed_devices, []);
    assert.equal(listed.max_number_of_devices, 2);

    // An admin can still tidy the list of a lapsed account.
    const seats = await adminManageDevices({ uid, adminUid: "admin-1" }, { action: "setExtraSeats", seats: 2 }, LIMITS);
    assert.equal(seats.max_number_of_devices, 4);
    await assert.rejects(register(uid, "phone-a", "iPhone", "ios"), safeCode("subscription-not-active"));
  });
});
