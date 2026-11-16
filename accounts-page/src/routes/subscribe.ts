/// `/subscribe`: buys a web plan with a card through Stripe, after sign-in.
///
/// The server decides the price. The page sends the total it showed; a different total comes back
/// as a re-price with nothing charged, and the page asks again; every attempt, an accepted
/// re-price included, sends a new confirmation token made from the card form as it is then.

import type { ConfirmationToken } from "@stripe/stripe-js";

import { h } from "../dom";
import { STRINGS, langFromParam, type Lang, type Strings } from "../i18n";
import { announce, focusLanguageToggle, focusSelector, heading, renderShell } from "../shell";
import { finishWebPurchase, getWebPlans, startWebPurchase } from "../billing/api";
import {
  asksForProvince,
  blockedPlans,
  confirmationFor,
  defaultPlan,
  elementsKindFor,
  formatDate,
  formatMoney,
  planName,
  planNames,
  premiumLine,
  premiumOf,
  purchasablePlans,
  purchaseRequest,
  refusalFrom,
  shownTotal,
  type DeclineCategory,
  type Plan,
  type PlanOffer,
  type PlansResponse,
  type Quote,
  type Refusal,
  type BlockedPlans,
} from "../billing/logic";
import { mountPayment, paymentHost, updatePayment, type MountedPayment } from "../billing/stripe";
import {
  accountRow,
  compact,
  createGate,
  externalLink,
  gateStep,
  loadingStep,
  notice,
  pageLink,
  Regions,
  sleep,
  storeCancelLink,
  storeName,
  type GateChange,
} from "../billing/ui";
import { STORE_SUBSCRIPTION_LINKS } from "../delete/storeSubscriptions";

type View =
  | { kind: "gate" }
  | { kind: "loadingPlans" }
  | { kind: "plansFailed"; refusal: Refusal }
  | { kind: "ready" }
  | { kind: "succeeded" }
  | { kind: "processing" };

/// Where an error is shown: next to the card form, the province field, or the pay button.
type ErrorPlace = "card" | "province" | "pay";

let lang: Lang = langFromParam(new URLSearchParams(location.search).get("lang"));
let view: View = { kind: "gate" };
let plans: PlansResponse | null = null;
let offers: PlanOffer[] = [];
let regions = new Regions();

const form = {
  selected: null as Plan | null,
  payment: null as MountedPayment | null,
  /// Bumped on every mount, so a late load from an earlier language is dropped.
  mountId: 0,
  cardStatus: "loading" as "loading" | "failed" | "ready",
  busy: false,
  progress: "",
  quote: null as Quote | null,
  /// The billing country of the last attempt's token, to tell a Canadian address apart.
  billingCountry: null as string | null,
  needProvince: false,
  province: "",
  error: null as { refusal: Refusal | { kind: "cardIncomplete" | "authenticationNotCompleted" | "provinceMissing" }; place: ErrorPlace } | null,
  /// The buyer ticked «فهمت ذلك» over premium from a store or a manual grant; kept when the plan
  /// changes, cleared when the plans load again.
  acknowledged: false,
  acknowledgeError: false,
};

const gate = createGate({ lang: () => lang, onChange: onGateChange });

function t(): Strings {
  return STRINGS[lang];
}

// ---------------------------------------------------------------------------
// Flow

function onGateChange(change: GateChange) {
  if (gate.phase === "signedIn") {
    void loadPlans({ announce: change.announce });
    return;
  }
  view = { kind: "gate" };
  render({ focus: change.focus });
  if (change.announce) announce(change.announce);
}

