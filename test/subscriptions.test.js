const assert = require("node:assert/strict");
const test = require("node:test");
const {
  Environment,
  Type,
} = require("@apple/app-store-server-library");
const {
  accountBindingVersion,
  deriveAccountBinding,
  sha256Reference,
} = require("../lib/services/subscriptions/crypto");
const {
  claimedAppleEnvironment,
  decodeAppleNotificationIdentity,
  validateAppleTransaction,
} = require("../lib/services/subscriptions/apple");
const {
  isRetainableFailure,
  reconcileWindow,
  voidedEventKey,
} = require("../lib/handlers/subscriptionReconcileHandlers");
const {
  setPlayApi,
  validateGooglePurchase,
} = require("../lib/services/subscriptions/google");
const {
  ACKNOWLEDGEMENT_DEADLINE_MS,
  acknowledgementData,
  acknowledgementNeeded,
  attemptUpdate,
  classifyAcknowledgeFailure,
  retryDelayMs,
} = require("../lib/services/subscriptions/acknowledgements");
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
  masterAfterProjection,
  masterProjectionUpdate,
  MASTER_PROJECTION_OPTIONAL_FIELDS,
  mayReplaceSlotPurchase,
  expiredTokenOwnerAccepted,
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
  assertMasterActive,
  buildDeviceResponse,
  deviceStateFromMaster,
  deviceStateUpdate,
  masterDataToResponse,
  MAX_DEVICE_LOG_ENTRIES,
  nextReplacementAllowedAt,
  resolveDeviceLimits,
} = {
  ...require("../lib/services/subscriptions/devices"),
  masterDataToResponse: require("../lib/services/subscriptions/persistence").masterDataToResponse,
};
const {
  applyAdminDeviceAction,
  assertExtraSeats,
} = require("../lib/services/subscriptions/adminDevices");
const { FieldValue } = require("firebase-admin/firestore");
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

function googlePurchase(token, { state, expiryTime, linkedToken } = {}) {
  return {
    subscription: normalizeGoogleSubscription({
      productId: "premium_access",
      environment: "test",
      purchaseReference: sha256Reference(token),
      expiryTime: (expiryTime ?? FUTURE).toISOString(),
      subscriptionState: state ?? "SUBSCRIPTION_STATE_ACTIVE",
      autoRenewing: state === undefined,
      eventAt: NOW,
      now: NOW,
    }),
    ownership: [
      {
        platform: "google",
        environment: "test",
        purchaseToken: token,
        currentPurchaseToken: token,
        ...(linkedToken ? { linkedPurchaseToken: linkedToken } : {}),
      },
      ...(linkedToken
        ? [{ platform: "google", environment: "test", purchaseToken: linkedToken, currentPurchaseToken: token }]
        : []),
    ],
  };
}

function applePurchase(originalTransactionId, storeStatus) {
  return {
    subscription: normalizeAppleSubscription({
      productId: "monthly_sub",
      environment: "sandbox",
      originalTransactionId,
      expiresAtMs: (storeStatus === 1 ? FUTURE : PAST).getTime(),
      signedAtMs: NOW.getTime(),
      storeStatus,
      autoRenewing: storeStatus === 1,
      now: NOW,
    }),
    ownership: [{ platform: "apple", environment: "sandbox", originalTransactionId }],
  };
}

test("a lapsed report about an older purchase never replaces the active one in its slot", () => {
  // The release QA timeline: token B was voided, C was bought, then Play re-delivered B's void.
  const current = googlePurchase("token-C-yearly").subscription;
  const voidedOlder = googlePurchase("token-B-monthly", {
    state: "SUBSCRIPTION_STATE_EXPIRED",
    expiryTime: PAST,
  });
  voidedOlder.subscription.status = "revoked";
  assert.equal(mayReplaceSlotPurchase(current, voidedOlder, NOW), false);

  // The same purchase ending does replace it.
  const currentVoided = googlePurchase("token-C-yearly", {
    state: "SUBSCRIPTION_STATE_EXPIRED",
    expiryTime: PAST,
  });
  assert.equal(mayReplaceSlotPurchase(current, currentVoided, NOW), true);

  // So does a lapsed upgrade that replaced it through linkedPurchaseToken.
  const lapsedUpgrade = googlePurchase("token-D-upgrade", {
    state: "SUBSCRIPTION_STATE_EXPIRED",
    expiryTime: PAST,
    linkedToken: "token-C-yearly",
  });
  assert.equal(mayReplaceSlotPurchase(current, lapsedUpgrade, NOW), true);

  // An active purchase always takes the slot, and nothing guards a slot that already lapsed.
  assert.equal(mayReplaceSlotPurchase(current, googlePurchase("token-E-new"), NOW), true);
  const lapsedStored = googlePurchase("token-C-yearly", { expiryTime: PAST }).subscription;
  assert.equal(lapsedStored.active, false);
  assert.equal(mayReplaceSlotPurchase(lapsedStored, voidedOlder, NOW), true);
  const staleActiveFlag = { ...current, expiresAt: PAST };
  assert.equal(mayReplaceSlotPurchase(staleActiveFlag, voidedOlder, NOW), true);
  assert.equal(mayReplaceSlotPurchase(undefined, voidedOlder, NOW), true);
  assert.equal(
    mayReplaceSlotPurchase({ ...current, purchaseReference: undefined }, voidedOlder, NOW),
    true
  );
});

test("an expired purchase under another Apple ID never replaces the active one in its slot", () => {
  const current = applePurchase("original-apple-id-2", 1).subscription;
  assert.equal(current.active, true);
  assert.equal(mayReplaceSlotPurchase(current, applePurchase("original-apple-id-1", 2), NOW), false);
  assert.equal(mayReplaceSlotPurchase(current, applePurchase("original-apple-id-1", 5), NOW), false);
  assert.equal(mayReplaceSlotPurchase(current, applePurchase("original-apple-id-2", 5), NOW), true);
  assert.equal(mayReplaceSlotPurchase(current, applePurchase("original-apple-id-1", 1), NOW), true);
});

test("two lapsed states about different purchases: the slot keeps the one that ran later", () => {
  const OLDER_PAST = new Date("2025-11-01T00:00:00.000Z");
  const storedLapsed = googlePurchase("token-C-yearly", {
    state: "SUBSCRIPTION_STATE_EXPIRED",
    expiryTime: PAST,
  }).subscription;
  const olderVoid = googlePurchase("token-B-monthly", {
    state: "SUBSCRIPTION_STATE_EXPIRED",
    expiryTime: OLDER_PAST,
  });
  assert.equal(mayReplaceSlotPurchase(storedLapsed, olderVoid, NOW), false);
  const laterLapse = googlePurchase("token-E-later", {
    state: "SUBSCRIPTION_STATE_EXPIRED",
    expiryTime: PAST,
  });
  assert.equal(mayReplaceSlotPurchase(storedLapsed, laterLapse, NOW), true);

  // A stored purchase whose active flag outlived its expiry counts as lapsed too.
  const staleActive = { ...googlePurchase("token-C-yearly").subscription, expiresAt: PAST };
  assert.equal(mayReplaceSlotPurchase(staleActive, olderVoid, NOW), false);
  assert.equal(mayReplaceSlotPurchase(staleActive, laterLapse, NOW), true);

  // The same purchase or its chain is never held back by its expiry.
  const ownEarlierVoid = googlePurchase("token-C-yearly", {
    state: "SUBSCRIPTION_STATE_EXPIRED",
    expiryTime: OLDER_PAST,
  });
  assert.equal(mayReplaceSlotPurchase(storedLapsed, ownEarlierVoid, NOW), true);
});

