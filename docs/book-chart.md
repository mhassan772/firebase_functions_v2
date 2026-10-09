# Popular books and listener counts

The app's home shows a popular books chart, and the catalog sorts books by popularity on author and narrator pages and in similar books. Both come from the people who actually listened to each book: a listener is someone with at least 5 minutes of listening on a book, across all their devices, over their whole history. Each person counts once per book.

Downloads, streams and samples are no longer counted anywhere. The `getUrls`, `webDownloads`, `downloadHttpV3` and `streamHttp` functions and the getUrls worker only read Firestore; `books_download_audit` and the `num_downloads`, `num_streams` and `num_samples` counters on `books` are no longer written.

## Where listening comes from

The app keeps a running total of the audio it has played per book and device, in 20-second steps, and syncs it:

| Document | Written by | Shape |
|---|---|---|
| `device_sessions_v2/{uid}` | 90.3 and later | `deviceSessions: [{deviceId, listenTimeEntries: [{contentId, source, sourceId, listenTimeSeconds, firstListenAt, lastListenAt}]}]` |
| `device_sessions/{uid}` | 88.4 to 90.2 | `listenTimes: [{deviceId, listenTimes: {contentId: seconds}}]`; before Feb 2026 the map was named `listenTimeByBooks` |

- Seeking does not add time; only audio played does.
- Podcasts are recorded under `p-<feedId>` (or `podcast-…`) and are skipped. `backfill` entries are milestone credits the app made up and are skipped too. Samples are never recorded.
- One user's totals are summed over devices and play sources. The two collections are never added together: 90.3 copies the older document's time into v2 (as `source: unknown`), so the larger of the two totals wins.
- The whole document is rewritten on every push and has no "changed at" field, which is why triggers read it rather than a nightly query.
- Free users push every `sync_intervals_config.experience.regular` minutes (set to 60, like progress) and premium users every `premium` minutes.

## Functions

| Function | Kind | What it does |
|---|---|---|
| `bookListenTimeTrigger` | onWrite on `device_sessions_v2/{uid}` | Raises the user's line for each book whose listening grew. |
| `bookListenTimeLegacyTrigger` | onWrite on `device_sessions/{uid}` | The same for versions before 90.3. Can be turned off once almost nobody uses them. |
| `mostPopularBooksV3` | Scheduled, every day at 00:05 Europe/Berlin | Adds new listeners to each book's `listeners_count`, then rebuilds the chart. |

### The triggers

1. They compare the document before and after the write, which comes with the event, and find the books whose total grew. A push that adds nothing reads and writes nothing.
2. For each such book, a transaction updates `book_listeners/{uid}_{bookGuid}`:
   - `seconds` becomes the new total, but only if it is higher than the stored one, so it never goes down.
   - `updatedAt` becomes the entry's `lastListenAt`, or the push time when the document has no dates. It is never later than now, since the app writes local time without a zone.
   - `listenedBeforeSessions` is cleared once `seconds` reaches the minimum, and never before.
   - `qualifies` is `seconds >= minimum` or `listenedBeforeSessions`.
   - A new line starts with `addedToBook: false`. The triggers never change it otherwise and never write `books`.

### mostPopularBooksV3

1. **New listeners.** It reads the lines with `qualifies == true` and `addedToBook == false`, groups them by book, and in one batch adds their number to `books/{guid}.listeners_count` and sets `addedToBook` on those lines. Because both happen together, a crash or a second run cannot count anyone twice. Lines for books not in the catalog (converted podcasts, file books) are flagged without an increment.
2. **Chart.** It reads the lines with `updatedAt` inside the window, keeps those that qualify, and counts people per book. Ties are ordered by book guid. Books missing from `books` are left out, and the list is cut to the list length.
3. **Save.** It writes `popular_books_v2/popular_books` as `{popular_books: [{book_guid, listeners}], date_added, date_updated}`. If fewer books than the minimum chart size remain, it keeps yesterday's chart and logs a warning. The app reads only the order of `book_guid`.

