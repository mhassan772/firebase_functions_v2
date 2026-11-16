/// What the account page decides from the callables' answers, kept apart from the DOM and
/// Stripe.js so it can be tested.

import { STRINGS, type Lang, type StoreWords, type Strings } from "../i18n";

export type Plan = "web_monthly" | "web_yearly" | "web_lifetime";
const PLANS: readonly Plan[] = ["web_monthly", "web_yearly", "web_lifetime"];

export type StorePlatform = "apple" | "google";

export interface PlanOffer {
  plan: Plan;
  /** Integer cents. */
  amount: number;
  currency: string;
  interval: "month" | "year" | null;
}

export interface StoreSubscription {
  platform: StorePlatform;
  autoRenewing: boolean;
}

/// One source of premium the account holds now, as `getWebPlans` lists it.
export interface PremiumSource {
  source: "web" | StorePlatform | "manual";
  kind: "subscription" | "lifetime" | "grant";
  plan?: Plan;
  state: "active" | "cancelling" | "payment_failed" | "needs_action";
  /// True only when it will charge again on its own.
  renews: boolean;
  /// The renewal date when `renews`, else the day premium ends; absent for lifetime.
  until?: string;
}

/// `getWebPlans`.
export interface PlansResponse {
  publishableKey: string;
  livemode: boolean;
  countryKnown: boolean;
  tier: string;
  plans: PlanOffer[];
  taxEnabled: boolean;
  current: { state: SubscriptionState; plan?: string } | null;
  storeSubscription: StoreSubscription | null;
  blockers: string[];
  /// Missing from a backend older than this page.
  premium?: PremiumSource[];
}

/// What a re-price answer shows; nothing was charged.
export interface Quote {
  plan: Plan;
  tier: string;
  amount: number;
  tax: number;
  total: number;
  currency: string;
  reason: "card_country" | "tax" | "both" | "price_changed";
}

export type StartResult =
  | { status: "succeeded"; purchaseId: string }
  | { status: "requires_action"; purchaseId: string; clientSecret: string }
  | { status: "pending"; purchaseId: string }
  | { status: "reprice"; quote: Quote };

export interface FinishResult {
  status: "succeeded" | "pending" | "failed";
  category?: DeclineCategory;
}

export type SubscriptionState = "none" | "active" | "cancelling" | "payment_failed" | "needs_action" | "ended" | "lifetime";

/// `getWebSubscription`.
export interface SubscriptionResponse {
  state: SubscriptionState;
  plan?: string;
  amount?: number;
  currency?: string;
  renewsAt?: string;
  endsAt?: string;
  card?: { brand: string; last4: string };
  purchaseId?: string;
  /// Left out when the configured key does not match the mode.
  publishableKey?: string;
  livemode?: boolean;
  storeSubscription: StoreSubscription | null;
  /// Every source of premium the account holds; missing from a backend older than this page.
  premium?: PremiumSource[];
}

export type ManageResult =
  | { status: "succeeded" }
  | { status: "reprice"; quote: Quote }
  | { status: "requires_action"; setupIntentId: string; clientSecret: string };

/// What a monthly-to-yearly switch costs today, from `quote_switch_yearly` or a re-price.
export interface SwitchQuote {
  plan: "web_yearly";
  tier: string;
  /// The yearly price, before tax. Integer cents, as every amount here.
  amount: number;
  /// The unused days of the month, a positive number taken off the amount.
  credit: number;
  tax: number;
  /// What the saved card is charged today.
  total: number;
  currency: string;
  /// The end of the year the switch pays for.
  renewsAt: string;
  card?: { brand: string; last4: string };
}

export type SwitchResult =
  | { status: "quote"; quote: SwitchQuote }
  | { status: "reprice"; quote: SwitchQuote }
  | { status: "succeeded"; purchaseId: string }
  | { status: "requires_action"; purchaseId: string; clientSecret: string };

/// What an upgrade to lifetime costs today, from `quote_lifetime` or a re-price.
export interface LifetimeQuote {
  plan: "web_lifetime";
  tier: string;
  /// The lifetime price, before tax. Integer cents, as every amount here.
  amount: number;
  /// The unused time of the current plan's paid period, a positive number taken off the amount.
  credit: number;
  tax: number;
  total: number;
  currency: string;
  /// The plan whose unused time is credited, and which stops.
  creditedPlan: "web_monthly" | "web_yearly";
  card?: { brand: string; last4: string };
}

export type LifetimeResult =
  | { status: "quote"; quote: LifetimeQuote }
  | { status: "reprice"; quote: LifetimeQuote }
  | { status: "succeeded"; purchaseId: string }
  | { status: "requires_action"; purchaseId: string; clientSecret: string };

export function isPlan(value: unknown): value is Plan {
  return typeof value === "string" && (PLANS as readonly string[]).includes(value);
}

function isRecurring(plan: Plan): boolean {
  return plan !== "web_lifetime";
}

// ---------------------------------------------------------------------------
// Formatting

