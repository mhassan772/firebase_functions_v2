import { describe, expect, it } from "vitest";

import {
  asksForProvince,
  blockedPlans,
  cardBrandName,
  confirmationFor,
  defaultPlan,
  doubleSubscriptionStore,
  elementsKindFor,
  elementsOptions,
  formatDate,
  formatMoney,
  intervalOf,
  keepsAttempt,
  manageActions,
  PAYMENT_ELEMENT_OPTIONS,
  planNames,
  premiumLine,
  premiumOf,
  purchasablePlans,
  purchaseRequest,
  refusalFrom,
  replaceCardRequest,
  shownTotal,
  switchRequest,
  switchSummary,
  type PlanOffer,
  type PlansResponse,
  type PremiumSource,
  type Quote,
  type SwitchQuote,
} from "../src/billing/logic";
import { STRINGS } from "../src/i18n";
import { routeFor } from "../src/router";

const MONTHLY: PlanOffer = { plan: "web_monthly", amount: 499, currency: "usd", interval: "month" };
const YEARLY: PlanOffer = { plan: "web_yearly", amount: 4999, currency: "usd", interval: "year" };
const LIFETIME: PlanOffer = { plan: "web_lifetime", amount: 14999, currency: "usd", interval: null };
const ALL = [MONTHLY, YEARLY, LIFETIME];

function httpsError(code: string, details?: Record<string, unknown>, message = "server message") {
  return Object.assign(new Error(message), { code: `functions/${code}`, details });
}

describe("routes", () => {
  it("knows the purchase pages", () => {
    expect(routeFor("/subscribe")).toBe("subscribe");
    expect(routeFor("/manage/")).toBe("manage");
    expect(routeFor("/Subscribe")).toBe("notFound");
  });
});

describe("formatMoney", () => {
  it("formats cents in English", () => {
    expect(formatMoney(499, "usd", "en")).toBe("$4.99");
    expect(formatMoney(14999, "usd", "en")).toBe("$149.99");
  });

  it("keeps the cents of a whole amount", () => {
    expect(formatMoney(5000, "usd", "en")).toBe("$50.00");
  });

  it("uses Arabic-Indic digits in Arabic", () => {
    const text = formatMoney(1999, "usd", "ar");
    expect(text).toContain("١٩");
    expect(text).toContain("٩٩");
    expect(text).not.toMatch(/[0-9]/);
  });
});

describe("formatDate", () => {
  it("writes the date in words, in UTC", () => {
    expect(formatDate("2026-12-14T23:30:00Z", "en")).toBe("December 14, 2026");
    expect(formatDate("2026-12-14T23:30:00Z", "ar")).toContain("ديسمبر");
  });

  it("returns null for a missing or broken date", () => {
    expect(formatDate(undefined, "en")).toBeNull();
    expect(formatDate("not a date", "en")).toBeNull();
  });
});

describe("cardBrandName", () => {
  it("names known brands and capitalises others", () => {
    expect(cardBrandName("visa")).toBe("Visa");
    expect(cardBrandName("amex")).toBe("American Express");
    expect(cardBrandName("maestro")).toBe("Maestro");
  });
});

describe("purchasablePlans", () => {
  it("offers every plan when nothing blocks", () => {
    expect(purchasablePlans({ plans: ALL, blockers: [] })).toEqual(ALL);
  });

  it("offers nothing with lifetime access", () => {
    expect(purchasablePlans({ plans: ALL, blockers: ["lifetime_active"] })).toEqual([]);
  });

  it("keeps lifetime when a web or store subscription blocks the recurring plans", () => {
    expect(purchasablePlans({ plans: ALL, blockers: ["already_subscribed"] })).toEqual([LIFETIME]);
    expect(purchasablePlans({ plans: ALL, blockers: ["store_subscription_active"] })).toEqual([LIFETIME]);
  });

  it("drops plans it does not know", () => {
    const unknown = { plan: "web_weekly", amount: 1, currency: "usd", interval: "week" } as unknown as PlanOffer;
    expect(purchasablePlans({ plans: [unknown, YEARLY], blockers: [] })).toEqual([YEARLY]);
  });
});

