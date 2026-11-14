import { DocumentData, Firestore } from "firebase-admin/firestore";
import type Stripe from "stripe";
import { refusal } from "../../utils/callableAuth";
import { toAlpha2 } from "../../utils/countryCodes";
import { SubscriptionError } from "../subscriptions/errors";
import { KnownCountries, WEB_PRICING_CONFIG_PATH } from "../storeCountry";
import { isWebPlan, WebPlan } from "./ledger";
import { StripeGateway } from "./stripeGateway";

export interface WebTierConfig {
  /** Higher is dearer. */
  rank: number;
  /** Lookup key of the Stripe price per plan; a plan missing here is not sold in the tier. */
  prices: Partial<Record<WebPlan, string>>;
}

/** `web_pricing/config`, with every missing field filled from `DEFAULT_WEB_PRICING`. */
export interface WebPricingConfig {
  salesEnabled: boolean;
  taxEnabled: boolean;
  /** Uids allowed to buy while the backend runs on a sandbox key. */
  testers: string[];
  tiers: Record<string, WebTierConfig>;
  /** Alpha-2 country to tier; a country not listed is `fullPriceTier`. */
  countries: Record<string, string>;
  fullPriceTier: string;
  allowUnattestedSim: boolean;
}

const tierPrices = (tier: string, plans: WebPlan[]): Partial<Record<WebPlan, string>> =>
  Object.fromEntries(plans.map((plan) => [plan, `${plan}_${tier}`]));

/** The owner's table of 2026-11-14. Amounts live in Stripe; this only names the prices. */
export const DEFAULT_WEB_PRICING: WebPricingConfig = {
  salesEnabled: false,
  taxEnabled: false,
  testers: [],
  tiers: {
    standard: { rank: 3, prices: tierPrices("standard", ["web_monthly", "web_yearly", "web_lifetime"]) },
    reduced: { rank: 2, prices: tierPrices("reduced", ["web_monthly", "web_yearly", "web_lifetime"]) },
    low: { rank: 1, prices: tierPrices("low", ["web_yearly", "web_lifetime"]) },
  },
  countries: {
    DZ: "reduced",
    IQ: "reduced",
    JO: "reduced",
    LB: "reduced",
    LY: "reduced",
    MA: "reduced",
    TN: "reduced",
    YE: "reduced",
    EG: "low",
    TR: "low",
  },
  fullPriceTier: "standard",
  allowUnattestedSim: false,
};

/**
 * Reads the stored config field by field over the defaults.
 *
 * A field of the wrong type falls back rather than failing, so a hand edit in the console can
 * never open sales or lower prices by accident: the defaults keep sales off and charge the full
 * price. A `fullPriceTier` that names no tier falls back too.
 */
export function webPricingConfigFromData(data: DocumentData | undefined): WebPricingConfig {
  const record = data ?? {};
  const config: WebPricingConfig = {
    ...DEFAULT_WEB_PRICING,
    tiers: { ...DEFAULT_WEB_PRICING.tiers },
    countries: { ...DEFAULT_WEB_PRICING.countries },
    testers: [],
  };
  if (typeof record.salesEnabled === "boolean") config.salesEnabled = record.salesEnabled;
  if (typeof record.taxEnabled === "boolean") config.taxEnabled = record.taxEnabled;
  if (typeof record.allowUnattestedSim === "boolean") config.allowUnattestedSim = record.allowUnattestedSim;
  if (Array.isArray(record.testers)) {
    config.testers = record.testers.filter((uid: unknown): uid is string => typeof uid === "string" && uid.length > 0);
  }
  const tiers = readTiers(record.tiers);
  if (tiers) config.tiers = tiers;
  if (record.countries && typeof record.countries === "object" && !Array.isArray(record.countries)) {
    const countries: Record<string, string> = {};
    for (const [code, tier] of Object.entries(record.countries as Record<string, unknown>)) {
      const alpha2 = toAlpha2(code);
      if (alpha2 && typeof tier === "string" && config.tiers[tier]) countries[alpha2] = tier;
    }
    config.countries = countries;
  }
  if (typeof record.fullPriceTier === "string" && config.tiers[record.fullPriceTier]) {
    config.fullPriceTier = record.fullPriceTier;
  }
  if (!config.tiers[config.fullPriceTier]) {
    // Stored tiers without the default's full-price name: the dearest stored tier is full price.
    config.fullPriceTier = Object.entries(config.tiers).sort((a, b) => b[1].rank - a[1].rank)[0][0];
  }
  return config;
}

function readTiers(value: unknown): Record<string, WebTierConfig> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const tiers: Record<string, WebTierConfig> = {};
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    const tier = raw as { rank?: unknown; prices?: unknown } | null;
    if (!tier || typeof tier.rank !== "number" || !Number.isFinite(tier.rank)) return undefined;
    if (!tier.prices || typeof tier.prices !== "object") return undefined;
    const prices: Partial<Record<WebPlan, string>> = {};
    for (const [plan, lookupKey] of Object.entries(tier.prices as Record<string, unknown>)) {
      if (isWebPlan(plan) && typeof lookupKey === "string" && lookupKey) prices[plan] = lookupKey;
    }
    tiers[name] = { rank: tier.rank, prices };
  }
  return Object.keys(tiers).length > 0 ? tiers : undefined;
}

