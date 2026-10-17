// Who a verified purchase belongs to, against the Firestore emulator. Run with
// `npm run test:integration`, which starts it under a demo project.
const assert = require("node:assert/strict");
const { beforeEach, describe, test } = require("node:test");

assert.ok(process.env.FIRESTORE_EMULATOR_HOST, "FIRESTORE_EMULATOR_HOST must point at the emulator");

const {
  assertCallerMayClaim,
  persistVerifiedSubscription,
  resolvePurchaseOwner,
} = require("../../lib/services/subscriptions/persistence");
const { deriveAccountBinding, sha256Reference } = require("../../lib/services/subscriptions/crypto");
const { SubscriptionError } = require("../../lib/services/subscriptions/errors");

const SECRET = "integration-test-account-binding-secret-32b";
const secret = () => SECRET;
const noSecret = () => {
  throw new Error("the secret must not be read when the expired purchase carried no binding");
};
const MINUTE = 60 * 1000;
const at = (minutes) => new Date(Date.now() + minutes * MINUTE);

function googleVerified(token, { active, expiresAt, eventAt, google } = {}) {
  return {
    subscription: {
      active: active ?? true,
      status: active === false ? "expired" : "active",
      platform: "google",
      productId: "premium_access",
      expiresAt: expiresAt ?? at(30),
      autoRenewing: active ?? true,
      inGracePeriod: false,
      environment: "test",
      purchaseReference: sha256Reference(token),
      lastStoreEventAt: eventAt ?? at(-1),
      lastVerifiedAt: eventAt ?? at(-1),
    },
    ownership: [{ platform: "google", environment: "test", purchaseToken: token, currentPurchaseToken: token }],
    ...(google ? { google } : {}),
  };
}

async function clearFirestore() {
  const response = await fetch(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-mantooq/databases/(default)/documents`,
    { method: "DELETE" }
  );
  assert.ok(response.ok, `clearing Firestore failed: ${response.status}`);
}

beforeEach(async () => {
  await clearFirestore();
});

describe("ownership of a Play Store resubscription", () => {
  const owner = "user-old-owner";
  const expiredToken = "token-old-expired";
  const newToken = "token-new-from-play-store";

  async function expiredPurchaseOwnedBy(uid) {
    await persistVerifiedSubscription(uid, googleVerified(expiredToken, { active: false, expiresAt: at(-100), eventAt: at(-100) }));
  }

  test("the chain's own owner is used before anything else", async () => {
    await expiredPurchaseOwnedBy(owner);
    await persistVerifiedSubscription("user-chain-owner", googleVerified(newToken));
    const resolved = await resolvePurchaseOwner(
      googleVerified(newToken, { google: { expiredPurchaseToken: expiredToken } }),
      noSecret
    );
    assert.equal(resolved, "user-chain-owner");
  });

  test("an unclaimed new token is linked to the expired token's owner when no binding is involved", async () => {
    await expiredPurchaseOwnedBy(owner);
    const resolved = await resolvePurchaseOwner(
      googleVerified(newToken, { google: { expiredPurchaseToken: expiredToken } }),
      noSecret
    );
    assert.equal(resolved, owner);
  });

  test("a binding on the expired purchase must be the owner's", async () => {
    await expiredPurchaseOwnedBy(owner);
    const matching = await resolvePurchaseOwner(
      googleVerified(newToken, {
        google: {
          expiredPurchaseToken: expiredToken,
          expiredAccountBinding: deriveAccountBinding(owner, "google", SECRET),
        },
      }),
      secret
    );
    assert.equal(matching, owner);

    const mismatched = await resolvePurchaseOwner(
      googleVerified(newToken, {
        google: {
          expiredPurchaseToken: expiredToken,
          expiredAccountBinding: deriveAccountBinding("user-someone-else", "google", SECRET),
        },
      }),
      secret
    );
    assert.equal(mismatched, undefined);
  });

  test("an expired token nobody ever verified with us resolves to nobody", async () => {
    const resolved = await resolvePurchaseOwner(
      googleVerified(newToken, { google: { expiredPurchaseToken: "token-never-seen" } }),
      noSecret
    );
    assert.equal(resolved, undefined);
  });

  test("the verify endpoint's claim check gives the same answer as the notification path", async () => {
    await expiredPurchaseOwnedBy(owner);
    const verified = googleVerified(newToken, { google: { expiredPurchaseToken: expiredToken } });
    await assertCallerMayClaim(owner, verified, noSecret);
    await assert.rejects(
      assertCallerMayClaim("user-signed-in-elsewhere", verified, noSecret),
      (error) =>
        error instanceof SubscriptionError &&
        error.kind === "ownership-conflict" &&
        error.safeCode === "purchase-owned-by-another-user"
    );
    // With no previous owner anywhere, the caller claims as before.
    await assertCallerMayClaim("user-first-ever", googleVerified("token-brand-new"), noSecret);
  });
});
