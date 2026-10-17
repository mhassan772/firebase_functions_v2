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
| 8 | `subscriptions/v8` | 2026-10-17 | A Play Store resubscription after expiry is claimed for the expired token's owner (binding-checked) by every entry point: the notification, the app's verify and later the recovery pass; `verifyGoogleSubscription` returns Play metadata (acknowledgement state, start time, out-of-app context) for the handlers; the Play store path is one shared function; the Play function mounts the binding secret | |
| 9 | `subscriptions/v9` | 2026-10-17 | Backend acknowledgement of Play purchases: `subscription_acknowledgements` queue written in the same commit as the entitlement (`pending` when owned, `awaiting-owner` when not), immediate attempt with prompt retries, `runAcknowledgementPhase` for the scheduled retry; the Play API client has a seam (`setPlayApi`) so handler paths run against a fake in tests | |
| 10 | `subscriptions/v10` | 2026-10-17 | Scheduled recovery pass `reconcileSubscriptions` (every 6 hours): acknowledgement retries, Play Voided Purchases replay from a 30-day-clamped checkpoint keyed `voided:<orderId>`, Apple Notification History replay per environment deduped on `notificationUUID`; page tokens stored with their window, checkpoint advances only when the window is done, bounded retry list that stops the run when full; deny-all rules for `subscription_acknowledgements` and `subscription_reconcile_state`. First deploy needs the Cloud Scheduler API | yes, 2026-10-17 (rules, then `googleSubscriptionNotifications,appleSubscriptionNotifications,verifySubscription,reconcileSubscriptions` by name) |