test("an expired purchase's owner is accepted only when its binding, if any, is that owner's", () => {
  const secret = "unit-test-account-binding-secret-with-32-bytes";
  const ownerBinding = deriveAccountBinding("owner-uid", "google", secret);
  assert.equal(expiredTokenOwnerAccepted("owner-uid", undefined, undefined), true);
  assert.equal(expiredTokenOwnerAccepted("owner-uid", ownerBinding, secret), true);
  assert.equal(
    expiredTokenOwnerAccepted("someone-else", ownerBinding, secret),
    false
  );
  assert.throws(
    () => expiredTokenOwnerAccepted("owner-uid", ownerBinding, undefined),
    (error) => error instanceof SubscriptionError && error.kind === "configuration"
  );
});

test("acknowledgement is queued only for an unacknowledged, non-pending Play purchase", () => {
  const google = (state, acknowledgementState) => ({
    ...googlePurchase("token-ack"),
    google: { acknowledgementState, subscriptionState: state, startTime: NOW },
  });
  assert.equal(acknowledgementNeeded(google("SUBSCRIPTION_STATE_ACTIVE", "ACKNOWLEDGEMENT_STATE_PENDING")), true);
  assert.equal(acknowledgementNeeded(google("SUBSCRIPTION_STATE_ACTIVE", "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED")), false);
  assert.equal(acknowledgementNeeded(google("SUBSCRIPTION_STATE_PENDING", "ACKNOWLEDGEMENT_STATE_PENDING")), false);
  assert.equal(acknowledgementNeeded(googlePurchase("token-no-metadata")), false);
  assert.equal(acknowledgementNeeded(applePurchase("original-1", 1)), false);

  const owned = acknowledgementData(google("SUBSCRIPTION_STATE_ACTIVE", "ACKNOWLEDGEMENT_STATE_PENDING"), "uid-1", Timestamp.fromDate(NOW));
  assert.equal(owned.status, "pending");
  assert.equal(owned.uid, "uid-1");
  assert.equal(owned.purchaseToken, "token-ack");
  assert.equal(owned.deadlineAt.toMillis() - owned.purchasedAt.toMillis(), ACKNOWLEDGEMENT_DEADLINE_MS);
  const unowned = acknowledgementData(google("SUBSCRIPTION_STATE_ACTIVE", "ACKNOWLEDGEMENT_STATE_PENDING"), undefined, Timestamp.fromDate(NOW));
  assert.equal(unowned.status, "awaiting-owner");
  assert.ok(!Object.hasOwn(unowned, "uid"));
});

test("acknowledgement attempts move the document and keep nextAttemptAt only while work remains", () => {
  const done = attemptUpdate(0, "done", NOW);
  assert.equal(done.status, "done");
  assert.equal(done.attempts, 1);
  assert.ok(done.nextAttemptAt instanceof FieldValue);
  const retry = attemptUpdate(2, "transient", NOW);
  assert.equal(retry.status, "pending");
  assert.equal(retry.attempts, 3);
  assert.equal(retry.nextAttemptAt.toMillis(), NOW.getTime() + retryDelayMs(3));
  const abandoned = attemptUpdate(4, "permanent", NOW, "http-400");
  assert.equal(abandoned.status, "abandoned");
  assert.equal(abandoned.abandonReason, "http-400");
  assert.ok(abandoned.nextAttemptAt instanceof FieldValue);

  assert.equal(retryDelayMs(1), 15 * 60 * 1000);
  assert.equal(retryDelayMs(2), 30 * 60 * 1000);
  assert.equal(retryDelayMs(10), 6 * 60 * 60 * 1000);
});

test("acknowledge failures: conflicts, limits, permissions and outages retry; a rejection is final unless Play shows it acknowledged", async () => {
  const states = { "token-done": "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED", "token-open": "ACKNOWLEDGEMENT_STATE_PENDING" };
  setPlayApi({
    async getSubscription(token) {
      if (!(token in states)) throw { code: 500 };
      return { acknowledgementState: states[token] };
    },
    async acknowledgeSubscription() {},
    async listVoidedPurchases() { return {}; },
  });
  try {
    for (const code of [409, 429, 500, 503, 401, 403]) {
      assert.equal((await classifyAcknowledgeFailure({ code }, "premium_access", "token-open")).outcome, "transient", String(code));
    }
    assert.equal((await classifyAcknowledgeFailure(new Error("socket hang up"), "premium_access", "token-open")).outcome, "transient");
    assert.deepEqual(await classifyAcknowledgeFailure({ code: 400 }, "premium_access", "token-done"), { outcome: "done", code: "already-acknowledged" });
    assert.equal((await classifyAcknowledgeFailure({ code: 400 }, "premium_access", "token-open")).outcome, "permanent");
    assert.equal((await classifyAcknowledgeFailure({ code: 400 }, "premium_access", "token-unknown")).outcome, "transient");
  } finally {
    setPlayApi(undefined);
  }
});

test("the recovery window resumes a stored page, else runs checkpoint to now within what the feed serves", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const fresh = reconcileWindow({ retained: [] }, NOW, 30 * DAY);
  assert.equal(fresh.window.startAt.getTime(), NOW.getTime() - 30 * DAY);
  assert.equal(fresh.window.endAt.getTime(), NOW.getTime());
  assert.equal(fresh.gapMs, 0);

  const recent = reconcileWindow({ checkpointAt: new Date(NOW.getTime() - 6 * 60 * 60 * 1000), retained: [] }, NOW, 30 * DAY);
  assert.equal(recent.window.startAt.getTime(), NOW.getTime() - 6 * 60 * 60 * 1000);
  assert.equal(recent.gapMs, 0);

  const stale = reconcileWindow({ checkpointAt: new Date(NOW.getTime() - 40 * DAY), retained: [] }, NOW, 30 * DAY);
  assert.equal(stale.window.startAt.getTime(), NOW.getTime() - 30 * DAY);
  assert.equal(stale.gapMs, 10 * DAY);

  const stored = { startAt: PAST, endAt: new Date(NOW.getTime() - DAY), pageToken: "page-3" };
  const resumed = reconcileWindow({ checkpointAt: PAST, window: stored, retained: [] }, NOW, 30 * DAY);
  assert.deepEqual(resumed, { window: stored, gapMs: 0 });

  assert.equal(voidedEventKey({ orderId: "GPA.1234", purchaseToken: "token-a" }), "voided:GPA.1234");
  const fallback = voidedEventKey({ purchaseToken: "token-promo", voidedTimeMillis: "1700000000000" });
  assert.equal(fallback, `voided:${sha256Reference("token-promo")}:1700000000000`);
  assert.ok(!fallback.includes("token-promo"));

  assert.equal(isRetainableFailure(new SubscriptionError("store-unavailable", "x", "x", true)), true);
  assert.equal(isRetainableFailure(new SubscriptionError("configuration", "x", "x")), true);
  assert.equal(isRetainableFailure(new SubscriptionError("internal", "x", "x")), true);
  assert.equal(isRetainableFailure(new Error("socket hang up")), true);
  assert.equal(isRetainableFailure(new SubscriptionError("invalid-store-data", "x", "x")), false);
  assert.equal(isRetainableFailure(new SubscriptionError("ownership-conflict", "x", "x")), false);
});

