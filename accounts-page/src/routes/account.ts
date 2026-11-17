/// `/subscribe` and `/manage`: one page for the signed-in account's Premium. `accountView` decides
/// what it shows; this file only renders that and runs the payments and changes it offers.
///
/// The server decides every price. The page sends the total it showed; a different total comes
/// back as a re-price with nothing charged, and the page asks again; every card attempt, an
/// accepted re-price included, sends a new confirmation token made from the card form as it is then.

import type { ConfirmationToken } from "@stripe/stripe-js";

import { h } from "../dom";
import { STRINGS, langFromParam, type Lang, type Strings } from "../i18n";
import { announce, clearAnnouncements, focusLanguageToggle, focusSelector, heading, renderShell } from "../shell";
import { finishWebPurchase, getWebPlans, getWebSubscription, manageWebSubscription, startWebPurchase } from "../billing/api";
import {
  accountView,
  asksForProvince,
  cardText,
  defaultPlan,
  elementsKindFor,
  formatDate,
  formatMoney,
  isPlan,
  keepsAttempt,
  keepsPending,
  lifetimePurchaseIn,
  lifetimeQuoteRequest,
  lifetimeRequest,
  lifetimeSummary,
  loadAnnouncement,
  provinceAnswer,
  countryName,
  countryNoticeText,
  onlyTaxAdded,
  payButtonState,
  payNote,
  pendingAfterLoad,
  planName,
  plansDisagree,
  purchaseRequest,
  refusalFrom,
  replaceCardRequest,
  shownTotal,
  statusText,
  storeWords,
  switchRequest,
  termsHref,
  switchSummary,
  type AccountView,
  type DeclineCategory,
  type LifetimeQuote,
  type LifetimeResult,
  type ManageResult,
  type Plan,
  type PendingPurchase,
  type PlanOffer,
  type PlansAnswer,
  type Purchase,
  type Quote,
  type Refusal,
  type Section,
  type SubscriptionResponse,
  type SwitchQuote,
  type SwitchResult,
  type SwitchSummary,
} from "../billing/logic";
import { destroyPayment, mountPayment, paymentHost, stripeFor, updatePayment, type CardFormStatus, type MountedPayment } from "../billing/stripe";
import {
  accountLine,
  compact,
  createGate,
  externalLink,
  gateStep,
  loadingStep,
  notice,
  Regions,
  signOutButton,
  sleep,
  storeManageLink,
  termsLine,
  type GateChange,
} from "../billing/ui";

type View = { kind: "gate" } | { kind: "loading" } | { kind: "loadFailed"; refusal: Refusal } | { kind: "ready" };

/// What is running; every control is busy while one is.
type Action = "cancel" | "resume" | "authenticate" | "replace" | "charge" | "pay" | "check";
/// Where an error is shown: under the status for the page's own controls, or inside the card
/// panel, the charge panel or the purchase (next to the card form, the province or the pay button).
type Place = "actions" | "replace" | "charge" | "card" | "province" | "pay";
type ShownError =
  | Refusal
  | {
      kind:
        | "cardIncomplete"
        | "verifyNotCompleted"
        | "cardVerifyNotCompleted"
        | "chargeVerifyNotCompleted"
        | "stripeUnavailable"
        | "authenticationNotCompleted"
        | "provinceMissing"
        | "provinceRefused";
    };

/// A panel opens in place of the control or section that opened it, and only one at a time.
type PanelKind = "card" | "switch" | "lifetime" | "buyLifetime";
type ChargeKind = "switch" | "lifetime";

let lang: Lang = langFromParam(new URLSearchParams(location.search).get("lang"));
let view: View = { kind: "gate" };
let subscription: SubscriptionResponse | null = null;
let plansAnswer: PlansAnswer | null = null;
let account: AccountView | null = null;
/// A purchase this tab made that the account may not show yet; see `PendingPurchase`.
let pending: PendingPurchase | null = null;
let regions = new Regions();

const page = {
  busy: null as Action | null,
  progress: "",
  error: null as { error: ShownError; place: Place } | null,
};

const panel = {
  kind: null as PanelKind | null,
  /// The slot it replaces: "primary" or a section's kind.
  slot: "",
  /// The control focus returns to when it closes.
  opener: "",
};

const replace = {
  payment: null as MountedPayment | null,
  mountId: 0,
  cardStatus: "loading" as "loading" | "failed" | "ready",
  quote: null as Quote | null,
};

/// The switch to yearly or the upgrade to lifetime, charged to the saved card.
const charge = {
  /// `province`: the upgrade's saved address needs a Canadian province before it can be quoted.
  status: "loading" as "loading" | "failed" | "ready" | "province",
  quote: null as SwitchQuote | LifetimeQuote | null,
  loadError: null as Refusal | null,
  /// The province select is shown, and `province` is sent with the quote and the upgrade.
  needProvince: false,
  province: "",
  /// The confirmation the server may already hold; see `keepsAttempt`.
  attemptId: null as string | null,
  loadId: 0,
};

/// The purchase on show: the page's own section or the lifetime panel.
const form = {
  purchase: null as Purchase | null,
  selected: null as Plan | null,
  payment: null as MountedPayment | null,
  /// Bumped on every mount, so a late load from an earlier render is dropped.
  mountId: 0,
  cardStatus: "loading" as "loading" | "failed" | "ready",
  quote: null as Quote | null,
  /// The billing country of the last attempt's token, to tell a Canadian address apart.
  billingCountry: null as string | null,
  needProvince: false,
  province: "",
  /// The buyer ticked «فهمت ذلك» over premium from a store or a manual grant.
  acknowledged: false,
  acknowledgeError: false,
};

const gate = createGate({ lang: () => lang, onChange: onGateChange });

function t(): Strings {
  return STRINGS[lang];
}

// ---------------------------------------------------------------------------
// Loading

function onGateChange(change: GateChange) {
  // However the session ended, the next account in this tab never starts from this one's purchase.
  if (gate.phase !== "signedIn") pending = null;
  if (gate.phase === "signedIn") {
    void load({ before: change.announce });
    return;
  }
  view = { kind: "gate" };
  render({ focus: change.focus });
  if (change.announce) announce(change.announce);
}

/// Reads the subscription (the server syncs it from Stripe first) and the plans together, and
/// shows the account with focus on the page's heading. `before` is said as loading starts, and
/// `announce` before the status once it is shown; `loadingFocus` is where focus waits meanwhile.
async function load(options: { before?: string; announce?: string; loadingFocus?: string } = {}) {
  const session = gate.session;
  if (!session) return;
  closePanel();
  resetForm();
  page.busy = null;
  page.error = null;
  view = { kind: "loading" };
  render({ focus: options.loadingFocus ?? "h1" });
  if (options.before) announce(options.before);
  let loaded: [SubscriptionResponse, PlansAnswer];
  try {
    loaded = await Promise.all([
      getWebSubscription(session.app),
      getWebPlans(session.app, lang).then(
        (plans): PlansAnswer => ({ plans }),
        (error): PlansAnswer => ({ refusal: refusalFrom(error) }),
      ),
    ]);
  } catch (error) {
    const refusal = refusalFrom(error);
    if (refusal.kind === "signedOut" || refusal.kind === "accountDeleted") {
      await signOutFor(refusal);
      return;
    }
    view = { kind: "loadFailed", refusal };
    render({ focus: "h1" });
    announce(refusal.kind === "noAnswer" ? t().actionNoAnswer : t().genericBody);
    return;
  }
  const sub = loaded[0];
  let answer = loaded[1];
  if ("plans" in answer && plansDisagree(sub, answer.plans)) {
    // The plans were read before the subscription call's sync: read them once more.
    answer = await plansFor(session.app);
  }
  if ("refusal" in answer && (answer.refusal.kind === "signedOut" || answer.refusal.kind === "accountDeleted")) {
    await signOutFor(answer.refusal);
    return;
  }
  subscription = sub;
  plansAnswer = answer;
  const now = Date.now();
  pending = pendingAfterLoad(pending ?? readPending(), sub, now);
  if (!pending) forgetPending();
  account = accountView(sub, answer, now, pending);
  view = { kind: "ready" };
  render({ focus: "h1" });
  announce(loadAnnouncement(options.announce, statusTitle()));
}

function plansFor(app: Parameters<typeof getWebPlans>[0]): Promise<PlansAnswer> {
  return getWebPlans(app, lang).then(
    (plans): PlansAnswer => ({ plans }),
    (error): PlansAnswer => ({ refusal: refusalFrom(error) }),
  );
}

/// Reads the plans again after they failed, leaving the rest of the page as it is.
async function reloadPlans() {
  const session = gate.session;
  if (page.busy || !session || !subscription) return;
  setBusy("pay");
  const answer = await plansFor(session.app);
  if ("refusal" in answer && (answer.refusal.kind === "signedOut" || answer.refusal.kind === "accountDeleted")) {
    await signOutFor(answer.refusal);
    return;
  }
  page.busy = null;
  plansAnswer = answer;
  resetForm();
  account = accountView(subscription, answer, Date.now(), pending);
  render({ focus: "h1" });
  announce(loadAnnouncement(undefined, statusTitle()));
}

