# Mantooq secure subscription backend

This implementation is local only. It has not deployed functions or rules,
configured an external console, or read or written production Firestore data.
It does not modify `subscriptions_manual`.

## Extracted project configuration

- Firebase project ID: `mantooq-test`
- Project number: `1008654973131`
- Functions region: `europe-west2`
- Language/runtime: TypeScript on Node.js 22
- Functions API: first-generation namespaced `firebase-functions`, declared
  as `^4.8.0` and resolved by the existing lock range to 4.9
- Existing rules source: absent from this repository, `firebase.json`, and
  inspected Git history
- Existing secrets: lowercase Secret Manager IDs read through
  `@google-cloud/secret-manager`
- Existing logging: `functions.logger` in wrappers plus unstructured console
  logging in older handlers; the new backend uses only structured
  `functions.logger` records
- Existing Pub/Sub conventions: none
- Existing Apple/Google server integration: none
- Existing App Check configuration: none
- Existing deployment scripts: `npm run build`, `npm run serve`, and
  `npm run deploy`

The configured, allowlisted recurring products are:

- Apple bundle `com.ktc.MantooqAppiOS`, numeric app ID `1624497481`,
  products `monthly_sub` and `yearly_sub`
- Google package `ca.basira.mantooqapp`, product `premium_access`, recurring
  base plans `monthly` and `yearly`

Apple transactions must report `Auto-Renewable Subscription`. Google line
items must contain `autoRenewingPlan`, must not contain `prepaidPlan`, and
must identify the allowlisted `monthly` or `yearly` base plan.
Anything else, including an allowlisted ID configured as a one-time/prepaid
product, is rejected.

## Functions

All four exports use the existing first-generation API, region, and camelCase
naming convention. They use the dedicated runtime identity
`subscription-verifier@mantooq-test.iam.gserviceaccount.com`.

### `getSubscriptionAccountBinding`

Authenticated callable request:

```json
{ "platform": "apple" }
```

`platform` is exactly `apple` or `google`; additional fields are rejected.
Response:

```json
{
  "platform": "apple",
  "accountBindingId": "deterministic-store-safe-value",
  "version": 1
}
```

The value is a domain-separated HMAC-SHA256 of the authenticated Firebase UID.
Apple receives a deterministic UUID and Google receives a base64url identifier
shorter than 64 characters. The raw UID is never sent to either store.

### `verifySubscription`

Authenticated Apple request:

```json
{
  "platform": "apple",
  "signedTransaction": "verificationData.serverVerificationData"
}
```

Authenticated Google request:

```json
{
  "platform": "google",
  "purchaseToken": "verificationData.serverVerificationData"
}
```

The callable obtains the UID only from Firebase callable authentication. It
rejects any additional field, including a client UID, status, expiration, or
active flag.

Successful response:

```json
{
  "subscription": {
    "active": true,
    "status": "active",
    "platform": "google",
    "productId": "premium_access",
    "expiresAt": "2026-08-24T00:00:00.000Z",
    "autoRenewing": true,
    "inGracePeriod": false,
    "environment": "production",
    "purchaseReference": "non-sensitive-sha256-reference",
    "lastStoreEventAt": "2026-07-24T00:00:00.000Z",
    "lastVerifiedAt": "2026-07-24T00:00:00.000Z",
    "createdAt": "2026-07-24T00:00:00.000Z",
    "updatedAt": "2026-07-24T00:00:00.000Z"
  }
}
```

Callable timestamps are ISO-8601 strings. Firestore values are native
timestamps. Ownership conflicts use `already-exists`, returned account-binding
mismatches use `permission-denied`, malformed input uses `invalid-argument`,
store rejection uses `failed-precondition`, and retryable store failures use
`unavailable`.

### `manageSubscriptionDevice`

Authenticated callable that manages the device list attached to a user's
subscription. Enforcement is client-side for now: the app reads its own
`subscription_master` doc and checks that its device ID is listed.

Request: `{ "action": "register" | "unregister", "deviceId": "..." }`
(`deviceId` is a client-generated identifier, trimmed, 1-128 characters).
The user must already have a `subscription_master` doc, otherwise
`failed-precondition` with details `{ code: "subscription-not-found" }`.

