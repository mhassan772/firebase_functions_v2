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
| `src/services/webSubscriptions/billingEmails.ts` | The outbox, which emails a sync calls for, the renewal reminder, the last-warning sweep |
| `src/services/email/billingEmailTemplates.ts` | The billing emails' words, `formatMoney`, `formatDate` |
| `src/handlers/webBillingEmailHandlers.ts` | The sender behind `sendWebBillingEmail` |
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
| `emailsEnabled` | `true`; when `false` the billing email sender marks every queued email `skipped` |

Amounts are never in the config: each is read from the Stripe price with that lookup key and cached for ten minutes per instance.

**`web_customers/{uid}`**: `{testCustomerId?, liveCustomerId?, activePurchase?: {purchaseId, startedAt}, createdAt, updatedAt}`. `activePurchase` is the account's purchase lock (see `startWebPurchase`). It is never written for an account with a tombstone in `deleted_accounts`. The Stripe customer carries `metadata.uid`. A Stripe object is acted on only when its customer's `metadata.uid` has a mapping that names that same customer, so it is the ownership record; `subscription_purchase_ownership` is not used for web.

**`web_purchases/{purchaseId}`**, the ledger. `purchaseId` is the first 32 hex characters of `sha256(uid + ":" + confirmationTokenId)`, so a retried purchase call lands on the same entry. Statuses: `pending` → `paid` | `failed` | `abandoned`; `paid` → `refunded` | `disputed` | `dispute_lost`; `disputed` → `paid` when the dispute is won. A partial refund sets `partialRefund` (cents) and nothing else. A plan switch (see `switch_yearly`) is an entry too, with `kind: "switch"`, `switchedFrom: "web_monthly"`, `plan: "web_yearly"`, `credit` (cents, positive) beside `amount`, `tax` and `total`, and its purchase id from `sha256(uid + ":" + attemptId)`. An upgrade to lifetime (see `buy_lifetime`) has `kind: "upgrade"`, `plan: "web_lifetime"`, `switchedFrom` the plan it stopped, `credit`, and no `stripe.subscriptionId`, since it pays a one-off invoice. No email, name, card number or address line is stored. An account's entries are read in pages of 200 by document id (no composite index), all of them, up to 2,000, past which the read stops with an error log (`web_ledger_read_capped`).

**`web_stripe_events/{eventId}`**: `{type, created, receivedAt, source, outcome, expiresAt}`, claimed in a transaction, so an existing document means the event was handled or is being handled. `outcome` is `processing` while handled, then `ignored` or `synced_<sync outcome>`. A claim still `processing` five minutes after `receivedAt` belongs to a handler that died, and the next delivery or reconcile run takes it over (`reclaimed: true`). Removed by a TTL policy on `expiresAt`, 90 days after receipt.

**`web_purchase_throttle/{uid_<uid> | ip_<sha256(ip)>}`**: `{kind, count, windowStart, lastAttemptAt, expiresAt}`, evaluated like `auth_email_throttle`: 10 attempts per uid and 30 per IP in 24 hours. Removed by a TTL policy on `expiresAt`.

**The slot**: `subscription_store_state/{sha256(uid)}_web_{production|test}`, the sixth and seventh slots, after the manual one. A live key writes `production`, a sandbox key `test`. Besides the usual slot fields it holds `web: {customerId, subscriptionId?, purchaseId?, lastPaidInvoiceId?, paidThrough?, plan, tier?, cancelAtPeriodEnd, needsAction, paymentFailed, readAt}`. `purchaseReference` is the subscription id, or the invoice id for lifetime, and is copied to the master when web wins it. `WEB_SLOT_ENABLED` in `constants.ts` takes both slots out of every projection, like `MANUAL_SLOT_ENABLED`.

A web slot is read as active only while its stored `active` is true and `expiresAt` is in the future; an entitled status (`active`, `canceled`, `grace_period`) past its date reads as `expired`. A missed webhook can therefore never leave access on.

## `syncWebEntitlement(uid)`

The only writer of the web slot. Every Stripe event, the reconcile run and the purchase callables end in it. It reads Stripe first, then writes the slot, the master projection and the ledger statuses in one transaction modelled on `applyManualMutation`. It writes nothing when the account has a tombstone (open or closed), when the mapping has no customer for the key's mode, or when the derived slot equals the stored one; the comparison leaves out the times of writing and reading, so a replay or a second sync costs no write. A sync whose Stripe reads began before those behind the stored slot never overwrites it (`web.readAt`), since Stripe delivers events out of order.

