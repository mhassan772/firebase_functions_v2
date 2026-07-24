import { SubscriptionError } from "./errors";

export function requireRuntimeSecret(secretName: string): string {
  const value = process.env[secretName]?.trim();
  if (!value) {
    throw new SubscriptionError(
      "configuration",
      "runtime-secret-missing",
      `Required runtime secret ${secretName} is unavailable.`
    );
  }
  return value;
}
