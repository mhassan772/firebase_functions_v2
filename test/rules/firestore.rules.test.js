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
  serverTimestamp,
  setLogLevel,
  writeBatch,
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
    "blocked_content/{uid}",
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

  test("hidden_podcasts, replaced by blocked_content, is closed to its owner", async () => {
    await assertFails(setDoc(doc(asUser("user-1"), "hidden_podcasts/user-1"), { value: 1 }));
    await assertFails(getDoc(doc(asUser("user-1"), "hidden_podcasts/user-1")));
  });

  test("user_books chunks of one user cannot be listed by another", async () => {
    await assertSucceeds(getDocs(collection(asUser("user-1"), "user_books/user-1/user_books_chunk")));
    await assertFails(getDocs(collection(asUser("user-2"), "user_books/user-1/user_books_chunk")));
  });

  test("subscriptions_manual: only the owner, by the hash of their uid, can get their document", async () => {
    // sha256("user-1") in hex.
    const ownHash = require("node:crypto").createHash("sha256").update("user-1").digest("hex");
    await env.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), `subscriptions_manual/${ownHash}`), { expires: Timestamp.now() });
    });
    await assertSucceeds(getDoc(doc(asUser("user-1"), `subscriptions_manual/${ownHash}`)));
    await assertFails(getDoc(doc(asUser("user-2"), `subscriptions_manual/${ownHash}`)));
    await assertFails(getDoc(doc(asGuest(), `subscriptions_manual/${ownHash}`)));
    await assertFails(getDocs(collection(asUser("user-1"), "subscriptions_manual")));
    // Nothing on the client writes here any more, admins included.
    await assertFails(setDoc(doc(asUser("user-1"), `subscriptions_manual/${ownHash}`), { expires: Timestamp.now() }));
    await assertFails(setDoc(doc(asUser("admin-1"), `subscriptions_manual/${ownHash}`), { expires: Timestamp.now() }));
    await assertFails(deleteDoc(doc(asUser("admin-1"), `subscriptions_manual/${ownHash}`)));
    // Admins keep reading for the transition.
    await assertSucceeds(getDoc(doc(asUser("admin-1"), `subscriptions_manual/${ownHash}`)));
    await assertSucceeds(getDocs(collection(asUser("admin-1"), "subscriptions_manual")));
  });

  test("subscription_acknowledgements and subscription_reconcile_state: no client at all", async () => {
    for (const path of ["subscription_acknowledgements/ref-1", "subscription_reconcile_state/google-voided"]) {
      for (const db of [asUser("user-1"), asUser("admin-1"), asGuest()]) {
        await assertFails(getDoc(doc(db, path)));
        await assertFails(setDoc(doc(db, path), { status: "done" }));
        await assertFails(getDocs(collection(db, path.split("/")[0])));
      }
    }
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

  test("subscription stats: admins read them, nobody writes them", async () => {
    await env.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, "subscription_stats/current"), { schemaVersion: 1 });
      await setDoc(doc(db, "subscription_stats_daily/2026-10-20"), { date: "2026-10-20" });
    });
    for (const path of ["subscription_stats/current", "subscription_stats_daily/2026-10-20"]) {
      const name = path.split("/")[0];
      await assertSucceeds(getDoc(doc(asUser("admin-1"), path)));
      await assertSucceeds(getDocs(collection(asUser("admin-1"), name)));
      for (const db of [asUser("dev-1"), asUser("user-1"), asGuest()]) {
        await assertFails(getDoc(doc(db, path)));
        await assertFails(getDocs(collection(db, name)));
      }
      for (const db of [asUser("admin-1"), asUser("dev-1"), asUser("user-1"), asGuest()]) {
        await assertFails(setDoc(doc(db, path), { schemaVersion: 2 }));
        await assertFails(updateDoc(doc(db, path), { schemaVersion: 2 }));
        await assertFails(deleteDoc(doc(db, path)));
      }
      await assertFails(setDoc(doc(asUser("admin-1"), `${name}/new-doc`), { value: 1 }));
    }
  });

  test("users_adminv2: nobody writes a role from the client", async () => {
    await assertFails(setDoc(doc(asUser("user-1"), "users_adminv2/user-1"), { role: "admin" }));
    await assertFails(setDoc(doc(asUser("admin-1"), "users_adminv2/user-1"), { role: "admin" }));
  });
});

