import * as crypto from "crypto";
import * as functions from "firebase-functions";
import type Stripe from "stripe";
import { readWebAccountSlots, StoreSubscriptionSummary, storeSubscriptionOf, webSlotView, WebAccountState } from "../services/webSubscriptions/accountState";
import { customerIdFor, readCustomerMapping } from "../services/webSubscriptions/customers";
import { isWebPlan, ledgerEntryFromData, WEB_PURCHASES_COLLECTION, WebPlan } from "../services/webSubscriptions/ledger";
import { cardFromToken, dearerTier, lookupKeyFor, tierOfCountry, WebPricingConfig } from "../services/webSubscriptions/pricing";
import { idOf, isResourceMissing, shortId, stripeErrorCode } from "../services/webSubscriptions/stripeGateway";
import { syncWebEntitlement, WebSyncDeps } from "../services/webSubscriptions/sync";
import { hasAppCheck, refusal, requireCaller } from "../utils/callableAuth";
import {
  cardDeclined,
  categoryOfLastError,
  CONFIRMATION_TOKEN_PATTERN,
  consumeWebThrottle,
  declineCategory,
  invalidRequest,
  isCardError,
  isTokenError,
  logWebInfo,
  openWebGate,
  optionalCents,
  readConfirmationToken,
  readRequestObject,
  requiredString,
  tokenInvalid,
  toWebCallableError,
  WebCallableDeps,
  WebCallerContext,
  WebGate,
} from "./webCallableCommon";
import { WebQuote } from "./webPurchaseHandlers";

const SETUP_INTENT_PATTERN = /^seti_[A-Za-z0-9]{6,200}$/;
/** Subscription states `/manage` can act on; anything else is `no_subscription`. */
const MANAGEABLE_STATES: readonly WebAccountState[] = ["active", "cancelling", "payment_failed", "needs_action"];
const OPEN_SUBSCRIPTION_STATUSES = new Set(["active", "past_due", "unpaid", "trialing"]);

// ---------------------------------------------------------------------------
// getWebSubscription
// ---------------------------------------------------------------------------

export interface WebSubscriptionResult {
  state: WebAccountState;
  plan?: string;
  /** The amount the next renewal charges before tax, or what lifetime cost. Integer cents. */
  amount?: number;
  currency?: string;
  /** ISO 8601. */
  renewsAt?: string;
  endsAt?: string;
  card?: { brand: string; last4: string };
  /** The ledger entry behind the slot, for `finishWebPurchase` after authenticating. */
  purchaseId?: string;
  storeSubscription: StoreSubscriptionSummary | null;
  /**
   * The key Stripe.js needs to replace a card or finish a bank check.
   *
   * Returned here because `/manage` must work while sales are switched off, when `getWebPlans`
   * refuses. Left out when the configured key does not match the gateway's mode.
   */
  publishableKey?: string;
  livemode: boolean;
}