/// The locale the page formats with: Arabic with Arabic-Indic digits and the Gregorian calendar,
/// matching the page's own copy, or English.
function locale(lang: Lang): string {
  return lang === "ar" ? "ar-u-nu-arab-ca-gregory" : "en";
}

/// Wraps a value placed inside Arabic text in a first-strong isolate, so its digits and any Latin
/// text (a card brand, a store's name) never reorder the sentence around it.
export function isolate(text: string, lang: Lang): string {
  return lang === "ar" ? `⁨${text}⁩` : text;
}

function amountNumber(cents: number, lang: Lang): string {
  return new Intl.NumberFormat(locale(lang), { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100);
}

/// An amount in cents as the page shows and speaks it: "٤٫٩٩ دولار" or "$4.99". Whole amounts
/// keep their cents, so two prices never look alike; a currency other than US dollars uses the
/// platform's own format.
export function formatMoney(cents: number, currency: string, lang: Lang): string {
  const code = currency.toUpperCase();
  if (code === "USD") return isolate(STRINGS[lang].dollars(amountNumber(cents, lang)), lang);
  return isolate(
    new Intl.NumberFormat(locale(lang), { style: "currency", currency: code, minimumFractionDigits: 2 }).format(cents / 100),
    lang,
  );
}

/// The amount with its currency named in full, said once above the pay button.
export function formatMoneyInFull(cents: number, currency: string, lang: Lang): string {
  const code = currency.toUpperCase();
  if (code === "USD") return isolate(STRINGS[lang].dollarsInFull(amountNumber(cents, lang)), lang);
  const name = new Intl.DisplayNames(lang, { type: "currency" }).of(code) ?? code;
  return isolate(`${formatMoney(cents, currency, lang)} (${name})`, lang);
}

/// A date from the callables (ISO 8601) in words, such as "14 December 2026", or null when missing
/// or unreadable. Shown in UTC, the time zone Stripe dates its periods in.
export function formatDate(iso: string | undefined, lang: Lang): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return isolate(new Intl.DateTimeFormat(locale(lang), { dateStyle: "long", timeZone: "UTC" }).format(new Date(ms)), lang);
}

/// A store as each place of a sentence names it ("an App Store subscription", "on Google Play");
/// with no store known, the store in general. Isolated inside Arabic text.
export function storeWords(store: StorePlatform | null, s: Strings, lang: Lang): StoreWords {
  const name = store === "apple" ? s.appStoreName : store === "google" ? s.playStoreName : s.anyStore;
  const words = s.storeWords(store, name);
  return { name: isolate(words.name, lang), a: isolate(words.a, lang), in: isolate(words.in, lang), through: isolate(words.through, lang) };
}

export function planName(plan: Plan, s: Strings): string {
  return plan === "web_monthly" ? s.planMonthly : plan === "web_yearly" ? s.planYearly : s.planLifetime;
}

/// A card brand as Stripe names it ("visa", "amex") in the form people know.
export function cardBrandName(brand: string): string {
  const names: Record<string, string> = {
    visa: "Visa",
    mastercard: "Mastercard",
    amex: "American Express",
    discover: "Discover",
    jcb: "JCB",
    unionpay: "UnionPay",
    diners: "Diners Club",
    cartes_bancaires: "Cartes Bancaires",
    eftpos_au: "eftpos",
    interac: "Interac",
  };
  return names[brand] ?? (brand ? brand.charAt(0).toUpperCase() + brand.slice(1) : "");
}

/// "Visa ending in 4242", with the brand and the digits isolated inside Arabic text.
export function cardText(card: { brand: string; last4: string }, s: Strings, lang: Lang): string {
  return s.cardEnding(isolate(cardBrandName(card.brand), lang), isolate(card.last4, lang));
}

// ---------------------------------------------------------------------------
// The purchase

/// The plans a purchase can still be made for, in the order the server listed them.
///
/// Lifetime access blocks everything. A web subscription or an auto-renewing store subscription
/// blocks only monthly and yearly, except a web subscription that is active or cancelled but
/// running: it upgrades to lifetime with a credit for its unused time, so lifetime is not sold to
/// it as a new purchase either. One whose renewal failed has no unused time, so lifetime stays.
export function purchasablePlans(response: Pick<PlansResponse, "plans" | "blockers"> & Partial<Pick<PlansResponse, "current">>): PlanOffer[] {
  const blockers = new Set(response.blockers);
  if (blockers.has("lifetime_active")) return [];
  const recurringBlocked = blockers.has("already_subscribed") || blockers.has("store_subscription_active");
  const state = response.current?.state;
  const lifetimeBlocked = blockers.has("already_subscribed") && (state === "active" || state === "cancelling");
  return response.plans.filter(
    (offer) => isPlan(offer.plan) && !(recurringBlocked && isRecurring(offer.plan)) && !(lifetimeBlocked && offer.plan === "web_lifetime"),
  );
}

