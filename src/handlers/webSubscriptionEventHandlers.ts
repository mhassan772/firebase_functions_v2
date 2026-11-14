import * as crypto from "crypto";
import { Firestore } from "firebase-admin/firestore";
import * as functions from "firebase-functions";
import type Stripe from "stripe";
import { safeErrorCode } from "../services/subscriptions/errors";
import { resolveCustomerUid } from "../services/webSubscriptions/customers";
import {
  claimWebEvent,
  isHandledWebEventType,
  recordWebEventOutcome,
  releaseWebEvent,
  WebEventRef,
  webEventRef,
  WebEventSource,
} from "../services/webSubscriptions/events";
import { stripeErrorCode, StripeGateway } from "../services/webSubscriptions/stripeGateway";
import { syncWebEntitlement, WebSyncDeps, WebSyncResult } from "../services/webSubscriptions/sync";

export interface WebEventDeps extends WebSyncDeps {
  /** Replaced in tests to count or fail syncs. */
  sync?: (uid: string, deps: WebSyncDeps, options: { operationId?: string; trigger?: string }) => Promise<WebSyncResult>;
}

export type WebEventOutcome = "synced" | "duplicate" | "ignored" | "livemode_mismatch";

/** The customer an event is about: its own field, or for a refund or dispute, its charge's. */
async function eventCustomer(gateway: StripeGateway, event: WebEventRef): Promise<string | undefined> {
  if (event.type.startsWith("refund.") || event.type.startsWith("charge.dispute.")) {
    if (!event.object.charge) return undefined;
    const charge = await gateway.retrieveCharge(event.object.charge);
    return typeof charge.customer === "string" ? charge.customer : charge.customer?.id;
  }
  return event.object.customer;
}

/**
 * Handles one Stripe event, from the webhook or the reconcile run.
 *
 * The event is only a trigger: it names a customer, and the account behind that customer is
 * synced from what Stripe holds now. Claimed first with `create()`, so a replay is a no-op. A
 * failure releases the claim and rethrows, so Stripe's retry or the next run handles it again.
 */
export async function handleWebEvent(
  event: WebEventRef,
  source: WebEventSource,
  deps: WebEventDeps,
  operationId: string = crypto.randomUUID()
): Promise<WebEventOutcome> {
  const fields = { operationId, eventId: event.id, type: event.type, source };
  if (event.livemode !== deps.gateway.livemode) {
    functions.logger.warn("web_event_livemode_mismatch", { ...fields, eventLivemode: event.livemode });
    return "livemode_mismatch";
  }
  if (!isHandledWebEventType(event.type)) {
    functions.logger.info("web_event_outcome", { ...fields, outcome: "ignored", reason: "type" });
    return "ignored";
  }
  const now = deps.now?.() ?? new Date();
  if (!(await claimWebEvent(deps.firestore, event, source, now))) {
    functions.logger.info("web_event_outcome", { ...fields, outcome: "duplicate" });
    return "duplicate";
  }
  try {
    const customerId = await eventCustomer(deps.gateway, event);
    const uid = await resolveCustomerUid(deps.firestore, deps.gateway, customerId);
    if (!uid) {
      await recordWebEventOutcome(deps.firestore, event.id, "ignored");
      functions.logger.info("web_event_outcome", { ...fields, outcome: "ignored", reason: "no_uid", customerId: customerId ?? null });
      return "ignored";
    }
    const result = await (deps.sync ?? syncWebEntitlement)(uid, deps, { operationId, trigger: event.type });
    await recordWebEventOutcome(deps.firestore, event.id, `synced_${result.outcome}`);
    functions.logger.info("web_event_outcome", { ...fields, outcome: "synced", uid, sync: result.outcome });
    return "synced";
  } catch (error) {
    functions.logger.error("web_event_failure", {
      ...fields,
      code: stripeErrorCode(error) ?? safeErrorCode(error),
      errorName: error instanceof Error ? error.name : typeof error,
    });
    try {
      await releaseWebEvent(deps.firestore, event.id);
    } catch (releaseError) {
      // The claim then outlives the failure, and only the event's next delivery is lost;
      // later events for the account sync it again.
      functions.logger.error("web_event_release_failure", { ...fields, code: safeErrorCode(releaseError) });
    }
    throw error;
  }
}

export interface StripeWebhookRequest {
  method: string;
  rawBody?: Buffer;
  header(name: string): string | undefined;
}

export interface StripeWebhookDeps {
  firestore: Firestore;
  /** Undefined when the secret key is not configured. */
  gateway: StripeGateway | undefined;
  webhookSecret: string | undefined;
  now?: () => Date;
  sync?: WebEventDeps["sync"];
}

export interface StripeWebhookResponse {
  status: number;
  body: Record<string, unknown>;
}

/**
 * The `stripeWebEvents` endpoint: verify the signature over the raw body, then handle the event.
 *
 * A bad signature is 400, which Stripe does not count as delivered; a handling failure is 500,
 * which Stripe retries for three days. Everything else, an ignored or replayed event included,
 * is 200.
 */
export async function handleStripeWebhook(
  request: StripeWebhookRequest,
  deps: StripeWebhookDeps
): Promise<StripeWebhookResponse> {
  const operationId = crypto.randomUUID();
  if (request.method !== "POST") return { status: 405, body: { error: "method_not_allowed" } };
  if (!deps.gateway || !deps.webhookSecret) {
    functions.logger.error("web_webhook_not_configured", { operationId });
    return { status: 500, body: { error: "not_configured" } };
  }
  const signature = request.header("stripe-signature");
  let event: Stripe.Event;
  try {
    if (!request.rawBody || !signature) throw new Error("missing body or signature");
    event = deps.gateway.constructEvent(request.rawBody, signature, deps.webhookSecret);
  } catch {
    functions.logger.warn("web_webhook_signature_invalid", { operationId });
    return { status: 400, body: { error: "invalid_signature" } };
  }
  try {
    const outcome = await handleWebEvent(
      webEventRef(event),
      "webhook",
      { firestore: deps.firestore, gateway: deps.gateway, now: deps.now, sync: deps.sync },
      operationId
    );
    return { status: 200, body: { received: true, outcome } };
  } catch {
    return { status: 500, body: { error: "handling_failed" } };
  }
}
