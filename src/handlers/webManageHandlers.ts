import * as crypto from "crypto";
import { Timestamp } from "firebase-admin/firestore";
import * as functions from "firebase-functions";
import type Stripe from "stripe";
import {
  existingPremium,
  PremiumSource,
  readWebAccountSlots,
  StoreSubscriptionSummary,
  storeSubscriptionOf,
  webSlotView,
  WebAccountState,
} from "../services/webSubscriptions/accountState";
import { customerIdFor, readCustomerMapping } from "../services/webSubscriptions/customers";
import {
  isWebPlan,
  ledgerEntryFromData,
  purchaseIdFor,
  WEB_PURCHASES_COLLECTION,
  WebPlan,
  WebPurchaseEntry,
} from "../services/webSubscriptions/ledger";
import { stopPendingStripeSide } from "../services/webSubscriptions/pendingSweep";
import {
  assertSaleAllowed,
  cardFromToken,
  chargedTier,
  dearerTier,
  invoiceAmounts,
  knownCountryList,
  KnownTier,
  knownTier,
  lookupKeyFor,
  quoteTotal,
  savedCardOf,
  SavedCard,
  saveTaxAddress,
  TaxAddress,
  tierOfCountry,
  unusedTimeCredit,
  WebPrice,
  WebPricingConfig,
} from "../services/webSubscriptions/pricing";
import { idOf, isResourceMissing, shortId, StripeGateway, stripeErrorCode } from "../services/webSubscriptions/stripeGateway";
import { chargeOfInvoice, servicePeriodEnd, syncWebEntitlement, WebSyncDeps } from "../services/webSubscriptions/sync";
import { hasAppCheck, refusal, requireCaller } from "../utils/callableAuth";
import {
  cardDeclined,
  categoryOfLastError,
  CONFIRMATION_TOKEN_PATTERN,
  consumeWebThrottle,
  DeclineCategory,
  declineCategory,
  invalidRequest,
  isCardError,
  isInvalidRequestError,
  isTokenError,
  logWebInfo,
  openWebGate,
  optionalCents,
  readConfirmationToken,
  readRequestObject,
  readWebLang,
  refusalWith,
  requiredString,
  tokenInvalid,
  toWebCallableError,
  WebCallableDeps,
  WebCallerContext,
  WebGate,
} from "./webCallableCommon";
import {
  abandonOlderPending,
  awaitSettled,
  createLifetimeInvoice,
  createLockedEntry,
  readBillingState,
  lockHolderNow,
  PURCHASE_ID_PATTERN,
  PURCHASE_LOCK_MS,
  settleUnstarted,
  WebQuote,
} from "./webPurchaseHandlers";

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
  /**
   * True when the subscription's renewals are taxed, read from the slot's `web.lastPaidTaxed` (its
   * latest paid invoice carried tax, recorded by the sync), so the page says `amount` is before tax
   * ("plus tax"). False when it carried none or there is no subscription. Added after the first page shipped, which ignores it; the page reads
   * a missing value as false.
   */
  renewalTaxed: boolean;
  currency?: string;
  /** ISO 8601. */
  renewsAt?: string;
  endsAt?: string;
  card?: { brand: string; last4: string };
  /** The ledger entry behind the slot, for `finishWebPurchase` after authenticating. */
  purchaseId?: string;
  storeSubscription: StoreSubscriptionSummary | null;
  /**
   * Every source of premium the account holds now, from the same reader as `getWebPlans`, so the
   * page can say where premium that is not from this site comes from. Added after the first page
   * shipped, which ignores it.
   */
  premium: PremiumSource[];
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
      await syncWebEntitlement(uid, { firestore: deps.firestore, gateway, now: deps.now, notify: deps.notify }, { operationId, trigger: "subscription_read" });
    }

    state.stage = "read";
    const now = deps.now();
    const slots = await readWebAccountSlots(deps.firestore, uid, gateway.livemode);
    const view = webSlotView(slots.web, now);
    const result: WebSubscriptionResult = {
      state: view.state,
      renewalTaxed: (view.state === "active" || view.state === "cancelling") && view.lastPaidTaxed,
      storeSubscription: storeSubscriptionOf(slots, now),
      premium: existingPremium(slots, now),
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
          const card = await cardOf(gateway, idOf(subscription.default_payment_method as string | { id: string } | null), customerId);
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

/** The brand and last four digits of a saved card, which is all a page is ever shown of it. */
function shownCard(card: SavedCard | undefined): { brand: string; last4: string } | undefined {
  return card?.brand && card.last4 ? { brand: card.brand, last4: card.last4 } : undefined;
}

async function cardOf(gateway: StripeGateway, paymentMethodId: string | undefined, customerId: string) {
  return shownCard(await savedCardOf(gateway, paymentMethodId, customerId));
}

// ---------------------------------------------------------------------------
// manageWebSubscription
// ---------------------------------------------------------------------------

export type ManageWebSubscriptionResult =
  | { status: "succeeded" }
  | { status: "reprice"; quote: WebQuote }
  | { status: "requires_action"; setupIntentId: string; clientSecret: string }
  | { clientSecret: string; purchaseId?: string }
  | SwitchResult
  | LifetimeResult;

/** Where a charge made from `/manage` (a plan switch or an upgrade to lifetime) stands. */
export type ChargeOutcome =
  | { status: "succeeded"; purchaseId: string }
  | { status: "requires_action"; purchaseId: string; clientSecret: string };

/** The answers of the three plan switch actions. */
export type SwitchResult = { status: "quote"; quote: SwitchQuote } | { status: "reprice"; quote: SwitchQuote } | ChargeOutcome;

/** The answers of the three lifetime upgrade actions. */
export type LifetimeResult = { status: "quote"; quote: LifetimeQuote } | { status: "reprice"; quote: LifetimeQuote } | ChargeOutcome;

type ManageRequest =
  | { action: "cancel" | "resume" | "authenticate" | "quote_switch_yearly" }
  | { action: "quote_lifetime"; billingState?: string }
  | { action: "replace_card"; confirmationToken: string; acceptedRenewalAmount?: number }
  | { action: "finish_replace_card"; setupIntentId: string }
  | { action: "switch_yearly"; acceptedTotal: number; attemptId: string; lang: "ar" | "en" }
  | { action: "finish_switch_yearly"; purchaseId: string }
  | { action: "buy_lifetime"; acceptedTotal: number; attemptId: string; lang: "ar" | "en"; billingState?: string }
  | { action: "finish_lifetime"; purchaseId: string };

/** A random id the page makes once per confirmation, such as a UUID. */
const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9-]{16,64}$/;

