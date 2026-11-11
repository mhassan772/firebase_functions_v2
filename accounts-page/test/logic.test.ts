import { afterEach, describe, expect, it, vi } from "vitest";

import { signInFailureFrom } from "../src/auth/errors";
import { isSignInStale, RECENT_SIGN_IN_MS } from "../src/auth/recentLogin";
import { authDomainFor, providerFrom } from "../src/auth/session";
import { accountCheckFrom, deletionFailureFrom } from "../src/delete/failures";
import { fetchRenewingStores, renewingStores } from "../src/delete/storeSubscriptions";
import { STRINGS } from "../src/i18n";
import { routeFor } from "../src/router";

const NOW = Date.parse("2026-11-11T12:00:00Z");
const FUTURE = "2027-11-11T12:00:00Z";
const PAST = "2026-10-01T00:00:00Z";

function row(fields: Record<string, unknown>) {
  const restFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === "boolean") restFields[key] = { booleanValue: value };
    else if (key === "expiresAt") restFields[key] = { timestampValue: value };
    else restFields[key] = { stringValue: value };
  }
  return { mapValue: { fields: restFields } };
}

function master(...rows: unknown[]) {
  return { name: "projects/p/databases/(default)/documents/subscription_master/u", fields: { sources: { arrayValue: { values: rows } } } };
}

describe("routeFor", () => {
  it("matches the page routes", () => {
    expect(routeFor("/action")).toBe("action");
    expect(routeFor("/delete")).toBe("delete");
  });

  it("tolerates a trailing slash", () => {
    expect(routeFor("/delete/")).toBe("delete");
    expect(routeFor("/action//")).toBe("action");
  });

  it("sends everything else to not found", () => {
    for (const path of ["/", "", "/index.html", "/Delete", "/delete/x", "/actions", "/__/auth/handler"]) {
      expect(routeFor(path)).toBe("notFound");
    }
  });
});

describe("renewingStores", () => {
  it("finds an active renewing Apple row", () => {
    const doc = master(row({ platform: "apple", environment: "production", status: "active", expiresAt: FUTURE, autoRenewing: true }));
    expect(renewingStores(doc, NOW)).toEqual(["apple"]);
  });

  it("finds a Google row in grace period", () => {
    const doc = master(row({ platform: "google", environment: "production", status: "grace_period", expiresAt: FUTURE, autoRenewing: true }));
    expect(renewingStores(doc, NOW)).toEqual(["google"]);
  });

  it("lists both stores once each, Apple first", () => {
    const doc = master(
      row({ platform: "google", status: "active", expiresAt: FUTURE, autoRenewing: true }),
      row({ platform: "apple", status: "active", expiresAt: FUTURE, autoRenewing: true }),
      row({ platform: "google", environment: "sandbox", status: "active", expiresAt: FUTURE, autoRenewing: true }),
    );
    expect(renewingStores(doc, NOW)).toEqual(["apple", "google"]);
  });

  it("ignores expired, revoked and non-renewing rows", () => {
    const doc = master(
      row({ platform: "apple", status: "active", expiresAt: PAST, autoRenewing: true }),
      row({ platform: "google", status: "revoked", expiresAt: FUTURE, autoRenewing: true }),
      row({ platform: "apple", status: "active", expiresAt: FUTURE, autoRenewing: false }),
      row({ platform: "google", status: "active", expiresAt: FUTURE }),
    );
    expect(renewingStores(doc, NOW)).toEqual([]);
  });

  it("ignores manual and web rows", () => {
    const doc = master(
      row({ platform: "manual", status: "active", expiresAt: FUTURE, autoRenewing: false }),
      row({ platform: "stripe", status: "active", expiresAt: FUTURE, autoRenewing: true }),
    );
    expect(renewingStores(doc, NOW)).toEqual([]);
  });

  it("treats malformed documents as having no rows", () => {
    const malformed: unknown[] = [
      null,
      undefined,
      "text",
      {},
      { fields: {} },
      { fields: { sources: { stringValue: "x" } } },
      { fields: { sources: { arrayValue: {} } } },
      { fields: { sources: { arrayValue: { values: "x" } } } },
      master(null, 3, { mapValue: null }, { mapValue: { fields: { platform: { stringValue: "apple" } } } }),
      master(row({ platform: "apple", status: "active", expiresAt: "not a date", autoRenewing: true })),
      master({ mapValue: { fields: { platform: { stringValue: "apple" }, autoRenewing: { stringValue: "true" }, expiresAt: { timestampValue: FUTURE } } } }),
    ];
    for (const doc of malformed) expect(renewingStores(doc, NOW)).toEqual([]);
  });
});