// The tab's memory of a pending purchase, kept in session storage so a reload keeps it, and keyed
// by the account so another account signed in on this tab never inherits it.

function pendingKey(): string | null {
  const uid = gate.signedIn?.user.uid;
  return uid ? `mantooq.pendingPurchase.${uid}` : null;
}

function readPending(): PendingPurchase | null {
  const key = pendingKey();
  if (!key) return null;
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? "null") as Partial<PendingPurchase> | null;
    return value && typeof value.purchaseId === "string" && isPlan(value.plan) && typeof value.at === "number"
      ? { purchaseId: value.purchaseId, plan: value.plan, at: value.at }
      : null;
  } catch {
    return null;
  }
}

function rememberPending(purchaseId: string, plan: Plan) {
  pending = { purchaseId, plan, at: Date.now() };
  const key = pendingKey();
  if (!key) return;
  try {
    sessionStorage.setItem(key, JSON.stringify(pending));
  } catch {
    // Without storage the memory lasts as long as the page; the server still refuses a repeat.
  }
}

function forgetPending() {
  pending = null;
  const key = pendingKey();
  if (!key) return;
  try {
    sessionStorage.removeItem(key);
  } catch {
    // Nothing stored.
  }
}

/// "Check again" while a purchase is confirming: asks the server where it stands. A failed or
/// unknown purchase is forgotten and the purchase is offered again; otherwise the page reloads.
async function runCheckAgain() {
  if (page.busy || !pending || !gate.session) return;
  setBusy("check", t().checkingPayment);
  let outcome: "succeeded" | "pending" | "failed" | "notFound" | "noAnswer";
  try {
    outcome = (await finishWebPurchase(gate.session.app, pending.purchaseId)).status;
  } catch (error) {
    const refusal = refusalFrom(error);
    if (refusal.kind === "signedOut" || refusal.kind === "accountDeleted") {
      await signOutFor(refusal);
      return;
    }
    if (refusal.kind !== "purchaseNotFound") {
      showError(refusal, "actions");
      return;
    }
    outcome = "notFound";
  }
  if (!keepsPending(outcome)) {
    forgetPending();
    await reloadAfter(t().paymentNotCompleted);
    return;
  }
  await reloadAfter(outcome === "succeeded" ? t().purchasedAnnouncement : t().stillConfirming);
}

async function signOutFor(refusal: Refusal) {
  closePanel();
  resetForm();
  page.busy = null;
  pending = null;
  await gate.signOut(refusal.kind === "accountDeleted" ? t().accountDeleted : undefined);
}

/// After an action: shows the new state and says what happened.
///
/// The control that had focus goes with the old view, so focus waits on the loading message
/// meanwhile; left to the browser it falls to the page body for the seconds the sync takes.
async function reloadAfter(message: string) {
  await load({ announce: message, loadingFocus: "#loading-status" });
}

function statusTitle(): string {
  return account ? statusText(account, t(), lang).title : "";
}

// ---------------------------------------------------------------------------
// Busy state and errors

function setBusy(action: Action | null, progress = "") {
  page.busy = action;
  page.progress = progress;
  const readOnly = action !== null;
  replace.payment?.element.update({ readOnly });
  form.payment?.element.update({ readOnly });
  for (const radio of document.querySelectorAll<HTMLInputElement>("input[name='plan']")) radio.disabled = readOnly;
  updateControls();
  if (progress) announce(progress);
}

/// Rebuilds every region that holds a control, so busy and error states reach all of them.
function updateControls() {
  regions.update(
    "actions-error",
    "slot-primary",
    ...(account?.sections ?? []).map((section) => `slot-${section.kind}`),
    "replace-error",
    "replace-actions",
    // The quote's province button sits in the body.
    "charge-body",
    "charge-province",
    "charge-error",
    "charge-actions",
    "acknowledge-region",
    "card-error",
    "pay-region",
    "panel-back",
    "cancel-region",
    "sign-out-region",
  );
}

function showError(error: ShownError, place: Place) {
  page.busy = null;
  page.progress = "";
  page.error = { error, place };
  setBusy(null);
  announce(errorText(error, place));
  if (place === "province") {
    focusSelector("#province");
  } else if (!document.activeElement || document.activeElement === document.body) {
    // The bank's window took focus with it when it closed.
    focusSelector(RETURN_FOCUS[place]());
  }
}

const RETURN_FOCUS: Record<Place, () => string> = {
  actions: () => "h1",
  replace: () => "#save-card",
  charge: () => `#confirm-${panel.kind}`,
  card: () => "#pay",
  province: () => "#province",
  pay: () => "#pay",
};

async function failed(error: unknown, place: Place) {
  const refusal = refusalFrom(error);
  if (refusal.kind === "signedOut" || refusal.kind === "accountDeleted") {
    await signOutFor(refusal);
    return;
  }
  showError(refusal, place);
}

// ---------------------------------------------------------------------------
// Panels

function openPanel(kind: PanelKind, slot: string, opener: string) {
  if (page.busy) return;
  closePanel();
  resetForm();
  panel.kind = kind;
  panel.slot = slot;
  panel.opener = opener;
  page.error = null;
  if (kind === "buyLifetime") {
    form.purchase = account ? lifetimePurchaseIn(account, slot) : null;
    form.selected = defaultPlan(form.purchase?.offers ?? []);
  }
  render({ focus: `#${kind === "card" ? "card-panel" : kind}-heading` });
  if (kind === "switch" || kind === "lifetime") void loadChargeQuote();
}

function closePanel() {
  replace.mountId += 1;
  if (replace.payment) destroyPayment(replace.payment);
  replace.payment = null;
  replace.quote = null;
  replace.cardStatus = "loading";
  charge.loadId += 1;
  charge.status = "loading";
  charge.quote = null;
  charge.loadError = null;
  charge.attemptId = null;
  charge.needProvince = false;
  charge.province = "";
  panel.kind = null;
  panel.slot = "";
}

/// "Back": closes the panel and gives focus back to the control that opened it.
function backFromPanel() {
  if (page.busy) return;
  const opener = panel.opener;
  closePanel();
  resetForm();
  page.error = null;
  render({ focus: `#${opener}` });
}


// ---------------------------------------------------------------------------
// Cancel and resume

function openCancelDialog(trigger: HTMLElement) {
  if (page.busy) return;
  const s = t();
  const date = formatDate(subscription?.renewsAt ?? subscription?.endsAt, lang);
  const dialog = h(
    "dialog",
    { id: "cancel-dialog", class: "dialog", "aria-labelledby": "cancel-dialog-title", "aria-describedby": "cancel-dialog-body" },
    h("h2", { id: "cancel-dialog-title" }, s.cancelDialogTitle),
    h("p", { id: "cancel-dialog-body" }, s.cancelDialogBody(date)),
    h(
      "div",
      { class: "dialog-actions" },
      h("button", { type: "button", id: "cancel-keep", class: "btn", autofocus: true, onclick: () => dialog.close("keep") }, s.keepSubscription),
      h("button", { type: "button", id: "cancel-confirm", class: "btn secondary danger-text", onclick: () => dialog.close("confirm") }, s.confirmCancel),
    ),
  );
  dialog.addEventListener("close", () => {
    const confirmed = dialog.returnValue === "confirm";
    dialog.remove();
    if (confirmed) {
      void runCancel();
    } else {
      trigger.focus();
    }
  });
  document.getElementById("app")!.append(dialog);
  dialog.showModal();
}

async function runCancel() {
  setBusy("cancel", t().cancellingSubscription);
  focusSelector("#cancel");
  try {
    await manageWebSubscription(gate.session!.app, { action: "cancel" });
  } catch (error) {
    await failed(error, "actions");
    return;
  }
  await reloadAfter(t().cancelledAnnouncement);
}

async function runResume() {
  if (page.busy) return;
  setBusy("resume", t().resuming);
  try {
    await manageWebSubscription(gate.session!.app, { action: "resume" });
  } catch (error) {
    await failed(error, "actions");
    return;
  }
  await reloadAfter(t().resumedAnnouncement);
}

// ---------------------------------------------------------------------------
// The bank's confirmation of a renewal

