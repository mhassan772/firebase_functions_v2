# `adminManageSubscription` and the manual slot

Manual (admin) grants are a fifth projection slot beside the four store slots.
Every admin action goes through one callable; the portal never writes
subscription data from the browser.

## Data model

- `subscription_store_state/{sha256b64url(uid)}_manual_production`: the manual
  slot. Same normalized fields as a store slot (`active`, `status`, `platform:
  "manual"`, `productId: "manual_grant"`, `expiresAt`, `environment:
  "production"`, `autoRenewing: false`, `lastStoreEventAt`, `lastVerifiedAt`),
  plus the **grant ledger**: `grants[]`, `ledgerRevision`, `recentOperations[]`
  (last 50 operation ids) and `manual: { activeGrantCount, grantSource,
  ledgerRevision }`.
- `subscription_master/{uid}`: unchanged shape, plus `sources[]`, one row per
  existing slot: `{ platform, environment, status, expiresAt, autoRenewing? }`.
  No `active` field on a row: readers derive activity from `expiresAt` and
  `status`, because a manual grant lapses with no write to flip a flag. The
  top-level `platform` flips between `manual` and a store as whichever ends
  later; UI copy should come from `sources`.
- `subscriptions_manual/{sha256hex(uid)}`: legacy. Mirrored to by every manual
  mutation while `LEGACY_MIRROR_ENABLED` is true (`expires`, `user_guid`,
  `source: "subscription_master_mirror"`, `mirrored_at`). Imported once as the
  account's baseline grant; never read back after that.
- `subscription_migration_runs/{runId}`: legacy migration reports.

### Ledger

Each grant: `{ grantId, kind: "months" | "absolute", months?, expiresAt?,
base: "extend" | "today", grantedAt, grantedBy, grantSource, queue?: {
collection, id }, metadata, status: "active" | "reversed" | "revoked",
statusChangedAt?, statusReason? }`.

The manual expiry is **replayed** from the active grants in `grantedAt` order:
a `months` grant with base `extend` adds its months to the later of its own
date and the running end; base `today` adds them to its own date; an
`absolute` grant moves the running end forward to its date. Store dates are
never an input. Reversing a grant preserves every other grant's purchased
duration, re-anchored as if the reversed grant had never existed.

Grant ids: `${queueCollection}_${queueId}_r${revision}` for approvals (one
record per approval of a request), the portal's per-press UUID for manual
adds, `legacy_${docId}` for the baseline.

## Callable

Region `europe-west2`, 540 s timeout. Caller must be signed in and hold the
`admin` portal role. Roles are read from `users_adminv2/{uid}`: a `roles` list
alone decides, otherwise the legacy `role` string (`src/utils/adminRole.ts`,
mirrored by the helpers at the top of `firestore.rules`). Every request is `{ action, ...fields }` with exactly the fields listed;
extra fields are rejected.

A caller whose roles include `egypt-subscription-approval` but not `admin` may
use only `get`, `grant` with a `queue`, `adjust` and `reverseRequest`, and the
last two only on a grant that came from a queue request (`grant.queue` set);
any other grant is refused with `grant-not-from-request`. Every other action is
refused with `not-subscription-admin`. The start log records `access: "admin"`
or `"queue"`.

`user` is `{ uid }` or `{ email }`, optionally with `hashedId` (the 64-hex id
the user pasted to support). The hash never finds an account; it only confirms
that the account found by uid or email is the one the user meant
(`hashed-id-mismatch` otherwise). The response's `user.hashConfirmed` says
whether a hash was checked.

Errors are `HttpsError` with `details.code` set to the safe code below.

