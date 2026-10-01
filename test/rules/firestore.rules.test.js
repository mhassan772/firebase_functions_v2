// Firestore rules tests. Run with `npm run test:rules`, which starts a Firestore emulator under
// a demo project, so nothing here can reach real data.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { after, before, beforeEach, describe, test } = require("node:test");
const {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} = require("@firebase/rules-unit-testing");
const { doc, getDoc, setDoc, collection, getDocs, setLogLevel } = require("firebase/firestore");

// The SDK logs every denial these tests expect; only real errors are worth seeing.
setLogLevel("error");

// RULES_FILE lets a deliberately broken copy be checked to fail.
const rulesPath = process.env.RULES_FILE ?? path.join(__dirname, "../../firestore.rules");

let env;

before(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-mantooq",
    firestore: { rules: fs.readFileSync(rulesPath, "utf8") },
  });
});

after(async () => {
  await env?.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, "users_adminv2/admin-1"), { role: "admin" });
    await setDoc(doc(db, "users_adminv2/dev-1"), { role: "developer" });
    await setDoc(doc(db, "books/book-1"), { name: "كتاب" });
    await setDoc(doc(db, "categories/cat-1"), { name: "تصنيف" });
    await setDoc(doc(db, "settings/mantooqAppSettings"), { isNoAuthAllowed: false });
    await setDoc(doc(db, "subscription_master/user-1"), { active: true });
  });
});

const asUser = (uid) => env.authenticatedContext(uid).firestore();
const asGuest = () => env.unauthenticatedContext().firestore();

describe("data owned by one user", () => {
  const ownedPaths = [
    "user_books/{uid}",
    "user_books/{uid}/user_books_chunk/0{uid}",
    "bookmarks/{uid}",
    "bookmarks/{uid}/bookmarks_chunk/0{uid}",
    "playback_progress_v2/{uid}",
    "playback_progress_v2/{uid}/chunks/0{uid}",
    "favorites_v2/{uid}",
    "playlists_v2/{uid}",
  ];

  for (const template of ownedPaths) {
    test(`${template}: the owner reads and writes, others and guests cannot`, async () => {
      const ownPath = template.replaceAll("{uid}", "user-1");
      await assertSucceeds(setDoc(doc(asUser("user-1"), ownPath), { value: 1 }));
      await assertSucceeds(getDoc(doc(asUser("user-1"), ownPath)));

      await assertFails(getDoc(doc(asUser("user-2"), ownPath)));
      await assertFails(setDoc(doc(asUser("user-2"), ownPath), { value: 2 }));
      await assertFails(getDoc(doc(asGuest(), ownPath)));
    });
  }

  test("user_books chunks of one user cannot be listed by another", async () => {
    await assertSucceeds(getDocs(collection(asUser("user-1"), "user_books/user-1/user_books_chunk")));
    await assertFails(getDocs(collection(asUser("user-2"), "user_books/user-1/user_books_chunk")));
  });

  test("subscription_master: the owner can get, but not list or write", async () => {
    await assertSucceeds(getDoc(doc(asUser("user-1"), "subscription_master/user-1")));
    await assertFails(getDoc(doc(asUser("user-2"), "subscription_master/user-1")));
    await assertFails(getDocs(collection(asUser("user-1"), "subscription_master")));
    await assertFails(setDoc(doc(asUser("user-1"), "subscription_master/user-1"), { active: true }));
  });
});

describe("admin-only data", () => {
  test("settings: admins read and write, others cannot", async () => {
    await assertSucceeds(getDoc(doc(asUser("admin-1"), "settings/mantooqAppSettings")));
    await assertSucceeds(setDoc(doc(asUser("admin-1"), "settings/mantooqAppSettings"), { isNoAuthAllowed: true }));

    await assertFails(getDoc(doc(asUser("user-1"), "settings/mantooqAppSettings")));
    await assertFails(getDoc(doc(asUser("dev-1"), "settings/mantooqAppSettings")));
    await assertFails(getDoc(doc(asGuest(), "settings/mantooqAppSettings")));
  });

  test("reporting_issues: admins and developers, nobody else", async () => {
    await assertSucceeds(getDocs(collection(asUser("admin-1"), "reporting_issues")));
    await assertSucceeds(getDocs(collection(asUser("dev-1"), "reporting_issues")));
    await assertFails(getDocs(collection(asUser("user-1"), "reporting_issues")));
  });

  test("users_adminv2: nobody writes a role from the client", async () => {
    await assertFails(setDoc(doc(asUser("user-1"), "users_adminv2/user-1"), { role: "admin" }));
    await assertFails(setDoc(doc(asUser("admin-1"), "users_adminv2/user-1"), { role: "admin" }));
  });
});

describe("the public catalog", () => {
  test("books and categories are readable by anyone and writable only by admins", async () => {
    await assertSucceeds(getDoc(doc(asGuest(), "books/book-1")));
    await assertSucceeds(getDoc(doc(asGuest(), "categories/cat-1")));

    await assertFails(setDoc(doc(asUser("user-1"), "books/book-1"), { name: "x" }));
    await assertFails(setDoc(doc(asUser("user-1"), "categories/cat-1"), { name: "x" }));
    await assertSucceeds(setDoc(doc(asUser("admin-1"), "books/book-1"), { name: "x" }));
  });
});

describe("everything else", () => {
  test("a collection with no rule of its own is closed", async () => {
    await assertFails(getDoc(doc(asUser("admin-1"), "unlisted_collection/doc-1")));
    await assertFails(setDoc(doc(asUser("user-1"), "unlisted_collection/doc-1"), { value: 1 }));
  });
});

test("the rules under test are the repo's, unless a copy was asked for", () => {
  assert.ok(fs.existsSync(rulesPath), `${rulesPath} is missing`);
});
