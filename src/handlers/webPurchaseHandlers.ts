import * as crypto from "crypto";
import { Timestamp } from "firebase-admin/firestore";
import * as functions from "firebase-functions";
import type Stripe from "stripe";
import {
  existingPremium,
  PremiumSource,
  purchaseBlockers,
  readWebAccountSlots,
  StoreSubscriptionSummary,
  webSlotRef,
  webSlotView,
  WebAccountState,
  WebSlotView,
} from "../services/webSubscriptions/accountState";
import { DELETED_ACCOUNTS_COLLECTION } from "../services/accountDeletion/tombstone";
import {
  accountDeleted,
  customerIdFor,
  ensureCustomer,
  readCustomerMapping,
  WEB_CUSTOMERS_COLLECTION,
} from "../services/webSubscriptions/customers";
import {
  isWebPlan,
  ledgerEntryFromData,
  ledgerEntryToData,
  listLedgerEntries,
  purchaseIdFor,
  WEB_PLANS,
  WEB_PURCHASES_COLLECTION,
  WebPlan,
  WebPurchaseEntry,
} from "../services/webSubscriptions/ledger";
import { abandonPendingPurchase, stopPendingStripeSide } from "../services/webSubscriptions/pendingSweep";
import {
  billingAddressFromToken,
  cardFromToken,
  chargedTier,
  knownTier,
  lookupKeyFor,
  quoteTotal,
  WebPrice,
} from "../services/webSubscriptions/pricing";
import { idOf, shortId, stripeErrorCode, StripeGateway } from "../services/webSubscriptions/stripeGateway";
import { syncWebEntitlement, WebSyncDeps } from "../services/webSubscriptions/sync";
import { hasAppCheck, reasonOf, refusal, requireCaller } from "../utils/callableAuth";
import {
  callerEmail,
  cardDeclined,
  categoryOfLastError,
  CONFIRMATION_TOKEN_PATTERN,
  consumeWebThrottle,
  declineCategory,
  DeclineCategory,
  invalidRequest,
  isCardError,
  isInvalidRequestError,
  isTokenError,
  logWebInfo,
  openWebGate,
  optionalCents,
  optionalString,
  readConfirmationToken,
  readRequestObject,
  readWebLang,
  refusalWith,
  requiredString,
  requireVerifiedEmail,
  tokenInvalid,
  toWebCallableError,
  WebCallableDeps,
  WebCallerContext,
  WebGate,
} from "./webCallableCommon";

/** What a re-price answer shows; the page asks again before anything is charged. */
export interface WebQuote {
  plan: WebPlan;
  tier: string;
  /** Integer cents before tax. */
  amount: number;
  tax: number;
  total: number;
  currency: string;
  reason: "card_country" | "tax" | "both" | "price_changed";
}

const DECLINE_CATEGORIES: readonly DeclineCategory[] = [
  "declined",
  "insufficient_funds",
  "expired_card",
  "incorrect_details",
  "authentication_failed",
];