describe("defaultPlan", () => {
  it("picks yearly, else the first plan", () => {
    expect(defaultPlan(ALL)).toBe("web_yearly");
    expect(defaultPlan([LIFETIME])).toBe("web_lifetime");
    expect(defaultPlan([])).toBeNull();
  });
});

describe("shownTotal", () => {
  const quote: Quote = { plan: "web_yearly", tier: "standard", amount: 4999, tax: 650, total: 5649, currency: "usd", reason: "tax" };

  it("is the plan price without a quote", () => {
    expect(shownTotal(YEARLY, null)).toBe(4999);
  });

  it("is the quote's total for the quoted plan only", () => {
    expect(shownTotal(YEARLY, quote)).toBe(5649);
    expect(shownTotal(LIFETIME, quote)).toBe(14999);
  });
});

describe("elements options", () => {
  it("uses subscription mode for recurring plans and payment mode for lifetime", () => {
    expect(elementsKindFor("web_monthly")).toBe("subscription");
    expect(elementsKindFor("web_yearly")).toBe("subscription");
    expect(elementsKindFor("web_lifetime")).toBe("payment");
  });

  it("asks for off-session tokens for subscriptions and card replacement, and none for lifetime", () => {
    expect(elementsOptions("subscription", 499, "USD")).toMatchObject({ mode: "subscription", amount: 499, currency: "usd", setupFutureUsage: "off_session" });
    expect(elementsOptions("setup", 0, "usd")).toMatchObject({ mode: "setup", setupFutureUsage: "off_session" });
    expect(elementsOptions("setup", 0, "usd")).not.toHaveProperty("amount");
    expect(elementsOptions("payment", 14999, "usd")).toMatchObject({ mode: "payment", amount: 14999, setupFutureUsage: null });
  });

  it("allows cards only, created by hand, in every mode", () => {
    for (const kind of ["subscription", "payment", "setup"] as const) {
      expect(elementsOptions(kind, 1, "usd")).toMatchObject({ allowedPaymentMethodTypes: ["card"], paymentMethodCreation: "manual" });
    }
  });

  it("keeps Link out of the Payment Element and collects the billing address", () => {
    expect(PAYMENT_ELEMENT_OPTIONS.wallets.link).toBe("never");
    expect(PAYMENT_ELEMENT_OPTIONS.fields.billingDetails.address).toBe("auto");
  });
});

