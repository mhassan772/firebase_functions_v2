import { androidpublisher_v3, google } from "googleapis";
import {
  GOOGLE_PACKAGE_NAME,
  GOOGLE_SUBSCRIPTION_BASE_PLANS,
  GOOGLE_SUBSCRIPTION_PRODUCTS,
} from "../../config/constants";
import {
  GoogleOwnershipIdentity,
  VerifiedSubscription,
} from "../../types/subscriptions";
import {
  sha256Reference,
  timingSafeEqualText,
} from "./crypto";
import { SubscriptionError } from "./errors";
import { normalizeGoogleSubscription } from "./normalization";

const ANDROID_PUBLISHER_SCOPE =
  "https://www.googleapis.com/auth/androidpublisher";
const MAX_PURCHASE_TOKEN_LENGTH = 4096;
const MAX_LINKED_TOKEN_DEPTH = 20;

interface GoogleTokenStatus {
  token: string;
  data: androidpublisher_v3.Schema$SubscriptionPurchaseV2;
}

let publisherClient: androidpublisher_v3.Androidpublisher | undefined;

export async function verifyGoogleSubscription(
  purchaseToken: string,
  expectedAccountBinding?: string,
  eventAt?: Date
): Promise<VerifiedSubscription> {
  validatePurchaseToken(purchaseToken);

  try {
    const statuses: GoogleTokenStatus[] = [];
    const seen = new Set<string>();
    let token: string | undefined = purchaseToken;
    let unqueriedLinkedToken: string | undefined;

    while (token) {
      if (seen.has(token) || statuses.length >= MAX_LINKED_TOKEN_DEPTH) {
        throw invalidStoreData("google-linked-token-chain-invalid");
      }
      seen.add(token);

      try {
        const response: {
          data: androidpublisher_v3.Schema$SubscriptionPurchaseV2;
        } = await getPublisherClient().purchases.subscriptionsv2.get({
          packageName: GOOGLE_PACKAGE_NAME,
          token,
        });
        validateGooglePurchase(response.data, expectedAccountBinding);
        statuses.push({ token, data: response.data });
        token = response.data.linkedPurchaseToken ?? undefined;
      } catch (error) {
        if (statuses.length > 0 && isGoneResponse(error)) {
          unqueriedLinkedToken = token;
          break;
        }
        throw error;
      }
    }

    const current = statuses[0];
    if (!current) {
      throw invalidStoreData("google-subscription-not-found");
    }
    const environment = current.data.testPurchase
      ? "test" as const
      : "production" as const;
    if (
      statuses.some(
        (status) => Boolean(status.data.testPurchase) !==
          Boolean(current.data.testPurchase)
      )
    ) {
      throw invalidStoreData("google-linked-token-environment-mismatch");
    }
    const lineItems = current.data.lineItems ?? [];
    const productId = lineItems[0]?.productId!;
    const expiryTime = latestExpiry(lineItems);
    const autoRenewing = lineItems.every(
      (item) => item.autoRenewingPlan?.autoRenewEnabled === true
    );
    const normalized = normalizeGoogleSubscription({
      productId,
      environment,
      purchaseReference: sha256Reference(current.token),
      expiryTime,
      subscriptionState: current.data.subscriptionState,
      autoRenewing,
      eventAt,
    });
    if (normalized.status === "unknown") {
      throw invalidStoreData("google-subscription-state-unknown");
    }

    const ownership: GoogleOwnershipIdentity[] = statuses.map(
      (status): GoogleOwnershipIdentity => ({
        platform: "google",
        environment,
        purchaseToken: status.token,
        linkedPurchaseToken:
          status.data.linkedPurchaseToken ?? undefined,
        currentPurchaseToken: current.token,
      })
    );
    if (unqueriedLinkedToken) {
      ownership.push({
        platform: "google",
        environment,
        purchaseToken: unqueriedLinkedToken,
        currentPurchaseToken: current.token,
      });
    }

    return { subscription: normalized, ownership };
  } catch (error) {
    throw mapGoogleError(error);
  }
}