export const PURCHASE_ID_PATTERN = /^[0-9a-f]{32}$/;
const BILLING_STATE_PATTERN = /^[\p{L}\p{N} .'-]{1,64}$/u;

// ---------------------------------------------------------------------------
// getWebPlans
// ---------------------------------------------------------------------------

export interface WebPlansResult {
  publishableKey: string;
  livemode: boolean;
  countryKnown: boolean;
  tier: string;
  plans: Array<{ plan: WebPlan; amount: number; currency: string; interval: "month" | "year" | null }>;
  taxEnabled: boolean;
  current: { state: WebAccountState; plan?: string } | null;
  storeSubscription: StoreSubscriptionSummary | null;
  blockers: string[];
  /** Added after the first page shipped, so that page ignores it. */
  premium: PremiumSource[];
}

/**
 * The plans and prices the signed-in account would be offered now, for `/subscribe`.
 *
 * Prices are those of the account's known tier; the card's country can still raise them at
 * purchase, which `startWebPurchase` answers with a re-price. Reads Firestore and the cached
 * Stripe prices only; nothing is written.
 */
export async function handleGetWebPlans(
  data: unknown,
  context: WebCallerContext,
  deps: WebCallableDeps
): Promise<WebPlansResult> {
  const event = "web_plans";
  const operationId = crypto.randomUUID();
  const state = { stage: "validate" };
  try {
    const uid = requireCaller(context, { allowAnonymous: false, withReason: true });
    const request = readRequestObject(data, ["lang"]);
    readWebLang(request.lang);
    requireVerifiedEmail(context);
    state.stage = "gate";
    const gate = await openWebGate(uid, deps, { sales: true });
    const publishableKey = deps.publishableKey;
    const expectedPrefix = gate.gateway.livemode ? "pk_live_" : "pk_test_";
    if (!publishableKey || !publishableKey.startsWith(expectedPrefix)) {
      functions.logger.error(`${event}_publishable_key_invalid`, { operationId, present: Boolean(publishableKey) });
      throw refusal("failed-precondition", "Web purchases are not available.", "sales_disabled");
    }

    state.stage = "prices";
    const now = deps.now();
    const known = knownTier(gate.config, await deps.storeCountry.knownCountries(uid));
    const tierPrices = gate.config.tiers[known.tier]?.prices ?? {};
    const keys = WEB_PLANS.map((plan) => tierPrices[plan]).filter((key): key is string => Boolean(key));
    const prices = await gate.prices.get(keys);
    const plans = WEB_PLANS.filter((plan) => tierPrices[plan]).map((plan) => {
      const price = prices.get(tierPrices[plan]!)!;
      return { plan, amount: price.amount, currency: price.currency, interval: price.interval };
    });

    state.stage = "slots";
    const slots = await readWebAccountSlots(deps.firestore, uid, gate.gateway.livemode);
    const { blockers, storeSubscription } = purchaseBlockers(slots, now);
    const view = webSlotView(slots.web, now);
    const premium = existingPremium(slots, now);
    logWebInfo(`${event}_success`, operationId, {
      uid,
      tier: known.tier,
      countryKnown: known.countryKnown,
      livemode: gate.gateway.livemode,
      blockers,
      premium: premium.map((source) => source.source),
      appCheck: hasAppCheck(context),
    });
    return {
      publishableKey,
      livemode: gate.gateway.livemode,
      countryKnown: known.countryKnown,
      tier: known.tier,
      plans,
      taxEnabled: gate.config.taxEnabled,
      current: view.state === "none" ? null : { state: view.state, ...(view.plan ? { plan: view.plan } : {}) },
      storeSubscription,
      blockers,
      premium,
    };
  } catch (error) {
    throw toWebCallableError(event, operationId, state.stage, error);
  }
}

// ---------------------------------------------------------------------------
// startWebPurchase
// ---------------------------------------------------------------------------

export type StartWebPurchaseResult =
  | { status: "succeeded"; purchaseId: string }
  | { status: "requires_action"; purchaseId: string; clientSecret: string }
  | { status: "pending"; purchaseId: string }
  | { status: "reprice"; quote: WebQuote };

interface StartRequest {
  plan: WebPlan;
  confirmationToken: string;
  acceptedTotal: number;
  billingState?: string;
  lang: "ar" | "en";
  /** The buyer confirmed buying over premium from a store or a manual grant. */
  acknowledgeExisting: boolean;
}

function readStartRequest(data: unknown): StartRequest {
  const request = readRequestObject(data, ["plan", "confirmationToken", "acceptedTotal", "billingState", "lang", "acknowledgeExisting"]);
  if (!isWebPlan(request.plan)) throw invalidRequest();
  const acceptedTotal = optionalCents(request.acceptedTotal);
  if (acceptedTotal === undefined) throw invalidRequest();
  // The callable SDK sends an `undefined` value as `null`, so both mean the flag was not given.
  const acknowledge = request.acknowledgeExisting;
  if (acknowledge !== undefined && acknowledge !== null && typeof acknowledge !== "boolean") throw invalidRequest();
  return {
    plan: request.plan,
    confirmationToken: requiredString(request.confirmationToken, CONFIRMATION_TOKEN_PATTERN),
    acceptedTotal,
    billingState: optionalString(request.billingState, BILLING_STATE_PATTERN),
    lang: readWebLang(request.lang),
    acknowledgeExisting: request.acknowledgeExisting === true,
  };
}

/** One purchase call's working state, shared by its steps. */
interface PurchaseContext {
  uid: string;
  operationId: string;
  deps: WebCallableDeps;
  gate: WebGate;
  syncDeps: WebSyncDeps;
}

/**
 * Buys a plan with a confirmation token from the Payment Element: the stage D contract's steps,
 * in order.
 *
 * The server decides the tier, the price and the total; the page's `acceptedTotal` is only
 * compared with them, and a difference answers `reprice` with nothing created at Stripe and no
 * ledger entry. The purchase id is derived from the uid and the token, and every Stripe create
 * carries an idempotency key built from it, so a retried call lands on the same entry and
 * returns its outcome instead of charging again.
 */
export async function handleStartWebPurchase(
  data: unknown,
  context: WebCallerContext,
  deps: WebCallableDeps
): Promise<StartWebPurchaseResult> {
  const event = "web_purchase_start";
  const operationId = crypto.randomUUID();
  const state = { stage: "validate" };
  try {
    const uid = requireCaller(context, { allowAnonymous: false, withReason: true });
    const request = readStartRequest(data);
    requireVerifiedEmail(context);
    state.stage = "gate";
    const gate = await openWebGate(uid, deps, { sales: true });
    const { gateway, config } = gate;
    const purchaseId = purchaseIdFor(uid, request.confirmationToken);
    const ctx: PurchaseContext = {
      uid,
      operationId,
      deps,
      gate,
      syncDeps: { firestore: deps.firestore, gateway, now: deps.now, notify: deps.notify },
    };
    logWebInfo(`${event}_start`, operationId, {
      uid,
      plan: request.plan,
      purchaseId,
      acknowledgeExisting: request.acknowledgeExisting,
      token: shortId(request.confirmationToken),
      livemode: gateway.livemode,
      appCheck: hasAppCheck(context),
    });

    // A retried call: the token already started a purchase, whose outcome is the answer.
    state.stage = "retry";
    const ledgerRef = deps.firestore.collection(WEB_PURCHASES_COLLECTION).doc(purchaseId);
    const existing = ledgerEntryFromData(purchaseId, (await ledgerRef.get()).data());
    if (existing) return await retriedOutcome(ctx, existing, event);

    state.stage = "throttle";
    await consumeWebThrottle(deps, uid, context);

    state.stage = "guards";
    const mapping = await readCustomerMapping(deps.firestore, uid);
    if (customerIdFor(mapping, gateway.livemode)) {
      await syncWebEntitlement(uid, ctx.syncDeps, { operationId, trigger: "purchase_guard" });
    }
    await assertPurchaseAllowed(ctx, request.plan, request.acknowledgeExisting);

    state.stage = "token";
    const token = await readConfirmationToken(
      gateway,
      request.confirmationToken,
      deps.now(),
      request.plan === "web_lifetime" ? null : "off_session",
      (problem) => logWebInfo(`${event}_token_refused`, operationId, { uid, purchaseId, problem })
    );
    const card = cardFromToken(token);

    state.stage = "price";
    const known = knownTier(config, await deps.storeCountry.knownCountries(uid));
    const tierCharged = chargedTier(config, known.tier, card.country);
    const lookupKey = lookupKeyFor(config, tierCharged, request.plan);
    const billing = billingAddressFromToken(token, { taxEnabled: config.taxEnabled, billingState: request.billingState });
    const price = (await gate.prices.get([lookupKey])).get(lookupKey)!;
    const total = await quoteTotal(gateway, price, { taxEnabled: config.taxEnabled, address: billing.address });
    if (request.acceptedTotal !== total.total) {
      const cardChanged = tierCharged !== known.tier;
      const taxed = total.tax > 0;
      const quote: WebQuote = {
        plan: request.plan,
        tier: tierCharged,
        amount: total.amount,
        tax: total.tax,
        total: total.total,
        currency: total.currency,
        reason: cardChanged && taxed ? "both" : cardChanged ? "card_country" : taxed ? "tax" : "price_changed",
      };
      logWebInfo(`${event}_reprice`, operationId, {
        uid,
        purchaseId,
        plan: request.plan,
        tierShown: known.tier,
        tierCharged,
        total: total.total,
        reason: quote.reason,
      });
      return { status: "reprice", quote };
    }

    state.stage = "customer";
    const customerId = await ensureCustomer(uid, { firestore: deps.firestore, gateway, now: deps.now });

    state.stage = "ledger";
    const now = deps.now();
    const entry: WebPurchaseEntry = {
      purchaseId,
      uid,
      plan: request.plan,
      tierShown: known.tier,
      tierCharged,
      lookupKey,
      priceId: price.priceId,
      amount: total.amount,
      tax: total.tax,
      total: total.total,
      currency: total.currency,
      knownCountry: known.knownCountry,
      cardCountry: card.country,
      cardFunding: card.funding,
      wallet: card.wallet,
      billingCountry: billing.country,
      billingState: billing.state,
      livemode: gateway.livemode,
      lang: request.lang,
      status: "pending",
      stripe: { customerId },
      createdAt: now,
      updatedAt: now,
    };
    const locked = await createLockedEntry(ctx, entry);
    if (locked.kind === "existing") return await retriedOutcome(ctx, locked.entry, event);
    if (locked.kind === "busy") {
      logWebInfo(`${event}_busy`, operationId, { uid, purchaseId, activePurchase: locked.activePurchaseId, reason: locked.reason });
      throw refusal("failed-precondition", "Another purchase is in progress.", "purchase_in_progress");
    }

    // Nothing exists at Stripe for this purchase until it is created below, so any failure
    // before then settles the entry at once and releases the lock, rather than leaving it
    // pending (and blocking the account) for ten minutes.
    try {
      // After the lock, so a refused second tab never changes the address the first is taxed at.
      state.stage = "customer";
      await updateCustomerForPurchase(gateway, customerId, billing.address, callerEmail(context), request.lang, config.taxEnabled);

      state.stage = "older";
      // The previous lock holder was paid (it may have finished between this call's guards and
      // its lock), or an older pending purchase turned out paid: decide again on what the
      // account now holds, so two tabs never both subscribe.
      const olderPaid = await abandonOlderPending(ctx, purchaseId);
      if (locked.previousPaid || olderPaid) {
        await syncWebEntitlement(uid, ctx.syncDeps, { operationId, trigger: "purchase_guard" });
        await assertPurchaseAllowed(ctx, request.plan, request.acknowledgeExisting);
      }
    } catch (error) {
      const failure = error instanceof functions.https.HttpsError ? `refused_${reasonOf(error) ?? error.code}` : `before_create_${state.stage}`;
      await settleUnstarted(ctx, purchaseId, "abandoned", failure);
      throw error;
    }

    state.stage = "create";
    const created = request.plan === "web_lifetime"
      ? await createLifetimeInvoice(ctx, entry, price)
      : await createIncompleteSubscription(ctx, entry, price);
    await ledgerRef.update({
      ...(created.subscriptionId ? { "stripe.subscriptionId": created.subscriptionId } : {}),
      "stripe.invoiceId": created.invoiceId,
      "stripe.paymentIntentId": created.paymentIntentId,
      updatedAt: Timestamp.fromDate(deps.now()),
    });
    entry.stripe = { customerId, subscriptionId: created.subscriptionId, invoiceId: created.invoiceId, paymentIntentId: created.paymentIntentId };
    if (created.invoiceTotal !== request.acceptedTotal) {
      // Stripe's invoice disagrees with the quote (a price or tax change between the two):
      // never charge an amount the buyer did not accept.
      await failUnpaid(ctx, entry, "total_mismatch", "abandoned");
      logWebInfo(`${event}_reprice`, operationId, { uid, purchaseId, total: created.invoiceTotal, reason: "price_changed" });
      return {
        status: "reprice",
        quote: {
          plan: request.plan,
          tier: tierCharged,
          amount: total.amount,
          tax: Math.max(0, created.invoiceTotal - total.amount),
          total: created.invoiceTotal,
          currency: total.currency,
          reason: "price_changed",
        },
      };
    }

    // Another call may have settled this purchase since it was created (the sweep, or a
    // finishWebPurchase that saw it fail): then it is stopped here, never charged.
    state.stage = "confirm";
    const latest = ledgerEntryFromData(purchaseId, (await ledgerRef.get()).data());
    if (latest?.status !== "pending") {
      if (await stopPendingStripeSide(ctx.syncDeps, entry)) return await succeeded(ctx, purchaseId, event);
      logWebInfo(`${event}_settled_elsewhere`, operationId, { uid, purchaseId, status: latest?.status ?? null });
      throw tokenInvalid();
    }
    let intent: Stripe.PaymentIntent;
    try {
      intent = await gateway.confirmPaymentIntent(
        created.paymentIntentId,
        { confirmation_token: request.confirmationToken },
        `confirm_${purchaseId}`
      );
    } catch (error) {
      if (isCardError(error)) {
        const category = declineCategory(error);
        if ((await failUnpaid(ctx, entry, category)) === "paid") return await succeeded(ctx, purchaseId, event);
        logWebInfo(`${event}_declined`, operationId, { uid, purchaseId, category, stripeCode: stripeErrorCode(error) });
        throw cardDeclined(category);
      }
      if (isInvalidRequestError(error)) {
        // Stripe refused the confirmation itself, so nothing was charged.
        const failure = isTokenError(error) ? "token_invalid" : `confirm_${stripeErrorCode(error) ?? "invalid_request"}`;
        if ((await failUnpaid(ctx, entry, failure)) === "paid") return await succeeded(ctx, purchaseId, event);
        if (isTokenError(error)) throw tokenInvalid();
        throw error;
      }
      // Anything else may have charged: the entry stays pending for the sync and the sweep.
      throw error;
    }
    return await outcomeOfIntent(ctx, entry, intent, event);
  } catch (error) {
    throw toWebCallableError(event, operationId, state.stage, error);
  }
}

/** A purchase holds the account's lock this long at most; a pending entry this old is stale. */
export const PURCHASE_LOCK_MS = 10 * 60 * 1000;

type LockOutcome =
  | { kind: "created"; previousPaid: boolean }
  | { kind: "existing"; entry: WebPurchaseEntry }
  | { kind: "busy"; activePurchaseId: string; reason: "pending" | "paid_not_shown" };

/**
 * Creates the pending ledger entry and takes the account's purchase lock, in one transaction.
 *
 * The lock is `activePurchase: {purchaseId, startedAt}` on `web_customers/{uid}`. Another
 * purchase holds it while its entry is still `pending` and it started under
 * `PURCHASE_LOCK_MS` ago; then this one is refused and nothing is created at Stripe. No unlock
 * is needed: a settled or stale holder simply stops blocking. A holder that was paid makes the
 * caller check the guards again. So two tabs can never both be charged, and no purchase is
 * abandoned while another call may still confirm it.
 *
 * A new purchase is also refused while the holder was paid moments ago and the web slot does not
 * show it yet (`paidButNotShown`): a page that reloaded before the records caught up, or another
 * tab, would otherwise sell the same Premium a second time.
 */
export async function createLockedEntry(ctx: Pick<PurchaseContext, "uid" | "deps">, entry: WebPurchaseEntry): Promise<LockOutcome> {
  const { firestore } = ctx.deps;
  const ledger = firestore.collection(WEB_PURCHASES_COLLECTION);
  const ownRef = ledger.doc(entry.purchaseId);
  const mappingRef = firestore.collection(WEB_CUSTOMERS_COLLECTION).doc(ctx.uid);
  const tombstoneRef = firestore.collection(DELETED_ACCOUNTS_COLLECTION).doc(ctx.uid);
  const nowMs = ctx.deps.now().getTime();
  const slotRef = webSlotRef(firestore, ctx.uid, entry.livemode);
  return firestore.runTransaction(async (transaction): Promise<LockOutcome> => {
    const [own, mapping, tombstone, slot] = await transaction.getAll(ownRef, mappingRef, tombstoneRef, slotRef);
    if (own.exists) {
      const existing = ledgerEntryFromData(entry.purchaseId, own.data());
      if (!existing) throw new Error("unreadable ledger entry");
      return { kind: "existing", entry: existing };
    }
    if (tombstone.exists || !mapping.exists) throw accountDeleted();
    const { lockId, startedMs } = readLock(mapping.get("activePurchase"));
    let previousPaid = false;
    if (lockId && lockId !== entry.purchaseId) {
      const holder = ledgerEntryFromData(lockId, (await transaction.get(ledger.doc(lockId))).data());
      if (holderBlocks(holder, startedMs, nowMs)) {
        return { kind: "busy", activePurchaseId: lockId, reason: "pending" };
      }
      if (!entry.kind && paidButNotShown(holder, startedMs, nowMs, webSlotView(slot.data(), new Date(nowMs)), entry.livemode)) {
        return { kind: "busy", activePurchaseId: lockId, reason: "paid_not_shown" };
      }
      previousPaid = holder?.status === "paid";
    }
    transaction.create(ownRef, ledgerEntryToData(entry));
    transaction.update(mappingRef, {
      activePurchase: { purchaseId: entry.purchaseId, startedAt: Timestamp.fromMillis(nowMs) },
    });
    return { kind: "created", previousPaid };
  });
}

function readLock(value: unknown): { lockId?: string; startedMs: number } {
  const lock = value as { purchaseId?: unknown; startedAt?: unknown } | undefined;
  return {
    lockId: typeof lock?.purchaseId === "string" ? lock.purchaseId : undefined,
    startedMs: lock?.startedAt instanceof Timestamp ? lock.startedAt.toMillis() : 0,
  };
}

/** A lock holder blocks while its entry is pending and it started under `PURCHASE_LOCK_MS` ago. */
function holderBlocks(holder: WebPurchaseEntry | undefined, startedMs: number, nowMs: number): boolean {
  return holder?.status === "pending" && nowMs - startedMs < PURCHASE_LOCK_MS;
}

/**
 * Whether the lock holder is a plain purchase paid under `PURCHASE_LOCK_MS` ago that the web slot
 * does not show yet: a subscription slot naming another purchase or none running, or a lifetime
 * purchase without a lifetime slot. A switch or an upgrade changes a subscription the slot already
 * shows, so it never counts; a refunded, failed or abandoned holder is not paid. The lock is shared
 * by both Stripe modes while `view` is the slot of the new purchase's mode, so a holder of the other
 * mode (a tester's sandbox purchase before a live one) never counts either.
 */
export function paidButNotShown(
  holder: WebPurchaseEntry | undefined,
  startedMs: number,
  nowMs: number,
  view: WebSlotView,
  livemode: boolean
): boolean {
  if (!holder || holder.kind || holder.status !== "paid" || holder.livemode !== livemode || nowMs - startedMs >= PURCHASE_LOCK_MS) return false;
  if (holder.plan === "web_lifetime") return view.state !== "lifetime";
  return view.purchaseId !== holder.purchaseId || view.state === "none" || view.state === "ended";
}

/**
 * The purchase holding the account's lock now, read without taking it: for a step that must not
 * touch Stripe while another purchase may still be confirming (the plan switch voids a pending
 * change before it takes the lock).
 */
export async function lockHolderNow(ctx: Pick<PurchaseContext, "uid" | "deps">): Promise<string | undefined> {
  const { firestore } = ctx.deps;
  const { lockId, startedMs } = readLock((await firestore.collection(WEB_CUSTOMERS_COLLECTION).doc(ctx.uid).get()).get("activePurchase"));
  if (!lockId) return undefined;
  const holder = ledgerEntryFromData(lockId, (await firestore.collection(WEB_PURCHASES_COLLECTION).doc(lockId).get()).data());
  return holderBlocks(holder, startedMs, ctx.deps.now().getTime()) ? lockId : undefined;
}

/**
 * Refuses with the first blocker that applies to `plan`, read from the account's slots; then,
 * unless the buyer confirmed it, when premium from a store or a manual grant is active, since the
 * purchase starts today and adds nothing to the days already held.
 */
async function assertPurchaseAllowed(ctx: PurchaseContext, plan: WebPlan, acknowledgeExisting: boolean): Promise<void> {
  const now = ctx.deps.now();
  const slots = await readWebAccountSlots(ctx.deps.firestore, ctx.uid, ctx.gate.gateway.livemode);
  const { blockers, storeSubscription } = purchaseBlockers(slots, now, plan);
  const blocker = blockers[0];
  if (!blocker) {
    if (acknowledgeExisting) return;
    const premium = existingPremium(slots, now).filter((source) => source.source !== "web");
    if (premium.length > 0) {
      throw refusalWith("failed-precondition", "Premium from another source is active.", "existing_premium", { premium });
    }
    return;
  }
  if (blocker === "store_subscription_active" && storeSubscription) {
    throw refusalWith("failed-precondition", "A store subscription is already active.", blocker, {
      platform: storeSubscription.platform,
    });
  }
  const message = blocker === "lifetime_active" ? "Lifetime access is already active." : "A web subscription is already active.";
  throw refusal("failed-precondition", message, blocker);
}

async function updateCustomerForPurchase(
  gateway: StripeGateway,
  customerId: string,
  address: Stripe.AddressParam,
  email: string | undefined,
  lang: string,
  taxEnabled: boolean
): Promise<void> {
  const params: Stripe.CustomerUpdateParams = { address, preferred_locales: [lang] };
  if (email) params.email = email;
  if (taxEnabled) params.tax = { validate_location: "immediately" };
  try {
    await gateway.updateCustomer(customerId, params);
  } catch (error) {
    if (stripeErrorCode(error) === "customer_tax_location_invalid") {
      throw refusal("invalid-argument", "The billing address is incomplete.", "billing_address_incomplete");
    }
    throw error;
  }
}

/**
 * Abandons the account's other pending purchases older than the lock's lifetime, of every kind (a
 * purchase, a plan switch, an upgrade to lifetime), after the guard's sync has marked any that
 * were paid. Each is stopped at Stripe only once its invoice is read as unpaid, so an old bank
 * step can no longer be completed behind a new charge. One that turned out paid is left for the
 * sync to mark, and its purchase id is returned.
 */
export async function abandonOlderPending(
  ctx: Pick<PurchaseContext, "uid" | "operationId" | "deps" | "syncDeps">,
  currentPurchaseId: string
): Promise<string | undefined> {
  const { firestore, gateway } = ctx.syncDeps;
  // Only entries past the lock's lifetime: a younger pending entry may belong to a call that
  // is about to confirm it, and the lock already kept this purchase from racing it.
  const staleBefore = ctx.deps.now().getTime() - PURCHASE_LOCK_MS;
  const older = (await listLedgerEntries(firestore, ctx.uid)).filter(
    (entry) =>
      entry.status === "pending" &&
      entry.purchaseId !== currentPurchaseId &&
      entry.livemode === gateway.livemode &&
      entry.createdAt.getTime() <= staleBefore
  );
  let paidTurnedUp: string | undefined;
  for (const entry of older) {
    const abandoned = await abandonPendingPurchase(ctx.syncDeps, entry.purchaseId, ctx.deps.now());
    if (abandoned) {
      logWebInfo("web_purchase_abandoned", ctx.operationId, { uid: ctx.uid, purchaseId: entry.purchaseId, plan: entry.plan, kind: entry.kind ?? null, by: currentPurchaseId });
      continue;
    }
    // Not abandoned: paid after all, whether or not the sync has marked it yet.
    const after = ledgerEntryFromData(entry.purchaseId, (await firestore.collection(WEB_PURCHASES_COLLECTION).doc(entry.purchaseId).get()).data());
    if (after?.status === "pending" || after?.status === "paid") paidTurnedUp ??= entry.purchaseId;
  }
  return paidTurnedUp;
}

interface CreatedPayment {
  subscriptionId?: string;
  invoiceId: string;
  paymentIntentId: string;
  invoiceTotal: number;
  /** The finalized invoice; lifetime only. */
  invoice?: Stripe.Invoice;
}

function metadataFor(entry: WebPurchaseEntry): Record<string, string> {
  return { uid: entry.uid!, purchaseId: entry.purchaseId, plan: entry.plan, tier: entry.tierCharged };
}

function paymentIntentOf(invoice: Stripe.Invoice | string | null): string {
  const payments = typeof invoice === "object" && invoice ? invoice.payments?.data ?? [] : [];
  const payment = payments.find((row) => row.is_default) ?? payments[0];
  const id = idOf(payment?.payment?.payment_intent ?? null);
  if (!id) throw new Error("invoice without a payment intent");
  return id;
}

/** Recipe B4: an incomplete subscription whose first invoice the token then pays. Cards only. */
async function createIncompleteSubscription(ctx: PurchaseContext, entry: WebPurchaseEntry, price: WebPrice): Promise<CreatedPayment> {
  const subscription = await ctx.gate.gateway.createSubscription(
    {
      customer: entry.stripe.customerId,
      items: [{ price: price.priceId }],
      payment_behavior: "default_incomplete",
      payment_settings: { save_default_payment_method: "on_subscription", payment_method_types: ["card"] },
      automatic_tax: { enabled: ctx.gate.config.taxEnabled },
      metadata: metadataFor(entry),
      expand: ["latest_invoice.confirmation_secret", "latest_invoice.payments"],
    },
    `sub_${entry.purchaseId}`
  );
  const invoice = subscription.latest_invoice as Stripe.Invoice;
  return {
    subscriptionId: subscription.id,
    invoiceId: invoice.id!,
    paymentIntentId: paymentIntentOf(invoice),
    invoiceTotal: invoice.total,
  };
}

/**
 * Recipe C8: a one-off invoice for the lifetime price, finalized so a card can pay it. Cards only.
 *
 * An upgrade from a subscription adds `credit`, a second, negative item for the subscription's
 * unused time (accepted next to the price's item in the sandbox), described in the buyer's
 * language. Its idempotency key comes from the purchase like the others.
 */
export async function createLifetimeInvoice(
  ctx: Pick<PurchaseContext, "gate">,
  entry: WebPurchaseEntry,
  price: WebPrice,
  credit?: { amount: number; description: string }
): Promise<CreatedPayment> {
  const { gateway, config } = ctx.gate;
  const draft = await gateway.createInvoice(
    {
      customer: entry.stripe.customerId,
      collection_method: "charge_automatically",
      auto_advance: false,
      currency: price.currency,
      automatic_tax: { enabled: config.taxEnabled },
      payment_settings: { payment_method_types: ["card"] },
      metadata: metadataFor(entry),
    },
    `inv_${entry.purchaseId}`
  );
  await gateway.createInvoiceItem(
    { customer: entry.stripe.customerId, invoice: draft.id!, pricing: { price: price.priceId } },
    `item_${entry.purchaseId}`
  );
  if (credit && credit.amount > 0) {
    await gateway.createInvoiceItem(
      {
        customer: entry.stripe.customerId,
        invoice: draft.id!,
        amount: -credit.amount,
        currency: price.currency,
        description: credit.description,
      },
      `credit_${entry.purchaseId}`
    );
  }
  const open = await gateway.finalizeInvoice(draft.id!, { auto_advance: false, expand: ["confirmation_secret", "payments"] });
  return { invoiceId: open.id!, paymentIntentId: paymentIntentOf(open), invoiceTotal: open.total, invoice: open };
}

/**
 * Stops an unpaid purchase at Stripe (cancels the incomplete subscription or voids the invoice)
 * and marks its entry, unless the payment turned out to have gone through: then nothing is
 * stopped and "paid" is returned.
 */
async function failUnpaid(
  ctx: PurchaseContext,
  entry: WebPurchaseEntry,
  failure: string,
  status: "failed" | "abandoned" = "failed"
): Promise<"paid" | "stopped"> {
  if (await stopPendingStripeSide(ctx.syncDeps, entry)) return "paid";
  await settleUnstarted(ctx, entry.purchaseId, status, failure);
  return "stopped";
}

/** Marks a still-pending entry failed or abandoned. */
export async function settleUnstarted(
  ctx: Pick<PurchaseContext, "uid" | "operationId" | "deps">,
  purchaseId: string,
  status: "failed" | "abandoned",
  failure: string
): Promise<void> {
  const ref = ctx.deps.firestore.collection(WEB_PURCHASES_COLLECTION).doc(purchaseId);
  await ctx.deps.firestore.runTransaction(async (transaction) => {
    const entry = ledgerEntryFromData(purchaseId, (await transaction.get(ref)).data());
    if (!entry || entry.status !== "pending") return;
    transaction.update(ref, { status, failure, updatedAt: Timestamp.fromDate(ctx.deps.now()) });
  });
  logWebInfo(`web_purchase_${status}`, ctx.operationId, { uid: ctx.uid, purchaseId, failure });
}

/** How long a succeeded payment may take to show on its subscription or invoice. */
const SETTLE_ATTEMPTS = 10;
const SETTLE_WAIT_MS = 1000;

/**
 * Waits, briefly, until Stripe shows a succeeded payment on the subscription or invoice it paid.
 *
 * Stripe moves an incomplete subscription to active a few seconds after its PaymentIntent
 * succeeds (about 4 s in the sandbox). A sync before that finds no started subscription and
 * grants nothing, leaving access to the webhook. Giving up is not an error: the webhook syncs.
 */
export async function awaitSettled(ctx: Pick<PurchaseContext, "gate" | "deps">, entry: WebPurchaseEntry): Promise<boolean> {
  const sleep = ctx.deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const { gateway } = ctx.gate;
  for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt++) {
    if (entry.stripe.subscriptionId) {
      const subscription = await gateway.retrieveSubscription(entry.stripe.subscriptionId);
      if (subscription.status !== "incomplete") return true;
    } else if (entry.stripe.invoiceId) {
      if ((await gateway.retrieveInvoice(entry.stripe.invoiceId)).status === "paid") return true;
    } else {
      return false;
    }
    await sleep(SETTLE_WAIT_MS);
  }
  return false;
}

