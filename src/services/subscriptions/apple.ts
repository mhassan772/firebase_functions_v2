import * as fs from "fs";
import * as path from "path";
import {
  APIException,
  AppStoreServerAPIClient,
  AutoRenewStatus,
  Environment,
  JWSRenewalInfoDecodedPayload,
  JWSTransactionDecodedPayload,
  ResponseBodyV2DecodedPayload,
  SignedDataVerifier,
  Status,
  Type,
} from "@apple/app-store-server-library";
import {
  APPLE_APP_ID,
  APPLE_BUNDLE_ID,
  APPLE_SUBSCRIPTION_PRODUCTS,
  SUBSCRIPTION_SECRETS,
} from "../../config/constants";
import {
  StoreEvent,
  VerifiedSubscription,
} from "../../types/subscriptions";
import { timingSafeEqualText } from "./crypto";
import { SubscriptionError } from "./errors";
import { normalizeAppleSubscription } from "./normalization";
import { requireRuntimeSecret } from "./runtimeSecrets";

const ROOT_CERTIFICATE_FILES = [
  "certs/apple/apple-inc-root.pem",
  "certs/apple/apple-root-ca-g2.pem",
  "certs/apple/apple-root-ca-g3.pem",
];
const MAX_SIGNED_PAYLOAD_LENGTH = 1_500_000;

interface VerifiedAppleStatus {
  status: Status | number;
  transaction: JWSTransactionDecodedPayload;
  renewal: JWSRenewalInfoDecodedPayload;
}

export interface VerifiedAppleNotification {
  decoded: ResponseBodyV2DecodedPayload;
  verified: VerifiedSubscription;
  event: StoreEvent;
}

export async function verifyAppleSubscription(
  signedTransaction: string,
  expectedAccountBinding?: string,
  notificationEventAt?: Date
): Promise<VerifiedSubscription> {
  assertSignedPayload(signedTransaction);
  const environment = claimedAppleEnvironment(signedTransaction);

  try {
    const verifier = createVerifier(environment);
    const submitted = await verifier.verifyAndDecodeTransaction(
      signedTransaction
    );
    validateAppleTransaction(submitted, environment);
    validateAccountBinding(submitted.appAccountToken, expectedAccountBinding);

    const transactionId = requiredString(
      submitted.transactionId,
      "apple-transaction-id-missing"
    );
    const originalTransactionId = requiredString(
      submitted.originalTransactionId,
      "apple-original-transaction-id-missing"
    );
    const response = await createApiClient(
      environment
    ).getAllSubscriptionStatuses(transactionId);

    if (
      response.bundleId !== APPLE_BUNDLE_ID ||
      response.environment !== environment ||
      (environment === Environment.PRODUCTION &&
        response.appAppleId !== APPLE_APP_ID)
    ) {
      throw invalidStoreData("apple-status-identity-mismatch");
    }

    const statuses: VerifiedAppleStatus[] = [];
    for (const group of response.data ?? []) {
      for (const item of group.lastTransactions ?? []) {
        if (
          item.originalTransactionId !== originalTransactionId ||
          item.status === undefined ||
          !item.signedTransactionInfo ||
          !item.signedRenewalInfo
        ) {
          continue;
        }
        if (!Object.values(Status).includes(item.status)) {
          throw invalidStoreData("apple-status-unknown");
        }

        const transaction = await verifier.verifyAndDecodeTransaction(
          item.signedTransactionInfo
        );
        const renewal = await verifier.verifyAndDecodeRenewalInfo(
          item.signedRenewalInfo
        );
        validateAppleTransaction(transaction, environment);
        validateRenewal(renewal, environment, originalTransactionId);
        validateAccountBinding(
          transaction.appAccountToken ?? renewal.appAccountToken,
          expectedAccountBinding
        );
        statuses.push({ status: item.status, transaction, renewal });
      }
    }

    const selected = selectCurrentStatus(statuses);
    if (!selected) {
      throw invalidStoreData("apple-status-not-found");
    }

    const productId = requiredString(
      selected.transaction.productId,
      "apple-product-missing"
    );
    const expiresAtMs = requiredDateNumber(
      selected.transaction.expiresDate,
      "apple-expiration-missing"
    );
    if (
      selected.renewal.gracePeriodExpiresDate !== undefined &&
      !Number.isFinite(
        new Date(selected.renewal.gracePeriodExpiresDate).getTime()
      )
    ) {
      throw invalidStoreData("apple-grace-expiration-invalid");
    }
    const normalized = normalizeAppleSubscription({
      productId,
      environment: toStoreEnvironment(environment),
      originalTransactionId,
      expiresAtMs,
      gracePeriodExpiresAtMs: selected.renewal.gracePeriodExpiresDate,
      signedAtMs: Math.max(
        selected.transaction.signedDate ?? 0,
        selected.renewal.signedDate ?? 0
      ),
      revocationAtMs: selected.transaction.revocationDate,
      storeStatus: selected.status,
      autoRenewing:
        selected.renewal.autoRenewStatus === undefined
          ? undefined
          : selected.renewal.autoRenewStatus === AutoRenewStatus.ON,
    });

    if (normalized.status === "unknown") {
      throw invalidStoreData("apple-status-unknown");
    }
    if (
      notificationEventAt &&
      notificationEventAt.getTime() > normalized.lastStoreEventAt.getTime()
    ) {
      normalized.lastStoreEventAt = notificationEventAt;
    }

    return {
      subscription: normalized,
      ownership: [
        {
          platform: "apple",
          environment: toStoreEnvironment(environment),
          originalTransactionId,
        },
      ],
    };
  } catch (error) {
    throw mapAppleError(error);
  }
}

