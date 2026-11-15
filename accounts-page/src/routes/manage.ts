/// `/manage`: the signed-in account's web subscription, with cancel, resume, card replacement and
/// the bank's verification of a renewal.

import { h, ltr } from "../dom";
import { STRINGS, langFromParam, type Lang, type Strings } from "../i18n";
import { announce, focusLanguageToggle, focusSelector, heading, renderShell } from "../shell";
import { finishWebPurchase, getWebSubscription, manageWebSubscription } from "../billing/api";
import {
  cardBrandName,
  doubleSubscriptionStore,
  formatDate,
  formatMoney,
  intervalOf,
  manageActions,
  refusalFrom,
  replaceCardRequest,
  type DeclineCategory,
  type ManageResult,
  type Quote,
  type Refusal,
  type SubscriptionResponse,
  type SubscriptionState,
} from "../billing/logic";
import { mountPayment, paymentHost, stripeFor, type MountedPayment } from "../billing/stripe";
import {
  accountRow,
  compact,
  createGate,
  gateStep,
  loadingStep,
  notice,
  pageLink,
  Regions,
  storeCancelLink,
  storeName,
  type GateChange,
} from "../billing/ui";

type View = { kind: "gate" } | { kind: "loading" } | { kind: "loadFailed"; refusal: Refusal } | { kind: "ready" };

type Action = "cancel" | "resume" | "authenticate" | "replace";
type ShownError = Refusal | { kind: "cardIncomplete" | "verifyNotCompleted" | "cardVerifyNotCompleted" | "stripeUnavailable" };

let lang: Lang = langFromParam(new URLSearchParams(location.search).get("lang"));
let view: View = { kind: "gate" };
let subscription: SubscriptionResponse | null = null;
let publishableKey: string | null = null;
let regions = new Regions();

const page = {
  busy: null as Action | null,
  progress: "",
  error: null as { error: ShownError; place: "actions" | "replace" } | null,
};

const replace = {
  open: false,
  payment: null as MountedPayment | null,
  mountId: 0,
  cardStatus: "loading" as "loading" | "failed" | "ready",
  quote: null as Quote | null,
};

const gate = createGate({ lang: () => lang, onChange: onGateChange });

function t(): Strings {
  return STRINGS[lang];
}

// ---------------------------------------------------------------------------
// Flow

function onGateChange(change: GateChange) {
  if (gate.phase === "signedIn") {
    void load({ announce: change.announce, focus: "h1" });
    return;
  }
  view = { kind: "gate" };
  render({ focus: change.focus });
  if (change.announce) announce(change.announce);
}

/// Reads the subscription (the server syncs it from Stripe first) and shows it.
async function load(options: { announce?: string; focus?: string } = {}) {
  const session = gate.session;
  if (!session) return;
  closeReplace();
  view = { kind: "loading" };
  render({ focus: options.focus });
  if (options.announce) announce(options.announce);
  try {
    subscription = await getWebSubscription(session.app);
    publishableKey = subscription.publishableKey ?? null;
  } catch (error) {
    const refusal = refusalFrom(error);
    if (refusal.kind === "signedOut" || refusal.kind === "accountDeleted") {
      await gate.signOut(refusal.kind === "accountDeleted" ? t().accountDeleted : undefined);
      return;
    }
    view = { kind: "loadFailed", refusal };
    render({ focus: "h1" });
    announce(refusal.kind === "salesDisabled" ? t().salesDisabled : refusal.kind === "noAnswer" ? t().networkBody : t().genericBody);
    return;
  }
  view = { kind: "ready" };
  render({ focus: options.focus ?? "#status-heading" });
}

/// After an action: shows the new state with focus on its heading, and says what happened.
async function reloadAfter(message: string) {
  page.busy = null;
  page.error = null;
  await load({ focus: "#status-heading" });
  announce(`${message} ${statusHeadingText(subscription?.state ?? "none")}.`);
}