- `register` succeeds while the device count is below the maximum and is
  idempotent for an already-registered device. At the limit it fails with
  `resource-exhausted` and details `{ code: "device-limit-reached", maxDevices }`.
- `unregister` removes a device and records the removal time. Because any
  replacement requires removing a device first, removal is rate-limited: one
  removal per cooldown window. Inside the window it fails with
  `failed-precondition` and details
  `{ code: "device-replacement-cooldown", nextAllowedAt }`. Unregistering a
  device that is not listed is a no-op and does not consume the cooldown.

Both limits are read from `settings/mantooqAppSettings`:

```json
{
  "subscription": {
    "max_number_of_devices": 2,
    "days_before_replacing_device": 7
  }
}
```

Missing or invalid values fall back to those defaults (2 devices, 7 days).
The effective maximum also adds the user's `extra_device_seats` field when a
future extra-seat purchase flow sets it on the master doc.

Response:

```json
{
  "devices": {
    "action": "register",
    "changed": true,
    "allowed_devices": ["device-a", "device-b"],
    "max_number_of_devices": 2,
    "last_date_replacing_device": "2026-08-24T00:00:00.000Z",
    "next_replacement_allowed_at": "2026-08-31T00:00:00.000Z"
  }
}
```

### `appleSubscriptionNotifications`

First-generation HTTPS endpoint:

`https://europe-west2-mantooq-test.cloudfunctions.net/appleSubscriptionNotifications`

It accepts App Store Server Notifications V2 `{ "signedPayload": "..." }`.
Apple's certificate chain, bundle, numeric app ID, environment, product, and
auto-renewable type are verified. The signed transaction is then used to query
Get All Subscription Statuses. Valid test or unclaimed notifications are
acknowledged without granting access.

### `googleSubscriptionNotifications`

First-generation Pub/Sub function triggered by:

`projects/mantooq-test/topics/mantooq-play-subscription-notifications`

RTDN is a change signal only. The handler validates the fixed package, gets the
current purchase through `purchases.subscriptionsv2.get`, follows the linked
token chain, and then resolves ownership. Invalid permanent messages are
acknowledged; transient API/configuration failures throw so the function's
retry policy can redeliver.

## Firestore

`subscription_master/{firebaseUid}` is overwritten as an exact projection.
It contains only:

- `active`, `status`, `platform`, `productId`
- `expiresAt`, optional `autoRenewing`, `inGracePeriod`, `environment`
- Apple-only `originalTransactionId`
- Google-only `purchaseReference` (SHA-256, never a token)
- `lastStoreEventAt`, `lastVerifiedAt`, `createdAt`, `updatedAt`
- Device-management fields owned by `manageSubscriptionDevice`, preserved
  across store-driven rebuilds: `allowed_devices`,
  `last_date_replacing_device`, and future `extra_device_seats`

Protected collections:

- `subscription_purchase_ownership/{hashedStableIdentifier}` stores the owning
  `uid`. Apple records retain the protected original transaction ID. Google
  records retain protected current/linked raw tokens only because RTDN
  replacement-chain resolution requires them.
- `subscription_store_state/{hashedUid_platform_environment}` stores current
  state independently for each platform and environment.
- `subscription_store_events/{hashedEventKey}` stores minimal deduplication
  metadata only.

After external verification, one Firestore transaction reads every ownership
record in the verified chain before writing anything. Unclaimed records are
assigned to the authenticated UID. Repeats by the same UID are idempotent. Any
different UID or conflicting linked-token owner aborts all writes. Purchases
are never transferred automatically.

The master projection chooses an active production state before an active
sandbox/test state, then the furthest expiry. When no state is active, it uses
the most recently verified inactive state. Older notifications cannot regress
the relevant per-store state. Cancellation disables renewal but preserves
access until paid expiration.

## Firestore rules blocker

`docs/firestore_subscription_rules.patch` contains the required match blocks,
but is intentionally not referenced from `firebase.json`. Deploying a partial
rules file could replace unrelated deployed rules. Before any rules deployment:

1. Reauthenticate the Firebase CLI or otherwise export the complete deployed
   rules.
2. Add that complete source to the repository.
3. Merge the patch and preserve the current `subscriptions_manual` behavior.
4. Inspect every wildcard/catch-all allow because a matching allow elsewhere
   overrides a denial in this patch.
