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
const {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  getDocs,
  query,
  where,
  Timestamp,
  setLogLevel,
} = require("firebase/firestore");

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
    "bookmarks/{uid}/tags/{uid}",
    "bookmarks/{uid}/book_bookmarks/{uid}",
    "routines/{uid}",
    "routine_activity/{uid}",
    "pdf_progress/{uid}",
    "device_sessions_v2/{uid}",
    "podcast_subscriptions/{uid}",
    "episodes_lists/{uid}",
    "episodes_lists/{uid}/lists/default-episode-list",
    "episode_progress/{uid}",
    "converted_podcasts/{uid}",
    "archived_episodes/{uid}",
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

describe("shared_collections", () => {
  const now = Timestamp.fromMillis(Date.UTC(2026, 9, 3));

  const playlistShare = (overrides = {}) => ({
    type: "playlist",
    ownerUid: "user-1",
    sourceId: "playlist-local-1",
    enabled: true,
    schema: 1,
    name: "قائمتي",
    icon: { code: 1 },
    items: [{ g: "book-1" }, { pod: 42, n: "بودكاست", i: "https://example.com/p.jpg" }],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });

  const routineShare = (overrides = {}) => ({
    type: "routine",
    ownerUid: "user-1",
    sourceId: "routine-local-1",
    enabled: true,
    schema: 1,
    name: "وردي اليومي",
    entries: [
      { g: "book-1", t: "06:00", r: [1, 2] },
      { list: "k1", t: "07:00", r: [3] },
    ],
    playlists: { k1: { name: "قائمة", items: [{ g: "book-1" }] } },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });

  const seed = async (id, data) => {
    await env.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), `shared_collections/${id}`), data);
    });
  };

  test("anyone reads an enabled share; only the owner reads a stopped one", async () => {
    await seed("on", playlistShare());
    await seed("off", playlistShare({ enabled: false }));

    await assertSucceeds(getDoc(doc(asGuest(), "shared_collections/on")));
    await assertSucceeds(getDoc(doc(asUser("user-2"), "shared_collections/on")));

    await assertFails(getDoc(doc(asGuest(), "shared_collections/off")));
    await assertFails(getDoc(doc(asUser("user-2"), "shared_collections/off")));
    await assertSucceeds(getDoc(doc(asUser("user-1"), "shared_collections/off")));
  });

  test("the owner creates valid playlist and routine shares", async () => {
    await assertSucceeds(setDoc(doc(asUser("user-1"), "shared_collections/p1"), playlistShare()));
    await assertSucceeds(setDoc(doc(asUser("user-1"), "shared_collections/r1"), routineShare()));
    const { icon, ...noIcon } = playlistShare();
    await assertSucceeds(setDoc(doc(asUser("user-1"), "shared_collections/p2"), noIcon));
  });

  test("a share cannot be created for someone else or as a guest", async () => {
    await assertFails(setDoc(doc(asUser("user-2"), "shared_collections/p1"), playlistShare()));
    await assertFails(setDoc(doc(asGuest(), "shared_collections/p1"), playlistShare()));
  });

  test("a share with a bad shape is refused", async () => {
    const db = asUser("user-1");
    const tooMany = Array.from({ length: 1001 }, (_, i) => ({ g: `book-${i}` }));
    const bad = [
      playlistShare({ schema: 2 }),
      playlistShare({ type: "album" }),
      playlistShare({ name: "" }),
      playlistShare({ name: "ن".repeat(101) }),
      playlistShare({ sourceId: "" }),
      playlistShare({ enabled: "yes" }),
      playlistShare({ unknownKey: true }),
      playlistShare({ items: tooMany }),
      playlistShare({ entries: [] }),
      routineShare({ icon: { code: 1 } }),
      routineShare({ items: [] }),
      routineShare({ entries: Array.from({ length: 201 }, () => ({ g: "book-1", t: "06:00", r: [1] })) }),
    ];
    for (const [i, data] of bad.entries()) {
      await assertFails(setDoc(doc(db, `shared_collections/bad-${i}`), data));
    }
  });

  test("only the owner updates or deletes a share", async () => {
    await seed("p1", playlistShare());

    await assertFails(updateDoc(doc(asUser("user-2"), "shared_collections/p1"), { name: "x" }));
    await assertFails(updateDoc(doc(asUser("user-2"), "shared_collections/p1"), { enabled: false }));
    await assertFails(updateDoc(doc(asGuest(), "shared_collections/p1"), { enabled: false }));
    await assertFails(deleteDoc(doc(asUser("user-2"), "shared_collections/p1")));

    const db = asUser("user-1");
    await assertSucceeds(updateDoc(doc(db, "shared_collections/p1"), { name: "اسم جديد", updatedAt: now }));
    await assertSucceeds(updateDoc(doc(db, "shared_collections/p1"), { items: [{ g: "book-2" }] }));
    await assertSucceeds(updateDoc(doc(db, "shared_collections/p1"), { enabled: false }));
    await assertSucceeds(updateDoc(doc(db, "shared_collections/p1"), { enabled: true }));
    await assertSucceeds(deleteDoc(doc(db, "shared_collections/p1")));
  });

  test("the owner cannot change who owns a share, its type or its source", async () => {
    await seed("p1", playlistShare());
    const db = asUser("user-1");

    await assertFails(updateDoc(doc(db, "shared_collections/p1"), { ownerUid: "user-2" }));
    await assertFails(updateDoc(doc(db, "shared_collections/p1"), { type: "routine" }));
    await assertFails(updateDoc(doc(db, "shared_collections/p1"), { sourceId: "other" }));
    await assertFails(updateDoc(doc(db, "shared_collections/p1"), { createdAt: Timestamp.now() }));
    await assertFails(updateDoc(doc(db, "shared_collections/p1"), { name: "" }));
  });

  test("only the owner lists, and only their own shares", async () => {
    await seed("p1", playlistShare());
    await seed("p2", playlistShare({ ownerUid: "user-2", sourceId: "other" }));

    const own = await assertSucceeds(
      getDocs(query(collection(asUser("user-1"), "shared_collections"), where("ownerUid", "==", "user-1"))),
    );
    assert.equal(own.size, 1);

    await assertFails(
      getDocs(query(collection(asUser("user-2"), "shared_collections"), where("ownerUid", "==", "user-1"))),
    );
    await assertFails(
      getDocs(query(collection(asGuest(), "shared_collections"), where("ownerUid", "==", "user-1"))),
    );
    await assertFails(getDocs(collection(asUser("user-1"), "shared_collections")));
    await assertFails(
      getDocs(query(collection(asUser("user-1"), "shared_collections"), where("enabled", "==", true))),
    );
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