function setBusy(action: Action | null, progress = "") {
  page.busy = action;
  page.progress = progress;
  replace.payment?.element.update({ readOnly: action !== null });
  regions.update("actions", "replace-actions");
  if (progress) announce(progress);
}

function showError(error: ShownError, place: "actions" | "replace") {
  page.busy = null;
  page.error = { error, place };
  replace.payment?.element.update({ readOnly: false });
  regions.update("actions", "replace-actions", "replace-error");
  announce(errorText(error, place));
  if (!document.activeElement || document.activeElement === document.body) {
    // The bank's window took focus with it when it closed.
    focusSelector(place === "replace" ? "#save-card" : "#status-heading");
  }
}

async function failed(error: unknown, place: "actions" | "replace") {
  const refusal = refusalFrom(error);
  if (refusal.kind === "signedOut" || refusal.kind === "accountDeleted") {
    page.busy = null;
    closeReplace();
    await gate.signOut(refusal.kind === "accountDeleted" ? t().accountDeleted : undefined);
    return;
  }
  showError(refusal, place);
}

/// The publishable key from the subscription answer; null when the backend left it out because
/// it does not match the key's mode.
async function stripeKey(): Promise<string | null> {
  return publishableKey;
}

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
      h("button", { type: "button", id: "cancel-keep", class: "btn secondary", autofocus: true, onclick: () => dialog.close("keep") }, s.keepSubscription),
      h("button", { type: "button", id: "cancel-confirm", class: "btn danger", onclick: () => dialog.close("confirm") }, s.confirmCancel),
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

// The bank's verification of a renewal

