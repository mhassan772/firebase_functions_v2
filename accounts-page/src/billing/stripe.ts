/// Stripe.js for the account page, loaded only when it needs it.
///
/// `@stripe/stripe-js/pure` adds the script on the first call, not on import, so no other page
/// ever reaches js.stripe.com. Stripe.js fixes its locale per instance, so there is one instance
/// per language, as on the donation site.

import { loadStripe } from "@stripe/stripe-js/pure";
import type {
  Appearance,
  Stripe,
  StripeElements,
  StripeElementsOptionsMode,
  StripePaymentElement,
} from "@stripe/stripe-js";

import { h } from "../dom";
import type { Lang } from "../i18n";
import { elementsOptions, PAYMENT_ELEMENT_OPTIONS, type ElementsKind } from "./logic";

const instances = new Map<string, Promise<Stripe>>();

/// The Stripe instance for `lang`; a failed load is forgotten so a retry loads again.
export function stripeFor(publishableKey: string, lang: Lang): Promise<Stripe> {
  const key = `${lang}:${publishableKey}`;
  let instance = instances.get(key);
  if (!instance) {
    instance = loadStripe(publishableKey, { locale: lang }).then((stripe) => {
      if (!stripe) throw new Error("stripe_unavailable");
      return stripe;
    });
    instance.catch(() => instances.delete(key));
    instances.set(key, instance);
  }
  return instance;
}

/// The donation site's look (mantooq-donation `Checkout.tsx`), with this site's danger colour.
const APPEARANCE: Appearance = {
  theme: "stripe",
  variables: {
    colorPrimary: "#00a576",
    colorText: "#10241c",
    colorTextSecondary: "#55665f",
    colorDanger: "#b42318",
    fontFamily: "'IBM Plex Sans Arabic', 'Segoe UI', Tahoma, sans-serif",
    borderRadius: "12px",
  },
  rules: {
    // Fields at least 48 px tall, like this site's own.
    ".Input": { padding: "13px 12px" },
  },
};

/// Loaded inside Stripe's own frames, so this page's policy never fetches it.
const FONTS = [{ cssSrc: "https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&display=swap" }];

export interface MountedPayment {
  stripe: Stripe;
  elements: StripeElements;
  element: StripePaymentElement;
  /// Where the card form says whether its fields are on screen.
  onStatus: (status: CardFormStatus) => void;
  /// An in-place update still waiting for Stripe's `update-end`.
  pendingUpdate: { timer: ReturnType<typeof setTimeout> | null; shown: boolean; fallback: ReturnType<typeof setTimeout> | null } | null;
}

/// A container for the Payment Element; Arabic needs `dir="rtl"` on an ancestor, since the
/// locale alone does not turn the fields around.
export function paymentHost(id: string, lang: Lang): HTMLElement {
  return h("div", { id, class: "payment-host", dir: lang === "ar" ? "rtl" : "ltr" });
}

/// `loading` from the start of a mount until the Payment Element's `ready`, `failed` on a load
/// error, and `loading` again during an in-place update that takes long enough to be seen.
export type CardFormStatus = "loading" | "ready" | "failed";

/// An update that Stripe applies within this time is not shown as loading, so a plan change that
/// redraws nothing never flashes the line or speaks it.
const UPDATE_LOADING_DELAY_MS = 150;
/// A missing `update-end` never leaves the line up for good.
const UPDATE_GIVE_UP_MS = 10_000;

/// Creates a deferred-intent Elements group and mounts the Payment Element in `host`.
///
/// The one path for every mount, first or again (a language switch, the card panel however it was
/// opened): `onStatus` hears `loading` at once and then `ready` or `failed`, from listeners attached
/// before the element is mounted, so no early event is missed.
export async function mountPayment(options: {
  publishableKey: string;
  lang: Lang;
  kind: ElementsKind;
  amount: number;
  currency: string;
  host: HTMLElement;
  onStatus: (status: CardFormStatus) => void;
}): Promise<MountedPayment> {
  options.onStatus("loading");
  const stripe = await stripeFor(options.publishableKey, options.lang);
  const elements = stripe.elements({
    ...(elementsOptions(options.kind, options.amount, options.currency) as StripeElementsOptionsMode),
    locale: options.lang,
    appearance: APPEARANCE,
    fonts: FONTS,
    // Stripe's ready event can come before the fields are drawn; its own skeleton keeps the
    // reserved area from looking blank in between.
    loader: "always",
  });
  const element = elements.create("payment", PAYMENT_ELEMENT_OPTIONS);
  const mounted: MountedPayment = { stripe, elements, element, onStatus: options.onStatus, pendingUpdate: null };
  element.on("ready", () => mounted.onStatus("ready"));
  element.on("loaderror", () => mounted.onStatus("failed"));
  elements.on("update-end", () => finishUpdate(mounted));
  element.mount(options.host);
  return mounted;
}

/// Switches the group to another plan's mode and amount without remounting, so typed card details
/// stay. The form reads as loading only if Stripe has not finished redrawing within 150 ms.
export function updatePayment(mounted: MountedPayment, kind: ElementsKind, amount: number, currency: string): void {
  // A second change can arrive while the first one's loading line is already up. The line then
  // belongs to this update too: without carrying it over, an update that finishes inside the
  // delay would end with nothing to turn the line off.
  const alreadyShown = mounted.pendingUpdate?.shown === true;
  clearPendingUpdate(mounted);
  const pending: NonNullable<MountedPayment["pendingUpdate"]> = { timer: null, shown: alreadyShown, fallback: null };
  if (!alreadyShown) {
    pending.timer = setTimeout(() => {
      pending.timer = null;
      pending.shown = true;
      mounted.onStatus("loading");
    }, UPDATE_LOADING_DELAY_MS);
  }
  pending.fallback = setTimeout(() => finishUpdate(mounted), UPDATE_GIVE_UP_MS);
  mounted.pendingUpdate = pending;
  const { paymentMethodCreation: _ignored, ...options } = elementsOptions(kind, amount, currency);
  mounted.elements.update(options as Parameters<StripeElements["update"]>[0]);
}

function finishUpdate(mounted: MountedPayment): void {
  const pending = mounted.pendingUpdate;
  if (!pending) return;
  clearPendingUpdate(mounted);
  if (pending.shown) mounted.onStatus("ready");
}

function clearPendingUpdate(mounted: MountedPayment): void {
  const pending = mounted.pendingUpdate;
  if (!pending) return;
  if (pending.timer) clearTimeout(pending.timer);
  if (pending.fallback) clearTimeout(pending.fallback);
  mounted.pendingUpdate = null;
}

/// Removes the element and anything still waiting on it.
export function destroyPayment(mounted: MountedPayment): void {
  clearPendingUpdate(mounted);
  mounted.element.destroy();
}
