import { admin } from "../../config/admin";
import { STRIPE_WEB_SECRETS } from "../../config/constants";
import { StripeGateway, stripeGatewayFromEnv } from "../../services/webSubscriptions/stripeGateway";
import { WebSyncDeps } from "../../services/webSubscriptions/sync";
import { WebCallableDeps } from "../../handlers/webCallableCommon";
import { firestoreStoreCountry } from "../../services/storeCountry";
import { firestoreWebPurchaseThrottle } from "../../services/webSubscriptions/purchaseThrottle";

/** The live Firestore and Stripe for web subscriptions, or undefined when no Stripe key is set. */
export function webSyncDepsFromEnv(): WebSyncDeps | undefined {
  const gateway = stripeGatewayFromEnv();
  return gateway ? { firestore: admin.firestore(), gateway } : undefined;
}

/** The live gateway, read when first needed so a function without the secret still loads. */
export function webGatewayFromEnv(): StripeGateway | undefined {
  return stripeGatewayFromEnv();
}

export function webhookSecretFromEnv(): string | undefined {
  return process.env[STRIPE_WEB_SECRETS.webhookSecret]?.trim() || undefined;
}

let callableDeps: Omit<WebCallableDeps, "gateway" | "publishableKey"> | undefined;

/**
 * The live dependencies of the purchase callables. The Firestore-backed parts are made once per
 * instance; the gateway and the publishable key are read on every call, so a function deployed
 * before its secrets existed starts working once they do.
 */
export function webCallableDeps(): WebCallableDeps {
  callableDeps ??= {
    firestore: admin.firestore(),
    storeCountry: firestoreStoreCountry(() => admin.firestore()),
    throttle: firestoreWebPurchaseThrottle(() => admin.firestore()),
    now: () => new Date(),
  };
  return {
    ...callableDeps,
    gateway: stripeGatewayFromEnv(),
    publishableKey: process.env[STRIPE_WEB_SECRETS.publishableKey]?.trim() || undefined,
  };
}
