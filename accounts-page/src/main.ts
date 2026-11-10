import "@fontsource/ibm-plex-sans-arabic/arabic-400.css";
import "@fontsource/ibm-plex-sans-arabic/arabic-700.css";
import "@fontsource/ibm-plex-sans-arabic/latin-400.css";
import "@fontsource/ibm-plex-sans-arabic/latin-700.css";
import "./style.css";

import { initializeApp, type FirebaseOptions } from "firebase/app";
import {
  applyActionCode,
  checkActionCode,
  confirmPasswordReset,
  connectAuthEmulator,
  inMemoryPersistence,
  initializeAuth,
  sendPasswordResetEmail,
  verifyPasswordResetCode,
  type Auth,
} from "firebase/auth";
import { FirebaseError } from "firebase/app";

import { h, ltr } from "./dom";
import { STRINGS, langFromParam, type Lang } from "./i18n";

const MIN_PASSWORD_LENGTH = 8;
const APP_LINK_HOST = "go.mantooq.com";

type Mode = "resetPassword" | "verifyEmail" | "verifyAndChangeEmail" | "recoverEmail";

type Failure = "expired" | "invalid" | "disabled" | "network" | "tooMany" | "generic";

type View =
  | { kind: "loading" }
  | { kind: "resetForm"; email: string }
  | { kind: "resetDone" }
  | { kind: "verified" }
  | { kind: "changed"; email: string | null }
  | { kind: "recovered"; email: string }
  | { kind: "failure"; failure: Failure };

const params = new URLSearchParams(location.search);
const mode = params.get("mode");
const oobCode = params.get("oobCode");

let lang: Lang = langFromParam(params.get("lang"));
let view: View = { kind: "loading" };
let auth: Auth | null = null;

/// Values typed in the reset form, kept so a language switch doesn't wipe them.
const form = { password: "", confirm: "", showPassword: false, showConfirm: false, error: "", busy: false };

/// Recover-email follow-up state, kept across re-renders for the same reason.
const recover = { busy: false, message: "" };

const root = document.getElementById("app")!;
const announcer = document.getElementById("announcer")!;

function t() {
  return STRINGS[lang];
}

function announce(message: string) {
  announcer.textContent = "";
  // A fresh text node after a tick makes screen readers repeat identical messages.
  setTimeout(() => (announcer.textContent = message), 50);
}

function isPhone(): boolean {
  const ua = navigator.userAgent;
  return /android|iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
}

/// A continue URL is honoured only when it opens the app, so the page can't be used as an open redirect.
function continueUrl(): string | null {
  const raw = params.get("continueUrl");
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.host === APP_LINK_HOST ? url.toString() : null;
  } catch {
    return null;
  }
}

/// The app screen each outcome should return to; null means "tell the user to switch back".
function appLinkFor(current: View): string | null {
  switch (current.kind) {
    case "resetDone":
      return continueUrl() ?? `https://${APP_LINK_HOST}/login`;
    case "verified":
      return continueUrl() ?? `https://${APP_LINK_HOST}/verify-email`;
    case "failure":
      if (current.failure !== "expired" && current.failure !== "invalid") return null;
      if (mode === "resetPassword") return `https://${APP_LINK_HOST}/forgotPassword`;
      if (mode === "verifyEmail") return `https://${APP_LINK_HOST}/verify-email`;
      return null;
    default:
      // The change-email screen confirms on resume; a deep link would navigate away and lose its state.
      return null;
  }
}

function failureFrom(error: unknown): Failure {
  const code = error instanceof FirebaseError ? error.code : "";
  switch (code) {
    case "auth/expired-action-code":
    case "auth/invalid-action-code":
      return "expired";
    case "auth/user-not-found":
    case "auth/invalid-email":
      return "invalid";
    case "auth/user-disabled":
      return "disabled";
    case "auth/network-request-failed":
    case "auth/internal-error":
      return "network";
    case "auth/too-many-requests":
      return "tooMany";
    default:
      return "generic";
  }
}

function setView(next: View, options: { focus?: boolean } = {}) {
  view = next;
  render(options.focus ?? true);
}

// ---------------------------------------------------------------------------
// Firebase