/// What the account already has; a backend older than the page sends no list, read as empty.
export function premiumOf(response: { premium?: PremiumSource[] }): PremiumSource[] {
  return Array.isArray(response.premium) ? response.premium : [];
}

/// One line about premium from a store or a grant that the status does not describe itself; this
/// site's own purchase is always the status.
export function premiumLine(source: PremiumSource, s: Strings, lang: Lang): string {
  const date = formatDate(source.until, lang);
  if (isStore(source)) {
    const store = storeWords(source.source, s, lang);
    return source.renews ? s.premiumStoreRenews(store, date) : s.premiumStoreCancelling(store, date);
  }
  return s.premiumManual(date);
}

/// What a purchase must be confirmed over: premium from a store or a manual grant; null when
/// nothing needs confirming. `renewingStores` keep charging after the purchase, so the notice
/// says renewal must be turned off in the store.
export function confirmationFor(response: Pick<PlansResponse, "premium">): { renewingStores: StorePlatform[] } | null {
  const sources = premiumOf(response).filter((source) => source.source !== "web");
  if (sources.length === 0) return null;
  const renewingStores = sources.flatMap((source) =>
    (source.source === "apple" || source.source === "google") && source.renews ? [source.source] : [],
  );
  return { renewingStores };
}

/// The plan picked when the purchase opens: yearly when sold, else the first one.
export function defaultPlan(offers: readonly PlanOffer[]): Plan | null {
  return offers.find((offer) => offer.plan === "web_yearly")?.plan ?? offers[0]?.plan ?? null;
}

/// The yearly badge shows from this share up.
const MIN_SAVED_PERCENT = 5;

/// The share the yearly plan saves against twelve months of the tier's monthly plan, rounded down
/// to a whole percent; 0 when the tier sells no monthly plan or the saving is under 5%.
export function savedPercent(tierPlans: readonly PlanOffer[]): number {
  const monthly = tierPlans.find((offer) => offer.plan === "web_monthly");
  const yearly = tierPlans.find((offer) => offer.plan === "web_yearly");
  if (!monthly || !yearly || monthly.amount <= 0 || monthly.currency !== yearly.currency) return 0;
  const percent = Math.floor(((monthly.amount * 12 - yearly.amount) * 100) / (monthly.amount * 12));
  return percent >= MIN_SAVED_PERCENT ? percent : 0;
}

/// The total the pay button states and `acceptedTotal` carries: the quote's when the server
/// re-priced this plan, else the plan's price.
export function shownTotal(offer: PlanOffer, quote: Quote | null): number {
  return quote && quote.plan === offer.plan ? quote.total : offer.amount;
}

/// Whether a re-price only adds tax to the price shown, which the page presents as the total with
/// tax rather than as a change of price.
export function onlyTaxAdded(offer: PlanOffer, quote: Quote): boolean {
  return quote.reason === "tax" && quote.amount === offer.amount && quote.currency === offer.currency;
}

/// The one note above the pay button: the total today, how it renews or that it never does, and
/// no refunds.
export function payNote(offer: PlanOffer, total: number, s: Strings, lang: Lang): string {
  const today = formatMoneyInFull(total, offer.currency, lang);
  switch (offer.interval) {
    case "month":
      return s.payNoteMonthly(today);
    case "year":
      return s.payNoteYearly(today);
    default:
      return s.payNoteLifetime(today);
  }
}

export type ElementsKind = "subscription" | "payment" | "setup";

export function elementsKindFor(plan: Plan): ElementsKind {
  return plan === "web_lifetime" ? "payment" : "subscription";
}

/// The deferred-intent options of the Elements group, without locale and appearance.
///
/// Subscription and setup tokens must carry `setup_future_usage: off_session`, since the
/// subscription's first PaymentIntent and the card replacement's SetupIntent are off-session; the
/// lifetime payment's must carry none. Only cards are allowed, which also keeps Link out.
export function elementsOptions(kind: ElementsKind, amount: number, currency: string) {
  const base = {
    currency: currency.toLowerCase(),
    paymentMethodCreation: "manual" as const,
    allowedPaymentMethodTypes: ["card"],
  };
  switch (kind) {
    case "subscription":
      return { ...base, mode: "subscription" as const, amount, setupFutureUsage: "off_session" as const };
    case "payment":
      return { ...base, mode: "payment" as const, amount, setupFutureUsage: null };
    case "setup":
      return { ...base, mode: "setup" as const, setupFutureUsage: "off_session" as const };
  }
}

/// The Payment Element's own options: billing address as Stripe needs it, wallets but no Link.
export const PAYMENT_ELEMENT_OPTIONS = {
  layout: "tabs" as const,
  wallets: { link: "never" as const, applePay: "auto" as const, googlePay: "auto" as const },
  fields: { billingDetails: { address: "auto" as const } },
};

// ---------------------------------------------------------------------------
// Refusals

export type DeclineCategory = "declined" | "insufficient_funds" | "expired_card" | "incorrect_details" | "authentication_failed";

