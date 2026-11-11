/// The sign-in view and the "confirm it's you" view, shared by every page that needs an account.
///
/// Each renders into a container the page keeps across its own re-renders, and resolves once
/// done. The page calls `refresh()` after a language switch.

import {
  EmailAuthProvider,
  GoogleAuthProvider,
  OAuthProvider,
  browserPopupRedirectResolver,
  reauthenticateWithCredential,
  reauthenticateWithPopup,
  signInWithEmailAndPassword,
  signInWithPopup,
  type Auth,
  type AuthProvider,
  type User,
  type UserCredential,
} from "firebase/auth";

import { h, icon, ltr } from "../dom";
import { STRINGS, type Lang, type Strings } from "../i18n";
import { announce } from "../shell";
import { signInFailureFrom, type SignInFailure } from "./errors";
import type { Provider, SignedIn } from "./session";

export interface ViewOptions {
  lang: () => Lang;
  /// Prefix for element ids, so two views on one page never share one.
  idPrefix?: string;
}

export interface MountedView<T> {
  result: Promise<T>;
  /// Re-renders in the current language, keeping typed values and focus.
  refresh(): void;
}

type FieldError = "emailMissing" | "passwordMissing" | "wrongPassword";
type ShownError = { kind: Exclude<SignInFailure, "cancelled"> | FieldError; place: "providers" | "form" };

const GOOGLE_ICON = [
  { fill: "#EA4335", d: "M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" },
  { fill: "#4285F4", d: "M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" },
  { fill: "#FBBC05", d: "M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" },
  { fill: "#34A853", d: "M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" },
];
const APPLE_ICON = [
  { d: "M12 7.1c-1.5 0-2.3-1-3.9-1C5.8 6.1 4 8.1 4 11.3 4 15.1 6.6 20 8.6 20c1.2 0 1.7-.8 3.4-.8s2.2.8 3.4.8c2 0 4.6-4.9 4.6-8.7 0-3.2-1.8-5.2-4.1-5.2-1.6 0-2.4 1-3.9 1z" },
  { d: "M12.3 5.7c.2-1.8 1.4-3.3 3.1-3.7.2 1.9-1.3 3.5-3.1 3.7z" },
];

function errorText(s: Strings, kind: ShownError["kind"]): string {
  const copy: Record<ShownError["kind"], string> = {
    emailMissing: s.errorEmailMissing,
    passwordMissing: s.errorPasswordMissing,
    wrongPassword: s.errorWrongPassword,
    wrongCredentials: s.errorWrongCredentials,
    tooMany: s.errorTooMany,
    network: s.errorNetwork,
    popupBlocked: s.errorPopupBlocked,
    providerDisabled: s.errorProviderDisabled,
    otherMethod: s.errorOtherMethod,
    differentAccount: s.errorDifferentAccount,
    disabled: s.errorDisabled,
    generic: s.errorSignInGeneric,
  };
  return copy[kind];
}

/// The Google or Apple provider, asking for the page's language and, when known, the account.
function oauthProvider(kind: "google" | "apple", lang: Lang, email?: string | null): AuthProvider {
  if (kind === "google") {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters(email ? { login_hint: email } : { prompt: "select_account" });
    return provider;
  }
  const provider = new OAuthProvider("apple.com");
  provider.addScope("email");
  provider.addScope("name");
  provider.setCustomParameters({ locale: lang === "ar" ? "ar_SA" : "en_US" });
  return provider;
}

function signedInFrom(credential: UserCredential, provider: Provider): SignedIn {
  const appleAccessToken =
    provider === "apple" ? (OAuthProvider.credentialFromResult(credential)?.accessToken ?? undefined) : undefined;
  return { user: credential.user, provider, appleAccessToken };
}

/// Confirms the current user again with the method they signed in with. Another account fails
/// with `auth/user-mismatch`. Must be called straight from a click, so a popup is allowed.
export function reauthenticate(
  user: User,
  provider: Provider,
  options: { lang: Lang; password?: string },
): Promise<SignedIn> {
  const operation =
    provider === "password"
      ? reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email ?? "", options.password ?? ""))
      : reauthenticateWithPopup(user, oauthProvider(provider, options.lang, user.email), browserPopupRedirectResolver);
  return operation.then((credential) => signedInFrom(credential, provider));
}