async function firebaseOptions(): Promise<FirebaseOptions> {
  if (import.meta.env.DEV && import.meta.env.VITE_AUTH_EMULATOR) {
    return { apiKey: "demo-key", projectId: import.meta.env.VITE_PROJECT_ID ?? "demo-mantooq" };
  }
  // Firebase Hosting serves the project's own web config here, so no key is committed and a
  // crafted link can't point the page at another project.
  const response = await fetch("/__/firebase/init.json", { cache: "no-store" });
  if (!response.ok) throw new Error(`init.json ${response.status}`);
  return (await response.json()) as FirebaseOptions;
}

async function getAuthInstance(): Promise<Auth> {
  if (auth) return auth;
  const app = initializeApp(await firebaseOptions());
  // In-memory persistence: the page never signs anyone in, so nothing is written to the browser.
  const instance = initializeAuth(app, { persistence: inMemoryPersistence });
  if (import.meta.env.DEV && import.meta.env.VITE_AUTH_EMULATOR) {
    connectAuthEmulator(instance, import.meta.env.VITE_AUTH_EMULATOR, { disableWarnings: true });
  }
  auth = instance;
  return instance;
}

async function start() {
  setView({ kind: "loading" }, { focus: false });
  if (!oobCode || !isMode(mode)) {
    setView({ kind: "failure", failure: "invalid" });
    return;
  }
  try {
    const instance = await getAuthInstance();
    instance.languageCode = lang;
    switch (mode) {
      case "resetPassword": {
        const email = await verifyPasswordResetCode(instance, oobCode);
        setView({ kind: "resetForm", email });
        break;
      }
      case "verifyEmail":
        await applyActionCode(instance, oobCode);
        setView({ kind: "verified" });
        break;
      case "verifyAndChangeEmail": {
        const info = await checkActionCode(instance, oobCode);
        await applyActionCode(instance, oobCode);
        setView({ kind: "changed", email: info.data.email ?? null });
        break;
      }
      case "recoverEmail": {
        const info = await checkActionCode(instance, oobCode);
        await applyActionCode(instance, oobCode);
        setView({ kind: "recovered", email: info.data.email ?? "" });
        break;
      }
    }
  } catch (error) {
    setView({ kind: "failure", failure: failureFrom(error) });
  }
}

function isMode(value: string | null): value is Mode {
  return (
    value === "resetPassword" ||
    value === "verifyEmail" ||
    value === "verifyAndChangeEmail" ||
    value === "recoverEmail"
  );
}

async function submitReset(event: Event) {
  event.preventDefault();
  if (form.busy || view.kind !== "resetForm") return;
  const s = t();
  if (form.password.length < MIN_PASSWORD_LENGTH) {
    form.error = s.errorLength;
  } else if (form.password !== form.confirm) {
    form.error = s.errorMatch;
  } else {
    form.error = "";
  }
  if (form.error) {
    render(false);
    announce(form.error);
    document.getElementById(form.password.length < MIN_PASSWORD_LENGTH ? "password" : "confirm")?.focus();
    return;
  }
  form.busy = true;
  render(false);
  announce(s.saving);
  try {
    await confirmPasswordReset(await getAuthInstance(), oobCode!, form.password);
    form.password = form.confirm = "";
    form.busy = false;
    setView({ kind: "resetDone" });
  } catch (error) {
    form.busy = false;
    if (error instanceof FirebaseError && error.code === "auth/weak-password") {
      form.error = t().errorWeak;
      render(false);
      announce(form.error);
      document.getElementById("password")?.focus();
      return;
    }
    setView({ kind: "failure", failure: failureFrom(error) });
  }
}

async function sendResetAfterRecover() {
  if (recover.busy || view.kind !== "recovered" || !view.email) return;
  recover.busy = true;
  recover.message = "";
  render(false);
  announce(t().sending);
  try {
    const instance = await getAuthInstance();
    instance.languageCode = lang;
    await sendPasswordResetEmail(instance, view.email);
    recover.message = t().resetSent(view.email);
  } catch {
    recover.message = t().resetSendFailed;
  }
  recover.busy = false;
  render(false);
  announce(recover.message);
}

// ---------------------------------------------------------------------------
// Rendering

function render(focusHeading: boolean) {
  const s = t();
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
  document.title = s.brand;

  const header = h(
    "header",
    { class: "top" },
    h("span", { class: "logo" }, h("img", { src: "/logo.svg", alt: "", width: 30, height: 30 }), s.brand),
    h(
      "button",
      { type: "button", class: "lang", lang: s.switchLanguageLang, onclick: () => switchLanguage() },
      s.switchLanguage,
    ),
  );

  const main = h("main", { class: "card", "aria-busy": view.kind === "loading" ? "true" : undefined }, ...body());
  const footer = h("footer", { class: "foot" }, s.footer);

  root.replaceChildren(header, main, footer);

  if (focusHeading) {
    const heading = root.querySelector<HTMLElement>("h1");
    heading?.focus();
  }
}

