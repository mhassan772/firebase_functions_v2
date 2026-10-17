import { OwnershipIdentity } from "../../types/subscriptions";
import { sha256Reference } from "./crypto";

export const SUBSCRIPTION_OWNERSHIP_COLLECTION =
  "subscription_purchase_ownership";

/** One record per Play token or Apple environment and original transaction; never the raw value. */
export function ownershipDocumentId(identity: OwnershipIdentity): string {
  if (identity.platform === "apple") {
    return `apple_${sha256Reference(
      `${identity.environment}:${identity.originalTransactionId}`
    )}`;
  }
  return googleOwnershipDocumentId(identity.purchaseToken);
}

export function googleOwnershipDocumentId(purchaseToken: string): string {
  return `google_${sha256Reference(purchaseToken)}`;
}
