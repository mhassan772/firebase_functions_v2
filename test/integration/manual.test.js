// Manual grant transactions against the Firestore and Auth emulators. Run with
// `npm run test:integration`, which starts both under a demo project, so nothing here can
// reach real data or a real store.
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { before, beforeEach, describe, test } = require("node:test");

assert.ok(process.env.FIRESTORE_EMULATOR_HOST, "FIRESTORE_EMULATOR_HOST must point at the emulator");
assert.ok(process.env.FIREBASE_AUTH_EMULATOR_HOST, "FIREBASE_AUTH_EMULATOR_HOST must point at the emulator");

const { admin } = require("../../lib/config/admin");
const { Timestamp } = require("firebase-admin/firestore");
const {
  persistVerifiedSubscription,
  stateDocumentId,
  legacyManualDocumentId,
  SUBSCRIPTION_MASTER_COLLECTION,
  SUBSCRIPTION_STATE_COLLECTION,
  LEGACY_MANUAL_COLLECTION,
} = require("../../lib/services/subscriptions/persistence");
const {
  applyManualMutation,
  readAccountSubscription,
  LEGACY_MIRROR_SOURCE,
} = require("../../lib/services/subscriptions/manual");
const { planLegacyMigration, importLegacyRows, readMigrationRun } = require("../../lib/services/subscriptions/legacyMigration");

/** Plans, then imports the plan's rows: what the portal's Dry run followed by Migrate does. */
async function planAndImport(runId) {
  const plan = await planLegacyMigration({ runId: `${runId}-plan`, actor: "admin-1", now: NOW });
  const rows = plan.rows.filter((row) => row.action === "imported").map(({ docId, uid }) => ({ docId, uid }));
  if (rows.length === 0) {
    return { ...plan, dryRun: false, runId };
  }
  const result = await importLegacyRows({ runId, rows, actor: "admin-1", now: NOW });
  // Rows the plan did not import are carried over so callers can read every document's fate.
  for (const row of plan.rows) {
    if (row.action !== "imported") {
      result.rows.push(row);
      result.totals[row.action] += 1;
    }
  }
  return result;
}
const { SubscriptionError } = require("../../lib/services/subscriptions/errors");

const db = () => admin.firestore();
const hex = (value) => createHash("sha256").update(value).digest("hex");
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-11T10:00:00.000Z");