/// `existingPremium`: the server refused a purchase over premium this page did not show, so the
/// plan is kept and focus goes to the confirmation that now appears.
async function loadPlans(options: { announce?: string; existingPremium?: boolean } = {}) {
  const session = gate.session;
  if (!session) return;
  const previousPlan = form.selected;
  view = { kind: "loadingPlans" };
  resetForm();
  render({ focus: "h1" });
  if (options.announce) announce(options.announce);
  try {
    plans = await getWebPlans(session.app, lang);
  } catch (error) {
    const refusal = refusalFrom(error);
    if (refusal.kind === "signedOut" || refusal.kind === "accountDeleted") {
      await gate.signOut(refusal.kind === "accountDeleted" ? t().accountDeleted : undefined);
      return;
    }
    view = { kind: "plansFailed", refusal };
    render({ focus: "h1" });
    announce(plansFailedText(refusal));
    return;
  }
  offers = purchasablePlans(plans);
  const keep = options.existingPremium && offers.some((offer) => offer.plan === previousPlan);
  form.selected = keep ? previousPlan : defaultPlan(offers);
  view = { kind: "ready" };
  const confirming = Boolean(options.existingPremium && selectedOffer() && confirmationFor(plans));
  render({ focus: confirming ? "#acknowledge" : "h1" });
  announce(options.existingPremium ? t().existingPremiumChanged : t().plansLoaded);
}

function resetForm() {
  destroyPayment();
  Object.assign(form, {
    selected: null,
    cardStatus: "loading",
    busy: false,
    progress: "",
    quote: null,
    billingCountry: null,
    needProvince: false,
    province: "",
    error: null,
    acknowledged: false,
    acknowledgeError: false,
  });
}

function destroyPayment() {
  form.mountId += 1;
  form.payment?.element.destroy();
  form.payment = null;
}

async function mountCardForm() {
  const offer = selectedOffer();
  const host = document.getElementById("payment-host");
  if (!plans || !offer || !host) return;
  const mountId = ++form.mountId;
  form.cardStatus = "loading";
  regions.update("card-status");
  let mounted: MountedPayment;
  try {
    mounted = await mountPayment({
      publishableKey: plans.publishableKey,
      lang,
      kind: elementsKindFor(offer.plan),
      amount: shownTotal(offer, form.quote),
      currency: offer.currency,
      host,
    });
  } catch {
    if (mountId !== form.mountId) return;
    form.cardStatus = "failed";
    regions.update("card-status");
    announce(t().cardFormFailed);
    return;
  }
  if (mountId !== form.mountId) {
    mounted.element.destroy();
    return;
  }
  form.payment = mounted;
  mounted.element.on("ready", () => {
    if (mountId !== form.mountId) return;
    form.cardStatus = "ready";
    regions.update("card-status");
  });
  mounted.element.on("loaderror", () => {
    if (mountId !== form.mountId) return;
    form.cardStatus = "failed";
    regions.update("card-status");
    announce(t().cardFormFailed);
  });
  mounted.element.on("change", () => {
    // New card details: a price worked out from the last card no longer applies.
    if (form.busy || mountId !== form.mountId) return;
    const hadQuote = form.quote !== null;
    form.needProvince = false;
    form.province = "";
    if (form.error?.place !== "pay") form.error = null;
    if (hadQuote) {
      form.quote = null;
      syncElementsAmount();
    }
    regions.update("card-error", "pay-region");
  });
}

function selectedOffer(): PlanOffer | null {
  return offers.find((offer) => offer.plan === form.selected) ?? null;
}

function syncElementsAmount() {
  const offer = selectedOffer();
  if (offer && form.payment) updatePayment(form.payment, elementsKindFor(offer.plan), shownTotal(offer, form.quote), offer.currency);
}

function onPlanChange(plan: Plan) {
  if (form.busy || form.selected === plan) return;
  form.selected = plan;
  // A quote is for one plan.
  form.quote = null;
  form.needProvince = false;
  form.error = null;
  syncElementsAmount();
  regions.update("card-error", "pay-region");
}

function setBusy(busy: boolean, progress = "") {
  form.busy = busy;
  form.progress = progress;
  form.payment?.element.update({ readOnly: busy });
  for (const radio of document.querySelectorAll<HTMLInputElement>("input[name='plan']")) radio.disabled = busy;
  regions.update("pay-region");
}

function showError(error: NonNullable<typeof form.error>) {
  form.error = error;
  setBusy(false);
  regions.update("card-error", "pay-region");
  announce(errorText(error.refusal));
  if (error.place === "province") {
    focusSelector("#province");
  } else if (!document.activeElement || document.activeElement === document.body) {
    // The bank's window took focus with it when it closed: put it back on the pay button.
    focusSelector("#pay");
  }
}

