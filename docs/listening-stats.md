# Listening stats and the public numbers

The donation site (books.mantooq.com) shows four numbers: audiobooks in the app, hours listened, listeners and donors. They live in one document anyone may read, `public_stats/site`, and come from what the app already syncs. Nothing here needs an app release.

Where listening comes from, and how the triggers read it, is in [book-chart.md](book-chart.md). This page covers what was added on top.

## What is stored

| Document | Fields | Written by |
|---|---|---|
| `podcast_listeners/{uid}_{podcastId}` | `podcast_id`, `user_guid`, `seconds`, `updatedAt` | The listen-time triggers and the backfill. One per user and podcast, all episodes together: the app records time per podcast, never per episode. Closed to clients. |
| `listener_totals/{uid}` | `user_guid`, `bookSeconds`, `podcastSeconds`, `totalSeconds`, `lastListenAt`, `isListener` | The listen-time triggers and the backfill. One per user. Closed to clients. |
| `public_stats/site` | `listeners`, `hoursListened`, `bookHoursListened`, `podcastHoursListened`, `audiobooks`, `donors`, `updatedAt`, `listenersCheckedAt` | See below. Readable by anyone; numbers only. |

- A podcast id is `p-<feedId>`. An id synced as `podcast-p-<feedId>` is stored under the plain id, so one podcast is never split in two.
- A **listener** is a user whose `totalSeconds`, books and podcasts together, has reached `popularBooksMinListenSeconds` (5 minutes by default, the same setting the book chart uses per book). `isListener` turns true then and never turns false.
- `backfill` entries in the session documents are milestone credits the app made up; they are not listening and are left out everywhere.

## Functions

| Function | Kind | What it does |
|---|---|---|
| `bookListenTimeTrigger`, `bookListenTimeLegacyTrigger` | onWrite on the session documents | As before for books. Now also raise the podcast lines that grew, add the growth to the user's totals, and add 1 to `listeners` the first time the user reaches the minimum. |
| `refreshPublicStats` | Scheduled, every day at 00:35 Europe/Berlin | Sets hours listened, audiobooks and donors. Never writes `listeners`. |
| `checkPublicListeners` | Scheduled, the 1st of each month at 03:00 Europe/Berlin | Counts every listener and corrects `listeners` if it drifted, logging a warning with both values. |

### The triggers

1. A write that grew no book and no podcast reads and writes nothing.
2. Otherwise one transaction reads the user's totals and the lines that grew, raises the lines, and adds exactly what the lines moved by to the totals. A repeated or retried event finds the lines already raised and adds nothing.
3. A user with no totals yet is seeded from the whole session document, because their book lines already hold the listening from before totals existed.
4. When the totals reach the minimum for the first time, the same transaction adds 1 to `listeners`. That happens once per user, ever, so the public document is written rarely.

Hours are not kept as a running total: they grow on every sync from every active user, which would mean one document written constantly. They are summed once a day instead.

### The daily job

- **Hours**: one aggregate query summing `bookSeconds` and `podcastSeconds` over `listener_totals`.
- **Audiobooks**: the number of `books` documents minus those with `is_book_hidden == true` (a book that was never hidden may not have the field).
- **Donors**: distinct `email` values across `DONATE_donations`, which holds the donation site's Stripe orders and the imported Squarespace ones. It counts emails, not people.

## What the numbers leave out

- Guests who never sign in: their listening stays on the device.
- Anything before listening time was synced (July 2025).
- Totals from app builds before the late October 2026 player rewrite counted content position, so listening at 2x added about double. That time is still inside the stored totals.

Treat hours listened as approximate for those reasons.

## Cost

Firestore bills aggregate queries at about one read per 1,000 documents.

| Piece | Reads | Writes |
|---|---|---|
| Trigger, per sync that grew something | 1 (totals) + 1 per line that grew | The same |
| Daily job | About `listener_totals` / 1,000, plus 1 per donation record | 1 |
| Monthly check | About `listener_totals` / 1,000 | 1 |
| Backfill, once | 1 per `device_sessions_v2` and `device_sessions` document | 1 per user with listening + 1 per user and podcast |

Before this change the trigger did 1 read and 1 write per book that grew, so a sync adds one read and one write for the totals, plus one each per podcast listened to.

## One-time backfill

The triggers only see users whose app syncs from now on. `scripts/backfill/listen-stats.mjs` catches up on everyone else, reading both session collections once.

1. Deploy the rules and the triggers first (see below), so listening synced after the dry run is not lost.
2. `npm run build && npm run backfill:listen-stats -- --project mantooq-test`. Writes nothing to Firestore. It saves the documents it would write to an `.ndjson` file and prints a summary: users, listeners, hours, the top podcasts, and how many podcast ids had an old or unknown shape.
3. Review the summary, then `npm run backfill:listen-stats -- --commit --from <file>.ndjson --project mantooq-test`. It writes from the file without reading the session documents again. A document the triggers already wrote is merged, keeping the larger totals, so the commit can be run again if it stops. It ends by setting `listeners` and the hours in `public_stats/site` from what is stored.

If a commit wrote its documents but stopped before publishing, `npm run backfill:listen-stats -- --publish --project mantooq-test` does only that last step.

## Deploy order

1. `firebase deploy --only firestore:rules --project mantooq-test`
2. `firebase deploy --only functions:bookListenTimeTrigger,functions:bookListenTimeLegacyTrigger --project mantooq-test`
3. Run the backfill, dry run then commit.
4. `firebase deploy --only functions:refreshPublicStats,functions:checkPublicListeners --project mantooq-test`
5. Deploy the donation site, which falls back to its built-in numbers until `public_stats/site` exists.
