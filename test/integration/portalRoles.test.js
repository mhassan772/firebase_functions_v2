// The role-limited subscription actions, against the Firestore and Auth
// emulators. Run with `npm run test:integration`, which starts both under a demo project.
const assert = require("node:assert/strict");
const { before, beforeEach, describe, test } = require("node:test");

assert.ok(process.env.FIRESTORE_EMULATOR_HOST, "FIRESTORE_EMULATOR_HOST must point at the emulator");
assert.ok(process.env.FIREBASE_AUTH_EMULATOR_HOST, "FIREBASE_AUTH_EMULATOR_HOST must point at the emulator");

const { admin } = require("../../lib/config/admin");
const { handleAdminManageSubscription } = require("../../lib/handlers/adminSubscriptionHandlers");

const db = () => admin.firestore();
const as = (uid) => ({ auth: { uid } });
const subscriptions = (data, uid) => handleAdminManageSubscription(data, as(uid));

/** An HttpsError from the callable, matched on its status and safe code. */
const refusedWith = (status, code) => (error) => error.code === status && error.details?.code === code;

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

before(async () => {
  await ensureUser("admin-1", "admin@example.test");
  await ensureUser("customer-1", "customer1@example.test");
});

beforeEach(async () => {
  await clearFirestore();
  const users = db().collection("users_adminv2");
  await users.doc("admin-1").set({ role: "admin", active: true });
  await users.doc("admin-2").set({ roles: ["admin"], active: true, email: "admin2@example.test" });
  await users.doc("legacy-manager").set({ role: "manager", active: true, email: "manager@example.test" });
  await users.doc("approver-1").set({ roles: ["egypt-subscription-approval"], active: true });
});

describe("adminManageSubscription for an Egypt approver", () => {
  const user = { uid: "customer-1" };
  const metadata = { grantSource: "egypt_request" };
  const revisionOf = async (uid) =>
    (await subscriptions({ action: "get", user }, uid)).account.manual.ledgerRevision;

  test("the approver works the queue and nothing else", async () => {
    await db().collection("subscriptions_to_be_approved").doc("req-e1").set({ user_guid: "customer-1", status: "pending" });

    const account = await subscriptions({ action: "get", user }, "approver-1");
    assert.equal(account.user.uid, "customer-1");

    const approved = await subscriptions(
      {
        action: "grant",
        user,
        opId: "op-approver-grant-1",
        intent: { kind: "months", months: 3, base: "extend" },
        metadata,
        queue: { collection: "subscriptions_to_be_approved", id: "req-e1", expectedStatus: "pending" },
      },
      "approver-1"
    );
    const queueGrantId = "subscriptions_to_be_approved_req-e1_r1";
    assert.equal(approved.account.manual.grants[0].grantId, queueGrantId);

    const adjusted = await subscriptions(
      { action: "adjust", user, opId: "op-approver-adjust-1", grantId: queueGrantId, targetMonths: 6, expectedLedgerRevision: 1 },
      "approver-1"
    );
    assert.equal(adjusted.account.manual.grants[0].months, 6);

    // A grant made without a request, by an admin, is out of the approver's reach.
    await subscriptions(
      {
        action: "grant",
        user,
        opId: "op-admin-manual-1",
        intent: { kind: "months", months: 1, base: "extend" },
        metadata: { grantSource: "admin_manual_add" },
      },
      "admin-1"
    );
    const revision = await revisionOf("admin-1");
    await assert.rejects(
      subscriptions(
        { action: "adjust", user, opId: "op-approver-adjust-2", grantId: "op-admin-manual-1", targetMonths: 4, expectedLedgerRevision: revision },
        "approver-1"
      ),
      refusedWith("permission-denied", "grant-not-from-request")
    );
    await assert.rejects(
      subscriptions(
        { action: "reverseRequest", user, opId: "op-approver-reverse-2", grantId: "op-admin-manual-1", reason: "x", expectedLedgerRevision: revision },
        "approver-1"
      ),
      refusedWith("permission-denied", "grant-not-from-request")
    );
    assert.equal(await revisionOf("admin-1"), revision);

    const reversed = await subscriptions(
      { action: "reverseRequest", user, opId: "op-approver-reverse-1", grantId: queueGrantId, reason: "bad receipt", expectedLedgerRevision: revision },
      "approver-1"
    );
    assert.equal(reversed.account.manual.grants.find((g) => g.grantId === queueGrantId).status, "reversed");
    assert.equal((await db().collection("subscriptions_to_be_approved").doc("req-e1").get()).get("status"), "rejected");

    const refused = [
      { action: "grant", user, opId: "op-approver-manual", intent: { kind: "months", months: 1, base: "extend" }, metadata },
      { action: "revokeAccess", user, opId: "op-approver-revoke", reason: "x", expectedLedgerRevision: revision + 1 },
      { action: "listManual" },
      { action: "refreshStats" },
      { action: "listDevices", user },
      { action: "setExtraSeats", user, seats: 1 },
    ];
    for (const request of refused) {
      await assert.rejects(subscriptions(request, "approver-1"), refusedWith("permission-denied", "not-subscription-admin"));
    }
  });

  test("a legacy manager and a non-portal user are refused every action", async () => {
    for (const caller of ["legacy-manager", "customer-1"]) {
      await assert.rejects(
        subscriptions({ action: "get", user }, caller),
        refusedWith("permission-denied", "not-subscription-admin")
      );
    }
  });
});
