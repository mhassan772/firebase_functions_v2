// Billing emails without Firestore: which emails a slot change calls for, the card expiry rule,
// and every template in both languages. The outbox, the trigger points and the sender run
// against the emulator in test/integration/billingEmails.test.js.
const assert = require("node:assert/strict");
const { describe, test } = require("node:test");
const { Timestamp } = require("firebase-admin/firestore");
const { cardExpiresBefore, decideSlotEmails, outboxData } = require("../lib/services/webSubscriptions/billingEmails");
const {
  BillingEmailIncompleteError,
  formatDate,
  formatMoney,
  renderBillingEmail,
} = require("../lib/services/email/billingEmailTemplates");

const NOW = new Date(Date.UTC(2026, 10, 15, 12));
const DAY = 24 * 60 * 60 * 1000;
const at = (days) => Timestamp.fromMillis(NOW.getTime() + days * DAY);

function slot(status, web = {}, extra = {}) {
  return {
    status,
    active: !["expired", "revoked", "billing_retry"].includes(status),
    productId: "web_yearly",
    expiresAt: status === "grace_period" ? at(5) : at(300),
    web: {
      customerId: "cus_1",
      subscriptionId: "sub_1",
      purchaseId: "p1",
      lastPaidInvoiceId: "in_1",
      paidThrough: at(300),
      cancelAtPeriodEnd: false,
      needsAction: false,
      paymentFailed: false,
      ...web,
    },
    ...extra,
  };
}

const entry = (purchaseId, plan, lang = "en", extra = {}) => ({
  purchaseId, uid: "u1", plan, amount: 4999, tax: 0, total: 4999, currency: "usd", lang, status: "paid",
  stripe: { customerId: "cus_1", subscriptionId: plan === "web_lifetime" ? undefined : "sub_1", invoiceId: "in_1" }, ...extra,
});

function notice({ previous, next, becamePaid = [], entries, subscription } = {}) {
  return {
    uid: "u1",
    livemode: false,
    operationId: "op",
    now: NOW,
    previous,
    next,
    becamePaid,
    entries: entries ?? [entry("p1", "web_yearly", "en", { status: "paid" })],
    subscription,
  };
}

const kinds = (emails) => emails.map((email) => `${email.kind}:${email.id}`);

