const assert = require("node:assert/strict");
const { describe, test } = require("node:test");
const { renderAuthEmail, escapeHtml, senderName } = require("../lib/services/email/authEmailTemplates");
const { rewriteActionLink, readLang, ActionLinkError } = require("../lib/services/email/actionLink");
const { formatFromAddress } = require("../lib/services/email/sesMailer");
const {
  evaluateThrottle,
  hashAddress,
  addressDocId,
  uidDocId,
  AuthEmailThrottledError,
  DEFAULT_AUTH_EMAIL_LIMITS,
} = require("../lib/services/authEmailThrottle");
const {
  handleRequestPasswordResetEmail,
  handleRequestVerificationEmail,
  handleRequestEmailChange,
  RECENT_LOGIN_MS,
} = require("../lib/handlers/authEmailHandlers");

const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const adminLink = (mode, code = "CODE-123_abc") =>
  `https://mantooq-test.firebaseapp.com/__/auth/action?mode=${mode}&oobCode=${code}&apiKey=AIzaFake&lang=en`;

function authError(code) {
  return Object.assign(new Error(`Auth said ${code} for someone@example.com`), { code });
}

/** An in-memory stand-in for Auth, SES and the throttle, recording what each handler did. */
function fakes({ users = [], throttleError, sendError, linkError } = {}) {
  const byUid = new Map(users.map((u) => [u.uid, u]));
  const calls = { sent: [], consumed: [], links: [] };
  const auth = {
    async getUser(uid) {
      const user = byUid.get(uid);
      if (!user) throw authError("auth/user-not-found");
      return user;
    },
    async getUserByEmail(email) {
      const user = users.find((u) => u.email && u.email.toLowerCase() === email.toLowerCase());
      if (!user) throw authError("auth/user-not-found");
      return user;
    },
    async generatePasswordResetLink(email) {
      calls.links.push(["resetPassword", email]);
      if (linkError) throw linkError;
      return adminLink("resetPassword");
    },
    async generateEmailVerificationLink(email) {
      calls.links.push(["verifyEmail", email]);
      if (linkError) throw linkError;
      return adminLink("verifyEmail");
    },
    async generateVerifyAndChangeEmailLink(email, newEmail) {
      calls.links.push(["verifyAndChangeEmail", email, newEmail]);
      if (linkError) throw linkError;
      return adminLink("verifyAndChangeEmail");
    },
  };
  const deps = {
    auth,
    mailer: {
      async send(email) {
        if (sendError) throw sendError;
        calls.sent.push(email);
      },
    },
    throttle: {
      async consume(input) {
        calls.consumed.push(input);
        if (throttleError) throw throttleError;
      },
    },
    now: () => NOW,
  };
  return { deps, calls };
}

const ctx = (uid, { provider = "password", authTime = NOW / 1000 - 60, app } = {}) => ({
  auth: { uid, token: { auth_time: authTime, firebase: { sign_in_provider: provider } } },
  app,
});

const withCode = (code, reason) => (error) => {
  assert.equal(error.code, code);
  if (reason) assert.equal(error.details?.reason, reason);
  return true;
};

const alice = { uid: "alice", email: "alice@example.com", emailVerified: false, disabled: false };

