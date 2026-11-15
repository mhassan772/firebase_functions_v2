/// Stripe.js for `/subscribe` and `/manage`, loaded only when one of them needs it.
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
}

/// A container for the Payment Element; Arabic needs `dir="rtl"` on an ancestor, since the
/// locale alone does not turn the fields around.
export function paymentHost(id: string, lang: Lang): HTMLElement {
  return h("div", { id, class: "payment-host", dir: lang === "ar" ? "rtl" : "ltr" });
}

/// Creates a deferred-intent Elements group and mounts the Payment Element in `host`.
export async function mountPayment(options: {
  publishableKey: string;
  lang: Lang;
  kind: ElementsKind;
  amount: number;
  currency: string;
  host: HTMLElement;
}): Promise<MountedPayment> {
  const stripe = await stripeFor(options.publishableKey, options.lang);
  const elements = stripe.elements({
    ...(elementsOptions(options.kind, options.amount, options.currency) as StripeElementsOptionsMode),
    locale: options.lang,
    appearance: APPEARANCE,
    fonts: FONTS,
  });
  const element = elements.create("payment", PAYMENT_ELEMENT_OPTIONS);
  element.mount(options.host);
  return { stripe, elements, element };
}

/// Switches the group to another plan's mode and amount without remounting, so typed card details stay.
export function updatePayment(mounted: MountedPayment, kind: ElementsKind, amount: number, currency: string): void {
  const { paymentMethodCreation: _ignored, ...options } = elementsOptions(kind, amount, currency);
  mounted.elements.update(options as Parameters<StripeElements["update"]>[0]);
}