const DECLINE_CATEGORIES: readonly DeclineCategory[] = [
  "declined",
  "insufficient_funds",
  "expired_card",
  "incorrect_details",
  "authentication_failed",
];

/// A failed call, decided from its code and `details` alone; the message is never shown.
export type Refusal =
  | { kind: "declined"; category: DeclineCategory }
  | { kind: "storeSubscriptionActive"; platform: StorePlatform | null }
  | {
      kind:
        | "existingPremium"
        | "throttled"
        | "salesDisabled"
        | "emailUnverified"
        | "planUnavailable"
        | "billingAddressIncomplete"
        | "alreadySubscribed"
        | "lifetimeActive"
        | "tokenInvalid"
        | "cardRequired"
        | "noSubscription"
        | "switchUnavailable"
        | "lifetimeUnavailable"
        | "chargeIncomplete"
        | "purchaseNotFound"
        | "noActionRequired"
        | "purchaseInProgress"
        | "accountDeleted"
        | "signedOut"
        | "noAnswer"
        | "generic";
    };

const SDK_ONLY_MESSAGE = /^internal(?: \[\d+\])?$/;

export function refusalFrom(error: unknown): Refusal {
  const record = (error ?? {}) as { code?: unknown; message?: unknown; details?: unknown };
  const code = typeof record.code === "string" ? record.code : "";
  const details = (record.details && typeof record.details === "object" ? record.details : {}) as Record<string, unknown>;
  switch (code) {
    case "functions/unauthenticated":
      return { kind: "signedOut" };
    case "functions/deadline-exceeded":
    case "functions/unavailable":
    case "auth/network-request-failed":
      return { kind: "noAnswer" };
    case "functions/internal":
      // The SDK reports a request that got no readable answer as `internal` with only the code
      // (and from 12.19 the HTTP status) as its message; the backend's own carries its own.
      return SDK_ONLY_MESSAGE.test(String(record.message)) ? { kind: "noAnswer" } : { kind: "generic" };
    case "functions/resource-exhausted":
      return details.reason === "throttled" ? { kind: "throttled" } : { kind: "generic" };
  }
  switch (details.reason) {
    case "card_declined": {
      const category = DECLINE_CATEGORIES.find((value) => value === details.category) ?? "declined";
      return { kind: "declined", category };
    }
    case "store_subscription_active":
      return {
        kind: "storeSubscriptionActive",
        platform: details.platform === "apple" || details.platform === "google" ? details.platform : null,
      };
    case "throttled":
      return { kind: "throttled" };
    case "sales_disabled":
      return { kind: "salesDisabled" };
    case "email_unverified":
      return { kind: "emailUnverified" };
    case "plan_unavailable":
      return { kind: "planUnavailable" };
    case "billing_address_incomplete":
      return { kind: "billingAddressIncomplete" };
    case "already_subscribed":
      return { kind: "alreadySubscribed" };
    case "lifetime_active":
      return { kind: "lifetimeActive" };
    case "token_invalid":
      return { kind: "tokenInvalid" };
    case "card_required":
      return { kind: "cardRequired" };
    case "no_subscription":
      return { kind: "noSubscription" };
    case "no_action_required":
      return { kind: "noActionRequired" };
    case "switch_unavailable":
      return { kind: "switchUnavailable" };
    case "lifetime_unavailable":
      return { kind: "lifetimeUnavailable" };
    case "switch_incomplete":
    case "lifetime_incomplete":
      return { kind: "chargeIncomplete" };
    case "purchase_not_found":
      return { kind: "purchaseNotFound" };
    case "purchase_in_progress":
      return { kind: "purchaseInProgress" };
    case "existing_premium":
      return { kind: "existingPremium" };
    case "account_deleted":
      return { kind: "accountDeleted" };
    default:
      return { kind: "generic" };
  }
}

/// The `startWebPurchase` request for one press of the pay button.
///
/// Every attempt carries a confirmation token made from the card form at that moment, never one
/// from an earlier attempt: the Payment Element does not report every edit, so a saved token could
/// charge a card or security code the buyer has changed since. A re-price accepted is such an
/// attempt too, with the quote's total as the accepted total.
///
/// Optional keys are left out rather than set to `undefined`, which the callable SDK sends as
/// `null`: `billingState` without a province, and `acknowledgeExisting` until the buyer ticked
/// the confirmation, since a backend older than the page refuses a field it does not know.
export function purchaseRequest(options: {
  offer: PlanOffer;
  quote: Quote | null;
  freshTokenId: string;
  province: string | null;
  lang: Lang;
  acknowledged?: boolean;
}) {
  return {
    plan: options.offer.plan,
    confirmationToken: options.freshTokenId,
    acceptedTotal: shownTotal(options.offer, options.quote),
    ...(options.province ? { billingState: options.province } : {}),
    lang: options.lang,
    ...(options.acknowledged ? { acknowledgeExisting: true as const } : {}),
  };
}

