#!/usr/bin/env node
/**
 * Drives the five web purchase callables end to end against the Stripe sandbox, with Firestore
 * in the integration emulator.
 *
 * Not part of `npm test`. It calls the real handlers with the live gateway and confirmation
 * tokens from `stripe.testHelpers.confirmationTokens.create`, then checks what Stripe and the
 * emulator hold. No webhook is registered in the sandbox, so every event is undelivered; the
 * handlers sync on their own, and one scenario rebuilds a slot from the reconcile phase alone.
 * Every customer it creates, and its test clock, is deleted at the end. Products and prices are
 * only read. Stripe Tax is not active in the sandbox, so tax stays off.
 *
 * Refuses any key that is not a sandbox secret key (sk_test_) and never prints a key or a
 * client secret.
 *
 *   npm run build
 *   bash scripts/emulator/with-java.sh firebase emulators:exec --config firebase.integration-test.json \
 *     --only firestore,auth --project demo-mantooq \
 *     'node --env-file=<path to .env.local> scripts/stripe/verify-web-purchase.mjs'
 */
import { createRequire } from 'node:module';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const key = process.env.STRIPE_WEB_SECRET_KEY ?? '';
if (!key.startsWith('sk_test_')) {
  console.error('Refusing: STRIPE_WEB_SECRET_KEY is missing or not a sandbox secret key (sk_test_).');
  process.exit(1);
}
if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('Refusing: run inside the Firestore emulator (FIRESTORE_EMULATOR_HOST is not set).');
  process.exit(1);
}

const Stripe = require('stripe');
const { Timestamp } = require('firebase-admin/firestore');
const { admin } = require('../../lib/config/admin');
const { liveStripeGateway, isResourceMissing } = require('../../lib/services/webSubscriptions/stripeGateway');
const { syncWebEntitlement, WEB_GRACE_MS } = require('../../lib/services/webSubscriptions/sync');
const { firestoreStoreCountry, storeCountryToData, USER_STORE_COUNTRY_COLLECTION } = require('../../lib/services/storeCountry');
const { firestoreWebPurchaseThrottle } = require('../../lib/services/webSubscriptions/purchaseThrottle');
const { WEB_CUSTOMERS_COLLECTION } = require('../../lib/services/webSubscriptions/customers');
const { WEB_PURCHASES_COLLECTION } = require('../../lib/services/webSubscriptions/ledger');
const { sweepPendingWebPurchases } = require('../../lib/services/webSubscriptions/pendingSweep');
const { stateDocumentId, SUBSCRIPTION_MASTER_COLLECTION, SUBSCRIPTION_STATE_COLLECTION } = require('../../lib/services/subscriptions/persistence');
const { runFeedPhase, stripeEventsPhase } = require('../../lib/handlers/subscriptionReconcileHandlers');
const { handleStartWebPurchase, handleFinishWebPurchase, handleGetWebPlans } = require('../../lib/handlers/webPurchaseHandlers');
const { handleGetWebSubscription, handleManageWebSubscription } = require('../../lib/handlers/webManageHandlers');
const { reasonOf } = require('../../lib/utils/callableAuth');

const stripe = new Stripe(key);
const gateway = liveStripeGateway(key);
const db = admin.firestore();
const run = crypto.randomBytes(4).toString('hex');
const uids = [];
const clocks = [];
const results = [];
let failed = false;

function check(name, ok, detail) {
  results.push({ name, ok });
  if (!ok) failed = true;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}
const iso = (value) => (value?.toDate ? value.toDate().toISOString() : value instanceof Date ? value.toISOString() : String(value));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read, ok, label, attempts = 30, waitMs = 1000) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const value = await read();
    if (ok(value)) return value;
    await sleep(waitMs);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function newUid(label) {
  const uid = `e2e${run}${label}`.replace(/[^A-Za-z0-9]/g, '').padEnd(24, '0');
  uids.push(uid);
  return uid;
}

let clockNow;
const deps = {
  firestore: db,
  gateway,
  publishableKey: process.env.STRIPE_WEB_PUBLISHABLE_KEY?.trim(),
  storeCountry: firestoreStoreCountry(() => db),
  throttle: firestoreWebPurchaseThrottle(() => db, { uidPerWindow: 100, ipPerWindow: 1000, windowMs: 86_400_000 }),
  now: () => clockNow ?? new Date(),
};
const caller = (uid) => ({
  auth: { uid, token: { email: `${uid.toLowerCase()}@example.invalid`, email_verified: true, firebase: { sign_in_provider: 'password' } } },
  rawRequest: { ip: '198.51.100.20' },
});

