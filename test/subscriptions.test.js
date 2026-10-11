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
  buildSourceSummaries,
  googleOwnershipDocumentId,
  ownershipDocumentId,
  preserveMasterDeviceFields,
  shouldApplyIncomingState,
  stateData,
  stateDataToNormalized,
  STATE_SLOTS,
  MANUAL_SLOT_INDEX,
  legacyManualDocumentId,
} = require("../lib/services/subscriptions/persistence");
const {
  addMonthsEndOfDay,
  endOfDayInZone,
  replayGrants,
  grantsFromData,
  grantToData,
  nextQueueGrantId,
  activeGrantForQueue,
  legacyExpires,
} = require("../lib/services/subscriptions/manual");
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
  assert.equal(
    selectMasterState([sandbox, production], { environmentPriority: true }),
    production
  );
  // With the priority switched off (the live sandbox stage), dates alone decide.
  assert.equal(
    selectMasterState([sandbox, production], { environmentPriority: false }),
    sandbox
  );

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

// ---------------------------------------------------------------------------
// Manual grants
// ---------------------------------------------------------------------------

const CAIRO = "Africa/Cairo";

function grant(overrides) {
  return {
    grantId: "g",
    kind: "months",
    months: 1,
    base: "extend",
    grantedAt: NOW,
    grantedBy: "admin",
    metadata: { grantSource: "admin_manual_add" },
    status: "active",
    ...overrides,
  };
}

test("manual dates end at the last millisecond of the Cairo day", () => {
  // 2026-01-01T00:00Z is already Jan 1 in Cairo (UTC+2); the day ends 21:59:59.999Z.
  assert.equal(
    endOfDayInZone(NOW, CAIRO).toISOString(),
    "2026-01-01T21:59:59.999Z"
  );
  // 23:30Z on Jan 1 is 01:30 on Jan 2 in Cairo.
  assert.equal(
    endOfDayInZone(new Date("2026-01-01T23:30:00.000Z"), CAIRO).toISOString(),
    "2026-01-02T21:59:59.999Z"
  );
  // Summer time (UTC+3): the day ends at 20:59:59.999Z.
  assert.equal(
    endOfDayInZone(new Date("2026-07-10T12:00:00.000Z"), CAIRO).toISOString(),
    "2026-07-10T20:59:59.999Z"
  );
});

test("adding months follows setMonth overflow and lands on the Cairo end of day", () => {
  assert.equal(
    addMonthsEndOfDay(NOW, 3, CAIRO).toISOString(),
    "2026-04-01T21:59:59.999Z"
  );
  // Jan 31 + 1 month rolls into March, as the old portal did.
  assert.equal(
    addMonthsEndOfDay(new Date("2026-01-31T10:00:00.000Z"), 1, CAIRO).toISOString(),
    "2026-03-03T21:59:59.999Z"
  );
  assert.equal(
    addMonthsEndOfDay(NOW, 12, CAIRO).toISOString(),
    "2027-01-01T21:59:59.999Z"
  );
});

test("replay: a grant counts from its own date, an extension from the running end", () => {
  const first = grant({ grantId: "a", months: 3, grantedAt: NOW });
  const extension = grant({
    grantId: "b",
    months: 12,
    base: "extend",
    grantedAt: new Date("2026-02-01T00:00:00.000Z"),
  });
  const replay = replayGrants([extension, first], CAIRO);
  assert.equal(replay.activeGrantCount, 2);
  // 3 months from Jan 1 ends Apr 1; 12 more from there ends Apr 1 next year.
  // Egypt's summer time starts on the last Friday of April, so Apr 1 is still UTC+2.
  assert.equal(replay.expiresAt.toISOString(), "2027-04-01T21:59:59.999Z");
  assert.equal(replay.latestActive.grantId, "b");

  const fromToday = replayGrants([first, { ...extension, base: "today" }], CAIRO);
  assert.equal(fromToday.expiresAt.toISOString(), "2027-02-01T21:59:59.999Z");
});

