// Store-country reports and the known-country reader against the Firestore emulator. Run with
// `npm run test:integration`, which starts it under a demo project, so nothing here can reach
// real data or a real store.
const assert = require("node:assert/strict");
const { beforeEach, describe, test } = require("node:test");

assert.ok(process.env.FIRESTORE_EMULATOR_HOST, "FIRESTORE_EMULATOR_HOST must point at the emulator");

const { admin } = require("../../lib/config/admin");
const { Timestamp } = require("firebase-admin/firestore");
const {
  USER_STORE_COUNTRY_COLLECTION,
  firestoreStoreCountry,
} = require("../../lib/services/storeCountry");
const { handleReportStoreCountry } = require("../../lib/handlers/storeCountryHandlers");
const {
  persistVerifiedSubscription,
  stateDocumentId,
  SUBSCRIPTION_MASTER_COLLECTION,
  SUBSCRIPTION_STATE_COLLECTION,
} = require("../../lib/services/subscriptions/persistence");

const db = () => admin.firestore();
const store = firestoreStoreCountry(db);
const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

async function clearFirestore() {
  const response = await fetch(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-mantooq/databases/(default)/documents`,
    { method: "DELETE" }
  );
  assert.ok(response.ok, `clearing Firestore failed: ${response.status}`);
}

const report = (country, source, attested, raw = country) => ({ country, raw, source, attested });
const stored = async (uid) => (await db().collection(USER_STORE_COUNTRY_COLLECTION).doc(uid).get()).data();
const setSwitch = (value) => db().collection("web_pricing").doc("config").set({ allowUnattestedSim: value });

async function writeSlot(uid, platform, environment, data) {
  await db()
    .collection(SUBSCRIPTION_STATE_COLLECTION)
    .doc(stateDocumentId(uid, platform, environment))
    .set({ uid, platform, environment, ...data });
}

describe("store country document", () => {
  beforeEach(clearFirestore);

  test("a first report creates the document with timestamps and one history entry", async () => {
    const decision = await store.record("u1", report("SA", "apple_storefront", true, "SAU"), NOW);
    assert.equal(decision.write, true);
    const data = await stored("u1");
    assert.equal(data.country, "SA");
    assert.equal(data.raw, "SAU");
    assert.equal(data.source, "apple_storefront");
    assert.equal(data.attested, true);
    for (const field of ["firstReportedAt", "updatedAt", "lastReportAt"]) {
      assert.ok(data[field] instanceof Timestamp, field);
      assert.equal(data[field].toMillis(), NOW, field);
    }
    assert.deepEqual(
      data.history.map((e) => [e.country, e.source, e.attested, e.at.toMillis()]),
      [["SA", "apple_storefront", true, NOW]]
    );
  });

  test("an unattested report keeps attested evidence; an identical one waits a day", async () => {
    await store.record("u1", report("SA", "play_billing", true), NOW);
    await store.record("u1", report("EG", "sim", false), NOW + HOUR);
    let data = await stored("u1");
    assert.equal(data.country, "SA");
    assert.equal(data.updatedAt.toMillis(), NOW);
    assert.equal(data.lastReportAt.toMillis(), NOW + HOUR);
    assert.deepEqual(data.history.map((e) => e.country), ["SA", "EG"]);

    assert.deepEqual(await store.record("u1", report("SA", "play_billing", true), NOW + 2 * HOUR), { write: false });
    assert.equal((await stored("u1")).lastReportAt.toMillis(), NOW + HOUR);

    await store.record("u1", report("SA", "play_billing", true), NOW + 2 * DAY);
    data = await stored("u1");
    assert.equal(data.lastReportAt.toMillis(), NOW + 2 * DAY);
    assert.equal(data.updatedAt.toMillis(), NOW);
    assert.equal(data.history.length, 2);
  });

  test("parallel reports all land in the history", async () => {
    await store.record("u1", report("SA", "play_billing", true), NOW);
    await Promise.all(
      ["AE", "EG", "JO"].map((country, i) => store.record("u1", report(country, "sim", false), NOW + (i + 1) * HOUR))
    );
    const data = await stored("u1");
    assert.equal(data.country, "SA");
    assert.deepEqual(data.history.map((e) => e.country).slice(1).sort(), ["AE", "EG", "JO"]);
  });
});

describe("knownCountries", () => {
  beforeEach(clearFirestore);

  test("nothing known for an account with no report and no slot", async () => {
    assert.deepEqual(await store.knownCountries("nobody"), { storePurchase: [] });
  });

  test("an attested report counts; an unattested one does not", async () => {
    await store.record("a", report("SA", "apple_storefront", true), NOW);
    await store.record("b", report("EG", "play_billing", false), NOW);
    assert.deepEqual(await store.knownCountries("a"), { appReport: "SA", storePurchase: [] });
    assert.deepEqual(await store.knownCountries("b"), { storePurchase: [] });
  });

  test("an unattested sim report counts only when allowUnattestedSim is true", async () => {
    await store.record("d", report("EG", "sim", false), NOW);
    await store.record("p", report("EG", "play_billing", false), NOW);
    assert.deepEqual(await store.knownCountries("d"), { storePurchase: [] }, "no config document");

    await db().collection("web_pricing").doc("config").set({ other: true });
    assert.deepEqual(await store.knownCountries("d"), { storePurchase: [] }, "no field");

    await setSwitch("true");
    assert.deepEqual(await store.knownCountries("d"), { storePurchase: [] }, "only the boolean true");

    await setSwitch(true);
    assert.deepEqual(await store.knownCountries("d"), { appReport: "EG", storePurchase: [] });
    assert.deepEqual(await store.knownCountries("p"), { storePurchase: [] }, "never for another source");
  });

  test("reads the store country from the production slots only, distinct", async () => {
    await writeSlot("s", "apple", "production", { storeCountry: "SA" });
    await writeSlot("s", "google", "production", { storeCountry: "SA" });
    await writeSlot("s", "apple", "sandbox", { storeCountry: "US" });
    await writeSlot("s", "google", "test", { storeCountry: "GB" });
    assert.deepEqual(await store.knownCountries("s"), { storePurchase: ["SA"] });

    await writeSlot("s", "google", "production", { storeCountry: "EG" });
    assert.deepEqual(await store.knownCountries("s"), { storePurchase: ["SA", "EG"] });

    await writeSlot("t", "apple", "production", { storeCountry: "XX" });
    await writeSlot("t", "google", "production", {});
    assert.deepEqual(await store.knownCountries("t"), { storePurchase: [] });
  });

  test("the callable answers counted from the same reader", async () => {
    const deps = { store, now: () => NOW };
    const ctx = (app) => ({ auth: { uid: "c", token: { firebase: { sign_in_provider: "apple.com" } } }, app });
    assert.deepEqual(await handleReportStoreCountry({ country: "SAU", source: "apple_storefront" }, ctx(), deps), {
      country: "SA",
      counted: false,
    });
    assert.deepEqual(
      await handleReportStoreCountry({ country: "SAU", source: "apple_storefront" }, ctx({ appId: "x" }), deps),
      { country: "SA", counted: true }
    );
    assert.equal((await stored("c")).attested, true);
  });
});

describe("store country on a verified purchase", () => {
  beforeEach(clearFirestore);

  const verified = (eventAt, storeCountry) => ({
    subscription: {
      active: true,
      status: "active",
      platform: "apple",
      productId: "monthly_sub",
      expiresAt: new Date(Date.now() + 30 * DAY),
      autoRenewing: true,
      inGracePeriod: false,
      environment: "production",
      originalTransactionId: "2000000000000001",
      lastStoreEventAt: eventAt,
      lastVerifiedAt: eventAt,
      ...(storeCountry ? { storeCountry } : {}),
    },
    ownership: [{ platform: "apple", environment: "production", originalTransactionId: "2000000000000001" }],
  });

  test("saved on the slot, kept by a later verification without it, never on the master", async () => {
    const uid = "buyer";
    const slotRef = db().collection(SUBSCRIPTION_STATE_COLLECTION).doc(stateDocumentId(uid, "apple", "production"));
    const t0 = Date.now() - 10 * 60 * 1000;

    await persistVerifiedSubscription(uid, verified(new Date(t0), "SA"));
    assert.equal((await slotRef.get()).get("storeCountry"), "SA");

    await persistVerifiedSubscription(uid, verified(new Date(t0 + 60 * 1000)));
    const slot = (await slotRef.get()).data();
    assert.equal(slot.storeCountry, "SA");
    assert.equal(slot.lastStoreEventAt.toMillis(), t0 + 60 * 1000, "the later state was applied");

    const master = (await db().collection(SUBSCRIPTION_MASTER_COLLECTION).doc(uid).get()).data();
    assert.equal("storeCountry" in master, false);
    assert.deepEqual(await store.knownCountries(uid), { storePurchase: ["SA"] });

    await persistVerifiedSubscription(uid, verified(new Date(t0 + 2 * 60 * 1000), "AE"));
    assert.equal((await slotRef.get()).get("storeCountry"), "AE");
  });
});