/** A token as the Payment Element makes it: a card with a billing country. */
async function token(cardToken, { setupFutureUsage = 'off_session', billingCountry = 'US' } = {}) {
  const created = await stripe.testHelpers.confirmationTokens.create({
    payment_method_data: { type: 'card', card: { token: cardToken }, billing_details: { address: { country: billingCountry } } },
    ...(setupFutureUsage ? { setup_future_usage: setupFutureUsage } : {}),
  });
  return created.id;
}

async function start(uid, plan, cardToken, acceptedTotal) {
  const confirmationToken = await token(cardToken, { setupFutureUsage: plan === 'web_lifetime' ? null : 'off_session' });
  const answer = await handleStartWebPurchase({ plan, confirmationToken, acceptedTotal, lang: 'en' }, caller(uid), deps);
  return { answer, confirmationToken };
}

async function refusalOf(promise) {
  try {
    await promise;
    return 'no refusal';
  } catch (error) {
    return `${error.code}/${reasonOf(error) ?? ''}${error.details?.category ? `/${error.details.category}` : ''}${error.details?.platform ? `/${error.details.platform}` : ''}`;
  }
}

const read = async (ref) => ((snapshot) => (snapshot.exists ? snapshot.data() : undefined))(await ref.get());
const slotOf = (uid) => read(db.collection(SUBSCRIPTION_STATE_COLLECTION).doc(stateDocumentId(uid, 'web', 'test')));
const masterOf = (uid) => read(db.collection(SUBSCRIPTION_MASTER_COLLECTION).doc(uid));
const ledgerOf = (purchaseId) => read(db.collection(WEB_PURCHASES_COLLECTION).doc(purchaseId));
const mappingOf = (uid) => read(db.collection(WEB_CUSTOMERS_COLLECTION).doc(uid));

async function seedKnownCountry(uid, country) {
  const now = new Date();
  await db.collection(USER_STORE_COUNTRY_COLLECTION).doc(uid).set(storeCountryToData({
    country, raw: country, source: 'play_billing', attested: true,
    firstReportedAt: now, updatedAt: now, lastReportAt: now,
    history: [{ country, source: 'play_billing', attested: true, at: now }],
  }));
}

