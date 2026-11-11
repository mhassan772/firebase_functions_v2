/// `/delete`: deletes a Mantooq account after sign-in and an explicit confirmation.
///
/// What deletion removes and keeps is shown before any sign-in, because Google Play requires the
/// page to say it without the app or an account.

import { revokeAccessToken, signOut } from "firebase/auth";
import { connectFunctionsEmulator, getFunctions, httpsCallable, type Functions } from "firebase/functions";

import { isSignInStale } from "../auth/recentLogin";
import { getSession, restoredSignIn, signedInUser, type Session, type SignedIn } from "../auth/session";
import { renderReauthentication, renderSignIn, type MountedView } from "../auth/signIn";
import { accountCheckFrom, deletionFailureFrom, type AccountCheck } from "../delete/failures";
import { fetchRenewingStores, STORE_SUBSCRIPTION_LINKS, type Store } from "../delete/storeSubscriptions";
import { h, ltr } from "../dom";
import { emulatorSettings, hostAndPort } from "../firebaseConfig";
import { STRINGS, langFromParam, type Lang, type Strings } from "../i18n";
import { announce, focusSelector, focusLanguageToggle, heading, renderShell } from "../shell";

const FUNCTIONS_REGION = "europe-west2";
/// Longer than the SDK's default 70 s: a large account's purge can take minutes.
const DELETE_TIMEOUT_MS = 5 * 60 * 1000;

type Phase =
  | { kind: "loading" }
  | { kind: "initFailed" }
  | { kind: "signedOut" }
  | { kind: "reauth" }
  | { kind: "signedIn" }
  | { kind: "done"; emailed: boolean };

type ConfirmError = "failed" | "noAnswer" | "unknown";

let lang: Lang = langFromParam(new URLSearchParams(location.search).get("lang"));
let phase: Phase = { kind: "loading" };
let session: Session | null = null;
let functions: Functions | null = null;
let signedIn: SignedIn | null = null;

/// The sign-in or confirmation view currently shown, in a slot kept across page re-renders.
let subview: { slot: HTMLElement; view: MountedView<unknown> } | null = null;

const confirmation = {
  ticked: false,
  tickError: false,
  busy: false,
  error: null as ConfirmError | null,
  stores: [] as Store[],
};

function t(): Strings {
  return STRINGS[lang];
}

function storeName(store: Store): string {
  return store === "apple" ? t().appStoreName : t().playStoreName;
}

// ---------------------------------------------------------------------------
// Flow

async function start() {
  phase = { kind: "loading" };
  render();
  try {
    session = await getSession();
  } catch {
    phase = { kind: "initFailed" };
    render({ focus: "h1" });
    return;
  }
  const user = signedInUser(session.auth);
  signedIn = null;
  if (user) {
    try {
      signedIn = await restoredSignIn(user);
    } catch {
      // A stored session whose token can no longer refresh counts as signed out.
      await signOut(session.auth).catch(() => undefined);
    }
  }
  if (signedIn) {
    enterSignedIn({ focus: "h1" });
  } else {
    enterSignedOut({ focus: "h1" });
  }
}

function mountSubview<T>(create: (slot: HTMLElement) => MountedView<T>): MountedView<T> {
  const slot = h("div", { class: "slot" });
  const view = create(slot);
  subview = { slot, view };
  return view;
}

function enterSignedOut(options: { focus?: string; message?: string } = {}) {
  const current = session!;
  signedIn = null;
  phase = { kind: "signedOut" };
  const view = mountSubview((slot) => renderSignIn(slot, current.auth, { lang: () => lang, idPrefix: "signin" }));
  render({ focus: options.focus ?? "#signin-heading" });
  if (options.message) announce(options.message);
  void view.result.then((result) => {
    if (phase.kind !== "signedOut" || subview?.view !== view) return;
    signedIn = result;
    enterSignedIn();
    announce(t().signedInAnnouncement);
  });
}

