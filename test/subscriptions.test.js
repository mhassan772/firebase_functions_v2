const assert = require("node:assert/strict");
const test = require("node:test");
const {
  Environment,
  Type,
} = require("@apple/app-store-server-library");
const {
  accountBindingVersion,
  deriveAccountBinding,
} = require("../lib/services/subscriptions/crypto");
const {
  claimedAppleEnvironment,
  validateAppleTransaction,
} = require("../lib/services/subscriptions/apple");
const {
  validateGooglePurchase,
} = require("../lib/services/subscriptions/google");
const {
  normalizeAppleSubscription,
  normalizeGoogleSubscription,
  selectMasterState,
} = require("../lib/services/subscriptions/normalization");
const {
  assertOwnershipClaimAllowed,
  buildMasterProjection,
  googleOwnershipDocumentId,
  ownershipDocumentId,
  preserveMasterDeviceFields,
  shouldApplyIncomingState,
} = require("../lib/services/subscriptions/persistence");
const {
  applyDeviceAction,
  deviceStateFromMaster,
  nextReplacementAllowedAt,
  resolveDeviceLimits,
} = require("../lib/services/subscriptions/devices");
const { Timestamp } = require("firebase-admin/firestore");
const {
  asCallableError,
  SubscriptionError,
} = require("../lib/services/subscriptions/errors");

const NOW = new Date("2026-01-01T00:00:00.000Z");
const FUTURE = new Date("2026-02-01T00:00:00.000Z");
const PAST = new Date("2025-12-01T00:00:00.000Z");

test("account bindings are deterministic, separated, and store-safe", () => {
  const secret = "a-secure-test-key-with-at-least-32-bytes";
  const apple = deriveAccountBinding("firebase-user", "apple", secret);
  const google = deriveAccountBinding("firebase-user", "google", secret);
  assert.equal(
    apple,
    deriveAccountBinding("firebase-user", "apple", secret)
  );
  assert.match(
    apple,
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  );
  assert.notEqual(apple, google);
  assert.ok(google.length <= 64);
  assert.equal(accountBindingVersion(), 1);
  assert.ok(!apple.includes("firebase-user"));
  assert.ok(!google.includes("firebase-user"));
  assert.throws(
    () => deriveAccountBinding("firebase-user", "google", "short"),
    /configuration is unavailable/
  );
});

test("Apple identity, product, environment, and recurring type are enforced", () => {
  const valid = {
    bundleId: "com.ktc.MantooqAppiOS",
    environment: Environment.PRODUCTION,
    type: Type.AUTO_RENEWABLE_SUBSCRIPTION,
    productId: "monthly_sub",
    originalTransactionId: "original",
  };
  assert.doesNotThrow(() =>
    validateAppleTransaction(valid, Environment.PRODUCTION)
  );
  assert.throws(
    () =>
      validateAppleTransaction(
        { ...valid, bundleId: "com.example.invalid" },
        Environment.PRODUCTION
      ),
    /failed validation/
  );
  assert.throws(
    () =>
      validateAppleTransaction(
        { ...valid, productId: "other_product" },
        Environment.PRODUCTION
      ),
    /failed validation/
  );
  assert.throws(
    () =>
      validateAppleTransaction(
        { ...valid, type: Type.NON_CONSUMABLE },
        Environment.PRODUCTION
      ),
    /failed validation/
  );
  assert.throws(
    () => validateAppleTransaction(valid, Environment.SANDBOX),
    /failed validation/
  );
});

