const assert = require("node:assert/strict");
const { describe, test } = require("node:test");
const { Timestamp } = require("firebase-admin/firestore");
const { ISO_ALPHA3_TO_ALPHA2, toAlpha2 } = require("../lib/utils/countryCodes");
const {
  LAST_REPORT_REFRESH_MS,
  STORE_COUNTRY_HISTORY_LIMIT,
  appReportCounts,
  nextStoreCountryDocument,
  storeCountryFromData,
  storeCountryToData,
} = require("../lib/services/storeCountry");
const { handleReportStoreCountry } = require("../lib/handlers/storeCountryHandlers");
const { stateData } = require("../lib/services/subscriptions/persistence");

const NOW = new Date(Date.UTC(2026, 10, 11, 12, 0, 0));
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const later = (ms) => new Date(NOW.getTime() + ms);

const report = (country, source, attested, raw = country) => ({ country, raw, source, attested });

describe("country codes", () => {
  const entries = Object.entries(ISO_ALPHA3_TO_ALPHA2);

  test("the table holds every officially assigned ISO 3166-1 code, once", () => {
    assert.equal(entries.length, 249);
    for (const [alpha3, alpha2] of entries) {
      assert.match(alpha3, /^[A-Z]{3}$/);
      assert.match(alpha2, /^[A-Z]{2}$/);
    }
    assert.equal(new Set(entries.map(([, alpha2]) => alpha2)).size, 249);
  });

  test("every two-letter value is a region Intl knows", () => {
    const names = new Intl.DisplayNames(["en"], { type: "region" });
    for (const [alpha3, alpha2] of entries) {
      assert.notEqual(names.of(alpha2), alpha2, `${alpha3} -> ${alpha2}`);
    }
  });

  test("spot checks, both forms, any case", () => {
    const expected = {
      SAU: "SA", EGY: "EG", ARE: "AE", KWT: "KW", QAT: "QA", BHR: "BH", OMN: "OM", JOR: "JO",
      IRQ: "IQ", YEM: "YE", SYR: "SY", LBN: "LB", PSE: "PS", MAR: "MA", DZA: "DZ", TUN: "TN",
      LBY: "LY", SDN: "SD", TUR: "TR", USA: "US", CAN: "CA", GBR: "GB", DEU: "DE", FRA: "FR",
    };
    for (const [alpha3, alpha2] of Object.entries(expected)) {
      assert.equal(toAlpha2(alpha3), alpha2, alpha3);
      assert.equal(toAlpha2(alpha3.toLowerCase()), alpha2, alpha3.toLowerCase());
      assert.equal(toAlpha2(alpha2), alpha2, alpha2);
      assert.equal(toAlpha2(alpha2.toLowerCase()), alpha2, alpha2.toLowerCase());
    }
    assert.equal(toAlpha2("Sau"), "SA");
  });

  test("refuses user-assigned, unknown and malformed codes", () => {
    for (const code of ["XKX", "XK", "ZZ", "ZZZ", "UK", "", "S", "SAUD", " SA", "SA ", "S1", "١٢", "__proto__", "toString"]) {
      assert.equal(toAlpha2(code), undefined, JSON.stringify(code));
    }
    assert.equal(toAlpha2(undefined), undefined);
    assert.equal(toAlpha2(42), undefined);
  });
});