function enterSignedIn(options: { focus?: string; keepConfirmation?: boolean } = {}) {
  phase = { kind: "signedIn" };
  subview = null;
  if (!options.keepConfirmation) {
    Object.assign(confirmation, { ticked: false, tickError: false, busy: false, error: null, stores: [] });
  }
  render({ focus: options.focus ?? "#confirm-heading" });
  if (!options.keepConfirmation) void loadStoreWarning();
}

/// The one read of `subscription_master/{uid}`; a renewing store row makes the warning specific.
async function loadStoreWarning() {
  const current = signedIn;
  if (!current || !session) return;
  let idToken: string;
  try {
    idToken = await current.user.getIdToken();
  } catch {
    return;
  }
  const stores = await fetchRenewingStores({
    projectId: session.app.options.projectId ?? "",
    uid: current.user.uid,
    idToken,
    emulator: import.meta.env.DEV ? emulatorSettings()?.firestore : undefined,
  });
  if (stores.length === 0 || signedIn !== current || phase.kind !== "signedIn") return;
  confirmation.stores = stores;
  render();
  announce(stores.map((store) => t().activeStoreWarning(storeName(store))).join(" "));
}

function enterReauth() {
  const current = signedIn!;
  if (!current.provider) {
    // A method this page can't confirm: a fresh sign-in sets a new sign-in time instead.
    void signOut(session!.auth).finally(() => enterSignedOut({ message: t().reauthSignInAgain }));
    return;
  }
  phase = { kind: "reauth" };
  const view = mountSubview((slot) =>
    renderReauthentication(slot, session!.auth, current, {
      lang: () => lang,
      idPrefix: "reauth",
      body: () => t().reauthBody,
    }),
  );
  render({ focus: "#reauth-heading" });
  announce(t().reauthBody);
  void view.result.then((confirmed) => {
    if (phase.kind !== "reauth" || subview?.view !== view) return;
    if (!confirmed) {
      confirmation.busy = false;
      enterSignedIn({ keepConfirmation: true });
      return;
    }
    signedIn = confirmed;
    enterSignedIn({ keepConfirmation: true });
    void runDeletion();
  });
}

function onDeleteClick() {
  if (confirmation.busy) return;
  if (!confirmation.ticked) {
    confirmation.tickError = true;
    render({ focus: "#confirm-check" });
    announce(t().tickFirst);
    return;
  }
  void runDeletion();
}

function deleteCallable() {
  if (!functions) {
    functions = getFunctions(session!.app, FUNCTIONS_REGION);
    if (import.meta.env.DEV) {
      const emulator = emulatorSettings()?.functions;
      if (emulator) {
        const { host, port } = hostAndPort(emulator);
        connectFunctionsEmulator(functions, host, port);
      }
    }
  }
  return httpsCallable<{ lang: Lang }, { deleted?: unknown }>(functions, "deleteAccount", { timeout: DELETE_TIMEOUT_MS });
}

async function runDeletion() {
  const current = signedIn;
  if (!current || !session || confirmation.busy) return;
  confirmation.busy = true;
  confirmation.error = null;
  render();
  announce(t().deleting);

  let authTime: unknown;
  try {
    authTime = (await current.user.getIdTokenResult()).claims.auth_time;
  } catch (error) {
    await afterFailure(error, current);
    return;
  }
  if (isSignInStale(authTime, Date.now())) {
    confirmation.busy = false;
    enterReauth();
    return;
  }

  if (current.provider === "apple" && current.appleAccessToken) {
    try {
      await revokeAccessToken(session.auth, current.appleAccessToken);
    } catch {
      // Revoking is a courtesy to Apple's records; the deletion goes ahead without it.
    }
  }

  try {
    const response = await deleteCallable()({ lang });
    if (response.data?.deleted === true) {
      await finishDone(current);
      return;
    }
    showConfirmError("failed");
  } catch (error) {
    await afterFailure(error, current);
  }
}

