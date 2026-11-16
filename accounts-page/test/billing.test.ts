import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  accountView,
  asksForProvince,
  cardBrandName,
  cardText,
  confirmationFor,
  defaultPlan,
  doubleSubscriptionStore,
  elementsKindFor,
  elementsOptions,
  formatDate,
  formatMoney,
  formatMoneyInFull,
  keepsAttempt,
  lifetimeRequest,
  lifetimeSummary,
  keepsPending,
  lifetimePurchaseIn,
  loadAnnouncement,
  payButtonState,
  PENDING_PURCHASE_MS,
  pendingAfterLoad,
  plansDisagree,
  savedPercent,
  storeWords,
  onlyTaxAdded,
  PAYMENT_ELEMENT_OPTIONS,
  payNote,
  premiumLine,
  premiumOf,
  purchasablePlans,
  purchaseRequest,
  refusalFrom,
  replaceCardRequest,
  shownTotal,
  statusText,
  switchRequest,
  switchSummary,
  termsHref,
  termsSentence,
  type AccountView,
  type LifetimeQuote,
  type PlanOffer,
  type PlansAnswer,
  type PlansResponse,
  type PremiumSource,
  type Purchase,
  type Quote,
  type SubscriptionResponse,
  type SwitchQuote,
} from "../src/billing/logic";
import { STRINGS, TERMS_CONTACT, TERMS_UPDATED } from "../src/i18n";
import { routeFor } from "../src/router";

const MONTHLY: PlanOffer = { plan: "web_monthly", amount: 499, currency: "usd", interval: "month" };
const YEARLY: PlanOffer = { plan: "web_yearly", amount: 4999, currency: "usd", interval: "year" };
const LIFETIME: PlanOffer = { plan: "web_lifetime", amount: 14999, currency: "usd", interval: null };
const ALL = [MONTHLY, YEARLY, LIFETIME];
const S_AR = STRINGS.ar;

/// First-strong isolate marks, which every amount and date inside Arabic text carries.
const FSI = "⁨";
const PDI = "⁩";
const iso = (text: string) => `${FSI}${text}${PDI}`;

function httpsError(code: string, details?: Record<string, unknown>, message = "server message") {
  return Object.assign(new Error(message), { code: `functions/${code}`, details });
}

describe("routes", () => {
  it("shows the one account page at both of its addresses", () => {
    expect(routeFor("/subscribe")).toBe("account");
    expect(routeFor("/manage/")).toBe("account");
    expect(routeFor("/Subscribe")).toBe("notFound");
  });

  it("shows the terms at /terms", () => {
    expect(routeFor("/terms")).toBe("terms");
    expect(routeFor("/terms/")).toBe("terms");
    expect(routeFor("/Terms")).toBe("notFound");
  });
});

describe("formatMoney", () => {
  it("formats cents in English with the symbol", () => {
    expect(formatMoney(499, "usd", "en")).toBe("$4.99");
    expect(formatMoney(14999, "usd", "en")).toBe("$149.99");
    expect(formatMoney(5000, "usd", "en")).toBe("$50.00");
  });

  it("writes Arabic as the number then «دولار», isolated, with no symbol", () => {
    expect(formatMoney(499, "usd", "ar")).toBe(iso("٤٫٩٩ دولار"));
    expect(formatMoney(5000, "USD", "ar")).toBe(iso("٥٠٫٠٠ دولار"));
    expect(formatMoney(123450, "usd", "ar")).toBe(iso("١٬٢٣٤٫٥٠ دولار"));
    expect(formatMoney(499, "usd", "ar")).not.toMatch(/[0-9$]|US/);
  });

  it("falls back to the platform's format for another currency, still isolated in Arabic", () => {
    expect(formatMoney(499, "eur", "en")).toBe("€4.99");
    const ar = formatMoney(499, "eur", "ar");
    expect(ar.startsWith(FSI) && ar.endsWith(PDI)).toBe(true);
    expect(ar).toContain("٤٫٩٩");
  });

  it("names the currency in full once, for the note above the pay button", () => {
    expect(formatMoneyInFull(4999, "usd", "ar")).toBe(iso("٤٩٫٩٩ دولار أمريكي"));
    expect(formatMoneyInFull(4999, "usd", "en")).toBe("$49.99 (US dollars)");
    expect(formatMoneyInFull(4999, "eur", "en")).toBe("€49.99 (Euro)");
  });
});

describe("formatDate", () => {
  it("writes the date in words, in UTC, isolated in Arabic", () => {
    expect(formatDate("2026-12-14T23:30:00Z", "en")).toBe("December 14, 2026");
    expect(formatDate("2026-12-14T23:30:00Z", "ar")).toBe(iso("١٤ ديسمبر ٢٠٢٦"));
  });

  it("returns null for a missing or broken date", () => {
    expect(formatDate(undefined, "en")).toBeNull();
    expect(formatDate("not a date", "en")).toBeNull();
  });
});

describe("cards", () => {
  it("names known brands and capitalises others", () => {
    expect(cardBrandName("visa")).toBe("Visa");
    expect(cardBrandName("amex")).toBe("American Express");
    expect(cardBrandName("maestro")).toBe("Maestro");
  });

  it("isolates the brand and the last four digits inside Arabic", () => {
    const card = { brand: "visa", last4: "4242" };
    expect(cardText(card, STRINGS.en, "en")).toBe("Visa ending in 4242");
    expect(cardText(card, STRINGS.ar, "ar")).toBe(`${iso("Visa")} المنتهية بـ ${iso("4242")}`);
  });
});