async function runAuthenticate() {
  if (page.busy) return;
  const session = gate.session!;
  setBusy("authenticate", t().confirmingPayment);
  const key = subscription?.publishableKey;
  if (!key) {
    showError({ kind: "stripeUnavailable" }, "actions");
    return;
  }
  let answer: { clientSecret: string; purchaseId?: string };
  try {
    answer = await manageWebSubscription(session.app, { action: "authenticate" });
  } catch (error) {
    await failed(error, "actions");
    return;
  }
  let stripe;
  try {
    stripe = await stripeFor(key, lang);
  } catch {
    showError({ kind: "stripeUnavailable" }, "actions");
    return;
  }
  await bankStep(stripe, answer.clientSecret, "#confirm-payment");
  const purchaseId = answer.purchaseId ?? subscription?.purchaseId;
  let outcome: { status: string; category?: DeclineCategory } = { status: "pending" };
  if (purchaseId) {
    try {
      outcome = await finishWebPurchase(session.app, purchaseId);
    } catch (error) {
      await failed(error, "actions");
      return;
    }
  }
  if (outcome.status === "succeeded") {
    await reloadAfter(t().verifiedAnnouncement);
    return;
  }
  if (outcome.status === "failed") {
    showError({ kind: "declined", category: outcome.category ?? "authentication_failed" }, "actions");
    return;
  }
  showError({ kind: "verifyNotCompleted" }, "actions");
}

/// Runs the bank's check, then gives focus back to the button that started it.
///
/// The bank's window takes focus with it and leaves it on the page body when it closes, completed
/// or not; a screen reader user would then be nowhere while the page asks the server where the
/// payment stands. The button stays in place (busy) through that call.
async function bankStep(stripe: { handleNextAction(options: { clientSecret: string }): Promise<unknown> }, clientSecret: string, returnTo: string) {
  try {
    await stripe.handleNextAction({ clientSecret });
  } catch {
    // Whatever happened, the server says where the payment or card change stands.
  }
  focusSelector(returnTo);
}

// ---------------------------------------------------------------------------
// Changing the card

async function mountReplaceForm() {
  const host = document.getElementById("replace-host");
  if (!host) return;
  const mountId = ++replace.mountId;
  const key = subscription?.publishableKey ?? null;
  const onStatus = (status: CardFormStatus) => {
    if (mountId !== replace.mountId) return;
    replace.cardStatus = status;
    regions.update("replace-status", "replace-actions");
    if (status === "failed") announce(t().cardFormFailed);
  };
  let mounted: MountedPayment | null = null;
  if (key) {
    try {
      mounted = await mountPayment({ publishableKey: key, lang, kind: "setup", amount: 0, currency: subscription?.currency ?? "usd", host, onStatus });
    } catch {
      mounted = null;
    }
  } else {
    onStatus("loading");
  }
  if (mountId !== replace.mountId) {
    if (mounted) destroyPayment(mounted);
    return;
  }
  if (!mounted) {
    replace.cardStatus = "failed";
    regions.update("replace-status", "replace-actions");
    announce(key ? t().cardFormFailed : t().stripeUnavailable);
    return;
  }
  replace.payment = mounted;
  mounted.element.on("change", () => {
    if (page.busy || mountId !== replace.mountId) return;
    replace.quote = null;
    if (page.error?.place === "replace") page.error = null;
    regions.update("replace-error", "replace-actions");
  });
}

async function onSaveCard() {
  if (page.busy || !replace.payment || replace.cardStatus !== "ready") return;
  page.error = null;
  setBusy("replace", t().savingCard);
  const token = await newToken(replace.payment, "replace");
  if (!token) return;
  let result: ManageResult;
  try {
    result = await manageWebSubscription(gate.session!.app, replaceCardRequest(token.id, replace.quote));
  } catch (error) {
    await failed(error, "replace");
    return;
  }
  await afterReplaceAnswer(result);
}