/** The caller's web purchase for `/manage`, synced from Stripe first when the account has a customer. */
export async function handleGetWebSubscription(
  data: unknown,
  context: WebCallerContext,
  deps: WebCallableDeps
): Promise<WebSubscriptionResult> {
  const event = "web_subscription_read";
  const operationId = crypto.randomUUID();
  const state = { stage: "validate" };
  try {
    const uid = requireCaller(context, { allowAnonymous: false, withReason: true });
    readRequestObject(data, []);
    state.stage = "gate";
    const gate = await openWebGate(uid, deps, { sales: false });
    const { gateway } = gate;
    const customerId = customerIdFor(await readCustomerMapping(deps.firestore, uid), gateway.livemode);
    if (customerId) {
      state.stage = "sync";
      await syncWebEntitlement(uid, { firestore: deps.firestore, gateway, now: deps.now }, { operationId, trigger: "subscription_read" });
    }

    state.stage = "read";
    const now = deps.now();
    const slots = await readWebAccountSlots(deps.firestore, uid, gateway.livemode);
    const view = webSlotView(slots.web, now);
    const result: WebSubscriptionResult = {
      state: view.state,
      storeSubscription: storeSubscriptionOf(slots, now),
      livemode: gateway.livemode,
    };
    const publishableKey = deps.publishableKey;
    if (publishableKey?.startsWith(gateway.livemode ? "pk_live_" : "pk_test_")) {
      result.publishableKey = publishableKey;
    } else {
      functions.logger.error(`${event}_publishable_key_invalid`, { operationId, present: Boolean(publishableKey) });
    }
    if (view.state !== "none") {
      if (view.plan) result.plan = view.plan;
      if (view.purchaseId) result.purchaseId = view.purchaseId;
      const iso = (date: Date | undefined) => date?.toISOString();
      if (view.state === "active") result.renewsAt = iso(view.paidThrough);
      if (view.state === "cancelling") result.endsAt = iso(view.paidThrough);
      if (view.state === "lifetime" || view.state === "ended" || view.state === "payment_failed" || view.state === "needs_action") {
        result.endsAt = iso(view.expiresAt);
      }
      if (view.state === "lifetime" && view.purchaseId) {
        const entry = ledgerEntryFromData(
          view.purchaseId,
          (await deps.firestore.collection(WEB_PURCHASES_COLLECTION).doc(view.purchaseId).get()).data()
        );
        if (entry && entry.uid === uid) {
          result.amount = entry.total;
          result.currency = entry.currency;
        }
      }
      if (view.subscriptionId && customerId && view.state !== "ended") {
        const subscription = await ownSubscription(gate, view.subscriptionId, customerId);
        if (subscription) {
          const item = subscription.items.data[0];
          if (typeof item?.price?.unit_amount === "number") {
            result.amount = item.price.unit_amount;
            result.currency = item.price.currency;
          }
          const card = await cardOf(gate, idOf(subscription.default_payment_method as string | { id: string } | null), customerId);
          if (card) result.card = card;
        }
      }
    }
    logWebInfo(`${event}_success`, operationId, { uid, state: result.state, appCheck: hasAppCheck(context) });
    return result;
  } catch (error) {
    throw toWebCallableError(event, operationId, state.stage, error);
  }
}

/** The subscription, only when it belongs to the caller's customer. */
async function ownSubscription(gate: WebGate, subscriptionId: string, customerId: string): Promise<Stripe.Subscription | undefined> {
  try {
    const subscription = await gate.gateway.retrieveSubscription(subscriptionId);
    return idOf(subscription.customer as string | { id: string }) === customerId ? subscription : undefined;
  } catch (error) {
    if (isResourceMissing(error)) return undefined;
    throw error;
  }
}