/// The `replace_card` request for one press of the save button, with a fresh token for the same
/// reason; an accepted re-price sends the quoted renewal amount, and no re-price sends no key.
export function replaceCardRequest(freshTokenId: string, quote: Quote | null) {
  return {
    action: "replace_card" as const,
    confirmationToken: freshTokenId,
    ...(quote ? { acceptedRenewalAmount: quote.amount } : {}),
  };
}

/// Whether a refusal is answered by asking for the Canadian province: the server wants a province
/// (or postal code) only for a Canadian billing address, and the page can add the province.
export function asksForProvince(refusal: Refusal, billingCountry: string | null): boolean {
  return refusal.kind === "billingAddressIncomplete" && billingCountry === "CA";
}

// ---------------------------------------------------------------------------
// The account view

/// `getWebPlans` answers on its own: a refusal affects only what the page sells.
export type PlansAnswer = { plans: PlansResponse } | { refusal: Refusal };

export type Tone = "ok" | "warn" | "neutral";

/// What the status block describes; its words come from `statusText`.
export type Status =
  | { kind: "lifetime" }
  | { kind: "needsAction"; until?: string }
  | { kind: "paymentFailed"; until?: string }
  | { kind: "active"; plan?: Plan; renewsAt?: string; amount?: number; currency?: string }
  | { kind: "cancelling"; until?: string }
  | { kind: "storeRenews"; platform: StorePlatform; renewsAt?: string }
  | { kind: "endsOnItsOwn"; source: PremiumSource }
  | { kind: "ended"; endedAt?: string }
  | { kind: "none" }
  /// A purchase this tab just paid for that the records do not show yet.
  | { kind: "confirming" };

export type Primary =
  | { kind: "confirmPayment" }
  | { kind: "changeCard" }
  | { kind: "resume" }
  | { kind: "manageInStore"; platform: StorePlatform }
  /// Asks again where the confirming purchase stands.
  | { kind: "checkAgain" }
  /// The pay button of the purchase that follows the status.
  | { kind: "pay" };

/// A purchase by card: the plans, or why there are none.
export interface Purchase {
  offers: PlanOffer[];
  /// Why nothing can be bought now; the plans are then left out.
  unavailable: "salesDisabled" | "emailUnverified" | "noAnswer" | "generic" | null;
  unknownCountry: boolean;
  /// The share the yearly plan saves, for its badge; 0 for none.
  savedPercent: number;
  /// Premium from elsewhere the buyer confirms first, with the stores that keep renewing.
  confirm: { renewingStores: StorePlatform[] } | null;
}

export type Section =
  | { kind: "payingTwice"; platform: StorePlatform; lifetime: boolean }
  | { kind: "card"; card?: { brand: string; last4: string } }
  | { kind: "lifetimeInstead"; purchase: Purchase }
  | { kind: "upgrade"; yearly: boolean; lifetime: boolean }
  | { kind: "payByCard"; platform: StorePlatform; until?: string; lifetime: Purchase | null }
  | { kind: "continueAfter"; purchase: Purchase }
  | { kind: "purchase"; purchase: Purchase };

export interface AccountView {
  tone: Tone;
  status: Status;
  /// Further sources of premium, one plain line each under the status.
  others: PremiumSource[];
  primary: Primary | null;
  sections: Section[];
  /// The cancel link at the very bottom.
  cancel: boolean;
}

/// The store whose subscription also renews while the web purchase gives access, so the buyer is
/// paying twice; null when there is nothing to warn about. A cancelled web subscription no longer
/// renews, so it is not paying twice.
export function doubleSubscriptionStore(response: Pick<SubscriptionResponse, "state" | "storeSubscription">): StorePlatform | null {
  const store = response.storeSubscription;
  if (!store?.autoRenewing) return null;
  const paying = ["active", "payment_failed", "needs_action", "lifetime"].includes(response.state);
  return paying ? store.platform : null;
}

function isStore(source: PremiumSource): source is PremiumSource & { source: StorePlatform } {
  return source.source === "apple" || source.source === "google";
}

/// Premium other than this site's that still runs at `now`. An older backend lists nothing, so a
/// renewing store subscription it reports apart is read as one source with no date.
function otherSources(subscription: SubscriptionResponse, answer: PlansAnswer, now: number): PremiumSource[] {
  let sources = premiumOf(subscription);
  if (sources.length === 0 && "plans" in answer) sources = premiumOf(answer.plans);
  const others = sources.filter((source) => {
    if (source.source === "web") return false;
    const ends = source.until ? Date.parse(source.until) : Number.NaN;
    return source.renews || !Number.isFinite(ends) || ends > now;
  });
  const store = subscription.storeSubscription;
  if (others.length === 0 && premiumOf(subscription).length === 0 && store?.autoRenewing) {
    return [{ source: store.platform, kind: "subscription", state: "active", renews: true }];
  }
  return others;
}

