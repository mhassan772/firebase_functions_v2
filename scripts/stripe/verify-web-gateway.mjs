#!/usr/bin/env node
/**
 * Checks the live Stripe gateway and the entitlement derivation against the Stripe sandbox.
 *
 * Not part of `npm test`: it creates customers, subscriptions, invoices, refunds and a dispute
 * in the sandbox, reads them back through `liveStripeGateway`, and runs the same derivation
 * `syncWebEntitlement` uses. Firestore is not touched. Every customer it creates is deleted at
 * the end, which cancels its subscriptions. Products and prices are only read.
 *
 * Refuses any key that is not a sandbox secret key (sk_test_) and never prints the key.
 *
 *   npm run build
 *   node --env-file=<path to .env.local> scripts/stripe/verify-web-gateway.mjs
 */
import { createRequire } from 'node:module';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const key = process.env.STRIPE_WEB_SECRET_KEY ?? '';
if (!key.startsWith('sk_test_')) {
  console.error('Refusing: STRIPE_WEB_SECRET_KEY is missing or not a sandbox secret key (sk_test_).');
  process.exit(1);
}

const Stripe = require('stripe');
const { liveStripeGateway, isResourceMissing } = require('../../lib/services/webSubscriptions/stripeGateway');
const { deriveWebSlot, readWebStripeFacts, WEB_RENEWAL_SLACK_MS } = require('../../lib/services/webSubscriptions/sync');
const { createPriceLookup, quoteTotal, cardFromToken, billingAddressFromToken } = require('../../lib/services/webSubscriptions/pricing');
const { ledgerUpdate } = require('../../lib/services/webSubscriptions/ledger');
const { HANDLED_WEB_EVENT_TYPES } = require('../../lib/services/webSubscriptions/events');

const stripe = new Stripe(key);
const gateway = liveStripeGateway(key);
const run = crypto.randomBytes(4).toString('hex');
const created = [];
const results = [];
let failed = false;

function check(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failed = true;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

const iso = (date) => (date ? date.toISOString() : 'none');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read, ok, label, attempts = 20) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const value = await read();
    if (ok(value)) return value;
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function newCustomer(label) {
  const uid = `sandbox-verify-${run}-${label}`;
  const customer = await gateway.createCustomer(
    { description: `verify-web-gateway ${run} ${label}`, metadata: { uid } },
    `customer_${uid}`
  );
  created.push(customer.id);
  return customer.id;
}

async function token(paymentMethod, setupFutureUsage) {
  return stripe.testHelpers.confirmationTokens.create({
    payment_method: paymentMethod,
    ...(setupFutureUsage ? { setup_future_usage: setupFutureUsage } : {}),
  });
}

/** Recipe B4: an incomplete subscription confirmed with a token. */
async function subscribe(customer, price, paymentMethod) {
  const purchaseId = crypto.randomBytes(16).toString('hex');
  const sub = await gateway.createSubscription(
    {
      customer,
      items: [{ price: price.priceId }],
      payment_behavior: 'default_incomplete',
      payment_settings: { save_default_payment_method: 'on_subscription', payment_method_types: ['card'] },
      metadata: { purchaseId, plan: price.plan, tier: 'standard' },
      expand: ['latest_invoice.confirmation_secret', 'latest_invoice.payments'],
    },
    `sub_${purchaseId}`
  );
  const paymentIntentId = sub.latest_invoice.payments.data[0].payment.payment_intent;
  const ct = await token(paymentMethod, 'off_session');
  const pi = await gateway.confirmPaymentIntent(paymentIntentId, { confirmation_token: ct.id }, `confirm_${purchaseId}`);
  await until(() => gateway.retrieveSubscription(sub.id), (row) => row.status === 'active', 'the subscription to turn active');
  return { subscriptionId: sub.id, invoiceId: sub.latest_invoice.id, paymentIntentId, chargeId: pi.latest_charge, purchaseId };
}