/** Syncs after a payment went through. A sync failure is logged and the answer is still success. */
async function succeeded(
  ctx: PurchaseContext,
  purchaseId: string,
  event: string,
  entry?: WebPurchaseEntry
): Promise<StartWebPurchaseResult> {
  try {
    if (entry && !(await awaitSettled(ctx, entry))) {
      logWebInfo(`${event}_settle_timeout`, ctx.operationId, { uid: ctx.uid, purchaseId });
    }
    await syncWebEntitlement(ctx.uid, ctx.syncDeps, { operationId: ctx.operationId, trigger: "purchase_succeeded" });
  } catch (error) {
    // The payment is taken either way; the webhook and the sweep sync again.
    functions.logger.warn(`${event}_after_payment_failure`, {
      operationId: ctx.operationId,
      uid: ctx.uid,
      purchaseId,
      code: stripeErrorCode(error) ?? (error instanceof Error ? error.name : typeof error),
    });
  }
  logWebInfo(`${event}_success`, ctx.operationId, { uid: ctx.uid, purchaseId, status: "succeeded" });
  return { status: "succeeded", purchaseId };
}

async function outcomeOfIntent(
  ctx: PurchaseContext,
  entry: WebPurchaseEntry,
  intent: Stripe.PaymentIntent,
  event: string
): Promise<StartWebPurchaseResult> {
  const purchaseId = entry.purchaseId;
  if (intent.status === "succeeded") return succeeded(ctx, purchaseId, event, entry);
  if (intent.status === "requires_action" && intent.client_secret) {
    logWebInfo(`${event}_success`, ctx.operationId, { uid: ctx.uid, purchaseId, status: "requires_action" });
    return { status: "requires_action", purchaseId, clientSecret: intent.client_secret };
  }
  if (intent.status === "requires_payment_method") {
    const category = categoryOfLastError(intent.last_payment_error);
    if ((await failUnpaid(ctx, entry, category)) === "paid") return succeeded(ctx, purchaseId, event);
    throw cardDeclined(category);
  }
  logWebInfo(`${event}_success`, ctx.operationId, { uid: ctx.uid, purchaseId, status: "pending", intentStatus: intent.status });
  return { status: "pending", purchaseId };
}