/// The source that ends last; one with no end date lasts longest.
function endsLast(sources: readonly PremiumSource[]): PremiumSource {
  const end = (source: PremiumSource) => (source.until ? Date.parse(source.until) : Number.POSITIVE_INFINITY);
  return sources.reduce((last, source) => (end(source) > end(last) ? source : last));
}

/// The purchase the account can make now, or one plan of it; null when `only` is not for sale.
function purchaseOf(answer: PlansAnswer, only?: Plan): Purchase | null {
  if ("refusal" in answer) {
    if (only) return null;
    const kind = answer.refusal.kind;
    const unavailable = kind === "salesDisabled" || kind === "emailUnverified" || kind === "noAnswer" ? kind : "generic";
    return { offers: [], unavailable, unknownCountry: false, savedPercent: 0, confirm: null };
  }
  const plans = answer.plans;
  const offers = purchasablePlans(plans).filter((offer) => !only || offer.plan === only);
  if (only && offers.length === 0) return null;
  return {
    offers,
    unavailable: offers.length ? null : "generic",
    unknownCountry: !plans.countryKnown,
    savedPercent: savedPercent(plans.plans),
    confirm: confirmationFor(plans),
  };
}

/// A purchase this tab paid for (or sent and got no final answer for), remembered until the account
/// shows it, so a reload in the seconds the records lag never offers the purchase again.
export interface PendingPurchase {
  purchaseId: string;
  /// What it bought: a lifetime purchase over a failed renewal is shown only once the account is
  /// lifetime.
  plan: Plan;
  /// When it was made, in milliseconds.
  at: number;
}

/// How long a pending purchase is remembered; past this the page trusts the account again.
export const PENDING_PURCHASE_MS = 15 * 60 * 1000;

/// The pending purchase still worth remembering after a load: dropped once it is too old, or once
/// the account shows it: any premium from this site, or lifetime for a lifetime purchase made over
/// a failed renewal (`payment_failed`, `needs_action`), which shows as that state until it syncs.
export function pendingAfterLoad(pending: PendingPurchase | null, subscription: Pick<SubscriptionResponse, "state">, now: number): PendingPurchase | null {
  if (!pending || now - pending.at >= PENDING_PURCHASE_MS || now < pending.at) return null;
  const state = subscription.state;
  if (state === "none" || state === "ended") return pending;
  const overFailedRenewal = state === "payment_failed" || state === "needs_action";
  return pending.plan === "web_lifetime" && overFailedRenewal ? pending : null;
}

/// Whether a pending purchase is kept after asking the server again: forgotten when it failed or
/// does not exist, so the purchase is offered again; kept while it is confirming, paid but not
/// yet shown, or unanswered.
export function keepsPending(outcome: "succeeded" | "pending" | "failed" | "notFound" | "noAnswer"): boolean {
  return outcome !== "failed" && outcome !== "notFound";
}

/// The `getWebPlans` answer disagrees with `getWebSubscription` about this site's subscription:
/// the two run together, and the subscription call syncs first, so the plans may describe the
/// account before the sync. One says none or ended while the other says subscribed or lifetime.
export function plansDisagree(subscription: Pick<SubscriptionResponse, "state">, plans: Pick<PlansResponse, "current" | "blockers">): boolean {
  const subscriptionHas = subscription.state !== "none" && subscription.state !== "ended";
  const plansState = plans.current?.state;
  const plansHave =
    (plansState !== undefined && plansState !== "none" && plansState !== "ended") ||
    plans.blockers.includes("already_subscribed") ||
    plans.blockers.includes("lifetime_active");
  return subscriptionHas !== plansHave;
}

/// The lifetime purchase a section offers, for the panel it opens; null once the section or its
/// offer is gone, as after a reload into another state.
export function lifetimePurchaseIn(view: AccountView, slot: string): Purchase | null {
  const section = view.sections.find((candidate) => candidate.kind === slot);
  if (section?.kind === "lifetimeInstead") return section.purchase;
  if (section?.kind === "payByCard") return section.lifetime;
  return null;
}

/// The pay button's state: busy, waiting for the card form, or waiting for the "I understand"
/// tick, each said through the region that explains it.
export function payButtonState(options: { busy: boolean; cardReady: boolean; waitingForTick: boolean; errorId: string | null; quote: boolean }): {
  disabled: boolean;
  describedBy: string;
} {
  return {
    disabled: options.busy || !options.cardReady || options.waitingForTick,
    describedBy: [options.errorId, options.quote ? "quote" : null, options.waitingForTick ? "existing-notice" : null, "pay-note"]
      .filter(Boolean)
      .join(" "),
  };
}

