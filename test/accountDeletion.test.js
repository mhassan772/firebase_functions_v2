const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { describe, test } = require("node:test");
const { renderAuthEmail } = require("../lib/services/email/authEmailTemplates");
const { renderAccountDeletedEmail } = require("../lib/services/email/accountDeletedEmail");
const { purgeAccount, PurgeRefusedError, PURGEABLE_UID } = require("../lib/services/accountDeletion/purge");
const inventory = require("../lib/services/accountDeletion/inventory");
const { handleDeleteAccount, handleAccountDeleted } = require("../lib/handlers/accountDeletionHandlers");
const { RECENT_LOGIN_MS } = require("../lib/utils/callableAuth");

const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);
const UID = "Abcdefghij0123456789XYZ0";

function authError(code) {
  return Object.assign(new Error(`Auth said ${code} for someone@example.com`), { code });
}

/** Storage that records what it was asked to delete. */
function fakeStorage({ failPrefix } = {}) {
  const calls = { prefixes: [] };
  return {
    calls,
    async deleteByPrefix(prefix) {
      calls.prefixes.push(prefix);
      if (failPrefix && prefix.startsWith(failPrefix)) throw Object.assign(new Error("denied"), { code: 403 });
      return 0;
    },
  };
}

describe("purge guards and step isolation", () => {
  test("refuses an empty uid or one that is not letters and digits, touching nothing", async () => {
    const storage = fakeStorage();
    let cancelled = 0;
    const deps = { firestore: {}, storage, now: () => NOW, cancelWebSubscription: async () => void cancelled++ };
    for (const uid of ["", "short", "abc/defghijklmnopqrstuvwxyz", "Abcdefghij0123456789_XYZ", "A".repeat(41), undefined]) {
      await assert.rejects(purgeAccount(uid, deps), PurgeRefusedError, String(uid));
    }
    assert.equal(cancelled, 0);
    assert.deepEqual(storage.calls, { prefixes: [] });
    assert.ok(PURGEABLE_UID.test(UID));
  });

  test("a failing step does not stop the rest, and the run is not ok", async () => {
    // Every Firestore step fails on this stand-in; the web cancel fails too.
    const storage = fakeStorage();
    let cancelled = 0;
    const result = await purgeAccount(UID, {
      firestore: {},
      storage,
      now: () => NOW,
      cancelWebSubscription: async () => {
        cancelled++;
        throw new Error("provider down");
      },
    });
    assert.equal(result.ok, false);
    assert.equal(cancelled, 1);
    assert.deepEqual(
      storage.calls.prefixes,
      inventory.STORAGE_UID_PREFIX_FOLDERS.map((folder) => `${folder}/${UID}_`),
      "the Storage step still ran"
    );
    assert.ok(!result.failedSteps.includes("storage"));
    for (const step of [
      "tombstone",
      "web_subscription",
      "listener_totals",
      "uid_keyed",
      "field_keyed",
      "subscription_records",
      "payment_requests",
      "tombstone_result",
    ]) {
      assert.ok(result.failedSteps.includes(step), step);
    }
  });

  test("one failing Storage folder still lets the other folders run", async () => {
    const storage = fakeStorage({ failPrefix: "reportingIssues/" });
    const result = await purgeAccount(UID, { firestore: {}, storage, now: () => NOW, cancelWebSubscription: async () => {} });
    assert.equal(storage.calls.prefixes.length, inventory.STORAGE_UID_PREFIX_FOLDERS.length);
    assert.ok(result.failedSteps.includes("storage"));
  });
});

describe("inventory", () => {
  test("payment requests lose exactly the payer's identity and free text", () => {
    assert.deepEqual(
      [...inventory.PAYMENT_REQUEST_STRIPPED_FIELDS],
      ["user_guid", "subscription_id", "phone_number_sent_from", "notes", "admin_notes", "photo_link"]
    );
    assert.deepEqual([...inventory.PAYMENT_REQUEST_COLLECTIONS], ["subscriptions_to_be_approved", "subscription_migration_restoration"]);
    assert.equal(inventory.PAYMENT_REQUEST_ANONYMISED_FIELD, "anonymised_at");
  });

  test("listener_totals is handled on its own, never among the uid-keyed documents", () => {
    assert.equal(inventory.LISTENER_TOTALS_COLLECTION, "listener_totals");
    assert.ok(!inventory.UID_KEYED_COLLECTIONS.includes("listener_totals"));
    assert.equal(new Set(inventory.UID_KEYED_COLLECTIONS).size, inventory.UID_KEYED_COLLECTIONS.length);
  });
});