describe("decideSlotEmails", () => {
  test("a first payment queues purchase_confirmed with its breakdown, renewal date and language", () => {
    const paid = entry("p1", "web_yearly", "en", { tax: 650, total: 5649 });
    const emails = decideSlotEmails(notice({ next: slot("active"), becamePaid: [paid] }));
    assert.deepEqual(kinds(emails), ["purchase_confirmed:confirmed_p1"]);
    assert.equal(emails[0].lang, "en");
    assert.deepEqual(emails[0].fields, {
      plan: "web_yearly", amount: 4999, tax: 650, total: 5649, currency: "usd", renewsAt: at(300).toDate(),
    });
    const lifetime = decideSlotEmails(notice({ next: slot("active", { subscriptionId: undefined }, { productId: "web_lifetime" }), becamePaid: [entry("p2", "web_lifetime", "ar")] }));
    assert.equal(lifetime[0].lang, "ar");
    assert.equal(lifetime[0].fields.renewsAt, undefined);
  });

  test("a paid plan switch queues switched_yearly with its credit, never purchase_confirmed, renewed or anything for the renewal it turned back on", () => {
    const switched = entry("p2", "web_yearly", "ar", { kind: "switch", switchedFrom: "web_monthly", amount: 4999, credit: 333, total: 4666 });
    const previous = slot("canceled", { purchaseId: "p1", lastPaidInvoiceId: "in_1", paidThrough: at(20), cancelAtPeriodEnd: true }, { productId: "web_monthly" });
    const next = slot("active", { purchaseId: "p2", lastPaidInvoiceId: "in_2", paidThrough: at(365) });
    const facts = { id: "sub_1", latestPaid: { id: "in_2", billingReason: "subscription_update", amountPaid: 4666, currency: "usd" } };
    const emails = decideSlotEmails(notice({ previous, next, becamePaid: [switched], subscription: facts, entries: [entry("p1", "web_monthly"), switched] }));
    assert.deepEqual(kinds(emails), ["switched_yearly:switched_p2"]);
    assert.equal(emails[0].lang, "ar");
    assert.deepEqual(emails[0].fields, {
      plan: "web_yearly", amount: 4999, credit: 333, tax: 0, total: 4666, currency: "usd", renewsAt: at(365).toDate(),
    });
  });

  test("an upgrade to lifetime queues purchase_confirmed with its credit and the stopped plan, and nothing for the stopped subscription", () => {
    const upgrade = entry("p3", "web_lifetime", "en", { kind: "upgrade", switchedFrom: "web_yearly", amount: 14999, credit: 2500, total: 12499 });
    const previous = slot("active", { purchaseId: "p1" });
    const next = slot("active", { subscriptionId: undefined, purchaseId: "p3", lastPaidInvoiceId: "in_3" }, { productId: "web_lifetime" });
    const emails = decideSlotEmails(notice({ previous, next, becamePaid: [upgrade], entries: [entry("p1", "web_yearly"), upgrade] }));
    assert.deepEqual(kinds(emails), ["purchase_confirmed:confirmed_p3"]);
    assert.deepEqual(emails[0].fields, {
      plan: "web_lifetime", amount: 14999, tax: 0, total: 12499, currency: "usd", credit: 2500, creditedPlan: "web_yearly",
    });
  });

  test("renewed only for a subscription_cycle invoice on the same subscription", () => {
    const previous = slot("active");
    const next = slot("active", { lastPaidInvoiceId: "in_2", paidThrough: at(665) });
    const renewal = { id: "sub_1", latestPaid: { id: "in_2", billingReason: "subscription_cycle", amountPaid: 4999, currency: "usd" } };
    const emails = decideSlotEmails(notice({ previous, next, subscription: renewal }));
    assert.deepEqual(kinds(emails), ["renewed:renewed_in_2"]);
    assert.equal(emails[0].fields.amount, 4999);
    assert.deepEqual(emails[0].fields.renewsAt, at(665).toDate());
    const notCycle = { ...renewal, latestPaid: { ...renewal.latestPaid, billingReason: "subscription_update" } };
    assert.deepEqual(decideSlotEmails(notice({ previous, next, subscription: notCycle })), []);
    assert.deepEqual(decideSlotEmails(notice({ previous: slot("active", { subscriptionId: "sub_0" }), next, subscription: renewal })), [], "another subscription");
  });

  test("payment_failed when paymentFailed turns on, with the grace end; action_required instead when the bank wants confirmation", () => {
    const previous = slot("active");
    const failed = slot("grace_period", { paymentFailed: true });
    const open = { id: "sub_1", latestOpen: { id: "in_9", billingReason: "subscription_cycle" } };
    const emails = decideSlotEmails(notice({ previous, next: failed, subscription: open }));
    assert.deepEqual(kinds(emails), ["payment_failed:failed_in_9"]);
    assert.deepEqual(emails[0].fields.graceEndsAt, at(5).toDate());
    const action = decideSlotEmails(notice({ previous, next: slot("grace_period", { paymentFailed: true, needsAction: true }), subscription: open }));
    assert.deepEqual(kinds(action), ["action_required:action_in_9"]);
    assert.deepEqual(decideSlotEmails(notice({ previous: failed, next: failed, subscription: open })), [], "no change, no email");
    const past = slot("billing_retry", { paymentFailed: true }, { expiresAt: at(-1) });
    assert.deepEqual(decideSlotEmails(notice({ previous, next: past, subscription: open })), [], "the grace is over");
  });

  test("no action_required for a first purchase (subscription_create)", () => {
    const open = { id: "sub_1", latestOpen: { id: "in_1", billingReason: "subscription_create" } };
    const next = slot("grace_period", { paymentFailed: true, needsAction: true });
    assert.deepEqual(decideSlotEmails(notice({ previous: slot("active"), next, subscription: open })), []);
  });

  test("cancellation_confirmed when cancelAtPeriodEnd turns on", () => {
    const emails = decideSlotEmails(notice({ previous: slot("active"), next: slot("canceled", { cancelAtPeriodEnd: true }) }));
    assert.deepEqual(kinds(emails), [`cancellation_confirmed:cancelled_sub_1_${Math.floor(at(300).toMillis() / 1000)}`]);
    assert.deepEqual(emails[0].fields.endsAt, at(300).toDate());
  });

  test("nothing for a refund or a dispute, or for a slot rebuilt without a previous one", () => {
    assert.deepEqual(decideSlotEmails(notice({ previous: slot("active"), next: slot("revoked") })), []);
    assert.deepEqual(decideSlotEmails(notice({ previous: undefined, next: slot("canceled", { cancelAtPeriodEnd: true }) })), []);
  });

  test("the outbox document holds dates as timestamps and no address", () => {
    const data = outboxData({ id: "x", uid: "u1", kind: "renewed", lang: "ar", livemode: false, fields: { renewsAt: NOW, amount: 499 } }, NOW);
    assert.ok(data.renewsAt instanceof Timestamp);
    assert.equal(data.status, "queued");
    assert.equal(data.attempts, 0);
    assert.equal(data.expiresAt.toMillis(), NOW.getTime() + 90 * DAY);
    assert.ok(!("email" in data));
  });
});

