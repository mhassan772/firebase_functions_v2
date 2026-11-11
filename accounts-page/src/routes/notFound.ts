/// Any path the router doesn't know, such as `/index.html` opened directly.

import { h } from "../dom";
import { STRINGS, langFromParam, type Lang } from "../i18n";
import { focusLanguageToggle, heading, renderShell } from "../shell";

let lang: Lang = langFromParam(new URLSearchParams(location.search).get("lang"));

function render() {
  const s = STRINGS[lang];
  renderShell({
    lang,
    body: [
      h("div", { class: "icon warn", "aria-hidden": "true" }, "!"),
      heading(s.notFoundTitle),
      h("p", { class: "center" }, s.notFoundBody),
      h("a", { class: "btn secondary", href: "https://mantooq.com" }, s.goHome),
    ],
    onSwitchLanguage: () => {
      lang = lang === "ar" ? "en" : "ar";
      render();
      focusLanguageToggle();
    },
  });
}

export function mount(): void {
  render();
}
