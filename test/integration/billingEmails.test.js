// Billing emails against the Firestore emulator, with the in-memory Stripe: each trigger point
// queues its outbox document exactly once, and the sender's skips, retries and send. Nothing
// reaches Stripe or SES.
const assert = require("node:assert/strict");
const { beforeEach, describe, test } = require("node:test");

assert.ok(process.env.FIRESTORE_EMULATOR_HOST, "FIRESTORE_EMULATOR_HOST must point at the emulator");

const { admin } = require("../../lib/config/admin");
const { Timestamp } = require("firebase-admin/firestore");
const { createFakeStripe, DAY } = require("../helpers/fakeStripeGateway");
const { stateDocumentId, SUBSCRIPTION_STATE_COLLECTION } = require("../../lib/services/subscriptions/persistence");
const { WEB_PURCHASES_COLLECTION } = require("../../lib/services/webSubscriptions/ledger");
const { firestoreWebPurchaseThrottle } = require("../../lib/services/webSubscriptions/purchaseThrottle");
const { createPriceLookup } = require("../../lib/services/webSubscriptions/pricing");
const { syncWebEntitlement } = require("../../lib/services/webSubscriptions/sync");
const { webEventRef } = require("../../lib/services/webSubscriptions/events");
const {
  billingNotifier,
  queueBillingEmail,
  sweepFinalPaymentWarnings,
  WEB_EMAIL_OUTBOX_COLLECTION,
} = require("../../lib/services/webSubscriptions/billingEmails");
const { DELETED_ACCOUNTS_COLLECTION } = require("../../lib/services/accountDeletion/tombstone");
const { handleWebEvent } = require("../../lib/handlers/webSubscriptionEventHandlers");
const { handleFinishWebPurchase, handleStartWebPurchase } = require("../../lib/handlers/webPurchaseHandlers");
const { handleManageWebSubscription } = require("../../lib/handlers/webManageHandlers");
const { BillingEmailRetry, handleWebBillingEmail } = require("../../lib/handlers/webBillingEmailHandlers");

const db = () => admin.firestore();
const UID = "BillingBuyerAaaaaaaaaa01";