try {
  console.log(`Stripe sandbox, livemode ${gateway.livemode}, run ${run}\n`);
  check('gateway mode is sandbox', gateway.livemode === false);

  // Prices by lookup key.
  const keys = ['web_monthly_standard', 'web_monthly_reduced', 'web_yearly_standard', 'web_yearly_reduced', 'web_yearly_low',
    'web_lifetime_standard', 'web_lifetime_reduced', 'web_lifetime_low'];
  const prices = await createPriceLookup(gateway).get(keys);
  check('all eight prices found by lookup key and match their plans', prices.size === 8,
    keys.map((lookupKey) => `${lookupKey}=${prices.get(lookupKey).amount}`).join(' '));
  const monthly = prices.get('web_monthly_standard');
  const lifetime = prices.get('web_lifetime_standard');
  const total = await quoteTotal(gateway, monthly, { taxEnabled: false });
  check('total without tax is the price', total.total === 499 && total.tax === 0, JSON.stringify(total));

  // Token reading.
  const caToken = await stripe.testHelpers.confirmationTokens.create({
    payment_method_data: { type: 'card', card: { token: 'tok_ca' }, billing_details: { address: { country: 'CA', state: 'ON', postal_code: 'M5V 3L9' } } },
  });
  const retrieved = await gateway.retrieveConfirmationToken(caToken.id);
  const card = cardFromToken(retrieved);
  const billing = billingAddressFromToken(retrieved, { taxEnabled: true });
  check('token card and billing address read', card.country === 'CA' && billing.country === 'CA' && billing.state === 'ON',
    `card ${card.country}/${card.funding}, billing ${billing.country}/${billing.state}`);

  // 1. Monthly, paid.
  const customerA = await newCustomer('monthly');
  const subA = await subscribe(customerA, monthly, 'pm_card_us');
  let facts = await readWebStripeFacts(gateway, customerA, []);
  let derived = deriveWebSlot(facts, new Date());
  const paidInvoice = await gateway.retrieveInvoice(subA.invoiceId);
  const lineEnd = new Date(paidInvoice.lines.data[0].period.end * 1000);
  const item = (await gateway.retrieveSubscription(subA.subscriptionId)).items.data[0];
  check('monthly: active, renewing',
    derived.kind === 'slot' && derived.slot.status === 'active' && derived.slot.active && derived.slot.autoRenewing,
    derived.kind === 'slot' ? `${derived.slot.status}, expires ${iso(derived.slot.expiresAt)}` : derived.kind);
  check('monthly: paidThrough is the paid invoice line period end',
    derived.slot?.web.paidThrough?.getTime() === lineEnd.getTime() &&
      derived.slot.expiresAt.getTime() === lineEnd.getTime() + WEB_RENEWAL_SLACK_MS,
    `line end ${iso(lineEnd)}, item current_period_end ${iso(new Date(item.current_period_end * 1000))}, paidThrough ${iso(derived.slot?.web.paidThrough)}`);
  check('monthly: purchase reference and metadata carried',
    derived.slot?.purchaseReference === subA.subscriptionId && derived.slot?.web.purchaseId === subA.purchaseId);

  // 2. The same purchase refunded in full.
  await stripe.refunds.create({ payment_intent: subA.paymentIntentId });
  await until(() => gateway.retrieveCharge(subA.chargeId), (charge) => charge.refunded, 'the refund');
  facts = await readWebStripeFacts(gateway, customerA, []);
  derived = deriveWebSlot(facts, new Date());
  check('full refund: revoked, inactive, subscription to be cancelled',
    derived.slot?.status === 'revoked' && derived.slot.active === false && derived.cancel.includes(subA.subscriptionId),
    `${derived.slot?.status}, cancel [${derived.cancel.join(',')}]`);
  await gateway.cancelSubscription(subA.subscriptionId);
  facts = await readWebStripeFacts(gateway, customerA, []);
  derived = deriveWebSlot(facts, new Date());
  check('after the cancel: still revoked, nothing more to cancel', derived.slot?.status === 'revoked' && derived.cancel.length === 0);

  // 3. A disputed charge.
  const customerB = await newCustomer('dispute');
  const subB = await subscribe(customerB, monthly, 'pm_card_createDispute');
  await until(() => gateway.retrieveCharge(subB.chargeId), (charge) => charge.disputed, 'the dispute');
  facts = await readWebStripeFacts(gateway, customerB, []);
  derived = deriveWebSlot(facts, new Date());
  const disputes = await gateway.listDisputes({ charge: subB.chargeId });
  check('dispute: revoked, inactive, subscription left running',
    derived.slot?.status === 'revoked' && derived.slot.active === false && derived.cancel.length === 0,
    `dispute ${disputes[0]?.status}, slot ${derived.slot?.status}`);

  // 4. Lifetime, recipe C8.
  const customerC = await newCustomer('lifetime');
  const purchaseId = crypto.randomBytes(16).toString('hex');
  const draft = await gateway.createInvoice(
    { customer: customerC, collection_method: 'charge_automatically', auto_advance: false, currency: 'usd', metadata: { purchaseId, plan: 'web_lifetime', tier: 'standard' } },
    `inv_${purchaseId}`
  );
  await gateway.createInvoiceItem({ customer: customerC, invoice: draft.id, pricing: { price: lifetime.priceId } }, `item_${purchaseId}`);
  const open = await gateway.finalizeInvoice(draft.id, { auto_advance: false, expand: ['confirmation_secret', 'payments'] });
  const lifetimeToken = await token('pm_card_us');
  await gateway.confirmPaymentIntent(open.payments.data[0].payment.payment_intent, { confirmation_token: lifetimeToken.id }, `confirm_${purchaseId}`);
  await until(() => gateway.retrieveInvoice(draft.id), (invoice) => invoice.status === 'paid', 'the lifetime invoice to be paid');
  // A monthly subscription beside it, which the lifetime purchase must cancel.
  const subC = await subscribe(customerC, monthly, 'pm_card_us');
  const entry = {
    purchaseId, uid: `sandbox-verify-${run}-lifetime`, plan: 'web_lifetime', tierShown: 'standard', tierCharged: 'standard',
    lookupKey: lifetime.lookupKey, priceId: lifetime.priceId, amount: lifetime.amount, tax: 0, total: lifetime.amount, currency: 'usd',
    knownCountry: null, cardCountry: 'US', cardFunding: 'credit', wallet: null, billingCountry: 'US', billingState: null,
    livemode: false, lang: 'en', status: 'pending', stripe: { customerId: customerC, invoiceId: draft.id },
    createdAt: new Date(), updatedAt: new Date(),
  };
  facts = await readWebStripeFacts(gateway, customerC, [entry]);
  derived = deriveWebSlot(facts, new Date());
  const paidAt = facts.invoices.get(draft.id)?.paidAt;
  const years = derived.slot ? derived.slot.expiresAt.getUTCFullYear() - paidAt.getUTCFullYear() : 0;
  check('lifetime: active for 50 years from payment',
    derived.slot?.productId === 'web_lifetime' && derived.slot.active && years === 50 &&
      derived.slot.expiresAt.getUTCMonth() === paidAt.getUTCMonth() && derived.slot.expiresAt.getUTCDate() === paidAt.getUTCDate(),
    `paid ${iso(paidAt)}, expires ${iso(derived.slot?.expiresAt)}`);
  check('lifetime: the subscription beside it is to be cancelled', derived.cancel.includes(subC.subscriptionId), `[${derived.cancel.join(',')}]`);
  const update = ledgerUpdate(entry, facts.invoices.get(draft.id), new Date());
  check('lifetime: the pending ledger entry becomes paid with its charge', update?.status === 'paid' && typeof update['stripe.chargeId'] === 'string');

  // 5. Events and webhook signatures.
  const events = await gateway.listEvents({
    types: [...HANDLED_WEB_EVENT_TYPES],
    created: { gte: Math.floor(Date.now() / 1000) - 3600 },
    limit: 100,
  });
  const ours = events.data.filter((event) => {
    const object = event.data.object;
    return created.includes(object.customer);
  });
  check('events.list with types returns handled events for these customers', ours.length > 0,
    [...new Set(ours.map((event) => event.type))].sort().join(' '));
  const sample = events.data[0];
  const payload = JSON.stringify(sample);
  const secret = `whsec_${crypto.randomBytes(12).toString('hex')}`;
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret });
  const verified = gateway.constructEvent(Buffer.from(payload), header, secret);
  let tamperedRejected = false;
  try {
    gateway.constructEvent(Buffer.from(payload.replace(sample.id, `${sample.id}x`)), header, secret);
  } catch {
    tamperedRejected = true;
  }
  check('constructEvent accepts a signed body and rejects a changed one', verified.id === sample.id && tamperedRejected);
} catch (error) {
  failed = true;
  console.log(`FAIL  unexpected error: ${error?.type ?? ''} ${error?.code ?? ''} ${error?.name ?? ''}`);
  console.log(String(error?.message ?? error).replace(/(sk|rk)_(test|live)_[A-Za-z0-9]+/g, '<key>').slice(0, 300));
} finally {
  // Deleting a customer cancels its subscriptions.
  for (const customerId of created) {
    try {
      await gateway.deleteCustomer(customerId);
    } catch (error) {
      if (!isResourceMissing(error)) console.log(`could not delete ${customerId}: ${error?.code ?? error?.type}`);
    }
  }
  if (created.length > 0) {
    const facts = await readWebStripeFacts(gateway, created[0], []);
    check('a deleted customer derives nothing', deriveWebSlot(facts, new Date()).kind === 'nothing');
    let again;
    try {
      await gateway.deleteCustomer(created[0]);
      again = 'deleted again without error';
    } catch (error) {
      again = isResourceMissing(error) ? 'resource_missing' : `${error?.code ?? error?.type}`;
    }
    console.log(`deleting an already deleted customer: ${again}`);
  }
  console.log(`\n${results.filter((row) => row.ok).length} of ${results.length} checks passed; ${created.length} sandbox customers deleted.`);
  process.exit(failed ? 1 : 0);
}