export async function readWebPricingConfig(db: Firestore): Promise<WebPricingConfig> {
  const snapshot = await db.collection(WEB_PRICING_CONFIG_PATH.collection).doc(WEB_PRICING_CONFIG_PATH.doc).get();
  return webPricingConfigFromData(snapshot.data());
}

/** A country's tier; no country, or one not listed, is the full price. */
export function tierOfCountry(config: WebPricingConfig, country: string | null | undefined): string {
  const alpha2 = country ? toAlpha2(country) : undefined;
  return (alpha2 && config.countries[alpha2]) || config.fullPriceTier;
}

function rankOf(config: WebPricingConfig, tier: string): number {
  return config.tiers[tier]?.rank ?? Number.POSITIVE_INFINITY;
}

/** The dearer of two tiers; on a tie the first. */
export function dearerTier(config: WebPricingConfig, left: string, right: string): string {
  return rankOf(config, right) > rankOf(config, left) ? right : left;
}

export interface KnownTier {
  tier: string;
  countryKnown: boolean;
  /** The known country that decided the tier, for the ledger. */
  knownCountry: string | null;
}

/**
 * The tier the account's known countries allow: the dearest among the app report and every
 * store purchase country, so evidence of a dearer country is never outweighed by a cheaper one.
 * Nothing known means the full price.
 */
export function knownTier(config: WebPricingConfig, known: KnownCountries): KnownTier {
  const countries = [...(known.appReport ? [known.appReport] : []), ...known.storePurchase];
  if (countries.length === 0) {
    return { tier: config.fullPriceTier, countryKnown: false, knownCountry: null };
  }
  let tier = tierOfCountry(config, countries[0]);
  let knownCountry = countries[0];
  for (const country of countries.slice(1)) {
    const candidate = tierOfCountry(config, country);
    if (dearerTier(config, tier, candidate) !== tier) {
      tier = candidate;
      knownCountry = country;
    }
  }
  return { tier, countryKnown: true, knownCountry };
}

/** The tier charged: the dearer of the known tier and the card's country. A card with no country is full price. */
export function chargedTier(config: WebPricingConfig, known: string, cardCountry: string | null): string {
  return dearerTier(config, known, tierOfCountry(config, cardCountry));
}

/** The lookup key of a plan in a tier, or the `plan_unavailable` refusal. */
export function lookupKeyFor(config: WebPricingConfig, tier: string, plan: WebPlan): string {
  const lookupKey = config.tiers[tier]?.prices[plan];
  if (!lookupKey) {
    throw refusal("failed-precondition", "This plan is not sold at this price level.", "plan_unavailable");
  }
  return lookupKey;
}

export interface WebPrice {
  lookupKey: string;
  priceId: string;
  plan: WebPlan;
  /** Integer cents, before tax. */
  amount: number;
  currency: string;
  interval: "month" | "year" | null;
}

const PRICE_CACHE_MS = 10 * 60 * 1000;
const EXPECTED_INTERVAL: Record<WebPlan, "month" | "year" | null> = {
  web_monthly: "month",
  web_yearly: "year",
  web_lifetime: null,
};

/** Prices by lookup key, read from Stripe and kept for ten minutes. */
export interface PriceLookup {
  get(lookupKeys: string[]): Promise<Map<string, WebPrice>>;
}

/**
 * A price lookup over one gateway.
 *
 * Amounts come only from Stripe, never from the config or the page. A price whose product,
 * currency or interval does not match its plan is a configuration error, not a sale at the wrong
 * price. Concurrent lookups of the same keys share one request.
 */
export function createPriceLookup(gateway: StripeGateway, now: () => number = Date.now): PriceLookup {
  const cache = new Map<string, { price: WebPrice; fetchedAt: number }>();
  const inFlight = new Map<string, Promise<void>>();
  const fetch = (keys: string[]): Promise<void> => {
    const id = [...keys].sort().join(",");
    let pending = inFlight.get(id);
    if (!pending) {
      pending = (async () => {
        try {
          const prices = await gateway.listPricesByLookupKeys(keys);
          const fetchedAt = now();
          for (const price of prices) {
            const parsed = parsePrice(price);
            if (parsed && keys.includes(parsed.lookupKey)) cache.set(parsed.lookupKey, { price: parsed, fetchedAt });
          }
        } finally {
          inFlight.delete(id);
        }
      })();
      inFlight.set(id, pending);
    }
    return pending;
  };
  return {
    async get(lookupKeys) {
      const fresh = (key: string) => {
        const hit = cache.get(key);
        return hit && now() - hit.fetchedAt < PRICE_CACHE_MS ? hit.price : undefined;
      };
      const missing = [...new Set(lookupKeys)].filter((key) => !fresh(key));
      if (missing.length > 0) await fetch(missing);
      const result = new Map<string, WebPrice>();
      for (const key of lookupKeys) {
        const price = cache.get(key)?.price;
        if (!price) {
          throw new SubscriptionError("configuration", "web-price-missing", `No active Stripe price has lookup key ${key}.`);
        }
        result.set(key, price);
      }
      return result;
    },
  };
}