async function runAuthenticate() {
  if (page.busy) return;
  const session = gate.session!;
  setBusy("authenticate", t().verifying);
  const key = await stripeKey();
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
  try {
    await stripe.handleNextAction({ clientSecret: answer.clientSecret });
  } catch {
    // Whatever happened, the server says where the payment stands.
  }
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

// Card replacement

function openReplace() {
  if (page.busy) return;
  replace.open = true;
  replace.quote = null;
  page.error = null;
  render({ focus: "#replace-heading" });
}

function closeReplace() {
  replace.mountId += 1;
  replace.payment?.element.destroy();
  replace.payment = null;
  replace.open = false;
  replace.quote = null;
  replace.cardStatus = "loading";
}

function cancelReplace() {
  if (page.busy) return;
  closeReplace();
  page.error = null;
  render({ focus: "#replace-card" });
}

async function mountReplaceForm() {
  const host = document.getElementById("replace-host");
  if (!host) return;
  const mountId = ++replace.mountId;
  replace.cardStatus = "loading";
  regions.update("replace-status");
  const key = await stripeKey();
  let mounted: MountedPayment | null = null;
  if (key) {
    try {
      mounted = await mountPayment({
        publishableKey: key,
        lang,
        kind: "setup",
        amount: 0,
        currency: subscription?.currency ?? "usd",
        host,
      });
    } catch {
      mounted = null;
    }
  }
  if (mountId !== replace.mountId) {
    mounted?.element.destroy();
    return;
  }
  if (!mounted) {
    replace.cardStatus = "failed";
    regions.update("replace-status", "replace-actions");
    announce(key ? t().cardFormFailed : t().stripeUnavailable);
    return;
  }
  replace.payment = mounted;
  mounted.element.on("ready", () => {
    if (mountId !== replace.mountId) return;
    replace.cardStatus = "ready";
    regions.update("replace-status", "replace-actions");
  });
  mounted.element.on("loaderror", () => {
    if (mountId !== replace.mountId) return;
    replace.cardStatus = "failed";
    regions.update("replace-status", "replace-actions");
    announce(t().cardFormFailed);
  });
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
  regions.update("replace-error");
  setBusy("replace", t().savingCard);
  await saveCard();
}

async function newSetupToken(): Promise<string | null> {
  const payment = replace.payment!;
  const submitted = await payment.elements.submit();
  if (submitted.error) {
    showError({ kind: "cardIncomplete" }, "replace");
    return null;
  }
  const created = await payment.stripe.createConfirmationToken({ elements: payment.elements });
  if (created.error || !created.confirmationToken) {
    const validation = created.error?.type === "validation_error" || created.error?.type === "card_error";
    showError(validation ? { kind: "cardIncomplete" } : { kind: "generic" }, "replace");
    return null;
  }
  return created.confirmationToken.id;
}

/// Every press makes a new token from the card form as it is then, an accepted re-price included.
async function saveCard() {
  const session = gate.session!;
  const token = await newSetupToken();
  if (!token) return;
  let result: ManageResult;
  try {
    result = await manageWebSubscription(session.app, replaceCardRequest(token, replace.quote));
  } catch (error) {
    await failed(error, "replace");
    return;
  }
  await afterReplaceAnswer(result);
}

async function afterReplaceAnswer(result: ManageResult) {
  const session = gate.session!;
  switch (result.status) {
    case "succeeded":
      await reloadAfter(t().cardSavedAnnouncement);
      return;
    case "reprice":
      // Saving again sends a new token with the quoted renewal amount.
      replace.quote = result.quote;
      page.busy = null;
      replace.payment?.element.update({ readOnly: false });
      regions.update("replace-actions", "replace-error");
      announce(repriceText(result.quote));
      focusSelector("#replace-quote");
      return;
    case "requires_action": {
      setBusy("replace", t().verifyingCard);
      try {
        await replace.payment!.stripe.handleNextAction({ clientSecret: result.clientSecret });
      } catch {
        // The server says where the card change stands.
      }
      let finished: ManageResult;
      try {
        finished = await manageWebSubscription(session.app, { action: "finish_replace_card", setupIntentId: result.setupIntentId });
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

async function onSignOut() {
  if (page.busy) return;
  closeReplace();
  await gate.signOut(t().signedOutAnnouncement);
}

// ---------------------------------------------------------------------------
// Text

function money(cents: number, currency: string): string {
  return formatMoney(cents, currency, lang);
}

function planName(plan: string | undefined, s: Strings): string {
  return plan === "web_monthly" ? s.planMonthly : plan === "web_yearly" ? s.planYearly : plan === "web_lifetime" ? s.planLifetime : "";
}

function priceText(sub: SubscriptionResponse, s: Strings): string | null {
  if (typeof sub.amount !== "number" || !sub.currency) return null;
  const price = money(sub.amount, sub.currency);
  const interval = intervalOf(sub.plan);
  return interval === "month" ? s.perMonth(price) : interval === "year" ? s.perYear(price) : price;
}

function statusHeadingText(state: SubscriptionState): string {
  const s = t();
  const headings: Record<SubscriptionState, string> = {
    active: s.stateActive,
    cancelling: s.stateCancelling,
    payment_failed: s.statePaymentFailed,
    needs_action: s.stateNeedsAction,
    lifetime: s.stateLifetime,
    ended: s.stateEnded,
    none: s.stateNone,
  };
  return headings[state];
}

function statusBody(sub: SubscriptionResponse, s: Strings): string {
  const renews = formatDate(sub.renewsAt, lang);
  const ends = formatDate(sub.endsAt, lang);
  switch (sub.state) {
    case "active":
      return s.activeBody(renews);
    case "cancelling":
      return s.cancellingBody(ends);
    case "payment_failed":
      return s.paymentFailedBody(ends);
    case "needs_action":
      return s.needsActionBody(ends);
    case "lifetime":
      return s.lifetimeBody;
    case "ended":
      return s.endedBody(ends);
    case "none":
      return s.noneBody;
  }
}

function repriceText(quote: Quote): string {
  return t().renewalReprice(money(quote.amount, quote.currency), formatDate(subscription?.renewsAt ?? subscription?.endsAt, lang));
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

function errorText(error: ShownError, place: "actions" | "replace" = page.error?.place ?? "actions"): string {
  const s = t();
  switch (error.kind) {
    case "declined":
      // A card replacement's check verifies the card, not a payment.
      if (place === "replace" && error.category === "authentication_failed") return s.cardVerifyFailed;
      return declineText(error.category, s);
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
      return s.stripeUnavailable;
    case "noSubscription":
      return s.noSubscriptionError;
    case "noActionRequired":
      return s.noActionRequiredError;
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

function render(options: { focus?: string } = {}) {
  replace.mountId += 1;
  replace.payment?.element.destroy();
  replace.payment = null;
  regions.clear();
  regions = new Regions();
  renderShell({
    lang,
    body: body(),
    busy: view.kind === "loading" || (view.kind === "gate" && gate.phase === "loading"),
    onSwitchLanguage: switchLanguage,
  });
  if (options.focus) focusSelector(options.focus);
  if (view.kind === "ready" && replace.open) void mountReplaceForm();
}

function switchLanguage() {
  if (page.busy) return;
  lang = lang === "ar" ? "en" : "ar";
  gate.refresh();
  replace.quote = null;
  render();
  focusLanguageToggle();
}

function body(): Node[] {
  const s = t();
  switch (view.kind) {
    case "gate":
      return [heading(s.manageTitle), h("section", { class: "step" }, ...gateStep(gate, s, () => void gate.start()))];
    case "loading":
      return [heading(s.manageTitle), signedInRow(), ...loadingStep(s.loadingSubscription)];
    case "loadFailed": {
      const refusal = view.refusal;
      const text = refusal.kind === "salesDisabled" ? s.salesDisabled : refusal.kind === "noAnswer" ? s.networkBody : s.genericBody;
      return compact([
        heading(s.manageTitle),
        signedInRow(),
        notice("danger", "!", h("p", {}, text)),
        refusal.kind === "salesDisabled"
          ? null
          : h("button", { type: "button", id: "load-retry", class: "btn", onclick: () => void load({ focus: "h1" }) }, s.retry),
      ]);
    }
    case "ready":
      return readyView(subscription!);
  }
}

function signedInRow(): Node {
  return accountRow(gate.signedIn!, t(), { busy: page.busy !== null, onSignOut: () => void onSignOut() });
}

function readyView(sub: SubscriptionResponse): Node[] {
  const s = t();
  const actions = manageActions(sub.state);
  const nodes: (Node | null)[] = [heading(s.manageTitle), signedInRow(), statusSection(sub)];
  const store = doubleSubscriptionStore(sub);
  if (store) {
    const name = storeName(store, s);
    nodes.push(
      notice(
        "danger",
        "!",
        h("p", { class: "strong" }, sub.state === "lifetime" ? s.storeAlsoActiveLifetime(name) : s.storeAlsoActive(name)),
        h("p", {}, storeCancelLink(store, s)),
      ),
    );
  }
  if (actions.subscribe) nodes.push(pageLink("/subscribe", s.subscribeLink, lang, "btn"));
  nodes.push(regions.create("actions", () => actionButtons(sub)));
  if (replace.open) nodes.push(replaceSection(sub));
  return compact(nodes);
}

function statusSection(sub: SubscriptionResponse): Node {
  const s = t();
  const details: (Node | null)[] = [];
  const plan = planName(sub.plan, s);
  if (plan) details.push(h("li", {}, `${s.labelPlan} `, plan));
  const price = priceText(sub, s);
  if (price && sub.state !== "ended" && sub.state !== "none") {
    details.push(h("li", {}, `${sub.state === "lifetime" ? s.labelPaid : s.labelPrice} `, price));
  }
  const renews = formatDate(sub.renewsAt, lang);
  if (renews && sub.state === "active") details.push(h("li", {}, `${s.labelRenews} `, renews));
  const ends = formatDate(sub.endsAt, lang);
  if (ends && (sub.state === "cancelling" || sub.state === "payment_failed" || sub.state === "needs_action")) {
    details.push(h("li", {}, `${s.labelEnds} `, ends));
  }
  if (sub.card) {
    details.push(h("li", {}, `${s.labelCard} `, `${s.cardEnding(cardBrandName(sub.card.brand))} `, ltr(sub.card.last4)));
  }
  const tone = sub.state === "payment_failed" || sub.state === "needs_action" ? "warn" : null;
  return h(
    "section",
    { class: `status${tone ? ` ${tone}` : ""}`, "aria-labelledby": "status-heading" },
    h("h2", { id: "status-heading", tabindex: -1 }, statusHeadingText(sub.state)),
    h("p", {}, statusBody(sub, s)),
    details.length ? h("ul", { class: "plain details" }, ...compact(details)) : null,
  );
}

function errorFor(place: "actions" | "replace"): Node | null {
  if (!page.error || page.error.place !== place) return null;
  return h("div", { id: `${place}-error-text` }, notice("danger", "!", h("p", {}, errorText(page.error.error))));
}

function actionButton(options: { id: string; action: Action; label: string; busyLabel?: string; className?: string; onClick: (event: Event) => void }): Node {
  const busy = page.busy !== null;
  const mine = page.busy === options.action;
  return h(
    "button",
    {
      type: "button",
      id: options.id,
      class: options.className ?? "btn secondary",
      "aria-disabled": busy ? "true" : undefined,
      "aria-busy": mine ? "true" : undefined,
      "aria-describedby": page.error?.place === "actions" ? "actions-error-text" : undefined,
      onclick: options.onClick,
    },
    mine && options.busyLabel ? options.busyLabel : options.label,
  );
}

function actionButtons(sub: SubscriptionResponse): (Node | null)[] {
  const s = t();
  const actions = manageActions(sub.state);
  return [
    errorFor("actions"),
    actions.authenticate
      ? actionButton({ id: "verify", action: "authenticate", label: s.verifyButton, busyLabel: s.verifying, className: "btn", onClick: () => void runAuthenticate() })
      : null,
    actions.resume
      ? actionButton({ id: "resume", action: "resume", label: s.resumeButton, busyLabel: s.resuming, className: "btn", onClick: () => void runResume() })
      : null,
    actions.replaceCard && !replace.open
      ? actionButton({ id: "replace-card", action: "replace", label: s.replaceCardButton, onClick: () => openReplace() })
      : null,
    actions.cancel
      ? actionButton({
          id: "cancel",
          action: "cancel",
          label: s.cancelButton,
          busyLabel: s.cancellingSubscription,
          className: "btn secondary danger-text",
          onClick: (event) => openCancelDialog(event.currentTarget as HTMLElement),
        })
      : null,
  ];
}

function replaceSection(sub: SubscriptionResponse): Node {
  const s = t();
  return h(
    "section",
    { class: "pay-card", "aria-labelledby": "replace-heading" },
    h("h2", { id: "replace-heading", tabindex: -1 }, s.replaceHeading),
    h("p", {}, sub.state === "payment_failed" ? s.replaceIntroPastDue : s.replaceIntro),
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
        notice("danger", "!", h("p", {}, publishableKey ? s.cardFormFailed : s.stripeUnavailable)),
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
  const price = quote ? money(quote.amount, quote.currency) : null;
  const describedBy = [page.error?.place === "replace" ? "replace-error-text" : "", quote ? "replace-quote" : ""].filter(Boolean).join(" ");
  return [
    quote
      ? h(
          "div",
          { id: "replace-quote", tabindex: -1, class: "notice warn" },
          h("span", { class: "notice-icon", "aria-hidden": "true" }, "!"),
          h("div", { class: "notice-body" }, h("p", {}, repriceText(quote))),
        )
      : null,
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
    h(
      "button",
      { type: "button", id: "replace-cancel", class: "btn secondary", "aria-disabled": busy ? "true" : undefined, onclick: () => cancelReplace() },
      s.cancel,
    ),
  ];
}

/// Entry point the router calls once.
export function mount(): void {
  void gate.start();
}