// ---------------------------------------------------------------------------
// Shared pieces

function refreshKeepingFocus(container: HTMLElement, build: () => Node[]) {
  const active = document.activeElement as HTMLElement | null;
  const activeId = active && container.contains(active) ? active.id : "";
  container.replaceChildren(...build());
  if (activeId) document.getElementById(activeId)?.focus();
}

function passwordGroup(options: {
  id: string;
  s: Strings;
  value: string;
  visible: boolean;
  describedBy?: string;
  invalid: boolean;
  onInput: (value: string) => void;
  onToggle: () => void;
}): Node {
  const { s } = options;
  const input = h("input", {
    id: options.id,
    name: "password",
    type: options.visible ? "text" : "password",
    autocomplete: "current-password",
    autocapitalize: "off",
    spellcheck: "false",
    dir: "ltr",
    required: true,
    "aria-describedby": options.describedBy,
    "aria-invalid": options.invalid ? "true" : undefined,
    oninput: (event: Event) => options.onInput((event.target as HTMLInputElement).value),
  });
  input.value = options.value;
  return h(
    "div",
    { class: "group" },
    h("label", { for: options.id }, s.password),
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
          "aria-label": options.visible ? s.hidePassword : s.showPassword,
          onclick: options.onToggle,
        },
        options.visible ? s.hide : s.show,
      ),
    ),
  );
}

function providerButton(options: {
  id: string;
  kind: "google" | "apple";
  label: string;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}): Node {
  return h(
    "button",
    {
      type: "button",
      id: options.id,
      class: `btn provider ${options.kind}`,
      "aria-busy": options.busy ? "true" : undefined,
      "aria-disabled": options.disabled ? "true" : undefined,
      onclick: options.onClick,
    },
    icon(options.kind === "google" ? "0 0 48 48" : "0 0 24 24", options.kind === "google" ? GOOGLE_ICON : APPLE_ICON),
    h("span", {}, options.label),
  );
}

/// Removes a shown form error once the user edits, without re-rendering the field being typed in.
function clearFormError(container: HTMLElement, errorId: string, fieldIds: string[]) {
  container.querySelector(`#${errorId}`)?.remove();
  for (const id of fieldIds) {
    const input = container.querySelector(`#${id}`);
    input?.removeAttribute("aria-invalid");
    input?.removeAttribute("aria-describedby");
    input?.parentElement?.classList.remove("invalid");
  }
}

// ---------------------------------------------------------------------------
// Sign-in view

