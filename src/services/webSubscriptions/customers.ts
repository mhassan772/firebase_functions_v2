import { DocumentData, Firestore, Timestamp } from "firebase-admin/firestore";
import * as functions from "firebase-functions";
import type Stripe from "stripe";
import { refusal } from "../../utils/callableAuth";
import { DELETED_ACCOUNTS_COLLECTION } from "../accountDeletion/tombstone";
import { idOf, StripeGateway } from "./stripeGateway";

/**
 * `web_customers/{uid}`: the account's Stripe customer in each mode.
 *
 * It is the ownership record for web purchases. The Stripe customer carries `metadata.uid`, and
 * a Stripe object is acted on only when that uid's document names that same customer, so a
 * customer edited in the Dashboard, or made by anything but this backend, never grants access.
 * Server-only: the rules catch-all denies clients.
 */
export const WEB_CUSTOMERS_COLLECTION = "web_customers";

export interface CustomerMapping {
  testCustomerId?: string;
  liveCustomerId?: string;
}

export type MappingField = "liveCustomerId" | "testCustomerId";

export function mappingField(livemode: boolean): MappingField {
  return livemode ? "liveCustomerId" : "testCustomerId";
}

export function mappingFromData(data: DocumentData | undefined): CustomerMapping | undefined {
  if (!data) return undefined;
  const mapping: CustomerMapping = {};
  if (typeof data.testCustomerId === "string" && data.testCustomerId) mapping.testCustomerId = data.testCustomerId;
  if (typeof data.liveCustomerId === "string" && data.liveCustomerId) mapping.liveCustomerId = data.liveCustomerId;
  return mapping;
}

/** The customer for the gateway's mode, when the mapping has one. */
export function customerIdFor(mapping: CustomerMapping | undefined, livemode: boolean): string | undefined {
  return mapping?.[mappingField(livemode)];
}

export async function readCustomerMapping(db: Firestore, uid: string): Promise<CustomerMapping | undefined> {
  const snapshot = await db.collection(WEB_CUSTOMERS_COLLECTION).doc(uid).get();
  return snapshot.exists ? mappingFromData(snapshot.data()) : undefined;
}

export function customerIdempotencyKey(uid: string): string {
  return `customer_${uid}`;
}

export interface EnsureCustomerDeps {
  firestore: Firestore;
  gateway: StripeGateway;
  now?: () => Date;
}

/**
 * The account's customer in the gateway's mode, created with `metadata.uid` and mapped on first use.
 *
 * Created under the idempotency key `customer_<uid>`, so two first purchases at once get the
 * same customer from Stripe. When the mapping already names another customer (a call outside
 * Stripe's 24 h idempotency window lost the race), the stored one wins and is returned.
 *
 * A deleted account (its tombstone exists) is refused `account_deleted`, before Stripe and
 * again inside the write, so nothing recreates `web_customers/{uid}` after the purge removed it.
 */
export async function ensureCustomer(
  uid: string,
  deps: EnsureCustomerDeps,
  params: Omit<Stripe.CustomerCreateParams, "metadata"> = {}
): Promise<string> {
  const field = mappingField(deps.gateway.livemode);
  const ref = deps.firestore.collection(WEB_CUSTOMERS_COLLECTION).doc(uid);
  const tombstoneRef = deps.firestore.collection(DELETED_ACCOUNTS_COLLECTION).doc(uid);
  const [mappingSnap, tombstoneSnap] = await deps.firestore.getAll(ref, tombstoneRef);
  if (tombstoneSnap.exists) throw accountDeleted();
  const existing = customerIdFor(mappingFromData(mappingSnap.data()), deps.gateway.livemode);
  if (existing) return existing;

  const customer = await deps.gateway.createCustomer(
    { ...params, metadata: { uid } },
    customerIdempotencyKey(uid)
  );
  const now = Timestamp.fromDate(deps.now?.() ?? new Date());
  const stored = await deps.firestore.runTransaction(async (transaction) => {
    const [snapshot, tombstone] = await transaction.getAll(ref, tombstoneRef);
    // Deleted while the customer was being made: the mapping is never written back. The
    // customer itself carries no access and the next purge or a person removes it.
    if (tombstone.exists) throw accountDeleted();
    const current = customerIdFor(mappingFromData(snapshot.data()), deps.gateway.livemode);
    if (current) return current;
    if (snapshot.exists) {
      transaction.update(ref, { [field]: customer.id, updatedAt: now });
    } else {
      transaction.set(ref, { [field]: customer.id, createdAt: now, updatedAt: now });
    }
    return customer.id;
  });
  functions.logger.info("web_customer_mapped", {
    uid,
    customerId: stored,
    livemode: deps.gateway.livemode,
    created: stored === customer.id,
  });
  return stored;
}

/**
 * The uid a Stripe customer belongs to, or undefined when it belongs to nobody we know.
 *
 * The customer's own `metadata.uid` names the account, and that account's mapping must name this
 * customer for the gateway's mode. A deleted customer has no metadata and resolves to nobody.
 */
export async function resolveCustomerUid(
  db: Firestore,
  gateway: StripeGateway,
  customer: string | { id: string } | null | undefined
): Promise<string | undefined> {
  const customerId = idOf(customer);
  if (!customerId) return undefined;
  const retrieved = await gateway.retrieveCustomer(customerId);
  if ("deleted" in retrieved && retrieved.deleted) return undefined;
  const uid = (retrieved as { metadata?: Record<string, string> }).metadata?.uid;
  if (typeof uid !== "string" || !uid || uid.includes("/")) return undefined;
  const mapping = await readCustomerMapping(db, uid);
  return customerIdFor(mapping, gateway.livemode) === customerId ? uid : undefined;
}

export function accountDeleted() {
  return refusal("permission-denied", "This account was deleted.", "account_deleted");
}
