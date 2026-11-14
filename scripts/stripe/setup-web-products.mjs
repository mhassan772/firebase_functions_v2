#!/usr/bin/env node
/**
 * Creates the web subscription products and prices in a Stripe account.
 *
 * The same script builds the sandbox and the live account, so both hold the
 * same catalogue. It is safe to run again: a product or price that already
 * matches is left alone.
 *
 * Reads the key from STRIPE_WEB_SECRET_KEY. Without --apply it only prints
 * what it would do. A live key is refused unless --live is also passed.
 *
 *   node --env-file=<path to .env.local> scripts/stripe/setup-web-products.mjs
 *   node --env-file=<path to .env.local> scripts/stripe/setup-web-products.mjs --apply
 */
import Stripe from 'stripe';

/** Software as a service, personal use: premium unlocks app features, the audio is free. */
const TAX_CODE = 'txcd_10103000';
const STATEMENT_DESCRIPTOR = 'MANTOOQ';
const CURRENCY = 'usd';

/** Product ids match the product ids the subscription backend stores on a web slot. */
const PRODUCTS = [
  {id: 'web_monthly', name: 'Mantooq Premium – Monthly', interval: 'month'},
  {id: 'web_yearly', name: 'Mantooq Premium – Yearly', interval: 'year'},
  {id: 'web_lifetime', name: 'Mantooq Premium – Lifetime', interval: null},
];

/** Amounts in cents. A missing tier means the plan is not sold there. */
const AMOUNTS = {
  web_monthly: {standard: 499, reduced: 399},
  web_yearly: {standard: 4999, reduced: 3999, low: 1999},
  web_lifetime: {standard: 14999, reduced: 11999, low: 5999},
};

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const allowLive = args.has('--live');

const key = process.env.STRIPE_WEB_SECRET_KEY ?? '';
if (!key) {
  console.error('STRIPE_WEB_SECRET_KEY is not set.');
  process.exit(1);
}
const isLive = !key.startsWith('sk_test_') && !key.startsWith('rk_test_');
if (isLive && !allowLive) {
  console.error('This is not a test key. Pass --live to run against the live account.');
  process.exit(1);
}

const stripe = new Stripe(key);
const mode = isLive ? 'LIVE' : 'sandbox';
console.log(`Stripe ${mode} account, ${apply ? 'applying changes' : 'dry run (pass --apply to create)'}\n`);

async function findProduct(id) {
  try {
    return await stripe.products.retrieve(id);
  } catch (error) {
    if (error?.code === 'resource_missing') return null;
    throw error;
  }
}

async function ensureProduct(spec) {
  const wanted = {
    name: spec.name,
    tax_code: TAX_CODE,
    statement_descriptor: STATEMENT_DESCRIPTOR,
    metadata: {plan: spec.id},
  };
  const existing = await findProduct(spec.id);
  if (!existing) {
    console.log(`product ${spec.id}: create "${spec.name}"`);
    if (apply) await stripe.products.create({id: spec.id, ...wanted});
    return;
  }
  const existingTaxCode = typeof existing.tax_code === 'string' ? existing.tax_code : existing.tax_code?.id;
  const same =
    existing.name === wanted.name &&
    existingTaxCode === wanted.tax_code &&
    existing.statement_descriptor === wanted.statement_descriptor &&
    existing.active;
  if (same) {
    console.log(`product ${spec.id}: ok`);
    return;
  }
  console.log(`product ${spec.id}: update to match`);
  if (apply) await stripe.products.update(spec.id, {...wanted, active: true});
}

function priceMatches(price, spec, amount) {
  return (
    price.active &&
    price.product === spec.id &&
    price.currency === CURRENCY &&
    price.unit_amount === amount &&
    price.tax_behavior === 'exclusive' &&
    (price.recurring?.interval ?? null) === spec.interval
  );
}

async function ensurePrice(spec, tier, amount) {
  const lookupKey = `${spec.id}_${tier}`;
  const found = await stripe.prices.list({lookup_keys: [lookupKey], limit: 1});
  const existing = found.data[0];
  const label = `${lookupKey}: $${(amount / 100).toFixed(2)}`;
  if (existing && priceMatches(existing, spec, amount)) {
    console.log(`price ${label}: ok (${existing.id})`);
    return;
  }
  // An amount cannot be edited on a price. A changed amount gets a new price
  // that takes over the lookup key; subscribers on the old price keep it.
  console.log(`price ${label}: ${existing ? `replace ${existing.id}` : 'create'}`);
  if (!apply) return;
  const created = await stripe.prices.create({
    product: spec.id,
    currency: CURRENCY,
    unit_amount: amount,
    tax_behavior: 'exclusive',
    lookup_key: lookupKey,
    transfer_lookup_key: true,
    metadata: {plan: spec.id, tier},
    ...(spec.interval ? {recurring: {interval: spec.interval}} : {}),
  });
  console.log(`  created ${created.id}`);
}

const taxCode = await stripe.taxCodes.retrieve(TAX_CODE);
console.log(`tax code ${taxCode.id}: ${taxCode.name}\n`);

for (const spec of PRODUCTS) {
  await ensureProduct(spec);
  for (const [tier, amount] of Object.entries(AMOUNTS[spec.id])) {
    await ensurePrice(spec, tier, amount);
  }
}

console.log(apply ? '\nDone.' : '\nNothing was changed.');