function googleVerified(uid, expiresAt, eventAt = NOW) {
  return {
    subscription: {
      active: true,
      status: "active",
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
  const [host] = [process.env.FIRESTORE_EMULATOR_HOST];
  const response = await fetch(
    `http://${host}/emulator/v1/projects/demo-mantooq/databases/(default)/documents`,
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

async function manualSlot(uid) {
  const snapshot = await db()
    .collection(SUBSCRIPTION_STATE_COLLECTION)
    .doc(stateDocumentId(uid, "manual", "production"))
    .get();
  return snapshot.exists ? snapshot.data() : undefined;
}

async function legacy(uid) {
  const snapshot = await db().collection(LEGACY_MANUAL_COLLECTION).doc(legacyManualDocumentId(uid)).get();
  return snapshot.exists ? snapshot.data() : undefined;
}

const grant = (uid, opId, months, extra = {}) =>
  applyManualMutation(
    { uid, opId, actor: "admin-1", now: extra.now ?? NOW },
    {
      action: "grant",
      intent: { kind: "months", months, base: extra.base ?? "extend" },
      metadata: { grantSource: "admin_manual_add", note: "test" },
      queue: extra.queue,
    }
  );

before(async () => {
  await ensureUser("admin-1", "admin@example.test");
});

beforeEach(async () => {
  await clearFirestore();
});

describe("a manual grant beside a store subscription", () => {
  const uid = "user-google";

  test("the grant never disturbs the store row and the store row never disturbs the grant", async () => {
    await ensureUser(uid, "google@example.test");
    const googleEnd = new Date(NOW.getTime() + 400 * DAY);
    await persistVerifiedSubscription(uid, googleVerified(uid, googleEnd));
    assert.equal((await master(uid)).platform, "google");

    // One month, counted from today: Google still ends later, so it stays the master.
    const first = await grant(uid, "op-grant-1", 1);
    assert.equal(first.replayedOperation, false);
    assert.equal(first.account.master.platform, "google");
    assert.equal(first.account.sources.length, 2);
    assert.equal(first.account.manual.activeGrantCount, 1);
    assert.equal(first.account.manual.ledgerRevision, 1);
    assert.equal(first.account.manual.expiresAt, "2026-11-11T21:59:59.999Z");
    const mirrored = await legacy(uid);
    assert.equal(mirrored.source, LEGACY_MIRROR_SOURCE);
    assert.equal(mirrored.user_guid, uid);
    assert.equal(mirrored.expires.toDate().toISOString(), "2026-11-11T21:59:59.999Z");

    // A Google renewal arrives: the Google row moves, the manual slot is untouched.
    const slotBefore = await manualSlot(uid);
    const renewedEnd = new Date(NOW.getTime() + 430 * DAY);
    await persistVerifiedSubscription(uid, googleVerified(uid, renewedEnd, new Date(NOW.getTime() + DAY)), {
      key: "renewal-1",
      platform: "google",
      environment: "production",
      eventType: "SUBSCRIPTION_RENEWED",
      eventAt: new Date(NOW.getTime() + DAY),
    });
    const afterRenewal = await master(uid);
    assert.equal(afterRenewal.platform, "google");
    assert.equal(afterRenewal.expiresAt.toDate().toISOString(), renewedEnd.toISOString());
    const rows = afterRenewal.sources.map((row) => row.platform).sort();
    assert.deepEqual(rows, ["google", "manual"]);
    assert.deepEqual(await manualSlot(uid), slotBefore);

    // The same press again changes nothing.
    const replay = await grant(uid, "op-grant-1", 1);
    assert.equal(replay.replayedOperation, true);
    assert.equal(replay.account.manual.ledgerRevision, 1);

    // A second month extends from the manual end, not from Google's.
    const second = await grant(uid, "op-grant-2", 1);
    assert.equal(second.account.manual.expiresAt, "2026-12-11T21:59:59.999Z");
    assert.equal(second.account.manual.ledgerRevision, 2);
    assert.equal(second.account.master.platform, "google");

    // Reversing the second grant takes only its month back.
    const reversed = await applyManualMutation(
      { uid, opId: "op-reverse-2", actor: "admin-1", now: NOW },
      { action: "reverseRequest", grantId: "op-grant-2", reason: "fake payment", expectedLedgerRevision: 2 }
    );
    assert.equal(reversed.account.manual.expiresAt, "2026-11-11T21:59:59.999Z");
    assert.equal(reversed.account.manual.grants.find((g) => g.grantId === "op-grant-2").status, "reversed");

    // A stale revision is refused.
    await assert.rejects(
      applyManualMutation(
        { uid, opId: "op-stale", actor: "admin-1", now: NOW },
        { action: "revokeAccess", reason: "x", expectedLedgerRevision: 2 }
      ),
      (error) => error instanceof SubscriptionError && error.safeCode === "ledger-revision-stale"
    );

    // Revoking leaves the store subscription as the master and zeroes the mirror.
    const revoked = await applyManualMutation(
      { uid, opId: "op-revoke", actor: "admin-1", now: NOW },
      { action: "revokeAccess", reason: "refund", expectedLedgerRevision: 3 }
    );
    assert.equal(revoked.account.manual.status, "revoked");
    assert.equal(revoked.account.manual.activeGrantCount, 0);
    assert.equal(revoked.account.master.platform, "google");
    assert.equal((await legacy(uid)).expires.toDate().toISOString(), NOW.toISOString());

    // After a revoke the next grant counts from today, not from the revoked remainder.
    const fresh = await grant(uid, "op-grant-3", 1);
    assert.equal(fresh.account.manual.expiresAt, "2026-11-11T21:59:59.999Z");
  });

  test("a manual grant that ends later than the store takes the master, and hands it back when it ends", async () => {
    // The store path stamps with the real clock, so this scenario is laid out around it:
    // the grant is given 100 days ago for 3 months and has lapsed by now.
    const real = new Date();
    const grantedAt = new Date(real.getTime() - 100 * DAY);
    await ensureUser(uid, "google@example.test");
    const googleEnd = new Date(real.getTime() - 50 * DAY);
    await persistVerifiedSubscription(uid, googleVerified(uid, googleEnd, grantedAt));
    const granted = await grant(uid, "op-long", 3, { now: grantedAt });
    assert.equal(granted.account.master.platform, "manual");
    assert.equal(granted.account.master.productId, "manual_grant");
    assert.equal(granted.account.master.manual.activeGrantCount, 1);

    // The grant has lapsed; the next store event re-projects to the store.
    const later = new Date(real.getTime() - 60 * 1000);
    await persistVerifiedSubscription(uid, googleVerified(uid, new Date(real.getTime() + 30 * DAY), later), {
      key: "renewal-late",
      platform: "google",
      environment: "production",
      eventType: "SUBSCRIPTION_RENEWED",
      eventAt: later,
    });
    const projected = await master(uid);
    assert.equal(projected.platform, "google");
    const manualRow = projected.sources.find((row) => row.platform === "manual");
    assert.equal(manualRow.status, "expired");
    assert.ok(!Object.hasOwn(manualRow, "active"));
  });
});

describe("the legacy document", () => {
  test("is imported as the baseline when an account is granted before the migration, and never read back", async () => {
    const uid = "user-legacy";
    await ensureUser(uid, "legacy@example.test");
    const legacyEnd = new Date("2027-03-01T21:59:59.999Z");
    await db()
      .collection(LEGACY_MANUAL_COLLECTION)
      .doc(legacyManualDocumentId(uid))
      .set({ expires: Timestamp.fromDate(legacyEnd), email: "legacy@example.test", tag: "tester" });

    const granted = await grant(uid, "op-legacy-1", 1);
    const grants = granted.account.manual.grants;
    assert.equal(grants.length, 2);
    assert.equal(grants[0].grantId, `legacy_${legacyManualDocumentId(uid)}`);
    assert.equal(grants[0].isLegacyBaseline, true);
    assert.equal(grants[0].metadata.note, "tester");
    // One month on top of the legacy date, which the user had already paid for.
    assert.equal(granted.account.manual.expiresAt, "2027-04-01T21:59:59.999Z");
    assert.equal(granted.account.master.platform, "manual");

    // The mirror has overwritten the legacy document with the total.
    const mirrored = await legacy(uid);
    assert.equal(mirrored.source, LEGACY_MIRROR_SOURCE);
    assert.equal(mirrored.expires.toDate().toISOString(), "2027-04-01T21:59:59.999Z");

    // A migration run afterwards must not count that total again.
    const report = await planAndImport("run-after-grant");
    const row = report.rows.find((candidate) => candidate.docId === legacyManualDocumentId(uid));
    assert.equal(row.action, "skipped_ledger_exists");
    assert.equal((await readAccountSubscription(uid, NOW)).manual.expiresAt, "2027-04-01T21:59:59.999Z");

    // Edits on the baseline go through setBaseline; a request-level edit is refused.
    await assert.rejects(
      applyManualMutation(
        { uid, opId: "op-adjust-legacy", actor: "admin-1", now: NOW },
        { action: "adjust", grantId: grants[0].grantId, targetMonths: 2, expectedLedgerRevision: 1 }
      ),
      (error) => error instanceof SubscriptionError && error.safeCode === "unattributed-legacy-grant"
    );
    const rebased = await applyManualMutation(
      { uid, opId: "op-baseline", actor: "admin-1", now: NOW },
      { action: "setBaseline", expiresAt: new Date("2026-12-01T12:00:00.000Z"), reason: "correction", expectedLedgerRevision: 1 }
    );
    // Baseline now Dec 1; the month on top counts from there.
    assert.equal(rebased.account.manual.expiresAt, "2027-01-01T21:59:59.999Z");
  });

  test("migration: dry run writes nothing, live run imports once, re-run skips, mirror and expired docs are skipped", async () => {
    const hashOnly = "user-hash-only";
    const withGuid = "user-with-guid";
    const expired = "user-expired";
    const gone = "deleted-user";
    for (const [uid, email] of [
      [hashOnly, "hash@example.test"],
      [withGuid, "guid@example.test"],
      [expired, "expired@example.test"],
    ]) {
      await ensureUser(uid, email);
    }
    const future = Timestamp.fromDate(new Date("2027-06-30T21:59:59.999Z"));
    await db().collection(LEGACY_MANUAL_COLLECTION).doc(hex(hashOnly)).set({ expires: future, name: "no uid here" });
    await db()
      .collection(LEGACY_MANUAL_COLLECTION)
      .doc(hex(withGuid))
      .set({ expires: future, user_guid: withGuid, payment_method: "Instapay", amount_paid: 700 });
    await db()
      .collection(LEGACY_MANUAL_COLLECTION)
      .doc(hex(expired))
      .set({ expires: Timestamp.fromDate(new Date("2025-01-01T00:00:00.000Z")), user_guid: expired });
    await db().collection(LEGACY_MANUAL_COLLECTION).doc(hex(gone)).set({ expires: future, email: "gone@example.test" });
    await db().collection(LEGACY_MANUAL_COLLECTION).doc("not-a-hash-nor-uid!").set({ expires: future, user_guid: "someone-else" });
    // The one legacy document keyed by the raw uid instead of its hash; the old portal also wrote user_guid.
    const rawUid = "LohpLHPFvEOao4yQNLprCGFdLOo1";
    await ensureUser(rawUid, "raw@example.test");
    await db().collection(LEGACY_MANUAL_COLLECTION).doc(rawUid).set({ expires: future, user_guid: rawUid });

    const dry = await planLegacyMigration({ runId: "dry-run-1", actor: "admin-1", now: NOW });
    assert.equal(dry.status, "finished");
    assert.deepEqual(dry.totals, {
      imported: 3,
      skipped_expired: 1,
      skipped_ledger_exists: 0,
      skipped_mirror: 0,
      unresolved: 1,
      mismatch: 1,
      failed: 0,
    });
    assert.equal(dry.rows.find((row) => row.docId === hex(hashOnly)).resolution, "hash_scan");
    assert.equal(dry.rows.find((row) => row.docId === hex(withGuid)).resolution, "user_guid");
    const rawRow = dry.rows.find((row) => row.docId === rawUid);
    assert.equal(rawRow.resolution, "raw_uid_doc_id");
    assert.equal(rawRow.rawUidDocId, true);
    assert.equal(await manualSlot(hashOnly), undefined, "a dry run writes no slot");
    assert.equal(await readMigrationRun("dry-run-1"), undefined, "a dry run writes no report");

    // The live import trusts the plan's rows; a row whose uid does not own its document is refused.
    const rows = dry.rows.filter((row) => row.action === "imported").map(({ docId, uid }) => ({ docId, uid }));
    rows.push({ docId: hex("someone"), uid: "someone-else" });
    const live = await importLegacyRows({ runId: "live-run-1", rows, actor: "admin-1", now: NOW });
    assert.equal(live.totals.imported, 3);
    assert.equal(live.totals.mismatch, 1);
    // The raw-uid document is imported under its own id and stamped there, not under the hash.
    const rawView = await readAccountSubscription(rawUid, NOW);
    assert.equal(rawView.manual.grants[0].grantId, `legacy_${rawUid}`);
    assert.equal(rawView.master.platform, "manual");
    assert.equal((await db().collection(LEGACY_MANUAL_COLLECTION).doc(rawUid).get()).get("migrated_run_id"), "live-run-1");
    assert.equal(await legacy(rawUid), undefined, "no hashed document is created by the import");
    const imported = await readAccountSubscription(hashOnly, NOW);
    assert.equal(imported.manual.expiresAt, "2027-06-30T21:59:59.999Z");
    assert.equal(imported.manual.grants[0].isLegacyBaseline, true);
    assert.equal(imported.master.platform, "manual");
    assert.equal((await legacy(hashOnly)).migrated_run_id, "live-run-1");
    assert.equal((await legacy(hashOnly)).source, undefined, "the import does not mirror");
    const withGuidView = await readAccountSubscription(withGuid, NOW);
    assert.equal(withGuidView.manual.grants[0].metadata.paymentMethod, "Instapay");
    assert.equal(withGuidView.manual.grants[0].metadata.amountPaid, 700);
    const stored = await readMigrationRun("live-run-1");
    assert.equal(stored.status, "finished");
    assert.equal(stored.rows.length, 4);

    // A run id cannot be reused for a live run.
    await assert.rejects(
      importLegacyRows({ runId: "live-run-1", rows, actor: "admin-1", now: NOW }),
      (error) => error instanceof SubscriptionError && error.safeCode === "migration-run-exists"
    );

    // Importing the same rows again adds nothing: the transaction sees the ledger.
    const again = await importLegacyRows({ runId: "live-run-2", rows: rows.slice(0, 3), actor: "admin-1", now: NOW });
    assert.equal(again.totals.imported, 0);
    assert.equal(again.totals.skipped_ledger_exists, 3);

    // A mirror document for an account with no ledger is never imported either.
    const mirrorOnly = "user-mirror-only";
    await ensureUser(mirrorOnly, "mirror@example.test");
    await db()
      .collection(LEGACY_MANUAL_COLLECTION)
      .doc(hex(mirrorOnly))
      .set({ expires: future, user_guid: mirrorOnly, source: LEGACY_MIRROR_SOURCE });
    const third = await planAndImport("live-run-3");
    assert.equal(third.rows.find((row) => row.docId === hex(mirrorOnly)).action, "skipped_mirror");
    // Even if a stale plan listed it, the import refuses a mirror document.
    const forced = await importLegacyRows({
      runId: "live-run-4",
      rows: [{ docId: hex(mirrorOnly), uid: mirrorOnly }],
      actor: "admin-1",
      now: NOW,
    });
    assert.equal(forced.rows[0].action, "skipped_mirror");
  });
});

describe("a request from the approval queue", () => {
  test("one request yields one grant, re-approval after rejection is a new dated record", async () => {
    const uid = "user-queue";
    await ensureUser(uid, "queue@example.test");
    const queueRef = db().collection("subscriptions_to_be_approved").doc("req-1");
    await queueRef.set({ user_guid: uid, status: "pending", duration: "3_months", amount_paid: 200 });
    const queue = { collection: "subscriptions_to_be_approved", id: "req-1", expectedStatus: "pending" };

    const approved = await grant(uid, "op-approve-1", 3, { queue });
    assert.equal(approved.account.manual.grants[0].grantId, "subscriptions_to_be_approved_req-1_r1");
    assert.equal(approved.account.manual.expiresAt, "2027-01-11T21:59:59.999Z");
    assert.deepEqual((await queueRef.get()).data(), {
      user_guid: uid,
      status: "approved",
      duration: "3_months",
      amount_paid: 200,
      approved_months: 3,
    });

    // A second admin approving the same request is told it moved on; nothing stacks.
    await assert.rejects(
      grant(uid, "op-approve-other-admin", 3, { queue }),
      (error) => error instanceof SubscriptionError && error.safeCode === "queue-status-changed"
    );
    assert.equal((await readAccountSubscription(uid, NOW)).manual.activeGrantCount, 1);

    // Adjust to 6 months: the queue's approved_months follows.
    const adjusted = await applyManualMutation(
      { uid, opId: "op-adjust-1", actor: "admin-1", now: NOW },
      { action: "adjust", grantId: "subscriptions_to_be_approved_req-1_r1", targetMonths: 6, expectedLedgerRevision: 1 }
    );
    assert.equal(adjusted.account.manual.expiresAt, "2027-04-11T21:59:59.999Z");
    assert.equal((await queueRef.get()).get("approved_months"), 6);

    // Reverse: the request is rejected with the note and the grant is gone.
    const reversed = await applyManualMutation(
      { uid, opId: "op-reverse-1", actor: "admin-1", now: NOW },
      { action: "reverseRequest", grantId: "subscriptions_to_be_approved_req-1_r1", reason: "fake receipt", expectedLedgerRevision: 2 }
    );
    assert.equal(reversed.account.manual.activeGrantCount, 0);
    assert.equal((await queueRef.get()).get("status"), "rejected");
    assert.equal((await queueRef.get()).get("admin_notes"), "fake receipt");

    // Approving again later is a fresh record dated now.
    const later = new Date(NOW.getTime() + 30 * DAY);
    const reapproved = await grant(uid, "op-approve-2", 3, {
      queue: { ...queue, expectedStatus: "rejected" },
      now: later,
    });
    const r2 = reapproved.account.manual.grants.find((g) => g.grantId === "subscriptions_to_be_approved_req-1_r2");
    assert.equal(r2.status, "active");
    assert.equal(r2.grantedAt, later.toISOString());
    assert.equal(reapproved.account.manual.expiresAt, "2027-02-10T21:59:59.999Z");
  });

  test("reversing a grant whose request was deleted still reverses the grant", async () => {
    const uid = "user-deleted-queue";
    await ensureUser(uid, "dq@example.test");
    const queueRef = db().collection("subscriptions_to_be_approved").doc("req-gone");
    await queueRef.set({ user_guid: uid, status: "pending" });
    await grant(uid, "op-approve-gone", 1, {
      queue: { collection: "subscriptions_to_be_approved", id: "req-gone", expectedStatus: "pending" },
    });
    await queueRef.delete();
    const reversed = await applyManualMutation(
      { uid, opId: "op-reverse-gone", actor: "admin-1", now: NOW },
      { action: "reverseRequest", grantId: "subscriptions_to_be_approved_req-gone_r1", reason: "cleanup", expectedLedgerRevision: 1 }
    );
    assert.equal(reversed.account.manual.activeGrantCount, 0);
  });

  test("a request with no user_guid is refused", async () => {
    await ensureUser("user-y", "y@example.test");
    await db().collection("subscriptions_to_be_approved").doc("req-3").set({ status: "pending" });
    await assert.rejects(
      grant("user-y", "op-no-guid", 1, {
        queue: { collection: "subscriptions_to_be_approved", id: "req-3", expectedStatus: "pending" },
      }),
      (error) => error instanceof SubscriptionError && error.safeCode === "queue-user-mismatch"
    );
  });

  test("a manual add replays even after its operation id aged out of the recent list", async () => {
    const uid = "user-many-ops";
    await ensureUser(uid, "many@example.test");
    await grant(uid, "op-first-add", 1);
    for (let i = 0; i < 55; i++) {
      await applyManualMutation(
        { uid, opId: `op-churn-${i}`, actor: "admin-1", now: NOW },
        { action: "revokeAccess", reason: "churn", expectedLedgerRevision: i + 1 }
      );
    }
    const replay = await grant(uid, "op-first-add", 1);
    assert.equal(replay.replayedOperation, true);
    assert.equal(replay.account.manual.grants.filter((g) => g.grantId === "op-first-add").length, 1);
  });

  test("a request for another account is refused", async () => {
    await ensureUser("user-x", "x@example.test");
    await db().collection("subscriptions_to_be_approved").doc("req-2").set({ user_guid: "someone-else", status: "pending" });
    await assert.rejects(
      grant("user-x", "op-wrong-user", 1, {
        queue: { collection: "subscriptions_to_be_approved", id: "req-2", expectedStatus: "pending" },
      }),
      (error) => error instanceof SubscriptionError && error.safeCode === "queue-user-mismatch"
    );
  });
});