/// Renders the sign-in view into `container` and resolves with the signed-in user.
export function renderSignIn(container: HTMLElement, auth: Auth, options: ViewOptions): MountedView<SignedIn> {
  const id = (name: string) => `${options.idPrefix ?? "signin"}-${name}`;
  const state = {
    email: "",
    password: "",
    showPassword: false,
    busy: null as Provider | null,
    error: null as ShownError | null,
  };
  let resolve!: (value: SignedIn) => void;
  const result = new Promise<SignedIn>((done) => (resolve = done));

  const s = () => STRINGS[options.lang()];

  function fail(error: unknown, place: ShownError["place"]) {
    state.busy = null;
    const kind = signInFailureFrom(error);
    state.error = kind === "cancelled" ? null : { kind, place };
    refresh();
    if (!state.error) return;
    announce(errorText(s(), state.error.kind));
    if (place === "form") document.getElementById(id(kind === "wrongCredentials" ? "password" : "email"))?.focus();
  }

  function withProvider(kind: "google" | "apple") {
    if (state.busy) return;
    state.error = null;
    auth.languageCode = options.lang();
    // Started before any re-render or await, so the browser still counts the click and allows the popup.
    const operation = signInWithPopup(auth, oauthProvider(kind, options.lang()), browserPopupRedirectResolver);
    state.busy = kind;
    refresh();
    announce(s().signingIn);
    operation.then(
      (credential) => {
        state.busy = null;
        resolve(signedInFrom(credential, kind));
      },
      (error) => fail(error, "providers"),
    );
  }

  async function withPassword(event: Event) {
    event.preventDefault();
    if (state.busy) return;
    const email = state.email.trim();
    const missing: FieldError | null = !email ? "emailMissing" : !state.password ? "passwordMissing" : null;
    if (missing) {
      state.error = { kind: missing, place: "form" };
      refresh();
      announce(errorText(s(), missing));
      document.getElementById(id(missing === "emailMissing" ? "email" : "password"))?.focus();
      return;
    }
    state.error = null;
    state.busy = "password";
    refresh();
    announce(s().signingIn);
    try {
      auth.languageCode = options.lang();
      const credential = await signInWithEmailAndPassword(auth, email, state.password);
      state.busy = null;
      state.password = "";
      resolve(signedInFrom(credential, "password"));
    } catch (error) {
      fail(error, "form");
    }
  }

  function build(): Node[] {
    return buildNodes().filter((node): node is Node => node !== null);
  }

  function buildNodes(): (Node | null)[] {
    const strings = s();
    const busy = state.busy !== null;
    const error = state.error;
    const providerError = error?.place === "providers" ? error : null;
    const formError = error?.place === "form" ? error : null;
    const errorId = id("error");
    const emailInvalid = formError !== null && formError.kind !== "passwordMissing";
    const passwordInvalid = formError !== null && formError.kind !== "emailMissing";

    const email = h("input", {
      id: id("email"),
      name: "username",
      type: "email",
      autocomplete: "username",
      inputmode: "email",
      autocapitalize: "off",
      spellcheck: "false",
      dir: "ltr",
      required: true,
      "aria-describedby": emailInvalid ? errorId : undefined,
      "aria-invalid": emailInvalid ? "true" : undefined,
      oninput: (event: Event) => {
        state.email = (event.target as HTMLInputElement).value;
        if (state.error?.place === "form") {
          state.error = null;
          clearFormError(container, errorId, [id("email"), id("password")]);
        }
      },
    });
    email.value = state.email;

    return [
      h("h2", { tabindex: -1, id: id("heading") }, strings.signInTitle),
      h("p", { class: "muted" }, strings.signInIntro),
      providerButton({
        id: id("google"),
        kind: "google",
        label: strings.continueWithGoogle,
        busy: state.busy === "google",
        disabled: busy,
        onClick: () => withProvider("google"),
      }),
      providerButton({
        id: id("apple"),
        kind: "apple",
        label: strings.continueWithApple,
        busy: state.busy === "apple",
        disabled: busy,
        onClick: () => withProvider("apple"),
      }),
      providerError ? h("p", { class: "error", id: id("provider-error") }, errorText(strings, providerError.kind)) : null,
      h("div", { class: "divider" }, h("span", {}, strings.or)),
      h(
        "form",
        { novalidate: true, "aria-busy": state.busy === "password" ? "true" : undefined, onsubmit: (e: Event) => void withPassword(e) },
        h(
          "div",
          { class: "group" },
          h("label", { for: id("email") }, strings.email),
          h("div", { class: `field${emailInvalid ? " invalid" : ""}` }, email),
        ),
        passwordGroup({
          id: id("password"),
          s: strings,
          value: state.password,
          visible: state.showPassword,
          describedBy: passwordInvalid ? errorId : undefined,
          invalid: passwordInvalid,
          onInput: (value) => {
            state.password = value;
            if (state.error?.place === "form") {
              state.error = null;
              clearFormError(container, errorId, [id("email"), id("password")]);
            }
          },
          onToggle: () => {
            state.showPassword = !state.showPassword;
            refresh();
          },
        }),
        formError ? h("p", { id: errorId, class: "error" }, errorText(strings, formError.kind)) : null,
        h(
          "button",
          {
            type: "submit",
            id: id("submit"),
            class: "btn",
            "aria-busy": state.busy === "password" ? "true" : undefined,
            "aria-disabled": busy ? "true" : undefined,
          },
          state.busy === "password" ? strings.signingIn : strings.signIn,
        ),
      ),
      h("p", { class: "muted small" }, strings.forgotPasswordHint),
    ];
  }

  function refresh() {
    refreshKeepingFocus(container, build);
  }

  refresh();
  return { result, refresh };
}

// ---------------------------------------------------------------------------
// "Confirm it's you"