describe("replacement rule", () => {
  test("a first report becomes the evidence, whatever its attestation", () => {
    for (const attested of [true, false]) {
      const decision = nextStoreCountryDocument(undefined, report("SA", "apple_storefront", attested, "SAU"), NOW);
      assert.equal(decision.write, true);
      assert.equal(decision.replaced, true);
      assert.deepEqual(decision.document, {
        country: "SA",
        raw: "SAU",
        source: "apple_storefront",
        attested,
        firstReportedAt: NOW,
        updatedAt: NOW,
        lastReportAt: NOW,
        history: [{ country: "SA", source: "apple_storefront", attested, at: NOW }],
      });
    }
  });

  const first = (r) => nextStoreCountryDocument(undefined, r, NOW).document;

  test("an attested report replaces attested and unattested evidence", () => {
    for (const storedAttested of [true, false]) {
      const stored = first(report("EG", "sim", storedAttested));
      const decision = nextStoreCountryDocument(stored, report("SA", "play_billing", true), later(HOUR));
      assert.equal(decision.write, true);
      assert.equal(decision.replaced, true);
      const doc = decision.document;
      assert.equal(doc.country, "SA");
      assert.equal(doc.source, "play_billing");
      assert.equal(doc.attested, true);
      assert.deepEqual(doc.firstReportedAt, NOW, "set once");
      assert.deepEqual(doc.updatedAt, later(HOUR));
      assert.deepEqual(doc.lastReportAt, later(HOUR));
      assert.deepEqual(doc.history.map((e) => e.country), ["EG", "SA"]);
    }
  });

  test("an unattested report replaces unattested evidence", () => {
    const stored = first(report("EG", "sim", false));
    const decision = nextStoreCountryDocument(stored, report("SA", "sim", false), later(HOUR));
    assert.equal(decision.replaced, true);
    assert.equal(decision.document.country, "SA");
    assert.equal(decision.document.attested, false);
  });

  test("an unattested report does not replace attested evidence but is kept in the history", () => {
    const stored = first(report("SA", "play_billing", true));
    const decision = nextStoreCountryDocument(stored, report("EG", "sim", false), later(HOUR));
    assert.equal(decision.write, true);
    assert.equal(decision.replaced, false);
    const doc = decision.document;
    assert.equal(doc.country, "SA");
    assert.equal(doc.source, "play_billing");
    assert.equal(doc.attested, true);
    assert.deepEqual(doc.updatedAt, NOW, "the evidence did not change");
    assert.deepEqual(doc.lastReportAt, later(HOUR), "the call was accepted");
    assert.deepEqual(doc.history.at(-1), { country: "EG", source: "sim", attested: false, at: later(HOUR) });
  });

  test("the same unattested report again changes only lastReportAt, once a day", () => {
    const stored = nextStoreCountryDocument(
      first(report("SA", "play_billing", true)),
      report("EG", "sim", false),
      NOW
    ).document;
    assert.deepEqual(nextStoreCountryDocument(stored, report("EG", "sim", false), later(HOUR)), { write: false });
    const decision = nextStoreCountryDocument(stored, report("EG", "sim", false), later(DAY + 1));
    assert.equal(decision.write, true);
    assert.deepEqual(decision.document, { ...stored, lastReportAt: later(DAY + 1) });
  });

  test("an identical report writes nothing within a day", () => {
    const stored = first(report("SA", "apple_storefront", true));
    assert.deepEqual(nextStoreCountryDocument(stored, report("SA", "apple_storefront", true), later(HOUR)), {
      write: false,
    });
    assert.deepEqual(
      nextStoreCountryDocument(stored, report("SA", "apple_storefront", true), later(LAST_REPORT_REFRESH_MS)),
      { write: false },
      "exactly a day is not more than a day"
    );
  });

  test("an identical report after more than a day writes only lastReportAt", () => {
    const stored = nextStoreCountryDocument(
      first(report("SA", "apple_storefront", true)),
      report("EG", "sim", false),
      later(HOUR)
    ).document;
    const decision = nextStoreCountryDocument(stored, report("SA", "apple_storefront", true), later(2 * DAY));
    assert.equal(decision.write, true);
    assert.equal(decision.replaced, false);
    assert.deepEqual(decision.document, { ...stored, lastReportAt: later(2 * DAY) }, "history untouched too");
  });

  test("a report that differs only in attestation or source is not identical", () => {
    const stored = first(report("SA", "play_billing", false));
    const attested = nextStoreCountryDocument(stored, report("SA", "play_billing", true), later(HOUR));
    assert.equal(attested.replaced, true);
    assert.equal(attested.document.attested, true);
    assert.equal(attested.document.history.length, 2);

    const source = nextStoreCountryDocument(stored, report("SA", "sim", false), later(HOUR));
    assert.equal(source.replaced, true);
    assert.equal(source.document.source, "sim");
  });

  test("the history keeps the newest five", () => {
    let doc = first(report("AE", "sim", false));
    const countries = ["BH", "EG", "JO", "KW", "OM", "QA", "SA"];
    countries.forEach((country, i) => {
      doc = nextStoreCountryDocument(doc, report(country, "sim", false), later((i + 1) * HOUR)).document;
    });
    assert.equal(STORE_COUNTRY_HISTORY_LIMIT, 5);
    assert.deepEqual(doc.history.map((e) => e.country), ["JO", "KW", "OM", "QA", "SA"]);
    assert.equal(doc.country, "SA");
  });

  test("an attested report also caps the history", () => {
    let doc = first(report("SA", "apple_storefront", true));
    ["AE", "BH", "EG", "JO", "KW"].forEach((country, i) => {
      doc = nextStoreCountryDocument(doc, report(country, "sim", false), later((i + 1) * HOUR)).document;
    });
    doc = nextStoreCountryDocument(doc, report("QA", "apple_storefront", true), later(DAY)).document;
    assert.equal(doc.history.length, 5);
    assert.deepEqual(doc.history.map((e) => e.country), ["BH", "EG", "JO", "KW", "QA"]);
  });

  test("a document survives the trip through Firestore data", () => {
    const doc = nextStoreCountryDocument(
      first(report("SA", "apple_storefront", true, "SAU")),
      report("EG", "sim", false),
      later(HOUR)
    ).document;
    const data = storeCountryToData(doc);
    assert.ok(data.firstReportedAt instanceof Timestamp);
    assert.ok(data.history[0].at instanceof Timestamp);
    assert.deepEqual(storeCountryFromData(data), doc);
  });

  test("an unreadable stored document reads as none", () => {
    assert.equal(storeCountryFromData({ country: "XX", source: "sim", attested: true }), undefined);
    assert.equal(storeCountryFromData({}), undefined);
  });

  test("an app report counts when attested, or as unattested sim behind the switch", () => {
    const doc = (source, attested) => first(report("SA", source, attested));
    assert.equal(appReportCounts(doc("apple_storefront", true), false), true);
    assert.equal(appReportCounts(doc("sim", true), false), true);
    assert.equal(appReportCounts(doc("sim", false), false), false);
    assert.equal(appReportCounts(doc("sim", false), true), true);
    assert.equal(appReportCounts(doc("play_billing", false), true), false);
    assert.equal(appReportCounts(doc("apple_storefront", false), true), false);
  });
});