export type SettledOutcome =
  | { status: "succeeded" }
  | { status: "pending" }
  | { status: "requires_action"; clientSecret: string }
  | { status: "failed"; category?: DeclineCategory; failure?: string };

/**
 * Where a purchase stands now, after a sync of the account. A pending purchase whose payment
 * was confirmed and failed (a declined or failed authentication) is stopped at Stripe and
 * marked failed here, rather than waiting a day for the sweep.
 */
async function settlePurchase(ctx: PurchaseContext, entry: WebPurchaseEntry): Promise<SettledOutcome> {
  // Always synced, also for a paid entry: after a renewal's authentication the slot still says
  // it needs action until the next sync.
  await syncWebEntitlement(ctx.uid, ctx.syncDeps, { operationId: ctx.operationId, trigger: "purchase_finish" });
  const ref = ctx.deps.firestore.collection(WEB_PURCHASES_COLLECTION).doc(entry.purchaseId);
  const current = ledgerEntryFromData(entry.purchaseId, (await ref.get()).data()) ?? entry;
  switch (current.status) {
    case "pending": {
      const paymentIntentId = current.stripe.paymentIntentId;
      if (!paymentIntentId) return { status: "pending" };
      const intent = await ctx.gate.gateway.retrievePaymentIntent(paymentIntentId);
      if (intent.status === "requires_action" && intent.client_secret) {
        return { status: "requires_action", clientSecret: intent.client_secret };
      }
      // Back to requires_payment_method, or canceled: the authentication failed or was
      // dismissed. Settled now, so the account's purchase lock releases at once.
      if (intent.status === "requires_payment_method" || intent.status === "canceled") {
        const category = intent.last_payment_error ? categoryOfLastError(intent.last_payment_error) : "authentication_failed";
        if ((await failUnpaid(ctx, current, category)) === "paid") {
          await syncWebEntitlement(ctx.uid, ctx.syncDeps, { operationId: ctx.operationId, trigger: "purchase_finish" });
          return { status: "succeeded" };
        }
        return { status: "failed", category };
      }
      return { status: "pending" };
    }
    case "failed": {
      const category = (DECLINE_CATEGORIES as readonly string[]).includes(current.failure ?? "")
        ? (current.failure as DeclineCategory)
        : undefined;
      return { status: "failed", ...(category ? { category } : {}), ...(current.failure ? { failure: current.failure } : {}) };
    }
    case "abandoned":
      return { status: "failed", failure: current.failure ?? "abandoned" };
    default:
      // Paid, and anything that followed a payment (refund, dispute): the purchase went through.
      return { status: "succeeded" };
  }
}

