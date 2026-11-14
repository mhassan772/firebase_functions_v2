# Web subscriptions

Premium bought on `accounts.mantooq.com` with a card through Stripe. The contract shared with the pages is `docs/ai/plans/26-11-10/web-accounts-stage-d-spec.md` in the Mantooq_Mobile repo, and the verified Stripe behaviour is `docs/ai/research/26-11-14/stripe-web-purchase-api-facts.md` there (stripe-node 23.1.0, API `2026-10-28.endive`). This page covers the backend.

Plans are `web_monthly`, `web_yearly` and `web_lifetime`, which are also the Stripe product ids and the slot's `productId`. Lifetime means 50 years from payment.

## Code

| Path | What it holds |
|---|---|
| `src/services/webSubscriptions/stripeGateway.ts` | `StripeGateway`, the only Stripe calls this feature makes; `liveStripeGateway(key)`; `stripeGatewayFromEnv()` |
| `src/services/webSubscriptions/sync.ts` | `syncWebEntitlement(uid)`, the derivation and the facts it reads |
| `src/services/webSubscriptions/pricing.ts` | The pricing config, tiers, the price lookup, totals, billing address and card rules |
| `src/services/webSubscriptions/customers.ts` | `web_customers` and the customer-to-uid check |
| `src/services/webSubscriptions/ledger.ts` | `web_purchases`, purchase ids, ledger statuses |
| `src/services/webSubscriptions/events.ts` | `web_stripe_events`, the handled event types |
| `src/services/webSubscriptions/purchaseThrottle.ts` | `web_purchase_throttle` |
| `src/services/webSubscriptions/pendingSweep.ts` | The reconcile sweep of pending purchases |
| `src/services/webSubscriptions/accountDeletion.ts` | The Stripe customer deletion the purge calls |
| `src/services/webSubscriptions/accountState.ts` | The slots the callables read, the page states and the purchase blockers |
| `src/handlers/webSubscriptionEventHandlers.ts` | The webhook and the event handler shared with reconcile |
| `src/handlers/webCallableCommon.ts` | What the five callables share: dependencies, the sales gate, verified email, throttle, token checks, decline categories, error handling |
| `src/handlers/webPurchaseHandlers.ts` | `getWebPlans`, `startWebPurchase`, `finishWebPurchase` |
| `src/handlers/webManageHandlers.ts` | `getWebSubscription`, `manageWebSubscription` |
| `src/functions/webSubscriptions/` | `stripeWebEvents`, the five callables, and the lazy live dependencies |
| `test/helpers/fakeStripeGateway.js` | The in-memory Stripe the tests use |
| `test/webPurchase.test.js`, `test/integration/webPurchase.test.js` | The callables, without Firestore and against the emulator |
| `scripts/stripe/verify-web-gateway.mjs` | The sandbox check of the live gateway, not part of `npm test` |
| `scripts/stripe/verify-web-purchase.mjs` | The callables end to end against the sandbox and the emulator, not part of `npm test` |

## Collections

All server-only. `web_pricing` and `web_purchases` are readable by portal admins; the others fall to the rules' catch-all deny.

**`web_pricing/config`**, set by hand in the console. Missing or malformed fields fall back to `DEFAULT_WEB_PRICING` in `pricing.ts`, which keeps sales off and charges the full price.

| Field | Default |
|---|---|
| `salesEnabled` | `false` |
| `taxEnabled` | `false` |
| `testers` | `[]`, uids allowed to buy while the key is a sandbox key |
| `tiers` | `standard` (rank 3), `reduced` (2), `low` (1), each `{rank, prices: {plan: lookupKey}}`; `low` sells no monthly |
| `countries` | DZ, IQ, JO, LB, LY, MA, TN, YE → `reduced`; EG, TR → `low` |
| `fullPriceTier` | `standard`, also the tier of an unknown country |
| `allowUnattestedSim` | `false`, read by store country |

