import { describe, expect, it } from "vitest";

import {
  asksForProvince,
  cardBrandName,
  defaultPlan,
  doubleSubscriptionStore,
  elementsKindFor,
  elementsOptions,
  formatDate,
  formatMoney,
  intervalOf,
  manageActions,
  PAYMENT_ELEMENT_OPTIONS,
  purchasablePlans,
  purchaseRequest,
  refusalFrom,
  replaceCardRequest,
  shownTotal,
  type PlanOffer,
  type Quote,
} from "../src/billing/logic";
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
    expect(manageActions("active")).toEqual({ cancel: true, resume: false, replaceCard: true, authenticate: false, subscribe: false });
    expect(manageActions("cancelling")).toEqual({ cancel: false, resume: true, replaceCard: true, authenticate: false, subscribe: false });
    expect(manageActions("payment_failed")).toEqual({ cancel: true, resume: false, replaceCard: true, authenticate: false, subscribe: false });
    expect(manageActions("needs_action")).toEqual({ cancel: true, resume: false, replaceCard: true, authenticate: true, subscribe: false });
    expect(manageActions("lifetime")).toEqual({ cancel: false, resume: false, replaceCard: false, authenticate: false, subscribe: false });
    expect(manageActions("ended")).toEqual({ cancel: false, resume: false, replaceCard: false, authenticate: false, subscribe: true });
    expect(manageActions("none")).toEqual({ cancel: false, resume: false, replaceCard: false, authenticate: false, subscribe: true });
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
