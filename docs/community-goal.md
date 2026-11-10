# Community listening goal

Each Hijri month has one shared goal: the hours every signed-in user listened to together. The app shows it behind the `community_goal` kill switch; the server counts whether or not the switch is on, so the portal has numbers before anyone sees the feature.

The data contract shared with the app and the admin portal is `docs/ai/plans/26-11-10/community-goal-contract.md` in the Mantooq_Mobile repo. This page covers the server side.

## What is stored

| Document | Fields | Written by |
|---|---|---|
| `community_goals/{key}` | `hijriYear`, `hijriMonth`, `firstDay`, `lastDay`, `targetHours`, `dailyCapSeconds`, `closeAfterDays`, `show`, `auto`, `status`, `totalSeconds`, `totalUpdatedAt`, `participants` (only while `show.participants` is on), `closedAt`, `recount`, `updatedAt`, `updatedBy` | The hourly job creates it and writes the totals; the portal edits the settings. Readable by anyone. |
| `community_goal_stats/{key}` | `totalSeconds`, `participants`, `actualSeconds`, `updatedAt`, `actualUpdatedAt`, `recount` | The hourly job and the recount. Admins read it; no client writes it. |
| `listener_totals/{uid}.months` | key → `{c, a}`: counted and actual seconds | The listening trigger and the recount. At most 60 keys; the oldest goes when another is added. Closed to clients. |

- A key is `h{hijriYear}{MM}`, for example `h144807` for Rajab 1448.
- A goal day is the number of days since 1970-01-01 of a local calendar date. The app stamps every listening row with the user's own goal day.
- closesAt is never stored: `(lastDay + 1 + closeAfterDays) × 86,400,000` UTC milliseconds.
- A user's value for a month: for each day of the window, up to one day after today in UTC, the `cs` of every row of that day across devices, capped at `dailyCapSeconds`; then the sum. A row whose `cs` is missing or not a number of at least 0 counts as 0. `a` is always that value; `c` is that value only while the month is open, and is left as it was afterwards. So `actualSeconds` shows the time that arrived too late to count.

## Functions

| Function | Kind | What it does |
|---|---|---|
| `listeningDaysMonthTrigger` | onWrite on `listening_history/{uid}/chunks/{year}` | Recomputes the user's value for every month the write touched. |
| `refreshCommunityGoals` | Scheduled, every 60 minutes | Creates months, sums them, closes them, refreshes late time and resumes recounts. 300 s, 256 MB. |
| `communityGoalRecountTrigger` | onWrite on `community_goals/{key}` | Recounts a month when the portal sets a new `recount.requestedAt`. 540 s, 512 MB. |

### The listening trigger

1. It compares the seconds per day before and after the write. If no day changed, it reads nothing.
2. Otherwise it reads the goals, cached per instance for 10 minutes (the newest 60 by `firstDay`), and keeps those with a changed day in their window. Closed months are included, since their late time still moves.
3. For each, one transaction reads the goal, the year documents its window spans (both years when it crosses 1 January) and `listener_totals/{uid}`, computes the value from those reads and merges it into `months.<key>`.

The value comes from the rows as stored, never from the event, so a repeated or out-of-order event writes the same result, and a value goes down when rows shrink. A user with nothing stored and a value of 0 gets no entry.

### The hourly job

Each run, in order:

1. Makes sure the current Hijri month exists, and from 10 days before its first day the next one. A month is created only when missing, never overwritten. The first and last day come from the Umm al-Qura calendar (`Intl.DateTimeFormat` with `islamic-umalqura`). A new month copies `targetHours`, `dailyCapSeconds`, `closeAfterDays` and `show` from the month before it, else takes the defaults (no target, 12 hours a day, 3 days' grace, only `history` shown). Its first day is the previous month's `lastDay + 1` when that month exists, so an end date moved in the portal moves the next start too. It is marked `auto: true` until someone saves it in the portal.
2. For each open month, three aggregate queries over `listener_totals`: the sum of `months.<key>.c`, the sum of `months.<key>.a`, and the count with `c > 0`. One aggregate per query, which needs no composite index. All of it goes to the stats document; the goal gets `totalSeconds` and `totalUpdatedAt`, and `participants` only while `show.participants` is on (otherwise the field is removed).
3. Once now reaches closesAt, the same write sets `status: "closed"` and `closedAt`. A closed month's goal document is never changed by the server again.
4. For months closed in the last 60 days, it re-sums `a` into the stats document's `actualSeconds`, at most once every 24 hours.
5. It resumes a recount still `running` whose progress has not moved for 10 minutes. A request no trigger started within 10 minutes is started here, reaching back a further 31 days because the old first day is no longer known.

One step failing does not stop the others; the run then ends with an error so the log shows it.

### Recounts

The portal sets `recount.requestedAt` when it changes the dates or the cap of a month that has started and is still open. The recount trigger ignores every other write to the goal, the hourly totals included, so nothing loops.

1. A closed month, or one past closesAt, is refused: the stats document's `recount` says `failed` with the reason.
2. Otherwise it records `running` in `community_goal_stats/{key}.recount` and pages through the `listening_history` index documents whose `updatedAt` is on or after the day before the earlier of the old and new first day, ordered by `updatedAt` and then id, 200 at a time, 10 users at once. Anyone who uploaded a day of either window is among them.
3. Each user's month is recomputed with the listening trigger's function, so a user whose value falls to 0 under the new window is written as 0.
4. After each page it saves `processed`, the cursor and `progressAt`. It stops a minute before its timeout and leaves the state `running`, for the hourly job to resume from the cursor. The cursor keeps whole milliseconds, so a resumed run may redo a few users, which writes nothing new.
5. When the last page is done it sums the month as the hourly job does and marks the recount `done`.

A repeated event for a request already recorded does nothing. A newer request replaces an older run, which stops at its next save.

Besides the contract's fields, `recount` holds `progressAt`, the time of the last saved page, which tells the hourly job whether a run has stopped. `fromDay` is the day the search starts from: the day before the earlier first day.

## Cost

Firestore bills aggregate queries at about one read per 1,000 index entries.

| Piece | Reads | Writes |
|---|---|---|
| Listening trigger, a write that changed no day in a goal | 0 (plus the goals, once per instance every 10 minutes) | 0 |
| Listening trigger, per month touched | 1 goal + 1 or 2 year documents + 1 totals | 1, or 0 when the value is unchanged |
| Hourly job, per open month | 3 aggregates (about users with an entry / 1,000 each) + 1 goal | 2 |
| Recount | About 4 per user found, plus 1 per 200 users | 1 per user whose value changed, plus 1 per page |

## Deploy

Deploy by name only; never a plain functions deploy.

1. `firebase deploy --only firestore:rules --project mantooq-test`
2. `firebase deploy --only functions:bookListenTimeTrigger,functions:bookListenTimeLegacyTrigger --project mantooq-test`. These two carry the seeding change and must be live before the new trigger: the new trigger can create `listener_totals/{uid}` with only `months`, and the old seeding check would then skip a new user's lifetime totals.
3. `firebase deploy --only functions:listeningDaysMonthTrigger,functions:refreshCommunityGoals,functions:communityGoalRecountTrigger --project mantooq-test`
4. Check the first hourly run's log: the current month (and the next, if it starts within 10 days) is created and summed. An error there about an index means the sum over `months.<key>.c` needs an index setting.
5. Once the current month exists, press Recount on it in the admin portal. A user's month is otherwise recomputed only on their next upload of a day in it, so listeners who uploaded before the deploy and not since would be missing from the month already under way.

There is no backfill script. The job creates each later month before it starts, so only the month under way at the first deploy needs that recount.
