import "@fontsource/ibm-plex-sans-arabic/arabic-400.css";
import "@fontsource/ibm-plex-sans-arabic/arabic-700.css";
import "@fontsource/ibm-plex-sans-arabic/latin-400.css";
import "@fontsource/ibm-plex-sans-arabic/latin-700.css";
import "./style.css";

import { h } from "./dom";
import { STRINGS, langFromParam, type Lang } from "./i18n";
import { routeFor, type Route } from "./router";
import { focusLanguageToggle, heading, renderShell } from "./shell";

/// Each route is its own chunk, so `/action` never downloads the sign-in, popup or functions code,
/// and only the account page carries the Stripe.js loader.
const ROUTES: Record<Route, () => Promise<{ mount: () => void }>> = {
  action: () => import("./routes/action"),
  delete: () => import("./routes/delete"),
  account: () => import("./routes/account"),
  notFound: () => import("./routes/notFound"),
};

/// Shown when the route's own code couldn't be downloaded.
function loadFailed(lang: Lang) {
  const s = STRINGS[lang];
  renderShell({
    lang,
    body: [
      h("div", { class: "icon warn", "aria-hidden": "true" }, "!"),
      heading(s.networkTitle),
      h("p", { class: "center" }, s.networkBody),
      h("button", { type: "button", class: "btn", onclick: () => location.reload() }, s.retry),
    ],
    focusHeading: true,
    onSwitchLanguage: () => {
      loadFailed(lang === "ar" ? "en" : "ar");
      focusLanguageToggle();
    },
  });
}

ROUTES[routeFor(location.pathname)]().then(
  (route) => route.mount(),
  () => loadFailed(langFromParam(new URLSearchParams(location.search).get("lang"))),
);