test("Apple environment selection permits only signed store environments", () => {
  const jws = (payload) =>
    `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
  assert.equal(
    claimedAppleEnvironment(jws({ environment: "Production" })),
    Environment.PRODUCTION
  );
  assert.equal(
    claimedAppleEnvironment(jws({ data: { environment: "Sandbox" } })),
    Environment.SANDBOX
  );
  assert.throws(
    () => claimedAppleEnvironment(jws({ environment: "Xcode" })),
    /failed validation/
  );
});

test("Apple normalization preserves paid cancellation and grace access", () => {
  const canceled = normalizeAppleSubscription({
    productId: "monthly_sub",
    environment: "production",
    originalTransactionId: "original",
    expiresAtMs: FUTURE.getTime(),
    storeStatus: 1,
    autoRenewing: false,
    now: NOW,
  });
  assert.equal(canceled.status, "canceled");
  assert.equal(canceled.active, true);
  assert.equal(canceled.autoRenewing, false);

  const grace = normalizeAppleSubscription({
    productId: "monthly_sub",
    environment: "sandbox",
    originalTransactionId: "original",
    expiresAtMs: PAST.getTime(),
    gracePeriodExpiresAtMs: FUTURE.getTime(),
    storeStatus: 4,
    now: NOW,
  });
  assert.equal(grace.status, "grace_period");
  assert.equal(grace.active, true);
  assert.equal(grace.expiresAt.toISOString(), FUTURE.toISOString());

  const retry = normalizeAppleSubscription({
    productId: "monthly_sub",
    environment: "production",
    originalTransactionId: "original",
    expiresAtMs: PAST.getTime(),
    storeStatus: 3,
    now: NOW,
  });
  assert.equal(retry.status, "billing_retry");
  assert.equal(retry.active, false);
});

test("Google requires allowlisted products, base plans, and binding", () => {
  const valid = {
    subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
    lineItems: [
      {
        productId: "premium_access",
        expiryTime: FUTURE.toISOString(),
        autoRenewingPlan: { autoRenewEnabled: true },
        offerDetails: { basePlanId: "monthly" },
      },
    ],
    externalAccountIdentifiers: {
      obfuscatedExternalAccountId: "expected",
    },
  };
  assert.doesNotThrow(() => validateGooglePurchase(valid, "expected"));
  assert.doesNotThrow(() =>
    validateGooglePurchase(
      {
        ...valid,
        lineItems: [
          {
            ...valid.lineItems[0],
            offerDetails: { basePlanId: "yearly" },
          },
        ],
      },
      "expected"
    )
  );
  assert.throws(
    () =>
      validateGooglePurchase(
        {
          ...valid,
          lineItems: [{ ...valid.lineItems[0], productId: "other" }],
        },
        "expected"
      ),
    /failed validation/
  );
  assert.throws(
    () =>
      validateGooglePurchase(
        {
          ...valid,
          lineItems: [
            {
              productId: "premium_access",
              expiryTime: FUTURE.toISOString(),
              prepaidPlan: {},
            },
          ],
        },
        "expected"
    ),
    /failed validation/
  );
  assert.throws(
    () =>
      validateGooglePurchase(
        {
          ...valid,
          lineItems: [
            {
              ...valid.lineItems[0],
              offerDetails: { basePlanId: "unexpected" },
            },
          ],
        },
        "expected"
      ),
    /failed validation/
  );
  assert.throws(
    () =>
      validateGooglePurchase(
        {
          ...valid,
          lineItems: [
            {
              ...valid.lineItems[0],
              offerDetails: undefined,
            },
          ],
        },
        "expected"
      ),
    /failed validation/
  );
  assert.throws(
    () => validateGooglePurchase(valid, "different"),
    /does not match/
  );
  assert.doesNotThrow(() =>
    validateGooglePurchase(
      { ...valid, externalAccountIdentifiers: undefined },
      "historical-binding"
    )
  );
});

test("Google normalization grants only active, grace, or paid cancellation", () => {
  for (const [subscriptionState, expectedStatus, expectedActive] of [
    ["SUBSCRIPTION_STATE_ACTIVE", "active", true],
    ["SUBSCRIPTION_STATE_IN_GRACE_PERIOD", "grace_period", true],
    ["SUBSCRIPTION_STATE_CANCELED", "canceled", true],
    ["SUBSCRIPTION_STATE_ON_HOLD", "account_hold", false],
    ["SUBSCRIPTION_STATE_PAUSED", "paused", false],
    ["SUBSCRIPTION_STATE_PENDING", "pending", false],
    ["SUBSCRIPTION_STATE_EXPIRED", "expired", false],
  ]) {
    const result = normalizeGoogleSubscription({
      productId: "premium_access",
      environment: "production",
      purchaseReference: "reference",
      expiryTime: FUTURE.toISOString(),
      subscriptionState,
      autoRenewing: subscriptionState === "SUBSCRIPTION_STATE_ACTIVE",
      now: NOW,
    });
    assert.equal(result.status, expectedStatus);
    assert.equal(result.active, expectedActive);
  }
});

test("master projection prefers active production then inactive recency", () => {
  const sandbox = normalizeAppleSubscription({
    productId: "yearly_sub",
    environment: "sandbox",
    originalTransactionId: "sandbox",
    expiresAtMs: new Date("2027-01-01T00:00:00.000Z").getTime(),
    storeStatus: 1,
    now: NOW,
  });
  const production = normalizeGoogleSubscription({
    productId: "premium_access",
    environment: "production",
    purchaseReference: "production",
    expiryTime: FUTURE.toISOString(),
    subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
    autoRenewing: true,
    now: NOW,
  });
  assert.equal(selectMasterState([sandbox, production]), production);

  const oldInactive = { ...production, active: false, lastVerifiedAt: PAST };
  const newInactive = { ...sandbox, active: false, lastVerifiedAt: FUTURE };
  assert.equal(selectMasterState([oldInactive, newInactive]), newInactive);
});

test("ownership cannot transfer and older notifications cannot regress state", () => {
  assert.doesNotThrow(() => assertOwnershipClaimAllowed([], "uid-a"));
  assert.doesNotThrow(() =>
    assertOwnershipClaimAllowed(["uid-a", "uid-a"], "uid-a")
  );
  assert.throws(
    () => assertOwnershipClaimAllowed(["uid-a"], "uid-b"),
    (error) =>
      error instanceof SubscriptionError &&
      error.kind === "ownership-conflict"
  );
  assert.equal(shouldApplyIncomingState(FUTURE, PAST, true), false);
  assert.equal(shouldApplyIncomingState(FUTURE, PAST, false), true);
  assert.equal(shouldApplyIncomingState(PAST, FUTURE, true), true);
});

test("master projection and document keys never expose protected purchase data", () => {
  const state = normalizeGoogleSubscription({
    productId: "premium_access",
    environment: "production",
    purchaseReference: "safe-reference",
    expiryTime: FUTURE.toISOString(),
    subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
    autoRenewing: true,
    now: NOW,
  });
  const projection = buildMasterProjection(
    state,
    Timestamp.fromDate(NOW),
    Timestamp.fromDate(NOW)
  );
  assert.deepEqual(Object.keys(projection).sort(), [
    "active",
    "autoRenewing",
    "createdAt",
    "environment",
    "expiresAt",
    "inGracePeriod",
    "lastStoreEventAt",
    "lastVerifiedAt",
    "platform",
    "productId",
    "purchaseReference",
    "status",
    "updatedAt",
  ]);
  assert.ok(!Object.hasOwn(projection, "uid"));
  assert.ok(!Object.hasOwn(projection, "purchaseToken"));
  assert.ok(!Object.hasOwn(projection, "signedPayload"));

  const token = "protected-google-purchase-token";
  const original = "protected-apple-original-transaction";
  assert.ok(!googleOwnershipDocumentId(token).includes(token));
  assert.ok(
    !ownershipDocumentId({
      platform: "apple",
      environment: "production",
      originalTransactionId: original,
    }).includes(original)
  );
});

test("device limits come from settings with safe defaults", () => {
  assert.deepEqual(resolveDeviceLimits(undefined), {
    maxDevices: 2,
    replacementCooldownDays: 7,
  });
  assert.deepEqual(resolveDeviceLimits({}), {
    maxDevices: 2,
    replacementCooldownDays: 7,
  });
  assert.deepEqual(
    resolveDeviceLimits({
      subscription: {
        max_number_of_devices: 3,
        days_before_replacing_device: 14,
      },
    }),
    { maxDevices: 3, replacementCooldownDays: 14 }
  );
  assert.deepEqual(
    resolveDeviceLimits({
      subscription: {
        max_number_of_devices: 0,
        days_before_replacing_device: -1,
      },
    }),
    { maxDevices: 2, replacementCooldownDays: 7 }
  );
  assert.deepEqual(
    resolveDeviceLimits({
      subscription: {
        max_number_of_devices: "3",
        days_before_replacing_device: 1.5,
      },
    }),
    { maxDevices: 2, replacementCooldownDays: 7 }
  );
});

test("device registration is free under the limit and idempotent", () => {
  const limits = { maxDevices: 2, replacementCooldownDays: 7 };
  const empty = { allowedDevices: [], extraSeats: 0 };

  const first = applyDeviceAction(empty, "register", "device-a", limits, NOW);
  assert.equal(first.changed, true);
  assert.deepEqual(first.allowedDevices, ["device-a"]);

  const again = applyDeviceAction(
    { allowedDevices: ["device-a"], extraSeats: 0 },
    "register",
    "device-a",
    limits,
    NOW
  );
  assert.equal(again.changed, false);
  assert.deepEqual(again.allowedDevices, ["device-a"]);
});

test("device registration is rejected at the limit unless extra seats exist", () => {
  const limits = { maxDevices: 2, replacementCooldownDays: 7 };
  const full = { allowedDevices: ["device-a", "device-b"], extraSeats: 0 };
  assert.throws(
    () => applyDeviceAction(full, "register", "device-c", limits, NOW),
    (error) =>
      error.code === "resource-exhausted" &&
      error.details.code === "device-limit-reached" &&
      error.details.maxDevices === 2
  );

  const withSeat = { ...full, extraSeats: 1 };
  const result = applyDeviceAction(withSeat, "register", "device-c", limits, NOW);
  assert.equal(result.changed, true);
  assert.deepEqual(result.allowedDevices, ["device-a", "device-b", "device-c"]);
});

test("device removal enforces the replacement cooldown", () => {
  const limits = { maxDevices: 2, replacementCooldownDays: 7 };

  const first = applyDeviceAction(
    { allowedDevices: ["device-a", "device-b"], extraSeats: 0 },
    "unregister",
    "device-a",
    limits,
    NOW
  );
  assert.equal(first.changed, true);
  assert.deepEqual(first.allowedDevices, ["device-b"]);
  assert.equal(first.lastReplacedAt, NOW);

  const insideWindow = new Date(NOW.getTime() + 3 * 24 * 60 * 60 * 1000);
  assert.throws(
    () =>
      applyDeviceAction(
        { allowedDevices: ["device-b"], lastReplacedAt: NOW, extraSeats: 0 },
        "unregister",
        "device-b",
        limits,
        insideWindow
      ),
    (error) =>
      error.code === "failed-precondition" &&
      error.details.code === "device-replacement-cooldown" &&
      error.details.nextAllowedAt ===
        nextReplacementAllowedAt(NOW, limits).toISOString()
  );

  const afterWindow = new Date(NOW.getTime() + 8 * 24 * 60 * 60 * 1000);
  const second = applyDeviceAction(
    { allowedDevices: ["device-b"], lastReplacedAt: NOW, extraSeats: 0 },
    "unregister",
    "device-b",
    limits,
    afterWindow
  );
  assert.equal(second.changed, true);
  assert.deepEqual(second.allowedDevices, []);
  assert.equal(second.lastReplacedAt, afterWindow);
});

test("removing an unknown device is a no-op that keeps the cooldown intact", () => {
  const limits = { maxDevices: 2, replacementCooldownDays: 7 };
  const insideWindow = new Date(NOW.getTime() + 1 * 24 * 60 * 60 * 1000);
  const result = applyDeviceAction(
    { allowedDevices: ["device-a"], lastReplacedAt: NOW, extraSeats: 0 },
    "unregister",
    "device-x",
    limits,
    insideWindow
  );
  assert.equal(result.changed, false);
  assert.deepEqual(result.allowedDevices, ["device-a"]);
  assert.equal(result.lastReplacedAt, NOW);
});

test("device fields on the master doc survive store-driven rebuilds", () => {
  const state = normalizeGoogleSubscription({
    productId: "premium_access",
    environment: "production",
    purchaseReference: "reference",
    expiryTime: FUTURE.toISOString(),
    subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
    autoRenewing: true,
    now: NOW,
  });
  const rebuilt = buildMasterProjection(
    state,
    Timestamp.fromDate(NOW),
    Timestamp.fromDate(NOW)
  );
  const existing = {
    allowed_devices: ["device-a", "device-b"],
    last_date_replacing_device: Timestamp.fromDate(PAST),
    extra_device_seats: 1,
    productId: "stale-value-not-carried",
  };
  const preserved = preserveMasterDeviceFields(rebuilt, existing);
  assert.deepEqual(preserved.allowed_devices, ["device-a", "device-b"]);
  assert.equal(preserved.last_date_replacing_device, existing.last_date_replacing_device);
  assert.equal(preserved.extra_device_seats, 1);
  assert.equal(preserved.productId, "premium_access");

  const fresh = buildMasterProjection(
    state,
    Timestamp.fromDate(NOW),
    Timestamp.fromDate(NOW)
  );
  assert.equal(preserveMasterDeviceFields(fresh, undefined), fresh);
  assert.ok(!Object.hasOwn(fresh, "allowed_devices"));
});

test("device state parsing tolerates missing and malformed fields", () => {
  assert.deepEqual(deviceStateFromMaster({}), {
    allowedDevices: [],
    lastReplacedAt: undefined,
    extraSeats: 0,
  });
  const parsed = deviceStateFromMaster({
    allowed_devices: ["device-a", 42, "", "device-b"],
    last_date_replacing_device: Timestamp.fromDate(NOW),
    extra_device_seats: 2,
  });
  assert.deepEqual(parsed.allowedDevices, ["device-a", "device-b"]);
  assert.equal(parsed.lastReplacedAt.toISOString(), NOW.toISOString());
  assert.equal(parsed.extraSeats, 2);
});

test("callable errors do not expose raw store material", () => {
  const raw = "raw-purchase-token-that-must-not-leak";
  const callable = asCallableError(
    new SubscriptionError(
      "invalid-store-data",
      "store-rejected",
      raw
    )
  );
  assert.equal(callable.code, "failed-precondition");
  assert.ok(!callable.message.includes(raw));
});