export async function verifyAppleNotification(
  signedPayload: string
): Promise<VerifiedAppleNotification | {
  decoded: ResponseBodyV2DecodedPayload;
  event: StoreEvent;
}> {
  assertSignedPayload(signedPayload);
  const environment = claimedAppleEnvironment(signedPayload);

  try {
    const verifier = createVerifier(environment);
    const decoded = await verifier.verifyAndDecodeNotification(signedPayload);
    const notificationUuid = requiredString(
      decoded.notificationUUID,
      "apple-notification-id-missing"
    );
    const eventAt = new Date(decoded.signedDate ?? Date.now());
    if (!Number.isFinite(eventAt.getTime())) {
      throw invalidStoreData("apple-notification-date-invalid");
    }

    if (
      decoded.data?.bundleId !== undefined &&
      decoded.data.bundleId !== APPLE_BUNDLE_ID
    ) {
      throw invalidStoreData("apple-notification-bundle-mismatch");
    }
    if (
      decoded.data?.appAppleId !== undefined &&
      decoded.data.appAppleId !== APPLE_APP_ID
    ) {
      throw invalidStoreData("apple-notification-app-id-mismatch");
    }
    if (
      decoded.data?.environment !== undefined &&
      decoded.data.environment !== environment
    ) {
      throw invalidStoreData("apple-notification-environment-mismatch");
    }

    const event: StoreEvent = {
      key: notificationUuid,
      platform: "apple",
      environment: toStoreEnvironment(environment),
      eventType: decoded.notificationType ?? "UNKNOWN",
      eventAt,
    };
    const transactionInfo = decoded.data?.signedTransactionInfo;
    if (!transactionInfo) {
      return { decoded, event };
    }

    const transaction = await verifier.verifyAndDecodeTransaction(
      transactionInfo
    );
    validateAppleTransaction(transaction, environment);
    const verified = await verifyAppleSubscription(
      transactionInfo,
      undefined,
      eventAt
    );
    return { decoded, verified, event };
  } catch (error) {
    throw mapAppleError(error);
  }
}

function selectCurrentStatus(
  statuses: VerifiedAppleStatus[]
): VerifiedAppleStatus | undefined {
  return [...statuses].sort((left, right) => {
    const leftActive = left.status === Status.ACTIVE ||
      left.status === Status.BILLING_GRACE_PERIOD;
    const rightActive = right.status === Status.ACTIVE ||
      right.status === Status.BILLING_GRACE_PERIOD;
    if (leftActive !== rightActive) {
      return rightActive ? 1 : -1;
    }
    return (
      (right.transaction.expiresDate ?? 0) -
      (left.transaction.expiresDate ?? 0)
    );
  })[0];
}

function createVerifier(environment: Environment): SignedDataVerifier {
  const roots = ROOT_CERTIFICATE_FILES.map((relativePath) => {
    const certificatePath = path.resolve(process.cwd(), relativePath);
    try {
      return fs.readFileSync(certificatePath);
    } catch {
      throw new SubscriptionError(
        "configuration",
        "apple-root-certificate-missing",
        "An Apple root certificate is unavailable."
      );
    }
  });
  return new SignedDataVerifier(
    roots,
    true,
    environment,
    APPLE_BUNDLE_ID,
    environment === Environment.PRODUCTION ? APPLE_APP_ID : undefined
  );
}

function createApiClient(environment: Environment): AppStoreServerAPIClient {
  return new AppStoreServerAPIClient(
    requireRuntimeSecret(SUBSCRIPTION_SECRETS.applePrivateKey),
    requireRuntimeSecret(SUBSCRIPTION_SECRETS.appleKeyId),
    requireRuntimeSecret(SUBSCRIPTION_SECRETS.appleIssuerId),
    APPLE_BUNDLE_ID,
    environment
  );
}