describe("fetchRenewingStores", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads the owner's document with the ID token", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify(master(row({ platform: "apple", status: "active", expiresAt: FUTURE, autoRenewing: true }))), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const stores = await fetchRenewingStores({ projectId: "demo-mantooq", uid: "abc", idToken: "token", now: () => NOW });
    expect(stores).toEqual(["apple"]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://firestore.googleapis.com/v1/projects/demo-mantooq/databases/(default)/documents/subscription_master/abc");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer token");
  });

  it("uses the emulator when given", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await fetchRenewingStores({ projectId: "demo-mantooq", uid: "abc", idToken: "t", emulator: "http://127.0.0.1:8089" });
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toMatch(/^http:\/\/127\.0\.0\.1:8089\/v1\/projects\/demo-mantooq\//);
  });

  it("says nothing on a missing document, a refusal or a network failure", async () => {
    for (const respond of [
      async () => new Response("{}", { status: 404 }),
      async () => new Response("{}", { status: 403 }),
      async () => new Response("not json", { status: 200 }),
      async () => {
        throw new TypeError("Failed to fetch");
      },
    ]) {
      vi.stubGlobal("fetch", vi.fn(respond));
      expect(await fetchRenewingStores({ projectId: "p", uid: "u", idToken: "t" })).toEqual([]);
    }
  });
});

describe("signInFailureFrom", () => {
  const cases: [string, string][] = [
    ["auth/invalid-credential", "wrongCredentials"],
    ["auth/invalid-login-credentials", "wrongCredentials"],
    ["auth/wrong-password", "wrongCredentials"],
    ["auth/user-not-found", "wrongCredentials"],
    ["auth/invalid-email", "wrongCredentials"],
    ["auth/too-many-requests", "tooMany"],
    ["auth/network-request-failed", "network"],
    ["auth/popup-closed-by-user", "cancelled"],
    ["auth/cancelled-popup-request", "cancelled"],
    ["auth/user-cancelled", "cancelled"],
    ["auth/popup-blocked", "popupBlocked"],
    ["auth/operation-not-allowed", "providerDisabled"],
    ["auth/account-exists-with-different-credential", "otherMethod"],
    ["auth/user-mismatch", "differentAccount"],
    ["auth/user-disabled", "disabled"],
    ["auth/internal-error", "generic"],
  ];
  it.each(cases)("maps %s to %s", (code, failure) => {
    expect(signInFailureFrom({ code })).toBe(failure);
  });

  it("treats anything without a code as generic", () => {
    expect(signInFailureFrom(new Error("x"))).toBe("generic");
    expect(signInFailureFrom(null)).toBe("generic");
    expect(signInFailureFrom({ code: 42 })).toBe("generic");
  });
});

describe("isSignInStale", () => {
  const seconds = (ms: number) => Math.floor(ms / 1000);

  it("accepts a sign-in under four minutes old", () => {
    expect(isSignInStale(seconds(NOW - 60_000), NOW)).toBe(false);
    expect(isSignInStale(String(seconds(NOW - RECENT_SIGN_IN_MS)), NOW)).toBe(false);
  });

  it("refuses one older than four minutes", () => {
    expect(isSignInStale(seconds(NOW - RECENT_SIGN_IN_MS - 1000), NOW)).toBe(true);
    expect(isSignInStale(seconds(NOW - 4.5 * 60_000), NOW)).toBe(true);
  });

  it("refuses a missing or unreadable time", () => {
    for (const value of [undefined, null, "", "abc", 0, -5, Number.NaN, {}]) expect(isSignInStale(value, NOW)).toBe(true);
  });
});

