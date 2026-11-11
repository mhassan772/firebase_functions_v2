/// The page frame every route shares: logo, language toggle, card, footer and the live region.

import { h } from "./dom";
import { STRINGS, type Lang } from "./i18n";

export interface ShellOptions {
  lang: Lang;
  /// Content of the card.
  body: Node[];
  /// Marks the card busy while its content is still loading.
  busy?: boolean;
  /// Moves focus to the first heading inside the card; the route decides which views warrant it.
  focusHeading?: boolean;
  onSwitchLanguage: () => void;
}

function root(): HTMLElement {
  return document.getElementById("app")!;
}

/// Replaces the page with a fresh frame around `body`.
export function renderShell(options: ShellOptions): void {
  const s = STRINGS[options.lang];
  document.documentElement.lang = options.lang;
  document.documentElement.dir = options.lang === "ar" ? "rtl" : "ltr";
  document.title = s.brand;

  const header = h(
    "header",
    { class: "top" },
    h("span", { class: "logo" }, h("img", { src: "/logo.svg", alt: "", width: 30, height: 30 }), s.brand),
    h(
      "button",
      { type: "button", class: "lang", lang: s.switchLanguageLang, onclick: () => options.onSwitchLanguage() },
      s.switchLanguage,
    ),
  );

  const main = h("main", { class: "card", "aria-busy": options.busy ? "true" : undefined }, ...options.body);
  const footer = h("footer", { class: "foot" }, s.footer);

  root().replaceChildren(header, main, footer);

  if (options.focusHeading) focusHeading();
}

/// Focuses the page's first heading.
export function focusHeading(): void {
  focusSelector("h1");
}

/// Focuses the first element in the page matching `selector`, such as a section's heading.
export function focusSelector(selector: string): void {
  root().querySelector<HTMLElement>(selector)?.focus();
}

/// Returns focus to the language toggle after a language switch re-rendered the page.
export function focusLanguageToggle(): void {
  root().querySelector<HTMLElement>("button.lang")?.focus();
}

let pendingAnnouncements: string[] = [];

/// Speaks `message` through the live region.
///
/// Messages that arrive before the region is refilled are spoken together, so a second one, such
/// as a warning that loads right after "signed in", does not replace the first.
export function announce(message: string): void {
  const first = pendingAnnouncements.length === 0;
  pendingAnnouncements.push(message);
  if (!first) return;
  const announcer = document.getElementById("announcer")!;
  announcer.textContent = "";
  // A fresh text node after a tick makes screen readers repeat identical messages.
  setTimeout(() => {
    announcer.textContent = pendingAnnouncements.join(" ");
    pendingAnnouncements = [];
  }, 50);
}

/// A heading that can take focus without joining the tab order.
export function heading(text: string, level: "h1" | "h2" = "h1", id?: string): HTMLElement {
  return h(level, { tabindex: -1, id }, text);
}