/// The whole page for an account: the status, the one primary control, the sections in order and
/// whether the cancel link shows. The first matching state wins; the route renders only this.
/// `pending` is a purchase this tab made that the account may not show yet (`pendingAfterLoad`).
export function accountView(subscription: SubscriptionResponse, answer: PlansAnswer, now: number, pending: PendingPurchase | null = null): AccountView {
  const others = otherSources(subscription, answer, now);
  const twice = doubleSubscriptionStore(subscription);
  // The paying-twice warning names the store, so its line would say it twice.
  const lines = (except?: PremiumSource) => others.filter((source) => source !== except && !(twice && source.source === twice && source.renews));
  const twiceSections: Section[] = twice ? [{ kind: "payingTwice", platform: twice, lifetime: subscription.state === "lifetime" }] : [];
  const salesOff = "refusal" in answer && answer.refusal.kind === "salesDisabled";
  const plan = isPlan(subscription.plan) ? subscription.plan : undefined;
  const upgrade: Section[] =
    !salesOff && (plan === "web_monthly" || plan === "web_yearly") ? [{ kind: "upgrade", yearly: plan === "web_monthly", lifetime: true }] : [];
  const card: Section = { kind: "card", ...(subscription.card ? { card: subscription.card } : {}) };

  if (pendingAfterLoad(pending, subscription, now)) {
    // Paid moments ago and not on the account yet: nothing is sold until it shows or fails.
    return { tone: "neutral", status: { kind: "confirming" }, others: lines(), primary: { kind: "checkAgain" }, sections: [], cancel: false };
  }

  switch (subscription.state) {
    case "lifetime":
      return { tone: "ok", status: { kind: "lifetime" }, others: lines(), primary: null, sections: twiceSections, cancel: false };
    case "needs_action":
      return {
        tone: "warn",
        status: { kind: "needsAction", until: subscription.endsAt },
        others: lines(),
        primary: { kind: "confirmPayment" },
        sections: [...twiceSections, card],
        cancel: true,
      };
    case "payment_failed": {
      const lifetime = purchaseOf(answer, "web_lifetime");
      return {
        tone: "warn",
        status: { kind: "paymentFailed", until: subscription.endsAt },
        others: lines(),
        primary: { kind: "changeCard" },
        sections: [...twiceSections, ...(lifetime ? [{ kind: "lifetimeInstead" as const, purchase: lifetime }] : [])],
        cancel: true,
      };
    }
    case "active":
      return {
        tone: "ok",
        status: { kind: "active", plan, renewsAt: subscription.renewsAt, amount: subscription.amount, currency: subscription.currency },
        others: lines(),
        primary: null,
        sections: [...twiceSections, card, ...upgrade],
        cancel: true,
      };
    case "cancelling":
      return {
        tone: "ok",
        status: { kind: "cancelling", until: subscription.endsAt },
        others: lines(),
        primary: { kind: "resume" },
        sections: [card, ...upgrade],
        cancel: false,
      };
    case "ended":
    case "none":
      break;
  }


  const renewing = others.find((source) => isStore(source) && source.renews) as (PremiumSource & { source: StorePlatform }) | undefined;
  if (renewing) {
    return {
      tone: "ok",
      status: { kind: "storeRenews", platform: renewing.source, renewsAt: renewing.until },
      others: lines(renewing),
      primary: { kind: "manageInStore", platform: renewing.source },
      sections: salesOff ? [] : [{ kind: "payByCard", platform: renewing.source, until: renewing.until, lifetime: purchaseOf(answer, "web_lifetime") }],
      cancel: false,
    };
  }
  if (others.length > 0) {
    const described = endsLast(others);
    return {
      tone: "ok",
      status: { kind: "endsOnItsOwn", source: described },
      others: lines(described),
      primary: null,
      sections: [{ kind: "continueAfter", purchase: purchaseOf(answer)! }],
      cancel: false,
    };
  }
  const purchase = purchaseOf(answer)!;
  return {
    tone: "neutral",
    status: subscription.state === "ended" ? { kind: "ended", endedAt: subscription.endsAt } : { kind: "none" },
    others: [],
    primary: purchase.offers.length ? { kind: "pay" } : null,
    sections: [{ kind: "purchase", purchase }],
    cancel: false,
  };
}

/// The status block's words: a title, one sentence, and the plain lines under them.
export function statusText(view: AccountView, s: Strings, lang: Lang): { title: string; sentence: string | null; lines: string[] } {
  const status = view.status;
  const lines = view.others.map((source) => premiumLine(source, s, lang));
  const date = (iso: string | undefined) => formatDate(iso, lang);
  switch (status.kind) {
    case "lifetime":
      return { title: s.statusLifetime, sentence: s.statusLifetimeBody, lines };
    case "needsAction":
      return { title: s.statusNeedsAction, sentence: s.statusNeedsActionBody(date(status.until)), lines };
    case "paymentFailed":
      return { title: s.statusPaymentFailed, sentence: s.statusPaymentFailedBody(date(status.until)), lines };
    case "active": {
      const amount = typeof status.amount === "number" && status.currency ? formatMoney(status.amount, status.currency, lang) : null;
      const plan = status.plan ? planName(status.plan, s) : null;
      return { title: s.statusOn, sentence: s.statusActiveBody(plan, date(status.renewsAt), amount), lines };
    }
    case "cancelling":
      return { title: s.statusOnUntil(date(status.until)), sentence: s.statusCancellingBody, lines };
    case "storeRenews": {
      const store = storeWords(status.platform, s, lang);
      return { title: s.statusOn, sentence: s.statusStoreBody(store, date(status.renewsAt)), lines: [s.statusStoreManagedThere(store), ...lines] };
    }
    case "endsOnItsOwn": {
      const source = status.source;
      const sentence = isStore(source) ? s.statusFromCancelledStore(storeWords(source.source, s, lang)) : s.statusFromGrant;
      return { title: s.statusOnUntil(date(source.until)), sentence, lines };
    }
    case "ended":
      return { title: s.statusEnded(date(status.endedAt)), sentence: s.statusChoosePlan, lines };
    case "none":
      return { title: s.statusNone, sentence: s.statusChoosePlan, lines };
    case "confirming":
      return { title: s.confirmingTitle, sentence: s.confirmingBody, lines };
  }
}