describe("refusalFrom", () => {
  it("maps each decline category", () => {
    for (const category of ["declined", "insufficient_funds", "expired_card", "incorrect_details", "authentication_failed"]) {
      expect(refusalFrom(httpsError("failed-precondition", { reason: "card_declined", category }))).toEqual({ kind: "declined", category });
    }
    expect(refusalFrom(httpsError("failed-precondition", { reason: "card_declined", category: "new" }))).toEqual({ kind: "declined", category: "declined" });
  });

  it("maps the purchase refusals", () => {
    const cases: Record<string, string> = {
      sales_disabled: "salesDisabled",
      email_unverified: "emailUnverified",
      plan_unavailable: "planUnavailable",
      billing_address_incomplete: "billingAddressIncomplete",
      already_subscribed: "alreadySubscribed",
      lifetime_active: "lifetimeActive",
      token_invalid: "tokenInvalid",
      card_required: "cardRequired",
      no_subscription: "noSubscription",
      no_action_required: "noActionRequired",
      purchase_in_progress: "purchaseInProgress",
      something_new: "generic",
    };
    for (const [reason, kind] of Object.entries(cases)) {
      expect(refusalFrom(httpsError("failed-precondition", { reason })).kind).toBe(kind);
    }
  });

  it("carries the store of a store subscription", () => {
    expect(refusalFrom(httpsError("failed-precondition", { reason: "store_subscription_active", platform: "google" }))).toEqual({
      kind: "storeSubscriptionActive",
      platform: "google",
    });
    expect(refusalFrom(httpsError("failed-precondition", { reason: "store_subscription_active" }))).toEqual({
      kind: "storeSubscriptionActive",
      platform: null,
    });
  });

  it("maps the throttle", () => {
    expect(refusalFrom(httpsError("resource-exhausted", { reason: "throttled", limit: "uid" }))).toEqual({ kind: "throttled" });
  });

  it("tells no answer apart from the server's own failure", () => {
    expect(refusalFrom(httpsError("internal", undefined, "internal")).kind).toBe("noAnswer");
    expect(refusalFrom(httpsError("internal", undefined, "internal [0]")).kind).toBe("noAnswer");
    expect(refusalFrom(httpsError("unavailable")).kind).toBe("noAnswer");
    expect(refusalFrom(httpsError("deadline-exceeded")).kind).toBe("noAnswer");
    expect(refusalFrom(httpsError("internal", undefined, "Something failed.")).kind).toBe("generic");
  });

  it("signs out when the backend sees no usable sign-in or a deleted account", () => {
    expect(refusalFrom(httpsError("unauthenticated")).kind).toBe("signedOut");
    expect(refusalFrom(httpsError("permission-denied", { reason: "account_deleted" })).kind).toBe("accountDeleted");
  });

  it("never fails on odd errors", () => {
    expect(refusalFrom(undefined).kind).toBe("generic");
    expect(refusalFrom("text").kind).toBe("generic");
    expect(refusalFrom(new Error("x")).kind).toBe("generic");
  });
});

describe("purchaseRequest", () => {
  const quote: Quote = { plan: "web_yearly", tier: "standard", amount: 4999, tax: 0, total: 4999, currency: "usd", reason: "card_country" };

  it("sends the token it is given and the plan's price", () => {
    expect(purchaseRequest({ offer: YEARLY, quote: null, freshTokenId: "ctoken_new", province: null, lang: "en" })).toEqual({
      plan: "web_yearly",
      confirmationToken: "ctoken_new",
      acceptedTotal: 4999,
      billingState: undefined,
      lang: "en",
    });
  });

  it("accepts a re-price with a new token and the quote's total", () => {
    const low = { ...YEARLY, amount: 1999 };
    const request = purchaseRequest({ offer: low, quote, freshTokenId: "ctoken_after_quote", province: "", lang: "ar" });
    expect(request.confirmationToken).toBe("ctoken_after_quote");
    expect(request.acceptedTotal).toBe(4999);
    expect(request.billingState).toBeUndefined();
  });

  it("adds the province once asked for", () => {
    expect(purchaseRequest({ offer: YEARLY, quote: null, freshTokenId: "ctoken_x", province: "ON", lang: "en" }).billingState).toBe("ON");
  });
});

describe("replaceCardRequest", () => {
  it("sends a new token, with the quoted renewal amount once accepted", () => {
    expect(replaceCardRequest("ctoken_a", null)).toEqual({ action: "replace_card", confirmationToken: "ctoken_a", acceptedRenewalAmount: undefined });
    const quote: Quote = { plan: "web_yearly", tier: "standard", amount: 4999, tax: 0, total: 4999, currency: "usd", reason: "card_country" };
    expect(replaceCardRequest("ctoken_b", quote)).toEqual({ action: "replace_card", confirmationToken: "ctoken_b", acceptedRenewalAmount: 4999 });
  });
});