function switchLanguage() {
  lang = lang === "ar" ? "en" : "ar";
  if (auth) auth.languageCode = lang;
  render(false);
  root.querySelector<HTMLElement>("button.lang")?.focus();
}

function body(): Node[] {
  const s = t();
  switch (view.kind) {
    case "loading":
      return [h("div", { class: "spinner", "aria-hidden": "true" }), h("p", { class: "center", role: "status" }, s.loading)];
    case "resetForm":
      return resetForm(view.email);
    case "resetDone":
      return result("ok", s.resetDoneTitle, [s.resetDoneBody]);
    case "verified":
      return result("ok", s.verifiedTitle, [s.verifiedBody]);
    case "changed":
      return result("ok", s.changedTitle, [view.email ? withAddress(s.changedBody, view.email) : s.changedBodyNoEmail]);
    case "recovered":
      return recovered(view.email);
    case "failure":
      return failure(view.failure);
  }
}

/// Splits a sentence around the address so the address can be isolated for direction.
function withAddress(template: (email: string) => string, email: string): Node {
  const marker = "\u0000";
  const [before, after] = template(marker).split(marker);
  return h("span", {}, before, ltr(email), after);
}

function heading(text: string) {
  return h("h1", { tabindex: -1 }, text);
}

function result(tone: "ok" | "warn", title: string, lines: (string | Node)[], extra: Node[] = []): Node[] {
  return [
    h("div", { class: `icon ${tone}`, "aria-hidden": "true" }, tone === "ok" ? "✓" : "!"),
    heading(title),
    ...lines.map((line) => h("p", { class: "center" }, line)),
    ...extra,
    appAction(),
  ];
}

const RETRYABLE: ReadonlySet<Failure> = new Set(["network", "tooMany", "generic"]);

/// Retry for passing failures; otherwise a link into the app on a phone, or a plain note.
function appAction(): Node {
  if (view.kind === "failure" && RETRYABLE.has(view.failure)) {
    return h("button", { type: "button", class: "btn", onclick: () => void start() }, t().retry);
  }
  const link = appLinkFor(view);
  if (link && isPhone()) return h("a", { class: "btn", href: link }, t().openApp);
  return h("p", { class: "center muted" }, t().backToAppOnPhone);
}

function failure(kind: Failure): Node[] {
  const s = t();
  const copy: Record<Failure, [string, string]> = {
    expired: [s.expiredTitle, s.expiredBody],
    invalid: [s.invalidTitle, s.invalidBody],
    disabled: [s.disabledTitle, s.disabledBody],
    network: [s.networkTitle, s.networkBody],
    tooMany: [s.tooManyTitle, s.tooManyBody],
    generic: [s.genericTitle, s.genericBody],
  };
  const [title, text] = copy[kind];
  return result("warn", title, [text]);
}

function recovered(email: string): Node[] {
  const s = t();
  const extra: Node[] = [];
  if (email) {
    extra.push(
      h(
        "button",
        {
          type: "button",
          class: "btn secondary",
          "aria-busy": recover.busy ? "true" : undefined,
          onclick: () => void sendResetAfterRecover(),
        },
        recover.busy ? s.sending : s.sendReset,
      ),
    );
    if (recover.message) extra.push(h("p", { class: "center muted" }, recover.message));
  }
  return result("ok", s.recoveredTitle, [email ? withAddress(s.recoveredBody, email) : ""], extra);
}