/** A callable context; `authAgeMs` is how long ago the caller signed in. */
function context({ uid = UID, provider = "password", authAgeMs = 60_000 } = {}) {
  return {
    auth: { uid, token: { auth_time: Math.floor((NOW - authAgeMs) / 1000), firebase: { sign_in_provider: provider } } },
  };
}

function handlerFakes({ purgeOk = true, sendError, deleteError, email = "user@example.com" } = {}) {
  const calls = { purged: [], deleted: [], sent: [], marked: [] };
  const firestore = {
    collection: () => ({
      doc: (id) => ({
        async update(data) {
          calls.marked.push([id, data]);
        },
      }),
    }),
  };
  const deps = {
    auth: {
      async getUser(uid) {
        return { uid, ...(email ? { email } : {}) };
      },
      async deleteUser(uid) {
        calls.deleted.push(uid);
        if (deleteError) throw deleteError;
      },
    },
    mailer: {
      async send(message) {
        calls.sent.push(message);
        if (sendError) throw sendError;
      },
    },
    purge: { firestore, storage: fakeStorage(), now: () => NOW, cancelWebSubscription: async () => {} },
    async purgeAccount(uid, _deps, options) {
      calls.purged.push([uid, options]);
      return { operationId: "op", ok: purgeOk, counts: {}, failedSteps: purgeOk ? [] : ["storage"] };
    },
  };
  return { deps, calls };
}

const rejectsWith = (code, reason) => (error) => {
  assert.equal(error.code, code);
  assert.equal(error.details?.reason, reason);
  return true;
};

describe("deleteAccount", () => {
  test("purges as pending, deletes the sign-in, marks deleted and emails in the asked language", async () => {
    const { deps, calls } = handlerFakes();
    assert.deepEqual(await handleDeleteAccount({ lang: "en" }, context(), deps), { deleted: true });
    assert.deepEqual(calls.purged, [[UID, { state: "pending", email: "user@example.com" }]]);
    assert.deepEqual(calls.deleted, [UID]);
    assert.deepEqual(calls.marked, [[UID, { state: "deleted" }]]);
    assert.equal(calls.sent.length, 1);
    assert.equal(calls.sent[0].to, "user@example.com");
    assert.equal(calls.sent[0].subject, renderAccountDeletedEmail("en").subject);
  });

  test("anything but en is Arabic, and no lang at all is accepted", async () => {
    const { deps, calls } = handlerFakes();
    await handleDeleteAccount({}, context(), deps);
    await handleDeleteAccount({ lang: "fr" }, context(), deps);
    assert.deepEqual(
      calls.sent.map((m) => m.subject),
      [renderAccountDeletedEmail("ar").subject, renderAccountDeletedEmail("ar").subject]
    );
  });

  test("refuses signed-out and anonymous callers with their reasons", async () => {
    const { deps, calls } = handlerFakes();
    await assert.rejects(handleDeleteAccount({}, {}, deps), rejectsWith("unauthenticated", "signed_out"));
    await assert.rejects(
      handleDeleteAccount({}, context({ provider: "anonymous" }), deps),
      rejectsWith("unauthenticated", "anonymous")
    );
    assert.equal(calls.purged.length, 0);
  });

  test("needs a sign-in within the last five minutes", async () => {
    const { deps, calls } = handlerFakes();
    await assert.rejects(
      handleDeleteAccount({}, context({ authAgeMs: RECENT_LOGIN_MS + 1000 }), deps),
      rejectsWith("permission-denied", "recent_login_required")
    );
    const noAuthTime = { auth: { uid: UID, token: { firebase: { sign_in_provider: "google.com" } } } };
    await assert.rejects(handleDeleteAccount({}, noAuthTime, deps), rejectsWith("permission-denied", "recent_login_required"));
    assert.equal(calls.purged.length, 0);
  });

  test("refuses a request that is not a plain object or carries unknown keys", async () => {
    const { deps, calls } = handlerFakes();
    for (const data of [null, undefined, "en", ["en"], { lang: "en", extra: 1 }, { lang: 5 }, { uid: UID }]) {
      await assert.rejects(
        handleDeleteAccount(data, context(), deps),
        rejectsWith("invalid-argument", "invalid_request"),
        JSON.stringify(data)
      );
    }
    assert.equal(calls.purged.length, 0);
  });

  test("an email failure is logged and the call still succeeds", async () => {
    const { deps, calls } = handlerFakes({ sendError: Object.assign(new Error("SES rejected user@example.com"), { code: "MessageRejected" }) });
    assert.deepEqual(await handleDeleteAccount({ lang: "ar" }, context(), deps), { deleted: true });
    assert.deepEqual(calls.deleted, [UID]);
  });

  test("an account with no address is deleted without an email", async () => {
    const { deps, calls } = handlerFakes({ email: null });
    assert.deepEqual(await handleDeleteAccount({}, context(), deps), { deleted: true });
    assert.deepEqual(calls.purged, [[UID, { state: "pending", email: undefined }]]);
    assert.equal(calls.sent.length, 0);
  });

  test("a failed purge is internal, never passes its message, and keeps the sign-in", async () => {
    const { deps, calls } = handlerFakes({ purgeOk: false });
    await assert.rejects(handleDeleteAccount({}, context(), deps), (error) => {
      assert.equal(error.code, "internal");
      assert.equal(error.details, undefined);
      assert.doesNotMatch(error.message, /storage|user@/);
      return true;
    });
    assert.equal(calls.deleted.length, 0);
    assert.equal(calls.marked.length, 0);
    assert.equal(calls.sent.length, 0);
  });

  test("a sign-in already gone is fine; any other Auth failure is internal", async () => {
    const gone = handlerFakes({ deleteError: authError("auth/user-not-found") });
    assert.deepEqual(await handleDeleteAccount({}, context(), gone.deps), { deleted: true });

    const broken = handlerFakes({ deleteError: authError("auth/internal-error") });
    await assert.rejects(handleDeleteAccount({}, context(), broken.deps), (error) => error.code === "internal");
    assert.equal(broken.calls.marked.length, 0);
    assert.equal(broken.calls.sent.length, 0);
  });
});