describe("templates", () => {
  test("every kind has a subject, an HTML part and a text part in both languages", () => {
    for (const kind of ["passwordReset", "verification", "emailChange"]) {
      for (const lang of ["ar", "en"]) {
        const email = renderAuthEmail(kind, lang, { link: "https://accounts.mantooq.com/action?a=1&b=2", email: "a@b.co" });
        assert.ok(email.subject.length > 0, `${kind}/${lang} subject`);
        assert.match(email.html, /^<!DOCTYPE html>/);
        assert.ok(email.text.includes("https://accounts.mantooq.com/action?a=1&b=2"), "text keeps the raw link");
        assert.ok(email.html.includes('href="https://accounts.mantooq.com/action?a=1&amp;b=2"'), "html escapes the link");
        assert.ok(email.html.includes("https://accounts.mantooq.com/email-logo.png"));
        const dir = lang === "ar" ? "rtl" : "ltr";
        assert.ok(email.html.includes(`<html dir="${dir}" lang="${lang}">`), `${kind}/${lang} dir and lang`);
      }
    }
  });

  test("interpolated values are escaped and the address is isolated LTR", () => {
    const hostile = `"><script>alert(1)</script>@x.co`;
    for (const kind of ["passwordReset", "emailChange"]) {
      for (const lang of ["ar", "en"]) {
        const email = renderAuthEmail(kind, lang, { link: `https://x.co/?q="><b>`, email: hostile });
        assert.ok(!email.html.includes("<script>"), `${kind}/${lang} escapes the address`);
        assert.ok(!email.html.includes('"><b>'), `${kind}/${lang} escapes the link`);
        assert.ok(
          email.html.includes(
            `<span dir="ltr" style="font-weight:700;unicode-bidi:isolate;">${escapeHtml(hostile)}</span>`
          ),
          `${kind}/${lang} isolates the address`
        );
        assert.ok(email.text.includes(hostile), "text carries the address as is");
      }
    }
    assert.equal(escapeHtml(`&<>"'`), "&amp;&lt;&gt;&quot;&#39;");
  });

  test("the reset email says the link lasts one hour; the change email names the new address", () => {
    assert.match(renderAuthEmail("passwordReset", "en", { link: "https://x.co", email: "a@b.co" }).text, /one hour/);
    assert.match(renderAuthEmail("passwordReset", "ar", { link: "https://x.co", email: "a@b.co" }).text, /ساعة واحدة/);
    const change = renderAuthEmail("emailChange", "ar", { link: "https://x.co", email: "new@b.co" });
    assert.ok(change.text.includes("⁦new@b.co⁩"));
    assert.match(change.subject, /الجديد/);
  });

  test("the sender name is Arabic or English and is MIME-encoded when needed", () => {
    assert.equal(senderName("ar"), "منطوق");
    assert.equal(senderName("en"), "Mantooq");
    assert.equal(formatFromAddress("Mantooq", "noreply@mantooq.com"), `"Mantooq" <noreply@mantooq.com>`);
    const encoded = formatFromAddress("منطوق", "noreply@mantooq.com");
    const match = /^=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?= <noreply@mantooq\.com>$/.exec(encoded);
    assert.ok(match, encoded);
    assert.equal(Buffer.from(match[1], "base64").toString("utf8"), "منطوق");
  });
});

describe("action link", () => {
  test("keeps mode and oobCode, adds lang, drops apiKey", () => {
    const link = new URL(rewriteActionLink(adminLink("resetPassword"), "ar", "resetPassword"));
    assert.equal(link.origin + link.pathname, "https://accounts.mantooq.com/action");
    assert.equal(link.searchParams.get("mode"), "resetPassword");
    assert.equal(link.searchParams.get("oobCode"), "CODE-123_abc");
    assert.equal(link.searchParams.get("lang"), "ar");
    assert.equal(link.searchParams.get("apiKey"), null);
    assert.deepEqual([...link.searchParams.keys()], ["mode", "oobCode", "lang"]);
  });

  test("rejects a link without an oobCode, without a mode, or with another mode", () => {
    const reason = (r) => (error) => error instanceof ActionLinkError && error.reason === r;
    assert.throws(
      () => rewriteActionLink("https://x.firebaseapp.com/__/auth/action?mode=verifyEmail", "en"),
      reason("missing_code")
    );
    assert.throws(() => rewriteActionLink("https://x.firebaseapp.com/__/auth/action?oobCode=a", "en"), reason("missing_mode"));
    assert.throws(() => rewriteActionLink(adminLink("signIn"), "en"), reason("unexpected_mode"));
    assert.throws(() => rewriteActionLink(adminLink("verifyEmail"), "en", "resetPassword"), reason("unexpected_mode"));
    assert.throws(() => rewriteActionLink("not a url", "en"), reason("unparsable"));
  });

  test("lang is en only when asked for exactly", () => {
    assert.equal(readLang("en"), "en");
    for (const value of ["ar", "EN", "fr", undefined, null, 1]) assert.equal(readLang(value), "ar");
  });
});

describe("throttle decisions", () => {
  const L = DEFAULT_AUTH_EMAIL_LIMITS;

  test("one email per address per minute", () => {
    const first = evaluateThrottle(undefined, undefined, NOW, L);
    assert.equal(first.allowed, true);
    assert.deepEqual(evaluateThrottle(first.address, first.uid, NOW + MINUTE - 1, L), {
      allowed: false,
      reason: "address_minute",
    });
    assert.equal(evaluateThrottle(first.address, first.uid, NOW + MINUTE, L).allowed, true);
  });

  test("five per address and ten per uid in a day, then a fresh window", () => {
    let address;
    let uid;
    for (let i = 0; i < 5; i++) {
      const d = evaluateThrottle(address, uid, NOW + i * MINUTE, L);
      assert.equal(d.allowed, true, `send ${i + 1}`);
      ({ address, uid } = d);
    }
    assert.deepEqual(evaluateThrottle(address, uid, NOW + 10 * MINUTE, L), { allowed: false, reason: "address_day" });
    assert.equal(evaluateThrottle(address, uid, NOW + DAY, L).allowed, true);

    const fullUid = { windowStartMs: NOW, count: 10, lastSentMs: NOW };
    assert.deepEqual(evaluateThrottle(undefined, fullUid, NOW + MINUTE, L), { allowed: false, reason: "uid_day" });
    assert.equal(evaluateThrottle(undefined, fullUid, NOW + DAY, L).allowed, true);
  });

  test("the stored key is a hash of the trimmed, lower-cased address", () => {
    assert.equal(hashAddress("  Alice@Example.COM "), hashAddress("alice@example.com"));
    assert.match(addressDocId("alice@example.com"), /^address_[0-9a-f]{64}$/);
    assert.ok(!addressDocId("alice@example.com").includes("alice"));
    assert.equal(uidDocId("a/b"), "uid_a%2Fb");
  });
});