test("a notification's id and environment can be read for the dedupe lookup without verifying it", () => {
  const encode = (payload) =>
    `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
  assert.deepEqual(
    decodeAppleNotificationIdentity(encode({ notificationUUID: "uuid-1", data: { environment: "Sandbox" } })),
    { notificationUUID: "uuid-1", environment: "sandbox" }
  );
  assert.deepEqual(
    decodeAppleNotificationIdentity(encode({ notificationUUID: "uuid-2", environment: "Production" })),
    { notificationUUID: "uuid-2", environment: "production" }
  );
  assert.throws(
    () => decodeAppleNotificationIdentity(encode({ data: { environment: "Sandbox" } })),
    (error) => error instanceof SubscriptionError && error.safeCode === "apple-notification-id-missing"
  );
  assert.throws(() => decodeAppleNotificationIdentity("not-a-jws"), (error) => error instanceof SubscriptionError);
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

test("zero days before replacing a device means no cooldown, not the default", () => {
  assert.deepEqual(resolveDeviceLimits({ days_before_replacing_device: 0 }), {
    maxDevices: 2,
    replacementCooldownDays: 0,
  });
});

test("device limits come from the public subscription settings with safe defaults", () => {
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
        max_number_of_devices: 3,
        days_before_replacing_device: 14,
    }),
    { maxDevices: 3, replacementCooldownDays: 14 }
  );
  assert.deepEqual(
    resolveDeviceLimits({
        max_number_of_devices: 0,
        days_before_replacing_device: -1,
    }),
    { maxDevices: 2, replacementCooldownDays: 7 }
  );
  assert.deepEqual(
    resolveDeviceLimits({
        max_number_of_devices: "3",
        days_before_replacing_device: 1.5,
    }),
    { maxDevices: 2, replacementCooldownDays: 7 }
  );
});

const LIMITS = { maxDevices: 2, replacementCooldownDays: 7 };
const USER = { actor: "user" };
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const emptyState = () => ({ allowedDevices: [], devices: {}, deviceLog: [], extraSeats: 0 });
const record = (name, platform, at = PAST) => ({ name, platform, registeredAt: at, lastSeenAt: at });
const twoDevices = (extra = {}) => ({
  allowedDevices: ["device-a", "device-b"],
  devices: { "device-a": record("iPhone", "ios"), "device-b": record("Pixel 7", "android") },
  deviceLog: [],
  extraSeats: 0,
  ...extra,
});
const register = (deviceId, name = "Phone", platform = "ios") => ({ action: "register", deviceId, name, platform });

test("device registration is free under the limit, keeps metadata and logs the user", () => {
  const first = applyDeviceAction(emptyState(), register("device-a", "iPhone", "ios"), LIMITS, NOW, USER);
  assert.equal(first.changed, true);
  assert.equal(first.persist, true);
  assert.deepEqual(first.state.allowedDevices, ["device-a"]);
  assert.deepEqual(first.state.devices["device-a"], {
    name: "iPhone",
    platform: "ios",
    registeredAt: NOW,
    lastSeenAt: NOW,
  });
  assert.deepEqual(first.state.deviceLog, [
    { at: NOW, actor: "user", action: "register", deviceId: "device-a" },
  ]);

  const response = buildDeviceResponse("register", true, first.state, LIMITS);
  assert.deepEqual(response, {
    action: "register",
    changed: true,
    max_number_of_devices: 2,
    allowed_devices: ["device-a"],
    devices: [
      {
        id: "device-a",
        name: "iPhone",
        platform: "ios",
        registered_at: NOW.toISOString(),
        last_seen_at: NOW.toISOString(),
      },
    ],
  });
});

test("registering a listed device touches it only when its last visit is older than a day", () => {
  const listed = {
    ...emptyState(),
    allowedDevices: ["device-a"],
    devices: { "device-a": record("Old name", "ios", NOW) },
  };

  const soon = applyDeviceAction(listed, register("device-a", "New name"), LIMITS, new Date(NOW.getTime() + 23 * HOUR), USER);
  assert.equal(soon.changed, false);
  assert.equal(soon.persist, false, "a launch within the day writes nothing");
  assert.equal(soon.state, listed);

  const later = new Date(NOW.getTime() + 25 * HOUR);
  const touched = applyDeviceAction(listed, register("device-a", "New name", "android"), LIMITS, later, USER);
  assert.equal(touched.changed, false);
  assert.equal(touched.persist, true);
  assert.deepEqual(touched.state.devices["device-a"], {
    name: "New name",
    platform: "ios",
    registeredAt: NOW,
    lastSeenAt: later,
  });
  assert.deepEqual(touched.state.deviceLog, [], "a touch is not logged");

  // A seat registered before devices had metadata gains a row on its first touch.
  const bare = { ...emptyState(), allowedDevices: ["device-a"] };
  const filled = applyDeviceAction(bare, register("device-a", "iPhone", "ios"), LIMITS, NOW, USER);
  assert.equal(filled.changed, false);
  assert.equal(filled.persist, true);
  assert.deepEqual(filled.state.devices["device-a"], record("iPhone", "ios", NOW));
});

test("device registration is rejected at the limit, with the list, unless extra seats exist", () => {
  const full = twoDevices();
  assert.throws(
    () => applyDeviceAction(full, register("device-c"), LIMITS, NOW, USER),
    (error) =>
      error.code === "resource-exhausted" &&
      error.details.code === "device-limit-reached" &&
      error.details.maxDevices === 2 &&
      error.details.devices.length === 2 &&
      error.details.devices[1].name === "Pixel 7" &&
      error.details.devices[1].platform === "android"
  );

  const result = applyDeviceAction(twoDevices({ extraSeats: 1 }), register("device-c"), LIMITS, NOW, USER);
  assert.equal(result.changed, true);
  assert.deepEqual(result.state.allowedDevices, ["device-a", "device-b", "device-c"]);
  assert.equal(buildDeviceResponse("register", true, result.state, LIMITS).max_number_of_devices, 3);
});

test("device removal enforces the replacement cooldown unless told to ignore it", () => {
  const first = applyDeviceAction(twoDevices(), { action: "unregister", deviceId: "device-a" }, LIMITS, NOW, USER);
  assert.equal(first.changed, true);
  assert.deepEqual(first.state.allowedDevices, ["device-b"]);
  assert.deepEqual(Object.keys(first.state.devices), ["device-b"]);
  assert.equal(first.state.lastReplacedAt, NOW);
  assert.deepEqual(first.state.deviceLog, [
    { at: NOW, actor: "user", action: "unregister", deviceId: "device-a" },
  ]);

  const insideWindow = new Date(NOW.getTime() + 3 * DAY);
  const cooling = twoDevices({ lastReplacedAt: NOW });
  assert.throws(
    () => applyDeviceAction(cooling, { action: "unregister", deviceId: "device-b" }, LIMITS, insideWindow, USER),
    (error) =>
      error.code === "failed-precondition" &&
      error.details.code === "device-replacement-cooldown" &&
      error.details.nextAllowedAt === nextReplacementAllowedAt(NOW, LIMITS).toISOString()
  );

  const admin = applyDeviceAction(
    cooling,
    { action: "unregister", deviceId: "device-b" },
    LIMITS,
    insideWindow,
    { actor: "admin:a1", ignoreCooldown: true }
  );
  assert.equal(admin.changed, true);
  assert.deepEqual(admin.state.allowedDevices, ["device-a"]);
  assert.equal(admin.state.lastReplacedAt, NOW, "an admin removal does not restart the user's cooldown");
  assert.equal(admin.state.deviceLog[0].actor, "admin:a1");

  const afterWindow = new Date(NOW.getTime() + 8 * DAY);
  const second = applyDeviceAction(cooling, { action: "unregister", deviceId: "device-b" }, LIMITS, afterWindow, USER);
  assert.equal(second.changed, true);
  assert.equal(second.state.lastReplacedAt, afterWindow);
});

test("removing an unknown device is a no-op that keeps the cooldown intact and writes nothing", () => {
  const state = twoDevices({ lastReplacedAt: NOW });
  const result = applyDeviceAction(state, { action: "unregister", deviceId: "device-x" }, LIMITS, new Date(NOW.getTime() + DAY), USER);
  assert.equal(result.changed, false);
  assert.equal(result.persist, false);
  assert.equal(result.state, state);
  const listed = applyDeviceAction(state, { action: "list" }, LIMITS, NOW, USER);
  assert.equal(listed.persist, false);
  assert.equal(listed.state, state);
});

test("replace swaps a seat in one step and leaves the state untouched when either half is refused", () => {
  const replace = { action: "replace", removeDeviceId: "device-a", deviceId: "device-c", name: "iPad", platform: "ios" };
  const result = applyDeviceAction(twoDevices(), replace, LIMITS, NOW, USER);
  assert.equal(result.changed, true);
  assert.deepEqual(result.state.allowedDevices, ["device-b", "device-c"]);
  assert.deepEqual(Object.keys(result.state.devices).sort(), ["device-b", "device-c"]);
  assert.equal(result.state.devices["device-c"].name, "iPad");
  assert.equal(result.state.lastReplacedAt, NOW);
  assert.deepEqual(result.state.deviceLog, [
    { at: NOW, actor: "user", action: "replace", deviceId: "device-c", removedDeviceId: "device-a" },
  ]);

  // Inside the cooldown the removal is refused before anything is added.
  assert.throws(
    () => applyDeviceAction(twoDevices({ lastReplacedAt: NOW }), replace, LIMITS, new Date(NOW.getTime() + DAY), USER),
    (error) => error.details.code === "device-replacement-cooldown"
  );

  // Removing a device that is not listed frees nothing, so the register side
  // hits the limit and the removed seat is never lost.
  assert.throws(
    () => applyDeviceAction(twoDevices(), { ...replace, removeDeviceId: "device-x" }, LIMITS, NOW, USER),
    (error) => error.details.code === "device-limit-reached" && error.details.devices.length === 2
  );
});

test("registering needs an active master with a future expiry", () => {
  const active = { active: true, expiresAt: Timestamp.fromDate(FUTURE) };
  assert.doesNotThrow(() => assertMasterActive(active, NOW));
  for (const data of [
    { active: false, expiresAt: Timestamp.fromDate(FUTURE) },
    { active: true, expiresAt: Timestamp.fromDate(PAST) },
    { active: true, expiresAt: Timestamp.fromDate(NOW) },
    { active: true },
    {},
  ]) {
    assert.throws(
      () => assertMasterActive(data, NOW),
      (error) => error instanceof SubscriptionError && error.safeCode === "subscription-not-active"
    );
  }
  const callable = asCallableError((() => {
    try {
      assertMasterActive({}, NOW);
    } catch (error) {
      return error;
    }
  })());
  assert.equal(callable.code, "failed-precondition");
  assert.equal(callable.details.code, "subscription-not-active");
});

test("the device log keeps only the last entries", () => {
  let state = { ...emptyState(), extraSeats: 100 };
  for (let i = 0; i < MAX_DEVICE_LOG_ENTRIES + 5; i++) {
    state = applyDeviceAction(state, register(`device-${i}`), LIMITS, new Date(NOW.getTime() + i), USER).state;
  }
  assert.equal(state.deviceLog.length, MAX_DEVICE_LOG_ENTRIES);
  assert.equal(state.deviceLog[0].deviceId, "device-5");
  assert.equal(state.deviceLog[MAX_DEVICE_LOG_ENTRIES - 1].deviceId, `device-${MAX_DEVICE_LOG_ENTRIES + 4}`);
  const update = deviceStateUpdate(emptyState(), state, NOW);
  assert.equal(update.device_log.length, MAX_DEVICE_LOG_ENTRIES);
});

test("the master update writes only what the action owns", () => {
  const before = twoDevices();
  const registered = applyDeviceAction({ ...before, extraSeats: 1 }, register("device-c"), LIMITS, NOW, USER);
  const update = deviceStateUpdate({ ...before, extraSeats: 1 }, registered.state, NOW);
  assert.deepEqual(Object.keys(update).sort(), ["allowed_devices", "device_log", "devices", "updatedAt"]);
  assert.deepEqual(Object.keys(update.devices).sort(), ["device-a", "device-b", "device-c"]);
  assert.ok(update.devices["device-c"].registeredAt instanceof Timestamp);
  assert.deepEqual(update.device_log[0], {
    at: Timestamp.fromDate(NOW),
    actor: "user",
    action: "register",
    deviceId: "device-c",
  });

  const removed = applyDeviceAction(before, { action: "unregister", deviceId: "device-a" }, LIMITS, NOW, USER);
  const removal = deviceStateUpdate(before, removed.state, NOW);
  assert.deepEqual(removal.last_date_replacing_device, Timestamp.fromDate(NOW));
  assert.ok(!Object.hasOwn(removal.devices, "device-a"), "the row leaves with the seat");

  // A row for an id that is no longer listed is not carried into the document.
  const orphaned = { ...before, allowedDevices: ["device-a"] };
  assert.deepEqual(Object.keys(deviceStateUpdate(orphaned, orphaned, NOW).devices), ["device-a"]);
});

test("admin device actions ignore the cooldown, set seats within bounds and clear the cooldown", () => {
  const cooling = twoDevices({ lastReplacedAt: NOW });
  const now = new Date(NOW.getTime() + DAY);

  const removed = applyAdminDeviceAction(cooling, { action: "removeDevice", deviceId: "device-a" }, LIMITS, now, "admin-1");
  assert.deepEqual(removed.state.allowedDevices, ["device-b"]);
  assert.equal(removed.state.lastReplacedAt, NOW);
  assert.deepEqual(removed.state.deviceLog, [
    { at: now, actor: "admin:admin-1", action: "unregister", deviceId: "device-a" },
  ]);

  const seats = applyAdminDeviceAction(cooling, { action: "setExtraSeats", seats: 3 }, LIMITS, now, "admin-1");
  assert.equal(seats.changed, true);
  assert.equal(seats.state.extraSeats, 3);
  assert.deepEqual(seats.state.deviceLog, [{ at: now, actor: "admin:admin-1", action: "setExtraSeats", seats: 3 }]);
  assert.deepEqual(deviceStateUpdate(cooling, seats.state, now).extra_device_seats, 3);
  assert.equal(buildDeviceResponse("setExtraSeats", true, seats.state, LIMITS).max_number_of_devices, 5);
  const same = applyAdminDeviceAction(cooling, { action: "setExtraSeats", seats: 0 }, LIMITS, now, "admin-1");
  assert.equal(same.persist, false);
  for (const invalid of [-1, 11, 1.5, "2", undefined]) {
    assert.throws(
      () => assertExtraSeats(invalid),
      (error) => error instanceof SubscriptionError && error.safeCode === "seats-invalid"
    );
  }
  assert.equal(assertExtraSeats(10), 10);

  const reset = applyAdminDeviceAction(cooling, { action: "resetDeviceCooldown" }, LIMITS, now, "admin-1");
  assert.equal(reset.changed, true);
  assert.equal(reset.state.lastReplacedAt, undefined);
  assert.deepEqual(deviceStateUpdate(cooling, reset.state, now).last_date_replacing_device, FieldValue.delete());
  assert.ok(!Object.hasOwn(buildDeviceResponse("resetDeviceCooldown", true, reset.state, LIMITS), "next_replacement_allowed_at"));
  const nothing = applyAdminDeviceAction(twoDevices(), { action: "resetDeviceCooldown" }, LIMITS, now, "admin-1");
  assert.equal(nothing.persist, false);

  const listed = applyAdminDeviceAction(cooling, { action: "listDevices" }, LIMITS, now, "admin-1");
  assert.equal(listed.persist, false);
  assert.equal(listed.state, cooling);
});

test("a store-driven rebuild updates only the fields the projection owns", () => {
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
    Timestamp.fromDate(NOW),
    buildSourceSummaries([state])
  );
  const existing = {
    allowed_devices: ["device-a", "device-b"],
    devices: {
      "device-a": { name: "iPhone", platform: "ios", registeredAt: Timestamp.fromDate(PAST), lastSeenAt: Timestamp.fromDate(NOW) },
    },
    device_log: [{ at: Timestamp.fromDate(PAST), actor: "user", action: "register", deviceId: "device-a" }],
    last_date_replacing_device: Timestamp.fromDate(PAST),
    extra_device_seats: 1,
    // A field this build has never heard of, as a newer device feature would add.
    future_device_field: "kept",
    productId: "stale-value-not-carried",
    originalTransactionId: "apple-original-from-the-previous-state",
    manual: { activeGrantCount: 1, grantSource: "admin_manual_add", ledgerRevision: 5 },
  };

  // The written update names no field the projection does not own.
  const update = masterProjectionUpdate(rebuilt);
  for (const field of Object.keys(existing).filter((key) => key !== "productId" && !MASTER_PROJECTION_OPTIONAL_FIELDS.includes(key))) {
    assert.ok(!Object.hasOwn(update, field), `${field} must not be written by the projection`);
  }
  assert.equal(update.productId, "premium_access");
  assert.equal(update.purchaseReference, rebuilt.purchaseReference);
  assert.equal(update.autoRenewing, true);
  assert.deepEqual(update.originalTransactionId, FieldValue.delete());
  assert.deepEqual(update.manual, FieldValue.delete());
  assert.deepEqual(update.sources, rebuilt.sources);

  // The returned document is what the update leaves behind.
  const after = masterAfterProjection(rebuilt, existing);
  assert.deepEqual(after.allowed_devices, ["device-a", "device-b"]);
  assert.equal(after.devices, existing.devices);
  assert.equal(after.device_log, existing.device_log);
  assert.equal(after.last_date_replacing_device, existing.last_date_replacing_device);
  assert.equal(after.extra_device_seats, 1);
  assert.equal(after.future_device_field, "kept");
  assert.equal(after.productId, "premium_access");
  assert.ok(!Object.hasOwn(after, "originalTransactionId"));
  assert.ok(!Object.hasOwn(after, "manual"));
  assert.equal(masterDataToResponse(after).devices.devices[0].name, "iPhone");

  const fresh = masterAfterProjection(rebuilt, undefined);
  assert.deepEqual(fresh, rebuilt);
  assert.ok(!Object.hasOwn(fresh, "allowed_devices"));
  assert.ok(!Object.hasOwn(fresh, "devices"));
});

test("every field the projection writes only sometimes is listed as optional", () => {
  const full = buildMasterProjection(
    {
      active: true,
      status: "active",
      platform: "apple",
      productId: "premium_access",
      expiresAt: FUTURE,
      autoRenewing: true,
      inGracePeriod: false,
      environment: "production",
      originalTransactionId: "original",
      lastStoreEventAt: NOW,
      lastVerifiedAt: NOW,
    },
    Timestamp.fromDate(NOW),
    Timestamp.fromDate(NOW),
    []
  );
  const minimal = buildMasterProjection(
    {
      active: false,
      status: "expired",
      platform: "google",
      productId: "premium_access",
      expiresAt: PAST,
      inGracePeriod: false,
      environment: "production",
      lastStoreEventAt: NOW,
      lastVerifiedAt: NOW,
    },
    Timestamp.fromDate(NOW),
    Timestamp.fromDate(NOW)
  );
  const manual = buildMasterProjection(
    {
      active: true,
      status: "active",
      platform: "manual",
      productId: "manual_grant",
      expiresAt: FUTURE,
      inGracePeriod: false,
      environment: "production",
      lastStoreEventAt: NOW,
      lastVerifiedAt: NOW,
      manual: { activeGrantCount: 1 },
    },
    Timestamp.fromDate(NOW),
    Timestamp.fromDate(NOW)
  );
  const google = buildMasterProjection(
    {
      active: true,
      status: "active",
      platform: "google",
      productId: "premium_access",
      expiresAt: FUTURE,
      inGracePeriod: false,
      environment: "production",
      purchaseReference: "reference",
      lastStoreEventAt: NOW,
      lastVerifiedAt: NOW,
    },
    Timestamp.fromDate(NOW),
    Timestamp.fromDate(NOW)
  );
  const always = Object.keys(minimal);
  const sometimes = [...new Set([full, manual, google].flatMap((data) => Object.keys(data)))]
    .filter((field) => !always.includes(field));
  assert.deepEqual([...sometimes].sort(), [...MASTER_PROJECTION_OPTIONAL_FIELDS].sort());
  for (const field of MASTER_PROJECTION_OPTIONAL_FIELDS) {
    assert.ok(!always.includes(field), `${field} is always written, so it is not optional`);
  }
});

test("device state parsing tolerates missing and malformed fields", () => {
  assert.deepEqual(deviceStateFromMaster({}), {
    allowedDevices: [],
    devices: {},
    deviceLog: [],
    lastReplacedAt: undefined,
    extraSeats: 0,
  });
  const parsed = deviceStateFromMaster({
    allowed_devices: ["device-a", 42, "", "device-b"],
    devices: {
      "device-a": { name: "iPhone", platform: "ios", registeredAt: Timestamp.fromDate(PAST), lastSeenAt: Timestamp.fromDate(NOW) },
      "device-b": { name: "no dates", platform: "android" },
      "device-c": { name: 7, platform: "web", registeredAt: Timestamp.fromDate(PAST), lastSeenAt: Timestamp.fromDate(PAST) },
      "device-d": "not a row",
      "device-e": { platform: "android", registeredAt: Timestamp.fromDate(PAST), lastSeenAt: Timestamp.fromDate(PAST) },
    },
    device_log: [
      { at: Timestamp.fromDate(PAST), actor: "user", action: "register", deviceId: "device-a" },
      { at: "not a timestamp", actor: "user", action: "register" },
      { at: Timestamp.fromDate(PAST), actor: "admin:x", action: "setExtraSeats", seats: 2, deviceId: 5 },
      null,
      "junk",
    ],
    last_date_replacing_device: Timestamp.fromDate(NOW),
    extra_device_seats: 2,
  });
  assert.deepEqual(parsed.allowedDevices, ["device-a", "device-b"]);
  assert.deepEqual(Object.keys(parsed.devices).sort(), ["device-a", "device-e"]);
  assert.equal(parsed.devices["device-e"].name, "", "a missing name reads as empty");
  assert.deepEqual(parsed.deviceLog, [
    { at: PAST, actor: "user", action: "register", deviceId: "device-a" },
    { at: PAST, actor: "admin:x", action: "setExtraSeats", seats: 2 },
  ]);
  assert.equal(parsed.lastReplacedAt.toISOString(), NOW.toISOString());
  assert.equal(parsed.extraSeats, 2);

  for (const devices of [[], "map", 3, null]) {
    assert.deepEqual(deviceStateFromMaster({ devices, device_log: {} }).devices, {});
    assert.deepEqual(deviceStateFromMaster({ devices, device_log: {} }).deviceLog, []);
  }

  // A bare legacy id shows up in the response with no metadata.
  const response = buildDeviceResponse("list", false, parsed, LIMITS);
  assert.deepEqual(response.devices[1], { id: "device-b", name: "", platform: "unknown" });
});

test("the subscription response carries the device block, with the limit only when settings were read", () => {
  const stamp = Timestamp.fromDate(NOW);
  const master = {
    active: true,
    status: "active",
    platform: "google",
    productId: "premium_access",
    expiresAt: Timestamp.fromDate(FUTURE),
    inGracePeriod: false,
    environment: "production",
    lastStoreEventAt: stamp,
    lastVerifiedAt: stamp,
    createdAt: stamp,
    updatedAt: stamp,
    allowed_devices: ["device-a"],
    devices: { "device-a": { name: "iPhone", platform: "ios", registeredAt: stamp, lastSeenAt: stamp } },
    extra_device_seats: 1,
    last_date_replacing_device: Timestamp.fromDate(PAST),
  };
  assert.deepEqual(masterDataToResponse(master).devices, {
    allowed_devices: ["device-a"],
    devices: [
      { id: "device-a", name: "iPhone", platform: "ios", registered_at: NOW.toISOString(), last_seen_at: NOW.toISOString() },
    ],
    extra_device_seats: 1,
    last_date_replacing_device: PAST.toISOString(),
  });
  assert.equal(masterDataToResponse(master, LIMITS).devices.max_number_of_devices, 3);
  const { allowed_devices, devices, extra_device_seats, last_date_replacing_device, ...bare } = master;
  assert.deepEqual(masterDataToResponse(bare).devices, { allowed_devices: [], devices: [], extra_device_seats: 0 });
});

test("the device callable validates the exact field set of each action", () => {
  const { readDeviceActionInput } = require("../lib/handlers/verifiedSubscriptionHandlers");
  const refused = (action, request, code) =>
    assert.throws(
      () => readDeviceActionInput(action, { action, ...request }),
      (error) => error instanceof SubscriptionError && error.safeCode === code,
      `${action} ${JSON.stringify(request)} should fail with ${code}`
    );

  assert.deepEqual(readDeviceActionInput("list", { action: "list" }), { action: "list" });
  assert.deepEqual(readDeviceActionInput("unregister", { action: "unregister", deviceId: " d1 " }), {
    action: "unregister",
    deviceId: "d1",
  });
  assert.deepEqual(readDeviceActionInput("register", { action: "register", deviceId: "d1", platform: "ios" }), {
    action: "register",
    deviceId: "d1",
    name: "",
    platform: "ios",
  });
  assert.deepEqual(
    readDeviceActionInput("replace", { action: "replace", deviceId: "d2", removeDeviceId: "d1", platform: "android", name: " Pixel " }),
    { action: "replace", deviceId: "d2", removeDeviceId: "d1", name: "Pixel", platform: "android" }
  );

  refused("list", { deviceId: "d1" }, "request-fields-invalid");
  refused("unregister", { deviceId: "d1", name: "x" }, "request-fields-invalid");
  refused("register", { deviceId: "d1" }, "request-fields-invalid");
  refused("register", { deviceId: "d1", platform: "web" }, "device-platform-invalid");
  refused("register", { deviceId: "d1", platform: "unknown" }, "device-platform-invalid");
  refused("register", { deviceId: "", platform: "ios" }, "device-id-invalid");
  refused("register", { deviceId: "x".repeat(129), platform: "ios" }, "device-id-invalid");
  refused("register", { deviceId: "d1", platform: "ios", name: "n".repeat(65) }, "device-name-invalid");
  refused("register", { deviceId: "d1", platform: "ios", name: 5 }, "device-name-invalid");
  refused("replace", { deviceId: "d1", removeDeviceId: "d1", platform: "ios" }, "device-id-invalid");
  refused("replace", { deviceId: "d2", platform: "ios" }, "request-fields-invalid");
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

const { classifyGoogleRtdn } = require("../lib/handlers/verifiedSubscriptionHandlers");

test("Play notifications sort into the kinds the handler acts on", () => {
  assert.deepEqual(classifyGoogleRtdn({ testNotification: { version: "1.0" } }), { kind: "test" });
  assert.deepEqual(
    classifyGoogleRtdn({ oneTimeProductNotification: { notificationType: 1 } }),
    { kind: "oneTimeProduct" }
  );
  assert.deepEqual(
    classifyGoogleRtdn({
      pendingRefundReviewNotification: { pendingRefundToken: "secret", orderId: "GPA.1", refundReason: 7 },
    }),
    { kind: "pendingRefundReview", refundReason: 7 }
  );
  assert.deepEqual(
    classifyGoogleRtdn({ subscriptionNotification: { notificationType: 2, purchaseToken: "token-renewed" } }),
    { kind: "store", notificationType: "SUBSCRIPTION_RENEWED", purchaseToken: "token-renewed" }
  );
  assert.deepEqual(
    classifyGoogleRtdn({ subscriptionNotification: { notificationType: 99, purchaseToken: "token-new" } }),
    { kind: "store", notificationType: "SUBSCRIPTION_99", purchaseToken: "token-new" }
  );
  assert.deepEqual(
    classifyGoogleRtdn({
      voidedPurchaseNotification: { purchaseToken: "token-voided", orderId: "GPA.2", productType: 1, refundType: 1 },
    }),
    { kind: "store", notificationType: "VOIDED_PURCHASE", purchaseToken: "token-voided", refundType: 1 }
  );
});

test("an unrecognised Play notification reports its key names only", () => {
  const classification = classifyGoogleRtdn({
    version: "1.0",
    packageName: "ca.basira.mantooqapp",
    eventTimeMillis: "1760646423000",
    futureNotification: { token: "must-not-leak" },
    "bad key": 1,
  });
  assert.deepEqual(classification, {
    kind: "unknown",
    payloadKeys: ["eventTimeMillis", "futureNotification", "packageName", "version"],
  });
  assert.ok(!JSON.stringify(classification).includes("must-not-leak"));
  const many = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`key${index}`, index]));
  assert.equal(classifyGoogleRtdn(many).payloadKeys.length, 10);
});

test("malformed Play store notifications are rejected with their own codes", () => {
  const codeOf = (payload) => {
    try {
      classifyGoogleRtdn(payload);
    } catch (error) {
      return error.safeCode;
    }
    return undefined;
  };
  assert.equal(
    codeOf({ voidedPurchaseNotification: { purchaseToken: "token-voided", productType: 2 } }),
    "google-voided-product-not-subscription"
  );
  assert.equal(codeOf({ voidedPurchaseNotification: { productType: 1 } }), "google-purchase-token-missing");
  assert.equal(codeOf({ subscriptionNotification: { notificationType: 2 } }), "google-purchase-token-missing");
  assert.equal(
    codeOf({ subscriptionNotification: { notificationType: "2", purchaseToken: "token" } }),
    "google-notification-type-invalid"
  );
});

// ---------------------------------------------------------------------------
// Dashboard stats
// ---------------------------------------------------------------------------

const {
  computeStats,
  STATS_DAILY_DAYS,
  STATS_MONTHLY_MONTHS,
} = require("../lib/services/subscriptions/stats");

const STATS_NOW = new Date("2026-10-20T10:00:00.000Z"); // 13:00 in Cairo
const STATS_DAY = 24 * 60 * 60 * 1000;
const at = (iso) => Timestamp.fromDate(new Date(iso));
const daysAgo = (days) => Timestamp.fromDate(new Date(STATS_NOW.getTime() - days * STATS_DAY));
const statsInput = (parts = {}) => ({
  masters: [],
  slots: [],
  events: [],
  egyptRequests: [],
  migrationRequests: [],
  archive: [],
  ...parts,
});
const masterRow = (uid, data) => ({
  id: uid,
  data: { active: true, status: "active", environment: "production", expiresAt: daysAgo(-60), ...data },
});
const storeSlot = (uid, platform, environment, createdAt, expiresAt = daysAgo(-30)) => ({
  id: `${uid}_${platform}_${environment}`,
  data: { uid, platform, environment, createdAt, expiresAt, active: true, status: "active" },
});
const manualSlotRow = (uid, grants, createdAt = at("2026-10-11T09:00:00.000Z")) => ({
  id: `${uid}_manual_production`,
  data: { uid, platform: "manual", environment: "production", createdAt, expiresAt: daysAgo(-30), grants },
});
const grantRow = (grantId, grantedAt, extra = {}) => ({
  grantId,
  kind: "months",
  months: 3,
  base: "extend",
  grantedAt,
  grantedBy: "admin-1",
  status: "active",
  metadata: { grantSource: "admin_manual_add" },
  ...extra,
});
const eventRow = (id, platform, environment, eventType, eventAt) => ({
  id,
  data: { platform, environment, eventType, eventAt, createdAt: eventAt },
});
const requestRow = (id, data, updateTime) => ({
  id,
  data: { amount_paid: 200, payment_method: "Instapay", duration: "3_months", ...data },
  updateTime,
});
const dayOf = (document, date) => document.daily.find((point) => point.date === date);
const monthOf = (document, month) => document.monthly.find((point) => point.month === month);

test("stats: an empty database gives a full, zeroed document", () => {
  const { document, archiveRows } = computeStats(statsInput(), STATS_NOW);
  assert.equal(document.schemaVersion, 1);
  assert.equal(document.generatedAt, STATS_NOW.toISOString());
  assert.equal(document.timeZone, "Africa/Cairo");
  assert.equal(document.today, "2026-10-20");
  assert.equal(document.daily.length, STATS_DAILY_DAYS);
  assert.equal(document.daily[0].date, "2026-07-23");
  assert.equal(document.daily.at(-1).date, "2026-10-20");
  assert.equal(document.daily.at(-1).estimated, false);
  assert.ok(document.daily.slice(0, -1).every((point) => point.estimated));
  assert.equal(document.monthly.length, STATS_MONTHLY_MONTHS);
  assert.equal(document.monthly[0].month, "2024-11");
  assert.equal(document.monthly.at(-1).month, "2026-10");
  assert.deepEqual(document.summary.active, {
    total: 0, apple: 0, google: 0, manual: 0,
    manualBySource: { egypt_request: 0, migration_restoration: 0, admin_manual_add: 0, legacy_import: 0, unknown: 0 },
  });
  assert.equal(document.summary.activeChange30d, null);
  assert.equal(document.summary.medianHoursToApproval30d, null);
  assert.deepEqual(document.summary.pendingRequests, { egypt: 0, migration: 0 });
  assert.deepEqual(document.summary.revenueByMethodThisMonth, {});
  // The first run backfills the whole window.
  assert.equal(archiveRows.length, STATS_DAILY_DAYS);
  // Firestore rejects undefined anywhere in a document.
  assert.ok(!JSON.stringify(document, (key, value) => (value === undefined ? "UNDEFINED" : value)).includes("UNDEFINED"));
});

test("stats: active counts production masters that have not expired, whatever the stored flag says", () => {
  const { document } = computeStats(
    statsInput({
      masters: [
        masterRow("apple-1", { platform: "apple", autoRenewing: true }),
        masterRow("google-1", { platform: "google", autoRenewing: false, expiresAt: daysAgo(-3) }),
        masterRow("manual-1", { platform: "manual", manual: { grantSource: "egypt_request" }, expiresAt: daysAgo(-20) }),
        masterRow("manual-2", { platform: "manual" }),
        // Stale: still flagged active, but the expiry has passed.
        masterRow("stale-1", { platform: "apple", expiresAt: daysAgo(1) }),
        // Sandbox only.
        masterRow("sandbox-1", { platform: "apple", environment: "sandbox" }),
        masterRow("off-1", { platform: "google", active: false }),
      ],
      slots: [storeSlot("sandbox-1", "apple", "sandbox", daysAgo(2))],
    }),
    STATS_NOW
  );
  const { active } = document.summary;
  assert.deepEqual(
    { total: active.total, apple: active.apple, google: active.google, manual: active.manual },
    { total: 4, apple: 1, google: 1, manual: 2 }
  );
  assert.equal(active.manualBySource.egypt_request, 1);
  assert.equal(active.manualBySource.unknown, 1);
  assert.deepEqual(document.daily.at(-1).active, { total: 4, apple: 1, google: 1, manual: 2 });
  assert.equal(document.summary.expiring7d, 1);
  assert.equal(document.summary.expiring7dNotRenewing, 1);
  assert.equal(document.summary.expiring30d, 2);
  // The sandbox slot never makes its user new.
  assert.equal(document.summary.newThisMonth, 0);
});

test("stats: a user with a store and a manual source is one subscriber, new once, at the earliest start", () => {
  const { document } = computeStats(
    statsInput({
      masters: [
        masterRow("both-1", {
          platform: "apple",
          sources: [
            { platform: "apple", environment: "production", status: "active", expiresAt: daysAgo(-30) },
            { platform: "manual", environment: "production", status: "active", expiresAt: daysAgo(-10) },
            { platform: "google", environment: "test", status: "active", expiresAt: daysAgo(-10) },
          ],
        }),
      ],
      slots: [
        storeSlot("both-1", "apple", "production", at("2026-10-05T08:00:00.000Z")),
        manualSlotRow("both-1", [grantRow("op-both-1", at("2026-10-02T08:00:00.000Z"), { months: 1 })], at("2026-10-02T08:00:00.000Z")),
      ],
    }),
    STATS_NOW
  );
  assert.equal(document.summary.active.total, 1);
  assert.equal(document.summary.activeMultiSource, 1);
  assert.equal(document.summary.newThisMonth, 1);
  assert.equal(dayOf(document, "2026-10-02").new, 1);
  assert.equal(dayOf(document, "2026-10-05").new, 0);
  // Estimated: manual only on the 3rd, the store slot is the longer source from the 5th.
  assert.deepEqual(dayOf(document, "2026-10-03").active, { total: 1, apple: 0, google: 0, manual: 1 });
  assert.deepEqual(dayOf(document, "2026-10-06").active, { total: 1, apple: 1, google: 0, manual: 0 });
});

test("stats: a reversed grant is neither a start nor a grant, and an undated legacy baseline is never new", () => {
  const importedAt = at("2026-10-11T09:00:00.000Z");
  const { document } = computeStats(
    statsInput({
      slots: [
        manualSlotRow("reversed-1", [
          grantRow("op-reversed", at("2026-10-12T09:00:00.000Z"), { status: "reversed", statusChangedAt: at("2026-10-12T10:00:00.000Z") }),
        ]),
        // The old document had no date, so the import dated the baseline at the import.
        manualSlotRow("undated-1", [
          grantRow("legacy_doc-undated", importedAt, { kind: "absolute", expiresAt: daysAgo(-40), metadata: { grantSource: "legacy_import", amountPaid: 700 } }),
        ], importedAt),
        // The old document carried its paid date, months before the import.
        manualSlotRow("dated-1", [
          grantRow("legacy_doc-dated", at("2026-05-12T18:27:39.000Z"), { kind: "absolute", expiresAt: daysAgo(-40), metadata: { grantSource: "legacy_import" } }),
        ], importedAt),
      ],
    }),
    STATS_NOW
  );
  assert.equal(dayOf(document, "2026-10-11").new, 0);
  assert.equal(dayOf(document, "2026-10-11").manualGrants, 0);
  assert.equal(dayOf(document, "2026-10-12").new, 0);
  assert.equal(dayOf(document, "2026-10-12").manualGrants, 0);
  assert.equal(monthOf(document, "2026-05").new, 1);
  assert.equal(monthOf(document, "2026-05").manualGrants, 1);
  assert.equal(document.summary.newThisMonth, 0);
  // An undated amount is left out rather than dated at the import.
  assert.equal(document.summary.revenueThisMonthEgp, 0);
  // Both baselines still count as active before the import in the estimate.
  assert.equal(document.daily[0].active.manual, 2);
});

test("stats: store events count by type in production only, and the Google TEST ping is ignored", () => {
  const { document } = computeStats(
    statsInput({
      events: [
        eventRow("e1", "apple", "production", "DID_RENEW", at("2026-10-19T08:00:00.000Z")),
        eventRow("e2", "google", "production", "SUBSCRIPTION_RENEWED", at("2026-10-19T09:00:00.000Z")),
        eventRow("e3", "apple", "production", "EXPIRED", at("2026-10-19T09:00:00.000Z")),
        eventRow("e4", "google", "production", "SUBSCRIPTION_EXPIRED", at("2026-10-19T09:00:00.000Z")),
        eventRow("e5", "apple", "production", "REFUND", at("2026-10-19T09:00:00.000Z")),
        eventRow("e6", "google", "production", "SUBSCRIPTION_REVOKED", at("2026-10-19T09:00:00.000Z")),
        eventRow("e7", "google", "production", "VOIDED_PURCHASE", at("2026-10-19T09:00:00.000Z")),
        eventRow("e8", "google", "test", "TEST", at("2026-10-19T09:00:00.000Z")),
        eventRow("e9", "google", "test", "SUBSCRIPTION_RENEWED", at("2026-10-19T09:00:00.000Z")),
        eventRow("e10", "apple", "sandbox", "REFUND", at("2026-10-19T09:00:00.000Z")),
        eventRow("e11", "apple", "production", "DID_CHANGE_RENEWAL_STATUS", at("2026-10-19T09:00:00.000Z")),
      ],
    }),
    STATS_NOW
  );
  const day = dayOf(document, "2026-10-19");
  assert.deepEqual(
    { renewals: day.renewals, expirations: day.expirations, refunds: day.refunds },
    { renewals: 2, expirations: 2, refunds: 3 }
  );
});

test("stats: a request approved after it was created is received, approved and paid on its own days", () => {
  const createdAt = at("2026-10-14T06:00:00.000Z");
  const approvedAt = at("2026-10-15T08:00:00.000Z");
  const { document } = computeStats(
    statsInput({
      egyptRequests: [
        requestRow("req-1", { user_guid: "egypt-1", status: "approved", amount_paid: 700, created_at: createdAt }, new Date("2026-10-18T00:00:00.000Z")),
        // Rejected while pending: no grant, so the last write dates it.
        requestRow("req-2", { user_guid: "egypt-2", status: "rejected", created_at: createdAt }, new Date("2026-10-16T09:00:00.000Z")),
        requestRow("req-3", { user_guid: "egypt-3", status: "pending", created_at: createdAt }),
      ],
      migrationRequests: [
        { id: "mig-1", data: { user_guid: "mig-1", status: "pending", created_at: createdAt } },
      ],
      slots: [
        manualSlotRow("egypt-1", [
          grantRow("subscriptions_to_be_approved_req-1_r1", approvedAt, {
            queue: { collection: "subscriptions_to_be_approved", id: "req-1" },
            metadata: { grantSource: "egypt_request", amountPaid: 700 },
          }),
        ], approvedAt),
      ],
    }),
    STATS_NOW
  );
  assert.equal(dayOf(document, "2026-10-14").requestsReceived, 4);
  assert.equal(dayOf(document, "2026-10-15").requestsApproved, 1);
  assert.equal(dayOf(document, "2026-10-18").requestsApproved, 0);
  assert.equal(dayOf(document, "2026-10-16").requestsRejected, 1);
  assert.deepEqual(document.summary.pendingRequests, { egypt: 1, migration: 1 });
  assert.equal(document.summary.medianHoursToApproval30d, 26);
  // Paid on the request's date, once, although the grant carries the amount too.
  assert.equal(dayOf(document, "2026-10-14").revenueEgp, 700);
  assert.equal(dayOf(document, "2026-10-15").revenueEgp, 0);
  assert.deepEqual(document.summary.revenueByMethodThisMonth, { Instapay: 700 });
  assert.equal(dayOf(document, "2026-10-15").new, 1);
});

test("stats: an old-portal approval is dated by the legacy baseline, whose amount is the same payment", () => {
  const { document } = computeStats(
    statsInput({
      egyptRequests: [
        requestRow("old-1", { user_guid: "old-1", status: "approved", amount_paid: 700, payment_method: "VodafoneCash", created_at: at("2026-10-07T06:52:58.000Z") }, new Date("2026-10-19T00:00:00.000Z")),
      ],
      slots: [
        manualSlotRow("old-1", [
          grantRow("legacy_old-1", at("2026-10-08T17:54:07.000Z"), {
            kind: "absolute",
            expiresAt: daysAgo(-300),
            metadata: { grantSource: "legacy_import", amountPaid: 700, paymentMethod: "VodafoneCash" },
          }),
        ]),
        manualSlotRow("add-1", [
          grantRow("op-add-1", at("2026-10-09T10:00:00.000Z"), { metadata: { grantSource: "admin_manual_add", amountPaid: 200, paymentMethod: "Instapay" } }),
          grantRow("op-add-2", at("2026-10-09T11:00:00.000Z"), { status: "reversed", metadata: { grantSource: "admin_manual_add", amountPaid: 200 } }),
        ]),
      ],
    }),
    STATS_NOW
  );
  assert.equal(dayOf(document, "2026-10-08").requestsApproved, 1);
  assert.equal(document.summary.revenueThisMonthEgp, 900);
  assert.deepEqual(document.summary.revenueByMethodThisMonth, { VodafoneCash: 700, Instapay: 200 });
  assert.equal(document.summary.medianHoursToApproval30d, 35);
});

test("stats: days and months follow Cairo, not UTC", () => {
  // 21:30 UTC on 30 September is 00:30 on 1 October in Cairo.
  const lateSeptemberUtc = at("2026-09-30T21:30:00.000Z");
  const { document } = computeStats(
    statsInput({
      slots: [manualSlotRow("cairo-1", [grantRow("op-cairo", lateSeptemberUtc)], lateSeptemberUtc)],
      events: [eventRow("e1", "apple", "production", "DID_RENEW", at("2026-09-30T20:59:00.000Z"))],
    }),
    STATS_NOW
  );
  assert.equal(dayOf(document, "2026-10-01").new, 1);
  assert.equal(dayOf(document, "2026-09-30").new, 0);
  assert.equal(monthOf(document, "2026-10").new, 1);
  assert.equal(monthOf(document, "2026-09").new, 0);
  assert.equal(monthOf(document, "2026-09").renewals, 1);
  assert.equal(document.summary.newThisMonth, 1);
  assert.equal(document.summary.newLastMonth, 0);
});

test("stats: manual access that ran out is an expiration unless a later grant or a store subscription continued it", () => {
  const { document } = computeStats(
    statsInput({
      slots: [
        // One month from 1 Sep ends 1 Oct; the next grant comes on 5 Oct.
        manualSlotRow("gap-1", [
          grantRow("op-gap-1", at("2026-09-01T10:00:00.000Z"), { months: 1 }),
          grantRow("op-gap-2", at("2026-10-05T10:00:00.000Z"), { months: 1 }),
        ]),
        // Ends 1 Oct as well, but an Apple subscription covers that moment.
        manualSlotRow("covered-1", [grantRow("op-covered", at("2026-09-01T10:00:00.000Z"), { months: 1 })]),
        storeSlot("covered-1", "apple", "production", at("2026-09-20T10:00:00.000Z")),
        // Revoked: not an expiration.
        manualSlotRow("revoked-1", [
          grantRow("op-revoked", at("2026-09-01T10:00:00.000Z"), { months: 1, status: "revoked", statusChangedAt: at("2026-09-10T10:00:00.000Z") }),
        ]),
      ],
    }),
    STATS_NOW
  );
  assert.equal(dayOf(document, "2026-10-01").expirations, 1);
  assert.equal(monthOf(document, "2026-10").expirations, 1);
  assert.equal(monthOf(document, "2026-09").expirations, 0);
  // The revoked account is active in the estimate only until it was revoked.
  assert.equal(dayOf(document, "2026-09-05").active.manual, 3);
  assert.equal(dayOf(document, "2026-09-15").active.manual, 2);
});

test("stats: recorded days replace estimates, and only today, yesterday and missing days are written", () => {
  const recorded = (date, total) => ({
    id: date,
    data: { date, estimated: false, active: { total, apple: total, google: 0, manual: 0 } },
  });
  const archive = [];
  for (let offset = 1; offset < STATS_DAILY_DAYS; offset++) {
    const date = new Date(Date.UTC(2026, 9, 20 - offset)).toISOString().slice(0, 10);
    if (date !== "2026-10-10" && date !== "2026-09-25") {
      archive.push(recorded(date, 5));
    }
  }
  archive.push({ id: "2026-09-25", data: { date: "2026-09-25", estimated: true, active: { total: 1, apple: 1, google: 0, manual: 0 } } });
  const { document, archiveRows } = computeStats(
    statsInput({ archive, masters: [masterRow("apple-1", { platform: "apple" })] }),
    STATS_NOW
  );
  assert.deepEqual(dayOf(document, "2026-10-19").active, { total: 5, apple: 5, google: 0, manual: 0 });
  assert.equal(dayOf(document, "2026-10-19").estimated, false);
  assert.equal(dayOf(document, "2026-10-10").estimated, true);
  // An estimated archive row is estimated again, not trusted as recorded.
  assert.equal(dayOf(document, "2026-09-25").estimated, true);
  assert.equal(document.summary.activeChange30d, 1 - 5);
  assert.deepEqual(
    archiveRows.map((row) => row.date).sort(),
    ["2026-10-10", "2026-10-19", "2026-10-20"]
  );
  assert.equal(archiveRows.find((row) => row.date === "2026-10-20").estimated, false);
});