async function afterFailure(error: unknown, current: SignedIn) {
  switch (deletionFailureFrom(error)) {
    case "reauth":
      confirmation.busy = false;
      enterReauth();
      return;
    case "signedOut":
      confirmation.busy = false;
      await signOut(session!.auth).catch(() => undefined);
      enterSignedOut();
      return;
    case "noAnswer": {
      let check: AccountCheck;
      try {
        await current.user.reload();
        check = accountCheckFrom(undefined);
      } catch (reloadError) {
        check = accountCheckFrom(reloadError);
      }
      if (check === "gone") {
        await finishDone(current);
        return;
      }
      showConfirmError(check === "exists" ? "noAnswer" : "unknown");
      return;
    }
    case "retry":
      showConfirmError("failed");
      return;
  }
}

function showConfirmError(error: ConfirmError) {
  confirmation.busy = false;
  confirmation.error = error;
  render();
  announce(confirmErrorText(error));
}

function confirmErrorText(error: ConfirmError): string {
  const s = t();
  return error === "failed" ? s.deleteFailed : error === "noAnswer" ? s.deleteNoAnswer : s.deleteUnknown;
}

async function finishDone(current: SignedIn) {
  confirmation.busy = false;
  const emailed = Boolean(current.user.email);
  signedIn = null;
  await signOut(session!.auth).catch(() => undefined);
  phase = { kind: "done", emailed };
  subview = null;
  render({ focus: "h1" });
  announce(t().doneTitle);
}

async function signOutClicked() {
  if (confirmation.busy || !session) return;
  await signOut(session.auth).catch(() => undefined);
  enterSignedOut({ message: t().signedOutAnnouncement });
}

// ---------------------------------------------------------------------------
// Rendering

/// Re-renders the page; focus moves to `focus` when given, otherwise stays where it was.
function render(options: { focus?: string } = {}) {
  const active = document.activeElement as HTMLElement | null;
  const activeId = active?.id ?? "";
  renderShell({
    lang,
    body: body(),
    busy: phase.kind === "loading",
    onSwitchLanguage: switchLanguage,
  });
  if (options.focus) {
    focusSelector(options.focus);
  } else if (activeId) {
    document.getElementById(activeId)?.focus();
  }
}

function switchLanguage() {
  lang = lang === "ar" ? "en" : "ar";
  if (session) session.auth.languageCode = lang;
  subview?.view.refresh();
  render();
  focusLanguageToggle();
}

function body(): Node[] {
  if (phase.kind === "done") return doneView(phase.emailed);
  return [...information(), h("section", { class: "step", "aria-busy": confirmation.busy ? "true" : undefined }, ...step())];
}

function storeLinks(className = "links"): Node {
  const s = t();
  return h(
    "ul",
    { class: className },
    h("li", {}, externalLink(STORE_SUBSCRIPTION_LINKS.apple, s.appStoreLink)),
    h("li", {}, externalLink(STORE_SUBSCRIPTION_LINKS.google, s.playStoreLink)),
  );
}

function externalLink(href: string, text: string): Node {
  return h(
    "a",
    { href, target: "_blank", rel: "noopener noreferrer" },
    text,
    h("span", { class: "sr-only" }, ` ${t().opensInNewTab}`),
  );
}

function notice(tone: "info" | "warn" | "danger", glyph: string, ...content: Node[]): Node {
  return h(
    "div",
    { class: `notice ${tone}` },
    h("span", { class: "notice-icon", "aria-hidden": "true" }, glyph),
    h("div", { class: "notice-body" }, ...content),
  );
}

/// Always shown, signed in or not.
function information(): Node[] {
  const s = t();
  return [
    heading(s.deleteTitle),
    h("p", {}, s.deleteIntro),
    h("h2", {}, s.deletedHeading),
    h("p", {}, s.deletedBody),
    h("h2", {}, s.keptHeading),
    h("ul", { class: "plain" }, h("li", {}, s.keptPayments), h("li", {}, s.keptLateWrites)),
    notice("warn", "!", h("p", {}, s.storeNotice), storeLinks()),
    h("p", { class: "strong" }, s.cannotUndo),
    h("p", { class: "muted" }, s.inAppPath),
    h("hr", { class: "divider-line" }),
  ];
}

