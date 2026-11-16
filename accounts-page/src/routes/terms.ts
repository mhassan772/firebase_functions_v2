/// `/terms`: the subscription terms, public and static. It imports neither Firebase nor Stripe
/// code, so the page needs no sign-in and its header policy allows no other origin.

import { formatDate } from "../billing/logic";
import { h, ltr } from "../dom";
import { STRINGS, TERMS_CONTACT, TERMS_UPDATED, langFromParam, type Lang } from "../i18n";
import { focusLanguageToggle, heading, renderShell } from "../shell";

let lang: Lang = langFromParam(new URLSearchParams(location.search).get("lang"));

/// A clause's paragraph, with the contact address as a mail link that shows the address itself.
function paragraph(body: string): HTMLElement {
  const [before, ...rest] = body.split(TERMS_CONTACT);
  const nodes: (Node | string)[] = [before];
  for (const after of rest) nodes.push(h("a", { href: `mailto:${TERMS_CONTACT}`, class: "tall-link" }, ltr(TERMS_CONTACT)), after);
  return h("p", {}, ...nodes);
}

function render(focusHeading: boolean) {
  const s = STRINGS[lang];
  renderShell({
    lang,
    body: [
      heading(s.termsTitle),
      h("p", { class: "muted terms-updated" }, s.termsUpdated(formatDate(TERMS_UPDATED, lang)!)),
      h("div", { class: "terms" }, ...s.termsClauses.flatMap((clause) => [h("h2", {}, clause.title), paragraph(clause.body)])),
    ],
    focusHeading,
    onSwitchLanguage: () => {
      lang = lang === "ar" ? "en" : "ar";
      render(false);
      focusLanguageToggle();
    },
  });
}

export function mount(): void {
  render(true);
}