export function validateAppleTransaction(
  transaction: JWSTransactionDecodedPayload,
  environment: Environment
): void {
  if (
    transaction.bundleId !== APPLE_BUNDLE_ID ||
    transaction.environment !== environment
  ) {
    throw invalidStoreData("apple-transaction-identity-mismatch");
  }
  if (transaction.type !== Type.AUTO_RENEWABLE_SUBSCRIPTION) {
    throw invalidStoreData("apple-product-not-recurring");
  }
  const productId = requiredString(
    transaction.productId,
    "apple-product-missing"
  );
  if (!APPLE_SUBSCRIPTION_PRODUCTS.includes(
    productId as (typeof APPLE_SUBSCRIPTION_PRODUCTS)[number]
  )) {
    throw invalidStoreData("apple-product-not-allowed");
  }
  requiredString(
    transaction.originalTransactionId,
    "apple-original-transaction-id-missing"
  );
}

function validateRenewal(
  renewal: JWSRenewalInfoDecodedPayload,
  environment: Environment,
  originalTransactionId: string
): void {
  if (
    renewal.environment !== environment ||
    renewal.originalTransactionId !== originalTransactionId
  ) {
    throw invalidStoreData("apple-renewal-identity-mismatch");
  }
  for (const productId of [renewal.productId, renewal.autoRenewProductId]) {
    if (
      productId &&
      !APPLE_SUBSCRIPTION_PRODUCTS.includes(
        productId as (typeof APPLE_SUBSCRIPTION_PRODUCTS)[number]
      )
    ) {
      throw invalidStoreData("apple-renewal-product-not-allowed");
    }
  }
}

function validateAccountBinding(
  actual: string | undefined,
  expected: string | undefined
): void {
  if (actual && expected && !timingSafeEqualText(actual, expected)) {
    throw new SubscriptionError(
      "account-binding-mismatch",
      "apple-account-binding-mismatch",
      "The Apple account binding does not match."
    );
  }
}

export function claimedAppleEnvironment(signedPayload: string): Environment {
  let value: unknown;
  try {
    const pieces = signedPayload.split(".");
    if (pieces.length !== 3) {
      throw new Error("Malformed JWS");
    }
    const payload = JSON.parse(
      Buffer.from(pieces[1], "base64url").toString("utf8")
    ) as { environment?: unknown; data?: { environment?: unknown } };
    value = payload.environment ?? payload.data?.environment;
  } catch {
    throw invalidStoreData("apple-jws-malformed");
  }

  if (value === Environment.PRODUCTION) {
    return Environment.PRODUCTION;
  }
  if (value === Environment.SANDBOX) {
    return Environment.SANDBOX;
  }
  throw invalidStoreData("apple-environment-not-allowed");
}

function toStoreEnvironment(
  environment: Environment
): "production" | "sandbox" {
  if (environment === Environment.PRODUCTION) {
    return "production";
  }
  if (environment === Environment.SANDBOX) {
    return "sandbox";
  }
  throw invalidStoreData("apple-environment-not-allowed");
}

function assertSignedPayload(value: string): void {
  if (
    typeof value !== "string" ||
    value.length < 10 ||
    value.length > MAX_SIGNED_PAYLOAD_LENGTH
  ) {
    throw new SubscriptionError(
      "invalid-input",
      "apple-signed-payload-invalid",
      "The Apple signed payload is invalid."
    );
  }
}

function requiredString(
  value: string | undefined,
  code: string
): string {
  if (!value) {
    throw invalidStoreData(code);
  }
  return value;
}

function requiredDateNumber(
  value: number | undefined,
  code: string
): number {
  if (
    !Number.isFinite(value) ||
    !Number.isFinite(new Date(value!).getTime())
  ) {
    throw invalidStoreData(code);
  }
  return value!;
}

function invalidStoreData(code: string): SubscriptionError {
  return new SubscriptionError(
    "invalid-store-data",
    code,
    "Apple store data failed validation."
  );
}

function mapAppleError(error: unknown): SubscriptionError {
  if (error instanceof SubscriptionError) {
    return error;
  }
  if (
    error instanceof APIException &&
    (error.httpStatusCode === 429 || error.httpStatusCode >= 500)
  ) {
    return new SubscriptionError(
      "store-unavailable",
      "apple-api-unavailable",
      "The Apple API is temporarily unavailable.",
      true
    );
  }
  if (error instanceof APIException) {
    return invalidStoreData("apple-api-rejected");
  }
  return invalidStoreData("apple-signature-or-data-invalid");
}