| action | fields | returns |
|---|---|---|
| `get` | `user` | `{ user: ResolvedUser, account: AccountView }` |
| `grant` | `user, opId, intent, metadata, queue?` | `MutationResult` |
| `adjust` | `user, opId, grantId, targetMonths, expectedLedgerRevision` | `MutationResult` |
| `reverseRequest` | `user, opId, grantId, reason, expectedLedgerRevision` | `MutationResult` |
| `revokeAccess` | `user, opId, reason, expectedLedgerRevision` | `MutationResult` |
| `setBaseline` | `user, opId, expiresAt (ISO), reason, expectedLedgerRevision` | `MutationResult` |
| `listManual` | `limit?, startAfterUpdatedAt?` (the previous page's `nextStartAfterUpdatedAt`, an opaque `"<iso>|<docId>"` cursor) | `{ rows: ManualSlotListRow[], nextStartAfterUpdatedAt? }` |
| `refreshStats` | none | `{ generatedAt: ISO }` (rebuilds `subscription_stats/current` now; see Dashboard stats) |
| `migrateLegacy` | `runId, dryRun: true` | `MigrationReport` (the plan; this action never writes) |
| `importLegacyRows` | `runId, rows: [{ docId, uid }]` (1 to 200, the plan's `imported` rows) | `MigrationReport` |
| `getMigrationRun` | `runId` | `MigrationReport` |
| `listDevices` | `user` | `DevicesResult` |
| `removeDevice` | `user, deviceId` | `DevicesResult` (frees the seat; the user's cooldown is neither checked nor started) |
| `setExtraSeats` | `user, seats` (integer 0..10) | `DevicesResult` |
| `resetDeviceCooldown` | `user` | `DevicesResult` (clears `last_date_replacing_device`) |

- `opId`: 8 to 128 url-safe characters, generated per button press and reused
  only when retrying that same press. A repeated `opId` returns the earlier
  result with `replayedOperation: true`.
- `intent`: `{ kind: "months", months: 1..120, base: "extend" | "today" }` or
  `{ kind: "absolute", expiresAt: ISO }`. Dates are normalised to the end of the
  day in `Africa/Cairo`.
- `metadata`: `{ grantSource: "egypt_request" | "migration_restoration" |
  "admin_manual_add", paymentMethod?, amountPaid?, countryCode?, note? }`.
- `queue`: `{ collection: "subscriptions_to_be_approved" |
  "subscription_migration_restoration", id, expectedStatus? }`. The callable
  checks the request's current status against `expectedStatus`, that its
  `user_guid` is the resolved uid, and updates it in the same transaction
  (`status: "approved"`, `approved_months` on grant; `approved_months` on
  adjust; `status: "rejected"`, `admin_notes` on reverse).
- `expectedLedgerRevision`: the `manual.ledgerRevision` from the last `get`.
  Stale → `failed-precondition` / `ledger-revision-stale`; reload and retry.

### Device seats

The four device actions edit the seat fields on `subscription_master` directly;
they do not touch the grant ledger and take no `opId`, because each one is
idempotent by nature (removing a device that is gone, setting the seats it
already has or clearing a cooldown that is clear changes nothing and reports
`changed: false`). Every change appends `{ at, actor: "admin:<uid>", action,
deviceId?, seats? }` to `device_log`, capped at 20 rows, which the user's own
actions share under actor `user`. The account must have a master document
(`subscription-not-found` otherwise); it need not be active, so a lapsed
account can be tidied. `deviceId` is 1-128 characters (`device-id-invalid`);
`seats` outside 0..10 fails with `seats-invalid`. `removeDevice` on an id that
is not listed is a no-op.

`get` carries the same information on `account.master.devices`, so the card
needs no `listDevices` after loading an account. The limit comes from
`settings_app/subscription.max_number_of_devices` (default 2; the app reads the same document)
plus the account's `extra_device_seats`.

### Dashboard stats

`refreshStats` runs the same rebuild as the `refreshSubscriptionStats` job,
which runs daily at 23:55 Cairo (`src/services/subscriptions/stats.ts`). It scans the subscription
collections and both request queues, then writes `subscription_stats/current`,
the one document the dashboard reads, and the day's exact totals to
`subscription_stats_daily/{YYYY-MM-DD}` (Cairo days). Admins read both from the
client; nobody writes them except the backend. The document's shape is the
portal's `src/lib/subscriptionStatsTypes.ts`, and the field definitions are the
doc comment on `computeStats`. Past days without an archive row are estimated
and carry `estimated: true`.

### Shapes

```ts
ResolvedUser { uid, email?, displayName?, hashedId, resolvedBy: "uid" | "email", hashConfirmed }

AccountView {
  uid,
  master?: SubscriptionResponse,            // same as verifySubscription's, plus manual? and sources?
  sources: SourceRow[],                     // every existing slot; derive active from expiresAt/status
  manual: { exists, status: "active" | "expired" | "revoked" | "none", expiresAt?, activeGrantCount, ledgerRevision, grants: Grant[] },
  legacy: { docId, exists, expires?, isMirror, migratedAt? },
}
SourceRow { platform: "apple" | "google" | "manual", environment: "production" | "sandbox" | "test", status, expiresAt: ISO, autoRenewing? }
Grant { grantId, kind, months?, expiresAt?, base, grantedAt, grantedBy, queue?, metadata, status, statusChangedAt?, statusReason?, isLegacyBaseline }

MutationResult { user: ResolvedUser, replayedOperation: boolean, previousManualExpiresAt?: ISO, account: AccountView }

DeviceEntry { id, name, platform: "ios" | "android" | "unknown", registered_at?: ISO, last_seen_at?: ISO }
                                          // "unknown" and no dates: a seat registered before devices carried metadata
SubscriptionResponse.devices {            // on master in get and MutationResult; max_number_of_devices only in get
  allowed_devices: string[], devices: DeviceEntry[], max_number_of_devices?, extra_device_seats, last_date_replacing_device?: ISO }
DevicesResult {
  user: ResolvedUser,
  devices: { action, changed, max_number_of_devices, allowed_devices: string[], devices: DeviceEntry[],
             last_date_replacing_device?: ISO, next_replacement_allowed_at?: ISO },
}

ManualSlotListRow { uid, email?, status, expiresAt?, activeGrantCount, ledgerRevision, grantSource?, updatedAt? }

MigrationReport {
  runId, dryRun, status: "running" | "finished" | "failed", startedAt, finishedAt?, startedBy,
  totals: { imported, skipped_expired, skipped_ledger_exists, skipped_mirror, unresolved, mismatch, failed },
  rows: [{ docId, uid?, email?, expires?, resolution: "user_guid" | "raw_uid_doc_id" | "hash_scan" | "none",
           action: keyof totals, detail?, existingMaster?: { platform, expiresAt? }, rawUidDocId }],
  error?,
}
```

### Safe codes worth handling in the portal

`ledger-revision-stale`, `queue-status-changed`, `queue-already-approved`,
`queue-user-mismatch`, `unattributed-legacy-grant` (adjust or reverse on an
approval that predates the ledger; offer `setBaseline` or `revokeAccess`
instead), `grant-not-active`, `duration-unchanged`,
`hashed-id-mismatch`, `email-not-found`, `uid-not-found`, `manual-slot-disabled`,
`not-subscription-admin`, `grant-not-from-request`, `migration-run-exists` (a live run id was reused; pick a new one),
`queue-id-invalid`, `subscription-not-found` (device actions on an account with
no master), `seats-invalid`, `device-id-invalid`.

## Switches (`src/config/constants.ts`)

- `MANUAL_SLOT_ENABLED`: kill switch. False → the projection ignores the manual
  slot and admin mutations are refused.
- `LEGACY_MIRROR_ENABLED`: mirror manual expiries into `subscriptions_manual`
  for app versions before ~90.4.
- `ENVIRONMENT_PRIORITY_ENABLED`: production-over-sandbox ranking in
  `selectMasterState`. Ships false for the live sandbox stage, then true.

## Deploy

By name only:

```
firebase deploy --only functions:adminManageSubscription,functions:verifySubscription,functions:appleSubscriptionNotifications,functions:googleSubscriptionNotifications,functions:manageSubscriptionDevice,functions:egyptSubscription
firebase deploy --only firestore
```

Order: functions, portal, rules, migration (plan, review, then `importLegacyRows`
with the plan's rows; the import never re-resolves), app.
