const assert = require("node:assert/strict");
const test = require("node:test");
const { hasPortalRole, portalRolesFromData } = require("../lib/utils/adminRole");
const { assertActionAllowed, subscriptionAccessFor } = require("../lib/handlers/adminSubscriptionHandlers");
const { SubscriptionError } = require("../lib/services/subscriptions/errors");

const rejectsWith = (code) => (error) => error instanceof SubscriptionError && error.safeCode === code;

test("a roles list alone decides; the single role is the fallback", () => {
  assert.deepEqual(portalRolesFromData({ role: "admin", roles: ["content-manager"] }), ["content-manager"]);
  assert.deepEqual(portalRolesFromData({ role: "admin", roles: [] }), []);
  assert.deepEqual(portalRolesFromData({ role: "manager" }), ["manager"]);
  assert.deepEqual(portalRolesFromData({ roles: ["developer", 7, null] }), ["developer"]);
  assert.deepEqual(portalRolesFromData({ role: 3 }), []);
  assert.deepEqual(portalRolesFromData(undefined), []);
});

test("admin implies every role; other roles imply only themselves", () => {
  assert.equal(hasPortalRole(["admin"], "content-manager"), true);
  assert.equal(hasPortalRole(["admin"], "egypt-subscription-approval"), true);
  assert.equal(hasPortalRole(["content-manager"], "content-manager"), true);
  assert.equal(hasPortalRole(["content-manager"], "admin"), false);
  assert.equal(hasPortalRole(["manager"], "content-manager"), false);
  assert.equal(hasPortalRole([], "admin"), false);
});

test("subscription access: admins get all, approvers the queue, others nothing", () => {
  assert.equal(subscriptionAccessFor(["admin"]), "admin");
  assert.equal(subscriptionAccessFor(["egypt-subscription-approval", "admin"]), "admin");
  assert.equal(subscriptionAccessFor(["egypt-subscription-approval"]), "queue");
  assert.equal(subscriptionAccessFor(["content-manager", "egypt-subscription-approval"]), "queue");
  assert.equal(subscriptionAccessFor(["manager"]), undefined);
  assert.equal(subscriptionAccessFor([]), undefined);

  for (const action of ["revokeAccess", "setBaseline", "listManual", "refreshStats", "removeDevice", "migrateLegacy"]) {
    assert.doesNotThrow(() => assertActionAllowed("admin", action, { action }));
    assert.throws(() => assertActionAllowed("queue", action, { action }), rejectsWith("not-subscription-admin"));
  }
  for (const action of ["get", "adjust", "reverseRequest"]) {
    assert.doesNotThrow(() => assertActionAllowed("queue", action, { action }));
    assert.throws(() => assertActionAllowed(undefined, action, { action }), rejectsWith("not-subscription-admin"));
  }
  const egypt = { collection: "subscriptions_to_be_approved", id: "r1" };
  const migration = { collection: "subscription_migration_restoration", id: "r2" };
  assert.doesNotThrow(() =>
    assertActionAllowed("queue", "grant", { action: "grant", queue: egypt, metadata: { grantSource: "egypt_request" } })
  );
  assert.doesNotThrow(() =>
    assertActionAllowed("queue", "grant", {
      action: "grant",
      queue: migration,
      metadata: { grantSource: "migration_restoration" },
    })
  );
  // An approval may not be recorded under another source, such as an admin add.
  assert.throws(
    () => assertActionAllowed("queue", "grant", { action: "grant", queue: egypt, metadata: { grantSource: "admin_manual_add" } }),
    rejectsWith("not-subscription-admin")
  );
  assert.throws(
    () => assertActionAllowed("queue", "grant", { action: "grant", queue: egypt, metadata: { grantSource: "migration_restoration" } }),
    rejectsWith("not-subscription-admin")
  );
  assert.throws(() => assertActionAllowed("queue", "grant", { action: "grant", queue: {} }), rejectsWith("not-subscription-admin"));
  assert.throws(() => assertActionAllowed("queue", "grant", { action: "grant" }), rejectsWith("not-subscription-admin"));
  assert.doesNotThrow(() => assertActionAllowed("admin", "grant", { action: "grant" }));
});