function parsePrice(price: Stripe.Price): WebPrice | undefined {
  if (!price.lookup_key || !price.active) return undefined;
  const product = typeof price.product === "string" ? price.product : price.product?.id;
  if (!isWebPlan(product) || typeof price.unit_amount !== "number") {
    throw new SubscriptionError("configuration", "web-price-invalid", `Price ${price.id} does not belong to a web plan.`);
  }
  const interval = price.recurring?.interval ?? null;
  if (interval !== EXPECTED_INTERVAL[product] || price.currency !== "usd") {
    throw new SubscriptionError("configuration", "web-price-invalid", `Price ${price.id} does not match plan ${product}.`);
  }
  return {
    lookupKey: price.lookup_key,
    priceId: price.id,
    plan: product,
    amount: price.unit_amount,
    currency: price.currency,
    interval: interval as "month" | "year" | null,
  };
}

const lookups = new WeakMap<StripeGateway, PriceLookup>();

/** The shared lookup for a gateway, so every call in an instance uses one cache. */
export function priceLookupFor(gateway: StripeGateway): PriceLookup {
  let lookup = lookups.get(gateway);
  if (!lookup) {
    lookup = createPriceLookup(gateway);
    lookups.set(gateway, lookup);
  }
  return lookup;
}

export interface WebTotal {
  amount: number;
  tax: number;
  total: number;
  currency: string;
}

/**
 * The total a purchase charges: the price alone, or with tax switched on, Stripe's preview of the
 * invoice it would raise for the billing address. The preview is the same calculation the
 * subscription or one-off invoice then makes, so the total shown is the total charged.
 */
export async function quoteTotal(
  gateway: StripeGateway,
  price: WebPrice,
  options: { taxEnabled: boolean; address?: Stripe.AddressParam }
): Promise<WebTotal> {
  if (!options.taxEnabled) {
    return { amount: price.amount, tax: 0, total: price.amount, currency: price.currency };
  }
  const base = {
    automatic_tax: { enabled: true },
    currency: price.currency,
    customer_details: { address: options.address ?? {} },
  };
  const preview = await gateway.createInvoicePreview(
    price.interval
      ? { ...base, subscription_details: { items: [{ price: price.priceId }] } }
      : { ...base, invoice_items: [{ price: price.priceId }] }
  );
  if (preview.automatic_tax?.status === "requires_location_inputs") {
    throw refusal("invalid-argument", "The billing address is not complete enough to work out tax.", "billing_address_incomplete");
  }
  const tax = (preview.total_taxes ?? []).reduce((sum, row) => sum + (row.amount ?? 0), 0);
  return { amount: price.amount, tax, total: preview.total, currency: preview.currency ?? price.currency };
}

export interface BillingAddress {
  /** Copied to the Stripe customer so its invoices are taxed at this address. */
  address: Stripe.AddressParam;
  country: string;
  state: string | null;
}

/**
 * The billing address on a confirmation token, as tax needs it.
 *
 * The country is always required. A Canadian address also needs a province or postal code while
 * tax is on, since Stripe cannot place it otherwise; the request's `billingState` fills a missing
 * province. Only the country and province reach the ledger.
 */
export function billingAddressFromToken(
  token: Stripe.ConfirmationToken,
  options: { taxEnabled: boolean; billingState?: string }
): BillingAddress {
  const source = token.payment_method_preview?.billing_details?.address;
  const country = source?.country ? toAlpha2(source.country) : undefined;
  const incomplete = () =>
    refusal("invalid-argument", "The billing address is incomplete.", "billing_address_incomplete");
  if (!country) throw incomplete();
  let state = source?.state || null;
  if (!state && country === "CA" && options.billingState) state = options.billingState;
  if (country === "CA" && options.taxEnabled && !state && !source?.postal_code) throw incomplete();
  const address: Stripe.AddressParam = { country };
  if (state) address.state = state;
  for (const key of ["postal_code", "city", "line1", "line2"] as const) {
    if (source?.[key]) address[key] = source[key] as string;
  }
  return { address, country, state };
}

export interface TokenCard {
  country: string | null;
  funding: string | null;
  /** `apple_pay`, `google_pay` and the like, or null for a typed card. */
  wallet: string | null;
  brand: string | null;
}

/** The card on a confirmation token, or `card_required` for anything that is not a card (Link). */
export function cardFromToken(token: Stripe.ConfirmationToken): TokenCard {
  const preview = token.payment_method_preview;
  if (preview?.type !== "card" || !preview.card) {
    throw refusal("failed-precondition", "Only cards are accepted.", "card_required");
  }
  const card = preview.card;
  return {
    country: card.country ? toAlpha2(card.country) ?? null : null,
    funding: card.funding ?? null,
    wallet: card.wallet?.type ?? null,
    brand: card.brand ?? null,
  };
}