async function onPay() {
  if (form.busy) return;
  const offer = selectedOffer();
  const session = gate.session;
  if (!offer || !session) return;
  if (needsAcknowledgement()) {
    form.acknowledgeError = true;
    regions.update("pay-region");
    focusSelector("#acknowledge");
    announce(t().acknowledgeFirst);
    return;
  }
  if (!form.payment || form.cardStatus !== "ready") return;
  if (form.needProvince && !form.province) {
    showError({ refusal: { kind: "provinceMissing" }, place: "province" });
    return;
  }
  const total = shownTotal(offer, form.quote);
  form.error = null;
  setBusy(true, t().paying(money(total, offer.currency)));
  regions.update("card-error");
  announce(form.progress);
  await purchase(offer);
}

/// Elements' validation, then a new confirmation token; null after showing why it failed.
async function newToken(): Promise<{ id: string; billingCountry: string | null } | null> {
  const payment = form.payment!;
  const submitted = await payment.elements.submit();
  if (submitted.error) {
    showError({ refusal: { kind: "cardIncomplete" }, place: "card" });
    return null;
  }
  const created = await payment.stripe.createConfirmationToken({ elements: payment.elements });
  if (created.error || !created.confirmationToken) {
    const validation = created.error?.type === "validation_error" || created.error?.type === "card_error";
    showError({ refusal: validation ? { kind: "cardIncomplete" } : { kind: "generic" }, place: validation ? "card" : "pay" });
    return null;
  }
  return { id: created.confirmationToken.id, billingCountry: billingCountryOf(created.confirmationToken) };
}

function billingCountryOf(token: ConfirmationToken): string | null {
  return token.payment_method_preview?.billing_details?.address?.country ?? null;
}

async function purchase(offer: PlanOffer) {
  const session = gate.session!;
  const token = await newToken();
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
        acknowledged: Boolean(plans && confirmationFor(plans)) && form.acknowledged,
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
      enterSucceeded();
      return;
    case "requires_action": {
      setBusy(true, t().verifyingPayment);
      announce(t().verifyingPayment);
      let authenticationFailed: boolean;
      try {
        authenticationFailed = Boolean((await form.payment!.stripe.handleNextAction({ clientSecret: result.clientSecret })).error);
      } catch {
        authenticationFailed = true;
      }
      await settle(result.purchaseId, { authenticationFailed });
      return;
    }
    case "pending":
      await settle(result.purchaseId, { authenticationFailed: false });
      return;
  }
}

async function purchaseRefused(refusal: Refusal) {
  switch (refusal.kind) {
    case "signedOut":
    case "accountDeleted":
      resetForm();
      await gate.signOut(refusal.kind === "accountDeleted" ? t().accountDeleted : undefined);
      return;
    case "existingPremium":
      // A stale page: the plans are read again, so the premium and its confirmation show.
      await loadPlans({ existingPremium: true });
      return;
    case "billingAddressIncomplete":
      if (asksForProvince(refusal, form.billingCountry)) {
        form.needProvince = true;
        showError({ refusal: { kind: "provinceMissing" }, place: "province" });
        return;
      }
      showError({ refusal, place: "card" });
      return;
    case "declined":
    case "tokenInvalid":
    case "cardRequired":
    case "planUnavailable":
      showError({ refusal, place: "card" });
      return;
    default:
      showError({ refusal, place: "pay" });
  }
}

function showQuote(quote: Quote) {
  form.quote = quote;
  syncElementsAmount();
  setBusy(false);
  regions.update("pay-region");
  announce(t().quoteAnnouncement(money(quote.total, quote.currency)));
  focusSelector("#quote-heading");
}