5. Run Firestore emulator rule tests for own-document get, cross-user/list/write
   denial, all protected collection denials, and unchanged manual access.

## Required secrets and IAM

Create these uppercase Secret Manager entries locally:

- `APPLE_APP_STORE_ISSUER_ID`
- `APPLE_APP_STORE_KEY_ID`
- `APPLE_APP_STORE_PRIVATE_KEY`
- `SUBSCRIPTION_ACCOUNT_BINDING_HMAC_KEY` (at least 32 random bytes)

Treat the HMAC key as durable account-linking infrastructure. Rotating it
changes future store-binding values and therefore requires an explicit,
versioned migration plan.

Do not paste any secret into chat, commit it, put it in a Flutter asset, or log
it. Use local prompts for short values and `--data-file` for files:

```sh
firebase functions:secrets:set APPLE_APP_STORE_ISSUER_ID
firebase functions:secrets:set APPLE_APP_STORE_KEY_ID
firebase functions:secrets:set APPLE_APP_STORE_PRIVATE_KEY --data-file=/secure/local/path/SubscriptionKey_KEYID.p8
firebase functions:secrets:set SUBSCRIPTION_ACCOUNT_BINDING_HMAC_KEY --data-file=/secure/local/path/subscription-hmac-key
```

The dedicated runtime service account needs `roles/datastore.user`,
`roles/logging.logWriter`, and `roles/secretmanager.secretAccessor` on the four
secrets. The deployer needs permission to act as that service account. Google
Play API calls use Application Default Credentials; do not create or deploy a
JSON service-account key.

After checking whether each resource already exists, an authorized operator
can apply the GCP side with:

```sh
gcloud iam service-accounts create subscription-verifier \
  --display-name="Mantooq subscription verifier" \
  --project=mantooq-test

gcloud services enable androidpublisher.googleapis.com pubsub.googleapis.com secretmanager.googleapis.com \
  --project=mantooq-test

gcloud projects add-iam-policy-binding mantooq-test \
  --member=serviceAccount:subscription-verifier@mantooq-test.iam.gserviceaccount.com \
  --role=roles/datastore.user
gcloud projects add-iam-policy-binding mantooq-test \
  --member=serviceAccount:subscription-verifier@mantooq-test.iam.gserviceaccount.com \
  --role=roles/logging.logWriter

gcloud secrets add-iam-policy-binding APPLE_APP_STORE_ISSUER_ID \
  --member=serviceAccount:subscription-verifier@mantooq-test.iam.gserviceaccount.com \
  --role=roles/secretmanager.secretAccessor --project=mantooq-test
gcloud secrets add-iam-policy-binding APPLE_APP_STORE_KEY_ID \
  --member=serviceAccount:subscription-verifier@mantooq-test.iam.gserviceaccount.com \
  --role=roles/secretmanager.secretAccessor --project=mantooq-test
gcloud secrets add-iam-policy-binding APPLE_APP_STORE_PRIVATE_KEY \
  --member=serviceAccount:subscription-verifier@mantooq-test.iam.gserviceaccount.com \
  --role=roles/secretmanager.secretAccessor --project=mantooq-test
gcloud secrets add-iam-policy-binding SUBSCRIPTION_ACCOUNT_BINDING_HMAC_KEY \
  --member=serviceAccount:subscription-verifier@mantooq-test.iam.gserviceaccount.com \
  --role=roles/secretmanager.secretAccessor --project=mantooq-test
```

Grant the actual deployment principal
`roles/iam.serviceAccountUser` on the dedicated service account. Its member
string cannot be extracted from this repository and is intentionally left for
the operator to supply.

The three committed files in `certs/apple/` are public Apple root
certificates, not credentials.

## Apple configuration

1. In App Store Connect, create or confirm an In-App Purchase API key and store
   its issuer ID, key ID, and `.p8` key only in the secrets above.
2. Confirm both allowlisted products remain in one or more auto-renewable
   subscription groups. The backend does not need a group ID, but the current
   group identifiers are not present in this repository.
3. After the function is deployed and tested, configure the same V2 URL for
   Sandbox and Production:
   `https://europe-west2-mantooq-test.cloudfunctions.net/appleSubscriptionNotifications`
