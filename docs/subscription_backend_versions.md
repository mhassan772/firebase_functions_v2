# Subscription backend versions

One row per version of the subscription functions. Every version is a git tag `subscriptions/vN` on the commit that completed it; `master` carries the latest. "Go back to version N" means:

```
git checkout subscriptions/vN && npm run build && npm test
firebase deploy --only functions:googleSubscriptionNotifications,functions:appleSubscriptionNotifications,functions:verifySubscription
```

Tags are local until pushed with `git push origin --tags`.

Add `functions:reconcileSubscriptions` once a version includes it; going back to a version that predates it also needs `firebase functions:delete reconcileSubscriptions`. Rules from that commit redeploy with `firebase deploy --only firestore:rules`. Nothing is deployed without an explicit OK.

Going back is safe for data: no existing document changes shape across these versions, newer collections are only read by newer code, and the master is rebuilt from the slot documents on the next store event or app verify. Pub/Sub retries a failing Play notification for 7 days, so a rollback inside that window loses nothing. Not undone by a rollback: an acknowledgement (harmless) and an ownership claim that landed on the wrong account (fixed by hand through the ownership document).

| Version | Tag | Date | What changed | Deployed |
|---|---|---|---|---|
| 5 | `subscriptions/v5` | 2026-10-17 | Baseline: `master` as live before the guard | yes |
| 6 | `subscriptions/v6` | 2026-10-17 | Guard `mayReplaceSlotPurchase`: a lapsed state for another purchase never replaces a living one; `stateApplied` in results and logs; tests pinning the guard | |
| 7 | `subscriptions/v7` | 2026-10-17 | Event clock compares only the same purchase, so a new purchase's delayed notice is never outranked by an older purchase's later-dated event; two lapsed states keep the later-running purchase; event docs carry `purchaseReference`/`originalTransactionId`, `stateApplied`, `refundType`; `subscription_slot_concurrent_purchases` log counts two living purchases on one store | |