/// What is said after a load: the message, then the status title unless the message already says it.
export function loadAnnouncement(message: string | undefined, title: string): string {
  if (message && message.includes(title)) return message;
  return [message, `${title}.`].filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------------
// Switching to yearly and upgrading to lifetime

/// The `switch_yearly` request for one press of the confirm button: the total the buyer saw, and
/// the attempt's id, which a repeated press after no answer or an unfinished bank step sends again
/// so the server returns that attempt's outcome instead of charging twice.
export function switchRequest(quote: SwitchQuote, attemptId: string, lang: Lang) {
  return { action: "switch_yearly" as const, acceptedTotal: quote.total, attemptId, lang };
}

/// Whether a failed confirmation keeps its attempt id for the next press: only when the server may
/// already hold the attempt (no answer, or the bank step left open). A decline, a re-price or a
/// refusal ends it, and the next press is a new attempt.
export function keepsAttempt(refusal: Refusal | { kind: "verifyNotCompleted" }): boolean {
  // An incomplete charge was never attempted at the bank, so the next press is a new attempt.
  return refusal.kind === "noAnswer" || refusal.kind === "generic" || refusal.kind === "verifyNotCompleted";
}

export interface SwitchSummary {
  /// Label and value pairs, in the order the panel lists them.
  rows: { label: string; value: string }[];
  /// The sentences under the amounts: renewal, a resumed renewal, no refunds.
  notes: string[];
  confirm: string;
}

/// What the switch panel says for a quote, with every amount and date in the page's formats.
/// The credit sits under a label that says it is taken off, so it carries no minus sign; tax
/// shows only when there is some.
export function switchSummary(quote: SwitchQuote, state: SubscriptionState, s: Strings, lang: Lang): SwitchSummary {
  const money = (cents: number) => formatMoney(cents, quote.currency, lang);
  const yearly = money(quote.amount);
  const total = money(quote.total);
  const date = formatDate(quote.renewsAt, lang);
  const rows: SwitchSummary["rows"] = [
    { label: s.switchYearlyPrice, value: yearly },
    { label: s.switchCredit, value: money(quote.credit) },
  ];
  if (quote.tax > 0) rows.push({ label: s.switchTax, value: money(quote.tax) });
  rows.push({ label: s.switchTotalToday, value: total });
  if (quote.card) rows.push({ label: s.labelCard, value: cardText(quote.card, s, lang) });
  const notes = [s.switchRenews(date, yearly)];
  if (state === "cancelling") notes.push(s.switchResumes);
  notes.push(s.noticeNoRefunds);
  return { rows, notes, confirm: s.switchConfirm(total) };
}

/// The `buy_lifetime` request for one press of the confirm button, as `switchRequest`.
export function lifetimeRequest(quote: LifetimeQuote, attemptId: string, lang: Lang) {
  return { action: "buy_lifetime" as const, acceptedTotal: quote.total, attemptId, lang };
}

/// What the upgrade panel says for a quote: the same rows as the switch panel, with the credit
/// named after the plan it comes from, then what lifetime means, that the subscription stops now
/// and never renews, and no refunds.
export function lifetimeSummary(quote: LifetimeQuote, s: Strings, lang: Lang): SwitchSummary {
  const money = (cents: number) => formatMoney(cents, quote.currency, lang);
  const total = money(quote.total);
  const rows: SwitchSummary["rows"] = [{ label: s.lifetimePrice, value: money(quote.amount) }];
  if (quote.credit > 0) rows.push({ label: s.lifetimeCredit(planName(quote.creditedPlan, s)), value: money(quote.credit) });
  if (quote.tax > 0) rows.push({ label: s.switchTax, value: money(quote.tax) });
  rows.push({ label: s.switchTotalToday, value: total });
  if (quote.card) rows.push({ label: s.labelCard, value: cardText(quote.card, s, lang) });
  return {
    rows,
    notes: [s.lifetimeHint, s.noticeLifetime, s.lifetimeStops(planName(quote.creditedPlan, s)), s.noticeNoRefunds],
    confirm: s.lifetimeConfirm(total),
  };
}