async function clearFirestore() {
  const response = await fetch(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-mantooq/databases/(default)/documents`,
    { method: "DELETE" }
  );
  assert.ok(response.ok, `clearing Firestore failed: ${response.status}`);
}
beforeEach(clearFirestore);

const read = async (ref) => ((snapshot) => (snapshot.exists ? snapshot.data() : undefined))(await ref.get());
const outbox = async () =>
  (await db().collection(WEB_EMAIL_OUTBOX_COLLECTION).get()).docs.map((doc) => ({ id: doc.id, ...doc.data() })).sort((a, b) => (a.id < b.id ? -1 : 1));
const kinds = async () => (await outbox()).map((row) => row.kind).sort();
const slotRef = () => db().collection(SUBSCRIPTION_STATE_COLLECTION).doc(stateDocumentId(UID, "web", "test"));
const ledger = async (purchaseId) => read(db().collection(WEB_PURCHASES_COLLECTION).doc(purchaseId));

async function setup({ config = {} } = {}) {
  const fake = createFakeStripe({ nowSec: Math.floor(Date.now() / 1000) - 60 });
  await db().collection("web_pricing").doc("config").set({ salesEnabled: true, testers: [UID], ...config });
  const notify = billingNotifier(db());
  const deps = {
    firestore: db(),
    gateway: fake,
    publishableKey: "pk_test_fake",
    storeCountry: { knownCountries: async () => ({ storePurchase: [] }) },
    throttle: firestoreWebPurchaseThrottle(db, { uidPerWindow: 100, ipPerWindow: 100, windowMs: DAY * 1000 }),
    now: () => new Date(),
    prices: createPriceLookup(fake),
    notify,
  };
  return { fake, deps, syncDeps: { firestore: db(), gateway: fake, notify } };
}

const caller = () => ({
  auth: { uid: UID, token: { email: "buyer@example.com", email_verified: true, firebase: { sign_in_provider: "password" } } },
  rawRequest: { ip: "203.0.113.8" },
});
const PRICES = { web_monthly: 499, web_yearly: 4999, web_lifetime: 14999 };

async function buy(env, plan, token = {}, lang = "en") {
  const confirmationToken = env.fake.addToken({ setupFutureUsage: plan === "web_lifetime" ? null : "off_session", ...token });
  return handleStartWebPurchase({ plan, confirmationToken, acceptedTotal: PRICES[plan], lang }, caller(), env.deps);
}
const subscriptionOf = async (purchaseId) => (await ledger(purchaseId)).stripe.subscriptionId;
const replay = (env, event) => handleWebEvent(webEventRef(event), "webhook", env.syncDeps);

describe("queued by the sync", () => {
  test("a purchase queues purchase_confirmed once, in the purchase's language; a second sync queues nothing", async () => {
    const env = await setup();
    const { purchaseId } = await buy(env, "web_yearly", {}, "en");
    let rows = await outbox();
    assert.deepEqual(rows.map((row) => row.id), [`confirmed_${purchaseId}`]);
    const [row] = rows;
    assert.deepEqual(
      [row.kind, row.lang, row.livemode, row.plan, row.amount, row.tax, row.total, row.currency, row.status, row.attempts],
      ["purchase_confirmed", "en", false, "web_yearly", 4999, 0, 4999, "usd", "queued", 0]
    );
    assert.equal(row.renewsAt.toMillis(), (await read(slotRef())).web.paidThrough.toMillis());
    assert.ok(row.expiresAt instanceof Timestamp);
    assert.ok(!JSON.stringify(row).includes("@"), "no address in the outbox");
    await syncWebEntitlement(UID, env.syncDeps);
    for (const event of env.fake.state.events) await replay(env, event);
    assert.equal((await outbox()).length, 1);
  });

  test("lifetime queues its confirmation without a renewal date", async () => {
    const env = await setup();
    const { purchaseId } = await buy(env, "web_lifetime", {}, "ar");
    const [row] = await outbox();
    assert.deepEqual([row.id, row.lang, row.plan, row.total, row.renewsAt], [`confirmed_${purchaseId}`, "ar", "web_lifetime", 14999, undefined]);
  });

  test("a first purchase needing 3D Secure queues no action_required, only the confirmation once paid", async () => {
    const env = await setup();
    const started = await buy(env, "web_monthly", { behavior: "requires_action" });
    assert.equal(started.status, "requires_action");
    await handleFinishWebPurchase({ purchaseId: started.purchaseId }, caller(), env.deps);
    assert.deepEqual(await outbox(), []);
    env.fake.completeAction((await ledger(started.purchaseId)).stripe.paymentIntentId);
    await handleFinishWebPurchase({ purchaseId: started.purchaseId }, caller(), env.deps);
    assert.deepEqual(await kinds(), ["purchase_confirmed"]);
  });

  test("a paid renewal queues renewed once with the amount and next date; a replay queues nothing more", async () => {
    const env = await setup();
    const { purchaseId } = await buy(env, "web_monthly");
    const renewal = env.fake.renew(await subscriptionOf(purchaseId));
    for (const event of env.fake.state.events) await replay(env, event);
    for (const event of env.fake.state.events) await replay(env, event);
    const rows = (await outbox()).filter((row) => row.kind === "renewed");
    assert.deepEqual(rows.map((row) => row.id), [`renewed_${renewal.invoiceId}`]);
    assert.equal(rows[0].amount, 499);
    assert.equal(rows[0].renewsAt.toMillis(), (await read(slotRef())).web.paidThrough.toMillis());
  });

  test("a failed renewal queues payment_failed with the grace end; one needing confirmation queues action_required instead", async () => {
    const env = await setup();
    const { purchaseId } = await buy(env, "web_monthly");
    const failed = env.fake.renew(await subscriptionOf(purchaseId), { paid: false });
    await syncWebEntitlement(UID, env.syncDeps);
    await syncWebEntitlement(UID, env.syncDeps);
    const slot = await read(slotRef());
    const rows = (await outbox()).filter((row) => row.kind !== "purchase_confirmed");
    assert.deepEqual(rows.map((row) => row.id), [`failed_${failed.invoiceId}`]);
    assert.equal(rows[0].graceEndsAt.toMillis(), slot.expiresAt.toMillis());

    await clearFirestore();
    const other = await setup();
    const bought = await buy(other, "web_monthly");
    const action = other.fake.renew(await subscriptionOf(bought.purchaseId), { paid: false, requiresAction: true });
    await syncWebEntitlement(UID, other.syncDeps);
    assert.deepEqual((await outbox()).filter((row) => row.kind !== "purchase_confirmed").map((row) => row.id), [`action_${action.invoiceId}`]);
  });

  test("a cancel queues cancellation_confirmed once; cancelling again in the same period queues nothing", async () => {
    const env = await setup();
    await buy(env, "web_monthly");
    await handleManageWebSubscription({ action: "cancel" }, caller(), env.deps);
    await handleManageWebSubscription({ action: "resume" }, caller(), env.deps);
    await handleManageWebSubscription({ action: "cancel" }, caller(), env.deps);
    const rows = (await outbox()).filter((row) => row.kind === "cancellation_confirmed");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].endsAt.toMillis(), (await read(slotRef())).web.paidThrough.toMillis());
  });

  test("a refund or a dispute queues nothing", async () => {
    const env = await setup();
    const { purchaseId } = await buy(env, "web_monthly");
    env.fake.refund((await ledger(purchaseId)).stripe.chargeId);
    await syncWebEntitlement(UID, env.syncDeps);
    assert.deepEqual(await kinds(), ["purchase_confirmed"]);
  });

  test("a notify that throws never fails the sync", async () => {
    const env = await setup();
    const customer = env.fake.addCustomer(UID);
    await db().collection("web_customers").doc(UID).set({ testCustomerId: customer });
    env.fake.paySubscription({ customer });
    const result = await syncWebEntitlement(UID, { ...env.syncDeps, notify: async () => { throw new Error("boom"); } });
    assert.equal(result.outcome, "written");
  });

  test("a tombstoned account queues nothing", async () => {
    await db().collection(DELETED_ACCOUNTS_COLLECTION).doc(UID).set({ state: "pending" });
    const outcome = await queueBillingEmail(db(), { id: "x_1", uid: UID, kind: "renewed", lang: "ar", livemode: false, fields: {} }, new Date());
    assert.equal(outcome, "account_deleted");
    assert.deepEqual(await outbox(), []);
  });
});

describe("renewal reminder (invoice.upcoming)", () => {
  test("a yearly subscription queues one reminder with the date and amount; cardExpiresFirst both ways", async () => {
    const env = await setup();
    const { purchaseId } = await buy(env, "web_yearly", { expMonth: 1, expYear: 2027 }, "ar");
    const event = env.fake.upcoming(await subscriptionOf(purchaseId));
    assert.equal(await replay(env, event), "reminder");
    assert.equal(await replay(env, event), "duplicate");
    const rows = (await outbox()).filter((row) => row.kind === "renewal_reminder");
    const paidThrough = (await read(slotRef())).web.paidThrough;
    assert.deepEqual(rows.map((row) => row.id), [`reminder_${await subscriptionOf(purchaseId)}_${paidThrough.seconds}`]);
    assert.deepEqual([rows[0].lang, rows[0].amount, rows[0].cardExpiresFirst], ["ar", 4999, true]);
    assert.equal(rows[0].renewsAt.toMillis(), paidThrough.toMillis());

    await clearFirestore();
    const other = await setup();
    const bought = await buy(other, "web_yearly", { expMonth: 12, expYear: 2040 });
    await replay(other, other.fake.upcoming(await subscriptionOf(bought.purchaseId)));
    assert.equal((await outbox()).find((row) => row.kind === "renewal_reminder").cardExpiresFirst, false);
  });

  test("monthly, or a cancelling yearly, queues no reminder", async () => {
    const env = await setup();
    const monthly = await buy(env, "web_monthly");
    await replay(env, env.fake.upcoming(await subscriptionOf(monthly.purchaseId)));
    assert.deepEqual(await kinds(), ["purchase_confirmed"]);

    await clearFirestore();
    const other = await setup();
    const yearly = await buy(other, "web_yearly");
    await handleManageWebSubscription({ action: "cancel" }, caller(), other.deps);
    await replay(other, other.fake.upcoming(await subscriptionOf(yearly.purchaseId)));
    assert.deepEqual(await kinds(), ["cancellation_confirmed", "purchase_confirmed"]);
  });
});

describe("last warning (recovery pass)", () => {
  test("a grace ending within 48 hours queues payment_failed_final once", async () => {
    const env = await setup();
    const { purchaseId } = await buy(env, "web_monthly");
    env.fake.renew(await subscriptionOf(purchaseId), { paid: false });
    await syncWebEntitlement(UID, env.syncDeps);
    const slot = await read(slotRef());
    const options = (now) => ({ now, deadline: new Date(Date.now() + 30_000), operationId: "op-final" });
    const early = await sweepFinalPaymentWarnings(env.syncDeps, options(new Date()));
    assert.equal(early.queued, 0, "five days or more left: no warning yet");
    const late = new Date(slot.expiresAt.toMillis() - 24 * 3600 * 1000);
    const first = await sweepFinalPaymentWarnings({ ...env.syncDeps, now: () => late }, options(late));
    const second = await sweepFinalPaymentWarnings({ ...env.syncDeps, now: () => late }, options(late));
    assert.deepEqual([first.queued, second.queued], [1, 0]);
    const row = (await outbox()).find((item) => item.kind === "payment_failed_final");
    assert.equal(row.id, `failed_final_${await subscriptionOf(purchaseId)}_${slot.expiresAt.seconds}`);
    assert.equal(row.graceEndsAt.toMillis(), slot.expiresAt.toMillis());
  });
});

describe("sendWebBillingEmail", () => {
  const NOW = new Date();
  function senderDeps({ user = { uid: UID, email: "buyer@example.com" }, sendError } = {}) {
    const sent = [];
    return {
      sent,
      deps: {
        firestore: db(),
        auth: {
          async getUser(uid) {
            if (!user) throw Object.assign(new Error("no user"), { code: "auth/user-not-found" });
            return { ...user, uid };
          },
        },
        mailer: {
          async send(email) {
            if (sendError) throw sendError;
            sent.push(email);
          },
        },
        now: () => NOW,
      },
    };
  }
  async function queue(id, extra = {}, fields = { plan: "web_monthly", amount: 499, currency: "usd", renewsAt: new Date(Date.now() + 30 * DAY * 1000) }) {
    await queueBillingEmail(db(), { id, uid: UID, kind: "renewed", lang: "ar", livemode: false, fields }, NOW);
    if (Object.keys(extra).length) await db().collection(WEB_EMAIL_OUTBOX_COLLECTION).doc(id).update(extra);
  }
  const status = async (id) => read(db().collection(WEB_EMAIL_OUTBOX_COLLECTION).doc(id));

  test("sends with the sender name and a [TEST] subject on a sandbox, then marks sent; a second delivery sends nothing", async () => {
    await db().collection("web_pricing").doc("config").set({});
    await queue("renewed_in_1");
    const { deps, sent } = senderDeps();
    assert.equal(await handleWebBillingEmail("renewed_in_1", deps), "sent");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, "buyer@example.com");
    assert.equal(sent[0].fromName, "منطوق");
    assert.ok(sent[0].subject.startsWith("[TEST] "));
    assert.equal((await status("renewed_in_1")).status, "sent");
    assert.equal(await handleWebBillingEmail("renewed_in_1", deps), "not_queued");
    assert.equal(sent.length, 1);
  });

  test("skip reasons: emails off, deleted account, no user, no address, older than a day", async () => {
    const cases = [
      ["emails_disabled", async () => db().collection("web_pricing").doc("config").set({ emailsEnabled: false }), {}],
      ["account_deleted", async () => db().collection(DELETED_ACCOUNTS_COLLECTION).doc(UID).set({ state: "pending" }), {}],
      ["no_user", async () => {}, { user: null }],
      ["no_email", async () => {}, { user: { uid: UID } }],
      ["stale", async () => {}, {}, { createdAt: Timestamp.fromMillis(NOW.getTime() - 25 * 3600 * 1000) }],
    ];
    for (const [reason, arrange, depOptions, extra = {}] of cases) {
      await clearFirestore();
      await queue("renewed_in_2", extra);
      await arrange();
      const { deps, sent } = senderDeps(depOptions);
      assert.equal(await handleWebBillingEmail("renewed_in_2", deps), "skipped", reason);
      assert.deepEqual([(await status("renewed_in_2")).status, (await status("renewed_in_2")).reason], ["skipped", reason]);
      assert.equal(sent.length, 0);
    }
  });

  test("a transient SES failure counts an attempt and throws for a retry; the fifth attempt marks failed", async () => {
    await queue("renewed_in_3");
    const { deps } = senderDeps({ sendError: Object.assign(new Error("throttled"), { name: "TooManyRequestsException" }) });
    for (let attempt = 1; attempt <= 4; attempt++) {
      await assert.rejects(handleWebBillingEmail("renewed_in_3", deps), (error) => error instanceof BillingEmailRetry && error.attempts === attempt);
    }
    assert.equal(await handleWebBillingEmail("renewed_in_3", deps), "failed");
    assert.deepEqual([(await status("renewed_in_3")).status, (await status("renewed_in_3")).reason, (await status("renewed_in_3")).attempts], ["failed", "retries_exhausted", 5]);
  });

  test("a permanent SES failure, or a missing field, marks failed at once", async () => {
    await queue("renewed_in_4");
    const { deps } = senderDeps({ sendError: Object.assign(new Error("rejected"), { name: "MessageRejected" }) });
    assert.equal(await handleWebBillingEmail("renewed_in_4", deps), "failed");
    assert.equal((await status("renewed_in_4")).reason, "ses_MessageRejected");
    await queue("renewed_in_5", {}, { plan: "web_monthly", currency: "usd" });
    assert.equal(await handleWebBillingEmail("renewed_in_5", senderDeps().deps), "failed");
    assert.equal((await status("renewed_in_5")).reason, "incomplete_amount");
  });
});
