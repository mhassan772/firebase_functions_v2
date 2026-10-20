// The dashboard stats job against the Firestore emulator. Run with `npm run test:integration`,
// which starts the emulators under a demo project, so nothing here can reach real data.
const assert = require("node:assert/strict");
const { beforeEach, test } = require("node:test");

assert.ok(process.env.FIRESTORE_EMULATOR_HOST, "FIRESTORE_EMULATOR_HOST must point at the emulator");

const { admin } = require("../../lib/config/admin");
const { Timestamp } = require("firebase-admin/firestore");
const { persistVerifiedSubscription } = require("../../lib/services/subscriptions/persistence");
const { applyManualMutation } = require("../../lib/services/subscriptions/manual");
const {
  refreshSubscriptionStats,
  STATS_DAILY_DAYS,
  STATS_MONTHLY_MONTHS,
} = require("../../lib/services/subscriptions/stats");

const db = () => admin.firestore();
const DAY = 24 * 60 * 60 * 1000;
// Store slots are stamped with the real clock, so the run uses it too.
const NOW = new Date();
const before = (seconds) => new Date(NOW.getTime() - seconds * 1000);

async function clearFirestore() {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  const response = await fetch(
    `http://${host}/emulator/v1/projects/demo-mantooq/databases/(default)/documents`,
    { method: "DELETE" }
  );
  assert.ok(response.ok, `clearing Firestore failed: ${response.status}`);
}

beforeEach(async () => {
  await clearFirestore();
});

test("the job writes the dashboard document and backfills the archive once", async () => {
  await persistVerifiedSubscription(
    "user-google",
    {
      subscription: {
        active: true,
        status: "active",
        platform: "google",
        productId: "premium_access",
        expiresAt: new Date(NOW.getTime() + 30 * DAY),
        autoRenewing: true,
        inGracePeriod: false,
        environment: "production",
        purchaseReference: "ref-user-google",
        lastStoreEventAt: before(30),
        lastVerifiedAt: before(30),
      },
      ownership: [
        {
          platform: "google",
          environment: "production",
          purchaseToken: "token-user-google",
          currentPurchaseToken: "token-user-google",
        },
      ],
    },
    {
      key: "renewal-1",
      platform: "google",
      environment: "production",
      eventType: "SUBSCRIPTION_RENEWED",
      eventAt: before(30),
    }
  );

  await db().collection("subscriptions_to_be_approved").doc("req-1").set({
    user_guid: "user-egypt",
    status: "pending",
    amount_paid: 200,
    payment_method: "Instapay",
    duration: "3_months",
    created_at: Timestamp.fromDate(before(20)),
  });
  await db().collection("subscription_migration_restoration").doc("mig-1").set({
    user_guid: "user-migration",
    status: "pending",
    created_at: Timestamp.fromDate(before(20)),
  });
  await applyManualMutation(
    { uid: "user-egypt", opId: "op-approve-1", actor: "admin-1", now: before(10) },
    {
      action: "grant",
      intent: { kind: "months", months: 3, base: "extend" },
      metadata: { grantSource: "egypt_request" },
      queue: { collection: "subscriptions_to_be_approved", id: "req-1", expectedStatus: "pending" },
    }
  );

  const first = await refreshSubscriptionStats(NOW);
  assert.equal(first.generatedAt, NOW.toISOString());
  assert.equal(first.archiveRowsWritten, STATS_DAILY_DAYS);

  const current = (await db().collection("subscription_stats").doc("current").get()).data();
  assert.equal(current.generatedAt, NOW.toISOString());
  assert.equal(current.timeZone, "Africa/Cairo");
  assert.equal(current.daily.length, STATS_DAILY_DAYS);
  assert.equal(current.monthly.length, STATS_MONTHLY_MONTHS);
  assert.equal(current.daily.at(-1).date, current.today);
  const { active } = current.summary;
  assert.deepEqual(
    { total: active.total, apple: active.apple, google: active.google, manual: active.manual },
    { total: 2, apple: 0, google: 1, manual: 1 }
  );
  assert.equal(active.manualBySource.egypt_request, 1);
  assert.deepEqual(current.summary.pendingRequests, { egypt: 0, migration: 1 });
  assert.equal(current.summary.newToday, 2);
  assert.equal(current.summary.revenueThisMonthEgp, 200);
  assert.deepEqual(current.summary.revenueByMethodThisMonth, { Instapay: 200 });
  const today = current.daily.at(-1);
  assert.equal(today.estimated, false);
  assert.equal(today.renewals, 1);
  assert.equal(today.requestsReceived, 2);
  assert.equal(today.requestsApproved, 1);
  assert.equal(today.manualGrants, 1);

  const archive = await db().collection("subscription_stats_daily").get();
  assert.equal(archive.size, STATS_DAILY_DAYS);
  const todayRow = (await db().collection("subscription_stats_daily").doc(current.today).get()).data();
  assert.deepEqual(todayRow.active, today.active);
  assert.equal(todayRow.estimated, false);

  // A later run rewrites only today and yesterday.
  const later = new Date(NOW.getTime() + 60 * 1000);
  const second = await refreshSubscriptionStats(later);
  assert.equal(second.archiveRowsWritten, 2);
  assert.equal((await db().collection("subscription_stats_daily").get()).size, STATS_DAILY_DAYS);
  const refreshed = (await db().collection("subscription_stats").doc("current").get()).data();
  assert.equal(refreshed.generatedAt, later.toISOString());
});