describe("purchasablePlans", () => {
  it("offers every plan when nothing blocks", () => {
    expect(purchasablePlans({ plans: ALL, blockers: [] })).toEqual(ALL);
  });

  it("offers nothing with lifetime access", () => {
    expect(purchasablePlans({ plans: ALL, blockers: ["lifetime_active"] })).toEqual([]);
  });

  it("keeps lifetime when a store subscription or a failed web renewal blocks the recurring plans", () => {
    expect(purchasablePlans({ plans: ALL, blockers: ["already_subscribed"] })).toEqual([LIFETIME]);
    expect(purchasablePlans({ plans: ALL, blockers: ["store_subscription_active"] })).toEqual([LIFETIME]);
    expect(purchasablePlans({ plans: ALL, blockers: ["already_subscribed"], current: { state: "payment_failed" } })).toEqual([LIFETIME]);
  });

  it("sells no lifetime to a running web subscription, which upgrades instead", () => {
    for (const state of ["active", "cancelling"] as const) {
      expect(purchasablePlans({ plans: ALL, blockers: ["already_subscribed"], current: { state, plan: "web_monthly" } })).toEqual([]);
    }
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

describe("savedPercent", () => {
  it("is the share a year saves against twelve months, rounded down, at the standard and reduced tiers", () => {
    // Standard: 49.99 against 12 × 4.99 = 59.88 saves 16.5%.
    expect(savedPercent([MONTHLY, YEARLY, LIFETIME])).toBe(16);
    // Reduced: 24.99 against 12 × 2.99 = 35.88 saves 30.4%.
    expect(savedPercent([{ ...MONTHLY, amount: 299 }, { ...YEARLY, amount: 2499 }])).toBe(30);
  });

  it("has no badge at the low tier, which sells no monthly plan, or under 5%", () => {
    expect(savedPercent([{ ...YEARLY, amount: 999 }, LIFETIME])).toBe(0);
    expect(savedPercent([MONTHLY, { ...YEARLY, amount: 5700 }])).toBe(0);
    expect(savedPercent([MONTHLY, { ...YEARLY, amount: 5688 }])).toBe(5);
    expect(savedPercent([MONTHLY, { ...YEARLY, amount: 6500 }])).toBe(0);
    expect(savedPercent([MONTHLY])).toBe(0);
  });

  it("says it as a saving in both languages", () => {
    expect(STRINGS.ar.savePercent(16)).toBe("وفّر ١٦٪");
    expect(STRINGS.en.savePercent(16)).toBe("Save 16%");
  });
});

describe("store names in sentences", () => {
  it("English uses each store's own article and preposition", () => {
    expect(storeWords("apple", STRINGS.en, "en")).toEqual({ name: "App Store", a: "an App Store", in: "in the App Store", through: "through the App Store" });
    expect(storeWords("google", STRINGS.en, "en")).toEqual({ name: "Google Play", a: "a Google Play", in: "on Google Play", through: "through Google Play" });
    expect(STRINGS.en.manageInStore(storeWords("apple", STRINGS.en, "en"))).toBe("Manage the subscription in the App Store");
    expect(STRINGS.en.storeAlsoActive(storeWords("apple", STRINGS.en, "en"))).toMatch(/^You also have an App Store subscription .* Turn off its renewal in the App Store,/);
    expect(STRINGS.en.statusStoreManagedThere(storeWords("google", STRINGS.en, "en"))).toBe("It's managed on Google Play, not here.");
    expect(STRINGS.en.storeActiveError(storeWords(null, STRINGS.en, "en"))).toMatch(/^You have a store subscription .* in the store first/);
  });

  it("Arabic uses the name, isolated, everywhere", () => {
    const apple = storeWords("apple", S_AR, "ar");
    expect(apple).toEqual({ name: iso("App Store"), a: iso("App Store"), in: iso("App Store"), through: iso("App Store") });
    expect(S_AR.manageInStore(apple)).toBe(`إدارة الاشتراك في ${iso("App Store")}`);
  });
});

describe("shownTotal and tax", () => {
  const quote: Quote = { plan: "web_yearly", tier: "standard", amount: 4999, tax: 650, total: 5649, currency: "usd", reason: "tax" };

  it("is the plan price without a quote, and the quote's total for the quoted plan only", () => {
    expect(shownTotal(YEARLY, null)).toBe(4999);
    expect(shownTotal(YEARLY, quote)).toBe(5649);
    expect(shownTotal(LIFETIME, quote)).toBe(14999);
  });

  it("presents a re-price as tax only when nothing but tax changed", () => {
    expect(onlyTaxAdded(YEARLY, quote)).toBe(true);
    expect(onlyTaxAdded(YEARLY, { ...quote, amount: 5999 })).toBe(false);
    expect(onlyTaxAdded(YEARLY, { ...quote, reason: "both" })).toBe(false);
    expect(onlyTaxAdded(YEARLY, { ...quote, reason: "price_changed", tax: 0, total: 5999, amount: 5999 })).toBe(false);
  });
});

describe("the note above the pay button", () => {
  it("states the total today with the currency in full, how it renews, and no refunds", () => {
    expect(payNote(YEARLY, 4999, STRINGS.ar, "ar")).toBe(
      `تدفع اليوم ${iso("٤٩٫٩٩ دولار أمريكي")}، ثم يتجدد الاشتراك كل سنة بالمبلغ نفسه حتى تلغيه. لا تُسترد المبالغ المدفوعة.`,
    );
    expect(payNote(MONTHLY, 499, STRINGS.en, "en")).toBe(
      "You pay $4.99 (US dollars) today. It renews every month for the same amount until you cancel. Payments are not refundable.",
    );
    expect(payNote(LIFETIME, 14999, STRINGS.ar, "ar")).toBe(`تدفع اليوم ${iso("١٤٩٫٩٩ دولار أمريكي")} مرة واحدة، ولا يتجدد. لا تُسترد المبالغ المدفوعة.`);
    expect(payNote(LIFETIME, 14999, STRINGS.en, "en")).toBe("You pay $149.99 (US dollars) once, today, and it never renews. Payments are not refundable.");
  });

  it("is followed by one sentence accepting the terms, whose link is the words that name them", () => {
    expect(termsSentence(STRINGS.ar)).toEqual({ before: "بالدفع توافق على ", link: "شروط الاشتراك", after: "." });
    expect(termsSentence(STRINGS.en)).toEqual({ before: "By paying, you accept the ", link: "subscription terms", after: "." });
    expect(termsHref("ar")).toBe("/terms?lang=ar");
    expect(termsHref("en")).toBe("/terms?lang=en");
  });
});

describe("the terms", () => {
  it("has the same eleven numbered clauses in both languages, each with a title and a body", () => {
    for (const lang of ["ar", "en"] as const) {
      const clauses = STRINGS[lang].termsClauses;
      expect(clauses).toHaveLength(11);
      clauses.forEach((clause, index) => {
        const number = lang === "ar" ? (index + 1).toLocaleString("ar-u-nu-arab") : String(index + 1);
        expect(clause.title.startsWith(`${number}. `)).toBe(true);
        expect(clause.body.length).toBeGreaterThan(0);
      });
    }
  });

  it("names the contact address in the first clause, and lifetime as up to 99 years in the seventh", () => {
    expect(TERMS_CONTACT).toBe("mantooq@basira.ca");
    for (const lang of ["ar", "en"] as const) {
      expect(STRINGS[lang].termsClauses[0].body.endsWith(TERMS_CONTACT)).toBe(true);
      expect(STRINGS[lang].termsClauses.filter((clause) => clause.body.includes(TERMS_CONTACT))).toHaveLength(1);
    }
    expect(STRINGS.ar.termsClauses[6].body).toContain("لمدة أقصاها ٩٩ سنة من تاريخ الشراء");
    expect(STRINGS.en.termsClauses[6].body).toContain("up to 99 years from the date of purchase");
  });

  it("dates the last update through the page's date format", () => {
    expect(STRINGS.en.termsUpdated(formatDate(TERMS_UPDATED, "en")!)).toBe("Last updated: November 16, 2026");
    expect(STRINGS.ar.termsUpdated(formatDate(TERMS_UPDATED, "ar")!)).toBe(`آخر تحديث: ${iso("١٦ نوفمبر ٢٠٢٦")}`);
  });

  it("loads no Firebase or Stripe code, so its page needs no other origin", () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
    const seen = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const source = readFileSync(file, "utf8");
      for (const [, spec] of source.matchAll(/^import[^"]*"([^"]+)"/gm)) {
        expect(spec, `${file} imports ${spec}`).not.toMatch(/firebase|stripe/i);
        if (spec.startsWith(".")) visit(resolve(dirname(file), `${spec}.ts`));
      }
    };
    visit(resolve(root, "routes/terms.ts"));
    expect(seen.has(resolve(root, "billing/logic.ts"))).toBe(true);
  });
});

describe("what lifetime means", () => {
  /// Every string the page can show: plain values, and each sentence built with placeholder words.
  function allText(value: unknown): string[] {
    if (typeof value === "string") return [value];
    if (typeof value === "function") return allText(value("X", "X", "X"));
    if (Array.isArray(value)) return value.flatMap(allText);
    if (value && typeof value === "object") return Object.values(value).flatMap(allText);
    return [];
  }

  it("is no longer a number of years anywhere on the page outside the terms", () => {
    for (const lang of ["ar", "en"] as const) {
      const { termsClauses, ...rest } = STRINGS[lang];
      expect(termsClauses.length).toBe(11);
      for (const text of allText(rest)) expect(text).not.toMatch(/\b50\b|٥٠|fifty|خمسين|\b99\b|٩٩|as long as the service|مدة تقديم الخدمة/i);
    }
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
      existing_premium: "existingPremium",
      switch_unavailable: "switchUnavailable",
      lifetime_unavailable: "lifetimeUnavailable",
      switch_incomplete: "chargeIncomplete",
      lifetime_incomplete: "chargeIncomplete",
      purchase_not_found: "purchaseNotFound",
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

describe("requests leave optional keys out", () => {
  const quote: Quote = { plan: "web_yearly", tier: "standard", amount: 4999, tax: 0, total: 4999, currency: "usd", reason: "card_country" };
  const noUndefined = (request: object) => expect(Object.values(request)).not.toContain(undefined);

  it("a purchase sends the token it is given and the plan's price, and no province or acknowledgement until there is one", () => {
    const request = purchaseRequest({ offer: YEARLY, quote: null, freshTokenId: "ctoken_new", province: null, lang: "en" });
    expect(request).toEqual({ plan: "web_yearly", confirmationToken: "ctoken_new", acceptedTotal: 4999, lang: "en" });
    noUndefined(request);
    const empty = purchaseRequest({ offer: YEARLY, quote: null, freshTokenId: "ctoken_x", province: "", lang: "ar", acknowledged: false });
    expect(Object.keys(empty)).not.toContain("billingState");
    expect(Object.keys(empty)).not.toContain("acknowledgeExisting");
  });

  it("a purchase accepts a re-price with a new token and the quote's total", () => {
    const low = { ...YEARLY, amount: 1999 };
    const request = purchaseRequest({ offer: low, quote, freshTokenId: "ctoken_after_quote", province: null, lang: "ar" });
    expect(request.confirmationToken).toBe("ctoken_after_quote");
    expect(request.acceptedTotal).toBe(4999);
  });

  it("a purchase adds the province once asked for, and the acknowledgement once ticked", () => {
    const request = purchaseRequest({ offer: LIFETIME, quote: null, freshTokenId: "ctoken_x", province: "ON", lang: "en", acknowledged: true });
    expect(request).toMatchObject({ billingState: "ON", acknowledgeExisting: true });
    noUndefined(request);
  });

  it("a card change sends a new token, with the quoted renewal amount only once accepted", () => {
    expect(replaceCardRequest("ctoken_a", null)).toEqual({ action: "replace_card", confirmationToken: "ctoken_a" });
    noUndefined(replaceCardRequest("ctoken_a", null));
    expect(replaceCardRequest("ctoken_b", quote)).toEqual({ action: "replace_card", confirmationToken: "ctoken_b", acceptedRenewalAmount: 4999 });
  });

  it("a switch and an upgrade send the shown total and the attempt id", () => {
    const switchQuote: SwitchQuote = { plan: "web_yearly", tier: "standard", amount: 4999, credit: 333, tax: 0, total: 4666, currency: "usd", renewsAt: "2027-11-26T05:40:15.000Z" };
    const lifetimeQuote: LifetimeQuote = { plan: "web_lifetime", tier: "standard", amount: 14999, credit: 2500, tax: 0, total: 12499, currency: "usd", creditedPlan: "web_yearly" };
    expect(switchRequest(switchQuote, "attempt-0001-aaaaaaaa", "ar")).toEqual({ action: "switch_yearly", acceptedTotal: 4666, attemptId: "attempt-0001-aaaaaaaa", lang: "ar" });
    expect(lifetimeRequest(lifetimeQuote, "attempt-0001-aaaaaaaa", "en")).toEqual({ action: "buy_lifetime", acceptedTotal: 12499, attemptId: "attempt-0001-aaaaaaaa", lang: "en" });
    noUndefined(switchRequest(switchQuote, "attempt-0001-aaaaaaaa", "ar"));
    noUndefined(lifetimeRequest(lifetimeQuote, "attempt-0001-aaaaaaaa", "en"));
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

describe("the switch panel", () => {
  const quote: SwitchQuote = {
    plan: "web_yearly", tier: "standard", amount: 4999, credit: 333, tax: 0, total: 4666, currency: "usd",
    renewsAt: "2027-11-26T05:40:15.000Z", card: { brand: "visa", last4: "4242" },
  };

  it("lists the yearly price, the credit with no minus sign, the total today and the card; then renewal and no refunds", () => {
    const summary = switchSummary(quote, "active", STRINGS.en, "en");
    expect(summary.rows).toEqual([
      { label: "Yearly price:", value: "$49.99" },
      { label: "Credit for the days left this month:", value: "$3.33" },
      { label: "Charged today:", value: "$46.66" },
      { label: "Card:", value: "Visa ending in 4242" },
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

  it("in Arabic, the credit after a label that says it is taken off, with no minus sign", () => {
    const summary = switchSummary(quote, "cancelling", STRINGS.ar, "ar");
    expect(summary.rows[1]).toEqual({ label: "خصم الأيام المتبقية من هذا الشهر:", value: iso("٣٫٣٣ دولار") });
    const text = [...summary.rows.map((row) => `${row.label} ${row.value}`), ...summary.notes, summary.confirm].join(" ");
    expect(text).toContain(formatDate(quote.renewsAt, "ar")!);
    expect(text).toContain(STRINGS.ar.switchResumes);
    expect(text).not.toMatch(/-|−|4999|4666|\b333\b|undefined|null|US\$/);
  });

  it("keeps the attempt id only while the server may hold the attempt", () => {
    expect(keepsAttempt({ kind: "noAnswer" })).toBe(true);
    expect(keepsAttempt({ kind: "generic" })).toBe(true);
    expect(keepsAttempt({ kind: "verifyNotCompleted" })).toBe(true);
    expect(keepsAttempt({ kind: "declined", category: "declined" })).toBe(false);
    expect(keepsAttempt({ kind: "purchaseInProgress" })).toBe(false);
    expect(keepsAttempt({ kind: "throttled" })).toBe(false);
    // An incomplete charge never reached the bank: the next press is a new attempt, never a "decline".
    expect(keepsAttempt({ kind: "chargeIncomplete" })).toBe(false);
  });
});

describe("the lifetime upgrade panel", () => {
  const quote: LifetimeQuote = {
    plan: "web_lifetime", tier: "standard", amount: 14999, credit: 2500, tax: 0, total: 12499, currency: "usd",
    creditedPlan: "web_yearly", card: { brand: "visa", last4: "4242" },
  };

  it("lists the lifetime price, the credit of the named plan, the total and the card; then one payment, the stop, no refunds", () => {
    const summary = lifetimeSummary(quote, STRINGS.en, "en");
    expect(summary.rows).toEqual([
      { label: "Lifetime price:", value: "$149.99" },
      { label: "Credit for the unused time of your yearly plan:", value: "$25.00" },
      { label: "Charged today:", value: "$124.99" },
      { label: "Card:", value: "Visa ending in 4242" },
    ]);
    expect(summary.notes).toEqual([
      STRINGS.en.lifetimeHint,
      "Your yearly subscription stops now. It won't renew, and nothing more is charged for it.",
      STRINGS.en.noticeNoRefunds,
    ]);
    expect(summary.confirm).toBe("Pay $124.99 and upgrade to lifetime");
  });

  it("shows tax only when there is some and no credit row for a zero credit; Arabic with no minus sign", () => {
    const taxed = lifetimeSummary({ ...quote, credit: 0, tax: 1200, total: 16199, creditedPlan: "web_monthly" }, STRINGS.en, "en");
    expect(taxed.rows.map((row) => row.label)).toEqual(["Lifetime price:", "Tax:", "Charged today:", "Card:"]);
    const ar = lifetimeSummary(quote, STRINGS.ar, "ar");
    expect(ar.rows[1]).toEqual({ label: "خصم المدة غير المستخدمة من الاشتراك السنوي:", value: iso("٢٥٫٠٠ دولار") });
    const text = [...ar.rows.map((row) => `${row.label} ${row.value}`), ...ar.notes, ar.confirm].join(" ");
    expect(text).toContain("يتوقف اشتراكك السنوي الآن");
    expect(text).not.toMatch(/-|14999|12499|2500|undefined|null/);
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

// ---------------------------------------------------------------------------
// The account view

const NOW = Date.parse("2026-11-16T12:00:00Z");
const RENEWS = "2026-12-14T12:00:00Z";
const ENDS = "2026-12-20T12:00:00Z";
const LATER = "2027-02-01T12:00:00Z";
const PAST = "2026-10-01T12:00:00Z";

const webSource = (fields: Partial<PremiumSource> = {}): PremiumSource => ({ source: "web", kind: "subscription", plan: "web_monthly", state: "active", renews: true, until: RENEWS, ...fields });
const storeSource = (source: "apple" | "google", renews: boolean, until = renews ? RENEWS : ENDS): PremiumSource => ({ source, kind: "subscription", state: renews ? "active" : "cancelling", renews, until });
const grant = (until: string | null = LATER): PremiumSource => ({ source: "manual", kind: "grant", state: "active", renews: false, ...(until ? { until } : {}) });

function plansAnswer(fields: Partial<PlansResponse> = {}): PlansAnswer {
  return {
    plans: {
      publishableKey: "pk_test_x", livemode: false, countryKnown: true, tier: "standard", plans: ALL, taxEnabled: false,
      current: null, storeSubscription: null, blockers: [], premium: [], ...fields,
    },
  };
}

function sub(state: SubscriptionResponse["state"], fields: Partial<SubscriptionResponse> = {}): SubscriptionResponse {
  return { state, storeSubscription: null, premium: [], ...fields };
}

const CARD = { brand: "visa", last4: "4242" };
const S = STRINGS.ar;

/// The page's words for a view in Arabic, as the route renders them.
function words(view: AccountView) {
  return statusText(view, S, "ar");
}

describe("accountView: every state", () => {
  it("web lifetime: no primary, the paying-twice warning when a store still renews", () => {
    const view = accountView(sub("lifetime", { premium: [webSource({ kind: "lifetime", plan: "web_lifetime", renews: false, until: undefined })] }), plansAnswer({ blockers: ["lifetime_active"] }), NOW);
    expect(view).toEqual({ tone: "ok", status: { kind: "lifetime" }, others: [], primary: null, sections: [], cancel: false });
    expect(words(view)).toEqual({ title: "بريميوم مدى الحياة", sentence: "دفعة واحدة، فلا يتجدد ولا يُخصم منك شيء بعدها.", lines: [] });

    const apple = storeSource("apple", true);
    const twice = accountView(sub("lifetime", { storeSubscription: { platform: "apple", autoRenewing: true }, premium: [apple] }), plansAnswer(), NOW);
    expect(twice.sections).toEqual([{ kind: "payingTwice", platform: "apple", lifetime: true }]);
    // The warning names the store, so no line repeats it.
    expect(twice.others).toEqual([]);
  });

  it("web, bank confirmation needed: warn, confirm the payment, the card row and the cancel link", () => {
    const view = accountView(sub("needs_action", { plan: "web_yearly", endsAt: ENDS, card: CARD }), plansAnswer({ blockers: ["already_subscribed"], current: { state: "needs_action" } }), NOW);
    expect(view).toEqual({
      tone: "warn",
      status: { kind: "needsAction", until: ENDS },
      others: [],
      primary: { kind: "confirmPayment" },
      sections: [{ kind: "card", card: CARD }],
      cancel: true,
    });
    expect(words(view)).toEqual({
      title: "يطلب مصرفك تأكيد دفعة التجديد",
      sentence: `يبقى بريميوم مفعّلًا حتى ${iso("٢٠ ديسمبر ٢٠٢٦")}. أكّد الدفعة ليستمر بعد ذلك.`,
      lines: [],
    });
  });

  it("web, payment failed: warn, change the card, lifetime instead as a quiet control, the cancel link", () => {
    const view = accountView(sub("payment_failed", { plan: "web_monthly", endsAt: ENDS, card: CARD }), plansAnswer({ blockers: ["already_subscribed"], current: { state: "payment_failed" } }), NOW);
    expect(view.tone).toBe("warn");
    expect(view.primary).toEqual({ kind: "changeCard" });
    expect(view.cancel).toBe(true);
    expect(view.sections).toEqual([
      { kind: "lifetimeInstead", purchase: { offers: [LIFETIME], unavailable: null, unknownCountry: false, savedPercent: 16, confirm: null } },
    ]);
    expect(words(view)).toEqual({
      title: "لم تنجح دفعة التجديد",
      sentence: `يبقى بريميوم مفعّلًا حتى ${iso("٢٠ ديسمبر ٢٠٢٦")}. غيّر البطاقة لتحتفظ به.`,
      lines: [],
    });
    // With sales off the lifetime purchase is left out, and managing still works.
    const salesOff = accountView(sub("payment_failed", { endsAt: ENDS }), { refusal: { kind: "salesDisabled" } }, NOW);
    expect(salesOff.sections).toEqual([]);
    expect(salesOff.primary).toEqual({ kind: "changeCard" });
  });

  it("web, active: no primary; the card row, upgrades by plan, and the cancel link", () => {
    const monthly = accountView(sub("active", { plan: "web_monthly", amount: 499, currency: "usd", renewsAt: RENEWS, card: CARD }), plansAnswer({ blockers: ["already_subscribed"], current: { state: "active", plan: "web_monthly" } }), NOW);
    expect(monthly).toEqual({
      tone: "ok",
      status: { kind: "active", plan: "web_monthly", renewsAt: RENEWS, amount: 499, currency: "usd" },
      others: [],
      primary: null,
      sections: [{ kind: "card", card: CARD }, { kind: "upgrade", yearly: true, lifetime: true }],
      cancel: true,
    });
    expect(words(monthly)).toEqual({
      title: "بريميوم مفعّل",
      sentence: `اشتراكك الشهري يتجدد في ${iso("١٤ ديسمبر ٢٠٢٦")} بمبلغ ${iso("٤٫٩٩ دولار")}.`,
      lines: [],
    });
    expect(statusText(monthly, STRINGS.en, "en").sentence).toBe("Your monthly plan renews on December 14, 2026 for $4.99.");

    const yearly = accountView(sub("active", { plan: "web_yearly", renewsAt: RENEWS }), plansAnswer(), NOW);
    expect(yearly.sections).toEqual([{ kind: "card" }, { kind: "upgrade", yearly: false, lifetime: true }]);
  });

  it("web, active, with a store that also renews: the paying-twice warning first", () => {
    const view = accountView(
      sub("active", { plan: "web_yearly", renewsAt: RENEWS, storeSubscription: { platform: "google", autoRenewing: true }, premium: [webSource({ plan: "web_yearly" }), storeSource("google", true)] }),
      plansAnswer(),
      NOW,
    );
    expect(view.sections[0]).toEqual({ kind: "payingTwice", platform: "google", lifetime: false });
    expect(view.others).toEqual([]);
  });

  it("web, cancelled and still running: on until the date, resume, the card row and upgrades, no cancel link", () => {
    const view = accountView(sub("cancelling", { plan: "web_monthly", endsAt: ENDS, card: CARD }), plansAnswer(), NOW);
    expect(view).toEqual({
      tone: "ok",
      status: { kind: "cancelling", until: ENDS },
      others: [],
      primary: { kind: "resume" },
      sections: [{ kind: "card", card: CARD }, { kind: "upgrade", yearly: true, lifetime: true }],
      cancel: false,
    });
    expect(words(view)).toEqual({
      title: `بريميوم مفعّل حتى ${iso("٢٠ ديسمبر ٢٠٢٦")}`,
      sentence: "التجديد متوقف، فلن يُخصم منك شيء بعد الآن.",
      lines: [],
    });
    // With sales off there is nothing to upgrade to.
    expect(accountView(sub("cancelling", { plan: "web_monthly", endsAt: ENDS }), { refusal: { kind: "salesDisabled" } }, NOW).sections).toEqual([{ kind: "card" }]);
  });

  it("no web subscription, a store subscription renews: a link to the store, then how to pay by card here", () => {
    const apple = storeSource("apple", true);
    const view = accountView(
      sub("none", { storeSubscription: { platform: "apple", autoRenewing: true }, premium: [apple] }),
      plansAnswer({ blockers: ["store_subscription_active"], storeSubscription: { platform: "apple", autoRenewing: true }, premium: [apple] }),
      NOW,
    );
    const lifetime: Purchase = { offers: [LIFETIME], unavailable: null, unknownCountry: false, savedPercent: 16, confirm: { renewingStores: ["apple"] } };
    expect(view).toEqual({
      tone: "ok",
      status: { kind: "storeRenews", platform: "apple", renewsAt: RENEWS },
      others: [],
      primary: { kind: "manageInStore", platform: "apple" },
      sections: [{ kind: "payByCard", platform: "apple", until: RENEWS, lifetime }],
      cancel: false,
    });
    expect(words(view)).toEqual({
      title: "بريميوم مفعّل",
      sentence: `اشتراكك عبر ${iso("App Store")} يتجدد في ${iso("١٤ ديسمبر ٢٠٢٦")}.`,
      lines: [`يُدار هذا الاشتراك من ${iso("App Store")}، لا من هنا.`],
    });
    // Sales off: only the store link; nothing on this page sells.
    expect(accountView(sub("none", { premium: [apple] }), { refusal: { kind: "salesDisabled" } }, NOW).sections).toEqual([]);
  });

  it("no web subscription, premium that ends on its own: on until the date, then the purchase with its confirmation first", () => {
    const google = storeSource("google", false);
    const view = accountView(sub("none", { premium: [google] }), plansAnswer({ premium: [google] }), NOW);
    expect(view).toEqual({
      tone: "ok",
      status: { kind: "endsOnItsOwn", source: google },
      others: [],
      primary: null,
      sections: [{ kind: "continueAfter", purchase: { offers: ALL, unavailable: null, unknownCountry: false, savedPercent: 16, confirm: { renewingStores: [] } } }],
      cancel: false,
    });
    expect(words(view)).toEqual({
      title: `بريميوم مفعّل حتى ${iso("٢٠ ديسمبر ٢٠٢٦")}`,
      sentence: `من اشتراكك عبر ${iso("Google Play")}، وقد أوقفت تجديده.`,
      lines: [],
    });
    const granted = accountView(sub("ended", { endsAt: PAST, premium: [grant()] }), plansAnswer({ premium: [grant()] }), NOW);
    expect(granted.status).toEqual({ kind: "endsOnItsOwn", source: grant() });
    expect(words(granted)).toEqual({ title: `بريميوم مفعّل حتى ${iso("١ فبراير ٢٠٢٧")}`, sentence: "فعّله لك فريق منطوق.", lines: [] });
  });

  it("web ended, no other premium: neutral, the pay button, the purchase", () => {
    const view = accountView(sub("ended", { endsAt: PAST }), plansAnswer(), NOW);
    expect(view).toEqual({
      tone: "neutral",
      status: { kind: "ended", endedAt: PAST },
      others: [],
      primary: { kind: "pay" },
      sections: [{ kind: "purchase", purchase: { offers: ALL, unavailable: null, unknownCountry: false, savedPercent: 16, confirm: null } }],
      cancel: false,
    });
    expect(words(view)).toEqual({ title: `انتهى اشتراكك في ${iso("١ أكتوبر ٢٠٢٦")}`, sentence: "اختر خطة من الخطط أدناه.", lines: [] });
  });

  it("nothing: neutral, choose a plan", () => {
    const view = accountView(sub("none"), plansAnswer({ countryKnown: false }), NOW);
    expect(view.status).toEqual({ kind: "none" });
    expect(view.primary).toEqual({ kind: "pay" });
    expect(view.sections).toEqual([{ kind: "purchase", purchase: { offers: ALL, unavailable: null, unknownCountry: true, savedPercent: 16, confirm: null } }]);
    expect(words(view)).toEqual({ title: "ليس لديك بريميوم", sentence: "اختر خطة من الخطط أدناه.", lines: [] });
  });

  it("a refused plans call replaces only the plans, with one reason and no pay button", () => {
    for (const kind of ["salesDisabled", "emailUnverified", "noAnswer"] as const) {
      const view = accountView(sub("none"), { refusal: { kind } }, NOW);
      expect(view.primary).toBeNull();
      expect(view.sections).toEqual([{ kind: "purchase", purchase: { offers: [], unavailable: kind, unknownCountry: false, savedPercent: 0, confirm: null } }]);
    }
    expect(accountView(sub("none"), { refusal: { kind: "throttled" } }, NOW).sections[0]).toMatchObject({ purchase: { unavailable: "generic" } });
  });

  it("the same page whichever address opened it: the view depends on the answers alone", () => {
    const answers = [sub("active", { plan: "web_monthly" }), plansAnswer()] as const;
    expect(accountView(...answers, NOW)).toEqual(accountView(...answers, NOW));
  });
});

describe("accountView: two sources at once", () => {
  const apple = storeSource("apple", true);
  const appleOff = storeSource("apple", false);
  const google = storeSource("google", true);
  const googleOff = storeSource("google", false, LATER);

  it("a renewing store is described first; the other source follows as a plain line", () => {
    const view = accountView(sub("none", { premium: [apple, grant()] }), plansAnswer({ premium: [apple, grant()] }), NOW);
    expect(view.status).toEqual({ kind: "storeRenews", platform: "apple", renewsAt: RENEWS });
    expect(view.others).toEqual([grant()]);
    expect(words(view).lines).toEqual([`يُدار هذا الاشتراك من ${iso("App Store")}، لا من هنا.`, `بريميوم من فريق منطوق حتى ${iso("١ فبراير ٢٠٢٧")}.`]);
  });

  it("with nothing renewing, the source that ends last is described", () => {
    const view = accountView(sub("none", { premium: [appleOff, googleOff] }), plansAnswer({ premium: [appleOff, googleOff] }), NOW);
    expect(view.status).toEqual({ kind: "endsOnItsOwn", source: googleOff });
    expect(words(view).lines).toEqual([`اشتراك عبر ${iso("App Store")}، تجديده متوقف، ويبقى بريميوم حتى ${iso("٢٠ ديسمبر ٢٠٢٦")}.`]);
    // A grant with no end lasts longest.
    const forever = grant(null);
    expect(accountView(sub("none", { premium: [googleOff, forever] }), plansAnswer(), NOW).status).toEqual({ kind: "endsOnItsOwn", source: forever });
  });

  it("two renewing stores: the first is described, the second is a line", () => {
    const view = accountView(sub("none", { premium: [apple, google] }), plansAnswer({ premium: [apple, google] }), NOW);
    expect(view.status).toMatchObject({ kind: "storeRenews", platform: "apple" });
    expect(view.others).toEqual([google]);
  });

  it("this site's subscription with a store or a grant: the web state is the status, the other a line", () => {
    const view = accountView(sub("active", { plan: "web_yearly", premium: [webSource({ plan: "web_yearly" }), appleOff] }), plansAnswer(), NOW);
    expect(view.status.kind).toBe("active");
    expect(view.others).toEqual([appleOff]);
    const cancelling = accountView(sub("cancelling", { plan: "web_yearly", premium: [webSource({ renews: false }), grant()] }), plansAnswer(), NOW);
    expect(cancelling.others).toEqual([grant()]);
    expect(words(cancelling).lines).toEqual([`بريميوم من فريق منطوق حتى ${iso("١ فبراير ٢٠٢٧")}.`]);
  });

  it("lifetime with a cancelled store: no warning, the store as a line", () => {
    const view = accountView(sub("lifetime", { premium: [appleOff] }), plansAnswer(), NOW);
    expect(view.sections).toEqual([]);
    expect(view.others).toEqual([appleOff]);
  });

  it("a source that ended before now is not counted", () => {
    const stale = grant(PAST);
    expect(accountView(sub("none", { premium: [stale] }), plansAnswer(), NOW).status).toEqual({ kind: "none" });
  });

  it("an older backend with no list: a renewing store it reports apart still sends the user to the store", () => {
    const view = accountView({ state: "none", storeSubscription: { platform: "google", autoRenewing: true } }, plansAnswer({ premium: undefined }), NOW);
    expect(view.status).toEqual({ kind: "storeRenews", platform: "google", renewsAt: undefined });
    expect(premiumOf({})).toEqual([]);
    expect(confirmationFor({})).toBeNull();
  });
});

describe("premium lines and confirmation", () => {
  it("writes one line per store or grant, with the date in words", () => {
    expect(premiumLine(storeSource("apple", true), STRINGS.en, "en")).toBe("Subscription through the App Store, renews on December 14, 2026.");
    expect(premiumLine(storeSource("google", false), STRINGS.en, "en")).toBe("Subscription through Google Play, renewal off; Premium stays on until December 20, 2026.");
    expect(premiumLine(grant(), STRINGS.en, "en")).toBe("Premium from the Mantooq team until February 1, 2027.");
    expect(premiumLine(grant(), S, "ar")).not.toMatch(/[0-9]/);
  });

  it("asks for confirmation over a store subscription or a grant, never over this site's own", () => {
    expect(confirmationFor({ premium: [webSource()] })).toBeNull();
    expect(confirmationFor({ premium: [grant()] })).toEqual({ renewingStores: [] });
    expect(confirmationFor({ premium: [webSource(), storeSource("apple", false)] })).toEqual({ renewingStores: [] });
    expect(confirmationFor({ premium: [storeSource("google", true), grant()] })).toEqual({ renewingStores: ["google"] });
  });
});

describe("a purchase the account does not show yet", () => {
  const PENDING = { purchaseId: "p".repeat(32), plan: "web_yearly" as const, at: NOW - 60_000 };

  it("is remembered while the account shows nothing from this site, for fifteen minutes", () => {
    expect(pendingAfterLoad(PENDING, { state: "none" }, NOW)).toEqual(PENDING);
    expect(pendingAfterLoad(PENDING, { state: "ended" }, NOW)).toEqual(PENDING);
    expect(pendingAfterLoad({ ...PENDING, at: NOW - PENDING_PURCHASE_MS }, { state: "none" }, NOW)).toBeNull();
    expect(pendingAfterLoad(null, { state: "none" }, NOW)).toBeNull();
  });

  it("is forgotten once the account shows premium from this site", () => {
    for (const state of ["active", "cancelling", "payment_failed", "needs_action", "lifetime"] as const) {
      expect(pendingAfterLoad(PENDING, { state }, NOW)).toBeNull();
    }
  });

  it("while remembered, the page says it is being confirmed, offers only to check again, and sells nothing", () => {
    for (const state of ["none", "ended"] as const) {
      const view = accountView(sub(state, { endsAt: PAST }), plansAnswer(), NOW, PENDING);
      expect(view).toEqual({ tone: "neutral", status: { kind: "confirming" }, others: [], primary: { kind: "checkAgain" }, sections: [], cancel: false });
      expect(words(view)).toEqual({ title: "الدفع قيد التأكيد", sentence: "لا حاجة إلى دفع شيء آخر. قد يستغرق التأكيد بضع دقائق.", lines: [] });
    }
    // Premium from elsewhere does not bring the purchase back either.
    const google = storeSource("google", false);
    expect(accountView(sub("none", { premium: [google] }), plansAnswer({ premium: [google] }), NOW, PENDING).sections).toEqual([]);
    // Once the account shows it, the page is the subscription's own.
    expect(accountView(sub("active", { plan: "web_yearly" }), plansAnswer(), NOW, PENDING).status.kind).toBe("active");
    // After fifteen minutes the purchase is offered again.
    expect(accountView(sub("none"), plansAnswer(), NOW, { ...PENDING, at: NOW - PENDING_PURCHASE_MS }).primary).toEqual({ kind: "pay" });
  });

  it("a lifetime purchase over a failed renewal stays confirming until the account is lifetime", () => {
    const lifetime = { ...PENDING, plan: "web_lifetime" as const };
    for (const state of ["payment_failed", "needs_action"] as const) {
      expect(pendingAfterLoad(lifetime, { state }, NOW)).toEqual(lifetime);
      const view = accountView(sub(state, { endsAt: ENDS }), plansAnswer({ blockers: ["already_subscribed"], current: { state } }), NOW, lifetime);
      expect(view.status).toEqual({ kind: "confirming" });
      expect(view.sections).toEqual([]);
      // A subscription bought then is not what a failed renewal is waiting for.
      expect(pendingAfterLoad(PENDING, { state }, NOW)).toBeNull();
    }
    expect(pendingAfterLoad(lifetime, { state: "lifetime" }, NOW)).toBeNull();
    expect(accountView(sub("lifetime"), plansAnswer(), NOW, lifetime).status).toEqual({ kind: "lifetime" });
  });

  it("check again: kept while paid, confirming or unanswered; forgotten when it failed or does not exist", () => {
    expect(keepsPending("succeeded")).toBe(true);
    expect(keepsPending("pending")).toBe(true);
    expect(keepsPending("noAnswer")).toBe(true);
    expect(keepsPending("failed")).toBe(false);
    expect(keepsPending("notFound")).toBe(false);
  });
});

describe("the two answers disagreeing", () => {
  it("asks for the plans again when one call says subscribed and the other none or ended", () => {
    expect(plansDisagree({ state: "ended" }, { current: { state: "active" }, blockers: ["already_subscribed"] })).toBe(true);
    expect(plansDisagree({ state: "none" }, { current: null, blockers: ["lifetime_active"] })).toBe(true);
    expect(plansDisagree({ state: "active" }, { current: null, blockers: [] })).toBe(true);
    expect(plansDisagree({ state: "lifetime" }, { current: { state: "ended" }, blockers: [] })).toBe(true);
  });

  it("leaves agreeing answers alone, a store blocker included", () => {
    expect(plansDisagree({ state: "ended" }, { current: { state: "ended" }, blockers: [] })).toBe(false);
    expect(plansDisagree({ state: "none" }, { current: null, blockers: ["store_subscription_active"] })).toBe(false);
    expect(plansDisagree({ state: "payment_failed" }, { current: { state: "payment_failed" }, blockers: ["already_subscribed"] })).toBe(false);
  });
});

describe("a refused plans call where management goes on", () => {
  const unverified: PlansAnswer = { refusal: { kind: "emailUnverified" } };

  it("store renews: the store link and the instruction, without the lifetime button", () => {
    const apple = storeSource("apple", true);
    const view = accountView(sub("none", { premium: [apple] }), unverified, NOW);
    expect(view.primary).toEqual({ kind: "manageInStore", platform: "apple" });
    expect(view.sections).toEqual([{ kind: "payByCard", platform: "apple", until: RENEWS, lifetime: null }]);
  });

  it("payment failed: the card change and cancel stay, lifetime instead is left out", () => {
    const view = accountView(sub("payment_failed", { endsAt: ENDS }), unverified, NOW);
    expect(view.primary).toEqual({ kind: "changeCard" });
    expect(view.sections).toEqual([]);
    expect(view.cancel).toBe(true);
  });
});

describe("the pay button", () => {
  const base = { busy: false, cardReady: true, waitingForTick: false, errorId: null, quote: false };

  it("is enabled and described by its note when ready", () => {
    expect(payButtonState(base)).toEqual({ disabled: false, describedBy: "pay-note" });
  });

  it("waits for the tick, described by the notice that explains it", () => {
    expect(payButtonState({ ...base, waitingForTick: true })).toEqual({ disabled: true, describedBy: "existing-notice pay-note" });
  });

  it("is disabled while busy or loading the card form, and carries an error and a quote", () => {
    expect(payButtonState({ ...base, busy: true }).disabled).toBe(true);
    expect(payButtonState({ ...base, cardReady: false }).disabled).toBe(true);
    expect(payButtonState({ ...base, errorId: "pay-error-text", quote: true }).describedBy).toBe("pay-error-text quote pay-note");
  });
});

describe("the lifetime panel after an existing_premium refusal", () => {
  it("is offered again in the same place after the reload, with its confirmation", () => {
    const apple = storeSource("apple", true);
    const before = accountView(sub("none", { premium: [apple] }), plansAnswer({ premium: [apple] }), NOW);
    const grantAdded = [apple, grant()];
    const after = accountView(sub("none", { premium: grantAdded }), plansAnswer({ premium: grantAdded }), NOW);
    expect(lifetimePurchaseIn(before, "payByCard")?.offers).toEqual([LIFETIME]);
    expect(lifetimePurchaseIn(after, "payByCard")?.confirm).toEqual({ renewingStores: ["apple"] });
    // A state with no such section offers no panel to reopen.
    expect(lifetimePurchaseIn(accountView(sub("active"), plansAnswer(), NOW), "payByCard")).toBeNull();
    const failed = accountView(sub("payment_failed", { endsAt: ENDS }), plansAnswer({ premium: [grant()] }), NOW);
    expect(lifetimePurchaseIn(failed, "lifetimeInstead")?.confirm).toEqual({ renewingStores: [] });
  });
});

describe("the announcement after a load", () => {
  it("adds the status title only when the message does not already say it", () => {
    expect(loadAnnouncement("أصبح لديك بريميوم مدى الحياة.", "بريميوم مدى الحياة")).toBe("أصبح لديك بريميوم مدى الحياة.");
    expect(loadAnnouncement("عاد التجديد التلقائي.", "بريميوم مفعّل")).toBe("عاد التجديد التلقائي. بريميوم مفعّل.");
    expect(loadAnnouncement(undefined, "ليس لديك بريميوم")).toBe("ليس لديك بريميوم.");
  });
});