/** An in-memory store applying the real rule; `allowUnattestedSim` stands in for the pricing switch. */
function fakeStore({ allowUnattestedSim = false, storePurchase = [], recordError, readError } = {}) {
  const documents = new Map();
  const calls = { recorded: [] };
  return {
    calls,
    documents,
    store: {
      async record(uid, r, nowMs) {
        calls.recorded.push({ uid, report: r, nowMs });
        if (recordError) throw recordError;
        const decision = nextStoreCountryDocument(documents.get(uid), r, new Date(nowMs));
        if (decision.write) documents.set(uid, decision.document);
        return decision;
      },
      async knownCountries(uid) {
        if (readError) throw readError;
        const doc = documents.get(uid);
        return {
          ...(doc && appReportCounts(doc, allowUnattestedSim) ? { appReport: doc.country } : {}),
          storePurchase,
        };
      },
    },
  };
}

const ctx = (uid, { provider = "password", app } = {}) => ({
  auth: { uid, token: { firebase: { sign_in_provider: provider } } },
  app,
});
const APP_CHECK = { appId: "1:1008654973131:ios:abc", token: {} };

const withCode = (code, reason) => (error) => {
  assert.equal(error.code, code);
  assert.equal(error.details?.reason, reason);
  return true;
};

describe("reportStoreCountry handler", () => {
  const depsFor = (fake) => ({ store: fake.store, now: () => NOW.getTime() });

  test("refuses a missing and an anonymous caller", async () => {
    const fake = fakeStore();
    const data = { country: "SAU", source: "apple_storefront" };
    await assert.rejects(handleReportStoreCountry(data, {}, depsFor(fake)), withCode("unauthenticated", "signed_out"));
    await assert.rejects(
      handleReportStoreCountry(data, ctx("guest", { provider: "anonymous" }), depsFor(fake)),
      withCode("unauthenticated", "anonymous")
    );
    assert.equal(fake.calls.recorded.length, 0);
  });

  test("refuses anything but exactly { country, source } as strings", async () => {
    const fake = fakeStore();
    const bad = [
      undefined,
      null,
      "SAU",
      42,
      [],
      ["SAU", "apple_storefront"],
      new Date(),
      {},
      { country: "SAU" },
      { source: "apple_storefront" },
      { country: "SAU", source: "apple_storefront", uid: "someone-else" },
      { country: 682, source: "apple_storefront" },
      { country: "SAU", source: null },
      { country: ["SAU"], source: "apple_storefront" },
    ];
    for (const data of bad) {
      await assert.rejects(
        handleReportStoreCountry(data, ctx("alice"), depsFor(fake)),
        withCode("invalid-argument", "invalid_request"),
        JSON.stringify(data)
      );
    }
    assert.equal(fake.calls.recorded.length, 0);
  });

  test("refuses an unknown country and an unknown source", async () => {
    const fake = fakeStore();
    for (const country of ["XKX", "ZZ", "", "SAUD", "S1"]) {
      await assert.rejects(
        handleReportStoreCountry({ country, source: "sim" }, ctx("alice"), depsFor(fake)),
        withCode("invalid-argument", "country_unknown"),
        country
      );
    }
    for (const source of ["", "web", "SIM", "storekit"]) {
      await assert.rejects(
        handleReportStoreCountry({ country: "SA", source }, ctx("alice"), depsFor(fake)),
        withCode("invalid-argument", "source_unknown"),
        source
      );
    }
    assert.equal(fake.calls.recorded.length, 0);
  });

  test("an attested report is stored upper-cased and counts", async () => {
    const fake = fakeStore();
    const result = await handleReportStoreCountry(
      { country: "sau", source: "apple_storefront" },
      ctx("alice", { app: APP_CHECK }),
      depsFor(fake)
    );
    assert.deepEqual(result, { country: "SA", counted: true });
    assert.deepEqual(fake.calls.recorded[0], {
      uid: "alice",
      report: { country: "SA", raw: "SAU", source: "apple_storefront", attested: true },
      nowMs: NOW.getTime(),
    });
  });

  test("an unattested report is accepted but does not count", async () => {
    const fake = fakeStore();
    const result = await handleReportStoreCountry({ country: "eg", source: "play_billing" }, ctx("alice"), depsFor(fake));
    assert.deepEqual(result, { country: "EG", counted: false });
    assert.equal(fake.calls.recorded[0].report.attested, false);
    assert.equal(fake.documents.get("alice").country, "EG");
  });

  test("an unattested sim report counts only behind the switch", async () => {
    const off = fakeStore();
    assert.deepEqual(await handleReportStoreCountry({ country: "EG", source: "sim" }, ctx("a"), depsFor(off)), {
      country: "EG",
      counted: false,
    });
    const on = fakeStore({ allowUnattestedSim: true });
    assert.deepEqual(await handleReportStoreCountry({ country: "EG", source: "sim" }, ctx("a"), depsFor(on)), {
      country: "EG",
      counted: true,
    });
  });

  test("an unattested report for another country after attested evidence does not count", async () => {
    const fake = fakeStore({ allowUnattestedSim: true });
    const deps = depsFor(fake);
    await handleReportStoreCountry({ country: "SA", source: "play_billing" }, ctx("a", { app: APP_CHECK }), deps);
    assert.deepEqual(await handleReportStoreCountry({ country: "EG", source: "sim" }, ctx("a"), deps), {
      country: "EG",
      counted: false,
    });
    assert.equal(fake.documents.get("a").country, "SA");
    // The same country unattested still counts: the evidence it matches is attested.
    assert.deepEqual(await handleReportStoreCountry({ country: "SA", source: "play_billing" }, ctx("a"), deps), {
      country: "SA",
      counted: true,
    });
  });

  test("store failures become internal without their message", async () => {
    const secret = Object.assign(new Error("projects/demo/databases/(default)/documents/user_store_country/alice"), {
      code: 14,
    });
    for (const fake of [fakeStore({ recordError: secret }), fakeStore({ readError: secret })]) {
      await assert.rejects(handleReportStoreCountry({ country: "SA", source: "sim" }, ctx("alice"), depsFor(fake)), (error) => {
        assert.equal(error.code, "internal");
        assert.ok(!error.message.includes("alice"));
        assert.equal(error.details, undefined);
        return true;
      });
    }
  });
});

describe("store country on the slot document", () => {
  const PAST = Timestamp.fromDate(new Date(Date.UTC(2026, 0, 1)));
  const verified = {
    active: true,
    status: "active",
    platform: "apple",
    productId: "monthly_sub",
    expiresAt: later(30 * DAY),
    inGracePeriod: false,
    environment: "production",
    originalTransactionId: "1000",
    lastStoreEventAt: NOW,
    lastVerifiedAt: NOW,
  };

  test("written when the verification carries one", () => {
    assert.equal(stateData("uid", { ...verified, storeCountry: "SA" }, PAST, PAST).storeCountry, "SA");
    assert.equal("storeCountry" in stateData("uid", verified, PAST, PAST), false);
  });

  test("a verification without one keeps the stored one; a new one replaces it", () => {
    const replaced = stateData("uid", { ...verified, storeCountry: "SA" }, PAST, PAST);
    assert.equal(stateData("uid", verified, PAST, PAST, replaced).storeCountry, "SA");
    assert.equal(stateData("uid", { ...verified, storeCountry: "EG" }, PAST, PAST, replaced).storeCountry, "EG");
  });
});