Amounts are never in the config: each is read from the Stripe price with that lookup key and cached for ten minutes per instance.

**`web_customers/{uid}`**: `{testCustomerId?, liveCustomerId?, activePurchase?: {purchaseId, startedAt}, createdAt, updatedAt}`. `activePurchase` is the account's purchase lock (see `startWebPurchase`). It is never written for an account with a tombstone in `deleted_accounts`. The Stripe customer carries `metadata.uid`. A Stripe object is acted on only when its customer's `metadata.uid` has a mapping that names that same customer, so it is the ownership record; `subscription_purchase_ownership` is not used for web.

**`web_purchases/{purchaseId}`**, the ledger. `purchaseId` is the first 32 hex characters of `sha256(uid + ":" + confirmationTokenId)`, so a retried purchase call lands on the same entry. Statuses: `pending` → `paid` | `failed` | `abandoned`; `paid` → `refunded` | `disputed` | `dispute_lost`; `disputed` → `paid` when the dispute is won. A partial refund sets `partialRefund` (cents) and nothing else. No email, name, card number or address line is stored. An account's entries are read in pages of 200 by document id (no composite index), all of them, up to 2,000, past which the read stops with an error log (`web_ledger_read_capped`).

**`web_stripe_events/{eventId}`**: `{type, created, receivedAt, source, outcome, expiresAt}`, claimed in a transaction, so an existing document means the event was handled or is being handled. `outcome` is `processing` while handled, then `ignored` or `synced_<sync outcome>`. A claim still `processing` five minutes after `receivedAt` belongs to a handler that died, and the next delivery or reconcile run takes it over (`reclaimed: true`). Removed by a TTL policy on `expiresAt`, 90 days after receipt.

**`web_purchase_throttle/{uid_<uid> | ip_<sha256(ip)>}`**: `{kind, count, windowStart, lastAttemptAt, expiresAt}`, evaluated like `auth_email_throttle`: 10 attempts per uid and 30 per IP in 24 hours. Removed by a TTL policy on `expiresAt`.

**The slot**: `subscription_store_state/{sha256(uid)}_web_{production|test}`, the sixth and seventh slots, after the manual one. A live key writes `production`, a sandbox key `test`. Besides the usual slot fields it holds `web: {customerId, subscriptionId?, purchaseId?, lastPaidInvoiceId?, paidThrough?, plan, tier?, cancelAtPeriodEnd, needsAction, paymentFailed, readAt}`. `purchaseReference` is the subscription id, or the invoice id for lifetime, and is copied to the master when web wins it. `WEB_SLOT_ENABLED` in `constants.ts` takes both slots out of every projection, like `MANUAL_SLOT_ENABLED`.

A web slot is read as active only while its stored `active` is true and `expiresAt` is in the future; an entitled status (`active`, `canceled`, `grace_period`) past its date reads as `expired`. A missed webhook can therefore never leave access on.

## `syncWebEntitlement(uid)`

The only writer of the web slot. Every Stripe event, the reconcile run and the purchase callables end in it. It reads Stripe first, then writes the slot, the master projection and the ledger statuses in one transaction modelled on `applyManualMutation`. It writes nothing when the account has a tombstone (open or closed), when the mapping has no customer for the key's mode, or when the derived slot equals the stored one; the comparison leaves out the times of writing and reading, so a replay or a second sync costs no write. A sync whose Stripe reads began before those behind the stored slot never overwrites it (`web.readAt`), since Stripe delivers events out of order.

Access comes only from the line periods of paid invoices (`lines.data[].period.end`), never from a subscription item's `current_period_end`, which Stripe moves forward at renewal whether or not the renewal is paid.

Derivation, first match wins:

1. **Lifetime.** A ledger entry for `web_lifetime` whose invoice is paid and whose charge is neither refunded in full nor disputed (`needs_response`, `under_review`, `lost`, or an appeal): `active` until payment + 50 years, not renewing. Every subscription of the customer not yet ended is cancelled at Stripe, with no refund.
   A lifetime entry's invoice is read whatever the entry's status, so a paid invoice wins over an entry marked `abandoned` or `failed`, and the sync corrects the entry to `paid`.
2. **Subscription.** The customer's newest started subscription not yet ended (active, trialing, past due, unpaid, paused), else the newest that ended after starting, with `paidThrough` the period end of its latest paid invoice. Every other started, open subscription is cancelled at Stripe and logged at error level as `web_duplicate_subscription_cancelled`: the customer paid twice and a person must refund. An incomplete subscription is never cancelled this way; it belongs to a purchase in flight.

| Stripe state | Slot |
|---|---|
| Latest paid charge refunded in full | `revoked`, inactive; the subscription is cancelled at Stripe |
| Latest paid charge disputed, `needs_response` or `under_review` | `revoked`, inactive |
| Dispute `lost` (or under appeal) | `revoked`, inactive; the subscription is cancelled at Stripe |
| `active`, not cancelling | `active`, until `paidThrough` + 6 h, renewing |
| `active`, `cancel_at_period_end` | `canceled`, active, until `paidThrough`, not renewing |
| `past_due`, before `paidThrough` + 7 d | `grace_period`, active, until `paidThrough` + 7 d, `paymentFailed` |
| `past_due` after that, or `unpaid` | `billing_retry`, inactive, dated `paidThrough` |
| `canceled` | `expired`, inactive, dated the earlier of `paidThrough` and `ended_at` |

   A won dispute restores the row; warning-stage disputes change nothing; a partial refund changes only the ledger. `needsAction` is set while the latest invoice is open and its PaymentIntent is `requires_action`. A revoked row is dated when its invoice was paid.

3. **Nothing.** An existing slot becomes `expired`, dated no later than now; no slot is created. A lifetime purchase that was refunded or disputed, with no subscription to fall back on, gives `revoked` instead, so the slot says why access ended.

Cancellations happen after the commit. A failed cancel is thrown, so the webhook answers 500 and Stripe retries; the slot write is then a no-op.

## Webhook `stripeWebEvents`

`onRequest` in europe-west2, with `STRIPE_WEB_SECRET_KEY` and `STRIPE_WEB_WEBHOOK_SECRET`, timeout 120 s.

1. Not a POST is 405. A missing key or webhook secret is 500, so Stripe keeps the event.
2. `constructEvent` over the raw body with the `Stripe-Signature` header; a bad signature is 400.
3. An event whose `livemode` differs from the key's is answered 200 and not handled. So is a type not in the list below.
4. The `web_stripe_events` document is created; an existing one is answered 200 (`duplicate`).
5. The uid: the event object's customer, or for a refund or dispute its charge's customer, then that customer's `metadata.uid`, then the mapping check. No uid is outcome `ignored`, 200.
6. `syncWebEntitlement(uid)`. A failure deletes the event document and answers 500, so Stripe's retry handles it again.

Handled types: `invoice.paid`, `invoice.payment_failed`, `invoice.payment_action_required`, `invoice.voided`, `customer.subscription.created`, `.updated`, `.deleted`, `charge.refunded`, `refund.created`, `refund.updated`, `charge.dispute.created`, `.updated`, `.closed`, `.funds_withdrawn`, `.funds_reinstated`. Register the endpoint in the Stripe Dashboard for these types only.

Logs: `web_event_outcome` and `web_event_failure` per event, `web_sync_success` and `web_sync_failure` per sync, `web_subscription_cancelled_at_stripe`. They carry ids and codes, never a key, a client secret, a full confirmation token id, an email or card details.

## Reconcile

`reconcileSubscriptions` runs two more phases after the Apple ones when `STRIPE_WEB_SECRET_KEY` is set, and reports `{skipped: "stripe_not_configured"}` for both otherwise.