describe("requestPasswordResetEmail", () => {
  test("sends a branded reset to an existing account", async () => {
    const { deps, calls } = fakes({ users: [alice] });
    const result = await handleRequestPasswordResetEmail(
      { email: "  Alice@Example.com ", lang: "en" },
      ctx("guest", { provider: "anonymous" }),
      deps
    );
    assert.deepEqual(result, { ok: true });
    assert.equal(calls.sent.length, 1);
    const [email] = calls.sent;
    assert.equal(email.to, "alice@example.com");
    assert.equal(email.fromName, "Mantooq");
    assert.ok(email.text.includes("https://accounts.mantooq.com/action?mode=resetPassword&oobCode=CODE-123_abc&lang=en"));
    assert.deepEqual(calls.consumed, [{ uid: "guest", address: "Alice@Example.com", nowMs: NOW }]);
  });

  test("replies the same for an unknown or disabled account, sends nothing, still counts", async () => {
    for (const users of [[], [{ ...alice, disabled: true }]]) {
      const { deps, calls } = fakes({ users });
      const result = await handleRequestPasswordResetEmail({ email: "alice@example.com" }, ctx("guest"), deps);
      assert.deepEqual(result, { ok: true });
      assert.equal(calls.sent.length, 0);
      assert.equal(calls.links.length, 0);
      assert.equal(calls.consumed.length, 1);
    }
  });

  test("an account deleted between lookup and link still gets the uniform reply", async () => {
    const { deps, calls } = fakes({ users: [alice], linkError: authError("auth/email-not-found") });
    assert.deepEqual(await handleRequestPasswordResetEmail({ email: "alice@example.com" }, ctx("g"), deps), { ok: true });
    assert.equal(calls.sent.length, 0);
  });

  test("refuses a missing caller and a bad address", async () => {
    const { deps } = fakes({ users: [alice] });
    await assert.rejects(handleRequestPasswordResetEmail({ email: "alice@example.com" }, {}, deps), withCode("unauthenticated"));
    for (const email of [undefined, "", "nope", "a@b", "a b@c.co", 42]) {
      await assert.rejects(handleRequestPasswordResetEmail({ email }, ctx("g"), deps), withCode("invalid-argument"));
    }
  });

  test("throttled calls get resource-exhausted", async () => {
    const { deps, calls } = fakes({ users: [alice], throttleError: new AuthEmailThrottledError("address_minute") });
    await assert.rejects(
      handleRequestPasswordResetEmail({ email: "alice@example.com" }, ctx("g"), deps),
      withCode("resource-exhausted", "address_minute")
    );
    assert.equal(calls.sent.length, 0);
  });

  test("SES and link failures become internal", async () => {
    const ses = fakes({ users: [alice], sendError: Object.assign(new Error("rejected a@b.co"), { name: "MessageRejected" }) });
    await assert.rejects(handleRequestPasswordResetEmail({ email: "alice@example.com" }, ctx("g"), ses.deps), withCode("internal"));
    const link = fakes({ users: [alice], linkError: authError("auth/internal-error") });
    await assert.rejects(handleRequestPasswordResetEmail({ email: "alice@example.com" }, ctx("g"), link.deps), withCode("internal"));
  });
});