describe("manageActions", () => {
  it("offers what each state allows", () => {
    const none = { switchYearly: false };
    expect(manageActions("active")).toEqual({ cancel: true, resume: false, replaceCard: true, authenticate: false, subscribe: false, ...none });
    expect(manageActions("cancelling")).toEqual({ cancel: false, resume: true, replaceCard: true, authenticate: false, subscribe: false, ...none });
    expect(manageActions("payment_failed")).toEqual({ cancel: true, resume: false, replaceCard: true, authenticate: false, subscribe: false, ...none });
    expect(manageActions("needs_action")).toEqual({ cancel: true, resume: false, replaceCard: true, authenticate: true, subscribe: false, ...none });
    expect(manageActions("lifetime")).toEqual({ cancel: false, resume: false, replaceCard: false, authenticate: false, subscribe: false, ...none });
    expect(manageActions("ended")).toEqual({ cancel: false, resume: false, replaceCard: false, authenticate: false, subscribe: true, ...none });
    expect(manageActions("none")).toEqual({ cancel: false, resume: false, replaceCard: false, authenticate: false, subscribe: true, ...none });
  });

  it("offers the switch to yearly only on a paid-up monthly plan, cancelled or not", () => {
    expect(manageActions("active", "web_monthly").switchYearly).toBe(true);
    expect(manageActions("cancelling", "web_monthly").switchYearly).toBe(true);
    for (const state of ["payment_failed", "needs_action", "ended", "none", "lifetime"] as const) {
      expect(manageActions(state, "web_monthly").switchYearly).toBe(false);
    }
    expect(manageActions("active", "web_yearly").switchYearly).toBe(false);
    expect(manageActions("active").switchYearly).toBe(false);
  });
});

describe("the switch panel", () => {
  const quote: SwitchQuote = {
    plan: "web_yearly", tier: "standard", amount: 4999, credit: 333, tax: 0, total: 4666, currency: "usd",
    renewsAt: "2027-11-26T05:40:15.000Z", card: { brand: "visa", last4: "4242" },
  };

  it("lists the yearly price, the credit as a deduction, the total today and the card; then renewal and no refunds", () => {
    const summary = switchSummary(quote, "active", STRINGS.en, "en");
    expect(summary.rows).toEqual([
      { label: "Yearly price:", value: "$49.99" },
      { label: "Credit for the days left this month:", value: "-$3.33" },
      { label: "Charged today:", value: "$46.66" },
      { label: "Card:", value: "Visa ending in", digits: "4242" },
    ]);
    expect(summary.notes).toEqual([
      "It renews automatically on November 26, 2027, then every year at $49.99, until you cancel.",
      STRINGS.en.noticeNoRefunds,
    ]);
    expect(summary.confirm).toBe("Pay $46.66 and switch to yearly");
  });

  it("shows tax only when there is some, and says a cancelled renewal is turned back on", () => {
    const taxed = switchSummary({ ...quote, tax: 650, total: 5316 }, "cancelling", STRINGS.en, "en");
    expect(taxed.rows.map((row) => row.label)).toEqual(["Yearly price:", "Credit for the days left this month:", "Tax:", "Charged today:", "Card:"]);
    expect(taxed.rows[2].value).toBe("$6.50");
    expect(taxed.notes).toContain(STRINGS.en.switchResumes);
    expect(switchSummary(quote, "active", STRINGS.en, "en").notes).not.toContain(STRINGS.en.switchResumes);
    const noCard = switchSummary({ ...quote, card: undefined }, "active", STRINGS.en, "en");
    expect(noCard.rows.map((row) => row.label)).not.toContain("Card:");
  });

  it("in Arabic, money and the date through the page's formats, with no raw cents", () => {
    const summary = switchSummary(quote, "cancelling", STRINGS.ar, "ar");
    const text = [...summary.rows.map((row) => `${row.label} ${row.value}`), ...summary.notes, summary.confirm].join(" ");
    expect(text).toContain(formatMoney(4999, "usd", "ar"));
    expect(text).toContain(formatMoney(-333, "usd", "ar"));
    expect(text).toContain(formatDate(quote.renewsAt, "ar")!);
    expect(text).toContain(STRINGS.ar.switchResumes);
    expect(text).not.toMatch(/4999|4666|\b333\b|undefined|null/);
  });

  it("each confirmation sends the shown total and its attempt id", () => {
    expect(switchRequest(quote, "attempt-0001-aaaaaaaa", "ar")).toEqual({ action: "switch_yearly", acceptedTotal: 4666, attemptId: "attempt-0001-aaaaaaaa", lang: "ar" });
  });

  it("keeps the attempt id only while the server may hold the attempt", () => {
    expect(keepsAttempt({ kind: "noAnswer" })).toBe(true);
    expect(keepsAttempt({ kind: "generic" })).toBe(true);
    expect(keepsAttempt({ kind: "verifyNotCompleted" })).toBe(true);
    expect(keepsAttempt({ kind: "declined", category: "declined" })).toBe(false);
    expect(keepsAttempt({ kind: "purchaseInProgress" })).toBe(false);
    expect(keepsAttempt({ kind: "throttled" })).toBe(false);
  });

  it("reads switch_unavailable, whatever its cause", () => {
    expect(refusalFrom({ code: "functions/failed-precondition", details: { reason: "switch_unavailable", cause: "payment_due" } })).toEqual({ kind: "switchUnavailable" });
  });

  it("the purchase page names the switch among what the manage page does", () => {
    expect(STRINGS.en.blockerSubscribed).toMatch(/monthly to yearly/);
    expect(STRINGS.ar.blockerSubscribed).toMatch(/السنوي/);
  });
});

