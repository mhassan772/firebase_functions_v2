# Account deletion

Deleting an account removes its data from Firestore and Storage, removes its sign-in from Firebase Auth and, when the app asked for it, sends a confirmation email. The contract shared with the app is `docs/ai/plans/26-11-10/web-accounts-stage-b-spec.md` in the Mantooq_Mobile repo. This page covers the server side.

What is deleted is listed in one place, `src/services/accountDeletion/inventory.ts`. A new kind of per-user data is not deleted until it is listed there.

## Functions

| Function | Kind | What it does |
|---|---|---|
| `deleteAccount` | Callable, europe-west2 | The app's delete. Purges, deletes the Auth user, sends the confirmation. 540 s, 512 MB, with the SES secrets and `STRIPE_WEB_SECRET_KEY`. |
| `accountDeletedCleanup` | Auth `onDelete` | Runs the same purge whenever an Auth user is deleted by any route, including app versions that delete the sign-in themselves and deletions in the console. No retry, no email. 540 s, 512 MB, at most 5 instances, with `STRIPE_WEB_SECRET_KEY`. |
| `sweepDeletedAccounts` | Scheduled, every Monday 03:00 UTC | Purges every open deletion again and closes the clean ones. 540 s, 512 MB, with `STRIPE_WEB_SECRET_KEY`. |

None of them runs as a custom service account.

### `deleteAccount`

Request: `{ "lang": "en" }`, where `lang` is optional and anything other than `en` gives an Arabic email. Response: `{ "deleted": true }`.

The caller must be signed in, not anonymous, and signed in within the last five minutes. App Check is logged, not enforced.

| Code | `details.reason` | When |
|---|---|---|
| `unauthenticated` | `signed_out` or `anonymous` | No caller, or an anonymous one |
| `permission-denied` | `recent_login_required` | The sign-in is older than five minutes |
| `invalid-argument` | `invalid_request` | Not a plain object, unknown keys, or a `lang` that is not a string |
| `internal` | none | The purge or the Auth deletion failed |

Steps: read the account's email from Auth; purge with the tombstone `pending`; delete the Auth user (one already gone is not an error); mark the tombstone `deleted`; send the confirmation. A failed purge or Auth deletion returns `internal` and leaves the tombstone `pending`, and the weekly cleanup finishes the deletion, sign-in included. A failed email is logged and the call still succeeds.

### `accountDeletedCleanup`

It records the tombstone as `deleted` and runs the purge. At most 5 instances run at once, so a bulk deletion from the console, or Firebase's automatic clean-up of anonymous users, cannot start hundreds of purges together. A failure leaves the tombstone open for the weekly cleanup.

A guest, with no email and no sign-in provider, has its tombstone closed in the same run when the purge is ok: a guest holds no entitlement to claim again, and purging every deleted guest again each week could outgrow the cleanup's time budget. A guest whose purge failed a step, and every other account, stays open for the weekly cleanup.

### The confirmation email

The confirmation, in Arabic or English, has no link or button. It says the account and its data were deleted, that a store subscription is not cancelled by this and must be cancelled in the App Store or Google Play, and that anything a signed-in device wrote afterwards is removed within 7 days.

## The tombstone

`deleted_accounts/{uid}` is written by the purge and has no rules entry, so no client reads or writes it. It holds no email, name or other personal field.

| Field | Meaning |
|---|---|
| `state` | `pending` while the sign-in may still exist, `deleted` once it does not. `deleted` never goes back to `pending`. |
| `deletedAt` | When the first purge started. Set once. |
| `lastRunAt` | When the latest purge started. |
| `lastRunOk` | Whether the latest purge finished with no step failing. |
| `runs` | Purges run so far. |
| `closedAt` | Set by the weekly cleanup; absent while open. |

`persistVerifiedSubscription` reads the tombstone in its transaction. While it exists, in either state, a store purchase is refused before anything is written, with a `SubscriptionError` of kind `forbidden` and safe code `account-deleted`; `verifySubscription` returns it as `permission-denied`. A device that stays signed in after the deletion therefore cannot claim a purchase for the deleted account again.

The Apple and Google notification paths, and the reconcile pass that replays them, treat that refusal as a purchase nobody owns: the event is recorded unclaimed with `recordUnclaimedStoreEvent`, Apple is answered 200 and Pub/Sub is acknowledged, instead of Apple retrying on a 400 and Pub/Sub redelivering for up to seven days. The path's usual outcome log carries `claimed: false` and `ownerDeleted: true`.

## The purge

`purgeAccount` in `src/services/accountDeletion/purge.ts`. It refuses a uid that is not 20 to 40 letters and digits, because Storage is deleted by a `<uid>_` prefix. Every step runs even when an earlier one failed, every step can be repeated, and the run is ok only when no step failed. Its logs are `account_purge_start`, `account_purge_step_failure` (step, target and error code), and `account_purge_success` or `account_purge_failure` with the count per step. They carry the uid and codes, never error messages, addresses or paths.