test("replay: a lapsed grant does not anchor a later one, and absolute grants only move the end forward", () => {
  const old = grant({ grantId: "a", months: 1, grantedAt: new Date("2025-01-01T00:00:00.000Z") });
  const later = grant({ grantId: "b", months: 2, grantedAt: NOW });
  assert.equal(
    replayGrants([old, later], CAIRO).expiresAt.toISOString(),
    "2026-03-01T21:59:59.999Z"
  );

  const absolute = grant({
    grantId: "legacy_x",
    kind: "absolute",
    expiresAt: new Date("2026-02-15T21:59:59.999Z"),
    grantedAt: PAST,
  });
  // The later extension counts from the baseline's end (Feb 15), not from its own date.
  assert.equal(
    replayGrants([absolute, later], CAIRO).expiresAt.toISOString(),
    "2026-04-15T21:59:59.999Z"
  );
  // A far baseline: the extension still adds its two months on top of it.
  const farAbsolute = { ...absolute, expiresAt: new Date("2030-01-01T21:59:59.999Z") };
  assert.equal(
    replayGrants([farAbsolute, later], CAIRO).expiresAt.toISOString(),
    "2030-03-01T21:59:59.999Z"
  );
});

test("replay: reversing a grant preserves the others' duration, re-anchored", () => {
  const jan = grant({ grantId: "jan", months: 3, grantedAt: new Date("2025-01-01T00:00:00.000Z") });
  const feb = grant({ grantId: "feb", months: 1, grantedAt: new Date("2025-02-01T00:00:00.000Z") });
  // Together: Jan 1 + 3 = Apr 1; Feb extends from Apr 1 by 1 = May 1.
  assert.equal(
    replayGrants([jan, feb], CAIRO).expiresAt.toISOString(),
    "2025-05-01T20:59:59.999Z"
  );
  // Reverse January: February keeps its one month, from its own date.
  assert.equal(
    replayGrants([{ ...jan, status: "reversed" }, feb], CAIRO).expiresAt.toISOString(),
    "2025-03-01T21:59:59.999Z"
  );
  // Reverse February: January alone.
  assert.equal(
    replayGrants([jan, { ...feb, status: "reversed" }], CAIRO).expiresAt.toISOString(),
    "2025-04-01T21:59:59.999Z"
  );
});

test("replay: revoked grants give nothing, so the next grant counts from its own date", () => {
  const revoked = grant({ grantId: "a", months: 12, status: "revoked", grantedAt: PAST });
  assert.equal(replayGrants([revoked], CAIRO).expiresAt, undefined);
  assert.equal(replayGrants([revoked], CAIRO).activeGrantCount, 0);
  const fresh = grant({ grantId: "b", months: 1, grantedAt: FUTURE });
  assert.equal(
    replayGrants([revoked, fresh], CAIRO).expiresAt.toISOString(),
    "2026-03-01T21:59:59.999Z"
  );
});

test("replay: adjusting a grant changes only its own months", () => {
  const a = grant({ grantId: "a", months: 3, grantedAt: NOW });
  const b = grant({ grantId: "b", months: 1, grantedAt: new Date("2026-02-01T00:00:00.000Z") });
  assert.equal(
    replayGrants([a, b], CAIRO).expiresAt.toISOString(),
    "2026-05-01T20:59:59.999Z"
  );
  assert.equal(
    replayGrants([{ ...a, months: 6 }, b], CAIRO).expiresAt.toISOString(),
    "2026-08-01T20:59:59.999Z"
  );
});