describe("cardExpiresFirst", () => {
  test("a card stops at the end of its expiry month", () => {
    const renewal = new Date(Date.UTC(2027, 2, 10));
    assert.equal(cardExpiresBefore(2, 2027, renewal), true, "expires end of February, renews 10 March");
    assert.equal(cardExpiresBefore(3, 2027, renewal), false, "valid through 31 March");
    assert.equal(cardExpiresBefore(12, 2030, renewal), false);
    assert.equal(cardExpiresBefore(undefined, undefined, renewal), false);
  });
});

describe("templates", () => {
  const date = new Date(Date.UTC(2026, 11, 14));
  const content = {
    plan: "web_yearly", amount: 4999, tax: 650, total: 5649, currency: "usd",
    renewsAt: date, endsAt: date, graceEndsAt: date, cardExpiresFirst: true, livemode: true,
  };
  const all = ["purchase_confirmed", "renewed", "payment_failed", "payment_failed_final", "action_required", "renewal_reminder", "cancellation_confirmed", "switched_yearly"];

  test("every kind renders in both languages, with the manage button and no placeholder or raw cents", () => {
    for (const kind of all) {
      for (const lang of ["ar", "en"]) {
        for (const plan of kind === "purchase_confirmed" ? ["web_monthly", "web_yearly", "web_lifetime"] : ["web_yearly"]) {
          const email = renderBillingEmail(kind, lang, { ...content, plan, credit: 333 });
          for (const part of [email.subject, email.text, email.html]) {
            assert.doesNotMatch(part, /undefined|NaN|null|\{|\$\{|\u0000/, `${kind}/${lang}`);
            assert.doesNotMatch(part, /4999|5649|\b650\b|\b333\b/, `${kind}/${lang}: raw cents`);
          }
          assert.ok(email.text.includes(`https://accounts.mantooq.com/manage?lang=${lang}`), `${kind}/${lang}: button`);
          assert.ok(!email.subject.startsWith("[TEST]"));
        }
      }
    }
  });

  test("what each email must say", () => {
    const en = (kind, extra = {}) => renderBillingEmail(kind, "en", { ...content, ...extra }).text;
    const ar = (kind, extra = {}) => renderBillingEmail(kind, "ar", { ...content, ...extra }).text;
    assert.match(en("purchase_confirmed"), /Plan: Yearly[\s\S]*Price: \$49\.99[\s\S]*Tax: \$6\.50[\s\S]*Total: \$56\.49[\s\S]*Next renewal: December 14, 2026/);
    assert.match(en("purchase_confirmed"), /renews automatically until you cancel[\s\S]*version 90\.7[\s\S]*not refundable[\s\S]*cancel the renewal/);
    assert.match(en("purchase_confirmed", { plan: "web_lifetime", tax: 0, total: 4999 }), /one payment[\s\S]*50 years/);
    assert.doesNotMatch(en("purchase_confirmed", { tax: 0, total: 4999 }), /Tax:/, "no tax line when there is none");
    assert.match(ar("purchase_confirmed", { plan: "web_lifetime" }), /الخطة: مدى الحياة[\s\S]*٥٠ سنة/);
    assert.match(ar("purchase_confirmed"), /١٤ ديسمبر ٢٠٢٦/, "Arabic month name");
    assert.match(en("renewed"), /Amount paid: \$49\.99[\s\S]*Next renewal: December 14, 2026/);
    assert.match(en("payment_failed"), /didn't go through[\s\S]*until December 14, 2026[\s\S]*Replace the card[\s\S]*try your current card again/);
    assert.match(en("payment_failed_final"), /stops on December 14, 2026 unless you replace the card/);
    assert.match(en("action_required"), /bank[\s\S]*manage page[\s\S]*stops on December 14, 2026/);
    assert.match(en("renewal_reminder"), /renews automatically on December 14, 2026 for \$56\.49[\s\S]*cancel it on the manage page before that date[\s\S]*expires before that date/);
    assert.doesNotMatch(en("renewal_reminder", { cardExpiresFirst: false }), /expires/);
    assert.match(en("cancellation_confirmed"), /won't renew[\s\S]*until December 14, 2026[\s\S]*resume/);
    const upgrade = { plan: "web_lifetime", amount: 14999, credit: 2500, tax: 0, total: 12499, creditedPlan: "web_yearly" };
    assert.match(en("purchase_confirmed", upgrade),
      /for life[\s\S]*Plan: Lifetime[\s\S]*Price: \$149\.99[\s\S]*unused time of your yearly plan: \$25\.00[\s\S]*Total: \$124\.99[\s\S]*yearly subscription has stopped[\s\S]*50 years/);
    assert.doesNotMatch(en("purchase_confirmed", upgrade), /Next renewal|renews automatically/);
    assert.match(en("purchase_confirmed", { ...upgrade, creditedPlan: "web_monthly", credit: 0, total: 14999 }), /monthly subscription has stopped/);
    assert.doesNotMatch(en("purchase_confirmed", { ...upgrade, credit: 0, total: 14999 }), /unused time/, "no credit line for a zero credit");
    assert.match(ar("purchase_confirmed", upgrade), /خصم المدة غير المستخدمة من اشتراكك السنوي: [\s\S]*توقف اشتراكك السنوي/);
    assert.doesNotMatch(ar("purchase_confirmed", upgrade), /14999|12499|2500|undefined|null/);
    assert.doesNotMatch(en("purchase_confirmed", { plan: "web_lifetime", tax: 0, total: 14999 }), /stopped|unused/, "a plain lifetime purchase is unchanged");
    const switched = { credit: 333, tax: 0, total: 4666 };
    assert.match(en("switched_yearly", switched),
      /to the yearly plan[\s\S]*starts on the day you switched[\s\S]*Plan: Yearly[\s\S]*Yearly price: \$49\.99[\s\S]*unused days of your monthly plan: \$3\.33[\s\S]*Amount paid: \$46\.66[\s\S]*Next renewal: December 14, 2026[\s\S]*every year[\s\S]*until you cancel[\s\S]*not refundable/);
    assert.doesNotMatch(en("switched_yearly", switched), /Tax:/, "no tax line when there is none");
    assert.match(en("switched_yearly", { credit: 333, tax: 650, total: 5316 }), /Tax: \$6\.50[\s\S]*Amount paid: \$53\.16/);
    assert.match(ar("switched_yearly", switched), /الخطة: سنوي[\s\S]*السعر السنوي: [\s\S]*خصم الأيام المتبقية من الاشتراك الشهري: [\s\S]*المبلغ المدفوع: [\s\S]*١٤ ديسمبر ٢٠٢٦[\s\S]*كل سنة[\s\S]*لا تُسترد/);
    assert.equal(renderBillingEmail("switched_yearly", "en", { ...content, ...switched }).subject, "Your Mantooq Premium subscription is now yearly");
    assert.ok(renderBillingEmail("switched_yearly", "ar", { ...content, ...switched, livemode: false }).subject.startsWith("[TEST] "));
    assert.throws(() => renderBillingEmail("switched_yearly", "en", { ...content, credit: undefined }),
      (error) => error instanceof BillingEmailIncompleteError && error.field === "credit");
  });

  test("a sandbox email's subject starts with [TEST]; a missing field refuses to render", () => {
    assert.ok(renderBillingEmail("renewed", "ar", { ...content, livemode: false }).subject.startsWith("[TEST] "));
    assert.throws(() => renderBillingEmail("payment_failed", "en", { ...content, graceEndsAt: undefined }),
      (error) => error instanceof BillingEmailIncompleteError && error.field === "graceEndsAt");
  });

  test("money and dates as the pages show them", () => {
    assert.equal(formatMoney(499, "usd", "en"), "$4.99");
    assert.equal(formatMoney(14999, "usd", "ar"), "١٤٩٫٩٩ دولار");
    assert.equal(formatMoney(123450, "USD", "ar"), "١٬٢٣٤٫٥٠ دولار");
    assert.equal(formatMoney(5000, "usd", "en"), "$50.00");
    assert.doesNotMatch(formatMoney(499, "usd", "ar"), /[0-9$]|US/);
    assert.equal(formatMoney(499, "eur", "en"), "€4.99");
    assert.equal(formatDate(date, "en"), "December 14, 2026");
    assert.equal(formatDate(date, "ar"), "١٤ ديسمبر ٢٠٢٦");
  });
});
