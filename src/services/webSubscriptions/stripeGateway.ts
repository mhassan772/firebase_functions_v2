import Stripe from "stripe";
import { STRIPE_WEB_SECRETS } from "../../config/constants";
import { SubscriptionError } from "../subscriptions/errors";

/**
 * Every Stripe call web subscriptions make, and nothing else.
 *
 * Handlers and services take this as a dependency, so unit tests run against an in-memory fake
 * and the live account is reached only through `liveStripeGateway`. Methods mirror stripe-node
 * one to one, with Stripe's own parameter and object types, so a caller reads the facts file
 * (`docs/ai/research/26-11-14/stripe-web-purchase-api-facts.md` in Mantooq_Mobile) and not this
 * wrapper. Every create call takes the idempotency key its caller derives from the purchase.
 */
export interface StripeGateway {
  /** True for a live key. Decides the web slot and refuses events from the other mode. */
  readonly livemode: boolean;

  /** Verifies a webhook's signature over the raw body and returns the event, or throws. */
  constructEvent(payload: Buffer | string, signature: string, secret: string): Stripe.Event;

  retrieveConfirmationToken(id: string): Promise<Stripe.ConfirmationToken>;

  createCustomer(params: Stripe.CustomerCreateParams, idempotencyKey: string): Promise<Stripe.Customer>;
  retrieveCustomer(id: string): Promise<Stripe.Customer | Stripe.DeletedCustomer>;
  updateCustomer(id: string, params: Stripe.CustomerUpdateParams): Promise<Stripe.Customer>;
  deleteCustomer(id: string): Promise<Stripe.DeletedCustomer>;

  createSubscription(params: Stripe.SubscriptionCreateParams, idempotencyKey: string): Promise<Stripe.Subscription>;
  retrieveSubscription(id: string, expand?: string[]): Promise<Stripe.Subscription>;
  updateSubscription(id: string, params: Stripe.SubscriptionUpdateParams): Promise<Stripe.Subscription>;
  cancelSubscription(id: string): Promise<Stripe.Subscription>;
  /** Every subscription of the customer in any status, newest first, up to 100. */
  listSubscriptions(customerId: string): Promise<Stripe.Subscription[]>;

  createInvoice(params: Stripe.InvoiceCreateParams, idempotencyKey: string): Promise<Stripe.Invoice>;
  createInvoiceItem(params: Stripe.InvoiceItemCreateParams, idempotencyKey: string): Promise<Stripe.InvoiceItem>;
  finalizeInvoice(id: string, params?: Stripe.InvoiceFinalizeInvoiceParams): Promise<Stripe.Invoice>;
  voidInvoice(id: string): Promise<Stripe.Invoice>;
  /** A draft cannot be voided, only deleted. */
  deleteInvoice(id: string): Promise<Stripe.DeletedInvoice>;
  payInvoice(id: string, params: Stripe.InvoicePayParams, idempotencyKey: string): Promise<Stripe.Invoice>;
  retrieveInvoice(id: string, expand?: string[]): Promise<Stripe.Invoice>;
  /** One page, newest first; callers bound it with `limit`. */
  listInvoices(params: Stripe.InvoiceListParams): Promise<Stripe.Invoice[]>;
  createInvoicePreview(params: Stripe.InvoiceCreatePreviewParams): Promise<Stripe.Invoice>;

  confirmPaymentIntent(
    id: string,
    params: Stripe.PaymentIntentConfirmParams,
    idempotencyKey: string
  ): Promise<Stripe.PaymentIntent>;
  retrievePaymentIntent(id: string, expand?: string[]): Promise<Stripe.PaymentIntent>;

  createSetupIntent(params: Stripe.SetupIntentCreateParams, idempotencyKey: string): Promise<Stripe.SetupIntent>;
  retrieveSetupIntent(id: string, expand?: string[]): Promise<Stripe.SetupIntent>;
  retrievePaymentMethod(id: string): Promise<Stripe.PaymentMethod>;

  /** Active prices holding these lookup keys. */
  listPricesByLookupKeys(lookupKeys: string[]): Promise<Stripe.Price[]>;

  retrieveCharge(id: string): Promise<Stripe.Charge>;
  retrieveRefund(id: string): Promise<Stripe.Refund>;
  retrieveDispute(id: string): Promise<Stripe.Dispute>;
  listDisputes(params: { charge?: string; payment_intent?: string }): Promise<Stripe.Dispute[]>;
  /** The invoices a PaymentIntent paid, found the way Stripe documents for this API version. */
  listInvoicePayments(params: Stripe.InvoicePaymentListParams): Promise<Stripe.InvoicePayment[]>;

  /** One page of events, newest first. */
  listEvents(params: Stripe.EventListParams): Promise<{ data: Stripe.Event[]; hasMore: boolean }>;
  retrieveEvent(id: string): Promise<Stripe.Event>;
}

/** A key's mode from its prefix; anything that is neither a live nor a test key is refused. */
export function livemodeOfKey(key: string): boolean {
  if (key.startsWith("sk_live_") || key.startsWith("rk_live_")) return true;
  if (key.startsWith("sk_test_") || key.startsWith("rk_test_")) return false;
  throw new SubscriptionError("configuration", "stripe-key-invalid", "The Stripe secret key is not a Stripe key.");
}

