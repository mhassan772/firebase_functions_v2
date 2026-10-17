# Subscription backend lab, 2026-10-17

Versions 10 to 12 (see `subscription_backend_versions.md`) on the Google test track, account PA on `Mantooq_Purchases_A`, licence tester GA1. Times are UTC. The backend acknowledged every purchase itself; the app's own acknowledgement afterwards raised no visible error.

| Step | What happened | Backend | Result |
|---|---|---|---|
| Buy monthly (19:12) | Premium within seconds | verify → claimed, acknowledged on attempt 1 (3 s after verify); PURCHASED notice then recognised as the same purchase | pass |
| Accelerated renewals (19:18, 19:23) | Still premium, expiry moved | RENEWED applied twice | pass |
| Refund of the original order from Order management | Order refunded, subscription stayed active | nothing sent by Play | n/a: a refund without "remove entitlement" does not end the subscription |
| Cancel subscription from the order page (19:25) | "Ends on …", premium until expiry | CANCELED applied, then EXPIRED at 19:28 | pass |
| Buy monthly again (19:28) | Premium | new token claimed and acknowledged on attempt 1 | pass |
| Replay of the old token's EXPIRED, dated after the new purchase (19:33) | Still premium | claimed, `stateApplied: false`; the new purchase's renewal applied 14 s later | pass: the original bug |
| Refund with revoke of the active order (19:37) | Free | VOIDED_PURCHASE (refundType 1) applied as revoked, REVOKED then EXPIRED followed | pass |
| Buy monthly a third time (19:38) | Premium | PURCHASED notice arrived 2 s before the app's verify: recorded unowned with acknowledgement `awaiting-owner`; the verify claimed it, flipped it to `pending` and acknowledged | pass: the awaiting-owner path |
| Replay of the second purchase's VOIDED_PURCHASE, dated now (19:38) | Still premium | claimed, `stateApplied: false`, refund type recorded | pass: the lab timeline |
| Cancel from Play's manage page, expiry (19:40, 19:43) | Free after expiry | CANCELED then EXPIRED applied | pass |
| Resubscribe from Play's expired list (19:44) | Play: "Server error", twice | nothing sent | blocked by Play on this emulator; covered by the integration test with the fake Play |
| Plan change monthly → yearly | Play's manage page offers no plan change for this product; the app shows no plans while subscribed | not run | not covered today |

Recovery pass, triggered by hand through its Pub/Sub topic:

- First run (v10): Apple production history walked 414 notifications over 21 pages, all already handled. Play voided and Apple sandbox refused their first page for the start time (fixed in v11 and v12).
- Final run (v12): all four phases complete. Play voided replayed 12 entries from the earlier lab's chargebacks, all claimed, none allowed to change a state. Apple sandbox fell back to a 7-day window and found its 7 notifications already handled.

Play Console notes:

- Orders live under **Order management** at the account level, not under the app's "Monetise with Play".
- A refund without "remove entitlement" only refunds the order; the subscription keeps renewing and Play sends nothing. The revoke option appears only on an order whose subscription is still active.
- "Cancel subscription" on the order page sends CANCELED and lets the subscription run to its expiry; it is not a chargeback.