/// Renders the confirmation for `signedIn`'s method; resolves with the refreshed sign-in, or null
/// when the user cancels. `signedIn.provider` must not be null.
export function renderReauthentication(
  container: HTMLElement,
  auth: Auth,
  signedIn: SignedIn,
  options: ViewOptions & { body: () => string },
): MountedView<SignedIn | null> {
  const provider = signedIn.provider!;
  const id = (name: string) => `${options.idPrefix ?? "reauth"}-${name}`;
  const state = { password: "", showPassword: false, busy: false, error: null as ShownError | null };
  let resolve!: (value: SignedIn | null) => void;
  const result = new Promise<SignedIn | null>((done) => (resolve = done));
  const s = () => STRINGS[options.lang()];

  function fail(error: unknown) {
    state.busy = false;
    const failure = signInFailureFrom(error);
    // Only the password was typed here, so a refusal is about the password.
    const kind = provider === "password" && failure === "wrongCredentials" ? "wrongPassword" : failure;
    state.error = kind === "cancelled" ? null : { kind, place: provider === "password" ? "form" : "providers" };
    refresh();
    if (!state.error) return;
    announce(errorText(s(), state.error.kind));
    if (provider === "password") document.getElementById(id("password"))?.focus();
  }

  function confirm(event?: Event) {
    event?.preventDefault();
    if (state.busy) return;
    if (provider === "password" && !state.password) {
      state.error = { kind: "passwordMissing", place: "form" };
      refresh();
      announce(s().errorPasswordMissing);
      document.getElementById(id("password"))?.focus();
      return;
    }
    state.error = null;
    auth.languageCode = options.lang();
    // Started before any re-render, so a popup still counts as opened by the click.
    const operation = reauthenticate(signedIn.user, provider, { lang: options.lang(), password: state.password });
    state.busy = true;
    refresh();
    announce(s().confirming);
    operation.then(
      (confirmed) => {
        state.busy = false;
        state.password = "";
        resolve(confirmed);
      },
      fail,
    );
  }

  function build(): Node[] {
    const strings = s();
    const errorId = id("error");
    const error = state.error;
    const nodes: Node[] = [
      h("h2", { tabindex: -1, id: id("heading") }, strings.reauthTitle),
      h("p", {}, options.body()),
    ];
    if (signedIn.user.email) nodes.push(h("p", { class: "account" }, `${strings.signedInAs} `, ltr(signedIn.user.email)));

    if (provider === "password") {
      nodes.push(
        h(
          "form",
          { novalidate: true, "aria-busy": state.busy ? "true" : undefined, onsubmit: (e: Event) => confirm(e) },
          // Lets password managers fill the password for the right account.
          h("input", {
            type: "email",
            name: "username",
            autocomplete: "username",
            value: signedIn.user.email ?? "",
            readonly: true,
            tabindex: -1,
            "aria-hidden": "true",
            class: "sr-only",
          }),
          passwordGroup({
            id: id("password"),
            s: strings,
            value: state.password,
            visible: state.showPassword,
            describedBy: error ? errorId : undefined,
            invalid: error !== null,
            onInput: (value) => {
              state.password = value;
              if (state.error) {
                state.error = null;
                clearFormError(container, errorId, [id("password")]);
              }
            },
            onToggle: () => {
              state.showPassword = !state.showPassword;
              refresh();
            },
          }),
          error ? h("p", { id: errorId, class: "error" }, errorText(strings, error.kind)) : null,
          h(
            "button",
            {
              type: "submit",
              id: id("confirm"),
              class: "btn",
              "aria-busy": state.busy ? "true" : undefined,
              "aria-disabled": state.busy ? "true" : undefined,
            },
            state.busy ? strings.confirming : strings.confirmWithPassword,
          ),
        ),
      );
    } else {
      nodes.push(
        providerButton({
          id: id("confirm"),
          kind: provider,
          label: state.busy ? strings.confirming : provider === "google" ? strings.confirmWithGoogle : strings.confirmWithApple,
          busy: state.busy,
          disabled: state.busy,
          onClick: () => confirm(),
        }),
      );
      if (error) nodes.push(h("p", { class: "error", id: errorId }, errorText(strings, error.kind)));
    }
    nodes.push(
      h(
        "button",
        {
          type: "button",
          id: id("cancel"),
          class: "btn secondary",
          "aria-disabled": state.busy ? "true" : undefined,
          onclick: () => {
            if (!state.busy) resolve(null);
          },
        },
        strings.cancel,
      ),
    );
    return nodes;
  }

  function refresh() {
    refreshKeepingFocus(container, build);
  }

  refresh();
  return { result, refresh };
}