test("queue grant ids carry a revision, and only an active one blocks a re-approval", () => {
  const queue = { collection: "subscriptions_to_be_approved", id: "req-1" };
  assert.equal(nextQueueGrantId([], queue), "subscriptions_to_be_approved_req-1_r1");
  const r1 = grant({ grantId: "subscriptions_to_be_approved_req-1_r1", queue });
  assert.equal(activeGrantForQueue([r1], queue), r1);
  assert.equal(nextQueueGrantId([r1], queue), "subscriptions_to_be_approved_req-1_r2");
  assert.equal(activeGrantForQueue([{ ...r1, status: "reversed" }], queue), undefined);
  // Another request's grants never collide.
  assert.equal(
    nextQueueGrantId([r1], { ...queue, id: "req-10" }),
    "subscriptions_to_be_approved_req-10_r1"
  );
});

test("grants round-trip through Firestore data and drop malformed entries", () => {
  const original = grant({
    grantId: "x",
    kind: "absolute",
    expiresAt: FUTURE,
    queue: { collection: "subscriptions_to_be_approved", id: "q" },
    statusChangedAt: NOW,
    statusReason: "why",
    metadata: { grantSource: "egypt_request", amountPaid: 200, paymentMethod: "VodafoneCash" },
  });
  delete original.months;
  const [back] = grantsFromData([grantToData(original), null, { grantId: 5 }, { grantId: "no-date" }]);
  assert.deepEqual(back, original);
});

test("a manual slot reads back with activity derived from the date, never the stored flag", () => {
  const manual = {
    active: true,
    status: "active",
    platform: "manual",
    productId: "manual_grant",
    expiresAt: PAST,
    autoRenewing: false,
    inGracePeriod: false,
    environment: "production",
    lastStoreEventAt: PAST,
    lastVerifiedAt: PAST,
    manual: { activeGrantCount: 1, grantSource: "egypt_request", ledgerRevision: 3 },
  };
  const data = stateData("uid", manual, Timestamp.fromDate(PAST), Timestamp.fromDate(PAST));
  assert.equal(data.active, true);
  const lapsed = stateDataToNormalized(data, NOW);
  assert.equal(lapsed.active, false);
  assert.equal(lapsed.status, "expired");
  assert.deepEqual(lapsed.manual, { activeGrantCount: 1, grantSource: "egypt_request", ledgerRevision: 3 });

  const live = stateDataToNormalized(
    stateData("uid", { ...manual, expiresAt: FUTURE }, Timestamp.fromDate(PAST), Timestamp.fromDate(PAST)),
    NOW
  );
  assert.equal(live.active, true);
  assert.equal(live.status, "active");

  const revoked = stateDataToNormalized(
    stateData("uid", { ...manual, status: "revoked", expiresAt: FUTURE }, Timestamp.fromDate(PAST), Timestamp.fromDate(PAST)),
    NOW
  );
  assert.equal(revoked.active, false);
  assert.equal(revoked.status, "revoked");
});

test("the manual slot is the fifth slot and its document id follows the slot scheme", () => {
  assert.equal(STATE_SLOTS.length, 5);
  assert.deepEqual(STATE_SLOTS[MANUAL_SLOT_INDEX], { platform: "manual", environment: "production" });
  assert.equal(
    legacyManualDocumentId("hi3CmRh1nudfKVNjCDoXK8yH4Tl2"),
    "011edb69606baa720915c24ad1b2995434dfac6b0164b02e3ee1aca61ccf183f"
  );
});