/** The answer to a call whose token already started a purchase: its outcome, never a new charge. */
async function retriedOutcome(ctx: PurchaseContext, entry: WebPurchaseEntry, event: string): Promise<StartWebPurchaseResult> {
  if (entry.uid !== ctx.uid || entry.livemode !== ctx.gate.gateway.livemode) throw tokenInvalid();
  const outcome = await settlePurchase(ctx, entry);
  logWebInfo(`${event}_retried`, ctx.operationId, { uid: ctx.uid, purchaseId: entry.purchaseId, status: outcome.status });
  switch (outcome.status) {
    case "succeeded":
      return { status: "succeeded", purchaseId: entry.purchaseId };
    case "requires_action":
      return { status: "requires_action", purchaseId: entry.purchaseId, clientSecret: outcome.clientSecret };
    case "pending":
      return { status: "pending", purchaseId: entry.purchaseId };
    case "failed":
      if (outcome.category) throw cardDeclined(outcome.category);
      throw tokenInvalid();
  }
}

// ---------------------------------------------------------------------------
// finishWebPurchase
// ---------------------------------------------------------------------------

export interface FinishWebPurchaseResult {
  status: "succeeded" | "pending" | "failed";
  /** Set on a failure that was a decline. */
  category?: DeclineCategory;
}