function resetForm(email: string): Node[] {
  const s = t();
  const lengthOk = form.password.length >= MIN_PASSWORD_LENGTH;
  const matchOk = form.confirm.length > 0 && form.password === form.confirm;
  const errorId = "form-error";

  const passwordField = field({
    id: "password",
    label: s.newPassword,
    value: form.password,
    visible: form.showPassword,
    showLabel: s.showNew,
    hideLabel: s.hideNew,
    describedBy: `rule-length${form.error ? ` ${errorId}` : ""}`,
    invalid: !!form.error && !lengthOk,
    onInput: (value) => {
      form.password = value;
      updateRules();
    },
    onToggle: () => {
      form.showPassword = !form.showPassword;
      render(false);
      document.getElementById("password-toggle")?.focus();
    },
  });

  const confirmField = field({
    id: "confirm",
    label: s.confirmPassword,
    value: form.confirm,
    visible: form.showConfirm,
    showLabel: s.showConfirm,
    hideLabel: s.hideConfirm,
    describedBy: `rule-match${form.error ? ` ${errorId}` : ""}`,
    invalid: !!form.error && lengthOk && !matchOk,
    onInput: (value) => {
      form.confirm = value;
      updateRules();
    },
    onToggle: () => {
      form.showConfirm = !form.showConfirm;
      render(false);
      document.getElementById("confirm-toggle")?.focus();
    },
  });

  return [
    heading(s.resetTitle),
    h("p", { class: "center muted" }, s.resetIntro),
    h("p", { class: "account" }, `${s.account} `, ltr(email)),
    h(
      "form",
      { novalidate: true, onsubmit: (event: Event) => void submitReset(event) },
      // Lets password managers save the new password against the right account.
      h("input", {
        type: "email",
        name: "username",
        autocomplete: "username",
        value: email,
        readonly: true,
        tabindex: -1,
        "aria-hidden": "true",
        class: "sr-only",
      }),
      passwordField,
      rule("rule-length", s.ruleLength, lengthOk),
      confirmField,
      rule("rule-match", s.ruleMatch, matchOk),
      form.error ? h("p", { id: errorId, class: "error" }, form.error) : null,
      h(
        "button",
        { type: "submit", class: "btn", "aria-busy": form.busy ? "true" : undefined },
        form.busy ? s.saving : s.save,
      ),
    ),
  ];
}

function rule(id: string, text: string, met: boolean) {
  return h(
    "p",
    { id, class: `rule${met ? " met" : ""}` },
    h("span", { class: "mark", "aria-hidden": "true" }, met ? "✓" : "•"),
    text,
  );
}

/// Removes a shown error once the user edits, without re-rendering the field being typed in.
function clearError() {
  if (!form.error) return;
  form.error = "";
  document.getElementById("form-error")?.remove();
  for (const id of ["password", "confirm"]) {
    const input = document.getElementById(id);
    input?.removeAttribute("aria-invalid");
    input?.setAttribute("aria-describedby", id === "password" ? "rule-length" : "rule-match");
    input?.parentElement?.classList.remove("invalid");
  }
}

/// Updates the rule marks in place while typing, so the field keeps focus and the caret.
function updateRules() {
  clearError();
  const lengthOk = form.password.length >= MIN_PASSWORD_LENGTH;
  const matchOk = form.confirm.length > 0 && form.password === form.confirm;
  for (const [id, met] of [
    ["rule-length", lengthOk],
    ["rule-match", matchOk],
  ] as const) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.classList.toggle("met", met);
    const mark = el.querySelector(".mark");
    if (mark) mark.textContent = met ? "✓" : "•";
  }
}

function field(options: {
  id: string;
  label: string;
  value: string;
  visible: boolean;
  showLabel: string;
  hideLabel: string;
  describedBy: string;
  invalid: boolean;
  onInput: (value: string) => void;
  onToggle: () => void;
}): Node {
  const s = t();
  const input = h("input", {
    id: options.id,
    name: options.id,
    type: options.visible ? "text" : "password",
    autocomplete: "new-password",
    autocapitalize: "off",
    spellcheck: "false",
    dir: "ltr",
    required: true,
    minlength: MIN_PASSWORD_LENGTH,
    "aria-describedby": options.describedBy,
    "aria-invalid": options.invalid ? "true" : undefined,
    oninput: (event: Event) => options.onInput((event.target as HTMLInputElement).value),
  });
  input.value = options.value;
  return h(
    "div",
    { class: "group" },
    h("label", { for: options.id }, options.label),
    h(
      "div",
      { class: `field${options.invalid ? " invalid" : ""}` },
      input,
      h(
        "button",
        {
          type: "button",
          id: `${options.id}-toggle`,
          class: "toggle",
          "aria-controls": options.id,
          "aria-pressed": options.visible ? "true" : "false",
          "aria-label": options.visible ? options.hideLabel : options.showLabel,
          onclick: options.onToggle,
        },
        options.visible ? s.hide : s.show,
      ),
    ),
  );
}

void start();