describe("doubleSubscriptionStore", () => {
  const renewing = { platform: "apple" as const, autoRenewing: true };

  it("warns while both renew", () => {
    expect(doubleSubscriptionStore({ state: "active", storeSubscription: renewing })).toBe("apple");
    expect(doubleSubscriptionStore({ state: "lifetime", storeSubscription: renewing })).toBe("apple");
    expect(doubleSubscriptionStore({ state: "payment_failed", storeSubscription: { platform: "google", autoRenewing: true } })).toBe("google");
  });

  it("stays quiet when one of them no longer renews", () => {
    expect(doubleSubscriptionStore({ state: "cancelling", storeSubscription: renewing })).toBeNull();
    expect(doubleSubscriptionStore({ state: "ended", storeSubscription: renewing })).toBeNull();
    expect(doubleSubscriptionStore({ state: "active", storeSubscription: { platform: "apple", autoRenewing: false } })).toBeNull();
    expect(doubleSubscriptionStore({ state: "active", storeSubscription: null })).toBeNull();
  });
});

describe("intervalOf", () => {
  it("reads the interval from the plan id", () => {
    expect(intervalOf("web_monthly")).toBe("month");
    expect(intervalOf("web_yearly")).toBe("year");
    expect(intervalOf("web_lifetime")).toBeNull();
    expect(intervalOf(undefined)).toBeNull();
  });
});

describe("asksForProvince", () => {
  it("asks only for a Canadian billing address the server found incomplete", () => {
    expect(asksForProvince({ kind: "billingAddressIncomplete" }, "CA")).toBe(true);
    expect(asksForProvince({ kind: "billingAddressIncomplete" }, "US")).toBe(false);
    expect(asksForProvince({ kind: "billingAddressIncomplete" }, null)).toBe(false);
    expect(asksForProvince({ kind: "generic" }, "CA")).toBe(false);
  });
});