/// After the bank's check or a payment still in flight: asks the server where the purchase
/// stands, a few times while it is still confirming.
async function settle(purchaseId: string, options: { authenticationFailed: boolean }) {
  const session = gate.session!;
  setBusy(true, t().checkingPayment);
  announce(t().checkingPayment);
  const delays = options.authenticationFailed ? [0] : [0, 2000, 3000, 5000];
  let last: "pending" | "failed" | "noAnswer" = "pending";
  let category: DeclineCategory | undefined;
  for (const delay of delays) {
    if (delay) await sleep(delay);
    try {
      const outcome = await finishWebPurchase(session.app, purchaseId);
      if (outcome.status === "succeeded") {
        enterSucceeded();
        return;
      }
      last = outcome.status;
      category = outcome.category;
      if (outcome.status === "failed") break;
    } catch (error) {
      const refusal = refusalFrom(error);
      if (refusal.kind === "signedOut" || refusal.kind === "accountDeleted") {
        resetForm();
        await gate.signOut(refusal.kind === "accountDeleted" ? t().accountDeleted : undefined);
        return;
      }
      last = "noAnswer";
    }
  }
  if (last === "failed") {
    showError({ refusal: { kind: "declined", category: category ?? "declined" }, place: "card" });
    return;
  }
  if (options.authenticationFailed) {
    // The bank's window was closed or failed: the payment is still waiting, unpaid.
    showError({ refusal: { kind: "authenticationNotCompleted" }, place: "card" });
    return;
  }
  view = { kind: "processing" };
  destroyPayment();
  render({ focus: "h1" });
  announce(`${t().processingTitle}. ${t().processingBody}`);
}

function enterSucceeded() {
  destroyPayment();
  form.busy = false;
  view = { kind: "succeeded" };
  render({ focus: "h1" });
  announce(`${t().successTitle}. ${t().successBody}`);
}

async function onSignOut() {
  if (form.busy) return;
  resetForm();
  await gate.signOut(t().signedOutAnnouncement);
}

// ---------------------------------------------------------------------------
// Text

function money(cents: number, currency: string): string {
  return formatMoney(cents, currency, lang);
}

