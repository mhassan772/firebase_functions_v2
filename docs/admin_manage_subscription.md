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

Region `europe-west2`, 540 s timeout. Caller must be signed in and have
`users_adminv2/{uid}.role == "admin"`. Every request is `{ action, ...fields }`
with exactly the fields listed; extra fields are rejected.

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
| `migrateLegacy` | `runId, dryRun: true` | `MigrationReport` (the plan; this action never writes) |
| `importLegacyRows` | `runId, rows: [{ docId, uid }]` (1 to 200, the plan's `imported` rows) | `MigrationReport` |
| `getMigrationRun` | `runId` | `MigrationReport` |

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
`not-subscription-admin`, `migration-run-exists` (a live run id was reused; pick a new one),
`queue-id-invalid`.

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
