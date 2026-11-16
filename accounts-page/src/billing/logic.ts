/// What `/subscribe` and `/manage` decide from the callables' answers, kept apart from the DOM and
/// Stripe.js so it can be tested.

import type { Lang, Strings } from "../i18n";

export type Plan = "web_monthly" | "web_yearly" | "web_lifetime";
export const PLANS: readonly Plan[] = ["web_monthly", "web_yearly", "web_lifetime"];

export type StorePlatform = "apple" | "google";
export type Blocker = "store_subscription_active" | "already_subscribed" | "lifetime_active";

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

export function isPlan(value: unknown): value is Plan {
  return typeof value === "string" && (PLANS as readonly string[]).includes(value);
}

export function isRecurring(plan: Plan): boolean {
  return plan !== "web_lifetime";
}

// ---------------------------------------------------------------------------
// Formatting

/// The locale the pages format with: Arabic with Arabic-Indic digits and the Gregorian calendar,
/// matching the page's own copy, or English.
function locale(lang: Lang): string {
  return lang === "ar" ? "ar-u-nu-arab-ca-gregory" : "en";
}

/// An amount in cents as the page shows and speaks it, such as "$4.99". Whole amounts keep their
/// cents, so two prices never look alike.
export function formatMoney(cents: number, currency: string, lang: Lang): string {
  return new Intl.NumberFormat(locale(lang), {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: 2,
  }).format(cents / 100);
}

/// A date from the callables (ISO 8601) in words, such as "14 December 2026", or null when missing
/// or unreadable. Shown in UTC, the time zone Stripe dates its periods in.
export function formatDate(iso: string | undefined, lang: Lang): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return new Intl.DateTimeFormat(locale(lang), { dateStyle: "long", timeZone: "UTC" }).format(new Date(ms));
}

export function storeName(store: StorePlatform, s: Strings): string {
  return store === "apple" ? s.appStoreName : s.playStoreName;
}

export function planName(plan: Plan, s: Strings): string {
  return plan === "web_monthly" ? s.planMonthly : plan === "web_yearly" ? s.planYearly : s.planLifetime;
}

/// Plan names joined as a list in the page's language, such as "Monthly and Yearly".
export function planNames(plans: readonly Plan[], s: Strings, lang: Lang): string {
  return new Intl.ListFormat(lang, { type: "conjunction" }).format(plans.map((plan) => planName(plan, s)));
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

// ---------------------------------------------------------------------------
// /subscribe

/// The plans a purchase can still be made for, in the order the server listed them.
///
/// Lifetime access blocks everything. A web subscription or an auto-renewing store subscription
/// blocks only monthly and yearly: lifetime can still be bought, which cancels the web
/// subscription with no refund.
export function purchasablePlans(response: Pick<PlansResponse, "plans" | "blockers">): PlanOffer[] {
  const blockers = new Set(response.blockers);
  if (blockers.has("lifetime_active")) return [];
  const recurringBlocked = blockers.has("already_subscribed") || blockers.has("store_subscription_active");
  return response.plans.filter((offer) => isPlan(offer.plan) && !(recurringBlocked && isRecurring(offer.plan)));
}

/// What the account already has; a backend older than the page sends no list, read as empty.
export function premiumOf(response: Pick<PlansResponse, "premium">): PremiumSource[] {
  return Array.isArray(response.premium) ? response.premium : [];
}

/// One line of «ما لديك الآن»; `manage` asks for a link to `/manage`, where a failed renewal is
/// paid.
export function premiumLine(source: PremiumSource, s: Strings, lang: Lang): { text: string; manage: boolean } {
  const date = formatDate(source.until, lang);
  switch (source.source) {
    case "web": {
      if (source.kind === "lifetime") return { text: s.premiumWebLifetime, manage: false };
      const plan = source.plan ? planName(source.plan, s) : null;
      if (source.state === "payment_failed" || source.state === "needs_action") {
        return { text: s.premiumWebPaymentFailed(plan), manage: true };
      }
      return { text: source.renews ? s.premiumWebRenews(plan, date) : s.premiumWebCancelling(plan, date), manage: false };
    }
    case "apple":
    case "google": {
      const store = storeName(source.source, s);
      return { text: source.renews ? s.premiumStoreRenews(store, date) : s.premiumStoreCancelling(store, date), manage: false };
    }
    case "manual":
      return { text: s.premiumManual(date), manage: false };
  }
}

/// Why some of the tier's plans cannot be bought, and what unblocks them.
export type BlockedReason =
  | { kind: "lifetime" }
  | { kind: "web" }
  | { kind: "store"; platform: StorePlatform; until?: string };

export interface BlockedPlans {
  plans: Plan[];
  reason: BlockedReason;
}

/// The tier's plans that cannot be bought, grouped by what blocks them, in the order of the
/// checks: lifetime blocks every plan; a web subscription and a renewing store subscription each
/// block monthly and yearly.
export function blockedPlans(response: Pick<PlansResponse, "plans" | "blockers" | "storeSubscription" | "premium">): BlockedPlans[] {
  const blockers = new Set(response.blockers);
  const tier = response.plans.map((offer) => offer.plan).filter(isPlan);
  if (blockers.has("lifetime_active")) return tier.length ? [{ plans: tier, reason: { kind: "lifetime" } }] : [];
  const recurring = tier.filter(isRecurring);
  if (recurring.length === 0) return [];
  const result: BlockedPlans[] = [];
  if (blockers.has("already_subscribed")) result.push({ plans: recurring, reason: { kind: "web" } });
  const store = response.storeSubscription;
  if (blockers.has("store_subscription_active") && store) {
    const until = premiumOf(response).find((source) => source.source === store.platform && source.renews)?.until;
    result.push({ plans: recurring, reason: { kind: "store", platform: store.platform, ...(until ? { until } : {}) } });
  }
  return result;
}

/// What a purchase must be confirmed over: premium from a store or a manual grant; null when
/// nothing needs confirming. `renewingStores` keep charging after the purchase, so the notice
/// says they must be cancelled in the store.
export function confirmationFor(response: Pick<PlansResponse, "premium">): { sources: PremiumSource[]; renewingStores: StorePlatform[] } | null {
  const sources = premiumOf(response).filter((source) => source.source !== "web");
  if (sources.length === 0) return null;
  const renewingStores = sources.flatMap((source) =>
    (source.source === "apple" || source.source === "google") && source.renews ? [source.source] : [],
  );
  return { sources, renewingStores };
}

/// The plan picked when the page opens: yearly when sold, else the first one.
export function defaultPlan(offers: readonly PlanOffer[]): Plan | null {
  return offers.find((offer) => offer.plan === "web_yearly")?.plan ?? offers[0]?.plan ?? null;
}

/// The total the pay button states and `acceptedTotal` carries: the quote's when the server
/// re-priced this plan, else the plan's price.
export function shownTotal(offer: PlanOffer, quote: Quote | null): number {
  return quote && quote.plan === offer.plan ? quote.total : offer.amount;
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
/// `acknowledgeExisting` is sent only once the buyer ticked the confirmation, since a backend
/// older than the page refuses a request with a field it does not know. The key is left out,
/// not set to `undefined`: the callable SDK sends an `undefined` value as `null`.
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
    billingState: options.province || undefined,
    lang: options.lang,
    ...(options.acknowledged ? { acknowledgeExisting: true as const } : {}),
  };
}