describe("accountDeletedCleanup", () => {
  test("runs the purge as deleted with the user's address, and swallows a refusal", async () => {
    const { deps, calls } = handlerFakes();
    await handleAccountDeleted({ uid: UID, email: "user@example.com" }, deps);
    assert.deepEqual(calls.purged, [[UID, { state: "deleted", email: "user@example.com" }]]);

    await handleAccountDeleted({ uid: "not/a/uid" }, { purge: deps.purge });
  });
});

describe("emails", () => {
  // Pinned when the shared layout was taken out of the auth-email renderer: these three emails
  // must not change by a byte.
  const PINNED = {
    "passwordReset ar": "c7feb0d67bc69d131347255fa68c61be3f38159a4c242bd869d2a4123550fdbd",
    "passwordReset en": "7a94dc41e3bd0be42f42892474cb02540750695d148c3980f17c77161999346b",
    "verification ar": "3d89a81afd0907b4795a6b74ede11d288e338427263473912052e19cb4ece2da",
    "verification en": "6346f138ab1c6e91d820c76a4567be2087a56a2c56e58b7a1f46d36261875afe",
    "emailChange ar": "5fdbd8111c2d81f94a5e69501710e5a705e38b9052ef5510151bea6370456ee5",
    "emailChange en": "4100519f74fe9de95e5e1c94a769d0a34e923997e3ab00ca527d09fb138ff0c7",
  };

  test("the auth emails render exactly as before", () => {
    for (const [key, hash] of Object.entries(PINNED)) {
      const [kind, lang] = key.split(" ");
      const rendered = renderAuthEmail(kind, lang, {
        link: `https://accounts.mantooq.com/action?mode=resetPassword&oobCode=X&lang=${lang}`,
        email: "user@example.com",
      });
      assert.equal(crypto.createHash("sha256").update(JSON.stringify(rendered)).digest("hex"), hash, key);
    }
  });

  test("the deletion confirmation has no link or button, and Arabic is right to left", () => {
    for (const lang of ["ar", "en"]) {
      const email = renderAccountDeletedEmail(lang);
      assert.ok(email.subject && email.html && email.text);
      assert.doesNotMatch(email.html, /border-radius:999px/, "no button");
      assert.equal((email.html.match(/<a /g) ?? []).length, 1, "only the footer's site link");
      assert.doesNotMatch(email.text, /https?:\/\//);
      assert.match(email.html, new RegExp(`<html dir="${lang === "ar" ? "rtl" : "ltr"}" lang="${lang}">`));
    }
  });

  test("the confirmation says the store subscription stays and what goes within 7 days", () => {
    const en = renderAccountDeletedEmail("en").text;
    assert.match(en, /App Store or Google Play/);
    assert.match(en, /does not cancel/);
    assert.match(en, /7 days/);
    const ar = renderAccountDeletedEmail("ar").text;
    assert.match(ar, /App Store أو Google Play/);
    assert.match(ar, /لا يُلغي/);
    assert.match(ar, /سبعة أيام/);
  });
});