describe("deletionFailureFrom", () => {
  it("asks for a fresh sign-in on recent_login_required", () => {
    expect(deletionFailureFrom({ code: "functions/permission-denied", details: { reason: "recent_login_required" } })).toBe("reauth");
  });

  it("treats other permission refusals as a retryable failure", () => {
    expect(deletionFailureFrom({ code: "functions/permission-denied" })).toBe("retry");
  });

  it("signs out on unauthenticated", () => {
    expect(deletionFailureFrom({ code: "functions/unauthenticated", details: { reason: "anonymous" } })).toBe("signedOut");
  });

  it("checks the account when no answer came back", () => {
    expect(deletionFailureFrom({ code: "functions/internal", message: "internal" })).toBe("noAnswer");
    expect(deletionFailureFrom({ code: "functions/internal", message: "internal [0]" })).toBe("noAnswer");
    expect(deletionFailureFrom({ code: "functions/internal", message: "internal [500]" })).toBe("noAnswer");
    expect(deletionFailureFrom({ code: "functions/deadline-exceeded", message: "deadline-exceeded" })).toBe("noAnswer");
    expect(deletionFailureFrom({ code: "functions/unavailable", message: "unavailable" })).toBe("noAnswer");
    expect(deletionFailureFrom({ code: "auth/network-request-failed" })).toBe("noAnswer");
  });

  it("shows a retry for the backend's own failures", () => {
    expect(deletionFailureFrom({ code: "functions/internal", message: "The account could not be deleted." })).toBe("retry");
    expect(deletionFailureFrom({ code: "functions/invalid-argument", details: { reason: "invalid_request" } })).toBe("retry");
    expect(deletionFailureFrom(new Error("x"))).toBe("retry");
  });
});

describe("accountCheckFrom", () => {
  it("reads a successful reload as the account still existing", () => {
    expect(accountCheckFrom(undefined)).toBe("exists");
  });

  it("reads a missing user as gone", () => {
    expect(accountCheckFrom({ code: "auth/user-not-found" })).toBe("gone");
    expect(accountCheckFrom({ code: "auth/user-token-expired" })).toBe("gone");
  });

  it("can't tell on any other failure", () => {
    expect(accountCheckFrom({ code: "auth/network-request-failed" })).toBe("unknown");
    expect(accountCheckFrom(new Error("x"))).toBe("unknown");
  });
});

describe("sign-in helpers", () => {
  it("uses the page's own host only on accounts.mantooq.com", () => {
    expect(authDomainFor({ hostname: "accounts.mantooq.com", host: "accounts.mantooq.com" }, "mantooq-test.firebaseapp.com")).toBe("accounts.mantooq.com");
    expect(authDomainFor({ hostname: "localhost", host: "localhost:5173" }, "mantooq-test.firebaseapp.com")).toBe("mantooq-test.firebaseapp.com");
    expect(authDomainFor({ hostname: "mantooq-accounts.web.app", host: "mantooq-accounts.web.app" }, "x.firebaseapp.com")).toBe("x.firebaseapp.com");
  });

  it("maps the token's sign-in provider", () => {
    expect(providerFrom("password")).toBe("password");
    expect(providerFrom("google.com")).toBe("google");
    expect(providerFrom("apple.com")).toBe("apple");
    expect(providerFrom("anonymous")).toBeNull();
    expect(providerFrom("phone")).toBeNull();
    expect(providerFrom(undefined)).toBeNull();
  });
});

describe("strings", () => {
  it("has the same keys and kinds in both languages", () => {
    const ar = STRINGS.ar as Record<string, unknown>;
    const en = STRINGS.en as Record<string, unknown>;
    expect(Object.keys(en).sort()).toEqual(Object.keys(ar).sort());
    for (const key of Object.keys(ar)) expect(typeof en[key]).toBe(typeof ar[key]);
  });
});