function getPublisherClient(): androidpublisher_v3.Androidpublisher {
  if (!publisherClient) {
    const auth = new google.auth.GoogleAuth({
      scopes: [ANDROID_PUBLISHER_SCOPE],
    });
    publisherClient = google.androidpublisher({ version: "v3", auth });
  }
  return publisherClient;
}

export function validateGooglePurchase(
  purchase: androidpublisher_v3.Schema$SubscriptionPurchaseV2,
  expectedAccountBinding?: string
): void {
  const lineItems = purchase.lineItems ?? [];
  if (lineItems.length === 0) {
    throw invalidStoreData("google-line-items-missing");
  }
  for (const lineItem of lineItems) {
    const productId = lineItem.productId;
    if (
      !productId ||
      !GOOGLE_SUBSCRIPTION_PRODUCTS.includes(
        productId as (typeof GOOGLE_SUBSCRIPTION_PRODUCTS)[number]
      )
    ) {
      throw invalidStoreData("google-product-not-allowed");
    }
    if (!lineItem.autoRenewingPlan || lineItem.prepaidPlan) {
      throw invalidStoreData("google-product-not-recurring");
    }
    const basePlanId = lineItem.offerDetails?.basePlanId;
    if (
      !basePlanId ||
      !GOOGLE_SUBSCRIPTION_BASE_PLANS.includes(
        basePlanId as (typeof GOOGLE_SUBSCRIPTION_BASE_PLANS)[number]
      )
    ) {
      throw invalidStoreData("google-base-plan-not-allowed");
    }
    if (!lineItem.expiryTime || !Number.isFinite(
      new Date(lineItem.expiryTime).getTime()
    )) {
      throw invalidStoreData("google-expiration-invalid");
    }
  }

  const actualBinding =
    purchase.externalAccountIdentifiers?.obfuscatedExternalAccountId;
  if (
    actualBinding &&
    expectedAccountBinding &&
    !timingSafeEqualText(actualBinding, expectedAccountBinding)
  ) {
    throw new SubscriptionError(
      "account-binding-mismatch",
      "google-account-binding-mismatch",
      "The Google account binding does not match."
    );
  }
}

function latestExpiry(
  lineItems: androidpublisher_v3.Schema$SubscriptionPurchaseLineItem[]
): string {
  return [...lineItems].sort(
    (left, right) =>
      new Date(right.expiryTime!).getTime() -
      new Date(left.expiryTime!).getTime()
  )[0].expiryTime!;
}

function validatePurchaseToken(token: string): void {
  if (
    typeof token !== "string" ||
    token.length < 10 ||
    token.length > MAX_PURCHASE_TOKEN_LENGTH ||
    /\s/.test(token)
  ) {
    throw new SubscriptionError(
      "invalid-input",
      "google-purchase-token-invalid",
      "The Google purchase token is invalid."
    );
  }
}

function invalidStoreData(code: string): SubscriptionError {
  return new SubscriptionError(
    "invalid-store-data",
    code,
    "Google Play store data failed validation."
  );
}

function isGoneResponse(error: unknown): boolean {
  return getHttpStatus(error) === 410;
}

function mapGoogleError(error: unknown): SubscriptionError {
  if (error instanceof SubscriptionError) {
    return error;
  }
  const status = getHttpStatus(error);
  if (status === 429 || (status !== undefined && status >= 500)) {
    return new SubscriptionError(
      "store-unavailable",
      "google-api-unavailable",
      "The Google Play API is temporarily unavailable.",
      true
    );
  }
  if (status === 401 || status === 403) {
    return new SubscriptionError(
      "configuration",
      "google-api-permission-denied",
      "Google Play API access is not configured."
    );
  }
  return invalidStoreData("google-api-rejected");
}

function getHttpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const value = error as {
    code?: unknown;
    response?: { status?: unknown };
  };
  const status = value.response?.status ?? value.code;
  return typeof status === "number" ? status : undefined;
}