/// The `replace_card` request for one press of the save button, with a fresh token for the same
/// reason; an accepted re-price sends the quoted renewal amount.
export function replaceCardRequest(freshTokenId: string, quote: Quote | null) {
  return {
    action: "replace_card" as const,
    confirmationToken: freshTokenId,
    acceptedRenewalAmount: quote?.amount,
  };
}

/// Whether a refusal is answered by asking for the Canadian province: the server wants a province
/// (or postal code) only for a Canadian billing address, and the page can add the province.
export function asksForProvince(refusal: Refusal, billingCountry: string | null): boolean {
  return refusal.kind === "billingAddressIncomplete" && billingCountry === "CA";
}

// ---------------------------------------------------------------------------
// /manage

export interface ManageActions {
  cancel: boolean;
  resume: boolean;
  replaceCard: boolean;
  authenticate: boolean;
  /// A paid-up monthly subscription, cancelled or not, may move to yearly.
  switchYearly: boolean;
  /// No subscription to manage: the page links to `/subscribe`.
  subscribe: boolean;
}

/// The controls `/manage` offers for a state and plan; only states the backend can act on get any.
export function manageActions(state: SubscriptionState, plan?: string): ManageActions {
  return {
    cancel: state === "active" || state === "payment_failed" || state === "needs_action",
    resume: state === "cancelling",
    replaceCard: state === "active" || state === "cancelling" || state === "payment_failed" || state === "needs_action",
    authenticate: state === "needs_action",
    switchYearly: (state === "active" || state === "cancelling") && plan === "web_monthly",
    subscribe: state === "none" || state === "ended",
  };
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

/// The interval a plan renews at, from its id, for `/manage` whose answer has no interval.
export function intervalOf(plan: string | undefined): "month" | "year" | null {
  return plan === "web_monthly" ? "month" : plan === "web_yearly" ? "year" : null;
}

// ---------------------------------------------------------------------------
// /manage: switching to yearly

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
  return refusal.kind === "noAnswer" || refusal.kind === "generic" || refusal.kind === "verifyNotCompleted";
}

export interface SwitchSummary {
  /// Label and value pairs, in the order the panel lists them; `digits` (a card's last four) is
  /// set left to right after the value.
  rows: { label: string; value: string; digits?: string }[];
  /// The sentences under the amounts: renewal, a resumed renewal, no refunds.
  notes: string[];
  confirm: string;
}

/// What the switch panel says for a quote, with every amount and date in the page's formats.
/// The credit is shown as a deduction, and tax only when there is some.
export function switchSummary(quote: SwitchQuote, state: SubscriptionState, s: Strings, lang: Lang): SwitchSummary {
  const money = (cents: number) => formatMoney(cents, quote.currency, lang);
  const yearly = money(quote.amount);
  const total = money(quote.total);
  const date = formatDate(quote.renewsAt, lang);
  const rows: SwitchSummary["rows"] = [
    { label: s.switchYearlyPrice, value: yearly },
    { label: s.switchCredit, value: money(-quote.credit) },
  ];
  if (quote.tax > 0) rows.push({ label: s.switchTax, value: money(quote.tax) });
  rows.push({ label: s.switchTotalToday, value: total });
  if (quote.card) rows.push({ label: s.labelCard, value: s.cardEnding(cardBrandName(quote.card.brand)), digits: quote.card.last4 });
  const notes = [s.switchRenews(date, yearly)];
  if (state === "cancelling") notes.push(s.switchResumes);
  notes.push(s.noticeNoRefunds);
  return { rows, notes, confirm: s.switchConfirm(total) };
}