4. Send an App Store Connect test notification, then exercise renewal,
   cancellation, billing retry/grace, expiration, refund, and revocation in
   sandbox before enabling the production URL.

Still missing externally: issuer ID, key ID, private-key secret, subscription
group information, sandbox setup, and server-notification configuration.

## Google Play and Pub/Sub configuration

1. Enable `androidpublisher.googleapis.com`.
2. Create the dedicated runtime service account if it does not exist.
3. Invite that service account in Play Console, give it access to
   `ca.basira.mantooqapp`, and grant the purchase/order and subscription
   permissions required to read subscription status.
4. Create
   `projects/mantooq-test/topics/mantooq-play-subscription-notifications`.
5. Grant
   `google-play-developer-notifications@system.gserviceaccount.com`
   `roles/pubsub.publisher` on that topic.
6. Configure Play Console RTDN to that fully qualified topic for subscriptions
   and voided purchases, then send a test notification.
7. Confirm the exact active recurring base plan and client offer token for
   `premium_access`, and test with a license tester.

The Pub/Sub commands, after confirming the topic is absent or already correct,
are:

```sh
gcloud pubsub topics create mantooq-play-subscription-notifications \
  --project=mantooq-test
gcloud pubsub topics add-iam-policy-binding mantooq-play-subscription-notifications \
  --member=serviceAccount:google-play-developer-notifications@system.gserviceaccount.com \
  --role=roles/pubsub.publisher \
  --project=mantooq-test
```

Still missing externally: service-account Play access, the Pub/Sub topic,
publisher IAM, exact base-plan/offer selection, RTDN configuration, and test
configuration.

## Deployment order (only after explicit authorization)

1. Recover, merge, regression-test, and review the complete Firestore rules.
2. Create the runtime service account, IAM, API enablement, secrets, Pub/Sub
   topic, and Play access.
3. Run `npm test`, review `npm audit`, and run local/emulator integration
   tests. The non-breaking audit remediation is included in this lockfile; 10
   moderate transitive advisories remain because npm's suggested fixes require
   breaking Firebase Admin/test-library changes and must be assessed separately.
4. Deploy only the reviewed complete rules:
   `firebase deploy --only firestore:rules --project mantooq-test`
5. Deploy only the four functions:
   `firebase deploy --only functions:getSubscriptionAccountBinding,functions:verifySubscription,functions:appleSubscriptionNotifications,functions:googleSubscriptionNotifications --project mantooq-test`
6. Configure Apple Sandbox V2 and Google RTDN, then execute store tests.
7. Configure Apple Production V2.
8. Release the Flutter integration.

## Flutter integration

1. Authenticate with Firebase before any purchase or restore.
2. Before a new purchase, call `getSubscriptionAccountBinding` for the current
   platform and pass `accountBindingId` as
   `PurchaseParam.applicationUserName`. The inspected plugin maps it to Apple
   `appAccountToken` and Google `obfuscatedAccountId`.
3. For Google, also select and pass the offer token for the intended recurring
   base plan. That exact base-plan/offer selection is still missing.
4. For every allowlisted `purchased` or `restored` item, call
   `verifySubscription` with:
   - Apple: `verificationData.serverVerificationData` as `signedTransaction`
   - Google: `verificationData.serverVerificationData` as `purchaseToken`
5. Do not send a UID or any client status/expiry. Grant premium and call
   `completePurchase` only after the callable succeeds.
6. After Firebase sign-in, automatically restore/query existing purchases and
   verify every returned allowlisted purchase. Historical purchases without a
   store binding remain claimable; a returned mismatching binding is rejected.
7. Listen to `subscription_master/{FirebaseAuth.currentUser.uid}` and require
   both `active == true` and a future `expiresAt`.
8. Combine that entitlement independently with the unchanged
   `subscriptions_manual` entitlement. Keep visible Restore Purchases as a
   fallback.

Users who never reopen the app cannot be linked unless a trustworthy
UID-to-store-purchase mapping already exists.

## Security note outside this implementation

The sibling mobile repository has a tracked service-account JSON asset at
`../Mantooq_Mobile/assets/mantooq-test.json`. It must not be reused. Key
revocation/rotation, removing it from the app, and Git-history cleanup require a
separate explicitly authorized security task.