function step(): Node[] {
  const s = t();
  switch (phase.kind) {
    case "loading":
      return [h("div", { class: "spinner", "aria-hidden": "true" }), h("p", { class: "center", role: "status" }, s.checkingSignIn)];
    case "initFailed":
      return [
        notice("danger", "!", h("p", { class: "strong" }, s.signInFailedTitle), h("p", {}, s.networkBody)),
        h("button", { type: "button", id: "init-retry", class: "btn", onclick: () => void start() }, s.retry),
      ];
    case "signedOut":
    case "reauth":
      return subview ? [subview.slot] : [];
    case "signedIn":
      return confirmStep();
    case "done":
      return [];
  }
}

function confirmStep(): Node[] {
  const s = t();
  const user = signedIn!.user;
  const busy = confirmation.busy;
  const tickErrorId = "confirm-check-error";
  const errorId = "confirm-error";

  const checkbox = h("input", {
    type: "checkbox",
    id: "confirm-check",
    required: true,
    "aria-invalid": confirmation.tickError ? "true" : undefined,
    "aria-describedby": confirmation.tickError ? tickErrorId : undefined,
    onchange: (event: Event) => {
      confirmation.ticked = (event.target as HTMLInputElement).checked;
      confirmation.tickError = false;
      render();
    },
  });
  checkbox.checked = confirmation.ticked;
  if (busy) checkbox.disabled = true;

  const provider = signedIn!.provider === "apple" ? s.appleName : signedIn!.provider === "google" ? s.googleName : "";

  return [
    h("h2", { tabindex: -1, id: "confirm-heading" }, s.confirmTitle),
    h(
      "div",
      { class: "account row" },
      user.email ? h("span", {}, `${s.signedInAs} `, ltr(user.email)) : h("span", {}, s.signedInWith(provider)),
      h(
        "button",
        {
          type: "button",
          id: "sign-out",
          class: "link-button",
          "aria-disabled": busy ? "true" : undefined,
          onclick: () => void signOutClicked(),
        },
        s.notYou,
      ),
    ),
    ...confirmation.stores.map((store) =>
      notice(
        "danger",
        "!",
        h("p", { class: "strong" }, s.activeStoreWarning(storeName(store))),
        h("p", {}, externalLink(STORE_SUBSCRIPTION_LINKS[store], s.cancelInStore(storeName(store)))),
      ),
    ),
    h("label", { class: `check${confirmation.tickError ? " invalid" : ""}`, for: "confirm-check" }, checkbox, h("span", {}, s.understand)),
    confirmation.tickError ? h("p", { id: tickErrorId, class: "error" }, s.tickFirst) : null,
    confirmation.error ? h("div", { id: errorId }, notice("danger", "!", h("p", {}, confirmErrorText(confirmation.error)))) : null,
    h(
      "button",
      {
        type: "button",
        id: "delete-account",
        class: "btn danger",
        "aria-disabled": busy || !confirmation.ticked ? "true" : undefined,
        "aria-busy": busy ? "true" : undefined,
        "aria-describedby": confirmation.error ? errorId : undefined,
        onclick: onDeleteClick,
      },
      busy ? s.deleting : confirmation.error ? s.retryDelete : s.deleteButton,
    ),
  ].filter((node): node is Node => node !== null);
}

function doneView(emailed: boolean): Node[] {
  const s = t();
  return [
    h("div", { class: "icon ok", "aria-hidden": "true" }, "✓"),
    heading(s.doneTitle),
    h("p", { class: "center" }, s.doneBody),
    emailed ? h("p", { class: "center" }, s.doneEmail) : null,
    notice("warn", "!", h("p", {}, s.doneStore), storeLinks()),
  ].filter((node): node is Node => node !== null);
}

/// Entry point the router calls once.
export function mount(): void {
  void start();
}
