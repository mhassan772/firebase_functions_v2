import { Firestore } from "firebase-admin/firestore";
import * as functions from "firebase-functions";
import { SubscriptionError } from "../subscriptions/errors";
import { customerIdFor, readCustomerMapping } from "./customers";
import { isResourceMissing, StripeGateway } from "./stripeGateway";

/**
 * Ends an account's web subscriptions by deleting its Stripe customer, which cancels them.
 *
 * No mapping means the account never bought on the web, and nothing is asked of Stripe, so the
 * purge needs no key for it. A mapping with no key configured is an error: the purge step fails
 * and keeps the mapping for the next run rather than leave a subscription charging. A customer
 * already deleted is not an error. A customer only in the other mode is left alone, since this
 * key cannot reach it.
 */
export async function deleteWebCustomer(
  uid: string,
  deps: { firestore: Firestore; gateway: () => StripeGateway | undefined }
): Promise<void> {
  const mapping = await readCustomerMapping(deps.firestore, uid);
  if (!mapping) return;
  const gateway = deps.gateway();
  if (!gateway) {
    throw new SubscriptionError("configuration", "stripe-key-missing", "The Stripe key is needed to delete a web customer.");
  }
  const customerId = customerIdFor(mapping, gateway.livemode);
  if (!customerId) {
    functions.logger.warn("web_customer_delete_other_mode", { uid, livemode: gateway.livemode });
    return;
  }
  try {
    await gateway.deleteCustomer(customerId);
    functions.logger.info("web_customer_deleted", { uid, customerId, livemode: gateway.livemode });
  } catch (error) {
    if (!isResourceMissing(error)) throw error;
    functions.logger.info("web_customer_deleted", { uid, customerId, livemode: gateway.livemode, alreadyGone: true });
  }
}