Access comes only from the line periods of paid invoices (`lines.data[].period.end`), never from a subscription item's `current_period_end`, which Stripe moves forward at renewal whether or not the renewal is paid. `paidThrough` is the latest `period.end` across the invoice's lines (`servicePeriodEnd`), never the first line's: a plan switch's invoice lists the credit for the unused monthly days first, and only its yearly line runs to the new year's end.

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

   A won dispute restores the row; warning-stage disputes change nothing; a partial refund changes only the ledger. `needsAction` is set while the latest invoice is open and its PaymentIntent is `requires_action`, except an open `subscription_update` invoice: a plan switch waiting for its bank step leaves the subscription as it was, and is not a renewal in trouble. A revoked row is dated when its invoice was paid, and a full refund of a plan switch's payment revokes like any latest payment, since it paid for the year.

   `tier` is the subscription's `metadata.tier`. Every price change (`replace_card`, the plan switch) writes it in the same update as the price, and under `pending_if_incomplete` Stripe applies it only with the payment, so it is always the tier of the current price. The sync reads no config.

   Every entry made by `/manage` (a `kind`) has its invoice read whatever its status, as lifetime entries do, and any ledger entry naming the subscription's latest paid invoice is corrected from it whatever its status, so a plan switch marked `failed` or `abandoned` whose payment went through after all becomes `paid` and gets its one `switched_yearly`.

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

Handled types: `invoice.paid`, `invoice.payment_failed`, `invoice.payment_action_required`, `invoice.voided`, `customer.subscription.created`, `.updated`, `.deleted`, `charge.refunded`, `refund.created`, `refund.updated`, `charge.dispute.created`, `.updated`, `.closed`, `.funds_withdrawn`, `.funds_reinstated`, and `invoice.upcoming` (which only queues the yearly renewal reminder; see "Billing emails"). Register the endpoint in the Stripe Dashboard for these types only.

Logs: `web_event_outcome` and `web_event_failure` per event, `web_sync_success` and `web_sync_failure` per sync, `web_subscription_cancelled_at_stripe`. They carry ids and codes, never a key, a client secret, a full confirmation token id, an email or card details.

## Reconcile

`reconcileSubscriptions` runs three more phases after the Apple ones when `STRIPE_WEB_SECRET_KEY` is set, and reports `{skipped: "stripe_not_configured"}` for each otherwise.

A malformed Stripe key fails only these three phases (`{error: "stripe-key-invalid"}`, logged as `subscription_reconcile_web_config_failure`); the Apple and Google phases run first and are unaffected.