## Firestore documents

| Document | Fields | Written by |
|---|---|---|
| `book_listeners/{uid}_{bookGuid}` | `book_guid`, `user_guid`, `seconds`, `updatedAt`, `listenedBeforeSessions`, `qualifies`, `addedToBook` | The triggers, the nightly job (`addedToBook`) and the backfill. Kept forever; it is what lets each person count once. Closed to clients. |
| `books/{guid}.listeners_count` | All-time listeners | The nightly job and the backfill. |
| `popular_books_v2/popular_books` | The chart | The nightly job. Public read. |

`listenedBeforeSessions` marks a person who counts only because older data shows they listened before listening time was synced (see the backfill). Seconds are never estimated from progress: a made-up total would hide real listening from the trigger until it caught up.

The admin portal builds the catalog database's `num_downloads` column from `listeners_count`, so the app's popularity sorting uses listeners without an app change. The Firestore `num_downloads` field is no longer updated.

## Settings

In `settings/mantooqAppSettings`:

| Field | Default | Meaning |
|---|---|---|
| `mostPopularBooksDays` | 30 | Days of listening the chart counts. |
| `numberOfMostPopularBooksToReturn` | 100 | Books in the chart. |
| `popularBooksMinListenSeconds` | 300 | Lifetime listening on a book that makes someone its listener. |
| `popularBooksMinChartSize` | 20 | Below this many books the previous chart is kept. |

`numberOfDaysToDeleteMostPopularBooksAfter` is no longer read.

## One-off backfill

`scripts/backfill/book-listeners.mjs` fills `book_listeners` and every book's `listeners_count` from all synced history, so the numbers are right from the start.

- It reads every `device_sessions_v2` and `device_sessions` document for seconds and dates.
- It also reads `playback_progress_v2` (with its chunks), `playback_progress`, `completed_books_v2` and `completed_book`, so people who listened before listening time was synced (before 88.4) are counted. A book there counts when it is finished, or its chapter positions add up to the minimum. It only sets `listenedBeforeSessions`, and only where the sessions fall short of the minimum.
- Lines with no session dates count all-time but never in the chart.

Run:

1. `npm run build`
2. `npm run backfill:book-listeners -- --project mantooq-test` writes `backfill-book-listeners-<project>-<time>.ndjson` and a `.summary.json` with totals and the top 20 books for the window and all-time. Nothing is written to Firestore.
3. Review the summary, then `npm run backfill:book-listeners -- --commit --from <file>.ndjson --project mantooq-test`. It writes the lines, merging any already stored (by the triggers since the dry run, or by an earlier commit that stopped), and sets `listeners_count` exactly. About 2 million lines take roughly 25 minutes; it prints progress every 50,000 lines and can be run again if it stops.

On production the dry run read about 667,000 documents from 344,000 users and produced about 1.96 million lines, 1.33 million of them from old data only.

The commit must run after the triggers are deployed and before the new `mostPopularBooksV3` is.

## Deploy

1. `firebase deploy --only firestore:rules,firestore:indexes --project mantooq-test`
2. Remote Config: `sync_intervals_config.experience.regular` to 60.
3. `firebase deploy --only functions:bookListenTimeTrigger,functions:bookListenTimeLegacyTrigger --project mantooq-test`
4. The backfill dry run, review, then the commit.
5. Set `mostPopularBooksDays` to 30, then `firebase deploy --only functions:mostPopularBooksV3 --project mantooq-test` and run it once from Cloud Scheduler.
6. `firebase deploy --only functions:getUrls,functions:webDownloads,functions:downloadHttpV3,functions:streamHttp --project mantooq-test`, and `npx wrangler deploy` in `workers/get-urls`.
7. Deploy the admin portal and rebuild the catalog database.
8. Delete the old download records: `npm run cleanup:delete-collection -- --collection books_download_audit --project mantooq-test`, then with `--commit`, and the same for `books_download_audit_long_term`. Export them first if you want a copy.