test("master projection: an active manual grant competes with store states on dates", () => {
  const manual = {
    active: true,
    status: "active",
    platform: "manual",
    productId: "manual_grant",
    expiresAt: new Date("2026-03-01T21:59:59.999Z"),
    autoRenewing: false,
    inGracePeriod: false,
    environment: "production",
    lastStoreEventAt: NOW,
    lastVerifiedAt: NOW,
    manual: { activeGrantCount: 1, ledgerRevision: 1 },
  };
  const google = normalizeGoogleSubscription({
    productId: "premium_access",
    environment: "production",
    purchaseReference: "ref",
    expiryTime: FUTURE.toISOString(),
    subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
    autoRenewing: true,
    now: NOW,
  });
  // Manual ends later than Google: manual wins.
  assert.equal(selectMasterState([google, manual], { environmentPriority: true }), manual);
  // Google renewed past the manual date: Google wins.
  const renewed = { ...google, expiresAt: new Date("2026-06-01T00:00:00.000Z") };
  assert.equal(selectMasterState([renewed, manual], { environmentPriority: true }), renewed);
  // Expired store, active manual: manual wins regardless of dates.
  const expiredStore = { ...google, active: false, status: "expired", expiresAt: PAST };
  assert.equal(selectMasterState([expiredStore, manual], { environmentPriority: true }), manual);
  // Revoked manual vs expired store: nothing active, the store keeps the master so
  // its own status and references stay visible, however recently the grant was touched.
  const revokedManual = { ...manual, active: false, status: "revoked", lastVerifiedAt: FUTURE };
  const staleExpiredStore = { ...expiredStore, lastVerifiedAt: PAST };
  assert.equal(
    selectMasterState([staleExpiredStore, revokedManual], { environmentPriority: true }),
    staleExpiredStore
  );
  // Only manual slots inactive: the most recently verified one.
  const olderRevoked = { ...revokedManual, lastVerifiedAt: PAST };
  assert.equal(selectMasterState([olderRevoked, revokedManual]), revokedManual);
});

test("master projection carries the manual summary and one source row per slot", () => {
  const manual = {
    active: true,
    status: "active",
    platform: "manual",
    productId: "manual_grant",
    expiresAt: FUTURE,
    autoRenewing: false,
    inGracePeriod: false,
    environment: "production",
    lastStoreEventAt: NOW,
    lastVerifiedAt: NOW,
    manual: { activeGrantCount: 2, grantSource: "egypt_request", ledgerRevision: 4 },
  };
  const apple = normalizeAppleSubscription({
    productId: "monthly_sub",
    environment: "production",
    originalTransactionId: "orig",
    expiresAtMs: PAST.getTime(),
    storeStatus: 2,
    now: NOW,
  });
  const projection = buildMasterProjection(
    manual,
    Timestamp.fromDate(NOW),
    Timestamp.fromDate(NOW),
    buildSourceSummaries([apple, manual])
  );
  assert.equal(projection.platform, "manual");
  assert.equal(projection.productId, "manual_grant");
  assert.deepEqual(projection.manual, { activeGrantCount: 2, grantSource: "egypt_request", ledgerRevision: 4 });
  assert.ok(!Object.hasOwn(projection, "originalTransactionId"));
  assert.equal(projection.sources.length, 2);
  assert.deepEqual(Object.keys(projection.sources[0]).sort(), [
    "environment",
    "expiresAt",
    "platform",
    "status",
  ]);
  assert.equal(projection.sources[0].platform, "apple");
  assert.equal(projection.sources[0].status, "expired");
  assert.equal(projection.sources[1].autoRenewing, false);
  // No stored activity flag: readers derive it from the date.
  assert.ok(!Object.hasOwn(projection.sources[1], "active"));
});

test("legacy expiry tolerates the shapes the old documents used", () => {
  assert.equal(legacyExpires({ expires: Timestamp.fromDate(FUTURE) }).toISOString(), FUTURE.toISOString());
  assert.equal(legacyExpires({ expiresAt: Timestamp.fromDate(FUTURE) }).toISOString(), FUTURE.toISOString());
  assert.equal(legacyExpires({ expires: FUTURE.toISOString() }).toISOString(), FUTURE.toISOString());
  assert.equal(legacyExpires({ expires: Math.floor(FUTURE.getTime() / 1000) }).toISOString(), FUTURE.toISOString());
  assert.equal(legacyExpires({ expires: "garbage" }), undefined);
  assert.equal(legacyExpires(undefined), undefined);
});