A malformed Stripe key fails only these two phases (`{error: "stripe-key-invalid"}`, logged as `subscription_reconcile_web_config_failure`); the Apple and Google phases run first and are unaffected.

- **`stripeEvents`**: a feed phase over `events.list` for the handled types, from the checkpoint in `subscription_reconcile_state/stripe-events-{live|test}` (at most 29 days back; Stripe keeps 30), paged with `starting_after`. Each event goes through the webhook's handler with source `reconcile`, so an event already handled is skipped and one the webhook never received syncs its account.
- **`webPending`**: every ledger entry `pending` for more than 15 minutes is synced (one sync per account). An entry still pending after 24 hours has its incomplete subscription cancelled, or its one-off invoice voided (a draft is deleted), and becomes `abandoned`. Its PaymentIntent is read first: `succeeded` or `processing` counts as paid, and the account is synced instead of anything being cancelled.

## Callables

Five v1 `onCall` functions in europe-west2, each with `STRIPE_WEB_SECRET_KEY` (and `getWebPlans` with `STRIPE_WEB_PUBLISHABLE_KEY`). Amounts are integer cents, dates ISO 8601 strings. A refusal is an `HttpsError` whose `details.reason` names it; some carry more in `details`. App Check is recorded in the logs, not enforced.

### Shared rules

- **Caller.** Signed in and not anonymous, else `unauthenticated` with `signed_out` or `anonymous`.
- **Request.** A plain object (null counts as `{}`) with only the listed keys, of the listed types, else `invalid-argument` / `invalid_request`.
- **Verified email** (`getWebPlans`, `startWebPurchase` only). Read from the ID token of the call, never from the request: Google and Apple sign-ins count as verified; every other provider needs `email_verified` true and an email. Else `failed-precondition` / `email_unverified`.
- **Sales gate.** `failed-precondition` / `sales_disabled` when no Stripe key is configured, or the key is a sandbox key and the caller is not in `testers`. `getWebPlans` and `startWebPurchase` also need `salesEnabled`; the other three do not, so a buyer can finish, see and cancel a purchase while sales are off. `getWebPlans` also refuses it when the publishable key is missing or of the other mode.
- **Deleted account** (`getWebPlans`, `startWebPurchase`). A uid with a tombstone in `deleted_accounts` is refused `permission-denied` / `account_deleted` (its ID token can outlive the deletion by an hour), and the customer mapping is never recreated for it.
- **Throttle.** `startWebPurchase` and `manageWebSubscription` `replace_card` count one attempt per uid and per caller IP: `resource-exhausted` / `throttled`, with `details.limit` `uid_day` or `ip_day`.
- **Anything else** is `internal` with a fixed message; a Stripe or Firestore message never reaches the caller or the log, only its code.

### `getWebPlans({lang?})`

`lang` is `ar` or `en`. Reads only.

```
{ publishableKey, livemode, countryKnown, tier,
  plans: [{plan, amount, currency, interval: "month" | "year" | null}],
  taxEnabled,
  current: {state, plan?} | null,
  storeSubscription: {platform: "apple" | "google", autoRenewing} | null,
  blockers: ("lifetime_active" | "already_subscribed" | "store_subscription_active")[] }
```

`plans` are the known tier's, in the order monthly, yearly, lifetime; a tier without a plan leaves it out (low has no monthly). `current.state` uses the states of `getWebSubscription`, and `current` is null for `none`. `already_subscribed` and `store_subscription_active` block monthly and yearly only; lifetime may be bought over either. `storeSubscription` is an active production Apple or Google slot (sandbox and test slots never count), an auto-renewing one first; only an auto-renewing one blocks.

### `startWebPurchase({plan, confirmationToken, acceptedTotal, billingState?, lang?})`

`plan` is `web_monthly`, `web_yearly` or `web_lifetime`; `confirmationToken` a `ctoken_…` id; `acceptedTotal` the total the page showed (cents, tax included); `billingState` a province for a Canadian address that lacks one; `lang` `ar` or `en`. The token's `setup_future_usage` must be `off_session` for monthly and yearly and unset for lifetime.