function priceText(offer: PlanOffer, s: Strings): string {
  const price = money(offer.amount, offer.currency);
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

function storeLabel(platform: "apple" | "google" | null, s: Strings): string {
  return platform ? storeName(platform, s) : `${s.appStoreName} / ${s.playStoreName}`;
}

function errorText(refusal: NonNullable<typeof form.error>["refusal"]): string {
  const s = t();
  switch (refusal.kind) {
    case "declined":
      return declineText(refusal.category, s);
    case "cardIncomplete":
      return s.cardIncomplete;
    case "authenticationNotCompleted":
      return s.authenticationNotCompleted;
    case "provinceMissing":
      return s.provinceNeeded;
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
      return s.storeActiveError(storeLabel(refusal.platform, s));
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

function plansFailedText(refusal: Refusal): string {
  const s = t();
  switch (refusal.kind) {
    case "salesDisabled":
      return s.salesDisabled;
    case "emailUnverified":
      return s.emailUnverified;
    case "noAnswer":
      return s.networkBody;
    default:
      return s.genericBody;
  }
}

// ---------------------------------------------------------------------------
// Rendering

/// Re-renders the whole page; only view changes and language switches do this.
function render(options: { focus?: string } = {}) {
  destroyPayment();
  regions.clear();
  regions = new Regions();
  renderShell({
    lang,
    body: body(),
    busy: view.kind === "loadingPlans" || (view.kind === "gate" && gate.phase === "loading"),
    onSwitchLanguage: switchLanguage,
  });
  if (options.focus) focusSelector(options.focus);
  if (view.kind === "ready" && selectedOffer()) void mountCardForm();
}

function switchLanguage() {
  if (form.busy) return;
  lang = lang === "ar" ? "en" : "ar";
  gate.refresh();
  // The card form is mounted again in the new language, so what was typed in it is gone.
  form.quote = null;
  form.needProvince = false;
  form.error = null;
  render();
  focusLanguageToggle();
}

function body(): Node[] {
  const s = t();
  switch (view.kind) {
    case "gate":
      return [heading(s.subscribeTitle), h("p", {}, s.subscribeIntro), h("section", { class: "step" }, ...gateStep(gate, s, () => void gate.start()))];
    case "loadingPlans":
      return [heading(s.subscribeTitle), signedInRow(), ...loadingStep(s.loadingPlans)];
    case "plansFailed":
      return plansFailedView(view.refusal);
    case "ready":
      return readyView();
    case "succeeded":
      return [
        h("div", { class: "icon ok", "aria-hidden": "true" }, "✓"),
        heading(s.successTitle),
        h("p", { class: "center" }, s.successBody),
        pageLink("/manage", s.manageLink, lang, "btn secondary"),
      ];
    case "processing":
      return [
        h("div", { class: "icon warn", "aria-hidden": "true" }, "…"),
        heading(s.processingTitle),
        h("p", { class: "center" }, s.processingBody),
        pageLink("/manage", s.manageLink, lang, "btn secondary"),
      ];
  }
}

function signedInRow(): Node {
  return accountRow(gate.signedIn!, t(), { busy: form.busy, onSignOut: () => void onSignOut() });
}

function plansFailedView(refusal: Refusal): Node[] {
  const s = t();
  const nodes: Node[] = [heading(s.subscribeTitle), signedInRow(), notice(refusal.kind === "salesDisabled" ? "warn" : "danger", "!", h("p", {}, plansFailedText(refusal)))];
  if (refusal.kind === "emailUnverified") {
    nodes.push(
      h(
        "button",
        {
          type: "button",
          id: "check-again",
          class: "btn",
          onclick: () => void checkVerifiedAgain(),
        },
        s.checkAgain,
      ),
    );
  } else if (refusal.kind !== "salesDisabled") {
    nodes.push(h("button", { type: "button", id: "plans-retry", class: "btn", onclick: () => void loadPlans() }, s.retry));
  }
  return nodes;
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
  await loadPlans();
}

function readyView(): Node[] {
  const s = t();
  const response = plans!;
  const nodes: (Node | null)[] = [heading(s.subscribeTitle), signedInRow(), premiumSection(response), ...blockedNotices(response)];
  if (offers.length === 0) return compact(nodes);
  if (!response.countryKnown) nodes.push(notice("info", "i", h("p", {}, s.unknownCountryNote)));
  nodes.push(planGroup());
  nodes.push(
    h(
      "section",
      { class: "pay-card", "aria-labelledby": "card-heading" },
      h("h2", { id: "card-heading", tabindex: -1 }, s.cardHeading),
      h("p", { class: "muted small" }, s.cardsOnly),
      regions.create("card-status", cardStatus),
      paymentHost("payment-host", lang),
      regions.create("card-error", () => [errorFor("card")]),
    ),
  );
  nodes.push(regions.create("pay-region", payRegion));
  return compact(nodes);
}

/// «ما لديك الآن»: every source of premium the account holds, so none goes unmentioned.
function premiumSection(response: PlansResponse): Node | null {
  const s = t();
  const sources = premiumOf(response);
  if (sources.length === 0) return null;
  return h(
    "section",
    { class: "terms", "aria-labelledby": "premium-heading" },
    h("h2", { id: "premium-heading" }, s.premiumHeading),
    h(
      "ul",
      { class: "plain" },
      ...sources.map((source) => {
        const line = premiumLine(source, s, lang);
        return h("li", {}, line.text, line.manage ? " " : null, line.manage ? pageLink("/manage", s.manageLink, lang) : null);
      }),
    ),
  );
}

/// Each plan of the tier that cannot be bought, with why and the step that unblocks it.
function blockedNotices(response: PlansResponse): Node[] {
  const lifetimeOffered = offers.some((offer) => offer.plan === "web_lifetime");
  const confirmation = confirmationFor(response);
  return blockedPlans(response).map((blocked) => blockedNotice(blocked, lifetimeOffered, confirmation?.renewingStores ?? []));
}

function blockedNotice(blocked: BlockedPlans, lifetimeOffered: boolean, confirmedStores: readonly ("apple" | "google")[]): Node {
  const s = t();
  const names = h("p", { class: "strong" }, s.notOffered(planNames(blocked.plans, s, lang)));
  const reason = blocked.reason;
  switch (reason.kind) {
    case "lifetime":
      return notice("info", "i", names, h("p", {}, s.blockerLifetime));
    case "web":
      return notice(
        "info",
        "i",
        names,
        h("p", {}, s.blockerSubscribed),
        h("p", {}, pageLink("/manage", s.manageLink, lang)),
        lifetimeOffered ? h("p", {}, s.blockerSubscribedLifetime) : null,
      );
    case "store": {
      const name = storeName(reason.platform, s);
      // The confirmation above the pay button says it when the backend lists the store; an older
      // backend lists nothing, so it is said here as before.
      const sayLifetime = lifetimeOffered && !confirmedStores.includes(reason.platform);
      return notice(
        "warn",
        "!",
        names,
        h("p", {}, s.blockerStore(name, formatDate(reason.until, lang))),
        h("p", {}, storeCancelLink(reason.platform, s)),
        sayLifetime ? h("p", {}, s.blockerStoreLifetime(name)) : null,
      );
    }
  }
}

/// Whether the pay button waits for «فهمت ذلك»: the plan is bought over premium from a store or a
/// manual grant, and the buyer has not ticked it.
function needsAcknowledgement(): boolean {
  return Boolean(plans && confirmationFor(plans)) && !form.acknowledged;
}

/// The confirmation directly above the pay button: what the account has from elsewhere, that the
/// plan starts today and adds nothing to it, and the checkbox the purchase waits for.
function confirmationView(): Node[] {
  const s = t();
  const confirmation = plans ? confirmationFor(plans) : null;
  if (!confirmation) return [];
  const checkbox = h("input", {
    type: "checkbox",
    id: "acknowledge",
    "aria-invalid": form.acknowledgeError ? "true" : undefined,
    "aria-describedby": form.acknowledgeError ? "acknowledge-error" : undefined,
    onchange: (event: Event) => {
      form.acknowledged = (event.target as HTMLInputElement).checked;
      form.acknowledgeError = false;
      regions.update("pay-region");
    },
  });
  checkbox.checked = form.acknowledged;
  checkbox.disabled = form.busy;
  return compact([
    h(
      "div",
      { id: "existing-notice" },
      notice(
        "warn",
        "!",
        h("p", {}, s.confirmIntro),
        h("ul", { class: "plain" }, ...confirmation.sources.map((source) => h("li", {}, premiumLine(source, s, lang).text))),
        h("p", { class: "strong" }, s.confirmStartsToday),
        ...confirmation.renewingStores.flatMap((store) => [
          h("p", {}, s.blockerStoreLifetime(storeName(store, s))),
          h("p", {}, storeCancelLink(store, s)),
        ]),
      ),
    ),
    h("label", { class: `check${form.acknowledgeError ? " invalid" : ""}`, for: "acknowledge" }, checkbox, h("span", {}, s.acknowledge)),
    form.acknowledgeError ? h("p", { id: "acknowledge-error", class: "error" }, s.acknowledgeFirst) : null,
  ]);
}

function planGroup(): Node {
  const s = t();
  return h(
    "fieldset",
    { class: "plans" },
    h("legend", {}, s.choosePlan),
    ...offers.map((offer) => {
      const id = `plan-${offer.plan}`;
      const input = h("input", {
        type: "radio",
        name: "plan",
        id,
        value: offer.plan,
        onchange: () => onPlanChange(offer.plan),
      });
      input.checked = form.selected === offer.plan;
      input.disabled = form.busy;
      return h(
        "label",
        { class: "plan", for: id },
        input,
        h(
          "span",
          { class: "plan-text" },
          h("span", { class: "plan-name" }, planName(offer.plan, s)),
          h("span", { class: "plan-price" }, priceText(offer, s)),
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
        notice("danger", "!", h("p", {}, s.cardFormFailed)),
        h("button", { type: "button", id: "card-retry", class: "btn secondary", onclick: () => void mountCardForm() }, s.retry),
      ];
    case "ready":
      return [];
  }
}

function errorFor(place: ErrorPlace): Node | null {
  const error = form.error;
  if (!error || error.place !== place) return null;
  const s = t();
  const links: Node[] = [];
  const refusal = error.refusal;
  if (refusal.kind === "alreadySubscribed" || refusal.kind === "lifetimeActive") {
    links.push(h("p", {}, pageLink("/manage", s.manageLink, lang)));
  }
  if (refusal.kind === "storeSubscriptionActive") {
    const stores = refusal.platform ? [refusal.platform] : (["apple", "google"] as const);
    for (const store of stores) links.push(h("p", {}, externalLink(STORE_SUBSCRIPTION_LINKS[store], s.cancelInStore(storeName(store, s)), s)));
  }
  return h("div", { id: `${place}-error-text`, class: "field-error" }, notice("danger", "!", h("p", {}, errorText(refusal)), ...links));
}

function payRegion(): (Node | null)[] {
  const s = t();
  const offer = selectedOffer();
  if (!offer) return [];
  const total = shownTotal(offer, form.quote);
  const quote = form.quote && form.quote.plan === offer.plan ? form.quote : null;
  const errorId = form.error && form.error.place !== "province" ? `${form.error.place}-error-text` : "";
  const waiting = needsAcknowledgement();
  const describedBy = [errorId, quote ? "quote" : "", waiting ? "existing-notice" : ""].filter(Boolean).join(" ");
  return [
    form.needProvince ? provinceField() : null,
    quote ? quoteView(quote) : null,
    noticeView(offer, total),
    errorFor("pay"),
    ...confirmationView(),
    h(
      "button",
      {
        type: "button",
        id: "pay",
        class: "btn",
        "aria-disabled": form.busy || form.cardStatus !== "ready" || waiting ? "true" : undefined,
        "aria-busy": form.busy ? "true" : undefined,
        "aria-describedby": describedBy || undefined,
        onclick: () => void onPay(),
      },
      form.busy ? form.progress || s.paying(money(total, offer.currency)) : s.pay(money(total, offer.currency)),
    ),
  ];
}

function provinceField(): Node {
  const s = t();
  const invalid = form.error?.place === "province";
  const select = h(
    "select",
    {
      id: "province",
      name: "province",
      required: true,
      "aria-invalid": invalid ? "true" : undefined,
      "aria-describedby": invalid ? "province-error-text" : "province-hint",
      onchange: (event: Event) => {
        form.province = (event.target as HTMLSelectElement).value;
        if (form.error?.place === "province") {
          form.error = null;
          regions.update("pay-region");
        }
      },
    },
    h("option", { value: "" }, s.provinceChoose),
    ...Object.entries(s.provinces).map(([code, name]) => h("option", { value: code }, name)),
  );
  select.value = form.province;
  select.disabled = form.busy;
  return h(
    "div",
    { class: "group" },
    h("label", { for: "province" }, s.provinceLabel),
    h("p", { id: "province-hint", class: "muted small" }, s.provinceNeeded),
    h("div", { class: `field select${invalid ? " invalid" : ""}` }, select),
    errorFor("province"),
  );
}

function quoteView(quote: Quote): Node {
  const s = t();
  const reason =
    quote.reason === "card_country"
      ? s.quoteReasonCardCountry
      : quote.reason === "tax"
        ? s.quoteReasonTax
        : quote.reason === "both"
          ? s.quoteReasonBoth
          : s.quoteReasonPriceChanged;
  return h(
    "section",
    { id: "quote", class: "notice warn quote", "aria-labelledby": "quote-heading" },
    h("span", { class: "notice-icon", "aria-hidden": "true" }, "!"),
    h(
      "div",
      { class: "notice-body" },
      h("h2", { id: "quote-heading", tabindex: -1 }, s.quoteHeading),
      h("p", {}, reason),
      h(
        "ul",
        { class: "plain breakdown" },
        h("li", {}, `${s.quotePrice}: `, money(quote.amount, quote.currency)),
        h("li", {}, `${s.quoteTax}: `, money(quote.tax, quote.currency)),
        h("li", { class: "strong" }, `${s.quoteTotal}: `, money(quote.total, quote.currency)),
      ),
      h("p", {}, s.quoteNothingCharged),
    ),
  );
}

function noticeView(offer: PlanOffer, total: number): Node {
  const s = t();
  const price = money(total, offer.currency);
  return h(
    "section",
    { class: "terms", "aria-labelledby": "terms-heading" },
    h("h2", { id: "terms-heading" }, s.noticeHeading),
    h(
      "ul",
      { class: "plain" },
      h("li", {}, s.noticeImmediate),
      h("li", {}, s.noticeNoRefunds),
      offer.interval === "month" ? h("li", {}, s.noticeRenewsMonthly(price)) : null,
      offer.interval === "year" ? h("li", {}, s.noticeRenewsYearly(price)) : null,
      offer.interval === null ? h("li", {}, s.noticeLifetime) : null,
    ),
  );
}

/// Entry point the router calls once.
export function mount(): void {
  void gate.start();
}
