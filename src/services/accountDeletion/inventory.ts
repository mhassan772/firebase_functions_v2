/**
 * Everything an account's deletion removes or anonymises, in one reviewed place.
 *
 * Built from `firestore.rules`, the app's `firebase_keys.dart` and the writers in this repo. A
 * new kind of per-user data is not deleted until it is listed here. See docs/account_deletion.md.
 */

/**
 * Deleted before anything else.
 *
 * Deleting a `listening_history` chunk fires `listeningDaysMonthTrigger`, which writes the
 * month's value back into this document whenever it still holds an entry for that month. With
 * the document gone first, the recomputed value is 0 and nothing is written.
 */
export const LISTENER_TOTALS_COLLECTION = "listener_totals";

/** Documents whose id is the uid, each deleted with all of its subcollections. */
export const UID_KEYED_COLLECTIONS = [
  "users",
  "favourites",
  "favorites_v2",
  "playback_progress",
  "playback_progress_v2",
  "episode_progress",
  "converted_podcasts",
  "podcast_subscriptions",
  "episodes_lists",
  "pdf_progress",
  "completed_book",
  "completed_books_v2",
  "archived_episodes",
  "blocked_content",
  "playlists",
  "playlists_v2",
  "routines",
  "routine_activity",
  "listen_times",
  "device_sessions",
  "device_sessions_v2",
  "user_settings",
  "listening_history",
  "bookmarks",
  "user_books",
  "subscription_master",
  "url_grants",
  "users_my_mantooq",
  "user_store_country",
  "re_banned_users",
  // The older shape of likes and flags, nested under the uid, which has no user_guid field for
  // the query below. The flat shape is in FIELD_KEYED_COLLECTIONS.
  "re_user_liked_comments",
  "re_user_flagged_comments",
] as const;

/**
 * Holds the device ids the device step needs, so it is deleted only after that step has gone
 * through in the same run; otherwise it waits for the next run.
 */
export const URL_GRANTS_COLLECTION = "url_grants";

/** Documents found by an equality query on the field that holds the uid. */
export const FIELD_KEYED_COLLECTIONS: readonly { collection: string; field: string }[] = [
  { collection: "book_listeners", field: "user_guid" },
  { collection: "podcast_listeners", field: "user_guid" },
  { collection: "podcast_audit", field: "user_guid" },
  { collection: "converted_podcast_audit", field: "user_guid" },
  { collection: "re_review_content", field: "user_guid" },
  { collection: "re_user_liked_comments", field: "user_guid" },
  { collection: "re_user_flagged_comments", field: "user_guid" },
  { collection: "reporting_issues", field: "user_guid" },
  { collection: "auto_reported_issues", field: "userId" },
  { collection: "shared_collections", field: "ownerUid" },
  { collection: "content_reports", field: "uid" },
  // Older user documents whose id is not the uid.
  { collection: "users", field: "id" },
];

/** Where `url_grants/{uid}.devices` points: one document per device, shared by every guest on it. */
export const URL_GRANTS_DEVICES_COLLECTION = "url_grants_devices";

/**
 * Subscription records found by their `uid` field.
 *
 * Ownership is deleted, not kept: a store purchase stays live after the account is gone, and
 * while its ownership record names the deleted uid no other account can restore it.
 */
export const SUBSCRIPTION_UID_FIELD_COLLECTIONS: readonly { collection: string; field: string }[] = [
  { collection: "subscription_acknowledgements", field: "uid" },
  { collection: "subscription_purchase_ownership", field: "uid" },
];

/**
 * Manual payment requests, kept with the payer's identity and free text removed.
 *
 * They are the record of money received, which the admin portal's stats and bookkeeping still
 * count. Amount, method, duration, status, dates and country stay.
 */
export const PAYMENT_REQUEST_COLLECTIONS = ["subscriptions_to_be_approved", "subscription_migration_restoration"] as const;
export const PAYMENT_REQUEST_UID_FIELD = "user_guid";
/** `subscription_id` is a hash of the uid, so it identifies the payer as well as `user_guid`. */
export const PAYMENT_REQUEST_STRIPPED_FIELDS = [
  "user_guid",
  "subscription_id",
  "phone_number_sent_from",
  "notes",
  "admin_notes",
  "photo_link",
] as const;
export const PAYMENT_REQUEST_ANONYMISED_FIELD = "anonymised_at";

/**
 * Storage folders whose uploads are named `<folder>/<uid>_<time>_<file>`.
 *
 * Deleting by the `<uid>_` prefix is exact only because a uid is letters and digits; the purge
 * refuses any other uid. Paths stored on documents are never followed: every upload handler
 * names its file with this prefix, and a stored path could name another account's file.
 */
export const STORAGE_UID_PREFIX_FOLDERS = ["subscriptions", "restoreSubscriptionMigration", "reportingIssues", "logFiles"] as const;