Answers:

| `status` | Other fields | Meaning |
|---|---|---|
| `succeeded` | `purchaseId` | Paid; the slot is synced (after waiting up to 10 s for Stripe to show the payment) |
| `requires_action` | `purchaseId`, `clientSecret` | Call `stripe.handleNextAction({clientSecret})`, then `finishWebPurchase({purchaseId})` |
| `pending` | `purchaseId` | Only on a retried call whose first attempt did not get as far as a confirmation; poll `finishWebPurchase` |
| `reprice` | `quote: {plan, tier, amount, tax, total, currency, reason}` | Nothing charged, nothing created at Stripe, no ledger entry. `reason` is `card_country`, `tax`, `both` or `price_changed`. Ask again and resend the same token with `acceptedTotal = quote.total` |

Refusals, besides the shared ones, all `failed-precondition` unless noted:

| `reason` | When |
|---|---|
| `lifetime_active` | Lifetime is active (any plan) |
| `already_subscribed` | A web subscription is active, cancelling, past due or waiting for authentication (monthly and yearly) |
| `store_subscription_active` | An auto-renewing production store subscription (monthly and yearly); `details.platform` is `apple` or `google` |
| `purchase_in_progress` | Another purchase of the account holds the lock: its entry is still `pending` and it started under ten minutes ago. Nothing is created at Stripe and no ledger entry is written; finish or fail the other one, or wait |
| `token_invalid` | The token is unknown, expired, already used, made with the wrong `setup_future_usage`, a retry of a purchase that was abandoned or failed for a reason other than a decline, or a purchase settled by another call before it was confirmed |
| `card_required` | The token is not a card (Link) |
| `plan_unavailable` | The plan is not sold in the tier charged |
| `billing_address_incomplete` (`invalid-argument`) | No billing country; or, with tax on, a Canadian address with neither province nor postal code |
| `card_declined` | `details.category` is `declined`, `insufficient_funds`, `expired_card`, `incorrect_details` or `authentication_failed`. The incomplete subscription is cancelled (or the invoice voided) and the entry is `failed` |

