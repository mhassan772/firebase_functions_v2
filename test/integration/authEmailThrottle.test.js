// Account-email throttle against the Firestore emulator. Run with `npm run test:integration`,
// which starts it under a demo project, so nothing here can reach real data.
const assert = require("node:assert/strict");
const { beforeEach, describe, test } = require("node:test");

assert.ok(process.env.FIRESTORE_EMULATOR_HOST, "FIRESTORE_EMULATOR_HOST must point at the emulator");

const { admin } = require("../../lib/config/admin");
const { Timestamp } = require("firebase-admin/firestore");
const {
  AUTH_EMAIL_THROTTLE_COLLECTION,
  AuthEmailThrottledError,
  addressDocId,
  firestoreAuthEmailThrottle,
  uidDocId,
} = require("../../lib/services/authEmailThrottle");

const db = () => admin.firestore();
const throttle = firestoreAuthEmailThrottle(db);
const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

async function clearFirestore() {
  const response = await fetch(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-mantooq/databases/(default)/documents`,
    { method: "DELETE" }
  );
  assert.ok(response.ok, `clearing Firestore failed: ${response.status}`);
}

const refused = (reason) => (error) => error instanceof AuthEmailThrottledError && error.reason === reason;

describe("auth email throttle", () => {
  beforeEach(clearFirestore);

  test("stores a hashed address with a TTL timestamp, never the raw address", async () => {
    await throttle.consume({ uid: "u1", address: " Alice@Example.com", nowMs: NOW });

    const snapshot = await db().collection(AUTH_EMAIL_THROTTLE_COLLECTION).get();
    assert.deepEqual(snapshot.docs.map((d) => d.id).sort(), [addressDocId("alice@example.com"), uidDocId("u1")].sort());
    for (const doc of snapshot.docs) {
      assert.ok(!JSON.stringify(doc.data()).toLowerCase().includes("alice"), "no raw address in the data");
      assert.ok(doc.data().expiresAt instanceof Timestamp, "expiresAt is a timestamp the TTL policy can use");
      assert.equal(doc.data().expiresAt.toMillis(), NOW + DAY);
      assert.equal(doc.data().count, 1);
    }
  });

  test("one per address per minute, case and spaces ignored", async () => {
    await throttle.consume({ uid: "u1", address: "alice@example.com", nowMs: NOW });
    await assert.rejects(
      throttle.consume({ uid: "u2", address: "ALICE@example.com ", nowMs: NOW + 30_000 }),
      refused("address_minute")
    );
    await throttle.consume({ uid: "u2", address: "alice@example.com", nowMs: NOW + MINUTE });
  });

  test("five per address per day, then the window starts again", async () => {
    for (let i = 0; i < 5; i++) {
      await throttle.consume({ uid: `u${i}`, address: "alice@example.com", nowMs: NOW + i * MINUTE });
    }
    await assert.rejects(
      throttle.consume({ uid: "u9", address: "alice@example.com", nowMs: NOW + 10 * MINUTE }),
      refused("address_day")
    );
    await throttle.consume({ uid: "u9", address: "alice@example.com", nowMs: NOW + DAY });
  });

  test("ten per uid per day across addresses, and a refusal counts nothing", async () => {
    for (let i = 0; i < 10; i++) {
      await throttle.consume({ uid: "u1", address: `a${i}@example.com`, nowMs: NOW + i });
    }
    await assert.rejects(throttle.consume({ uid: "u1", address: "z@example.com", nowMs: NOW + 20 }), refused("uid_day"));

    const untouched = await db().collection(AUTH_EMAIL_THROTTLE_COLLECTION).doc(addressDocId("z@example.com")).get();
    assert.equal(untouched.exists, false);
    const uidDoc = await db().collection(AUTH_EMAIL_THROTTLE_COLLECTION).doc(uidDocId("u1")).get();
    assert.equal(uidDoc.data().count, 10);
  });

  test("parallel requests for one address let exactly one through", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) => throttle.consume({ uid: `p${i}`, address: "race@example.com", nowMs: NOW }))
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    for (const r of results.filter((r) => r.status === "rejected")) {
      assert.ok(refused("address_minute")(r.reason), String(r.reason));
    }
    const doc = await db().collection(AUTH_EMAIL_THROTTLE_COLLECTION).doc(addressDocId("race@example.com")).get();
    assert.equal(doc.data().count, 1);
  });
});