describe("admin portal roles", () => {
  // A `roles` list alone decides access; without one the single `role` does. `admin` grants all.
  const portalUsers = {
    "admin-roles": { roles: ["admin"] },
    "cm-1": { roles: ["content-manager"] },
    "egypt-1": { roles: ["egypt-subscription-approval"] },
    "manager-1": { role: "manager" },
    "multi-1": { roles: ["content-manager", "egypt-subscription-approval"] },
    "dev-roles": { roles: ["developer"] },
    // The list wins over the old field, so this user is not an admin.
    "roles-wins": { role: "admin", roles: ["content-manager"] },
    "no-roles": { roles: [] },
  };

  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      for (const [uid, data] of Object.entries(portalUsers)) {
        await setDoc(doc(db, `users_adminv2/${uid}`), { active: true, ...data });
      }
      await setDoc(doc(db, "settings/youtube"), { key: "x" });
      await setDoc(doc(db, "settings_app/subscription"), { maxDevices: 2 });
      await setDoc(doc(db, "settings_app/featured_active_books_1"), { books: [] });
      await setDoc(doc(db, "subscriptions_to_be_approved/req-1"), { user_guid: "user-1", status: "pending" });
      await setDoc(doc(db, "subscription_migration_restoration/req-2"), { user_guid: "user-1" });
      await setDoc(doc(db, "subscription_stats/current"), { schemaVersion: 1 });
      await setDoc(doc(db, "logs_adminv2/log-1"), { action: "x" });
      await setDoc(doc(db, "users_not_activated_adminv2/pending-1"), { email: "p@example.com", uid: "pending-1" });
      await setDoc(doc(db, "reporting_issues/issue-1"), { text: "x" });
    });
  });

  const admins = ["admin-1", "admin-roles"];
  const contentManagers = ["cm-1", "multi-1", "roles-wins"];
  const approvers = ["egypt-1", "multi-1"];
  const everyone = [
    "admin-1", "admin-roles", "cm-1", "egypt-1", "manager-1", "multi-1", "dev-roles", "roles-wins", "no-roles",
    "user-1",
  ];
  const others = (allowed) => everyone.filter((uid) => !allowed.includes(uid));

  test("books: admins and content managers write, nobody else", async () => {
    for (const uid of [...admins, ...contentManagers]) {
      await assertSucceeds(setDoc(doc(asUser(uid), "books/book-1"), { name: uid }));
      await assertSucceeds(setDoc(doc(asUser(uid), "book_recordings/rec-1"), { name: uid }));
      await assertSucceeds(getDoc(doc(asUser(uid), "book_recordings/rec-1")));
      await assertSucceeds(setDoc(doc(asUser(uid), "authors/author-1"), { name: uid }));
      await assertSucceeds(deleteDoc(doc(asUser(uid), "authors/author-1")));
    }
    for (const uid of others([...admins, ...contentManagers])) {
      await assertFails(setDoc(doc(asUser(uid), "books/book-1"), { name: uid }));
      await assertFails(getDoc(doc(asUser(uid), "book_recordings/rec-1")));
      await assertFails(setDoc(doc(asUser(uid), "categories/cat-1"), { name: uid }));
    }
  });

  test("settings: content managers reach the content settings only", async () => {
    for (const uid of admins) {
      await assertSucceeds(getDoc(doc(asUser(uid), "settings/mantooqAppSettings")));
      await assertSucceeds(setDoc(doc(asUser(uid), "settings/mantooqAppSettings"), { isNoAuthAllowed: false }));
      await assertSucceeds(setDoc(doc(asUser(uid), "settings/youtube"), { key: uid }));
    }
    for (const uid of contentManagers) {
      await assertSucceeds(getDoc(doc(asUser(uid), "settings/youtube")));
      await assertSucceeds(setDoc(doc(asUser(uid), "settings/youtube"), { key: uid }));
      await assertSucceeds(setDoc(doc(asUser(uid), "settings/webAdminV2UploadBooks"), { key: uid }));
      await assertFails(getDoc(doc(asUser(uid), "settings/mantooqAppSettings")));
      await assertFails(setDoc(doc(asUser(uid), "settings/mantooqAppSettings"), { isNoAuthAllowed: true }));
    }
    for (const uid of others([...admins, ...contentManagers])) {
      await assertFails(getDoc(doc(asUser(uid), "settings/youtube")));
      await assertFails(setDoc(doc(asUser(uid), "settings/youtube"), { key: uid }));
    }
  });

  test("settings_app: content managers write everything but the subscription device limits", async () => {
    for (const uid of admins) {
      await assertSucceeds(setDoc(doc(asUser(uid), "settings_app/subscription"), { maxDevices: 2 }));
      await assertSucceeds(setDoc(doc(asUser(uid), "settings_app/featured_active_books_1"), { books: [uid] }));
    }
    for (const uid of contentManagers) {
      await assertSucceeds(setDoc(doc(asUser(uid), "settings_app/featured_active_books_1"), { books: [uid] }));
      await assertSucceeds(setDoc(doc(asUser(uid), "settings_app/featured_active_books_1/items/a"), { v: 1 }));
      await assertFails(setDoc(doc(asUser(uid), "settings_app/subscription"), { maxDevices: 9 }));
      await assertFails(setDoc(doc(asUser(uid), "settings_app/subscription/items/a"), { v: 1 }));
    }
    for (const uid of others([...admins, ...contentManagers])) {
      await assertFails(setDoc(doc(asUser(uid), "settings_app/featured_active_books_1"), { books: [uid] }));
      await assertFails(setDoc(doc(asUser(uid), "settings_app/subscription"), { maxDevices: 9 }));
    }
    // Reads stay public.
    await assertSucceeds(getDoc(doc(asGuest(), "settings_app/subscription")));
  });

  test("the Egypt request queue: admins and approvers, plus the requester reading their own", async () => {
    for (const uid of [...admins, ...approvers]) {
      await assertSucceeds(getDocs(collection(asUser(uid), "subscriptions_to_be_approved")));
      await assertSucceeds(updateDoc(doc(asUser(uid), "subscriptions_to_be_approved/req-1"), { status: "approved" }));
      await assertSucceeds(getDoc(doc(asUser(uid), "subscription_migration_restoration/req-2")));
      await assertSucceeds(updateDoc(doc(asUser(uid), "subscription_migration_restoration/req-2"), { note: uid }));
    }
    for (const uid of others([...admins, ...approvers])) {
      if (uid !== "user-1") {
        await assertFails(getDoc(doc(asUser(uid), "subscriptions_to_be_approved/req-1")));
      }
      await assertFails(getDocs(collection(asUser(uid), "subscriptions_to_be_approved")));
      await assertFails(updateDoc(doc(asUser(uid), "subscriptions_to_be_approved/req-1"), { status: "approved" }));
      await assertFails(updateDoc(doc(asUser(uid), "subscription_migration_restoration/req-2"), { note: uid }));
    }
    await assertSucceeds(getDoc(doc(asUser("user-1"), "subscriptions_to_be_approved/req-1")));
    await assertSucceeds(getDoc(doc(asUser("user-1"), "subscription_migration_restoration/req-2")));
  });

  test("subscription stats and the legacy manual grants stay with admins, approvers included", async () => {
    for (const uid of admins) {
      await assertSucceeds(getDoc(doc(asUser(uid), "subscription_stats/current")));
      await assertSucceeds(getDocs(collection(asUser(uid), "subscriptions_manual")));
    }
    for (const uid of others(admins)) {
      await assertFails(getDoc(doc(asUser(uid), "subscription_stats/current")));
      await assertFails(getDocs(collection(asUser(uid), "subscriptions_manual")));
    }
  });

  test("logs_adminv2: every portal user writes a log, only admins read or change them", async () => {
    for (const uid of everyone.filter((uid) => uid !== "user-1")) {
      await assertSucceeds(setDoc(doc(asUser(uid), `logs_adminv2/new-${uid}`), { action: "x" }));
    }
    await assertFails(setDoc(doc(asUser("user-1"), "logs_adminv2/new-user-1"), { action: "x" }));
    await assertFails(setDoc(doc(asGuest(), "logs_adminv2/new-guest"), { action: "x" }));
    for (const uid of admins) {
      await assertSucceeds(getDocs(collection(asUser(uid), "logs_adminv2")));
      await assertSucceeds(updateDoc(doc(asUser(uid), "logs_adminv2/log-1"), { action: "y" }));
    }
    for (const uid of others(admins)) {
      await assertFails(getDocs(collection(asUser(uid), "logs_adminv2")));
      await assertFails(getDoc(doc(asUser(uid), "logs_adminv2/log-1")));
      await assertFails(updateDoc(doc(asUser(uid), "logs_adminv2/log-1"), { action: "y" }));
      await assertFails(deleteDoc(doc(asUser(uid), "logs_adminv2/log-1")));
    }
  });

  test("users_adminv2: everyone reads their own, admins list them all", async () => {
    for (const uid of admins) {
      await assertSucceeds(getDocs(collection(asUser(uid), "users_adminv2")));
      await assertSucceeds(getDoc(doc(asUser(uid), "users_adminv2/cm-1")));
    }
    for (const uid of others(admins)) {
      await assertFails(getDocs(collection(asUser(uid), "users_adminv2")));
      await assertFails(getDoc(doc(asUser(uid), "users_adminv2/admin-1")));
    }
    await assertSucceeds(getDoc(doc(asUser("cm-1"), "users_adminv2/cm-1")));
    // A user with no portal document reads it as missing, not as denied.
    await assertSucceeds(getDoc(doc(asUser("user-1"), "users_adminv2/user-1")));
  });

  // What the Portal users page writes: roles, active and the stamp, nothing else.
  const access = (by, roles, active = true) => ({ roles, active, updatedBy: by, updatedAt: serverTimestamp() });

  test("users_adminv2: admins change other people's roles and sign-in", async () => {
    for (const uid of admins) {
      await assertSucceeds(updateDoc(doc(asUser(uid), "users_adminv2/cm-1"), access(uid, ["content-manager", "egypt-subscription-approval"])));
      await assertSucceeds(updateDoc(doc(asUser(uid), "users_adminv2/egypt-1"), access(uid, [], false)));
      await assertSucceeds(updateDoc(doc(asUser(uid), "users_adminv2/manager-1"), access(uid, ["developer"])));
    }
    for (const uid of others(admins)) {
      await assertFails(updateDoc(doc(asUser(uid), "users_adminv2/cm-1"), access(uid, ["admin"])));
      await assertFails(updateDoc(doc(asUser(uid), `users_adminv2/${uid}`), access(uid, ["admin"])));
    }
  });

  test("users_adminv2: an admin's write must be well formed", async () => {
    const ref = doc(asUser("admin-roles"), "users_adminv2/cm-1");
    // Unknown, legacy or repeated roles; an active user with no role.
    await assertFails(updateDoc(ref, access("admin-roles", ["owner"])));
    await assertFails(updateDoc(ref, access("admin-roles", ["manager"])));
    await assertFails(updateDoc(ref, access("admin-roles", ["admin", "admin"])));
    await assertFails(updateDoc(ref, access("admin-roles", [])));
    await assertFails(updateDoc(ref, { ...access("admin-roles", ["admin"]), active: "yes" }));
    // The stamp must name the writer and the server time.
    await assertFails(updateDoc(ref, { ...access("admin-roles", ["admin"]), updatedBy: "someone-else" }));
    await assertFails(updateDoc(ref, { ...access("admin-roles", ["admin"]), updatedAt: Timestamp.fromMillis(0) }));
    // Only access fields change: not the legacy role, not the email.
    await assertFails(updateDoc(ref, { ...access("admin-roles", ["admin"]), role: "admin" }));
    await assertFails(updateDoc(ref, { ...access("admin-roles", ["admin"]), email: "x@example.com" }));
    // A whole-document write that drops fields is refused, and so is deleting.
    await assertFails(setDoc(ref, { roles: ["admin"] }));
    await assertFails(deleteDoc(ref));
  });

  test("users_adminv2: an admin can't remove their own admin access or sign-in", async () => {
    for (const uid of admins) {
      const own = doc(asUser(uid), `users_adminv2/${uid}`);
      await assertFails(updateDoc(own, access(uid, ["content-manager"])));
      await assertFails(updateDoc(own, access(uid, ["admin"], false)));
      await assertSucceeds(updateDoc(own, access(uid, ["admin", "developer"])));
    }
  });

  test("activating a sign-in: one batch creates the access and removes the waiting entry", async () => {
    const activate = (by, data = access(by, ["content-manager"])) => {
      const db = asUser(by);
      const batch = writeBatch(db);
      batch.set(doc(db, "users_adminv2/pending-1"), { email: "p@example.com", ...data });
      batch.delete(doc(db, "users_not_activated_adminv2/pending-1"));
      return batch.commit();
    };
    for (const uid of others(admins)) {
      await assertFails(activate(uid));
    }
    // Either half on its own is refused.
    await assertFails(setDoc(doc(asUser("admin-1"), "users_adminv2/pending-1"), { email: "p@example.com", ...access("admin-1", ["content-manager"]) }));
    await assertFails(deleteDoc(doc(asUser("admin-1"), "users_not_activated_adminv2/pending-1")));
    // The email must be the one the sign-in recorded, and the roles valid.
    const db = asUser("admin-1");
    const wrongEmail = writeBatch(db);
    wrongEmail.set(doc(db, "users_adminv2/pending-1"), { email: "other@example.com", ...access("admin-1", ["content-manager"]) });
    wrongEmail.delete(doc(db, "users_not_activated_adminv2/pending-1"));
    await assertFails(wrongEmail.commit());
    await assertFails(activate("admin-1", access("admin-1", ["manager"])));
    // Nobody can be created out of thin air.
    await assertFails(setDoc(doc(asUser("admin-1"), "users_adminv2/user-1"), access("admin-1", ["admin"])));

    await assertSucceeds(activate("admin-1"));
    await assertSucceeds(getDoc(doc(asUser("pending-1"), "users_adminv2/pending-1")));
  });

  test("users_not_activated_adminv2: a sign-up writes and reads only its own request", async () => {
    await assertSucceeds(getDoc(doc(asUser("pending-1"), "users_not_activated_adminv2/pending-1")));
    await assertSucceeds(
      setDoc(doc(asUser("user-1"), "users_not_activated_adminv2/user-1"), { email: "u@example.com", uid: "user-1" })
    );
    await assertFails(
      setDoc(doc(asUser("user-1"), "users_not_activated_adminv2/user-2"), { email: "u@example.com", uid: "user-2" })
    );
    await assertFails(setDoc(doc(asGuest(), "users_not_activated_adminv2/guest"), { email: "g@example.com" }));
    await assertFails(getDoc(doc(asGuest(), "users_not_activated_adminv2/pending-1")));
    await assertFails(getDocs(collection(asGuest(), "users_not_activated_adminv2")));
    await assertFails(updateDoc(doc(asUser("pending-1"), "users_not_activated_adminv2/pending-1"), { email: "x" }));
    await assertFails(deleteDoc(doc(asUser("pending-1"), "users_not_activated_adminv2/pending-1")));
    for (const uid of admins) {
      await assertSucceeds(getDocs(collection(asUser(uid), "users_not_activated_adminv2")));
      // Removed only by the activation batch (tested above), never on its own.
      await assertFails(deleteDoc(doc(asUser(uid), "users_not_activated_adminv2/pending-1")));
    }
    for (const uid of others(admins)) {
      await assertFails(getDocs(collection(asUser(uid), "users_not_activated_adminv2")));
      await assertFails(getDoc(doc(asUser(uid), "users_not_activated_adminv2/pending-1")));
    }
  });

  test("reporting_issues: developers by either field, and admins", async () => {
    for (const uid of [...admins, "dev-1", "dev-roles"]) {
      await assertSucceeds(getDocs(collection(asUser(uid), "reporting_issues")));
      await assertSucceeds(setDoc(doc(asUser(uid), "reporting_issues/issue-1"), { text: uid }));
    }
    for (const uid of others([...admins, "dev-roles"])) {
      await assertFails(getDocs(collection(asUser(uid), "reporting_issues")));
      await assertFails(setDoc(doc(asUser(uid), "reporting_issues/issue-1"), { text: uid }));
    }
  });

  test("an owner check next to an admin check still passes for a user with no portal document", async () => {
    await assertSucceeds(setDoc(doc(asUser("user-1"), "favorites_v2/user-1"), { value: 1 }));
    await assertSucceeds(getDoc(doc(asUser("user-1"), "favorites_v2/user-1")));
    await assertFails(getDoc(doc(asUser("cm-1"), "favorites_v2/user-1")));
    await assertSucceeds(getDoc(doc(asUser("admin-roles"), "favorites_v2/user-1")));
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

describe("podcast audit events", () => {
  const paths = [
    "podcast_audit/follow_user-1_p-920666",
    "podcast_audit/listen_user-1_p-920666",
    "converted_podcast_audit/convert_user-1_p-920666",
    "podcast_audit_state/daily",
  ];
  const event = (path) =>
    path.startsWith("podcast_audit_state")
      ? { lastRunAt: Timestamp.now() }
      : {
          podcast_id: "p-920666",
          ...(path.startsWith("converted") ? { book_guid: "book-guid-1" } : {}),
          user_guid: "user-1",
          action: path.split("/")[1].split("_")[0],
          timestamp: serverTimestamp(),
        };

  test("no client creates an event or the job state, the owner and admins included", async () => {
    for (const uid of ["user-1", "admin-1"]) {
      for (const path of paths) {
        await assertFails(setDoc(doc(asUser(uid), path), event(path)));
      }
    }
    await assertFails(setDoc(doc(asGuest(), paths[0]), event(paths[0])));
  });

  test("no client reads, updates or deletes an event or the job state", async () => {
    await env.withSecurityRulesDisabled(async (context) => {
      for (const path of paths) {
        await setDoc(doc(context.firestore(), path), { ...event(path), timestamp: Timestamp.now() });
      }
    });

    for (const uid of ["user-1", "admin-1"]) {
      const db = asUser(uid);
      for (const path of paths) {
        await assertFails(getDoc(doc(db, path)));
        await assertFails(updateDoc(doc(db, path), { podcast_id: "1" }));
        await assertFails(deleteDoc(doc(db, path)));
      }
      for (const name of ["podcast_audit", "converted_podcast_audit", "podcast_audit_state"]) {
        await assertFails(getDocs(collection(db, name)));
      }
    }
  });

  describe("converted podcast listens written by the app", () => {
    const listenPath = "converted_podcast_audit/listen_user-1_p-920666";
    const listen = (overrides = {}) => ({
      podcast_id: "p-920666",
      book_guid: "book-guid-1",
      user_guid: "user-1",
      action: "listen",
      timestamp: serverTimestamp(),
      ...overrides,
    });
    const seedListen = async (timestamp) => {
      await env.withSecurityRulesDisabled(async (context) => {
        await setDoc(doc(context.firestore(), listenPath), { ...listen(), timestamp });
      });
    };

    test("a user creates their own listen", async () => {
      await assertSucceeds(setDoc(doc(asUser("user-1"), listenPath), listen()));
    });

    test("a second write within a day is refused", async () => {
      const db = asUser("user-1");
      await assertSucceeds(setDoc(doc(db, listenPath), listen()));
      await assertFails(setDoc(doc(db, listenPath), listen()));
      await seedListen(Timestamp.fromMillis(Date.now() - 23 * 60 * 60 * 1000));
      await assertFails(setDoc(doc(db, listenPath), listen()));
    });

    test("a listen more than a day old is re-dated, keeping its podcast and user", async () => {
      await seedListen(Timestamp.fromMillis(Date.now() - 25 * 60 * 60 * 1000));
      const db = asUser("user-1");
      await assertFails(updateDoc(doc(db, listenPath), { timestamp: serverTimestamp(), podcast_id: "p-1" }));
      await assertSucceeds(setDoc(doc(db, listenPath), listen({ book_guid: "book-guid-2" })));
    });

    test("another user, a guest or another id is refused", async () => {
      await assertFails(setDoc(doc(asUser("user-2"), listenPath), listen()));
      await assertFails(setDoc(doc(asUser("user-2"), listenPath), listen({ user_guid: "user-2" })));
      await assertFails(setDoc(doc(asGuest(), listenPath), listen()));

      const db = asUser("user-1");
      await assertFails(setDoc(doc(db, "converted_podcast_audit/listen_user-1_p-1"), listen()));
      await assertFails(setDoc(doc(db, "converted_podcast_audit/listen_user-1_920666"), listen()));
      await assertFails(setDoc(doc(db, "converted_podcast_audit/listen_user-2_p-920666"), listen()));
      await assertFails(setDoc(doc(db, "converted_podcast_audit/user-1_p-920666"), listen()));
    });

    test("a client-chosen timestamp, a wrong action or a bad field set is refused", async () => {
      const db = asUser("user-1");
      const { book_guid, ...withoutBook } = listen();
      const bad = [
        listen({ timestamp: Timestamp.now() }),
        listen({ timestamp: Timestamp.fromMillis(Date.UTC(2026, 0, 1)) }),
        listen({ action: "convert" }),
        listen({ action: "follow" }),
        listen({ extra: 1 }),
        withoutBook,
        listen({ book_guid: "" }),
        listen({ book_guid: 5 }),
      ];
      for (const data of bad) {
        await assertFails(setDoc(doc(db, listenPath), data));
      }
      await assertFails(
        setDoc(doc(db, "converted_podcast_audit/convert_user-1_p-920666"), listen({ action: "convert" })),
      );
    });

    test("the owner cannot read, list or delete their listen", async () => {
      await seedListen(Timestamp.now());
      const db = asUser("user-1");
      await assertFails(getDoc(doc(db, listenPath)));
      await assertFails(getDocs(collection(db, "converted_podcast_audit")));
      await assertFails(
        getDocs(query(collection(db, "converted_podcast_audit"), where("user_guid", "==", "user-1"))),
      );
      await assertFails(deleteDoc(doc(db, listenPath)));
    });
  });

  test("the rankings are readable by anyone and written by nobody", async () => {
    await env.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "popular_podcasts_v2/popular_podcasts"), { popular_podcasts: [] });
    });

    await assertSucceeds(getDoc(doc(asUser("user-1"), "popular_podcasts_v2/popular_podcasts")));
    await assertSucceeds(getDoc(doc(asUser("user-1"), "popular_podcasts_v2/popular_converted_podcasts")));
    await assertSucceeds(getDoc(doc(asGuest(), "popular_podcasts_v2/popular_podcasts")));

    await assertFails(setDoc(doc(asUser("user-1"), "popular_podcasts_v2/popular_podcasts"), { popular_podcasts: [] }));
    await assertFails(setDoc(doc(asUser("admin-1"), "popular_podcasts_v2/popular_podcasts"), { popular_podcasts: [] }));
    await assertFails(deleteDoc(doc(asUser("user-1"), "popular_podcasts_v2/popular_podcasts")));
  });
});