/** The gateway over stripe-node for one secret key. */
export function liveStripeGateway(secretKey: string): StripeGateway {
  const livemode = livemodeOfKey(secretKey);
  // The library pins the API version it was generated for (2026-10-28.endive in 23.1.0), which
  // is the version the facts file was verified against.
  const stripe = new Stripe(secretKey, { maxNetworkRetries: 2, timeout: 20_000 });
  const withKey = (idempotencyKey: string): Stripe.RequestOptions => ({ idempotencyKey });
  return {
    livemode,
    constructEvent: (payload, signature, secret) => stripe.webhooks.constructEvent(payload, signature, secret),
    retrieveConfirmationToken: (id) => stripe.confirmationTokens.retrieve(id),
    createCustomer: (params, key) => stripe.customers.create(params, withKey(key)),
    retrieveCustomer: (id) => stripe.customers.retrieve(id),
    updateCustomer: (id, params) => stripe.customers.update(id, params),
    deleteCustomer: (id) => stripe.customers.del(id),
    createSubscription: (params, key) => stripe.subscriptions.create(params, withKey(key)),
    retrieveSubscription: (id, expand) => stripe.subscriptions.retrieve(id, expand ? { expand } : {}),
    updateSubscription: (id, params) => stripe.subscriptions.update(id, params),
    cancelSubscription: (id) => stripe.subscriptions.cancel(id),
    async listSubscriptions(customerId) {
      const page = await stripe.subscriptions.list({ customer: customerId, status: "all", limit: 100 });
      return [...page.data].sort((left, right) => right.created - left.created);
    },
    createInvoice: (params, key) => stripe.invoices.create(params, withKey(key)),
    createInvoiceItem: (params, key) => stripe.invoiceItems.create(params, withKey(key)),
    finalizeInvoice: (id, params) => stripe.invoices.finalizeInvoice(id, params ?? {}),
    voidInvoice: (id) => stripe.invoices.voidInvoice(id),
    deleteInvoice: (id) => stripe.invoices.del(id),
    payInvoice: (id, params, key) => stripe.invoices.pay(id, params, withKey(key)),
    retrieveInvoice: (id, expand) => stripe.invoices.retrieve(id, expand ? { expand } : {}),
    async listInvoices(params) {
      return (await stripe.invoices.list(params)).data;
    },
    createInvoicePreview: (params) => stripe.invoices.createPreview(params),
    confirmPaymentIntent: (id, params, key) => stripe.paymentIntents.confirm(id, params, withKey(key)),
    retrievePaymentIntent: (id, expand) => stripe.paymentIntents.retrieve(id, expand ? { expand } : {}),
    createSetupIntent: (params, key) => stripe.setupIntents.create(params, withKey(key)),
    retrieveSetupIntent: (id, expand) => stripe.setupIntents.retrieve(id, expand ? { expand } : {}),
    retrievePaymentMethod: (id) => stripe.paymentMethods.retrieve(id),
    async listPricesByLookupKeys(lookupKeys) {
      if (lookupKeys.length === 0) return [];
      return (await stripe.prices.list({ lookup_keys: lookupKeys, active: true, limit: 100 })).data;
    },
    retrieveCharge: (id) => stripe.charges.retrieve(id),
    retrieveRefund: (id) => stripe.refunds.retrieve(id),
    retrieveDispute: (id) => stripe.disputes.retrieve(id),
    async listDisputes(params) {
      return (await stripe.disputes.list({ ...params, limit: 100 })).data;
    },
    async listInvoicePayments(params) {
      return (await stripe.invoicePayments.list(params)).data;
    },
    async listEvents(params) {
      const page = await stripe.events.list(params);
      return { data: page.data, hasMore: page.has_more };
    },
    retrieveEvent: (id) => stripe.events.retrieve(id),
  };
}

let cached: { key: string; gateway: StripeGateway } | undefined;

/**
 * The live gateway for the key in the environment, or undefined when none is set.
 *
 * Undefined is not an error: every path that can run without web purchases (reconcile,
 * account deletion) checks for it and skips its Stripe work.
 */
export function stripeGatewayFromEnv(): StripeGateway | undefined {
  const key = process.env[STRIPE_WEB_SECRETS.secretKey]?.trim();
  if (!key) return undefined;
  if (cached?.key !== key) cached = { key, gateway: liveStripeGateway(key) };
  return cached.gateway;
}

/** Stripe's machine code for an error, never its message, which can quote ids or a token. */
export function stripeErrorCode(error: unknown): string | undefined {
  const record = error as { code?: unknown; type?: unknown } | null;
  if (typeof record?.code === "string" && /^[\w.-]{1,64}$/.test(record.code)) return record.code;
  if (typeof record?.type === "string" && /^[\w.-]{1,64}$/.test(record.type)) return record.type;
  return undefined;
}

export function isResourceMissing(error: unknown): boolean {
  return stripeErrorCode(error) === "resource_missing";
}

/** The id of an expandable Stripe field, whether or not it was expanded. */
export function idOf(value: string | { id: string } | null | undefined): string | undefined {
  if (!value) return undefined;
  return typeof value === "string" ? value : value.id;
}

/** Enough of an id to match log lines, never enough to use: for confirmation tokens and the like. */
export function shortId(id: string | undefined): string | undefined {
  if (!id) return undefined;
  const cut = id.indexOf("_") + 1;
  return `${id.slice(0, cut + 6)}…`;
}
