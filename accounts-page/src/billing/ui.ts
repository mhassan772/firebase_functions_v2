/// Pieces `/subscribe` and `/manage` share: the sign-in gate, notices, links and regions that
/// update in place.

import { signOut } from "firebase/auth";

import { getSession, restoredSignIn, signedInUser, type Session, type SignedIn } from "../auth/session";
import { renderSignIn, type MountedView } from "../auth/signIn";
import { STORE_SUBSCRIPTION_LINKS } from "../delete/storeSubscriptions";
import { h, ltr } from "../dom";
import { STRINGS, type Lang, type Strings } from "../i18n";
import { storeName, type StorePlatform } from "./logic";

// ---------------------------------------------------------------------------
// Sign-in gate, the same as `/delete`'s: session persistence, guests never count.

export type GatePhase = "loading" | "initFailed" | "signedOut" | "signedIn";

export interface Gate {
  readonly phase: GatePhase;
  readonly session: Session | null;
  readonly signedIn: SignedIn | null;
  /// The sign-in view's container while signed out.
  readonly signInSlot: HTMLElement | null;
  start(): Promise<void>;
  signOut(message?: string): Promise<void>;
  /// Re-renders the sign-in view after a language switch.
  refresh(): void;
}

export interface GateChange {
  /// Where focus goes after the page re-renders.
  focus?: string;
  announce?: string;
}

export function createGate(options: { lang: () => Lang; onChange: (change: GateChange) => void }): Gate {
  let phase: GatePhase = "loading";
  let session: Session | null = null;
  let signedIn: SignedIn | null = null;
  let view: { slot: HTMLElement; view: MountedView<SignedIn> } | null = null;

  function enterSignedOut(change: GateChange) {
    const current = session!;
    signedIn = null;
    phase = "signedOut";
    const slot = h("div", { class: "slot" });
    const mounted = renderSignIn(slot, current.auth, { lang: options.lang, idPrefix: "signin" });
    view = { slot, view: mounted };
    options.onChange({ focus: change.focus ?? "#signin-heading", announce: change.announce });
    void mounted.result.then((result) => {
      if (phase !== "signedOut" || view?.view !== mounted) return;
      signedIn = result;
      phase = "signedIn";
      view = null;
      options.onChange({ announce: STRINGS[options.lang()].signedInAnnouncement });
    });
  }

  const gate: Gate = {
    get phase() {
      return phase;
    },
    get session() {
      return session;
    },
    get signedIn() {
      return signedIn;
    },
    get signInSlot() {
      return view?.slot ?? null;
    },
    async start() {
      phase = "loading";
      options.onChange({});
      try {
        session = await getSession();
      } catch {
        phase = "initFailed";
        options.onChange({ focus: "h1" });
        return;
      }
      session.auth.languageCode = options.lang();
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
        phase = "signedIn";
        options.onChange({ focus: "h1" });
      } else {
        enterSignedOut({ focus: "h1" });
      }
    },
    async signOut(message) {
      if (!session) return;
      await signOut(session.auth).catch(() => undefined);
      enterSignedOut({ announce: message });
    },
    refresh() {
      if (session) session.auth.languageCode = options.lang();
      view?.view.refresh();
    },
  };
  return gate;
}

/// What the page shows while the gate is not signed in: a spinner, a retry, or the sign-in view.
export function gateStep(gate: Gate, s: Strings, retry: () => void): Node[] {
  switch (gate.phase) {
    case "loading":
      return loadingStep(s.checkingSignIn);
    case "initFailed":
      return [
        notice("danger", "!", h("p", { class: "strong" }, s.signInFailedTitle), h("p", {}, s.networkBody)),
        h("button", { type: "button", id: "init-retry", class: "btn", onclick: retry }, s.retry),
      ];
    case "signedOut":
      return gate.signInSlot ? [gate.signInSlot] : [];
    case "signedIn":
      return [];
  }
}

export function loadingStep(text: string): Node[] {
  return [h("div", { class: "spinner", "aria-hidden": "true" }), h("p", { class: "center", role: "status", id: "loading-status", tabindex: -1 }, text)];
}

/// "Account: name@example.com · Not you? Sign out".
export function accountRow(signedIn: SignedIn, s: Strings, options: { busy: boolean; onSignOut: () => void }): Node {
  const user = signedIn.user;
  const provider = signedIn.provider === "apple" ? s.appleName : signedIn.provider === "google" ? s.googleName : "";
  return h(
    "div",
    { class: "account row" },
    user.email ? h("span", {}, `${s.signedInAs} `, ltr(user.email)) : h("span", {}, s.signedInWith(provider)),
    h(
      "button",
      {
        type: "button",
        id: "sign-out",
        class: "link-button",
        "aria-disabled": options.busy ? "true" : undefined,
        onclick: () => {
          if (!options.busy) options.onSignOut();
        },
      },
      s.notYou,
    ),
  );
}

// ---------------------------------------------------------------------------
// Small pieces

/// A coloured notice that always pairs its colour with an icon and its own words.
export function notice(tone: "info" | "warn" | "danger", glyph: string, ...content: (Node | null)[]): HTMLElement {
  return h(
    "div",
    { class: `notice ${tone}` },
    h("span", { class: "notice-icon", "aria-hidden": "true" }, glyph),
    h("div", { class: "notice-body" }, ...content),
  );
}

export function externalLink(href: string, text: string, s: Strings): Node {
  return h("a", { href, target: "_blank", rel: "noopener noreferrer" }, text, h("span", { class: "sr-only" }, ` ${s.opensInNewTab}`));
}

export { storeName };

/// The store's own page for cancelling, for whichever account is signed in to the store.
export function storeCancelLink(store: StorePlatform, s: Strings): Node {
  return externalLink(STORE_SUBSCRIPTION_LINKS[store], s.cancelInStore(storeName(store, s)), s);
}

/// A link to another page of this site, keeping the page's language.
export function pageLink(path: "/subscribe" | "/manage", text: string, lang: Lang, className?: string): Node {
  return h("a", { href: lang === "en" ? `${path}?lang=en` : path, class: className }, text);
}

// ---------------------------------------------------------------------------
// Regions

/// Parts of a view rebuilt in place, so the rest of the page, the Payment Element's frame above
/// all, is never detached: a detached frame reloads and loses what was typed in it.
export class Regions {
  private builders = new Map<string, () => (Node | null)[]>();

  /// A container whose content `build` makes, now and on every `update`.
  create(id: string, build: () => (Node | null)[], attrs: Record<string, string | undefined> = {}): HTMLElement {
    this.builders.set(id, build);
    return h("div", { id, ...attrs }, ...build());
  }

  /// Rebuilds the named regions, giving focus back to the element that had it when it still exists.
  update(...ids: string[]): void {
    const active = document.activeElement as HTMLElement | null;
    const activeId = active?.id ?? "";
    for (const id of ids) {
      const container = document.getElementById(id);
      const build = this.builders.get(id);
      if (!container || !build) continue;
      container.replaceChildren(...build().filter((node): node is Node => node !== null));
    }
    if (activeId && document.activeElement !== active) document.getElementById(activeId)?.focus();
  }

  clear(): void {
    this.builders.clear();
  }
}

export function compact(nodes: (Node | null | false | undefined)[]): Node[] {
  return nodes.filter((node): node is Node => Boolean(node));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