function readManageRequest(data: unknown): ManageRequest {
  const action = (data as { action?: unknown } | null)?.action;
  switch (action) {
    case "cancel":
    case "resume":
    case "authenticate":
    case "quote_switch_yearly":
      readRequestObject(data, ["action"]);
      return { action };
    case "quote_lifetime": {
      // `billingState`: the province the buyer chose after `billing_address_incomplete` with `province: true`.
      const request = readRequestObject(data, ["action", "billingState"]);
      const billingState = readBillingState(request.billingState);
      return { action, ...(billingState ? { billingState } : {}) };
    }
    case "switch_yearly": {
      const request = readRequestObject(data, ["action", "acceptedTotal", "attemptId", "lang"]);
      const acceptedTotal = optionalCents(request.acceptedTotal);
      if (acceptedTotal === undefined) throw invalidRequest();
      return { action, acceptedTotal, attemptId: requiredString(request.attemptId, ATTEMPT_ID_PATTERN), lang: readWebLang(request.lang) };
    }
    case "buy_lifetime": {
      const request = readRequestObject(data, ["action", "acceptedTotal", "attemptId", "lang", "billingState"]);
      const acceptedTotal = optionalCents(request.acceptedTotal);
      if (acceptedTotal === undefined) throw invalidRequest();
      const billingState = readBillingState(request.billingState);
      return {
        action,
        acceptedTotal,
        attemptId: requiredString(request.attemptId, ATTEMPT_ID_PATTERN),
        lang: readWebLang(request.lang),
        ...(billingState ? { billingState } : {}),
      };
    }
    case "finish_switch_yearly":
    case "finish_lifetime": {
      const request = readRequestObject(data, ["action", "purchaseId"]);
      return { action, purchaseId: requiredString(request.purchaseId, PURCHASE_ID_PATTERN) };
    }
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

/** What settling a charge already made needs: the caller's customer, not a running subscription. */
interface ChargeContext {
  uid: string;
  operationId: string;
  deps: WebCallableDeps;
  gate: WebGate;
  syncDeps: WebSyncDeps;
  customerId: string;
}

interface ManageContext extends ChargeContext {
  subscription: Stripe.Subscription;
  plan: WebPlan;
  state: WebAccountState;
  purchaseId?: string;
}

/**
 * Changes the caller's own web subscription: cancel at period end, resume, replace the card,
 * switch from monthly to yearly, upgrade to lifetime, or hand the page what it needs to
 * authenticate a renewal.
 *
 * Quoting and making a switch or an upgrade need sales open, since each is a sale; finishing one
 * already charged needs only the key.
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
    const sale = ["quote_switch_yearly", "switch_yearly", "quote_lifetime", "buy_lifetime"].includes(request.action);
    const gate = await openWebGate(uid, deps, { sales: sale });
    logWebInfo(`${event}_start`, operationId, { uid, action: request.action, livemode: gate.gateway.livemode, appCheck: hasAppCheck(context) });

    state.stage = "subscription";
    const settled = await settleUpgradeEarly(uid, operationId, deps, gate, request);
    if (settled) {
      logWebInfo(`${event}_success`, operationId, { uid, action: request.action, status: settled.status });
      return settled;
    }
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
      case "quote_switch_yearly":
        assertSwitchable(ctx);
        await assertChargeAllowed(ctx);
        result = { status: "quote", quote: (await planSwitch(ctx)).quote };
        break;
      case "switch_yearly":
        result = await switchYearly(ctx, request, context);
        break;
      case "finish_switch_yearly":
        result = await finishCharge(ctx, request.purchaseId, "switch");
        break;
      case "quote_lifetime":
        assertUpgradable(ctx);
        await assertChargeAllowed(ctx);
        result = { status: "quote", quote: (await planLifetime(ctx, "ar", request.billingState)).quote };
        break;
      case "buy_lifetime":
        result = await buyLifetime(ctx, request, context);
        break;
      case "finish_lifetime":
        // Settled by `settleUpgradeEarly`; kept so every action has its case.
        result = await finishCharge(ctx, request.purchaseId, "upgrade");
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

/**
 * Finishing an upgrade, or repeating one already started, needs no running subscription: once the
 * lifetime invoice is paid the sync cancels it and the slot is lifetime, which `manageContext`
 * refuses. These are settled from the ledger entry and the customer alone.
 */
async function settleUpgradeEarly(
  uid: string,
  operationId: string,
  deps: WebCallableDeps,
  gate: WebGate,
  request: ManageRequest
): Promise<ChargeOutcome | undefined> {
  if (request.action !== "finish_lifetime" && request.action !== "buy_lifetime") return undefined;
  const purchaseId = request.action === "finish_lifetime" ? request.purchaseId : purchaseIdFor(uid, request.attemptId);
  const entry = ledgerEntryFromData(purchaseId, (await deps.firestore.collection(WEB_PURCHASES_COLLECTION).doc(purchaseId).get()).data());
  if (request.action === "buy_lifetime" && !entry) return undefined;
  const customerId = customerIdFor(await readCustomerMapping(deps.firestore, uid), gate.gateway.livemode);
  if (!customerId) throw noSubscription();
  const syncDeps: WebSyncDeps = { firestore: deps.firestore, gateway: gate.gateway, now: deps.now, notify: deps.notify };
  const ctx: ChargeContext = { uid, operationId, deps, gate, syncDeps, customerId };
  return settleChargeAttempt(ctx, entry, request.action === "finish_lifetime" ? "finish" : "retried", "upgrade");
}

function noSubscription() {
  return refusal("failed-precondition", "There is no web subscription to change.", "no_subscription");
}

/** The caller's customer and the open subscription its web slot names, or `no_subscription`. */
async function manageContext(uid: string, operationId: string, deps: WebCallableDeps, gate: WebGate): Promise<ManageContext> {
  const { gateway } = gate;
  const customerId = customerIdFor(await readCustomerMapping(deps.firestore, uid), gateway.livemode);
  if (!customerId) throw noSubscription();
  const syncDeps: WebSyncDeps = { firestore: deps.firestore, gateway, now: deps.now, notify: deps.notify };
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
  return { uid, operationId, deps, gate, syncDeps, customerId, subscription, plan: product, state: view.state, purchaseId: view.purchaseId };
}

async function sync(ctx: ChargeContext, trigger: string): Promise<void> {
  await syncWebEntitlement(ctx.uid, ctx.syncDeps, { operationId: ctx.operationId, trigger: `manage_${trigger}` });
}

/** The client secret of the open invoice's payment waiting for the buyer to authenticate. */
async function authenticate(ctx: ManageContext): Promise<ManageWebSubscriptionResult> {
  const invoiceId = idOf(ctx.subscription.latest_invoice as string | { id: string } | null);
  if (invoiceId) {
    const invoice = await ctx.gate.gateway.retrieveInvoice(invoiceId, ["payments"]);
    // A plan switch's open invoice is the switch's to finish, under its own purchase.
    const renewal = invoice.billing_reason !== "subscription_update";
    if (renewal && invoice.status === "open" && idOf(invoice.customer as string | { id: string } | null) === ctx.customerId) {
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

/**
 * Refuses a switch or an upgrade when the buyer is in a country this site does not sell in, by
 * the account's known countries, the saved card's country and the customer's address country.
 * Called by the quote actions too, so a blocked buyer is told when the panel opens.
 */
async function assertChargeAllowed(ctx: ManageContext): Promise<void> {
  const { config, gateway } = ctx.gate;
  if (config.blockedCountries.length === 0) return;
  const known = knownCountryList(await ctx.deps.storeCountry.knownCountries(ctx.uid));
  assertSaleAllowed(config, { known });
  const card = await savedCardOf(gateway, idOf(ctx.subscription.default_payment_method as string | { id: string } | null), ctx.customerId);
  const customer = await gateway.retrieveCustomer(ctx.customerId);
  const billing = "deleted" in customer && customer.deleted ? null : (customer as Stripe.Customer).address?.country ?? null;
  assertSaleAllowed(config, { known, card: card?.country ?? null, billing });
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
  // Before any SetupIntent: the saved card and the subscription stay as they are. Only the new
  // card counts, never the account's known country: a card change keeps a subscription alive.
  assertSaleAllowed(ctx.gate.config, {
    card: card.country,
    billing: token.payment_method_preview?.billing_details?.address?.country ?? null,
  });
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

// ---------------------------------------------------------------------------
// Switching from monthly to yearly
// ---------------------------------------------------------------------------

/** What `/manage` shows before a plan switch. Integer cents. */
export interface SwitchQuote {
  plan: "web_yearly";
  tier: string;
  /** The yearly price, before tax. */
  amount: number;
  /** The unused days of the month, a positive number taken off the amount. */
  credit: number;
  tax: number;
  /** What the saved card is charged today. */
  total: number;
  currency: string;
  /** ISO 8601: the end of the year the switch pays for, a year from the switch. */
  renewsAt: string;
  /** Left out when the saved card cannot be read; the charge then fails as a decline. */
  card?: { brand: string; last4: string };
}

function switchUnavailable(cause: "not_monthly" | "payment_due" | "changed") {
  return refusalWith("failed-precondition", "This subscription cannot be switched to yearly.", "switch_unavailable", { cause });
}

/**
 * Only a monthly subscription that is paid up switches: active or cancelling, its Stripe status
 * `active`. A past-due one would have its renewal and the switch due at once.
 */
function assertSwitchable(ctx: ManageContext): void {
  if (ctx.plan !== "web_monthly") throw switchUnavailable("not_monthly");
  if ((ctx.state !== "active" && ctx.state !== "cancelling") || ctx.subscription.status !== "active") {
    throw switchUnavailable("payment_due");
  }
}

interface SwitchPlan {
  quote: SwitchQuote;
  price: WebPrice;
  known: KnownTier;
  card: SavedCard | undefined;
}

/**
 * The change a switch makes, identical in the preview and the update: the one item to the yearly
 * price, the unused days credited on an invoice raised now, the year starting today, and renewal
 * turned back on for a subscription that was cancelled.
 */
function switchChange(ctx: ManageContext, price: WebPrice) {
  return {
    items: [{ id: ctx.subscription.items.data[0].id, price: price.priceId }],
    proration_behavior: "always_invoice" as const,
    billing_cycle_anchor: { type: "now" as const },
    cancel_at_period_end: false,
  };
}

/**
 * Prices a switch as a new yearly purchase is priced, then has Stripe preview the invoice the
 * change raises; the quote is that preview.
 *
 * The tier is the dearer of the account's known tier and the saved card's country, and a card
 * whose country is unknown prices as the full tier. The anchor reset cannot be combined with a
 * fixed proration date, so Stripe works out the credit at the moment of each call, and it can move
 * by a cent between the quote and the charge; `switchYearly` previews again for that reason.
 */
async function planSwitch(ctx: ManageContext): Promise<SwitchPlan> {
  const { config, gateway, prices } = ctx.gate;
  const card = await savedCardOf(gateway, idOf(ctx.subscription.default_payment_method as string | { id: string } | null), ctx.customerId);
  const known = knownTier(config, await ctx.deps.storeCountry.knownCountries(ctx.uid));
  const tier = chargedTier(config, known.tier, card?.country ?? null);
  const lookupKey = lookupKeyFor(config, tier, "web_yearly");
  const price = (await prices.get([lookupKey])).get(lookupKey)!;
  const preview = await gateway.createInvoicePreview({
    customer: ctx.customerId,
    subscription: ctx.subscription.id,
    subscription_details: switchChange(ctx, price),
  });
  const amounts = invoiceAmounts(preview);
  const quote: SwitchQuote = {
    plan: "web_yearly",
    tier,
    amount: amounts.amount,
    credit: amounts.credit,
    tax: amounts.tax,
    total: amounts.total,
    currency: amounts.currency,
    renewsAt: (servicePeriodEnd(preview) ?? ctx.deps.now()).toISOString(),
  };
  const shown = shownCard(card);
  if (shown) quote.card = shown;
  return { quote, price, known, card };
}

const purchaseInProgress = () => refusal("failed-precondition", "Another purchase is in progress.", "purchase_in_progress");
const switchNotFound = () => refusal("not-found", "No such purchase.", "purchase_not_found");

/**
 * Charges the switch, in the stage I contract's order.
 *
 * The purchase id comes from the uid and the page's `attemptId`, and the update carries a key
 * built from it, so a repeated call returns its attempt's outcome and never charges twice. The
 * update uses `pending_if_incomplete`: Stripe applies the price, the anchor, the renewal and the
 * metadata only once the invoice is paid, so a decline leaves the monthly plan with its dates.
 */
async function switchYearly(
  ctx: ManageContext,
  request: { acceptedTotal: number; attemptId: string; lang: "ar" | "en" },
  context: WebCallerContext
): Promise<SwitchResult> {
  const { gateway } = ctx.gate;
  const { firestore } = ctx.deps;
  const purchaseId = purchaseIdFor(ctx.uid, request.attemptId);
  const ledgerRef = firestore.collection(WEB_PURCHASES_COLLECTION).doc(purchaseId);
  const existing = ledgerEntryFromData(purchaseId, (await ledgerRef.get()).data());
  if (existing) return settleChargeAttempt(ctx, existing, "retried", "switch");

  await consumeWebThrottle(ctx.deps, ctx.uid, context);
  assertSwitchable(ctx);
  // Before the earlier switch's invoice is voided: a refused buyer changes nothing at Stripe.
  await assertChargeAllowed(ctx);
  // Checked before voiding an earlier attempt's invoice, which may belong to a call still waiting
  // for its bank step; the lock itself is taken with the entry below.
  if (await lockHolderNow(ctx)) throw purchaseInProgress();
  await voidEarlierSwitch(ctx);

  const plan = await planSwitch(ctx);
  if (plan.quote.total !== request.acceptedTotal) {
    logWebInfo("web_subscription_switch_reprice", ctx.operationId, {
      uid: ctx.uid,
      subscriptionId: ctx.subscription.id,
      accepted: request.acceptedTotal,
      total: plan.quote.total,
    });
    return { status: "reprice", quote: plan.quote };
  }

  const previous = ctx.purchaseId
    ? ledgerEntryFromData(ctx.purchaseId, (await firestore.collection(WEB_PURCHASES_COLLECTION).doc(ctx.purchaseId).get()).data())
    : undefined;
  const own = previous?.uid === ctx.uid ? previous : undefined;
  const now = ctx.deps.now();
  const entry: WebPurchaseEntry = {
    purchaseId,
    uid: ctx.uid,
    plan: "web_yearly",
    kind: "switch",
    switchedFrom: "web_monthly",
    tierShown: plan.known.tier,
    tierCharged: plan.quote.tier,
    lookupKey: plan.price.lookupKey,
    priceId: plan.price.priceId,
    amount: plan.quote.amount,
    credit: plan.quote.credit,
    tax: plan.quote.tax,
    total: plan.quote.total,
    currency: plan.quote.currency,
    knownCountry: plan.known.knownCountry,
    cardCountry: plan.card?.country ?? null,
    cardFunding: plan.card?.funding ?? null,
    wallet: plan.card?.wallet ?? null,
    billingCountry: own?.billingCountry ?? null,
    billingState: own?.billingState ?? null,
    livemode: gateway.livemode,
    lang: request.lang,
    status: "pending",
    stripe: { customerId: ctx.customerId, subscriptionId: ctx.subscription.id },
    createdAt: now,
    updatedAt: now,
  };
  const locked = await createLockedEntry(ctx, entry);
  if (locked.kind === "existing") return settleChargeAttempt(ctx, locked.entry, "retried", "switch");
  if (locked.kind === "busy") {
    logWebInfo("web_subscription_switch_busy", ctx.operationId, { uid: ctx.uid, purchaseId, activePurchase: locked.activePurchaseId });
    throw purchaseInProgress();
  }
  const superseded = await clearOlderAttempts(ctx, entry);
  if (superseded) return superseded;

  let updated: Stripe.Subscription;
  try {
    updated = await gateway.updateSubscription(
      ctx.subscription.id,
      {
        ...switchChange(ctx, plan.price),
        payment_behavior: "pending_if_incomplete",
        metadata: { plan: "web_yearly", tier: plan.quote.tier, purchaseId },
        expand: ["latest_invoice.payments"],
      },
      `switch_${purchaseId}`
    );
  } catch (error) {
    if (isCardError(error)) {
      const category = declineCategory(error);
      await settleUnstarted(ctx, purchaseId, "failed", category);
      throw cardDeclined(category);
    }
    if (isInvalidRequestError(error)) {
      // Stripe refused the change itself, so nothing was charged.
      await settleUnstarted(ctx, purchaseId, "failed", `update_${stripeErrorCode(error) ?? "invalid_request"}`);
    }
    // Anything else may have charged: the entry stays pending for the sweep.
    throw error;
  }
  const invoice = typeof updated.latest_invoice === "object" ? updated.latest_invoice : undefined;
  if (!invoice?.id || invoice.billing_reason !== "subscription_update") {
    // Not the switch's invoice: left pending, and the sweep resolves it from the subscription.
    throw new Error("switch without its invoice");
  }
  const paymentIntentId = paymentIntentOfInvoice(invoice);
  entry.stripe.invoiceId = invoice.id;
  if (paymentIntentId) entry.stripe.paymentIntentId = paymentIntentId;
  // The invoice's amounts are final once it exists, and may differ from the preview by the cent
  // the credit moved; recorded now, so a webhook's sync after a bank step emails what was charged.
  const charged = invoiceAmounts(invoice);
  Object.assign(entry, { amount: charged.amount, credit: charged.credit, tax: charged.tax, total: charged.total });
  await ledgerRef.update({
    "stripe.invoiceId": invoice.id,
    ...(paymentIntentId ? { "stripe.paymentIntentId": paymentIntentId } : {}),
    amount: charged.amount,
    credit: charged.credit,
    tax: charged.tax,
    total: charged.total,
    updatedAt: Timestamp.fromDate(ctx.deps.now()),
  });
  logWebInfo("web_subscription_switch_updated", ctx.operationId, {
    uid: ctx.uid,
    purchaseId,
    invoiceId: invoice.id,
    invoiceStatus: invoice.status,
    pendingUpdate: Boolean(updated.pending_update),
  });
  return outcomeOfCharge(ctx, entry, invoice);
}

/**
 * Run once a new switch or upgrade holds the account's lock, before anything is charged.
 *
 * Every older pending attempt of the account, of any kind, is abandoned and its invoice voided,
 * so a bank step left open in another tab can no longer be completed behind this charge (two
 * lifetimes, or a lifetime cancelling the yearly plan just paid for). One that turned out paid
 * wins: this attempt is abandoned and that one's success is the answer. Then the subscription
 * is read again; when it changed since the quote (another tab's switch or upgrade landed), this
 * attempt is abandoned and refused, and the page reloads its view.
 */
async function clearOlderAttempts(ctx: ManageContext, entry: WebPurchaseEntry): Promise<ChargeOutcome | undefined> {
  const label = chargeLabel(entry);
  const olderPaid = await abandonOlderPending(ctx, entry.purchaseId);
  if (olderPaid) {
    await settleUnstarted(ctx, entry.purchaseId, "abandoned", "older_paid");
    await sync(ctx, label.trigger);
    logWebInfo(`web_subscription_${label.log}_older_paid`, ctx.operationId, { uid: ctx.uid, purchaseId: entry.purchaseId, olderPaid });
    return { status: "succeeded", purchaseId: olderPaid };
  }
  const now = await ctx.gate.gateway.retrieveSubscription(ctx.subscription.id);
  const changed = now.status !== "active" || Boolean(now.pending_update) ||
    now.items.data[0]?.price?.id !== ctx.subscription.items.data[0]?.price?.id;
  if (!changed) return undefined;
  await settleUnstarted(ctx, entry.purchaseId, "abandoned", "subscription_changed");
  logWebInfo(`web_subscription_${label.log}_changed`, ctx.operationId, { uid: ctx.uid, purchaseId: entry.purchaseId, status: now.status });
  throw entry.kind === "upgrade" ? lifetimeUnavailable("changed") : switchUnavailable("changed");
}

/** The PaymentIntent paying an invoice, from its default payment row. */
function paymentIntentOfInvoice(invoice: Stripe.Invoice): string | undefined {
  const payments = invoice.payments?.data ?? [];
  const payment = payments.find((row) => row.is_default) ?? payments[0];
  return idOf(payment?.payment?.payment_intent ?? null);
}

/**
 * Voids the open invoice an earlier switch left, which drops the change Stripe holds for it and
 * the retry Stripe scheduled on it, so the new attempt starts from the monthly plan. The sync
 * then marks that attempt's entry.
 */
async function voidEarlierSwitch(ctx: ManageContext): Promise<void> {
  if (!ctx.subscription.pending_update) return;
  const { gateway } = ctx.gate;
  const invoiceId = idOf(ctx.subscription.latest_invoice as string | { id: string } | null);
  if (!invoiceId) return;
  const invoice = await gateway.retrieveInvoice(invoiceId);
  if (invoice.status !== "open" || invoice.billing_reason !== "subscription_update") return;
  await gateway.voidInvoice(invoiceId);
  logWebInfo("web_subscription_switch_earlier_voided", ctx.operationId, { uid: ctx.uid, invoiceId });
  await sync(ctx, "switch_yearly");
}

/** The name a charge's log lines and sync trigger carry. */
function chargeLabel(entry: WebPurchaseEntry): { log: "switch" | "lifetime"; trigger: string } {
  return entry.kind === "upgrade" ? { log: "lifetime", trigger: "buy_lifetime" } : { log: "switch", trigger: "switch_yearly" };
}

/** Where a charge stands from its invoice: paid, waiting for the bank, or declined. */
async function outcomeOfCharge(ctx: ChargeContext, entry: WebPurchaseEntry, invoice: Stripe.Invoice): Promise<ChargeOutcome> {
  if (invoice.status === "paid") return settleChargePaid(ctx, entry, invoice);
  const intentId = entry.stripe.paymentIntentId;
  const intent = intentId ? await ctx.gate.gateway.retrievePaymentIntent(intentId) : undefined;
  if (invoice.status === "open" && intent?.status === "requires_action" && intent.client_secret) {
    logWebInfo(`web_subscription_${chargeLabel(entry).log}_requires_action`, ctx.operationId, { uid: ctx.uid, purchaseId: entry.purchaseId });
    return { status: "requires_action", purchaseId: entry.purchaseId, clientSecret: intent.client_secret };
  }
  const category: DeclineCategory = intent?.last_payment_error
    ? categoryOfLastError(intent.last_payment_error)
    : intent?.status === "requires_payment_method"
      ? "declined"
      : "authentication_failed";
  return failCharge(ctx, entry, category);
}

/**
 * A charge whose payment did not go through: the entry is marked failed with its category, then
 * its open invoice is voided, so Stripe never retries the charge (and, for a switch, drops the
 * pending change).
 *
 * The failure is recorded before the void because the void's `invoice.voided` webhook syncs the
 * account, and a sync that came first would mark the entry abandoned with no category. A payment
 * that went through after all settles as paid; the sync then heals the entry from its paid invoice.
 */
async function failCharge(ctx: ChargeContext, entry: WebPurchaseEntry, category: DeclineCategory): Promise<ChargeOutcome> {
  const { gateway } = ctx.gate;
  const invoiceId = entry.stripe.invoiceId!;
  const intent = entry.stripe.paymentIntentId ? await gateway.retrievePaymentIntent(entry.stripe.paymentIntentId) : undefined;
  if (intent?.status === "succeeded" || intent?.status === "processing") {
    return settleChargePaid(ctx, entry, await gateway.retrieveInvoice(invoiceId, ["payments"]));
  }
  await settleUnstarted(ctx, entry.purchaseId, "failed", category);
  let invoice = await gateway.retrieveInvoice(invoiceId, ["payments"]);
  if (invoice.status === "open") {
    try {
      invoice = await gateway.voidInvoice(invoiceId);
    } catch (error) {
      // Paid between the read and the void: Stripe refuses to void it.
      if (!isInvalidRequestError(error)) throw error;
      invoice = await gateway.retrieveInvoice(invoiceId, ["payments"]);
    }
  }
  if (invoice.status === "paid") return settleChargePaid(ctx, entry, invoice);
  await sync(ctx, chargeLabel(entry).trigger);
  logWebInfo(`web_subscription_${chargeLabel(entry).log}_declined`, ctx.operationId, { uid: ctx.uid, purchaseId: entry.purchaseId, category });
  throw cardDeclined(category);
}

/**
 * Records what the paid invoice charged on the entry, so the ledger and the email carry the
 * amounts taken rather than the quote's, then syncs. A sync failure is logged and the answer is
 * still success: the payment is taken, and the webhook and the sweep sync again.
 */
async function settleChargePaid(ctx: ChargeContext, entry: WebPurchaseEntry, invoice: Stripe.Invoice): Promise<ChargeOutcome> {
  const amounts = invoiceAmounts(invoice);
  const paymentIntentId = paymentIntentOfInvoice(invoice);
  const label = chargeLabel(entry);
  await ctx.deps.firestore.collection(WEB_PURCHASES_COLLECTION).doc(entry.purchaseId).update({
    "stripe.invoiceId": invoice.id,
    ...(paymentIntentId ? { "stripe.paymentIntentId": paymentIntentId } : {}),
    amount: amounts.amount,
    credit: amounts.credit,
    tax: amounts.tax,
    total: amounts.total,
    updatedAt: Timestamp.fromDate(ctx.deps.now()),
  });
  try {
    await sync(ctx, label.trigger);
  } catch (error) {
    functions.logger.warn(`web_subscription_${label.log}_after_payment_failure`, {
      operationId: ctx.operationId,
      uid: ctx.uid,
      purchaseId: entry.purchaseId,
      code: stripeErrorCode(error) ?? (error instanceof Error ? error.name : typeof error),
    });
  }
  logWebInfo(`web_subscription_${label.log}_paid`, ctx.operationId, { uid: ctx.uid, purchaseId: entry.purchaseId, total: amounts.total });
  return { status: "succeeded", purchaseId: entry.purchaseId };
}

/** After the page's bank step: the charge's outcome read again from its invoice. */
async function finishCharge(ctx: ChargeContext, purchaseId: string, kind: "switch" | "upgrade"): Promise<ChargeOutcome> {
  const entry = ledgerEntryFromData(
    purchaseId,
    (await ctx.deps.firestore.collection(WEB_PURCHASES_COLLECTION).doc(purchaseId).get()).data()
  );
  return settleChargeAttempt(ctx, entry, "finish", kind);
}

const DECLINE_CATEGORIES: readonly string[] = ["declined", "insufficient_funds", "expired_card", "incorrect_details", "authentication_failed"];

/**
 * The outcome of a charge already started, for a repeated `attemptId` or a finish action; never a
 * new charge. Someone else's attempt, or one of the other kind, reads exactly like a missing one.
 */
async function settleChargeAttempt(
  ctx: ChargeContext,
  entry: WebPurchaseEntry | undefined,
  why: "retried" | "finish",
  kind: "switch" | "upgrade"
): Promise<ChargeOutcome> {
  if (!entry || entry.uid !== ctx.uid || entry.livemode !== ctx.gate.gateway.livemode || entry.kind !== kind) {
    throw switchNotFound();
  }
  const label = chargeLabel(entry);
  logWebInfo(`web_subscription_${label.log}_settle`, ctx.operationId, { uid: ctx.uid, purchaseId: entry.purchaseId, why, status: entry.status });
  switch (entry.status) {
    case "pending":
      break;
    case "failed":
    case "abandoned":
      // Given up for another attempt or a changed subscription, not for the card: the page reloads.
      if (entry.failure === "older_paid" || entry.failure === "subscription_changed") {
        throw kind === "upgrade" ? lifetimeUnavailable("changed") : switchUnavailable("changed");
      }
      throw cardDeclined(DECLINE_CATEGORIES.includes(entry.failure ?? "") ? (entry.failure as DeclineCategory) : "declined");
    default:
      // Paid, and anything that followed a payment: the charge went through.
      return { status: "succeeded", purchaseId: entry.purchaseId };
  }
  const young = ctx.deps.now().getTime() - entry.createdAt.getTime() < PURCHASE_LOCK_MS;
  if (!entry.stripe.invoiceId) {
    // The first call may still be making the invoice or inside Stripe's update: while the lock
    // lasts nothing is written or voided. Only a switch can be settled then, once the subscription
    // names it (Stripe applies its metadata with the payment).
    if (young) {
      if (kind === "upgrade") throw purchaseInProgress();
      if (!entry.stripe.subscriptionId) throw purchaseInProgress();
      const subscription = await ctx.gate.gateway.retrieveSubscription(entry.stripe.subscriptionId);
      const invoiceId = idOf(subscription.latest_invoice as string | { id: string } | null);
      if (subscription.metadata?.purchaseId !== entry.purchaseId || !invoiceId) throw purchaseInProgress();
      const invoice = await ctx.gate.gateway.retrieveInvoice(invoiceId, ["payments"]);
      if (invoice.status !== "paid") throw purchaseInProgress();
      return settleChargePaid(ctx, entry, invoice);
    }
    // Past the lock, the first call has ended: resolved as the sweep does.
    if (await stopPendingStripeSide(ctx.syncDeps, entry)) {
      await sync(ctx, label.trigger);
      return { status: "succeeded", purchaseId: entry.purchaseId };
    }
    await settleUnstarted(ctx, entry.purchaseId, "failed", "not_completed");
    throw kind === "upgrade"
      ? refusal("failed-precondition", "The upgrade did not complete.", "lifetime_incomplete")
      : refusal("failed-precondition", "The switch did not complete.", "switch_incomplete");
  }
  const invoice = await ctx.gate.gateway.retrieveInvoice(entry.stripe.invoiceId, ["payments"]);
  if (idOf(invoice.customer as string | { id: string } | null) !== ctx.customerId) throw switchNotFound();
  if (young && invoice.status === "open" && (invoice.attempt_count ?? 0) === 0 && entry.stripe.paymentIntentId) {
    // The first call recorded the invoice and has not confirmed it yet: not a decline, and
    // nothing to void while it may still charge.
    const intent = await ctx.gate.gateway.retrievePaymentIntent(entry.stripe.paymentIntentId);
    if (intent.status === "requires_payment_method" && !intent.last_payment_error) throw purchaseInProgress();
  }
  return outcomeOfCharge(ctx, entry, invoice);
}

// ---------------------------------------------------------------------------
// Upgrading to lifetime
// ---------------------------------------------------------------------------

/** What `/manage` shows before an upgrade to lifetime. Integer cents. */
export interface LifetimeQuote {
  plan: "web_lifetime";
  tier: string;
  /** The lifetime price, before tax. */
  amount: number;
  /** The unused time of the subscription's paid period, a positive number taken off the amount. */
  credit: number;
  tax: number;
  /** What the saved card is charged today. */
  total: number;
  currency: string;
  /** The plan whose unused time is credited. */
  creditedPlan: WebPlan;
  /** Left out when the saved card cannot be read; nothing can then be charged. */
  card?: { brand: string; last4: string };
  /** The province the buyer chose, when the quote was taxed with it; send it back with `buy_lifetime`. */
  billingState?: string;
}

/** The credit's line on the invoice, in the buyer's language: Stripe shows it on the receipt. */
const CREDIT_DESCRIPTION: Record<"ar" | "en", Partial<Record<WebPlan, string>>> = {
  ar: {
    web_monthly: "خصم المدة غير المستخدمة من اشتراكك الشهري",
    web_yearly: "خصم المدة غير المستخدمة من اشتراكك السنوي",
  },
  en: {
    web_monthly: "Credit for the unused time of your monthly plan",
    web_yearly: "Credit for the unused time of your yearly plan",
  },
};

function lifetimeUnavailable(cause: "payment_due" | "changed" = "payment_due") {
  return refusalWith("failed-precondition", "This subscription cannot be upgraded to lifetime.", "lifetime_unavailable", { cause });
}

/**
 * Only a paid-up subscription upgrades: active or cancelling, its Stripe status `active`. A
 * past-due one has no unused time to credit, and lifetime is bought on `/subscribe` instead.
 */
function assertUpgradable(ctx: ManageContext): void {
  if ((ctx.state !== "active" && ctx.state !== "cancelling") || ctx.subscription.status !== "active") {
    throw lifetimeUnavailable();
  }
}

interface LifetimePlan {
  quote: LifetimeQuote;
  price: WebPrice;
  known: KnownTier;
  card: SavedCard | undefined;
  description: string;
  /** With tax on: the address the quote was taxed at, saved by the purchase and recorded on its entry. */
  taxAddress?: TaxAddress;
}

/**
 * Prices an upgrade as a new lifetime purchase is priced, less the credit `unusedTimeCredit` gives
 * for the subscription's latest paid invoice at this moment. The credit moves with time, so
 * `buyLifetime` quotes again and compares.
 */
async function planLifetime(ctx: ManageContext, lang: "ar" | "en" = "ar", billingState?: string): Promise<LifetimePlan> {
  const { config, gateway, prices } = ctx.gate;
  const card = await savedCardOf(gateway, idOf(ctx.subscription.default_payment_method as string | { id: string } | null), ctx.customerId);
  const known = knownTier(config, await ctx.deps.storeCountry.knownCountries(ctx.uid));
  const tier = chargedTier(config, known.tier, card?.country ?? null);
  const lookupKey = lookupKeyFor(config, tier, "web_lifetime");
  const price = (await prices.get([lookupKey])).get(lookupKey)!;
  const [paid] = await gateway.listInvoices({ subscription: ctx.subscription.id, status: "paid", limit: 1, expand: ["data.payments"] });
  const charge = paid ? await chargeOfInvoice(gateway, paid) : undefined;
  // The share of that payment the buyer still has after any refund by support.
  const kept = charge?.fullyRefunded ? 0 : charge?.amount ? (charge.amount - charge.amountRefunded) / charge.amount : 1;
  const credit = unusedTimeCredit(paid, ctx.deps.now(), price.amount, kept);
  const description = CREDIT_DESCRIPTION[lang][ctx.plan] ?? CREDIT_DESCRIPTION[lang].web_monthly!;
  const total = await quoteTotal(gateway, price, {
    taxEnabled: config.taxEnabled,
    customer: ctx.customerId,
    ...(credit > 0 ? { credit: { amount: credit, description } } : {}),
    ...(billingState ? { billingState } : {}),
    ...(card?.billingAddress ? { fallbackAddress: card.billingAddress } : {}),
  });
  const quote: LifetimeQuote = {
    plan: "web_lifetime",
    tier,
    amount: price.amount,
    credit,
    tax: total.tax,
    total: total.total,
    currency: total.currency,
    creditedPlan: ctx.plan,
  };
  const shown = shownCard(card);
  if (shown) quote.card = shown;
  if (total.taxAddress?.billingState) quote.billingState = total.taxAddress.billingState;
  return { quote, price, known, card, description, taxAddress: total.taxAddress };
}

/**
 * Charges the upgrade, in the stage J contract's order, with the yearly switch's attempt id,
 * lock, retry and settle rules.
 *
 * The payment is a one-off lifetime invoice as on `/subscribe`, with a second, negative item for
 * the credit, confirmed with the subscription's saved card while the buyer is on the page (so a
 * bank step comes back as `requires_action`). The subscription is not touched here: the sync's
 * lifetime rule cancels it once the invoice is paid, without proration or a final invoice.
 */
async function buyLifetime(
  ctx: ManageContext,
  request: { acceptedTotal: number; attemptId: string; lang: "ar" | "en"; billingState?: string },
  context: WebCallerContext
): Promise<LifetimeResult> {
  const { gateway } = ctx.gate;
  const { firestore } = ctx.deps;
  const purchaseId = purchaseIdFor(ctx.uid, request.attemptId);
  const ledgerRef = firestore.collection(WEB_PURCHASES_COLLECTION).doc(purchaseId);
  const existing = ledgerEntryFromData(purchaseId, (await ledgerRef.get()).data());
  if (existing) return settleChargeAttempt(ctx, existing, "retried", "upgrade");

  await consumeWebThrottle(ctx.deps, ctx.uid, context);
  assertUpgradable(ctx);
  await assertChargeAllowed(ctx);
  if (await lockHolderNow(ctx)) throw purchaseInProgress();
  // A switch left waiting would otherwise stay payable on a subscription about to stop.
  await voidEarlierSwitch(ctx);

  const plan = await planLifetime(ctx, request.lang, request.billingState);
  if (plan.quote.total !== request.acceptedTotal) {
    logWebInfo("web_subscription_lifetime_reprice", ctx.operationId, {
      uid: ctx.uid,
      subscriptionId: ctx.subscription.id,
      accepted: request.acceptedTotal,
      total: plan.quote.total,
    });
    return { status: "reprice", quote: plan.quote };
  }
  const paymentMethodId = idOf(ctx.subscription.default_payment_method as string | { id: string } | null);
  if (!paymentMethodId || !plan.card) throw cardDeclined("declined");

  const previous = ctx.purchaseId
    ? ledgerEntryFromData(ctx.purchaseId, (await firestore.collection(WEB_PURCHASES_COLLECTION).doc(ctx.purchaseId).get()).data())
    : undefined;
  const own = previous?.uid === ctx.uid ? previous : undefined;
  const now = ctx.deps.now();
  // No subscription id on the entry: it pays a one-off invoice, and the pending sweep must read
  // that invoice, never the running subscription, to tell whether it was paid.
  const entry: WebPurchaseEntry = {
    purchaseId,
    uid: ctx.uid,
    plan: "web_lifetime",
    kind: "upgrade",
    switchedFrom: ctx.plan,
    tierShown: plan.known.tier,
    tierCharged: plan.quote.tier,
    lookupKey: plan.price.lookupKey,
    priceId: plan.price.priceId,
    amount: plan.quote.amount,
    credit: plan.quote.credit,
    tax: plan.quote.tax,
    total: plan.quote.total,
    currency: plan.quote.currency,
    knownCountry: plan.known.knownCountry,
    cardCountry: plan.card.country,
    cardFunding: plan.card.funding,
    wallet: plan.card.wallet,
    // The address the upgrade is taxed at, when tax is on; otherwise the subscription's own.
    billingCountry: plan.taxAddress ? plan.taxAddress.address.country ?? null : own?.billingCountry ?? null,
    billingState: plan.taxAddress ? plan.taxAddress.address.state ?? null : own?.billingState ?? null,
    livemode: gateway.livemode,
    lang: request.lang,
    status: "pending",
    stripe: { customerId: ctx.customerId },
    createdAt: now,
    updatedAt: now,
  };
  const locked = await createLockedEntry(ctx, entry);
  if (locked.kind === "existing") return settleChargeAttempt(ctx, locked.entry, "retried", "upgrade");
  if (locked.kind === "busy") {
    logWebInfo("web_subscription_lifetime_busy", ctx.operationId, { uid: ctx.uid, purchaseId, activePurchase: locked.activePurchaseId });
    throw purchaseInProgress();
  }
  const superseded = await clearOlderAttempts(ctx, entry);
  if (superseded) return superseded;

  try {
    // The only write of a chosen province or a copied card address, now that the buyer confirmed.
    await saveTaxAddress(gateway, ctx.customerId, plan.taxAddress);
  } catch (error) {
    await settleUnstarted(ctx, purchaseId, "abandoned", "billing_address_incomplete");
    throw error;
  }

  const created = await createLifetimeInvoice(
    ctx,
    entry,
    plan.price,
    plan.quote.credit > 0 ? { amount: plan.quote.credit, description: plan.description } : undefined
  );
  const charged = invoiceAmounts(created.invoice!);
  entry.stripe.invoiceId = created.invoiceId;
  entry.stripe.paymentIntentId = created.paymentIntentId;
  Object.assign(entry, { amount: charged.amount, credit: charged.credit, tax: charged.tax, total: charged.total });
  await ledgerRef.update({
    "stripe.invoiceId": created.invoiceId,
    "stripe.paymentIntentId": created.paymentIntentId,
    amount: charged.amount,
    credit: charged.credit,
    tax: charged.tax,
    total: charged.total,
    updatedAt: Timestamp.fromDate(ctx.deps.now()),
  });
  if (created.invoiceTotal !== request.acceptedTotal) {
    // Stripe's invoice disagrees with the quote (a tax change between the two): never charge an
    // amount the buyer did not accept. Recorded before the void, as for a decline.
    await settleUnstarted(ctx, purchaseId, "abandoned", "total_mismatch");
    await gateway.voidInvoice(created.invoiceId);
    logWebInfo("web_subscription_lifetime_reprice", ctx.operationId, { uid: ctx.uid, purchaseId, total: created.invoiceTotal });
    return { status: "reprice", quote: { ...plan.quote, credit: charged.credit, tax: charged.tax, total: charged.total } };
  }
  logWebInfo("web_subscription_lifetime_invoiced", ctx.operationId, { uid: ctx.uid, purchaseId, invoiceId: created.invoiceId, total: charged.total });

  let intent: Stripe.PaymentIntent;
  try {
    intent = await gateway.confirmPaymentIntent(created.paymentIntentId, { payment_method: paymentMethodId }, `confirm_${purchaseId}`);
  } catch (error) {
    if (isCardError(error)) return failCharge(ctx, entry, declineCategory(error));
    // Stripe refused the confirmation itself (the saved card is gone, say), so nothing was charged.
    if (isInvalidRequestError(error)) return failCharge(ctx, entry, "declined");
    // Anything else may have charged: the entry stays pending for the sweep.
    throw error;
  }
  if (intent.status === "succeeded" && !(await awaitSettled(ctx, entry))) {
    logWebInfo("web_subscription_lifetime_settle_timeout", ctx.operationId, { uid: ctx.uid, purchaseId });
  }
  const invoice = await gateway.retrieveInvoice(created.invoiceId, ["payments"]);
  return intent.status === "succeeded" ? settleChargePaid(ctx, entry, invoice) : outcomeOfCharge(ctx, entry, invoice);
}