async function afterReplaceAnswer(result: ManageResult) {
  switch (result.status) {
    case "succeeded":
      await reloadAfter(t().cardSavedAnnouncement);
      return;
    case "reprice":
      // Saving again sends a new token with the quoted renewal amount.
      replace.quote = result.quote;
      setBusy(null);
      announce(renewalRepriceText(result.quote));
      focusSelector("#replace-quote");
      return;
    case "requires_action": {
      setBusy("replace", t().verifyingCard);
      await bankStep(replace.payment!.stripe, result.clientSecret, "#save-card");
      let finished: ManageResult;
      try {
        finished = await manageWebSubscription(gate.session!.app, { action: "finish_replace_card", setupIntentId: result.setupIntentId });
      } catch (error) {
        await failed(error, "replace");
        return;
      }
      if (finished.status === "requires_action") {
        showError({ kind: "cardVerifyNotCompleted" }, "replace");
        return;
      }
      await afterReplaceAnswer(finished);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Switching to yearly, upgrading to lifetime

function chargeKind(): ChargeKind {
  return panel.kind === "lifetime" ? "lifetime" : "switch";
}

/// Asks the server what the charge costs now; the panel's heading keeps focus meanwhile, or the
/// province's button when the amount is worked out after choosing one.
async function loadChargeQuote() {
  const session = gate.session;
  if (!session) return;
  const kind = chargeKind();
  const loadId = ++charge.loadId;
  const province = charge.needProvince ? charge.province : null;
  charge.status = "loading";
  charge.loadError = null;
  regions.update("charge-body", "charge-province", "charge-actions");
  let answer: SwitchResult | LifetimeResult;
  try {
    answer = kind === "switch"
      ? await manageWebSubscription(session.app, { action: "quote_switch_yearly" })
      : await manageWebSubscription(session.app, lifetimeQuoteRequest(province));
  } catch (error) {
    if (loadId !== charge.loadId) return;
    const refusal = refusalFrom(error);
    if (refusal.kind === "signedOut" || refusal.kind === "accountDeleted") {
      await signOutFor(refusal);
      return;
    }
    if (refusal.kind === "switchUnavailable" || refusal.kind === "lifetimeUnavailable" || refusal.kind === "noSubscription") {
      await reloadAfter(unavailableText());
      return;
    }
    const asked = provinceAnswer(refusal, province);
    if (asked === "ask") {
      // The saved Canadian address has no province: the same select as the purchase asks for it.
      charge.needProvince = true;
      charge.status = "province";
      regions.update("charge-body", "charge-province", "charge-actions");
      focusSelector("#province");
      announce(t().provinceNeededUpgrade);
      return;
    }
    if (asked === "refused") {
      provinceRefused();
      return;
    }
    charge.status = "failed";
    charge.loadError = refusal;
    regions.update("charge-body", "charge-province", "charge-actions");
    announce(quoteFailureText(refusal));
    return;
  }
  if (loadId !== charge.loadId || answer.status !== "quote") return;
  charge.quote = answer.quote;
  charge.status = "ready";
  regions.update("charge-body", "charge-province", "charge-actions");
  // The province's button is gone with the select; the amounts take focus instead.
  if (province) focusSelector("#charge-summary");
  const total = formatMoney(answer.quote.total, answer.quote.currency, lang);
  announce(kind === "switch" ? t().switchQuoteReady(total) : t().lifetimeQuoteReady(total));
}

/// The province sent did not complete the address: back to the question, with the error at the select.
function provinceRefused() {
  charge.quote = null;
  charge.attemptId = null;
  charge.needProvince = true;
  charge.status = "province";
  regions.update("charge-body", "charge-province", "charge-actions");
  showError({ kind: "provinceRefused" }, "province");
}

/// "Change" next to the quote's province: the select comes back and the quote is dropped, so
/// nothing can be confirmed against a total worked out for another province.
function onChangeProvince() {
  if (page.busy) return;
  charge.quote = null;
  charge.attemptId = null;
  charge.status = "province";
  page.error = null;
  regions.update("charge-body", "charge-province", "charge-error", "charge-actions");
  focusSelector("#province");
  announce(t().provinceNeededUpgrade);
}

/// "Work out the amount" after choosing a province: quotes again with it, or asks for it first.
async function onProvinceQuote() {
  if (page.busy) return;
  if (!charge.province) {
    showError({ kind: "provinceMissing" }, "province");
    return;
  }
  page.error = null;
  // The loading line in the panel says what is happening; the button only shows it is busy.
  setBusy("charge");
  await loadChargeQuote();
  if (page.busy === "charge") setBusy(null);
}

function unavailableText(): string {
  return chargeKind() === "switch" ? t().switchUnavailableAnnouncement : t().lifetimeUnavailableAnnouncement;
}

async function onConfirmCharge() {
  if (page.busy || !charge.quote || charge.status !== "ready") return;
  const session = gate.session!;
  page.error = null;
  setBusy("charge", chargeKind() === "switch" ? t().switching : t().upgrading);
  charge.attemptId ??= crypto.randomUUID();
  let result: SwitchResult | LifetimeResult;
  try {
    result = charge.quote.plan === "web_yearly"
      ? await manageWebSubscription(session.app, switchRequest(charge.quote, charge.attemptId, lang))
      : await manageWebSubscription(session.app, lifetimeRequest(charge.quote, charge.attemptId, lang, charge.quote.billingState ?? null));
  } catch (error) {
    await chargeFailed(error);
    return;
  }
  await afterChargeAnswer(result);
}

async function afterChargeAnswer(result: SwitchResult | LifetimeResult) {
  const session = gate.session!;
  const kind = chargeKind();
  switch (result.status) {
    case "succeeded":
      charge.attemptId = null;
      await reloadAfter(kind === "switch" ? t().switchedAnnouncement : t().upgradedAnnouncement);
      return;
    case "quote":
    case "reprice":
      // Nothing was charged; the next press is a new attempt at the new total.
      charge.attemptId = null;
      charge.quote = result.quote;
      setBusy(null);
      regions.update("charge-body");
      announce(t().switchRepriced(formatMoney(result.quote.total, result.quote.currency, lang)));
      focusSelector("#charge-summary");
      return;
    case "requires_action": {
      setBusy("charge", t().verifyingPayment);
      const key = subscription?.publishableKey;
      let stripe;
      try {
        if (!key) throw new Error("no key");
        stripe = await stripeFor(key, lang);
      } catch {
        showError({ kind: "stripeUnavailable" }, "charge");
        return;
      }
      await bankStep(stripe, result.clientSecret, `#confirm-${kind}`);
      setBusy("charge", t().checkingPayment);
      let finished: SwitchResult | LifetimeResult;
      try {
        finished = kind === "switch"
          ? await manageWebSubscription(session.app, { action: "finish_switch_yearly", purchaseId: result.purchaseId })
          : await manageWebSubscription(session.app, { action: "finish_lifetime", purchaseId: result.purchaseId });
      } catch (error) {
        await chargeFailed(error);
        return;
      }
      if (finished.status === "requires_action") {
        // The same attempt is sent again on the next press, which asks for the bank step again.
        showError({ kind: "chargeVerifyNotCompleted" }, "charge");
        return;
      }
      await afterChargeAnswer(finished);
      return;
    }
  }
}

async function chargeFailed(error: unknown) {
  const refusal = refusalFrom(error);
  if (chargeKind() === "lifetime" && provinceAnswer(refusal, charge.quote?.plan === "web_lifetime" ? charge.quote.billingState ?? null : null) === "refused") {
    provinceRefused();
    return;
  }
  if (refusal.kind === "switchUnavailable" || refusal.kind === "lifetimeUnavailable" || refusal.kind === "noSubscription") {
    charge.attemptId = null;
    await reloadAfter(unavailableText());
    return;
  }
  if (!keepsAttempt(refusal)) charge.attemptId = null;
  await failed(error, "charge");
}

/// From a declined charge to the card panel, in the same place; "Back" there still returns to the
/// control that opened the charge.
function changeCardAfterDecline() {
  if (page.busy) return;
  const { slot, opener } = panel;
  closePanel();
  panel.kind = "card";
  panel.slot = slot;
  panel.opener = opener;
  page.error = null;
  render({ focus: "#card-panel-heading" });
}

// ---------------------------------------------------------------------------
// The purchase

function resetForm() {
  destroyPurchasePayment();
  Object.assign(form, {
    purchase: null,
    selected: null,
    cardStatus: "loading",
    quote: null,
    billingCountry: null,
    needProvince: false,
    province: "",
    acknowledged: false,
    acknowledgeError: false,
  });
}

function destroyPurchasePayment() {
  form.mountId += 1;
  if (form.payment) destroyPayment(form.payment);
  form.payment = null;
}

function purchaseKey(): string | null {
  return plansAnswer && "plans" in plansAnswer ? plansAnswer.plans.publishableKey : null;
}

async function mountCardForm() {
  const offer = selectedOffer();
  const host = document.getElementById("payment-host");
  const key = purchaseKey();
  if (!key || !offer || !host) return;
  const mountId = ++form.mountId;
  const onStatus = (status: CardFormStatus) => {
    if (mountId !== form.mountId) return;
    form.cardStatus = status;
    regions.update("card-status", "pay-region");
    if (status === "failed") announce(t().cardFormFailed);
  };
  let mounted: MountedPayment;
  try {
    mounted = await mountPayment({
      publishableKey: key,
      lang,
      kind: elementsKindFor(offer.plan),
      amount: shownTotal(offer, form.quote),
      currency: offer.currency,
      host,
      onStatus,
    });
  } catch {
    onStatus("failed");
    return;
  }
  if (mountId !== form.mountId) {
    destroyPayment(mounted);
    return;
  }
  form.payment = mounted;
  mounted.element.on("change", () => {
    // New card details: a price worked out from the last card no longer applies.
    if (page.busy || mountId !== form.mountId) return;
    const hadQuote = form.quote !== null;
    form.needProvince = false;
    form.province = "";
    if (page.error && page.error.place !== "pay" && isPurchasePlace(page.error.place)) page.error = null;
    if (hadQuote) {
      form.quote = null;
      syncElementsAmount();
    }
    regions.update("card-error", "pay-region");
  });
}

function isPurchasePlace(place: Place): boolean {
  return place === "card" || place === "province" || place === "pay";
}

function selectedOffer(): PlanOffer | null {
  return form.purchase?.offers.find((offer) => offer.plan === form.selected) ?? null;
}

function syncElementsAmount() {
  const offer = selectedOffer();
  if (offer && form.payment) updatePayment(form.payment, elementsKindFor(offer.plan), shownTotal(offer, form.quote), offer.currency);
}

function onPlanChange(plan: Plan) {
  if (page.busy || form.selected === plan) return;
  form.selected = plan;
  // A quote is for one plan.
  form.quote = null;
  form.needProvince = false;
  if (page.error && isPurchasePlace(page.error.place)) page.error = null;
  syncElementsAmount();
  regions.update("card-error", "pay-region");
}

function needsAcknowledgement(): boolean {
  return Boolean(form.purchase?.confirm) && !form.acknowledged;
}

async function onPay() {
  if (page.busy) return;
  const offer = selectedOffer();
  if (!offer || !gate.session) return;
  if (needsAcknowledgement()) {
    form.acknowledgeError = true;
    regions.update("acknowledge-region", "pay-region");
    focusSelector("#acknowledge");
    announce(t().acknowledgeFirst);
    return;
  }
  if (!form.payment || form.cardStatus !== "ready") return;
  if (form.needProvince && !form.province) {
    showError({ kind: "provinceMissing" }, "province");
    return;
  }
  page.error = null;
  setBusy("pay", t().paying(formatMoney(shownTotal(offer, form.quote), offer.currency, lang)));
  await purchase(offer);
}

/// Elements' validation, then a new confirmation token; null after showing why it failed.
async function newToken(payment: MountedPayment, place: "card" | "replace"): Promise<{ id: string; billingCountry: string | null } | null> {
  const submitted = await payment.elements.submit();
  if (submitted.error) {
    showError({ kind: "cardIncomplete" }, place);
    return null;
  }
  const created = await payment.stripe.createConfirmationToken({ elements: payment.elements });
  if (created.error || !created.confirmationToken) {
    const validation = created.error?.type === "validation_error" || created.error?.type === "card_error";
    showError(validation ? { kind: "cardIncomplete" } : { kind: "generic" }, validation || place === "replace" ? place : "pay");
    return null;
  }
  return { id: created.confirmationToken.id, billingCountry: billingCountryOf(created.confirmationToken) };
}

function billingCountryOf(token: ConfirmationToken): string | null {
  return token.payment_method_preview?.billing_details?.address?.country ?? null;
}

async function purchase(offer: PlanOffer) {
  const session = gate.session!;
  const token = await newToken(form.payment!, "card");
  if (!token) return;
  form.billingCountry = token.billingCountry;
  let result;
  try {
    result = await startWebPurchase(
      session.app,
      purchaseRequest({
        offer,
        quote: form.quote,
        freshTokenId: token.id,
        province: form.needProvince ? form.province : null,
        lang,
        acknowledged: Boolean(form.purchase?.confirm) && form.acknowledged,
      }),
    );
  } catch (error) {
    await purchaseRefused(refusalFrom(error));
    return;
  }
  switch (result.status) {
    case "reprice":
      showQuote(result.quote);
      return;
    case "succeeded":
      rememberPending(result.purchaseId, offer.plan);
      await reloadAfter(t().purchasedAnnouncement);
      return;
    case "requires_action": {
      setBusy("pay", t().verifyingPayment);
      let authenticationFailed: boolean;
      try {
        authenticationFailed = Boolean((await form.payment!.stripe.handleNextAction({ clientSecret: result.clientSecret })).error);
      } catch {
        authenticationFailed = true;
      }
      // The bank's window took focus with it; the pay button stays in place, busy.
      focusSelector("#pay");
      await settle(result.purchaseId, offer.plan, { authenticationFailed });
      return;
    }
    case "pending":
      await settle(result.purchaseId, offer.plan, { authenticationFailed: false });
      return;
  }
}

async function purchaseRefused(refusal: Refusal) {
  switch (refusal.kind) {
    case "signedOut":
    case "accountDeleted":
      await signOutFor(refusal);
      return;
    case "existingPremium": {
      // A stale page: read again, so the premium shows with its confirmation, in the lifetime
      // panel again when that is where the buyer was.
      const reopen = panel.kind === "buyLifetime" ? { slot: panel.slot, opener: panel.opener } : null;
      await load({ announce: t().existingPremiumChanged, loadingFocus: "#loading-status" });
      if (reopen && account && lifetimePurchaseIn(account, reopen.slot)) openPanel("buyLifetime", reopen.slot, reopen.opener);
      focusSelector("#acknowledge");
      return;
    }
    case "alreadySubscribed":
    case "lifetimeActive":
      // A stale page: the account already holds what this would buy, and reads it again.
      await reloadAfter(purchaseErrorText(refusal));
      return;
    case "billingAddressIncomplete":
      if (asksForProvince(refusal, form.billingCountry)) {
        // Not an error yet: the select appears with its hint, which is what is said.
        form.needProvince = true;
        page.error = null;
        setBusy(null);
        focusSelector("#province");
        announce(t().provinceNeeded);
        return;
      }
      showError(refusal, "card");
      return;
    case "declined":
    case "tokenInvalid":
    case "cardRequired":
    case "planUnavailable":
      showError(refusal, "card");
      return;
    default:
      showError(refusal, "pay");
  }
}

function showQuote(quote: Quote) {
  form.quote = quote;
  syncElementsAmount();
  setBusy(null);
  const offer = selectedOffer();
  const total = formatMoney(quote.total, quote.currency, lang);
  announce(offer && onlyTaxAdded(offer, quote) ? t().quoteTaxAnnouncement(total) : t().quoteAnnouncement(total));
  focusSelector("#quote-heading");
}

/// After the bank's check or a payment still in flight: asks the server where the purchase
/// stands, a few times while it is still confirming.
async function settle(purchaseId: string, plan: Plan, options: { authenticationFailed: boolean }) {
  const session = gate.session!;
  setBusy("pay", t().checkingPayment);
  const delays = options.authenticationFailed ? [0] : [0, 2000, 3000, 5000];
  let last: "pending" | "failed" | "noAnswer" = "pending";
  let category: DeclineCategory | undefined;
  for (const delay of delays) {
    if (delay) await sleep(delay);
    try {
      const outcome = await finishWebPurchase(session.app, purchaseId);
      if (outcome.status === "succeeded") {
        rememberPending(purchaseId, plan);
        await reloadAfter(t().purchasedAnnouncement);
        return;
      }
      last = outcome.status;
      category = outcome.category;
      if (outcome.status === "failed") break;
    } catch (error) {
      const refusal = refusalFrom(error);
      if (refusal.kind === "signedOut" || refusal.kind === "accountDeleted") {
        await signOutFor(refusal);
        return;
      }
      last = "noAnswer";
    }
  }
  if (last === "failed") {
    showError({ kind: "declined", category: category ?? "declined" }, "card");
    return;
  }
  if (options.authenticationFailed) {
    // The bank's window was closed or failed: the payment is still waiting, unpaid.
    showError({ kind: "authenticationNotCompleted" }, "card");
    return;
  }
  // Still confirming, or no answer: the page must not sell it again until the account shows it.
  rememberPending(purchaseId, plan);
  await reloadAfter(t().confirmingTitle);
}

/// After the buyer opened the verification link: a fresh ID token carries the new state.
async function checkVerifiedAgain() {
  const user = gate.signedIn?.user;
  if (!user) return;
  try {
    await user.reload();
    await user.getIdToken(true);
  } catch {
    // The plans call below reports what is still wrong.
  }
  await load({ loadingFocus: "#loading-status" });
}

async function onSignOut() {
  if (page.busy) return;
  closePanel();
  resetForm();
  pending = null;
  await gate.signOut(t().signedOutAnnouncement);
}

// ---------------------------------------------------------------------------
// Text

function priceText(offer: PlanOffer, s: Strings): string {
  const price = formatMoney(offer.amount, offer.currency, lang);
  return offer.interval === "month" ? s.perMonth(price) : offer.interval === "year" ? s.perYear(price) : s.once(price);
}

function declineText(category: DeclineCategory, s: Strings): string {
  switch (category) {
    case "insufficient_funds":
      return s.declinedFunds;
    case "expired_card":
      return s.declinedExpired;
    case "incorrect_details":
      return s.declinedDetails;
    case "authentication_failed":
      return s.declinedAuthentication;
    default:
      return s.declined;
  }
}

function renewalRepriceText(quote: Quote): string {
  return t().renewalReprice(formatMoney(quote.amount, quote.currency, lang), formatDate(subscription?.renewsAt ?? subscription?.endsAt, lang));
}

function quoteFailureText(refusal: Refusal): string {
  const s = t();
  switch (refusal.kind) {
    case "salesDisabled":
      return s.salesDisabled;
    case "noAnswer":
      return s.actionNoAnswer;
    case "billingAddressIncomplete":
      return s.upgradeAddressMissing;
    case "countryUnavailable":
      return countryNoticeText({ country: refusal.country, subscribed: true }, s, lang);
    default:
      return s.switchQuoteFailed;
  }
}

function errorText(error: ShownError, place: Place): string {
  return isPurchasePlace(place) ? purchaseErrorText(error) : manageErrorText(error, place);
}

/// The account already has a subscription, from this site or a store, so it is not sent to subscribe in the app.
function holdsSubscription(): boolean {
  const held = subscription !== null && subscription.state !== "none" && subscription.state !== "ended";
  return held || account?.status.kind === "storeRenews";
}

function purchaseErrorText(error: ShownError): string {
  const s = t();
  switch (error.kind) {
    case "declined":
      return declineText(error.category, s);
    case "cardIncomplete":
      return s.cardIncomplete;
    case "authenticationNotCompleted":
      return s.authenticationNotCompleted;
    case "provinceMissing":
      return s.provinceFirst;
    case "provinceRefused":
      return s.provinceRefused;
    case "countryUnavailable":
      return `${s.nothingCharged} ${countryNoticeText({ country: error.country, subscribed: holdsSubscription() }, s, lang)}`;
    case "tokenInvalid":
      return s.tokenExpired;
    case "cardRequired":
      return s.cardRequired;
    case "billingAddressIncomplete":
      return s.billingIncomplete;
    case "planUnavailable":
      return s.planUnavailable;
    case "throttled":
      return s.throttled;
    case "salesDisabled":
      return s.salesDisabled;
    case "emailUnverified":
      return s.emailUnverified;
    case "alreadySubscribed":
      return s.alreadySubscribedError;
    case "lifetimeActive":
      return s.lifetimeActiveError;
    case "storeSubscriptionActive":
      return s.storeActiveError(storeWords(error.platform, s, lang));
    case "purchaseInProgress":
      return s.purchaseInProgress;
    case "existingPremium":
      return s.existingPremiumChanged;
    case "accountDeleted":
      return s.accountDeleted;
    case "noAnswer":
      return s.paymentNoAnswer;
    default:
      return s.paymentFailed;
  }
}

function manageErrorText(error: ShownError, place: Place): string {
  const s = t();
  switch (error.kind) {
    case "declined":
      // A card change's check confirms the card, not a payment.
      if (place === "replace" && error.category === "authentication_failed") return s.cardVerifyFailed;
      return declineText(error.category, s);
    case "chargeVerifyNotCompleted":
      return chargeKind() === "switch" ? s.switchVerifyNotCompleted : s.lifetimeVerifyNotCompleted;
    case "chargeIncomplete":
      return s.chargeIncomplete;
    case "purchaseInProgress":
      return s.purchaseInProgress;
    case "cardIncomplete":
      return s.cardIncomplete;
    case "verifyNotCompleted":
      return s.verifyNotCompleted;
    case "cardVerifyNotCompleted":
      return s.cardVerifyNotCompleted;
    case "stripeUnavailable":
      return s.stripeUnavailable;
    case "tokenInvalid":
      return s.tokenExpired;
    case "cardRequired":
      return s.cardRequired;
    case "throttled":
      return s.throttled;
    case "salesDisabled":
      return place === "charge" ? s.salesDisabled : s.stripeUnavailable;
    case "noSubscription":
      return s.noSubscriptionError;
    case "noActionRequired":
      return s.noActionRequiredError;
    case "countryUnavailable":
      // A saved card is refused for its country; a switch or an upgrade charged nothing.
      return place === "replace"
        ? s.countryUnavailableCard(countryName(error.country, lang))
        : `${s.nothingCharged} ${countryNoticeText({ country: error.country, subscribed: true }, s, lang)}`;
    case "accountDeleted":
      return s.accountDeleted;
    case "noAnswer":
      return s.actionNoAnswer;
    default:
      return s.actionFailed;
  }
}

// ---------------------------------------------------------------------------
// Rendering

/// Re-renders the whole page; only loads, panels and language switches do this.
function render(options: { focus?: string } = {}) {
  replace.mountId += 1;
  if (replace.payment) destroyPayment(replace.payment);
  replace.payment = null;
  destroyPurchasePayment();
  regions.clear();
  regions = new Regions();
  renderShell({
    lang,
    body: body(),
    busy: view.kind === "loading" || (view.kind === "gate" && gate.phase === "loading"),
    // A new tab, so leaving for the terms never loses a card form being filled in.
    footerLink: externalLink(termsHref(lang), t().termsFooterLink, t(), "action-link"),
    onSwitchLanguage: switchLanguage,
  });
  if (options.focus) focusSelector(options.focus);
  if (view.kind !== "ready") return;
  if (panel.kind === "card") void mountReplaceForm();
  if (selectedOffer() && document.getElementById("payment-host")) void mountCardForm();
}

function switchLanguage() {
  if (page.busy) return;
  lang = lang === "ar" ? "en" : "ar";
  clearAnnouncements();
  gate.refresh();
  // The card forms are mounted again in the new language, so what was typed in them is gone.
  replace.quote = null;
  form.quote = null;
  form.needProvince = false;
  page.error = null;
  render();
  focusLanguageToggle();
}

function body(): Node[] {
  const s = t();
  switch (view.kind) {
    case "gate":
      return [heading(s.accountTitle), h("p", {}, s.accountIntro), h("div", { class: "step" }, ...gateStep(gate, s, () => void gate.start()))];
    case "loading":
      return [accountLine(gate.signedIn!, s), heading(s.accountTitle), ...loadingStep(s.loadingAccount)];
    case "loadFailed":
      return [
        accountLine(gate.signedIn!, s),
        heading(s.accountTitle),
        notice("danger", s, h("p", {}, view.refusal.kind === "noAnswer" ? s.actionNoAnswer : s.genericBody)),
        h("button", { type: "button", id: "load-retry", class: "btn", onclick: () => void load() }, s.retry),
        signOutRegion(),
      ];
    case "ready":
      return readyView(account!);
  }
}

function readyView(v: AccountView): Node[] {
  const s = t();
  // Each slot is replaced by the panel it opened; the slots the panel leaves update in place.
  const slot = (id: string, build: () => (Node | null)[], attrs: Record<string, string | undefined> = {}): Node =>
    panel.kind && panel.slot === id ? panelView() : regions.create(`slot-${id}`, build, attrs);
  return compact([
    accountLine(gate.signedIn!, s),
    heading(s.accountTitle),
    statusBlock(v),
    regions.create("actions-error", () => [errorFor("actions")]),
    v.primary && v.primary.kind !== "pay" ? slot("primary", primaryControl) : null,
    // The blocked-country notice is about selling; the card panel saves a card, which still works.
    ...v.sections.filter((section) => !(section.kind === "countryUnavailable" && panel.kind === "card")).map((section) => sectionView(section, slot)),
    v.cancel ? regions.create("cancel-region", cancelLink, { class: "cancel-row" }) : null,
    signOutRegion(),
  ]);
}

function signOutRegion(): Node {
  return regions.create("sign-out-region", () => [
    signOutButton(t(), { busy: page.busy !== null, onSignOut: () => void onSignOut() }),
  ]);
}

/// The status block: a title, one sentence, the plain lines about other premium; a warning
/// starts with a spoken "Attention" so its tone is never only a colour.
function statusBlock(v: AccountView): Node {
  const s = t();
  const text = statusText(v, s, lang);
  return h(
    "div",
    { class: `status ${v.tone}` },
    h("h2", { id: "status-title", class: "status-title" }, v.tone === "warn" ? h("span", { class: "sr-only" }, `${s.attention} `) : null, text.title),
    text.sentence ? h("p", {}, text.sentence) : null,
    ...text.lines.map((line) => h("p", { class: "status-line" }, line)),
  );
}

function controlButton(options: { id: string; action?: Action; label: string; busyLabel?: string; className?: string; onClick: (event: Event) => void }): Node {
  const mine = options.action !== undefined && page.busy === options.action;
  return h(
    "button",
    {
      type: "button",
      id: options.id,
      class: options.className ?? "btn secondary",
      "aria-disabled": page.busy !== null ? "true" : undefined,
      "aria-busy": mine ? "true" : undefined,
      "aria-describedby": page.error?.place === "actions" ? "actions-error-text" : undefined,
      onclick: (event: Event) => {
        if (page.busy === null) options.onClick(event);
      },
    },
    mine && options.busyLabel ? options.busyLabel : options.label,
  );
}

/// Exactly one filled control is on screen: every panel has its own pay, save or confirm button,
/// so while one is open the status's primary control is drawn as an outline.
function primaryClass(): string {
  return panel.kind ? "btn secondary" : "btn";
}

function primaryControl(): (Node | null)[] {
  const s = t();
  const primary = account?.primary;
  const className = primaryClass();
  switch (primary?.kind) {
    case "confirmPayment":
      return [controlButton({ id: "confirm-payment", action: "authenticate", label: s.confirmPayment, busyLabel: s.confirmingPayment, className, onClick: () => void runAuthenticate() })];
    case "changeCard":
      return [controlButton({ id: "primary-change-card", label: s.changeCard, className, onClick: () => openPanel("card", "primary", "primary-change-card") })];
    case "resume":
      return [controlButton({ id: "resume", action: "resume", label: s.resumeButton, busyLabel: s.resuming, className, onClick: () => void runResume() })];
    case "checkAgain":
      return [controlButton({ id: "check-payment", action: "check", label: s.checkAgain, busyLabel: s.checkingPayment, className, onClick: () => void runCheckAgain() })];
    case "manageInStore":
      return [storeManageLink(primary.platform, s, lang, className)];
    default:
      return [];
  }
}

function sectionView(section: Section, slot: (id: string, build: () => (Node | null)[], attrs?: Record<string, string | undefined>) => Node): Node {
  const s = t();
  switch (section.kind) {
    case "payingTwice": {
      const name = storeWords(section.platform, s, lang);
      return notice(
        "danger",
        s,
        h("p", { class: "strong" }, section.lifetime ? s.storeAlsoActiveLifetime(name) : s.storeAlsoActive(name)),
        h("p", {}, storeManageLink(section.platform, s, lang)),
      );
    }
    case "card":
      return slot(
        "card",
        () => [
          h("p", {}, `${s.labelCard} `, section.card ? cardText(section.card, s, lang) : null),
          // While a charge or card panel is open it carries the only change of card.
          panel.kind === "switch" || panel.kind === "lifetime" || panel.kind === "card"
            ? null
            : controlButton({ id: "change-card", label: s.changeCard, className: "btn secondary inline", onClick: () => openPanel("card", "card", "change-card") }),
        ],
        { class: "card-row" },
      );
    case "lifetimeInstead":
      return slot("lifetimeInstead", () => [
        controlButton({ id: "buy-lifetime-instead", label: s.lifetimeInstead, onClick: () => openPanel("buyLifetime", "lifetimeInstead", "buy-lifetime-instead") }),
      ]);
    case "upgrade":
      return slot(
        "upgrade",
        () => [
          h("h2", {}, s.upgradeHeading),
          section.yearly ? controlButton({ id: "switch-yearly", label: s.switchYearly, onClick: () => openPanel("switch", "upgrade", "switch-yearly") }) : null,
          section.lifetime ? controlButton({ id: "upgrade-lifetime", label: s.upgradeLifetime, onClick: () => openPanel("lifetime", "upgrade", "upgrade-lifetime") }) : null,
        ],
        { class: "block" },
      );
    case "payByCard":
      return slot(
        "payByCard",
        () => [
          h("h2", {}, s.payByCardHeading),
          h("p", {}, s.payByCardBody(storeWords(section.platform, s, lang), formatDate(section.until, lang))),
          section.lifetime
            ? controlButton({ id: "buy-lifetime-now", label: s.buyLifetimeNow, onClick: () => openPanel("buyLifetime", "payByCard", "buy-lifetime-now") })
            : null,
        ],
        { class: "block" },
      );
    case "continueAfter":
      return h("div", { class: "block" }, h("h2", {}, s.continueAfterHeading), ...purchaseView(section.purchase));
    case "purchase":
      return h("div", { class: "block" }, ...purchaseView(section.purchase));
    case "countryUnavailable":
      // In place of every sale: no card form and no pay button.
      return h("div", { class: "block" }, notice("warn", s, h("p", {}, countryNoticeText(section, s, lang))));
  }
}

function cancelLink(): (Node | null)[] {
  const s = t();
  const busy = page.busy !== null;
  const mine = page.busy === "cancel";
  return [
    h(
      "button",
      {
        type: "button",
        id: "cancel",
        class: "link-button danger-link",
        "aria-disabled": busy ? "true" : undefined,
        "aria-busy": mine ? "true" : undefined,
        "aria-describedby": page.error?.place === "actions" ? "actions-error-text" : undefined,
        onclick: (event: Event) => {
          if (!busy) openCancelDialog(event.currentTarget as HTMLElement);
        },
      },
      mine ? s.cancellingSubscription : s.cancelButton,
    ),
  ];
}

function errorFor(place: Place): Node | null {
  const error = page.error;
  if (!error || error.place !== place) return null;
  const s = t();
  const links: Node[] = [];
  if (error.error.kind === "storeSubscriptionActive") {
    const stores = error.error.platform ? [error.error.platform] : (["apple", "google"] as const);
    for (const store of stores) links.push(h("p", {}, storeManageLink(store, s, lang)));
  }
  return h("div", { id: `${place}-error-text`, class: "field-error" }, notice("danger", s, h("p", {}, errorText(error.error, place)), ...links));
}

// Panels

function panelView(): Node {
  switch (panel.kind) {
    case "card":
      return cardPanel();
    case "switch":
    case "lifetime":
      return chargePanel();
    default:
      return buyLifetimePanel();
  }
}

function backButton(id: string): Node {
  return h(
    "button",
    { type: "button", id, class: "btn secondary", "aria-disabled": page.busy !== null ? "true" : undefined, onclick: () => backFromPanel() },
    t().back,
  );
}

function cardPanel(): Node {
  const s = t();
  return h(
    "div",
    { class: "panel" },
    h("h2", { id: "card-panel-heading", tabindex: -1 }, s.changeCard),
    h("p", {}, subscription?.state === "payment_failed" ? s.replaceIntroPastDue : s.replaceIntro),
    h("p", { class: "muted small" }, s.cardsOnly),
    regions.create("replace-status", replaceStatus),
    paymentHost("replace-host", lang),
    regions.create("replace-error", () => [errorFor("replace")]),
    regions.create("replace-actions", replaceActions),
  );
}

function replaceStatus(): (Node | null)[] {
  const s = t();
  switch (replace.cardStatus) {
    case "loading":
      return [h("p", { class: "muted", role: "status" }, s.loadingCardForm)];
    case "failed":
      return [
        notice("danger", s, h("p", {}, subscription?.publishableKey ? s.cardFormFailed : s.stripeUnavailable)),
        h("button", { type: "button", id: "replace-retry", class: "btn secondary", onclick: () => void mountReplaceForm() }, s.retry),
      ];
    case "ready":
      return [];
  }
}

function replaceActions(): (Node | null)[] {
  const s = t();
  const busy = page.busy !== null;
  const quote = replace.quote;
  const price = quote ? formatMoney(quote.amount, quote.currency, lang) : null;
  const describedBy = [page.error?.place === "replace" ? "replace-error-text" : "", quote ? "replace-quote" : ""].filter(Boolean).join(" ");
  return [
    quote ? h("div", { id: "replace-quote", tabindex: -1 }, notice("warn", s, h("p", {}, renewalRepriceText(quote)))) : null,
    h(
      "button",
      {
        type: "button",
        id: "save-card",
        class: "btn",
        "aria-disabled": busy || replace.cardStatus !== "ready" ? "true" : undefined,
        "aria-busy": page.busy === "replace" ? "true" : undefined,
        "aria-describedby": describedBy || undefined,
        onclick: () => void onSaveCard(),
      },
      page.busy === "replace" ? page.progress || s.savingCard : price ? s.saveCardAccept(price) : s.saveCard,
    ),
    backButton("replace-back"),
  ];
}

function chargePanel(): Node {
  const s = t();
  const lifetime = panel.kind === "lifetime";
  return h(
    "div",
    { class: "panel" },
    h("h2", { id: `${panel.kind}-heading`, tabindex: -1 }, lifetime ? s.upgradeLifetime : s.switchYearly),
    h("p", {}, lifetime ? s.lifetimeIntro : s.switchIntro),
    regions.create("charge-body", chargeBody),
    regions.create("charge-province", () => [
      charge.needProvince && charge.status !== "ready" && charge.status !== "failed"
        ? provinceField(charge.province, s.provinceNeededUpgrade, "charge-province", (value) => (charge.province = value))
        : null,
    ]),
    regions.create("charge-error", () => [errorFor("charge")]),
    regions.create("charge-actions", chargeActions),
  );
}

/// The quote's rows and notes, from the summary of the panel's kind.
function chargeSummary(): SwitchSummary {
  const quote = charge.quote!;
  return quote.plan === "web_yearly"
    ? switchSummary(quote, subscription?.state ?? "active", t(), lang, subscription?.renewalTaxed === true)
    : lifetimeSummary(quote, t(), lang, subscription?.state ?? "active");
}

function chargeBody(): (Node | null)[] {
  const s = t();
  switch (charge.status) {
    case "loading":
      return [h("p", { class: "muted", role: "status" }, s.loadingSwitchQuote)];
    case "province":
      // The select's label and hint say it all.
      return [];
    case "failed":
      return [
        notice("danger", s, h("p", {}, quoteFailureText(charge.loadError ?? { kind: "generic" }))),
        // The panel's only action besides Back, so the one filled control on screen; none when
        // trying again cannot help.
        charge.loadError?.kind === "countryUnavailable"
          ? null
          : h("button", { type: "button", id: "charge-retry", class: "btn", onclick: () => void loadChargeQuote() }, s.retry),
        // No address to tax at: a card change saves the new card's address.
        charge.loadError?.kind === "billingAddressIncomplete"
          ? h("button", { type: "button", id: "charge-change-card", class: "btn secondary", onclick: () => changeCardAfterDecline() }, s.changeCard)
          : null,
      ];
    case "ready": {
      const summary = chargeSummary();
      return [
        h(
          "div",
          { id: "charge-summary", tabindex: -1 },
          h("ul", { class: "plain details" }, ...summary.rows.map((row) => h("li", {}, `${row.label} `, row.value))),
          ...summary.notes.map((note) => h("p", {}, note)),
          // Inside the summary the confirm button points at, so the terms are part of what it says.
          h("p", {}, termsLine(s, lang)),
        ),
        // Outside the summary, so the confirm button's description never reads it.
        charge.quote?.plan === "web_lifetime" && charge.quote.billingState
          ? h(
              "button",
              {
                type: "button",
                id: "charge-change-province",
                class: "btn secondary",
                "aria-label": s.provinceChangeLabel,
                "aria-disabled": page.busy !== null ? "true" : undefined,
                onclick: () => onChangeProvince(),
              },
              s.provinceChange,
            )
          : null,
      ];
    }
  }
}

function chargeActions(): (Node | null)[] {
  const s = t();
  const busy = page.busy !== null;
  const ready = charge.status === "ready" && charge.quote !== null;
  const declined = page.error?.place === "charge" && page.error.error.kind === "declined";
  const describedBy = [page.error?.place === "charge" ? "charge-error-text" : "", ready ? "charge-summary" : ""].filter(Boolean).join(" ");
  const asking = charge.needProvince && (charge.status === "province" || charge.status === "loading");
  return [
    asking
      ? h(
          "button",
          {
            type: "button",
            id: "charge-quote",
            class: "btn",
            "aria-disabled": busy ? "true" : undefined,
            "aria-busy": page.busy === "charge" ? "true" : undefined,
            onclick: () => void onProvinceQuote(),
          },
          page.busy === "charge" ? page.progress || s.loadingSwitchQuote : s.provinceWorkOut,
        )
      : null,
    ready
      ? h(
          "button",
          {
            type: "button",
            id: `confirm-${panel.kind}`,
            class: "btn",
            "aria-disabled": busy ? "true" : undefined,
            "aria-busy": page.busy === "charge" ? "true" : undefined,
            "aria-describedby": describedBy || undefined,
            onclick: () => void onConfirmCharge(),
          },
          page.busy === "charge" ? page.progress || s.switching : chargeSummary().confirm,
        )
      : null,
    declined
      ? h(
          "button",
          { type: "button", id: "charge-change-card", class: "btn secondary", "aria-disabled": busy ? "true" : undefined, onclick: () => changeCardAfterDecline() },
          s.changeCard,
        )
      : null,
    backButton("charge-back"),
  ];
}

function buyLifetimePanel(): Node {
  const s = t();
  return h(
    "div",
    { class: "panel" },
    h("h2", { id: "buyLifetime-heading", tabindex: -1 }, s.buyLifetimeHeading),
    ...(form.purchase ? purchaseView(form.purchase) : []),
    regions.create("panel-back", () => [backButton("buy-lifetime-back")]),
  );
}

// The purchase

/// The purchase in order: the confirmation and its tick, the plans, the card form, then the note
/// and the pay button; or one sentence saying why nothing can be bought now.
function purchaseView(purchase: Purchase): Node[] {
  const s = t();
  if (purchase.unavailable) return unavailableView(purchase.unavailable);
  if (form.purchase !== purchase) {
    form.purchase = purchase;
    form.selected = defaultPlan(purchase.offers);
  }
  return compact([
    purchase.confirm ? regions.create("acknowledge-region", confirmationView) : null,
    purchase.unknownCountry ? notice("info", s, h("p", {}, s.unknownCountryNote)) : null,
    planGroup(purchase),
    h(
      "div",
      { class: "pay-card" },
      h("h3", { id: "card-heading" }, s.cardHeading),
      h("p", { class: "muted small" }, s.cardsOnly),
      regions.create("card-status", cardStatus),
      paymentHost("payment-host", lang),
      regions.create("card-error", () => [errorFor("card")]),
    ),
    regions.create("pay-region", payRegion),
  ]);
}

function unavailableView(reason: NonNullable<Purchase["unavailable"]>): Node[] {
  const s = t();
  switch (reason) {
    case "salesDisabled":
      return [notice("info", s, h("p", {}, s.salesDisabled))];
    case "emailUnverified":
      return [
        notice("info", s, h("p", {}, s.emailUnverified)),
        h("button", { type: "button", id: "check-again", class: "btn", onclick: () => void checkVerifiedAgain() }, s.checkAgain),
      ];
    case "noAnswer":
    case "generic":
      return [
        notice("danger", s, h("p", {}, reason === "noAnswer" ? s.actionNoAnswer : s.genericBody)),
        h("button", { type: "button", id: "plans-retry", class: "btn secondary", onclick: () => void reloadPlans() }, s.retry),
      ];
  }
}

/// What the buyer confirms before choosing a plan: the purchase starts today and adds nothing to
/// the premium already held, a renewing store keeps charging, and the tick the payment waits for.
function confirmationView(): (Node | null)[] {
  const s = t();
  const confirm = form.purchase?.confirm;
  if (!confirm) return [];
  const checkbox = h("input", {
    type: "checkbox",
    id: "acknowledge",
    "aria-invalid": form.acknowledgeError ? "true" : undefined,
    "aria-describedby": form.acknowledgeError ? "existing-notice acknowledge-error" : "existing-notice",
    onchange: (event: Event) => {
      form.acknowledged = (event.target as HTMLInputElement).checked;
      form.acknowledgeError = false;
      regions.update("acknowledge-region", "pay-region");
    },
  });
  checkbox.checked = form.acknowledged;
  checkbox.disabled = page.busy !== null;
  return [
    h(
      "div",
      { id: "existing-notice" },
      notice(
        "warn",
        s,
        h("p", { class: "strong" }, s.confirmStartsToday),
        ...confirm.renewingStores.flatMap((store) => [
          h("p", {}, s.storeKeepsRenewing(storeWords(store, s, lang))),
          h("p", {}, storeManageLink(store, s, lang)),
        ]),
      ),
    ),
    h("label", { class: `check calm${form.acknowledgeError ? " invalid" : ""}`, for: "acknowledge" }, checkbox, h("span", {}, s.acknowledge)),
    form.acknowledgeError ? h("p", { id: "acknowledge-error", class: "error" }, s.acknowledgeFirst) : null,
  ];
}

/// The plans as whole-row radios, or a single line when only one is on offer.
function planGroup(purchase: Purchase): Node {
  const s = t();
  if (purchase.offers.length === 1) {
    const offer = purchase.offers[0];
    return h("p", { class: "plan-single" }, h("span", { class: "plan-name" }, `${planName(offer.plan, s)}: `), priceText(offer, s));
  }
  return h(
    "fieldset",
    { class: "plans" },
    h("legend", {}, s.choosePlan),
    ...purchase.offers.map((offer) => {
      const id = `plan-${offer.plan}`;
      const input = h("input", { type: "radio", name: "plan", id, value: offer.plan, onchange: () => onPlanChange(offer.plan) });
      input.checked = form.selected === offer.plan;
      input.disabled = page.busy !== null;
      const yearly = offer.interval === "year";
      return h(
        "label",
        { class: "plan", for: id },
        input,
        h(
          "span",
          { class: "plan-text" },
          h("span", { class: "plan-head" }, h("span", { class: "plan-name" }, planName(offer.plan, s)), yearly && purchase.savedPercent > 0 ? h("span", { class: "badge" }, s.savePercent(purchase.savedPercent)) : null),
          h("span", { class: "plan-price" }, priceText(offer, s)),
          yearly ? h("span", { class: "plan-hint" }, s.yearlyPerMonth(formatMoney(Math.round(offer.amount / 12), offer.currency, lang))) : null,
          offer.interval === null ? h("span", { class: "plan-hint" }, s.lifetimeHint) : null,
        ),
      );
    }),
  );
}

function cardStatus(): (Node | null)[] {
  const s = t();
  switch (form.cardStatus) {
    case "loading":
      return [h("p", { class: "muted", role: "status" }, s.loadingCardForm)];
    case "failed":
      return [
        notice("danger", s, h("p", {}, s.cardFormFailed)),
        h("button", { type: "button", id: "card-retry", class: "btn secondary", onclick: () => void mountCardForm() }, s.retry),
      ];
    case "ready":
      return [];
  }
}

function payRegion(): (Node | null)[] {
  const s = t();
  const offer = selectedOffer();
  if (!offer) return [];
  const total = shownTotal(offer, form.quote);
  const quote = form.quote && form.quote.plan === offer.plan ? form.quote : null;
  const errorId = page.error && (page.error.place === "card" || page.error.place === "pay") ? `${page.error.place}-error-text` : "";
  // Waiting for the tick, the button says so through the notice that explains it; a press still
  // takes focus to the tick.
  const state = payButtonState({
    busy: page.busy !== null,
    cardReady: form.cardStatus === "ready",
    waitingForTick: needsAcknowledgement(),
    errorId: errorId || null,
    quote: quote !== null,
  });
  const amount = formatMoney(total, offer.currency, lang);
  return [
    form.needProvince ? provinceField(form.province, s.provinceNeeded, "pay-region", (value) => (form.province = value)) : null,
    quote ? quoteView(offer, quote) : null,
    errorFor("pay"),
    // The terms sentence stays inside the note the pay button points at.
    h("p", { id: "pay-note", class: "pay-note" }, payNote(offer, total, s, lang), termsLine(s, lang)),
    h(
      "button",
      {
        type: "button",
        id: "pay",
        class: "btn",
        "aria-disabled": state.disabled ? "true" : undefined,
        "aria-busy": page.busy === "pay" ? "true" : undefined,
        "aria-describedby": state.describedBy,
        onclick: () => void onPay(),
      },
      page.busy === "pay" ? page.progress || s.paying(amount) : s.pay(amount),
    ),
  ];
}

/// The Canadian province select, in the purchase's pay region or the upgrade panel's own region,
/// whichever `region` names; its hint says what it is for there.
function provinceField(value: string, hint: string, region: string, onChoose: (value: string) => void): Node {
  const s = t();
  const invalid = page.error?.place === "province";
  const select = h(
    "select",
    {
      id: "province",
      name: "province",
      required: true,
      "aria-invalid": invalid ? "true" : undefined,
      // The hint stays read with the error, which is short and says only what is missing.
      "aria-describedby": invalid ? "province-hint province-error-text" : "province-hint",
      onchange: (event: Event) => {
        onChoose((event.target as HTMLSelectElement).value);
        if (page.error?.place === "province") {
          page.error = null;
          regions.update(region);
        }
      },
    },
    h("option", { value: "" }, s.provinceChoose),
    ...Object.entries(s.provinces).map(([code, name]) => h("option", { value: code }, name)),
  );
  select.value = value;
  select.disabled = page.busy !== null;
  return h(
    "div",
    { class: "group" },
    h("label", { for: "province" }, s.provinceLabel),
    h("p", { id: "province-hint", class: "muted small" }, hint),
    h("div", { class: `field select${invalid ? " invalid" : ""}` }, select),
    errorFor("province"),
  );
}

/// The re-priced total: information when only tax was added, a warning when the price changed.
function quoteView(offer: PlanOffer, quote: Quote): Node {
  const s = t();
  const money = (cents: number) => formatMoney(cents, quote.currency, lang);
  const taxOnly = onlyTaxAdded(offer, quote);
  const reason =
    quote.reason === "card_country"
      ? s.quoteReasonCardCountry
      : quote.reason === "tax"
        ? s.quoteReasonTax
        : quote.reason === "both"
          ? s.quoteReasonBoth
          : s.quoteReasonPriceChanged;
  return h(
    "div",
    { id: "quote" },
    notice(
      taxOnly ? "info" : "warn",
      s,
      h("h3", { id: "quote-heading", tabindex: -1 }, taxOnly ? s.quoteTaxHeading(money(quote.total)) : s.quoteHeading),
      taxOnly ? null : h("p", {}, reason),
      h(
        "ul",
        { class: "plain breakdown" },
        h("li", {}, `${s.quotePrice}: `, money(quote.amount)),
        h("li", {}, `${s.quoteTax}: `, money(quote.tax)),
        h("li", { class: "strong" }, `${s.quoteTotal}: `, money(quote.total)),
      ),
      h("p", {}, taxOnly ? s.quoteTaxBody : s.quoteNothingCharged),
    ),
  );
}

/// Entry point the router calls once.
export function mount(): void {
  void gate.start();
}