describe("existing premium", () => {
  const s = STRINGS.en;
  const ar = STRINGS.ar;
  const UNTIL = "2026-12-14T12:00:00Z";
  const web = (fields: Partial<PremiumSource> = {}): PremiumSource => ({ source: "web", kind: "subscription", plan: "web_monthly", state: "active", renews: true, until: UNTIL, ...fields });
  const store = (source: "apple" | "google", renews: boolean): PremiumSource => ({ source, kind: "subscription", state: renews ? "active" : "cancelling", renews, until: UNTIL });
  const manual: PremiumSource = { source: "manual", kind: "grant", state: "active", renews: false, until: UNTIL };
  const plansWith = (fields: Partial<PlansResponse>) => ({ plans: ALL, blockers: [], storeSubscription: null, ...fields });

  it("reads a missing list, from an older backend, as empty", () => {
    expect(premiumOf({})).toEqual([]);
    expect(confirmationFor({})).toBeNull();
  });

  it("writes one line per source, with the date in words", () => {
    const line = (source: PremiumSource) => premiumLine(source, s, "en");
    expect(line(web())).toEqual({ text: "Monthly subscription from this site, renews on December 14, 2026.", manage: false });
    expect(line(web({ plan: "web_yearly", state: "cancelling", renews: false })).text).toBe(
      "Yearly subscription from this site, cancelled; Premium stays on until December 14, 2026.",
    );
    expect(line(web({ state: "payment_failed" }))).toEqual({ text: "Monthly subscription from this site: the renewal payment didn't go through.", manage: true });
    expect(line(web({ state: "needs_action" })).manage).toBe(true);
    expect(line({ source: "web", kind: "lifetime", plan: "web_lifetime", state: "active", renews: false }).text).toBe("Lifetime access from this site.");
    expect(line(store("apple", true)).text).toBe("Subscription through App Store, renews on December 14, 2026.");
    expect(line(store("google", false)).text).toBe("Subscription through Google Play, cancelled; Premium stays on until December 14, 2026.");
    expect(line(manual).text).toBe("Premium activated by the Mantooq team, until December 14, 2026.");
    expect(premiumLine(manual, ar, "ar").text).toContain("ديسمبر");
    expect(premiumLine(manual, ar, "ar").text).not.toMatch(/[0-9]/);
  });

  it("names each blocked plan with its reason", () => {
    expect(blockedPlans(plansWith({}))).toEqual([]);
    expect(blockedPlans(plansWith({ blockers: ["lifetime_active"] }))).toEqual([{ plans: ["web_monthly", "web_yearly", "web_lifetime"], reason: { kind: "lifetime" } }]);
    expect(blockedPlans(plansWith({ blockers: ["already_subscribed"], premium: [web()] }))).toEqual([{ plans: ["web_monthly", "web_yearly"], reason: { kind: "web" } }]);
    expect(
      blockedPlans(plansWith({ blockers: ["store_subscription_active"], storeSubscription: { platform: "google", autoRenewing: true }, premium: [store("google", true)] })),
    ).toEqual([{ plans: ["web_monthly", "web_yearly"], reason: { kind: "store", platform: "google", until: UNTIL } }]);
    expect(
      blockedPlans({ plans: [YEARLY, LIFETIME], blockers: ["store_subscription_active"], storeSubscription: { platform: "apple", autoRenewing: true } }),
    ).toEqual([{ plans: ["web_yearly"], reason: { kind: "store", platform: "apple" } }]);
    expect(planNames(["web_monthly", "web_yearly"], s, "en")).toBe("Monthly and Yearly");
  });

  it("asks for confirmation over a store subscription or a manual grant, never over this site's own", () => {
    expect(confirmationFor({ premium: [web()] })).toBeNull();
    expect(confirmationFor({ premium: [web({ kind: "lifetime", plan: "web_lifetime", renews: false })] })).toBeNull();
    expect(confirmationFor({ premium: [manual] })).toEqual({ sources: [manual], renewingStores: [] });
    expect(confirmationFor({ premium: [web(), store("apple", false)] })).toEqual({ sources: [store("apple", false)], renewingStores: [] });
    expect(confirmationFor({ premium: [store("google", true), manual] })).toEqual({ sources: [store("google", true), manual], renewingStores: ["google"] });
  });

  it("sends acknowledgeExisting only once ticked, and reads the server's refusal", () => {
    const base = { offer: LIFETIME, quote: null, freshTokenId: "ctoken_new", province: null, lang: "en" as const };
    // The key itself must be absent: the callable SDK would send an `undefined` value as `null`.
    expect(Object.keys(purchaseRequest(base))).not.toContain("acknowledgeExisting");
    expect(Object.keys(purchaseRequest({ ...base, acknowledged: false }))).not.toContain("acknowledgeExisting");
    expect(purchaseRequest({ ...base, acknowledged: true }).acknowledgeExisting).toBe(true);
    expect(refusalFrom(httpsError("failed-precondition", { reason: "existing_premium", premium: [manual] }))).toEqual({ kind: "existingPremium" });
  });
});