describe("book listeners", () => {
  const path = "book_listeners/user-1_book-1";
  const line = {
    book_guid: "book-1",
    user_guid: "user-1",
    seconds: 600,
    updatedAt: Timestamp.now(),
    listenedBeforeSessions: false,
    qualifies: true,
    addedToBook: false,
  };

  test("no client creates a line, the owner and admins included", async () => {
    for (const uid of ["user-1", "admin-1"]) {
      await assertFails(setDoc(doc(asUser(uid), path), line));
    }
    await assertFails(setDoc(doc(asGuest(), path), line));
  });

  test("no client reads, updates or deletes a line", async () => {
    await env.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), path), line);
    });

    for (const uid of ["user-1", "admin-1"]) {
      const db = asUser(uid);
      await assertFails(getDoc(doc(db, path)));
      await assertFails(updateDoc(doc(db, path), { seconds: 99999 }));
      await assertFails(deleteDoc(doc(db, path)));
      await assertFails(getDocs(collection(db, "book_listeners")));
    }
  });
});

describe("content_reports", () => {
  const podcastReport = (overrides = {}) => ({
    uid: "user-1",
    contentType: "podcast",
    contentId: "p-534524",
    title: "بودكاست",
    image: "https://img.example.com/p.jpg",
    reason: "picture",
    request: "hide_picture",
    status: "pending",
    appVersion: "90.6.0",
    platform: "ios",
    createdAt: serverTimestamp(),
    ...overrides,
  });
  const copyright = {
    claimantName: "صاحب الحق",
    email: "owner@example.com",
    relationship: "owner",
    originalWork: "كتاب منشور عام 2020",
    statementAccepted: true,
  };
  const without = (data, ...keys) => Object.fromEntries(Object.entries(data).filter(([k]) => !keys.includes(k)));
  const create = (uid, id, data) => setDoc(doc(asUser(uid), `content_reports/${id}`), data);

  test("the user reports a podcast, an episode's podcast and a book once each", async () => {
    await assertSucceeds(create("user-1", "user-1_p-534524", podcastReport()));
    await assertSucceeds(
      create(
        "user-1",
        "user-1_p-77",
        podcastReport({
          contentId: "p-77",
          episode: { episodeId: "e-41928399210", title: "حلقة", image: "" },
          reason: "content",
          request: "remove",
          details: "تفاصيل",
        })
      )
    );
    await assertSucceeds(
      create(
        "user-1",
        "user-1_6f1c2a0e-1b2d_4c3e",
        podcastReport({ contentType: "book", contentId: "6f1c2a0e-1b2d_4c3e", reason: "copyright", request: "remove", copyright })
      )
    );
  });

  test("a second report of the same item is refused", async () => {
    await assertSucceeds(create("user-1", "user-1_p-534524", podcastReport()));
    await assertFails(create("user-1", "user-1_p-534524", podcastReport({ reason: "both" })));
    await assertFails(updateDoc(doc(asUser("user-1"), "content_reports/user-1_p-534524"), { details: "x" }));
    await assertFails(deleteDoc(doc(asUser("user-1"), "content_reports/user-1_p-534524")));
  });

  test("a report under someone else's name, a wrong id, or as a guest is refused", async () => {
    await assertFails(create("user-2", "user-1_p-534524", podcastReport()));
    await assertFails(create("user-2", "user-2_p-534524", podcastReport()));
    await assertFails(create("user-1", "user-1_p-1", podcastReport()));
    await assertFails(create("user-1", "user-1-p-534524", podcastReport()));
    await assertFails(setDoc(doc(asGuest(), "content_reports/user-1_p-534524"), podcastReport()));
  });

  test("a report with a bad shape is refused", async () => {
    const id = "user-1_p-534524";
    const bad = [
      podcastReport({ contentId: "534524" }),
      podcastReport({ contentType: "author" }),
      podcastReport({ reason: "spam" }),
      podcastReport({ request: "ban" }),
      podcastReport({ reason: "content", request: "hide_picture" }),
      podcastReport({ reason: "copyright", request: "remove" }),
      podcastReport({ reason: "copyright", request: "hide_picture", copyright }),
      podcastReport({ reason: "picture", copyright }),
      podcastReport({ reason: "copyright", request: "remove", copyright: { ...copyright, statementAccepted: false } }),
      podcastReport({ reason: "copyright", request: "remove", copyright: { ...copyright, email: "nope" } }),
      podcastReport({ reason: "copyright", request: "remove", copyright: { ...copyright, relationship: "fan" } }),
      podcastReport({ reason: "copyright", request: "remove", copyright: without(copyright, "originalWork") }),
      podcastReport({ details: "x".repeat(2001) }),
      podcastReport({ title: "x".repeat(501) }),
      podcastReport({ episode: { episodeId: "77", title: "", image: "" } }),
      podcastReport({ episode: { episodeId: "e-77", title: "", image: "", extra: 1 } }),
      podcastReport({ status: "actioned" }),
      podcastReport({ createdAt: Timestamp.now() }),
      podcastReport({ action: "blur" }),
      without(podcastReport(), "appVersion"),
      without(podcastReport(), "image"),
    ];
    for (const data of bad) {
      await assertFails(create("user-1", id, data));
    }
    // A book report cannot carry an episode.
    await assertFails(
      create(
        "user-1",
        "user-1_book-1",
        podcastReport({ contentType: "book", contentId: "book-1", episode: { episodeId: "e-1", title: "", image: "" } })
      )
    );
  });

  test("the reporter gets only their own report, and nobody but admins lists or acts", async () => {
    await assertSucceeds(create("user-1", "user-1_p-534524", podcastReport()));

    await assertSucceeds(getDoc(doc(asUser("user-1"), "content_reports/user-1_p-534524")));
    // A report not sent yet reads as missing to its would-be owner, not as denied.
    await assertSucceeds(getDoc(doc(asUser("user-1"), "content_reports/user-1_p-1")));
    await assertFails(getDoc(doc(asUser("user-2"), "content_reports/user-1_p-534524")));
    await assertFails(getDoc(doc(asUser("user"), "content_reports/user-1_p-534524")));
    await assertFails(getDoc(doc(asGuest(), "content_reports/user-1_p-534524")));
    await assertFails(getDocs(collection(asUser("user-1"), "content_reports")));
    await assertFails(getDocs(query(collection(asUser("user-1"), "content_reports"), where("uid", "==", "user-1"))));
    await assertFails(getDocs(collection(asUser("dev-1"), "content_reports")));

    await assertSucceeds(getDocs(collection(asUser("admin-1"), "content_reports")));
    await assertSucceeds(
      updateDoc(doc(asUser("admin-1"), "content_reports/user-1_p-534524"), {
        status: "actioned",
        action: "blur",
        reviewedBy: "admin-1",
        reviewedAt: serverTimestamp(),
      })
    );
    await assertFails(updateDoc(doc(asUser("dev-1"), "content_reports/user-1_p-534524"), { status: "dismissed" }));
  });
});

describe("everything else", () => {
  test("the backend-only subscription collections are closed to every client", async () => {
    for (const path of [
      "subscription_store_state/slot-1",
      "subscription_migration_runs/run-1",
      "subscription_purchase_ownership/own-1",
    ]) {
      await assertFails(getDoc(doc(asUser("admin-1"), path)));
      await assertFails(setDoc(doc(asUser("admin-1"), path), { value: 1 }));
    }
  });

  test("a collection with no rule of its own is closed", async () => {
    await assertFails(getDoc(doc(asUser("admin-1"), "unlisted_collection/doc-1")));
    await assertFails(setDoc(doc(asUser("user-1"), "unlisted_collection/doc-1"), { value: 1 }));
  });
});

test("the rules under test are the repo's, unless a copy was asked for", () => {
  assert.ok(fs.existsSync(rulesPath), `${rulesPath} is missing`);
});