describe("requestVerificationEmail", () => {
  test("sends to the account's own address in Arabic by default", async () => {
    const { deps, calls } = fakes({ users: [alice] });
    assert.deepEqual(await handleRequestVerificationEmail({}, ctx("alice"), deps), { ok: true });
    assert.equal(calls.sent[0].to, "alice@example.com");
    assert.equal(calls.sent[0].fromName, "منطوق");
    assert.ok(calls.sent[0].html.includes('<html dir="rtl" lang="ar">'));
    assert.ok(calls.sent[0].text.includes("mode=verifyEmail&oobCode=CODE-123_abc&lang=ar"));
  });

  test("refuses anonymous callers, verified accounts and accounts with no email", async () => {
    const { deps, calls } = fakes({
      users: [{ ...alice, emailVerified: true }, { uid: "phone", emailVerified: false, disabled: false }],
    });
    await assert.rejects(handleRequestVerificationEmail({}, ctx("alice", { provider: "anonymous" }), deps), withCode("unauthenticated"));
    await assert.rejects(
      handleRequestVerificationEmail({}, ctx("alice"), deps),
      withCode("failed-precondition", "already_verified")
    );
    await assert.rejects(handleRequestVerificationEmail(null, ctx("phone"), deps), withCode("failed-precondition", "no_email"));
    assert.equal(calls.consumed.length, 0, "refusals do not count against the throttle");
    assert.equal(calls.sent.length, 0);
  });

  test("throttled calls get resource-exhausted", async () => {
    const { deps } = fakes({ users: [alice], throttleError: new AuthEmailThrottledError("uid_day") });
    await assert.rejects(handleRequestVerificationEmail({}, ctx("alice"), deps), withCode("resource-exhausted", "uid_day"));
  });
});

describe("requestEmailChange", () => {
  const bob = { uid: "bob", email: "bob@example.com", emailVerified: true, disabled: false };

  test("sends the confirmation to the new address", async () => {
    const { deps, calls } = fakes({ users: [alice] });
    assert.deepEqual(
      await handleRequestEmailChange({ newEmail: " new@example.com ", lang: "en" }, ctx("alice"), deps),
      { ok: true }
    );
    assert.deepEqual(calls.links, [["verifyAndChangeEmail", "alice@example.com", "new@example.com"]]);
    assert.equal(calls.sent[0].to, "new@example.com");
    assert.ok(calls.sent[0].text.includes("mode=verifyAndChangeEmail&oobCode=CODE-123_abc&lang=en"));
    assert.equal(calls.consumed[0].address, "new@example.com");
  });

  test("needs a sign-in within the last five minutes", async () => {
    const { deps, calls } = fakes({ users: [alice] });
    const stale = NOW / 1000 - RECENT_LOGIN_MS / 1000 - 1;
    await assert.rejects(
      handleRequestEmailChange({ newEmail: "new@example.com" }, ctx("alice", { authTime: stale }), deps),
      withCode("permission-denied", "recent_login_required")
    );
    await assert.rejects(
      handleRequestEmailChange(
        { newEmail: "new@example.com" },
        { auth: { uid: "alice", token: { firebase: { sign_in_provider: "password" } } } },
        deps
      ),
      withCode("permission-denied", "recent_login_required")
    );
    const fresh = NOW / 1000 - RECENT_LOGIN_MS / 1000 + 1;
    await handleRequestEmailChange({ newEmail: "new@example.com" }, ctx("alice", { authTime: fresh }), deps);
    assert.equal(calls.sent.length, 1);
  });

  test("refuses the current address, a bad address and anonymous callers", async () => {
    const { deps, calls } = fakes({ users: [alice] });
    await assert.rejects(handleRequestEmailChange({ newEmail: "ALICE@example.com" }, ctx("alice"), deps), withCode("invalid-argument"));
    await assert.rejects(handleRequestEmailChange({ newEmail: "alice@" }, ctx("alice"), deps), withCode("invalid-argument"));
    await assert.rejects(
      handleRequestEmailChange({ newEmail: "new@example.com" }, ctx("alice", { provider: "anonymous" }), deps),
      withCode("unauthenticated")
    );
    assert.equal(calls.sent.length, 0);
  });

  test("an address owned by another account is already-exists, from the lookup or from Auth", async () => {
    const lookup = fakes({ users: [alice, bob] });
    await assert.rejects(handleRequestEmailChange({ newEmail: "bob@example.com" }, ctx("alice"), lookup.deps), withCode("already-exists"));
    assert.equal(lookup.calls.links.length, 0);

    const race = fakes({ users: [alice], linkError: authError("auth/email-already-exists") });
    await assert.rejects(handleRequestEmailChange({ newEmail: "bob@example.com" }, ctx("alice"), race.deps), withCode("already-exists"));
    assert.equal(race.calls.sent.length, 0);
  });

  test("throttled calls get resource-exhausted", async () => {
    const { deps } = fakes({ users: [alice], throttleError: new AuthEmailThrottledError("address_day") });
    await assert.rejects(
      handleRequestEmailChange({ newEmail: "new@example.com" }, ctx("alice"), deps),
      withCode("resource-exhausted", "address_day")
    );
  });
});