/**
 * Where the caller's purchase stands, after the page handled a `requires_action` answer (or a
 * renewal's authentication from `/manage`). Syncs first; an authentication that failed marks the
 * purchase failed and stops it at Stripe.
 */
export async function handleFinishWebPurchase(
  data: unknown,
  context: WebCallerContext,
  deps: WebCallableDeps
): Promise<FinishWebPurchaseResult> {
  const event = "web_purchase_finish";
  const operationId = crypto.randomUUID();
  const state = { stage: "validate" };
  try {
    const uid = requireCaller(context, { allowAnonymous: false, withReason: true });
    const request = readRequestObject(data, ["purchaseId"]);
    const purchaseId = requiredString(request.purchaseId, PURCHASE_ID_PATTERN);
    state.stage = "gate";
    const gate = await openWebGate(uid, deps, { sales: false });
    const ctx: PurchaseContext = {
      uid,
      operationId,
      deps,
      gate,
      syncDeps: { firestore: deps.firestore, gateway: gate.gateway, now: deps.now, notify: deps.notify },
    };
    state.stage = "read";
    const entry = ledgerEntryFromData(
      purchaseId,
      (await deps.firestore.collection(WEB_PURCHASES_COLLECTION).doc(purchaseId).get()).data()
    );
    // Someone else's purchase reads exactly like a missing one.
    if (!entry || entry.uid !== uid || entry.livemode !== gate.gateway.livemode) {
      throw refusal("not-found", "No such purchase.", "purchase_not_found");
    }
    state.stage = "settle";
    const outcome = await settlePurchase(ctx, entry);
    const result: FinishWebPurchaseResult =
      outcome.status === "requires_action"
        ? { status: "pending" }
        : outcome.status === "failed"
          ? { status: "failed", ...(outcome.category ? { category: outcome.category } : {}) }
          : { status: outcome.status };
    logWebInfo(`${event}_success`, operationId, { uid, purchaseId, status: result.status, appCheck: hasAppCheck(context) });
    return result;
  } catch (error) {
    throw toWebCallableError(event, operationId, state.stage, error);
  }
}