async function cardOf(gate: WebGate, paymentMethodId: string | undefined, customerId: string) {
  if (!paymentMethodId) return undefined;
  try {
    const method = await gate.gateway.retrievePaymentMethod(paymentMethodId);
    const owner = idOf(method.customer as string | { id: string } | null);
    if (owner && owner !== customerId) return undefined;
    if (!method.card?.brand || !method.card.last4) return undefined;
    return { brand: method.card.brand, last4: method.card.last4 };
  } catch (error) {
    if (isResourceMissing(error)) return undefined;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// manageWebSubscription
// ---------------------------------------------------------------------------

export type ManageWebSubscriptionResult =
  | { status: "succeeded" }
  | { status: "reprice"; quote: WebQuote }
  | { status: "requires_action"; setupIntentId: string; clientSecret: string }
  | { clientSecret: string; purchaseId?: string };

type ManageRequest =
  | { action: "cancel" | "resume" | "authenticate" }
  | { action: "replace_card"; confirmationToken: string; acceptedRenewalAmount?: number }
  | { action: "finish_replace_card"; setupIntentId: string };

function readManageRequest(data: unknown): ManageRequest {
  const action = (data as { action?: unknown } | null)?.action;
  switch (action) {
    case "cancel":
    case "resume":
    case "authenticate":
      readRequestObject(data, ["action"]);
      return { action };
    case "replace_card": {
      const request = readRequestObject(data, ["action", "confirmationToken", "acceptedRenewalAmount"]);
      return {
        action,
        confirmationToken: requiredString(request.confirmationToken, CONFIRMATION_TOKEN_PATTERN),
        acceptedRenewalAmount: optionalCents(request.acceptedRenewalAmount),
      };
    }
    case "finish_replace_card": {
      const request = readRequestObject(data, ["action", "setupIntentId"]);
      return { action, setupIntentId: requiredString(request.setupIntentId, SETUP_INTENT_PATTERN) };
    }
    default:
      readRequestObject(data, ["action"]);
      throw invalidRequest();
  }
}

interface ManageContext {
  uid: string;
  operationId: string;
  deps: WebCallableDeps;
  gate: WebGate;
  syncDeps: WebSyncDeps;
  customerId: string;
  subscription: Stripe.Subscription;
  plan: WebPlan;
  purchaseId?: string;
}

/**
 * Changes the caller's own web subscription: cancel at period end, resume, replace the card, or
 * hand the page what it needs to authenticate a renewal.
 *
 * The customer comes from `web_customers/{uid}` and the subscription from the account's web
 * slot, both checked against each other; the page sends no Stripe id except the SetupIntent of
 * a card replacement it is finishing, which must belong to the same customer.
 */
export async function handleManageWebSubscription(
  data: unknown,
  context: WebCallerContext,
  deps: WebCallableDeps
): Promise<ManageWebSubscriptionResult> {
  const event = "web_subscription_manage";
  const operationId = crypto.randomUUID();
  const state = { stage: "validate" };
  try {
    const uid = requireCaller(context, { allowAnonymous: false, withReason: true });
    const request = readManageRequest(data);
    state.stage = "gate";
    const gate = await openWebGate(uid, deps, { sales: false });
    logWebInfo(`${event}_start`, operationId, { uid, action: request.action, livemode: gate.gateway.livemode, appCheck: hasAppCheck(context) });

    state.stage = "subscription";
    const ctx = await manageContext(uid, operationId, deps, gate);

    state.stage = request.action;
    let result: ManageWebSubscriptionResult;
    switch (request.action) {
      case "cancel":
      case "resume":
        await gate.gateway.updateSubscription(ctx.subscription.id, { cancel_at_period_end: request.action === "cancel" });
        await sync(ctx, request.action);
        result = { status: "succeeded" };
        break;
      case "authenticate":
        result = await authenticate(ctx);
        break;
      case "replace_card":
        await consumeWebThrottle(deps, uid, context);
        result = await replaceCard(ctx, request.confirmationToken, request.acceptedRenewalAmount);
        break;
      case "finish_replace_card":
        result = await finishReplaceCard(ctx, request.setupIntentId);
        break;
    }
    logWebInfo(`${event}_success`, operationId, {
      uid,
      action: request.action,
      subscriptionId: ctx.subscription.id,
      status: "status" in result ? result.status : "client_secret",
    });
    return result;
  } catch (error) {
    throw toWebCallableError(event, operationId, state.stage, error);
  }
}

function noSubscription() {
  return refusal("failed-precondition", "There is no web subscription to change.", "no_subscription");
}

/** The caller's customer and the open subscription its web slot names, or `no_subscription`. */
async function manageContext(uid: string, operationId: string, deps: WebCallableDeps, gate: WebGate): Promise<ManageContext> {
  const { gateway } = gate;
  const customerId = customerIdFor(await readCustomerMapping(deps.firestore, uid), gateway.livemode);
  if (!customerId) throw noSubscription();
  const syncDeps: WebSyncDeps = { firestore: deps.firestore, gateway, now: deps.now };
  await syncWebEntitlement(uid, syncDeps, { operationId, trigger: "subscription_manage" });
  const slots = await readWebAccountSlots(deps.firestore, uid, gateway.livemode);
  const view = webSlotView(slots.web, deps.now());
  if (!view.subscriptionId || !MANAGEABLE_STATES.includes(view.state) || view.customerId !== customerId) {
    throw noSubscription();
  }
  const subscription = await ownSubscription(gate, view.subscriptionId, customerId);
  const product = idOf(subscription?.items.data[0]?.price?.product as string | { id: string } | null);
  if (!subscription || !OPEN_SUBSCRIPTION_STATUSES.has(subscription.status) || !isWebPlan(product) || product === "web_lifetime") {
    throw noSubscription();
  }
  return { uid, operationId, deps, gate, syncDeps, customerId, subscription, plan: product, purchaseId: view.purchaseId };
}

async function sync(ctx: ManageContext, trigger: string): Promise<void> {
  await syncWebEntitlement(ctx.uid, ctx.syncDeps, { operationId: ctx.operationId, trigger: `manage_${trigger}` });
}

/** The client secret of the open invoice's payment waiting for the buyer to authenticate. */
async function authenticate(ctx: ManageContext): Promise<ManageWebSubscriptionResult> {
  const invoiceId = idOf(ctx.subscription.latest_invoice as string | { id: string } | null);
  if (invoiceId) {
    const invoice = await ctx.gate.gateway.retrieveInvoice(invoiceId, ["payments"]);
    if (invoice.status === "open" && idOf(invoice.customer as string | { id: string } | null) === ctx.customerId) {
      const payment = (invoice.payments?.data ?? []).find((row) => row.status === "open" || row.is_default);
      const paymentIntentId = idOf(payment?.payment?.payment_intent ?? null);
      if (paymentIntentId) {
        const intent = await ctx.gate.gateway.retrievePaymentIntent(paymentIntentId);
        if (intent.status === "requires_action" && intent.client_secret) {
          return { clientSecret: intent.client_secret, ...(ctx.purchaseId ? { purchaseId: ctx.purchaseId } : {}) };
        }
      }
    }
  }
  throw refusal("failed-precondition", "No payment is waiting for verification.", "no_action_required");
}

/** The tier of the subscription's current price: the tier whose price for the plan has its lookup key. */
function currentTier(config: WebPricingConfig, subscription: Stripe.Subscription, plan: WebPlan): string {
  const lookupKey = subscription.items.data[0]?.price?.lookup_key;
  for (const [tier, tierConfig] of Object.entries(config.tiers)) {
    if (lookupKey && tierConfig.prices[plan] === lookupKey) return tier;
  }
  const stored = subscription.metadata?.tier;
  return stored && config.tiers[stored] ? stored : config.fullPriceTier;
}

/** The price change a card from `cardCountry` brings: a dearer tier only, never a cheaper one. */
async function priceChangeFor(ctx: ManageContext, cardCountry: string | null) {
  const { config, prices } = ctx.gate;
  const from = currentTier(config, ctx.subscription, ctx.plan);
  const to = dearerTier(config, from, tierOfCountry(config, cardCountry));
  if (to === from) return undefined;
  const lookupKey = lookupKeyFor(config, to, ctx.plan);
  const price = (await prices.get([lookupKey])).get(lookupKey)!;
  return { from, to, price };
}

async function replaceCard(
  ctx: ManageContext,
  confirmationToken: string,
  acceptedRenewalAmount: number | undefined
): Promise<ManageWebSubscriptionResult> {
  const { gateway } = ctx.gate;
  const token = await readConfirmationToken(gateway, confirmationToken, ctx.deps.now(), "off_session", (problem) =>
    logWebInfo("web_subscription_manage_token_refused", ctx.operationId, { uid: ctx.uid, problem })
  );
  const card = cardFromToken(token);
  const change = await priceChangeFor(ctx, card.country);
  if (change && acceptedRenewalAmount !== change.price.amount) {
    logWebInfo("web_subscription_manage_reprice", ctx.operationId, {
      uid: ctx.uid,
      subscriptionId: ctx.subscription.id,
      from: change.from,
      to: change.to,
      amount: change.price.amount,
    });
    return {
      status: "reprice",
      quote: {
        plan: ctx.plan,
        tier: change.to,
        amount: change.price.amount,
        tax: 0,
        total: change.price.amount,
        currency: change.price.currency,
        reason: "card_country",
      },
    };
  }

  const key = crypto.createHash("sha256").update(`${ctx.uid}:${confirmationToken}`, "utf8").digest("hex").slice(0, 32);
  let intent: Stripe.SetupIntent;
  try {
    intent = await gateway.createSetupIntent(
      {
        customer: ctx.customerId,
        usage: "off_session",
        confirm: true,
        confirmation_token: confirmationToken,
        // Cards only. Without it Stripe offers the Dashboard's methods, demands a return_url
        // for the redirecting ones, and spends the token on the refusal (seen in the sandbox).
        allowed_payment_method_types: ["card"],
        metadata: { uid: ctx.uid, subscriptionId: ctx.subscription.id, purpose: "replace_card" },
      },
      `seti_${key}`
    );
  } catch (error) {
    if (isCardError(error)) throw cardDeclined(declineCategory(error));
    if (isTokenError(error)) throw tokenInvalid();
    throw error;
  }
  logWebInfo("web_subscription_manage_setup", ctx.operationId, { uid: ctx.uid, setupIntent: shortId(intent.id), status: intent.status });
  return settleSetupIntent(ctx, intent);
}

async function finishReplaceCard(ctx: ManageContext, setupIntentId: string): Promise<ManageWebSubscriptionResult> {
  let intent: Stripe.SetupIntent;
  try {
    intent = await ctx.gate.gateway.retrieveSetupIntent(setupIntentId);
  } catch (error) {
    if (isResourceMissing(error)) throw setupIntentNotFound();
    throw error;
  }
  if (idOf(intent.customer as string | { id: string } | null) !== ctx.customerId) {
    logWebInfo("web_subscription_manage_foreign_setup", ctx.operationId, { uid: ctx.uid, setupIntent: shortId(setupIntentId) });
    throw setupIntentNotFound();
  }
  return settleSetupIntent(ctx, intent);
}

function setupIntentNotFound() {
  return refusal("not-found", "No such card change.", "setup_intent_not_found");
}

async function settleSetupIntent(ctx: ManageContext, intent: Stripe.SetupIntent): Promise<ManageWebSubscriptionResult> {
  if (intent.status === "requires_action" && intent.client_secret) {
    return { status: "requires_action", setupIntentId: intent.id, clientSecret: intent.client_secret };
  }
  if (intent.status === "requires_payment_method") {
    throw cardDeclined(categoryOfLastError(intent.last_setup_error));
  }
  const paymentMethodId = idOf(intent.payment_method as string | { id: string } | null);
  if (intent.status !== "succeeded" || !paymentMethodId) {
    throw refusal("failed-precondition", "The card change is not complete.", "setup_incomplete");
  }
  return applyCard(ctx, paymentMethodId);
}

/**
 * Makes a saved card the subscription's card, in one `subscriptions.update` (recipe E13, and
 * E14 for the price): a card from a dearer tier also moves the item to that tier's price from
 * the next renewal, without proration; a card from the same or a cheaper tier never lowers it.
 * A past-due subscription then has its open invoice paid with the new card.
 */
async function applyCard(ctx: ManageContext, paymentMethodId: string): Promise<ManageWebSubscriptionResult> {
  const { gateway } = ctx.gate;
  const method = await gateway.retrievePaymentMethod(paymentMethodId);
  if (idOf(method.customer as string | { id: string } | null) !== ctx.customerId || method.type !== "card") {
    throw setupIntentNotFound();
  }
  const cardCountry = method.card?.country ?? null;
  const change = await priceChangeFor(ctx, cardCountry);
  const params: Stripe.SubscriptionUpdateParams = { default_payment_method: paymentMethodId };
  if (change) {
    params.items = [{ id: ctx.subscription.items.data[0].id, price: change.price.priceId }];
    params.proration_behavior = "none";
    params.metadata = { tier: change.to };
  }
  const updated = await gateway.updateSubscription(ctx.subscription.id, params);
  logWebInfo("web_subscription_card_applied", ctx.operationId, {
    uid: ctx.uid,
    subscriptionId: ctx.subscription.id,
    cardCountry,
    priceChanged: Boolean(change),
    ...(change ? { from: change.from, to: change.to } : {}),
  });

  if (updated.status === "past_due" || updated.status === "unpaid") {
    const invoiceId = idOf(updated.latest_invoice as string | { id: string } | null);
    const invoice = invoiceId ? await gateway.retrieveInvoice(invoiceId) : undefined;
    if (invoice?.status === "open") {
      try {
        await gateway.payInvoice(invoice.id!, { payment_method: paymentMethodId }, `pay_${invoice.id}_${paymentMethodId}`);
        logWebInfo("web_subscription_past_due_paid", ctx.operationId, { uid: ctx.uid, invoiceId: invoice.id });
      } catch (error) {
        if (!isCardError(error)) throw error;
        await sync(ctx, "replace_card");
        logWebInfo("web_subscription_past_due_declined", ctx.operationId, { uid: ctx.uid, stripeCode: stripeErrorCode(error) });
        throw cardDeclined(declineCategory(error));
      }
    }
  }
  await sync(ctx, "replace_card");
  return { status: "succeeded" };
}