- **`stripeEvents`**: a feed phase over `events.list` for the handled types, from the checkpoint in `subscription_reconcile_state/stripe-events-{live|test}` (at most 29 days back; Stripe keeps 30), paged with `starting_after`. Each event goes through the webhook's handler with source `reconcile`, so an event already handled is skipped and one the webhook never received syncs its account.
- **`webPending`**: every ledger entry `pending` for more than 15 minutes is synced (one sync per account). An entry still pending after 24 hours has its incomplete subscription cancelled, or its one-off invoice voided (a draft is deleted), and becomes `abandoned`. Its PaymentIntent is read first: `succeeded` or `processing` counts as paid, and the account is synced instead of anything being cancelled. A plan switch still pending after the 15 minutes is settled at once: a paid invoice marks it paid; an open one is voided (which drops the change Stripe holds and its scheduled retry) and the entry becomes `failed` with `failure: "not_completed"`. A switch entry without an invoice id (the call ended between Stripe's answer and the write) is resolved from the subscription: its `metadata.purchaseId` names the switch only once paid, and then `latest_invoice` and its amounts are recorded and the sync marks it paid; otherwise it becomes `failed`, and an open `subscription_update` invoice on that subscription (it has a `pending_update`) raised at or after the entry was made is voided, so Stripe does not hold the change for 23 hours. An upgrade to lifetime is settled the same way after 15 minutes from its one-off invoice; one without an invoice id is found by `metadata.purchaseId` among the customer's ten newest invoices, and an open one is voided (a draft deleted).
- **`webFinalWarnings`**: the last warning before a failed renewal stops access. Slots with `platform == "web"` and `status == "grace_period"` (equality only, no composite index) of the key's mode, with `paymentFailed` and a grace ending within 48 hours, are synced and then, if still so, get `payment_failed_final` queued.

## Billing emails

Stripe's own customer emails are switched off (they have no Arabic), so these are the only messages a web subscriber gets. Contract: `docs/ai/plans/26-11-10/web-accounts-stage-e-spec.md` in Mantooq_Mobile.

Nothing that talks to Stripe sends mail. Code that notices something worth an email writes a document to `web_email_outbox/{id}`, and the Firestore trigger `sendWebBillingEmail` sends it. Only that function holds the SES secrets, a slow or failed send never delays a purchase, a sync or a webhook answer, and a send can be retried. Each occurrence has a deterministic id and is written with `create()`; a second attempt to queue it fails quietly, so replays and retries never send twice.

**`web_email_outbox/{id}`**: `{uid, kind, lang, livemode, plan?, amount?, credit?, creditedPlan?, tax?, total?, currency?, renewsAt?, endsAt?, graceEndsAt?, cardExpiresFirst?, status: "queued"|"sent"|"skipped"|"failed", reason?, attempts, createdAt, sentAt?, expiresAt}`, removed by a TTL policy on `expiresAt` 90 days after it was queued. Server-only; no address, name or card detail. `lang` is the purchase's (the ledger entry the slot names), Arabic when it cannot be read. Account deletion deletes the uid's documents.

| `kind` | Queued when | Id |
|---|---|---|
| `purchase_confirmed` | A ledger entry becomes `paid` for the first time (from pending, failed or abandoned), except a plan switch. For an upgrade to lifetime it also carries `credit` and `creditedPlan`: the credit line, shown as a deduction, and that the subscription has stopped and will not renew. The stopped subscription sends nothing else | `confirmed_<purchaseId>` |
| `switched_yearly` | A `kind: "switch"` entry becomes `paid` for the first time. Says the plan is now yearly, the yearly price, the credit for the unused monthly days, tax when not zero, the total charged, the next renewal and that it renews until cancelled, no refunds. Renewal turned back on by the switch sends nothing else | `switched_<purchaseId>` |
| `renewed` | The slot's `lastPaidInvoiceId` changes on the same subscription and that invoice's billing reason is `subscription_cycle` | `renewed_<invoiceId>` |
| `payment_failed` | `paymentFailed` turns on while the grace is still ahead, and the bank is not asking for confirmation | `failed_<open invoice id>` |
| `action_required` | `needsAction` turns on, the open invoice is `subscription_cycle` (never a first purchase) and the grace is ahead | `action_<invoiceId>` |
| `cancellation_confirmed` | `cancelAtPeriodEnd` turns on while the paid period is ahead | `cancelled_<subscriptionId>_<paidThrough s>` |
| `renewal_reminder` | `invoice.upcoming` for an active yearly subscription that is not cancelling, renewal still ahead | `reminder_<subscriptionId>_<paidThrough s>` |
| `payment_failed_final` | The recovery pass's `webFinalWarnings` phase | `failed_final_<subscriptionId>_<grace end s>` |

The first six come from `syncWebEntitlement`: after its transaction commits (when it wrote the slot, or moved an entry to paid) it calls its optional `notify` dependency with the slot before and after, the entries that became paid and the subscription's facts (the latest paid invoice's billing reason and amount, and the latest open invoice's id and reason). The live deps of every caller (the webhook, the recovery pass, the five callables) carry `billingNotifier`; a failure there is logged (`web_sync_notify_failure`, `web_email_queue_failure`) and never fails the sync. `renewal_reminder` sets `cardExpiresFirst` when the default card's expiry month ends before the renewal date. Nothing is queued for an account with a tombstone, once access is revoked (a refund or a dispute), for a subscription that ends after the retries run out, or for a change on a different subscription than the slot named before (a rebuilt slot).

**Sender `sendWebBillingEmail`** (`onCreate` on `web_email_outbox/{id}`, europe-west2, SES secrets, retries on): leaves a document that is not `queued` alone, and marks it `skipped` with a reason when `emailsEnabled` is false (`emails_disabled`), the account has a tombstone (`account_deleted`), the Auth user is gone (`no_user`) or has no address (`no_email`), or it was queued more than 24 hours ago (`stale`). Otherwise it renders with `billingEmailTemplates.ts` and sends through SES with the sender name of the language, then marks `sent`. A transient SES failure counts an attempt and throws so the platform retries; the fifth failed attempt, a permanent SES answer (`ses_<name>`) or a missing field (`incomplete_<field>`) marks `failed`. A send that succeeded but could not be marked may be sent again on the retry: a duplicate receipt is preferred over a lost one.

**Templates** (`src/services/email/billingEmailTemplates.ts`): one copy record per language on the shared frame, with the plan names and terms of the accounts pages, and every email carries the manage button (`https://accounts.mantooq.com/manage?lang=<lang>`). `formatMoney` and `formatDate` format as the page does: US dollars as `$4.99` in English and as the number then «دولار» in Arabic (`٤٫٩٩ دولار`, no symbol), another currency in the platform's format, Arabic digits and month names for Arabic, dates in UTC. A credit is written under a label that says it is taken off, so it carries no minus sign. A sandbox email's subject starts with `[TEST] `.

**Logs**: `web_email_queue` (kind, id, outcome), `web_email_send_outcome` (outcome, reason), `web_email_send_retry`, `web_email_reminder_failure`, `web_final_warning_item_failure`. Never an address.

### Owner's steps in Stripe before live sales

| Where | Setting | Value |
|---|---|---|
| Billing → Revenue recovery → Retries | Smart Retries | 8 within 2 weeks |
| Same page | After the last retry | Cancel the subscription |
| Billing settings → Upcoming renewal events | Lead time | 7 days |
| Billing settings → Customer emails | Stripe's own emails | Off |
| Radar | Rule | 3D Secure when risk is not normal |
| Webhook endpoint | Events | the handled types above, including `invoice.upcoming` |

## The account page

`accounts-page/` serves one page at both `/subscribe` and `/manage` (`src/routes/account.ts`), so old links and the emails' manage button keep working. It calls `getWebSubscription` and `getWebPlans` together; a refusal of `getWebPlans` (sales off, unverified email, any error) only replaces what the page sells, never the management of a subscription. `accountView(subscription, plans, now)` in `src/billing/logic.ts` decides the whole page and is unit-tested state by state; the route only renders it. One heading, «اشتراكك في منطوق بريميوم», then a status block (title, one sentence, tone), at most one primary control, quieter sections, and a cancel link at the very bottom. The first matching state wins:

| Account | Status | Primary | Then |
|---|---|---|---|
| Web lifetime | Lifetime Premium | none | Paying-twice warning when a store still renews |
| Web `needs_action` | The bank wants to confirm the renewal (warning) | Confirm the payment (`authenticate`) | Card row, cancel link |
| Web `payment_failed` | The renewal didn't go through (warning) | Change card | Buy lifetime instead (a new lifetime purchase), cancel link |
| Web `active` | Premium is on, with plan, renewal date and amount | none | Paying-twice warning, card row, upgrade (yearly from monthly; lifetime), cancel link |
| Web `cancelling` | Premium is on until the date | Resume renewal | Card row, upgrade |
| No web, a store renews | Premium is on through the store | Link to manage it in the store | How to pay by card here (turn off renewal first), or buy lifetime now |
| No web, other premium that ends on its own | Premium is on until the date | none | To continue after that: the confirmation and tick, then the purchase |
| Web `ended`, nothing else | Ended on the date | The purchase's pay button | The purchase |
| Nothing | No Premium | The purchase's pay button | The purchase |

Further sources of premium follow the status as plain lines. Card change, the switch to yearly, the upgrade to lifetime and the lifetime purchases open in place of the section that opened them and close with Back. After a payment or a change the page loads again into its new state and announces it. A purchase that succeeded, is still confirming or got no final answer is remembered with its plan for the tab (in `sessionStorage`, keyed by the uid, for fifteen minutes): until the account shows premium from this site (lifetime, for a lifetime purchase made over a failed renewal), `accountView` answers a "confirming" state with a "check again" control (`finishWebPurchase`) and no purchase, and forgets it when that call says the purchase failed or does not exist. `startWebPurchase` holds the same line for another tab (`purchase_in_progress`, below). When the two calls disagree about the web subscription (`getWebPlans` read the slots before `getWebSubscription`'s sync), the page asks for the plans once more. A refused `getWebPlans` shows only inside the part that sells, with its own retry. Upgrading and the purchases are hidden while sales are off.

## Callables

Five v1 `onCall` functions in europe-west2, each with `STRIPE_WEB_SECRET_KEY` (and `getWebPlans` with `STRIPE_WEB_PUBLISHABLE_KEY`). Amounts are integer cents, dates ISO 8601 strings. A refusal is an `HttpsError` whose `details.reason` names it; some carry more in `details`. App Check is recorded in the logs, not enforced.

### Shared rules

- **Caller.** Signed in and not anonymous, else `unauthenticated` with `signed_out` or `anonymous`.
- **Request.** A plain object (null counts as `{}`) with only the listed keys, of the listed types, else `invalid-argument` / `invalid_request`.
- **Verified email** (`getWebPlans`, `startWebPurchase` only). Read from the ID token of the call, never from the request: Google and Apple sign-ins count as verified; every other provider needs `email_verified` true and an email. Else `failed-precondition` / `email_unverified`.
- **Sales gate.** `failed-precondition` / `sales_disabled` when no Stripe key is configured, or the key is a sandbox key and the caller is not in `testers`. `getWebPlans`, `startWebPurchase` and `manageWebSubscription`'s `quote_switch_yearly`, `switch_yearly`, `quote_lifetime` and `buy_lifetime` (each is a sale) also need `salesEnabled`, and refuse a deleted account like a purchase; everything else does not, so a buyer can finish, see and cancel a purchase while sales are off. `getWebPlans` also refuses it when the publishable key is missing or of the other mode.
- **Deleted account** (`getWebPlans`, `startWebPurchase`). A uid with a tombstone in `deleted_accounts` is refused `permission-denied` / `account_deleted` (its ID token can outlive the deletion by an hour), and the customer mapping is never recreated for it.
- **Throttle.** `startWebPurchase` and `manageWebSubscription` `replace_card`, `switch_yearly` and `buy_lifetime` count one attempt per uid and per caller IP: `resource-exhausted` / `throttled`, with `details.limit` `uid_day` or `ip_day`.
- **Anything else** is `internal` with a fixed message; a Stripe or Firestore message never reaches the caller or the log, only its code.

### `getWebPlans({lang?})`

`lang` is `ar` or `en`. Reads only.

```
{ publishableKey, livemode, countryKnown, tier,
  plans: [{plan, amount, currency, interval: "month" | "year" | null}],
  taxEnabled,
  current: {state, plan?} | null,
  storeSubscription: {platform: "apple" | "google", autoRenewing} | null,
  blockers: ("lifetime_active" | "already_subscribed" | "store_subscription_active")[],
  premium: [{source: "web" | "apple" | "google" | "manual",
             kind: "subscription" | "lifetime" | "grant",
             plan?: "web_monthly" | "web_yearly" | "web_lifetime",
             state: "active" | "cancelling" | "payment_failed" | "needs_action",
             renews, until?}] }
```

`plans` are the known tier's, in the order monthly, yearly, lifetime; a tier without a plan leaves it out (low has no monthly). `current.state` uses the states of `getWebSubscription`, and `current` is null for `none`. `already_subscribed` and `store_subscription_active` block monthly and yearly only; lifetime may be bought over either. `storeSubscription` is an active production Apple or Google slot (sandbox and test slots never count), an auto-renewing one first; only an auto-renewing one blocks.

`premium` is every source of premium the account holds now, in the order web, Apple, Google, manual, built by `existingPremium` (`accountState.ts`), the one reader for it. A source is listed only while it gives premium, except a web subscription in `payment_failed` or `needs_action`, which is listed in that state. `renews` is true only when it will charge again on its own; `until` is the renewal date when it renews, else the day premium ends, and is absent for lifetime. The web date is `paidThrough`, not the slot's `expiresAt` with its grace margin; `lifetime` is web only and `grant` (the manual slot, read only while `MANUAL_SLOT_ENABLED`) manual only. Store sources are the production slots, `cancelling` when they do not renew. `premium` was added after the first page shipped; nothing else changed, so that page keeps working.

### `startWebPurchase({plan, confirmationToken, acceptedTotal, billingState?, lang?, acknowledgeExisting?})`

`plan` is `web_monthly`, `web_yearly` or `web_lifetime`; `confirmationToken` a `ctoken_…` id; `acceptedTotal` the total the page showed (cents, tax included); `billingState` a province for a Canadian address that lacks one; `lang` `ar` or `en`; `acknowledgeExisting` a boolean, `true` once the buyer confirmed buying over premium from a store or a manual grant (the page sends it only then, since a backend without it refuses an unknown field). The token's `setup_future_usage` must be `off_session` for monthly and yearly and unset for lifetime.

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
| `already_subscribed` | A web subscription is active, cancelling, past due or waiting for authentication (monthly and yearly); one that is active or cancelling also blocks lifetime, which it buys as an upgrade on the account page with a credit for its unused time (`buy_lifetime`). A past-due one has no unused time, so lifetime stays purchasable over it and the subscription is cancelled once lifetime is paid |
| `store_subscription_active` | An auto-renewing production store subscription (monthly and yearly); `details.platform` is `apple` or `google` |
| `existing_premium` | No blocker applies, but `premium` holds a source other than `web` (a store subscription, renewing or cancelled but still running, or a manual grant) and `acknowledgeExisting` is not `true`; `details.premium` lists those sources as `getWebPlans` does. The purchase starts today and adds nothing to the days already held, so the buyer must confirm it first. Checked with the blockers, before the purchase lock and the token read: nothing is created at Stripe and no ledger entry is written. A web source never needs it |
| `purchase_in_progress` | Another purchase of the account holds the lock: its entry is still `pending` and it started under ten minutes ago; or it is a plain purchase (no `kind`) that was paid under ten minutes ago and the web slot does not show yet (a subscription slot naming another purchase or none running, or no lifetime slot for a lifetime purchase; `paidButNotShown`, checked inside the lock's transaction and logged as `web_purchase_start_busy` with `reason: "paid_not_shown"`). Nothing is created at Stripe and no ledger entry is written; finish or fail the other one, or wait. A switch or an upgrade never takes the second rule, a refunded, failed or abandoned holder is not paid, and a holder of the other Stripe mode is ignored (the lock is shared by both modes). Since the refusal comes before any entry is written, a later attempt in the window, a declined one included, never becomes the holder |
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
  premium: [{source, kind, plan?, state, renews, until?}],
  publishableKey?, livemode }
```

`premium` is the same list as `getWebPlans` returns, from the same reader (`existingPremium`), so the account page can show premium from a store or a manual grant that this site did not sell. It was added after the first page shipped, which ignores it; `storeSubscription` stays.

`publishableKey` is returned here as well as by `getWebPlans`, because managing a subscription on the account page must work while sales are off; it is left out when the configured key does not match the gateway's mode.

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

| `quote_switch_yearly` | | `{status: "quote", quote}`; nothing written |
| `switch_yearly` | `acceptedTotal`, `attemptId` (16 to 64 letters, digits or hyphens, made once per confirmation), `lang?` | `{status: "succeeded", purchaseId}`; `{status: "reprice", quote}` when the total is no longer `acceptedTotal`, with nothing written or charged; `{status: "requires_action", purchaseId, clientSecret}` for the bank step, then `handleNextAction` and `finish_switch_yearly` |
| `quote_lifetime` | | `{status: "quote", quote}`; nothing written |
| `buy_lifetime` | `acceptedTotal`, `attemptId`, `lang?` | As `switch_yearly`: `succeeded`, `reprice` with a fresh quote, or `requires_action` with `purchaseId` and `clientSecret`, then `finish_lifetime` |
| `finish_lifetime` | `purchaseId` | As `finish_switch_yearly`, for an upgrade. Works once the slot is lifetime, as does a repeated `buy_lifetime` |
| `finish_switch_yearly` | `purchaseId` | The switch's invoice read again: paid, `{status: "succeeded", purchaseId}`; still waiting, the same `requires_action` answer; anything else voids the invoice and is `card_declined`. Another account's or an unknown purchase: `not-found` / `purchase_not_found` |

**Switching monthly to yearly.** `quote` is `{plan: "web_yearly", tier, amount, credit, tax, total, currency, renewsAt, card?: {brand, last4}}`: `amount` the yearly price, `credit` the unused days of the month as a positive number, `total` what the saved card is charged today, `renewsAt` the end of the yearly line's period (a year from now); `card` is left out when the default card cannot be read. Only a monthly subscription in `active` or `cancelling` whose Stripe status is `active` switches; otherwise `failed-precondition` / `switch_unavailable` with `details.cause` `not_monthly` or `payment_due` (a lifetime account has no subscription and gets `no_subscription`). The tier is decided as for a new purchase: the dearer of the known tier and the tier of the default card's country, an unreadable card country counting as full price (`savedCardOf` in `pricing.ts`, the one reader of the default card, also behind `getWebSubscription`'s `card` and the renewal reminder's expiry check).

The quote is `invoices.createPreview({customer, subscription, subscription_details: {items: [{id, price: yearly}], proration_behavior: "always_invoice", billing_cycle_anchor: {type: "now"}, cancel_at_period_end: false}})`, and its amounts are read from the preview's lines (`invoiceAmounts`: negative lines are the credit). The anchor reset cannot be combined with `proration_date`, so Stripe works out the credit at each call and it can move by a cent between the quote and the charge; `switch_yearly` therefore previews again and answers `reprice` on any difference.

`switch_yearly`, in order: the purchase id from the uid and `attemptId` (a repeated call returns that attempt's outcome and never charges again); the throttle; the eligibility check; `purchase_in_progress` while another purchase holds the account's lock; an earlier attempt's open `subscription_update` invoice (the subscription has a `pending_update`) is voided and the account synced; the preview and the `reprice` check; the pending ledger entry with the purchase lock, carrying the tier and country fields of a purchase, the billing country and state of the subscription's previous entry, and `lang`; then one `subscriptions.update` with the same change plus `payment_behavior: "pending_if_incomplete"` and `metadata: {plan, tier, purchaseId}`, expanding `latest_invoice.payments`, under the idempotency key `switch_<purchaseId>`. Stripe applies the price, the anchor, the renewal and the metadata only once the invoice is paid. The answer's invoice id, PaymentIntent and amounts are recorded on the entry at once (they are final once the invoice exists, so the email carries what was charged). A paid invoice syncs and answers `succeeded`; a PaymentIntent in `requires_action` answers `requires_action`; anything else is a decline: the entry becomes `failed` with the decline category first, then the invoice is voided at once (Stripe would otherwise retry the card after the pending change expired), and the answer is `card_declined`. The failure is recorded before the void because the void's `invoice.voided` webhook syncs the account, and a sync that came first would mark the entry `abandoned` with no category; an invoice paid meanwhile settles as `succeeded`. A repeated `attemptId` whose entry has no invoice id yet, while the entry is younger than the purchase lock, writes and voids nothing: the first call may still be inside Stripe's update, so it is settled as paid only when the subscription already names it, else refused `purchase_in_progress`. Past the lock it is resolved as the sweep does. A cancelled subscription may switch; `cancel_at_period_end: false` turns renewal back on. The `authenticate` action never hands out a switch's payment.

**Upgrading to lifetime.** `quote` is `{plan: "web_lifetime", tier, amount, credit, tax, total, currency, creditedPlan, card?: {brand, last4}}`: `amount` the lifetime price of the tier decided as for a new purchase (the dearer of the known tier and the saved card's country), `credit` the unused time of the current plan, `creditedPlan` that plan (`web_monthly` or `web_yearly`). Only a subscription in `active` or `cancelling` whose Stripe status is `active` upgrades; otherwise `failed-precondition` / `lifetime_unavailable` with `details.cause` `payment_due`; a lifetime owner gets `no_subscription`. The credit is ours, not Stripe's (lifetime is a one-off invoice, so Stripe has no proration for it): `unusedTimeCredit` in `pricing.ts`, the one owner, takes the subscription's latest paid invoice line with the latest `period.end` (on a switch invoice the yearly line), its amount before tax, scaled by the share of that invoice's charge not refunded (a partial refund by support credits only what is still paid, a full one nothing), prorated by the time left at the call and rounded down to a cent, never negative and never leaving the total under Stripe's 50-cent minimum. It moves with time (about a cent per 87 minutes on monthly, per 105 on yearly), so `buy_lifetime` quotes again and answers `reprice` on any difference.

`buy_lifetime` follows `switch_yearly`'s order with the same helpers: the purchase id from `attemptId`, the throttle, the eligibility check, `purchase_in_progress`, an earlier switch's pending invoice voided, the quote and `reprice` check (and `card_declined` when the subscription has no saved card), the pending entry with the purchase lock, then every older pending attempt of the account (any kind, past the lock) abandoned and its invoice voided, so a bank step left open in another tab can never be completed behind this charge (an invoice paid in the meantime instead makes that attempt's success the answer, and this one is abandoned), and the subscription read again (changed since the quote: abandoned, `lifetime_unavailable` with `cause: "changed"`), then the lifetime invoice of a new purchase (`createLifetimeInvoice`) with a second, negative item for the credit described in the buyer's language, finalized and confirmed with the subscription's saved default card while the buyer is present. Its id, PaymentIntent and amounts are recorded at once; a total that is not `acceptedTotal` abandons it and voids the invoice. A succeeded payment waits for the invoice to be paid and syncs: the sync's lifetime rule then cancels the subscription (`subscriptions.cancel`, no proration, no final invoice; the sandbox showed no invoice, credit note or balance afterwards). A PaymentIntent in `requires_action` answers `requires_action` (the sandbox showed the bank step this way, with the client secret on the invoice's PaymentIntent); a decline records `failed` and then voids the invoice. A repeated attempt inside the lock window writes and voids nothing and answers `purchase_in_progress` while it has no invoice id yet, or while its invoice has had no payment attempt (`attempt_count` 0 and the PaymentIntent still `requires_payment_method`). `switch_yearly` takes the same steps after its lock (abandoning older attempts, `switch_unavailable` with `cause: "changed"`), and an attempt abandoned for either reason answers `switch_unavailable` or `lifetime_unavailable` again when repeated or finished, never a settlement. A full refund of the lifetime payment ends lifetime; the stopped subscription is not restored, and the slot then reads the cancelled subscription (`expired`).

Applying a card is one `subscriptions.update`: the default payment method and, for a dearer tier, the item's price with `proration_behavior: "none"` (it takes effect at the next renewal) and `metadata.tier`. A same or cheaper tier never lowers the price. A past-due subscription then has its open invoice paid with the new card; a decline there is `card_declined`, with the new card already the default. `replace_card` refusals besides these: `token_invalid`, `card_required`, `card_declined` (with `category`), `throttled`. `buy_lifetime` refusals besides the shared ones: `lifetime_unavailable`, `purchase_in_progress`, `card_declined` (with `category`), `plan_unavailable`, `throttled`, and `lifetime_incomplete` for a repeated attempt, past the lock, whose call ended before its invoice was recorded and that never got paid. `switch_yearly` refusals besides these: `switch_unavailable`, `purchase_in_progress`, `card_declined` (with `category`), `plan_unavailable`, `sales_disabled`, `account_deleted`, `throttled`, and `switch_incomplete` for a repeated attempt, past the purchase lock, whose earlier call ended before recording Stripe's answer and that never got paid.

### Logs

Each callable logs `<event>_start`, `_success`, `_rejection` (code, reason, category) or `_failure` (stage, error name, Stripe or safe code) with an `operationId`: `web_plans`, `web_purchase_start`, `web_purchase_finish`, `web_subscription_read`, `web_subscription_manage`. Also `web_purchase_start_reprice`, `_retried`, `_declined`, `_token_refused`, `_settle_timeout`, `web_purchase_failed`, `web_purchase_abandoned`, `web_subscription_card_applied`, `web_subscription_past_due_paid`, `web_subscription_switch_reprice`, `_switch_busy`, `_switch_updated`, `_switch_requires_action`, `_switch_paid`, `_switch_declined`, `_switch_earlier_voided`, `_switch_settle`, `_switch_after_payment_failure`, the same `web_subscription_lifetime_*` lines for the upgrade plus `_lifetime_invoiced` and `_lifetime_settle_timeout`, and from the sweep `web_switch_failed`. Tokens appear shortened; no key, client secret, email, card number or address is logged.

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
- Turn on TTL for `expiresAt` on the `web_stripe_events`, `web_purchase_throttle` and `web_email_outbox` collection groups (`gcloud firestore fields ttls update expiresAt --collection-group=<name> --enable-ttl`).
- Deploy the rules.
- Deploy `stripeWebEvents` by name, register its URL in the Stripe Dashboard for the handled types, and store the signing secret as `STRIPE_WEB_WEBHOOK_SECRET`.
- Redeploy `reconcileSubscriptions`, `deleteAccount`, `accountDeletedCleanup` and `sweepDeletedAccounts` by name, since each now mounts `STRIPE_WEB_SECRET_KEY`.
- Deploy `getWebPlans`, `startWebPurchase`, `finishWebPurchase`, `getWebSubscription` and `manageWebSubscription` by name.
- **Stage K** (the one account page) changes no request or answer, so page and functions deploy in any order. The functions deploy changes how the billing emails write money and adds the paid-but-not-shown refusal to `startWebPurchase`, an existing reason every page already handles.
- **Order for stage J:** deploy the accounts page before these functions too. `startWebPurchase` then refuses full-price lifetime to a running web subscriber, and only the new page offers the upgrade on `/manage` and hides lifetime from `/subscribe` for them.
- **Order for stages H and I:** deploy the accounts page before these functions. `startWebPurchase` now refuses `existing_premium` unless the request carries `acknowledgeExisting`, which the live page does not send, so functions first would refuse every buyer who also holds store or manual premium. The plan switch adds actions only, so an older page keeps working with the new functions.
- Deploy `sendWebBillingEmail` by name (it mounts the two SES secrets of the auth emails), and redeploy `stripeWebEvents` and `reconcileSubscriptions` with the billing emails. Deploy the sender before or with the queuing functions, so nothing waits in the outbox past its 24 hours.
- Add `invoice.upcoming` to the webhook endpoint's events, and make the Stripe settings in "Owner's steps in Stripe before live sales".

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

It seeds `web_pricing/config` (its uids as testers, SA as a low-tier and AE as a reduced country, since Stripe has no Egyptian or Turkish test cards) and attested store countries, then buys each plan, re-prices a low-tier account's US card, declines, refunds, disputes, cancels and resumes, replaces a card with a dearer-tier one, runs a failed renewal on a test clock into grace and `billing_retry`, rebuilds a deleted slot from the reconcile phase alone, and abandons a pending purchase through the sweep. It deletes its customers and its test clocks.

With the argument `lifetime` only the upgrade runs, each scenario on its own test clock: from monthly ten days in (the invoice's lines and total against the quote, the subscription cancelled, then the clock past the old renewal date with no invoice, credit note or balance), from a yearly plan reached by the switch, and a card that fails when charged. `switch lifetime` runs both. With the argument `switch` (`... verify-web-purchase.mjs switch`) only the plan switch runs, each scenario on its own test clock whose customer carries no metadata (only the emulator's mapping names it): a switch end to end through the callables, ten days into a monthly subscription (quote, charge equal to the quote, Stripe's anchor and period, slot, ledger and email, the same attempt again), the renewal a year later as a plain yearly invoice, a card that fails when charged (`pm_card_chargeCustomerFail`), and a switch from a cancelled subscription. Completing a bank step needs a browser and is covered only by the fake.