try {
  console.log(`Stripe sandbox, livemode ${gateway.livemode}, run ${run}\n`);
  const A = newUid('monthly');
  const B = newUid('yearly');
  const C = newUid('lifetime');
  const LOW = newUid('low');
  const DECLINE = newUid('decline');
  const DISPUTE = newUid('dispute');
  const CARD = newUid('card');
  const CLOCK = newUid('clock');
  const PENDING = newUid('pending');
  const CONCURRENT = newUid('concurrent');
  await db.collection('web_pricing').doc('config').set({
    salesEnabled: true,
    taxEnabled: false,
    testers: uids,
    // Stripe has no Egyptian or Turkish test cards, so Saudi Arabia stands in for a low-tier
    // country and the UAE for a reduced one.
    countries: { SA: 'low', AE: 'reduced' },
  });
  await seedKnownCountry(LOW, 'SA');
  await seedKnownCountry(CARD, 'AE');

  // 0. The gate.
  check('a non-tester on the sandbox key is refused', (await refusalOf(handleGetWebPlans({}, caller('NotATester0000000000000x'), deps))) === 'failed-precondition/sales_disabled');
  const plans = await handleGetWebPlans({ lang: 'en' }, caller(A), deps);
  check('getWebPlans: standard tier, three plans, the publishable key, livemode false',
    plans.tier === 'standard' && plans.plans.length === 3 && plans.publishableKey?.startsWith('pk_test_') && plans.livemode === false,
    plans.plans.map((row) => `${row.plan}=${row.amount}/${row.interval}`).join(' '));

  // 1. Each plan end to end.
  for (const [uid, plan, amount] of [[A, 'web_monthly', 499], [B, 'web_yearly', 4999], [C, 'web_lifetime', 14999]]) {
    const { answer } = await start(uid, plan, 'tok_us', amount);
    const entry = answer.purchaseId ? await ledgerOf(answer.purchaseId) : undefined;
    const slot = await slotOf(uid);
    const master = await masterOf(uid);
    check(`${plan}: succeeded, ledger paid, slot and master grant premium`,
      answer.status === 'succeeded' && entry?.status === 'paid' && slot?.active === true && master?.active === true && master.productId === plan,
      `status ${answer.status}, ledger ${entry?.status} total ${entry?.total}, slot ${slot?.status} until ${iso(slot?.expiresAt)}, master ${master?.platform}/${master?.environment} ${master?.productId} active ${master?.active}`);
    const intent = await stripe.paymentIntents.retrieve(entry.stripe.paymentIntentId);
    check(`${plan}: the PaymentIntent offered cards only`, JSON.stringify(intent.payment_method_types) === '["card"]',
      `payment_method_types ${JSON.stringify(intent.payment_method_types)}, setup_future_usage ${intent.setup_future_usage}`);
    if (plan === 'web_lifetime') {
      const years = slot.expiresAt.toDate().getUTCFullYear() - new Date().getUTCFullYear();
      check('lifetime: expires 50 years from payment, invoice is one-off', years === 50, `expires ${iso(slot.expiresAt)}`);
    }
  }
  const state = await handleGetWebSubscription({}, caller(A), deps);
  check('getWebSubscription: active monthly with renewal, amount and card',
    state.state === 'active' && state.amount === 499 && state.card?.last4 && state.renewsAt,
    `${state.state} ${state.plan} ${state.amount} renews ${state.renewsAt} card ${state.card?.brand}/${state.card?.last4}`);

  // 2. A low-tier account paying with a US card.
  const lowToken = await token('tok_us');
  const lowRequest = { plan: 'web_yearly', confirmationToken: lowToken, acceptedTotal: 1999, lang: 'ar' };
  const lowPlans = await handleGetWebPlans({}, caller(LOW), deps);
  const reprice = await handleStartWebPurchase(lowRequest, caller(LOW), deps);
  const lowMapping = await mappingOf(LOW);
  const lowLedger = await db.collection(WEB_PURCHASES_COLLECTION).where('uid', '==', LOW).get();
  check('low tier + US card: reprice to standard, nothing at Stripe, no ledger entry',
    lowPlans.tier === 'low' && reprice.status === 'reprice' && reprice.quote.total === 4999 && reprice.quote.reason === 'card_country' &&
      lowMapping === undefined && lowLedger.empty,
    `plans tier ${lowPlans.tier} yearly ${lowPlans.plans.find((row) => row.plan === 'web_yearly')?.amount}; quote ${JSON.stringify(reprice.quote)}; customer mapping ${lowMapping ? 'exists' : 'none'}; ledger ${lowLedger.size}`);
  const accepted = await handleStartWebPurchase({ ...lowRequest, acceptedTotal: 4999 }, caller(LOW), deps);
  const lowEntry = await ledgerOf(accepted.purchaseId);
  check('low tier + US card accepted: charged the standard price', accepted.status === 'succeeded' && lowEntry.total === 4999 && lowEntry.tierShown === 'low' && lowEntry.tierCharged === 'standard',
    `ledger ${lowEntry.status} ${lowEntry.lookupKey} ${lowEntry.total}, card ${lowEntry.cardCountry}, known ${lowEntry.knownCountry}`);
  const retry = await handleStartWebPurchase({ ...lowRequest, acceptedTotal: 4999 }, caller(LOW), deps);
  const lowSubs = await gateway.listSubscriptions(lowEntry.stripe.customerId);
  check('a retried call with the same token: same purchase, one subscription, one paid invoice',
    retry.status === 'succeeded' && retry.purchaseId === accepted.purchaseId && lowSubs.length === 1,
    `subscriptions ${lowSubs.length}`);

  // 3. Declines.
  const declined = await refusalOf(start(DECLINE, 'web_monthly', 'tok_chargeDeclinedInsufficientFunds', 499));
  const declineCustomer = (await mappingOf(DECLINE)).testCustomerId;
  await sleep(2000);
  const declineSubs = await gateway.listSubscriptions(declineCustomer);
  const declineInvoices = await gateway.listInvoices({ customer: declineCustomer, limit: 10 });
  check('monthly decline: refusal with its category, no live subscription, no open invoice',
    declined === 'failed-precondition/card_declined/insufficient_funds' &&
      declineSubs.every((sub) => ['canceled', 'incomplete_expired'].includes(sub.status)) && declineInvoices.every((invoice) => invoice.status !== 'open'),
    `${declined}; subscriptions ${declineSubs.map((sub) => sub.status).join(',')}; invoices ${declineInvoices.map((invoice) => invoice.status).join(',')}`);
  const declinedLifetime = await refusalOf(start(DECLINE, 'web_lifetime', 'tok_chargeDeclined', 14999));
  const afterLifetime = await gateway.listInvoices({ customer: declineCustomer, limit: 10 });
  const declineEntries = (await db.collection(WEB_PURCHASES_COLLECTION).where('uid', '==', DECLINE).get()).docs.map((doc) => doc.data());
  check('lifetime decline: invoice voided, both ledger entries failed',
    declinedLifetime.startsWith('failed-precondition/card_declined') && afterLifetime.every((invoice) => invoice.status !== 'open') &&
      declineEntries.length === 2 && declineEntries.every((entry) => entry.status === 'failed'),
    `${declinedLifetime}; invoices ${afterLifetime.map((invoice) => invoice.status).join(',')}; ledger ${declineEntries.map((entry) => `${entry.plan}:${entry.status}:${entry.failure}`).join(' ')}`);
  check('no access after the declines', (await slotOf(DECLINE)) === undefined);

  // 4. A full refund and a dispute.
  const aEntry = (await db.collection(WEB_PURCHASES_COLLECTION).where('uid', '==', A).get()).docs[0].data();
  await stripe.refunds.create({ payment_intent: aEntry.stripe.paymentIntentId });
  await until(() => gateway.retrieveCharge(aEntry.stripe.chargeId), (charge) => charge.refunded, 'the refund');
  await syncWebEntitlement(A, deps, { trigger: 'e2e' });
  const refundedSlot = await slotOf(A);
  const refundedMaster = await masterOf(A);
  const refundedSub = await gateway.retrieveSubscription(aEntry.stripe.subscriptionId);
  check('full refund: slot revoked, master inactive, subscription cancelled at Stripe',
    refundedSlot.status === 'revoked' && refundedMaster.active === false && refundedSub.status === 'canceled',
    `slot ${refundedSlot.status} active ${refundedSlot.active}, master active ${refundedMaster.active}, subscription ${refundedSub.status}`);
  const aLedger = (await db.collection(WEB_PURCHASES_COLLECTION).where('uid', '==', A).get()).docs[0].data();
  check('full refund: ledger refunded', aLedger.status === 'refunded', aLedger.status);

  const { answer: disputed } = await start(DISPUTE, 'web_monthly', 'tok_createDispute', 499);
  const disputedEntry = await ledgerOf(disputed.purchaseId);
  await until(() => gateway.retrieveCharge(disputedEntry.stripe.chargeId), (charge) => charge.disputed, 'the dispute');
  await syncWebEntitlement(DISPUTE, deps, { trigger: 'e2e' });
  const disputedSlot = await slotOf(DISPUTE);
  const disputes = await gateway.listDisputes({ charge: disputedEntry.stripe.chargeId });
  check('dispute: slot revoked, master inactive, ledger disputed',
    disputedSlot.status === 'revoked' && (await masterOf(DISPUTE)).active === false && (await ledgerOf(disputed.purchaseId)).status === 'disputed',
    `dispute ${disputes[0]?.status}/${disputes[0]?.reason}, slot ${disputedSlot.status}`);

  // 5. Cancel, then resume.
  const cancel = await handleManageWebSubscription({ action: 'cancel' }, caller(B), deps);
  const cancelledSlot = await slotOf(B);
  const cancelledView = await handleGetWebSubscription({}, caller(B), deps);
  check('cancel: canceled at period end, still active, not renewing',
    cancel.status === 'succeeded' && cancelledSlot.status === 'canceled' && cancelledSlot.active && cancelledSlot.autoRenewing === false && cancelledView.state === 'cancelling',
    `slot ${cancelledSlot.status} until ${iso(cancelledSlot.expiresAt)}, page state ${cancelledView.state} ends ${cancelledView.endsAt}`);
  await handleManageWebSubscription({ action: 'resume' }, caller(B), deps);
  const resumedSlot = await slotOf(B);
  check('resume: active and renewing again', resumedSlot.status === 'active' && resumedSlot.autoRenewing === true, `slot ${resumedSlot.status}`);

  // 6. A card from a dearer tier moves the renewal price.
  const { answer: reduced } = await start(CARD, 'web_monthly', 'tok_ae', 399);
  const reducedEntry = await ledgerOf(reduced.purchaseId);
  const usSetup = await token('tok_us');
  const cardQuote = await handleManageWebSubscription({ action: 'replace_card', confirmationToken: usSetup }, caller(CARD), deps);
  const setupsBefore = await stripe.setupIntents.list({ customer: reducedEntry.stripe.customerId, limit: 10 });
  check('replace_card with a US card on a reduced subscription: reprice first, no SetupIntent',
    reduced.status === 'succeeded' && reducedEntry.total === 399 && cardQuote.status === 'reprice' && cardQuote.quote.amount === 499 && setupsBefore.data.length === 0,
    `bought ${reducedEntry.lookupKey} ${reducedEntry.total}; quote ${JSON.stringify(cardQuote.quote)}; setup intents ${setupsBefore.data.length}`);
  const applied = await handleManageWebSubscription({ action: 'replace_card', confirmationToken: usSetup, acceptedRenewalAmount: 499 }, caller(CARD), deps);
  const movedSub = await gateway.retrieveSubscription(reducedEntry.stripe.subscriptionId);
  const movedCard = await gateway.retrievePaymentMethod(movedSub.default_payment_method);
  const pendingItems = await stripe.invoiceItems.list({ customer: reducedEntry.stripe.customerId, pending: true });
  check('replace_card accepted: price moved to standard, no proration, new default card',
    applied.status === 'succeeded' && movedSub.items.data[0].price.lookup_key === 'web_monthly_standard' && movedCard.card.country === 'US' &&
      pendingItems.data.length === 0 && idOfLatest(movedSub) === reducedEntry.stripe.invoiceId,
    `item ${movedSub.items.data[0].price.lookup_key}, card ${movedCard.card.country}, pending items ${pendingItems.data.length}, latest invoice unchanged ${idOfLatest(movedSub) === reducedEntry.stripe.invoiceId}, slot tier ${(await slotOf(CARD)).web.tier}`);
  const cheaper = await handleManageWebSubscription({ action: 'replace_card', confirmationToken: await token('tok_sa') }, caller(CARD), deps);
  const stillStandard = await gateway.retrieveSubscription(reducedEntry.stripe.subscriptionId);
  const saCard = await gateway.retrievePaymentMethod(stillStandard.default_payment_method);
  check('a cheaper card then changes only the card', cheaper.status === 'succeeded' && stillStandard.items.data[0].price.lookup_key === 'web_monthly_standard' && saCard.card.country === 'SA',
    `item ${stillStandard.items.data[0].price.lookup_key}, card ${saCard.card.country}`);

  // 7. A test clock: a failed renewal gives seven days of grace, then billing_retry.
  const frozen = Math.floor(Date.now() / 1000);
  const clock = await stripe.testHelpers.testClocks.create({ frozen_time: frozen, name: `e2e ${run}` });
  clocks.push(clock.id);
  clockNow = new Date(frozen * 1000);
  const clockCustomer = await gateway.createCustomer({ test_clock: clock.id, metadata: { uid: CLOCK } }, `customer_${CLOCK}`);
  await db.collection(WEB_CUSTOMERS_COLLECTION).doc(CLOCK).set({ testCustomerId: clockCustomer.id, createdAt: Timestamp.now(), updatedAt: Timestamp.now() });
  const { answer: clockBuy } = await start(CLOCK, 'web_monthly', 'tok_us', 499);
  const clockEntry = await ledgerOf(clockBuy.purchaseId);
  const paidSlot = await slotOf(CLOCK);
  const paidThrough = paidSlot.web.paidThrough.toDate();
  const failing = await stripe.paymentMethods.attach('pm_card_chargeCustomerFail', { customer: clockCustomer.id });
  await stripe.subscriptions.update(clockEntry.stripe.subscriptionId, { default_payment_method: failing.id });
  const advance = async (toSec) => {
    await stripe.testHelpers.testClocks.advance(clock.id, { frozen_time: toSec });
    await until(() => stripe.testHelpers.testClocks.retrieve(clock.id), (row) => row.status === 'ready', 'the clock', 90, 2000);
    clockNow = new Date(toSec * 1000);
  };
  await advance(Math.floor(paidThrough.getTime() / 1000) + 3600);
  await until(() => gateway.retrieveSubscription(clockEntry.stripe.subscriptionId), (sub) => sub.status === 'past_due', 'past_due', 30, 2000);
  await syncWebEntitlement(CLOCK, deps, { trigger: 'e2e_clock' });
  const graceSlot = await slotOf(CLOCK);
  check('clock: renewal failed → grace_period, active, expires at paidThrough + 7 days',
    clockBuy.status === 'succeeded' && graceSlot.status === 'grace_period' && graceSlot.active && graceSlot.expiresAt.toMillis() === paidThrough.getTime() + WEB_GRACE_MS,
    `paidThrough ${iso(paidThrough)}, slot ${graceSlot.status} until ${iso(graceSlot.expiresAt)}, paymentFailed ${graceSlot.web.paymentFailed}`);
  const graceView = await handleGetWebSubscription({}, caller(CLOCK), deps);
  check('clock: the page reads payment_failed', graceView.state === 'payment_failed', `${graceView.state} ends ${graceView.endsAt}`);
  await advance(Math.floor(paidThrough.getTime() / 1000) + 8 * 86400);
  const lateSub = await gateway.retrieveSubscription(clockEntry.stripe.subscriptionId);
  await syncWebEntitlement(CLOCK, deps, { trigger: 'e2e_clock' });
  const retrySlot = await slotOf(CLOCK);
  check('clock: past the grace → billing_retry, inactive, dated paidThrough',
    lateSub.status === 'past_due' && retrySlot.status === 'billing_retry' && retrySlot.active === false && retrySlot.expiresAt.toMillis() === paidThrough.getTime() && (await masterOf(CLOCK)).active === false,
    `subscription ${lateSub.status}, slot ${retrySlot.status} active ${retrySlot.active} dated ${iso(retrySlot.expiresAt)}`);
  clockNow = undefined;

  // 8. The reconcile phase alone rebuilds a deleted slot (no webhook is registered here).
  const before = await slotOf(B);
  await db.collection(SUBSCRIPTION_STATE_COLLECTION).doc(stateDocumentId(B, 'web', 'test')).delete();
  const summary = await runFeedPhase(stripeEventsPhase(deps, `e2e-${run}`), new Date(), new Date(Date.now() + 240_000));
  const rebuilt = await slotOf(B);
  check('reconcile alone: the deleted slot is rebuilt from undelivered events',
    rebuilt?.status === before.status && rebuilt?.expiresAt.toMillis() === before.expiresAt.toMillis() && rebuilt?.web.subscriptionId === before.web.subscriptionId,
    `phase applied ${summary.applied}, skipped ${summary.skipped}, failed ${summary.failed}, completed ${summary.completed}; slot ${rebuilt?.status} until ${iso(rebuilt?.expiresAt)}`);

  // 9. The pending sweep abandons an unpaid purchase.
  const { answer: waiting } = await start(PENDING, 'web_monthly', 'tok_threeDSecureRequired', 499);
  const finish = await handleFinishWebPurchase({ purchaseId: waiting.purchaseId }, caller(PENDING), deps);
  const waitingEntry = await ledgerOf(waiting.purchaseId);
  check('3D Secure: requires_action with a client secret, finishWebPurchase pending', waiting.status === 'requires_action' && Boolean(waiting.clientSecret) && finish.status === 'pending',
    `start ${waiting.status} (client secret ${waiting.clientSecret ? 'present' : 'missing'}), finish ${finish.status}, ledger ${waitingEntry.status}`);
  // Twenty-five hours are simulated by back-dating the entry.
  await db.collection(WEB_PURCHASES_COLLECTION).doc(waiting.purchaseId).update({ createdAt: Timestamp.fromMillis(Date.now() - 25 * 3600 * 1000) });
  const sweep = await sweepPendingWebPurchases(deps, { now: new Date(), deadline: new Date(Date.now() + 60_000), operationId: `e2e-${run}` });
  const abandoned = await ledgerOf(waiting.purchaseId);
  const abandonedSub = await gateway.retrieveSubscription(waitingEntry.stripe.subscriptionId);
  const abandonedInvoice = await gateway.retrieveInvoice(waitingEntry.stripe.invoiceId);
  check('pending sweep: abandoned, subscription cancelled (Stripe reports incomplete_expired), invoice no longer open',
    abandoned.status === 'abandoned' && ['canceled', 'incomplete_expired'].includes(abandonedSub.status) && abandonedInvoice.status !== 'open',
    `sweep ${JSON.stringify(sweep)}; ledger ${abandoned.status}; subscription ${abandonedSub.status}; invoice ${abandonedInvoice.status}`);

  // Two purchases started together for one account: the lock lets one through.
  const [monthlyToken, yearlyToken] = await Promise.all([token('tok_us'), token('tok_us')]);
  const together = await Promise.allSettled([
    handleStartWebPurchase({ plan: 'web_monthly', confirmationToken: monthlyToken, acceptedTotal: 499 }, caller(CONCURRENT), deps),
    handleStartWebPurchase({ plan: 'web_yearly', confirmationToken: yearlyToken, acceptedTotal: 4999 }, caller(CONCURRENT), deps),
  ]);
  const outcomes = together.map((row) => (row.status === 'fulfilled' ? row.value.status : `${row.reason.code}/${reasonOf(row.reason)}`));
  const concurrentCustomer = (await mappingOf(CONCURRENT)).testCustomerId;
  const concurrentSubs = await gateway.listSubscriptions(concurrentCustomer);
  const concurrentCharges = await stripe.charges.list({ customer: concurrentCustomer, limit: 10 });
  const concurrentLedger = (await db.collection(WEB_PURCHASES_COLLECTION).where('uid', '==', CONCURRENT).get()).docs.map((doc) => doc.data());
  check('two purchases started together: one subscription, one charge, the other refused purchase_in_progress',
    outcomes.filter((outcome) => outcome === 'succeeded').length === 1 && outcomes.includes('failed-precondition/purchase_in_progress') &&
      concurrentSubs.length === 1 && concurrentCharges.data.length === 1 && concurrentLedger.length === 1,
    `answers ${outcomes.join(', ')}; subscriptions ${concurrentSubs.map((sub) => `${sub.items.data[0].price.lookup_key}:${sub.status}`).join(',')}; charges ${concurrentCharges.data.length}; ledger entries ${concurrentLedger.length}`);

  // Lifetime over a live subscription (B's yearly): the subscription is cancelled once paid.
  const { answer: upgrade } = await start(B, 'web_lifetime', 'tok_us', 14999);
  const bYearly = (await db.collection(WEB_PURCHASES_COLLECTION).where('uid', '==', B).where('plan', '==', 'web_yearly').get()).docs[0].data();
  const bSub = await gateway.retrieveSubscription(bYearly.stripe.subscriptionId);
  const bSlot = await slotOf(B);
  check('lifetime bought over an active yearly: yearly cancelled at Stripe, slot lifetime',
    upgrade.status === 'succeeded' && bSub.status === 'canceled' && bSlot.productId === 'web_lifetime',
    `yearly ${bSub.status}, slot ${bSlot.productId} ${bSlot.status}`);
  check('guards: lifetime_active, then already_subscribed', (await refusalOf(start(B, 'web_monthly', 'tok_us', 499))) === 'failed-precondition/lifetime_active' &&
    (await refusalOf(start(LOW, 'web_monthly', 'tok_us', 499))) === 'failed-precondition/already_subscribed');
} catch (error) {
  failed = true;
  console.log(`FAIL  unexpected error: ${error?.type ?? ''} ${error?.code ?? ''} ${reasonOf?.(error) ?? ''} ${error?.name ?? ''}`);
  console.log(String(error?.message ?? error).replace(/(sk|rk|pk)_(test|live)_[A-Za-z0-9]+/g, '<key>').replace(/_secret_[A-Za-z0-9]+/g, '_secret_<hidden>').slice(0, 400));
  console.log(String(error?.stack ?? '').split('\n').slice(1, 4).join('\n'));
} finally {
  let deleted = 0;
  for (const uid of uids) {
    const mapping = await mappingOf(uid).catch(() => undefined);
    const customerId = mapping?.testCustomerId;
    if (!customerId) continue;
    try {
      await gateway.deleteCustomer(customerId);
      deleted += 1;
    } catch (error) {
      if (!isResourceMissing(error)) console.log(`could not delete ${customerId}: ${error?.code ?? error?.type}`);
    }
  }
  for (const clockId of clocks) await stripe.testHelpers.testClocks.del(clockId).catch(() => undefined);
  console.log(`\n${results.filter((row) => row.ok).length} of ${results.length} checks passed; ${deleted} sandbox customers and ${clocks.length} test clock deleted.`);
  process.exit(failed ? 1 : 0);
}

function idOfLatest(subscription) {
  const latest = subscription.latest_invoice;
  return typeof latest === 'string' ? latest : latest?.id;
}