The server decides the tier (the dearer of the known tier and the card's), the price (from Stripe by lookup key) and the total (with tax when switched on); the page's total is only compared with it. The purchase id is `sha256(uid:token)`, so a retried call with the same token returns that purchase's outcome and never charges again: `succeeded`, `requires_action`, `pending`, or the same `card_declined`. **The lock.** The pending ledger entry is created in one transaction with `web_customers/{uid}.activePurchase = {purchaseId, startedAt}`. Another purchase blocks it (`purchase_in_progress`) while that one's entry is `pending` and under ten minutes old; nothing unlocks explicitly, since a settled or stale holder stops blocking. When the previous holder was paid, the guards are checked again after a sync, so a tab that passed its guards while another tab was paying is refused (`already_subscribed`) before anything is created. Pending purchases older than ten minutes are synced and then stopped at Stripe and marked `abandoned`; one that turned out paid is left alone and the guards are checked again. Any failure between the lock and creating the Stripe objects marks the entry `abandoned` at once. Just before confirming, the entry is read again: if another call settled it, its Stripe side is stopped and nothing is charged. If Stripe's invoice total differs from the accepted total, nothing is charged, the entry is `abandoned` (`total_mismatch`) and the answer is a `reprice`.

### `finishWebPurchase({purchaseId})`

The caller's own purchase only; another account's reads like a missing one: `not-found` / `purchase_not_found`. Syncs the account, then answers `{status: "succeeded" | "pending" | "failed", category?}`. `pending` covers a payment still waiting for authentication. A payment whose PaymentIntent went back to `requires_payment_method` or was `canceled` (a failed or dismissed 3D Secure challenge) is stopped at Stripe, marked `failed`, and answered `failed` with its category (`authentication_failed` when Stripe gives none). That also releases the account's purchase lock at once. A refunded or disputed purchase still answers `succeeded`: the payment went through, and access follows the slot.

### `getWebSubscription({})`

Syncs first when the account has a Stripe customer.

```
{ state: "none" | "active" | "cancelling" | "payment_failed" | "needs_action" | "ended" | "lifetime",
  plan?, amount?, currency?, renewsAt?, endsAt?, card?: {brand, last4}, purchaseId?,
  storeSubscription: {platform, autoRenewing} | null,
  publishableKey?, livemode }
```

`publishableKey` is returned here as well as by `getWebPlans`, because `/manage` must work while sales are off; it is left out when the configured key does not match the gateway's mode.

`amount` is the next renewal's price before tax (after a card change to a dearer tier, the new price), or what lifetime cost. `renewsAt` is set while `active`; `endsAt` while `cancelling` (end of the paid period), `payment_failed` or `needs_action` (end of the grace), `ended`, and `lifetime` (50 years). `card` is the subscription's default card. `needs_action` (a renewal waiting for authentication) wins over `payment_failed`; past due beyond the grace still reads `payment_failed`.

### `manageWebSubscription({action, …})`

The customer comes from `web_customers/{uid}` and the subscription from the account's web slot, checked against each other; the page sends no Stripe id except a SetupIntent it is finishing. With no open web subscription (none, lifetime only, ended): `failed-precondition` / `no_subscription`.

| `action` | Extra keys | Answer |
|---|---|---|
| `cancel` | | `{status: "succeeded"}`; cancels at period end |
| `resume` | | `{status: "succeeded"}` |
| `authenticate` | | `{clientSecret, purchaseId?}` of the open renewal's PaymentIntent in `requires_action`; then `handleNextAction` and `finishWebPurchase({purchaseId})`. Nothing waiting: `failed-precondition` / `no_action_required` |
| `replace_card` | `confirmationToken` (`setup_future_usage` `off_session`), `acceptedRenewalAmount?` | A card whose tier is dearer than the subscription's price and an `acceptedRenewalAmount` that is not the new price: `{status: "reprice", quote}` with `reason: "card_country"`, `tax` 0 and amounts before tax; nothing created. Otherwise a SetupIntent (cards only): `{status: "requires_action", setupIntentId, clientSecret}` or, done, `{status: "succeeded"}` |
| `finish_replace_card` | `setupIntentId` | The SetupIntent must belong to the caller's customer, else `not-found` / `setup_intent_not_found`. Still waiting: the same `requires_action` answer; not complete for another reason: `failed-precondition` / `setup_incomplete`; done: `{status: "succeeded"}` |

Applying a card is one `subscriptions.update`: the default payment method and, for a dearer tier, the item's price with `proration_behavior: "none"` (it takes effect at the next renewal) and `metadata.tier`. A same or cheaper tier never lowers the price. A past-due subscription then has its open invoice paid with the new card; a decline there is `card_declined`, with the new card already the default. `replace_card` refusals besides these: `token_invalid`, `card_required`, `card_declined` (with `category`), `throttled`.

### Logs

Each callable logs `<event>_start`, `_success`, `_rejection` (code, reason, category) or `_failure` (stage, error name, Stripe or safe code) with an `operationId`: `web_plans`, `web_purchase_start`, `web_purchase_finish`, `web_subscription_read`, `web_subscription_manage`. Also `web_purchase_start_reprice`, `_retried`, `_declined`, `_token_refused`, `_settle_timeout`, `web_purchase_failed`, `web_purchase_abandoned`, `web_subscription_card_applied`, `web_subscription_past_due_paid`. Tokens appear shortened; no key, client secret, email, card number or address is logged.

## Account deletion

The purge's web step deletes the Stripe customer of the key's mode, which cancels its subscriptions. No mapping means no Stripe call. `web_customers/{uid}` and the uid throttle document are deleted only when that step went through; `web_purchases` entries stay with `uid` removed. See `docs/account_deletion.md`.

## Secrets

Secret Manager names, listed in `STRIPE_WEB_SECRETS` in `constants.ts` and read from `process.env`:

| Name | Used by |
|---|---|
| `STRIPE_WEB_SECRET_KEY` | `stripeWebEvents`, `reconcileSubscriptions`, `deleteAccount`, `accountDeletedCleanup`, `sweepDeletedAccounts`, and the purchase callables |
| `STRIPE_WEB_WEBHOOK_SECRET` | `stripeWebEvents` |
| `STRIPE_WEB_PUBLISHABLE_KEY` | `getWebPlans`, which hands it to the page |

The key's prefix sets the mode: `sk_live_`/`rk_live_` is live, `sk_test_`/`rk_test_` is the sandbox. Every function above lists the secret key in `runWith`, so each deploy needs the secret to exist; at run time each one still works without a web customer, since nothing asks Stripe then.

## The tester gate

While the backend runs on a sandbox key, only uids in `web_pricing/config.testers` may buy; otherwise a test card would unlock premium for anyone. A sandbox key writes only the `web/test` slot, which loses the master to any production source.

## Going live

Switching `STRIPE_WEB_SECRET_KEY` from the sandbox key to the live one leaves every tester's `web/test` slot as it was, still giving access until its paid period ends, since nothing syncs the test slot once the key is live. As a required step of the switch, run:

```
npm run build
node scripts/stripe/expire-web-test-slots.mjs --project mantooq-test           # dry run: counts and lists
node scripts/stripe/expire-web-test-slots.mjs --project mantooq-test --apply   # writes
```

It needs no Stripe key (Application Default Credentials, or the emulator with `FIRESTORE_EMULATOR_HOST`). Each slot still giving access becomes `expired` and its owner's master is re-projected with the same code the sync uses; a second run writes nothing.

## Before the first deploy

- Create the three secrets.
- Turn on TTL for `expiresAt` on the `web_stripe_events` and `web_purchase_throttle` collection groups (`gcloud firestore fields ttls update expiresAt --collection-group=<name> --enable-ttl`).
- Deploy the rules.
- Deploy `stripeWebEvents` by name, register its URL in the Stripe Dashboard for the handled types, and store the signing secret as `STRIPE_WEB_WEBHOOK_SECRET`.
- Redeploy `reconcileSubscriptions`, `deleteAccount`, `accountDeletedCleanup` and `sweepDeletedAccounts` by name, since each now mounts `STRIPE_WEB_SECRET_KEY`.
- Deploy `getWebPlans`, `startWebPurchase`, `finishWebPurchase`, `getWebSubscription` and `manageWebSubscription` by name.

## Sandbox check

```
npm run build
node --env-file=<path to .env.local> scripts/stripe/verify-web-gateway.mjs
```

It refuses any key that is not `sk_test_`, never prints the key, and deletes the customers it creates. Stripe Tax is not active in the sandbox (no head office address), so the tax path is covered only by the fake in the unit tests.

The callables end to end, inside the integration emulator:

```
npm run build
bash scripts/emulator/with-java.sh firebase emulators:exec --config firebase.integration-test.json \
  --only firestore,auth --project demo-mantooq \
  'node --env-file=<path to .env.local> scripts/stripe/verify-web-purchase.mjs'
```

It seeds `web_pricing/config` (its uids as testers, SA as a low-tier and AE as a reduced country, since Stripe has no Egyptian or Turkish test cards) and attested store countries, then buys each plan, re-prices a low-tier account's US card, declines, refunds, disputes, cancels and resumes, replaces a card with a dearer-tier one, runs a failed renewal on a test clock into grace and `billing_retry`, rebuilds a deleted slot from the reconcile phase alone, and abandons a pending purchase through the sweep. It deletes its customers and its test clock.