Order:

1. Open the tombstone.
2. Read the device ids in `url_grants/{uid}.devices`.
3. Delete the account's Stripe customer for the key's mode, named in `web_customers/{uid}`, which cancels its web subscriptions at once with no refund. No mapping means no Stripe call, so an account that never bought on the web needs no key. A customer already deleted is not an error. A mapping with no key configured fails the step, and so does a Stripe error; `web_customers/{uid}` is then kept for the next run (see step 6).
4. Delete `listener_totals/{uid}`. First, because deleting a `listening_history` chunk fires `listeningDaysMonthTrigger`, which writes a month's value back into this document while it still holds an entry for that month.
5. Remove the uid from `guestUids` on each `url_grants_devices` document read in step 2 and set `guestUidsCount` to what remains, in a transaction. The documents themselves stay.
6. Delete the documents keyed by uid, each with all of its subcollections: `users`, `favourites`, `favorites_v2`, `playback_progress`, `playback_progress_v2`, `episode_progress`, `converted_podcasts`, `podcast_subscriptions`, `episodes_lists`, `pdf_progress`, `completed_book`, `completed_books_v2`, `archived_episodes`, `blocked_content`, `playlists`, `playlists_v2`, `routines`, `routine_activity`, `listen_times`, `device_sessions`, `device_sessions_v2`, `user_settings`, `listening_history`, `bookmarks`, `user_books`, `subscription_master`, `url_grants`, `users_my_mantooq`, `user_store_country`, `re_banned_users`, and `re_user_liked_comments` and `re_user_flagged_comments` for their older shape nested under the uid; and the two `auth_email_throttle` counters, the address one only when the email is known. `web_customers/{uid}` and the purchase throttle's `web_purchase_throttle/uid_<uid>` are deleted only when step 3 went through in this run, since the mapping is the only way back to the Stripe customer; otherwise they are left and the step counts as failed. `url_grants/{uid}` holds the device ids, so it is deleted only when steps 2 and 5 both went through in this run; otherwise it is left for the next run and the step counts as failed.
7. Delete the documents found by a field holding the uid: `user_guid` on `book_listeners`, `podcast_listeners`, `podcast_audit`, `converted_podcast_audit`, `re_review_content`, `re_user_liked_comments`, `re_user_flagged_comments` and `reporting_issues`; `userId` on `auto_reported_issues`; `ownerUid` on `shared_collections`; `uid` on `content_reports`; and `id` on `users`, for older user documents whose id is not the uid.
8. Delete the subscription records: every slot document in `subscription_store_state`, the hashed and the raw-uid documents in `subscriptions_manual`, and `subscription_acknowledgements` and `subscription_purchase_ownership` where `uid` is the account.
9. Anonymise the payment requests in `subscriptions_to_be_approved` and `subscription_migration_restoration`, and remove `uid` from the account's `web_purchases` entries, setting `anonymised_at`.
10. Delete every Storage object in bucket `mantooq-images-p` whose name starts with `<folder>/<uid>_` under `subscriptions/`, `restoreSubscriptionMigration/`, `reportingIssues/` and `logFiles/`. Paths stored on documents are not followed: every upload handler names its file with that prefix, and a stored path could name another account's file.
11. Record `lastRunOk` on the tombstone.

## What is anonymised

The web purchase ledger is kept for the same reason: it holds no email, name, card number or address line, and only `uid` is removed. Its Stripe customer id points at a customer that step 3 deleted.

The manual payment requests are the record of money received, so they stay. `user_guid`, `subscription_id` (a hash of the uid), `phone_number_sent_from`, `notes`, `admin_notes` and `photo_link` are removed and `anonymised_at` is set; amount, method, duration, status, dates and country stay. The portal cannot approve an anonymised request, since it no longer names an account.

## What is kept, and why

- `url_grants_devices` documents. They hold a device's audio allowance, shared by every guest on that device; only the uid's entry is removed.
- Purchase ownership is not kept: deleting it lets a new account restore a store purchase that is still live.
- `subscription_store_events`, which holds no uid.
- Review totals in `re_review_book` and like counts on other users' reviews, which are aggregates.
- Public and admin statistics, which hold counts only.

## Known gaps

- `subscription_migration_runs` rows and `url_policy_digest` documents can name a uid.
- `feedbacks` and `system_time` have no known writer or shape.

## The weekly cleanup

A device that is still signed in when the account is deleted keeps an ID token that passes the Firestore rules for up to an hour, so it can write again after the purge. `sweepDeletedAccounts` clears that.

For each tombstone without `closedAt` whose `deletedAt` is more than 75 minutes old, oldest first, it runs the purge, deletes the Auth user if it still exists and sets `state` to `deleted`, and sets `closedAt` when both went through. A failed run is tried again the next week. It stops starting new purges once about 420 s of its 540 s are used and leaves the rest for the next week. It then deletes tombstones closed more than 90 days ago. It logs `account_sweep_success` with how many were closed, failed, left and removed.
