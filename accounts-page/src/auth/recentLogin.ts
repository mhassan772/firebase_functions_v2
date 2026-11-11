/// Whether a sign-in is recent enough for an action the backend guards with `auth_time`.

/// One minute under the backend's five, so a confirmation that takes a while still lands in time.
export const RECENT_SIGN_IN_MS = 4 * 60 * 1000;

/// True when the sign-in is older than `maxAgeMs`, or its time is missing or unreadable.
export function isSignInStale(authTime: unknown, nowMs: number, maxAgeMs: number = RECENT_SIGN_IN_MS): boolean {
  const seconds = typeof authTime === "string" ? Number(authTime) : authTime;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return true;
  return nowMs - seconds * 1000 > maxAgeMs;
}
