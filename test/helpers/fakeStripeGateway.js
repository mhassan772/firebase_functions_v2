// An in-memory Stripe for the web subscription tests: the StripeGateway interface in
// src/services/webSubscriptions/stripeGateway.ts, over objects shaped like the ones stripe-node
// returns for API 2026-10-28.endive (see the facts file in Mantooq_Mobile). It models enough of
// customers, subscriptions, invoices, payments, charges, refunds, disputes and events for the
// purchase and entitlement paths; scenario helpers set up states that take Stripe days to reach.
const crypto = require("node:crypto");

const DAY = 24 * 60 * 60;

const DEFAULT_PRICES = {
  web_monthly_standard: ["web_monthly", 499, "month"],
  web_monthly_reduced: ["web_monthly", 399, "month"],
  web_yearly_standard: ["web_yearly", 4999, "year"],
  web_yearly_reduced: ["web_yearly", 3999, "year"],
  web_yearly_low: ["web_yearly", 1999, "year"],
  web_lifetime_standard: ["web_lifetime", 14999, null],
  web_lifetime_reduced: ["web_lifetime", 11999, null],
  web_lifetime_low: ["web_lifetime", 5999, null],
};

function stripeError(code, message, type = "invalid_request_error") {
  return Object.assign(new Error(message), { type, code, rawType: type });
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

/**
 * @param {{ livemode?: boolean, nowSec?: number, taxFor?: (address) => number }} options
 *   `taxFor` returns the tax in cents a preview adds for an address, for the tax path, which the
 *   sandbox cannot run.
 */
function createFakeStripe(options = {}) {
  let counter = 0;
  const nextId = (prefix) => `${prefix}_fake${String(++counter).padStart(6, "0")}`;
  const state = {
    customers: new Map(),
    subscriptions: new Map(),
    invoices: new Map(),
    invoiceItems: new Map(),
    paymentIntents: new Map(),
    charges: new Map(),
    refunds: new Map(),
    disputes: new Map(),
    tokens: new Map(),
    setupIntents: new Map(),
    paymentMethods: new Map(),
    prices: new Map(),
    events: [],
    idempotency: new Map(),
  };
  const calls = [];
  const fake = {
    livemode: options.livemode ?? false,
    nowSec: options.nowSec ?? Math.floor(Date.now() / 1000),
    taxFor: options.taxFor ?? (() => 0),
    state,
    calls,
    /** Names of calls that fail with the given error, once each. */
    failures: new Map(),
  };

  for (const [lookupKey, [product, amount, interval]] of Object.entries(DEFAULT_PRICES)) {
    const id = `price_${lookupKey}`;
    state.prices.set(id, {
      id,
      object: "price",
      active: true,
      lookup_key: lookupKey,
      product,
      currency: "usd",
      unit_amount: amount,
      recurring: interval ? { interval } : null,
      tax_behavior: "exclusive",
    });
  }

  const record = (name, args) => {
    calls.push({ name, args: clone(args) });
    const failure = fake.failures.get(name);
    if (failure) {
      fake.failures.delete(name);
      throw failure;
    }
  };
  const idempotent = (key, create) => {
    if (key && state.idempotency.has(key)) return state.idempotency.get(key);
    const result = create();
    if (key) state.idempotency.set(key, result);
    return result;
  };
  const must = (map, id, kind) => {
    const found = map.get(id);
    if (!found) throw stripeError("resource_missing", `No such ${kind}: '${id}'`);
    return found;
  };
  const emit = (type, object) => {
    const event = {
      id: nextId("evt"),
      object: "event",
      api_version: "2026-10-28.endive",
      created: fake.nowSec,
      data: { object: clone(object) },
      livemode: fake.livemode,
      pending_webhooks: 1,
      request: null,
      type,
    };
    state.events.push(event);
    return event;
  };
  const priceById = (id) => must(state.prices, id, "price");

  const invoiceView = (invoice, expand = []) => {
    const view = clone(invoice);
    const payments = view.payments;
    delete view.payments;
    if (expand.includes("payments") || expand.includes("data.payments")) {
      view.payments = { object: "list", data: payments, has_more: false };
    }
    if (!expand.includes("confirmation_secret")) delete view.confirmation_secret;
    return view;
  };
  const subscriptionView = (sub, expand = []) => {
    const view = clone(sub);
    if (expand.some((path) => path.startsWith("latest_invoice")) && view.latest_invoice) {
      view.latest_invoice = invoiceView(state.invoices.get(view.latest_invoice), expand.map((path) => path.replace("latest_invoice.", "")));
    }
    return view;
  };
  const paymentIntentView = (pi, expand = []) => {
    const view = clone(pi);
    if (expand.includes("latest_charge") && view.latest_charge) view.latest_charge = clone(state.charges.get(view.latest_charge));
    return view;
  };

  /** Tax a Stripe-Tax invoice adds for the customer's address, from `taxFor`. */
  const taxOf = (customer, automaticTax) =>
    automaticTax ? fake.taxFor(state.customers.get(customer)?.address ?? {}) : 0;

  function newInvoice({ customer, subscription, lines, metadata = {}, status = "open", billingReason, automaticTax = false }) {
    const id = nextId("in");
    const subtotal = lines.reduce((sum, line) => sum + line.amount, 0);
    const tax = status === "draft" ? 0 : taxOf(customer, automaticTax);
    const total = subtotal + tax;
    const invoice = {
      id,
      object: "invoice",
      customer,
      status,
      created: fake.nowSec,
      livemode: fake.livemode,
      billing_reason: billingReason ?? (subscription ? "subscription_create" : "manual"),
      currency: "usd",
      total,
      subtotal,
      amount_paid: 0,
      total_taxes: tax ? [{ amount: tax }] : [],
      metadata,
      parent: subscription
        ? { type: "subscription_details", subscription_details: { subscription, metadata }, quote_details: null }
        : null,
      lines: { object: "list", data: lines, has_more: false },
      status_transitions: { paid_at: null, finalized_at: status === "draft" ? null : fake.nowSec, voided_at: null },
      payments: [],
      automatic_tax: { enabled: automaticTax, status: automaticTax ? "complete" : null },
    };
    state.invoices.set(id, invoice);
    if (status === "open") attachPaymentIntent(invoice, subscription ? "off_session" : null);
    return invoice;
  }

  function attachPaymentIntent(invoice, setupFutureUsage) {
    const pi = {
      id: nextId("pi"),
      object: "payment_intent",
      amount: invoice.total,
      currency: "usd",
      customer: invoice.customer,
      status: "requires_payment_method",
      setup_future_usage: setupFutureUsage,
      latest_charge: null,
      payment_method: null,
      next_action: null,
    };
    pi.client_secret = `${pi.id}_secret_fake`;
    state.paymentIntents.set(pi.id, pi);
    invoice.payments.push({
      id: nextId("inpay"),
      object: "invoice_payment",
      invoice: invoice.id,
      status: "open",
      is_default: true,
      amount_requested: invoice.total,
      amount_paid: null,
      payment: { type: "payment_intent", payment_intent: pi.id },
    });
    invoice.confirmation_secret = { type: "payment_intent", client_secret: pi.client_secret };
    return pi;
  }

  function paymentMethodFromToken(token, customer) {
    const id = nextId("pm");
    const card = token.payment_method_preview.card;
    state.paymentMethods.set(id, {
      id,
      object: "payment_method",
      type: "card",
      customer: customer ?? null,
      card: { country: card.country, brand: card.brand, last4: card.last4, funding: card.funding, exp_month: card.exp_month, exp_year: card.exp_year },
      failsCharges: token.failsCharges === true,
    });
    return id;
  }

  function payInvoiceNow(invoice, { paymentMethod = "pm_fake_card", cardCountry = "US" } = {}) {
    const payment = invoice.payments.find((row) => row.is_default) ?? invoice.payments[0];
    const pi = state.paymentIntents.get(payment.payment.payment_intent);
    const charge = {
      id: nextId("ch"),
      object: "charge",
      amount: invoice.total,
      amount_refunded: 0,
      refunded: false,
      disputed: false,
      customer: invoice.customer,
      payment_intent: pi.id,
      created: fake.nowSec,
      payment_method_details: { type: "card", card: { country: cardCountry } },
    };
    state.charges.set(charge.id, charge);
    Object.assign(pi, { status: "succeeded", latest_charge: charge.id, payment_method: paymentMethod, next_action: null });
    payment.status = "paid";
    payment.amount_paid = invoice.total;
    invoice.status = "paid";
    invoice.amount_paid = invoice.total;
    invoice.status_transitions.paid_at = fake.nowSec;
    emit("invoice.paid", invoice);
    return { charge, paymentIntent: pi };
  }

  function subscriptionLine(sub, start, end) {
    const item = sub.items.data[0];
    const price = priceById(item.price.id);
    return {
      id: nextId("il"),
      object: "line_item",
      amount: price.unit_amount,
      period: { start, end },
      parent: {
        type: "subscription_item_details",
        subscription_item_details: { subscription: sub.id, subscription_item: item.id, proration: false },
      },
      pricing: { price_details: { price: price.id, product: price.product } },
    };
  }

  function periodEnd(start, interval) {
    const date = new Date(start * 1000);
    if (interval === "year") date.setUTCFullYear(date.getUTCFullYear() + 1);
    else date.setUTCMonth(date.getUTCMonth() + 1);
    return Math.floor(date.getTime() / 1000);
  }

  function newSubscription({ customer, price, metadata = {}, status = "incomplete", automaticTax = false }) {
    const priceObject = priceById(price);
    const start = fake.nowSec;
    const end = periodEnd(start, priceObject.recurring.interval);
    const sub = {
      id: nextId("sub"),
      object: "subscription",
      customer,
      status,
      created: fake.nowSec,
      cancel_at_period_end: false,
      cancel_at: null,
      canceled_at: null,
      ended_at: null,
      metadata,
      default_payment_method: null,
      latest_invoice: null,
      items: {
        object: "list",
        data: [
          {
            id: nextId("si"),
            object: "subscription_item",
            price: clone(priceObject),
            current_period_start: start,
            current_period_end: end,
          },
        ],
      },
      livemode: fake.livemode,
      automatic_tax: { enabled: automaticTax },
    };
    state.subscriptions.set(sub.id, sub);
    const invoice = newInvoice({ customer, subscription: sub.id, lines: [subscriptionLine(sub, start, end)], metadata, automaticTax });
    sub.latest_invoice = invoice.id;
    emit("customer.subscription.created", sub);
    return { sub, invoice };
  }

  function cancelNow(sub) {
    if (sub.status === "canceled" || sub.status === "incomplete_expired") {
      throw stripeError("resource_missing", `No such subscription: '${sub.id}'`);
    }
    const latest = state.invoices.get(sub.latest_invoice);
    if (latest && latest.status === "open" && sub.status === "incomplete") {
      latest.status = "void";
      latest.status_transitions.voided_at = fake.nowSec;
    }
    sub.status = "canceled";
    sub.canceled_at = fake.nowSec;
    sub.ended_at = fake.nowSec;
    emit("customer.subscription.deleted", sub);
    return sub;
  }

  // -------------------------------------------------------------------------
  // The gateway
  // -------------------------------------------------------------------------

  Object.assign(fake, {
    constructEvent(payload, signature, secret) {
      record("constructEvent", {});
      const body = Buffer.isBuffer(payload) ? payload.toString("utf8") : String(payload);
      const parts = Object.fromEntries(String(signature).split(",").map((part) => part.split("=")));
      const expected = crypto.createHmac("sha256", secret).update(`${parts.t}.${body}`).digest("hex");
      if (!parts.v1 || parts.v1.length !== expected.length ||
        !crypto.timingSafeEqual(Buffer.from(parts.v1), Buffer.from(expected))) {
        throw Object.assign(new Error("No signatures found matching the expected signature"), {
          type: "StripeSignatureVerificationError",
        });
      }
      return JSON.parse(body);
    },

    async retrieveConfirmationToken(id) {
      record("retrieveConfirmationToken", { id });
      return clone(must(state.tokens, id, "confirmationtoken"));
    },

    async createCustomer(params, key) {
      record("createCustomer", { params, key });
      return clone(
        idempotent(key, () => {
          const customer = { id: nextId("cus"), object: "customer", metadata: { ...params.metadata }, ...params, livemode: fake.livemode };
          customer.metadata = { ...params.metadata };
          state.customers.set(customer.id, customer);
          emit("customer.created", customer);
          return customer;
        })
      );
    },
    async retrieveCustomer(id) {
      record("retrieveCustomer", { id });
      const customer = must(state.customers, id, "customer");
      return customer.deleted ? { id, object: "customer", deleted: true } : clone(customer);
    },
    async updateCustomer(id, params) {
      record("updateCustomer", { id, params });
      const customer = must(state.customers, id, "customer");
      if (customer.deleted) throw stripeError("resource_missing", `No such customer: '${id}'`);
      Object.assign(customer, clone(params));
      return clone(customer);
    },
    async deleteCustomer(id) {
      record("deleteCustomer", { id });
      const customer = must(state.customers, id, "customer");
      if (customer.deleted) throw stripeError("resource_missing", `No such customer: '${id}'`);
      for (const sub of state.subscriptions.values()) {
        if (sub.customer === id && sub.status !== "canceled" && sub.status !== "incomplete_expired") cancelNow(sub);
      }
      customer.deleted = true;
      return { id, object: "customer", deleted: true };
    },

    async createSubscription(params, key) {
      record("createSubscription", { params, key });
      return subscriptionView(
        idempotent(key, () => {
          must(state.customers, params.customer, "customer");
          const { sub } = newSubscription({
            customer: params.customer,
            price: params.items[0].price,
            metadata: { ...params.metadata },
            automaticTax: params.automatic_tax?.enabled === true,
          });
          return sub;
        }),
        params.expand
      );
    },
    async retrieveSubscription(id, expand = []) {
      record("retrieveSubscription", { id });
      return subscriptionView(must(state.subscriptions, id, "subscription"), expand);
    },
    async updateSubscription(id, params) {
      record("updateSubscription", { id, params });
      const sub = must(state.subscriptions, id, "subscription");
      if (params.cancel_at_period_end !== undefined) {
        sub.cancel_at_period_end = params.cancel_at_period_end;
        sub.cancel_at = params.cancel_at_period_end ? sub.items.data[0].current_period_end : null;
      }
      if (params.default_payment_method) sub.default_payment_method = params.default_payment_method;
      if (params.items?.[0]?.price) {
        const item = sub.items.data.find((row) => row.id === params.items[0].id);
        if (!item) throw stripeError("resource_missing", `No such subscription item: '${params.items[0].id}'`);
        item.price = clone(priceById(params.items[0].price));
      }
      if (params.metadata) sub.metadata = { ...sub.metadata, ...params.metadata };
      emit("customer.subscription.updated", sub);
      return clone(sub);
    },
    async cancelSubscription(id) {
      record("cancelSubscription", { id });
      return clone(cancelNow(must(state.subscriptions, id, "subscription")));
    },
    async listSubscriptions(customerId) {
      record("listSubscriptions", { customerId });
      return [...state.subscriptions.values()]
        .filter((sub) => sub.customer === customerId)
        .sort((left, right) => right.created - left.created || (right.id > left.id ? 1 : -1))
        .map(clone);
    },

    async createInvoice(params, key) {
      record("createInvoice", { params, key });
      return invoiceView(
        idempotent(key, () => {
          const invoice = newInvoice({ customer: params.customer, lines: [], metadata: { ...params.metadata }, status: "draft" });
          invoice.automatic_tax = { enabled: params.automatic_tax?.enabled === true, status: null };
          invoice.payment_settings = clone(params.payment_settings ?? null);
          return invoice;
        })
      );
    },
    async createInvoiceItem(params, key) {
      record("createInvoiceItem", { params, key });
      return clone(
        idempotent(key, () => {
          const invoice = must(state.invoices, params.invoice, "invoice");
          const price = priceById(params.pricing.price);
          const item = { id: nextId("ii"), object: "invoiceitem", invoice: invoice.id, amount: price.unit_amount };
          invoice.lines.data.push({
            id: nextId("il"),
            object: "line_item",
            amount: price.unit_amount,
            period: { start: fake.nowSec, end: fake.nowSec },
            parent: { type: "invoice_item_details", invoice_item_details: { invoice_item: item.id } },
            pricing: { price_details: { price: price.id, product: price.product } },
          });
          invoice.total += price.unit_amount;
          invoice.subtotal += price.unit_amount;
          state.invoiceItems.set(item.id, item);
          return item;
        })
      );
    },
    async finalizeInvoice(id, params = {}) {
      record("finalizeInvoice", { id });
      const invoice = must(state.invoices, id, "invoice");
      if (invoice.status === "draft") {
        const tax = taxOf(invoice.customer, invoice.automatic_tax?.enabled);
        if (tax) {
          invoice.total += tax;
          invoice.total_taxes = [{ amount: tax }];
          invoice.automatic_tax.status = "complete";
        }
        invoice.status = "open";
        invoice.status_transitions.finalized_at = fake.nowSec;
        for (const line of invoice.lines.data) line.period = { start: fake.nowSec, end: fake.nowSec };
        attachPaymentIntent(invoice, null);
      }
      return invoiceView(invoice, params.expand ?? []);
    },
    async voidInvoice(id) {
      record("voidInvoice", { id });
      const invoice = must(state.invoices, id, "invoice");
      if (invoice.status !== "open") throw stripeError("invoice_not_open", "Only open invoices can be voided.");
      invoice.status = "void";
      invoice.status_transitions.voided_at = fake.nowSec;
      emit("invoice.voided", invoice);
      return invoiceView(invoice);
    },
    async deleteInvoice(id) {
      record("deleteInvoice", { id });
      const invoice = must(state.invoices, id, "invoice");
      if (invoice.status !== "draft") throw stripeError("invoice_not_draft", "Only drafts can be deleted.");
      state.invoices.delete(id);
      return { id, object: "invoice", deleted: true };
    },
    async payInvoice(id, params, key) {
      record("payInvoice", { id, params, key });
      return invoiceView(
        idempotent(key, () => {
          const invoice = must(state.invoices, id, "invoice");
          if (invoice.status !== "open") throw stripeError("invoice_not_open", "Only open invoices can be paid.");
          const method = params.payment_method && state.paymentMethods.get(params.payment_method);
          if (method?.failsCharges) {
            throw Object.assign(stripeError("card_declined", "Your card was declined.", "card_error"), { decline_code: "insufficient_funds" });
          }
          payInvoiceNow(invoice, { paymentMethod: params.payment_method });
          const sub = invoice.parent && state.subscriptions.get(invoice.parent.subscription_details.subscription);
          if (sub && (sub.status === "past_due" || sub.status === "unpaid")) sub.status = "active";
          return invoice;
        })
      );
    },
    async retrieveInvoice(id, expand = []) {
      record("retrieveInvoice", { id });
      return invoiceView(must(state.invoices, id, "invoice"), expand);
    },
    async listInvoices(params) {
      record("listInvoices", { params });
      return [...state.invoices.values()]
        .filter((invoice) => !params.customer || invoice.customer === params.customer)
        .filter((invoice) => !params.subscription || invoice.parent?.subscription_details?.subscription === params.subscription)
        .filter((invoice) => !params.status || invoice.status === params.status)
        .sort((left, right) => right.created - left.created || (right.id > left.id ? 1 : -1))
        .slice(0, params.limit ?? 10)
        .map((invoice) => invoiceView(invoice, params.expand ?? []));
    },
    async createInvoicePreview(params) {
      record("createInvoicePreview", { params });
      const priceId = params.subscription_details?.items?.[0]?.price ?? params.invoice_items?.[0]?.price;
      const price = priceById(priceId);
      const address = params.customer_details?.address ?? {};
      const automatic = params.automatic_tax?.enabled === true;
      if (automatic && address.country === "CA" && !address.state && !address.postal_code) {
        return { object: "invoice", total: price.unit_amount, currency: "usd", total_taxes: [], automatic_tax: { enabled: true, status: "requires_location_inputs" } };
      }
      const tax = automatic ? fake.taxFor(address) : 0;
      return {
        object: "invoice",
        total: price.unit_amount + tax,
        subtotal: price.unit_amount,
        currency: "usd",
        total_taxes: tax ? [{ amount: tax }] : [],
        automatic_tax: { enabled: automatic, status: automatic ? "complete" : null },
      };
    },

    async confirmPaymentIntent(id, params, key) {
      record("confirmPaymentIntent", { id, key });
      return clone(
        idempotent(key, () => {
          const pi = must(state.paymentIntents, id, "payment_intent");
          const token = must(state.tokens, params.confirmation_token, "confirmationtoken");
          if (token.used) {
            throw stripeError("payment_intent_confirmation_token_invalid", "This ConfirmationToken has already been used.");
          }
          if ((token.setup_future_usage ?? null) !== (pi.setup_future_usage ?? null)) {
            throw stripeError("parameter_invalid", "setup_future_usage does not match the confirmation token.");
          }
          token.used = true;
          token.payment_intent = id;
          const invoice = [...state.invoices.values()].find((row) =>
            row.payments.some((payment) => payment.payment.payment_intent === id)
          );
          if (token.behavior === "decline") {
            throw Object.assign(stripeError("card_declined", "Your card was declined.", "card_error"), {
              decline_code: token.declineCode ?? "generic_decline",
            });
          }
          if (token.behavior === "requires_action") {
            Object.assign(pi, { status: "requires_action", next_action: { type: "use_stripe_sdk" } });
            if (invoice) emit("invoice.payment_action_required", invoice);
            return pi;
          }
          const pm = paymentMethodFromToken(token, pi.customer);
          payInvoiceNow(invoice, { paymentMethod: pm, cardCountry: token.payment_method_preview.card.country });
          const sub = invoice.parent && state.subscriptions.get(invoice.parent.subscription_details.subscription);
          if (sub && sub.status === "incomplete") {
            sub.status = "active";
            sub.default_payment_method = pm;
            emit("customer.subscription.updated", sub);
          }
          return pi;
        })
      );
    },
    async retrievePaymentIntent(id, expand = []) {
      record("retrievePaymentIntent", { id });
      return paymentIntentView(must(state.paymentIntents, id, "payment_intent"), expand);
    },

    async createSetupIntent(params, key) {
      record("createSetupIntent", { params, key });
      return clone(
        idempotent(key, () => {
          const token = must(state.tokens, params.confirmation_token, "confirmationtoken");
          if (token.used) throw stripeError("setup_intent_confirmation_token_invalid", "This ConfirmationToken has already been used.");
          if ((token.setup_future_usage ?? null) !== (params.usage ?? null)) {
            throw stripeError("parameter_invalid", "usage does not match the setup_future_usage from the confirmation token.");
          }
          token.used = true;
          if (token.behavior === "decline") {
            throw Object.assign(stripeError("card_declined", "Your card was declined.", "card_error"), {
              decline_code: token.declineCode ?? "generic_decline",
            });
          }
          const pm = paymentMethodFromToken(token, params.customer);
          const intent = {
            id: nextId("seti"),
            object: "setup_intent",
            customer: params.customer,
            status: token.behavior === "requires_action" ? "requires_action" : "succeeded",
            payment_method: pm,
            metadata: { ...params.metadata },
            last_setup_error: null,
          };
          intent.client_secret = `${intent.id}_secret_fake`;
          token.setup_intent = intent.id;
          state.setupIntents.set(intent.id, intent);
          return intent;
        })
      );
    },
    async retrieveSetupIntent(id) {
      record("retrieveSetupIntent", { id });
      return clone(must(state.setupIntents, id, "setup_intent"));
    },
    async retrievePaymentMethod(id) {
      record("retrievePaymentMethod", { id });
      return clone(must(state.paymentMethods, id, "payment_method"));
    },

    async listPricesByLookupKeys(lookupKeys) {
      record("listPricesByLookupKeys", { lookupKeys });
      return [...state.prices.values()].filter((price) => price.active && lookupKeys.includes(price.lookup_key)).map(clone);
    },

    async retrieveCharge(id) {
      record("retrieveCharge", { id });
      return clone(must(state.charges, id, "charge"));
    },
    async retrieveRefund(id) {
      record("retrieveRefund", { id });
      return clone(must(state.refunds, id, "refund"));
    },
    async retrieveDispute(id) {
      record("retrieveDispute", { id });
      return clone(must(state.disputes, id, "dispute"));
    },
    async listDisputes(params) {
      record("listDisputes", { params });
      return [...state.disputes.values()]
        .filter((dispute) => (!params.charge || dispute.charge === params.charge) &&
          (!params.payment_intent || dispute.payment_intent === params.payment_intent))
        .map(clone);
    },
    async listInvoicePayments(params) {
      record("listInvoicePayments", { params });
      const pi = params.payment?.payment_intent;
      const rows = [];
      for (const invoice of state.invoices.values()) {
        for (const payment of invoice.payments) {
          if ((!pi || payment.payment.payment_intent === pi) && (!params.status || payment.status === params.status)) {
            rows.push({ ...clone(payment), invoice: params.expand?.includes("data.invoice") ? invoiceView(invoice) : invoice.id });
          }
        }
      }
      return rows;
    },

    async listEvents(params) {
      record("listEvents", { params });
      let rows = [...state.events]
        .filter((event) => !params.types || params.types.includes(event.type))
        .filter((event) => !params.created?.gte || event.created >= params.created.gte)
        .filter((event) => !params.created?.lte || event.created <= params.created.lte)
        .reverse();
      if (params.starting_after) {
        const index = rows.findIndex((event) => event.id === params.starting_after);
        rows = rows.slice(index + 1);
      }
      const limit = params.limit ?? 10;
      return { data: rows.slice(0, limit).map(clone), hasMore: rows.length > limit };
    },
    async retrieveEvent(id) {
      record("retrieveEvent", { id });
      return clone(state.events.find((event) => event.id === id) ?? must(new Map(), id, "event"));
    },
  });

  // -------------------------------------------------------------------------
  // Scenario helpers
  // -------------------------------------------------------------------------

  Object.assign(fake, {
    /** Calls made since the last reset, by name. */
    callNames() {
      return calls.map((call) => call.name);
    },
    resetCalls() {
      calls.length = 0;
    },

    addCustomer(uid, extra = {}) {
      const customer = { id: nextId("cus"), object: "customer", metadata: uid ? { uid } : {}, livemode: fake.livemode, ...extra };
      state.customers.set(customer.id, customer);
      return customer.id;
    },

    /**
     * A confirmation token. `behavior` is `succeed` (default), `decline` or `requires_action`;
     * `setupFutureUsage` must match the PaymentIntent it confirms, as Stripe requires.
     */
    addToken({
      type = "card",
      country = "US",
      funding = "credit",
      wallet = null,
      brand = "visa",
      billing = { country: country ?? "US" },
      setupFutureUsage = "off_session",
      behavior = "succeed",
      declineCode,
      failsCharges = false,
      expiresInSec = 43200,
      expMonth = 12,
      expYear = 2040,
    } = {}) {
      const id = nextId("ctoken");
      state.tokens.set(id, {
        id,
        object: "confirmation_token",
        created: fake.nowSec,
        expires_at: fake.nowSec + expiresInSec,
        setup_future_usage: setupFutureUsage,
        payment_intent: null,
        setup_intent: null,
        behavior,
        declineCode,
        failsCharges,
        payment_method_preview:
          type === "card"
            ? {
              type: "card",
              billing_details: { address: { city: null, line1: null, line2: null, postal_code: null, state: null, ...billing } },
              card: { country, funding, brand, wallet: wallet ? { type: wallet } : null, last4: "4242", exp_month: expMonth, exp_year: expYear },
            }
            : { type, billing_details: { address: { ...billing } }, link: { email: null } },
      });
      return id;
    },

    /** An active subscription whose first invoice was paid at `nowSec`. */
    paySubscription({ customer, lookupKey = "web_monthly_standard", metadata = {} }) {
      const { sub, invoice } = newSubscription({ customer, price: `price_${lookupKey}`, metadata });
      const { charge, paymentIntent } = payInvoiceNow(invoice);
      sub.status = "active";
      emit("customer.subscription.updated", sub);
      return { subscriptionId: sub.id, invoiceId: invoice.id, chargeId: charge.id, paymentIntentId: paymentIntent.id };
    },

    /** An incomplete subscription with its open first invoice, as `default_incomplete` leaves it. */
    startSubscription({ customer, lookupKey = "web_monthly_standard", metadata = {} }) {
      const { sub, invoice } = newSubscription({ customer, price: `price_${lookupKey}`, metadata });
      const payment = invoice.payments[0];
      return { subscriptionId: sub.id, invoiceId: invoice.id, paymentIntentId: payment.payment.payment_intent };
    },

    /**
     * The next renewal at `nowSec`: the item period advances whatever happens, as Stripe's does.
     * Paid, the invoice is paid; otherwise it stays open and the subscription goes past due.
     */
    renew(subscriptionId, { paid = true, requiresAction = false } = {}) {
      const sub = must(state.subscriptions, subscriptionId, "subscription");
      const item = sub.items.data[0];
      const start = item.current_period_end;
      const end = periodEnd(start, item.price.recurring.interval);
      Object.assign(item, { current_period_start: start, current_period_end: end });
      const invoice = newInvoice({ customer: sub.customer, subscription: sub.id, lines: [subscriptionLine(sub, start, end)], billingReason: "subscription_cycle", automaticTax: sub.automatic_tax?.enabled === true });
      sub.latest_invoice = invoice.id;
      if (paid) {
        const result = payInvoiceNow(invoice);
        return { invoiceId: invoice.id, chargeId: result.charge.id };
      }
      const pi = state.paymentIntents.get(invoice.payments[0].payment.payment_intent);
      if (requiresAction) {
        Object.assign(pi, { status: "requires_action", next_action: { type: "use_stripe_sdk" } });
        emit("invoice.payment_action_required", invoice);
      } else {
        emit("invoice.payment_failed", invoice);
      }
      sub.status = "past_due";
      emit("customer.subscription.updated", sub);
      return { invoiceId: invoice.id, paymentIntentId: pi.id };
    },

    /** The buyer finishes (or fails) the authentication a `requires_action` PaymentIntent asked for. */
    completeAction(paymentIntentId, { succeed = true } = {}) {
      const pi = must(state.paymentIntents, paymentIntentId, "payment_intent");
      const invoice = [...state.invoices.values()].find((row) =>
        row.payments.some((payment) => payment.payment.payment_intent === paymentIntentId)
      );
      if (!succeed) {
        Object.assign(pi, {
          status: "requires_payment_method",
          next_action: null,
          last_payment_error: { type: "card_error", code: "payment_intent_authentication_failure" },
        });
        return;
      }
      const token = [...state.tokens.values()].find((row) => row.payment_intent === paymentIntentId);
      const pm = token ? paymentMethodFromToken(token, pi.customer) : "pm_fake_card";
      payInvoiceNow(invoice, { paymentMethod: pm, cardCountry: token?.payment_method_preview.card.country ?? "US" });
      const sub = invoice.parent && state.subscriptions.get(invoice.parent.subscription_details.subscription);
      if (sub && (sub.status === "incomplete" || sub.status === "past_due")) {
        sub.status = "active";
        if (!sub.default_payment_method) sub.default_payment_method = pm;
        emit("customer.subscription.updated", sub);
      }
    },

    /** The buyer finishes (or fails) a SetupIntent's authentication. */
    completeSetupAction(setupIntentId, { succeed = true } = {}) {
      const intent = must(state.setupIntents, setupIntentId, "setup_intent");
      if (succeed) Object.assign(intent, { status: "succeeded" });
      else Object.assign(intent, { status: "requires_payment_method", last_setup_error: { code: "setup_intent_authentication_failure" } });
    },

    /** Stripe's `invoice.upcoming`: a preview of the next renewal invoice, with no id. */
    upcoming(subscriptionId) {
      const sub = must(state.subscriptions, subscriptionId, "subscription");
      const price = priceById(sub.items.data[0].price.id);
      return emit("invoice.upcoming", {
        object: "invoice",
        customer: sub.customer,
        billing_reason: "upcoming",
        currency: "usd",
        total: price.unit_amount,
        parent: { type: "subscription_details", subscription_details: { subscription: sub.id } },
      });
    },

    setSubscription(subscriptionId, patch) {
      const sub = must(state.subscriptions, subscriptionId, "subscription");
      Object.assign(sub, patch);
      emit("customer.subscription.updated", sub);
    },

    /** A paid one-off lifetime invoice, as recipe C8 leaves it. */
    payLifetime({ customer, lookupKey = "web_lifetime_standard", metadata = {} }) {
      const price = priceById(`price_${lookupKey}`);
      const invoice = newInvoice({
        customer,
        lines: [{
          id: nextId("il"),
          object: "line_item",
          amount: price.unit_amount,
          period: { start: fake.nowSec, end: fake.nowSec },
          parent: { type: "invoice_item_details", invoice_item_details: {} },
          pricing: { price_details: { price: price.id, product: price.product } },
        }],
        metadata,
      });
      const { charge, paymentIntent } = payInvoiceNow(invoice);
      return { invoiceId: invoice.id, chargeId: charge.id, paymentIntentId: paymentIntent.id };
    },

    refund(chargeId, amount) {
      const charge = must(state.charges, chargeId, "charge");
      const refunded = amount ?? charge.amount - charge.amount_refunded;
      charge.amount_refunded += refunded;
      charge.refunded = charge.amount_refunded >= charge.amount;
      const refund = { id: nextId("re"), object: "refund", amount: refunded, charge: chargeId, payment_intent: charge.payment_intent, customer: charge.customer, status: "succeeded" };
      state.refunds.set(refund.id, refund);
      emit("refund.created", refund);
      emit("charge.refunded", charge);
      return refund.id;
    },

    dispute(chargeId, status = "needs_response") {
      const charge = must(state.charges, chargeId, "charge");
      charge.disputed = true;
      const dispute = { id: nextId("du"), object: "dispute", charge: chargeId, payment_intent: charge.payment_intent, status, created: fake.nowSec };
      state.disputes.set(dispute.id, dispute);
      emit("charge.dispute.created", dispute);
      return dispute.id;
    },

    setDispute(disputeId, status) {
      const dispute = must(state.disputes, disputeId, "dispute");
      dispute.status = status;
      emit(status === "won" || status === "lost" ? "charge.dispute.closed" : "charge.dispute.updated", dispute);
    },

    emit,

    /** A signed webhook body for an event, as Stripe would post it. */
    signedEvent(event, secret, timestamp = fake.nowSec) {
      const body = JSON.stringify(event);
      const signature = crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
      return { body: Buffer.from(body), header: `t=${timestamp},v1=${signature}` };
    },

    advance(seconds) {
      fake.nowSec += seconds;
    },
  });

  return fake;
}

module.exports = { createFakeStripe, DAY };
