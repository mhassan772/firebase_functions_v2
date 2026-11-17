/// The web purchase callables, typed as the backend answers them (docs/web_subscriptions.md).

import type { FirebaseApp } from "firebase/app";
import { connectFunctionsEmulator, getFunctions, httpsCallable, type Functions } from "firebase/functions";

import { emulatorSettings, hostAndPort } from "../firebaseConfig";
import type { Lang } from "../i18n";
import type { FinishResult, LifetimeResult, ManageResult, Plan, PlansResponse, StartResult, SubscriptionResponse, SwitchResult } from "./logic";

const FUNCTIONS_REGION = "europe-west2";
/// A little over the purchase callable's own 120 s, so the server always answers first.
const PURCHASE_TIMEOUT_MS = 130 * 1000;

let functions: Functions | null = null;

function functionsFor(app: FirebaseApp): Functions {
  if (!functions) {
    functions = getFunctions(app, FUNCTIONS_REGION);
    if (import.meta.env.DEV) {
      const emulator = emulatorSettings()?.functions;
      if (emulator) {
        const { host, port } = hostAndPort(emulator);
        connectFunctionsEmulator(functions, host, port);
      }
    }
  }
  return functions;
}

async function call<Request, Response>(app: FirebaseApp, name: string, data: Request, timeout?: number): Promise<Response> {
  const callable = httpsCallable<Request, Response>(functionsFor(app), name, timeout ? { timeout } : undefined);
  return (await callable(data)).data;
}

export function getWebPlans(app: FirebaseApp, lang: Lang): Promise<PlansResponse> {
  return call(app, "getWebPlans", { lang });
}

export function startWebPurchase(
  app: FirebaseApp,
  request: { plan: Plan; confirmationToken: string; acceptedTotal: number; billingState?: string; lang: Lang; acknowledgeExisting?: true },
): Promise<StartResult> {
  return call(app, "startWebPurchase", request, PURCHASE_TIMEOUT_MS);
}

export function finishWebPurchase(app: FirebaseApp, purchaseId: string): Promise<FinishResult> {
  return call(app, "finishWebPurchase", { purchaseId }, PURCHASE_TIMEOUT_MS);
}

export function getWebSubscription(app: FirebaseApp): Promise<SubscriptionResponse> {
  return call(app, "getWebSubscription", {});
}

export function manageWebSubscription(app: FirebaseApp, request: { action: "cancel" | "resume" }): Promise<{ status: "succeeded" }>;
export function manageWebSubscription(app: FirebaseApp, request: { action: "authenticate" }): Promise<{ clientSecret: string; purchaseId?: string }>;
export function manageWebSubscription(
  app: FirebaseApp,
  request: { action: "replace_card"; confirmationToken: string; acceptedRenewalAmount?: number } | { action: "finish_replace_card"; setupIntentId: string },
): Promise<ManageResult>;
export function manageWebSubscription(
  app: FirebaseApp,
  request:
    | { action: "quote_switch_yearly" }
    | { action: "switch_yearly"; acceptedTotal: number; attemptId: string; lang: Lang }
    | { action: "finish_switch_yearly"; purchaseId: string },
): Promise<SwitchResult>;
export function manageWebSubscription(
  app: FirebaseApp,
  request:
    | { action: "quote_lifetime"; billingState?: string }
    | { action: "buy_lifetime"; acceptedTotal: number; attemptId: string; lang: Lang; billingState?: string }
    | { action: "finish_lifetime"; purchaseId: string },
): Promise<LifetimeResult>;
export function manageWebSubscription(app: FirebaseApp, request: { action: string }): Promise<unknown> {
  return call(app, "manageWebSubscription", request, PURCHASE_TIMEOUT_MS);
}
