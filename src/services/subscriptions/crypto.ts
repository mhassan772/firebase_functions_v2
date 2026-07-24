import * as crypto from "crypto";
import { SubscriptionError } from "./errors";
import { SubscriptionPlatform } from "../../types/subscriptions";

const ACCOUNT_BINDING_VERSION = 1;

export function sha256Reference(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("base64url");
}

export function deriveAccountBinding(
  uid: string,
  platform: SubscriptionPlatform,
  secret: string
): string {
  if (!uid || Buffer.byteLength(secret, "utf8") < 32) {
    throw new SubscriptionError(
      "configuration",
      "account-binding-secret-missing",
      "Account binding configuration is unavailable."
    );
  }

  const digest = crypto
    .createHmac("sha256", secret)
    .update(`mantooq:subscription-binding:v${ACCOUNT_BINDING_VERSION}:${platform}:`)
    .update(uid, "utf8")
    .digest();

  if (platform === "google") {
    return `v${ACCOUNT_BINDING_VERSION}.${digest.toString("base64url")}`;
  }

  const uuidBytes = Buffer.from(digest.subarray(0, 16));
  uuidBytes[6] = (uuidBytes[6] & 0x0f) | 0x50;
  uuidBytes[8] = (uuidBytes[8] & 0x3f) | 0x80;
  const hex = uuidBytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

export function timingSafeEqualText(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual.toLowerCase(), "utf8");
  const expectedBuffer = Buffer.from(expected.toLowerCase(), "utf8");
  return (
    actualBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

export function accountBindingVersion(): number {
  return ACCOUNT_BINDING_VERSION;
}
