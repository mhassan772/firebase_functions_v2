# Podcast charts

The app's home shows two podcast charts: popular podcasts and popular converted podcasts. Each one ranks podcasts by how many different users engaged with them in the last 60 days. This page covers the functions that build the charts, the documents they use and the settings that control them.

## Functions

| Function | Kind | What it does |
|---|---|---|
| `popularPodcastsV1` | Scheduled, every day at 00:15 Europe/Berlin | Collects engagement synced since its last run, rebuilds both charts, and deletes audit records past retention. |
| `podcastFollowAuditTrigger` | onWrite on `podcast_subscriptions/{uid}` | Temporary. Records follows from older app versions. |
| `podcastConvertAuditTrigger` | onWrite on `converted_podcasts/{uid}` | Temporary. Records conversions from older app versions. |

### popularPodcastsV1

1. It reads `podcast_audit_state/daily.lastRunAt` and starts collecting from one day before it. The overlap covers device clocks that run behind. On the first run there is no state, so it starts two days back; the backfill script covers anything older.
2. It reads the per-user documents that changed since then, in pages:
   - `episode_progress` where `updateTimestamp` is later. All app versions write this field.
   - `podcast_subscriptions` and `converted_podcasts` where the top-level `updatedAt` is later. Only app versions from the home redesign onward write this field. Older versions are covered by the two triggers.
3. From each document it builds one event per podcast and action, dated as follows:
   - A follow is dated by the subscription's `subscribedAt`.
   - A conversion is dated by its `convertedAt`.
   - A listen is dated by the latest `updatedAt` among the user's episodes of that podcast that have been played at all (a position above zero). Deleted episodes do not count.

   Events older than retention are dropped, and dates in the future are moved back to now. Each event overwrites its document, so a podcast heard 70 days ago and again today is dated today and counts again.
4. Once every write has succeeded, it sets `lastRunAt` to the time the run started. If a write fails, the mark stays put and the next run collects the same documents again.
5. It ranks the podcasts:
   - The popular chart counts the distinct users with a follow or a listen inside the window.
   - The converted chart counts the distinct users with a conversion, or a listen to a converted podcast, inside the window. A user who did both counts once.
   - Podcasts in the admin deny list (`settings_app/admin_deny{n}`) are left out. Category blocking is not applied, because it needs each podcast's categories from Podcast Index.
6. It adds what the app needs to draw each row, so phones never call Podcast Index for the charts (see "Podcast metadata" below). A podcast with no title or image is left out and logged, and the next podcast down takes its place, so each chart still fills to the list length.
7. It deletes audit records older than retention, in batches of 500.

### Podcast metadata

Each entry gets its title, image and ids from the first of these sources that has them, matched by Podcast Index feed id:

1. The hand-picked lists: `settings_app/popular_podcasts_{1..n}` (field `popular_podcasts`) and `settings_app/popular_converted_podcasts_{1..n}` (field `popular_converted_podcasts`). The values of `n` come from `settings_app/settings_metadata.podcasts_featured.number_of_popular_podcasts` and `number_of_popular_converted_podcasts`, and default to 1.
2. Yesterday's chart entries, so a podcast that stays in a chart is looked up only once.
3. The Podcast Index API (`/podcasts/byfeedid`), signed with the keys in `settings_app/settings_metadata.podcast_index_keys`.
   - It makes at most one call per chart entry each run, and each call times out after 5 seconds.
   - A failed call only leaves that podcast out for the day.
   - Without keys, no calls are made.
   - The keys are never logged.

### The two triggers

Each trigger compares the document before and after a write. It records items that are active after the write and were absent or deleted before it.

- **Dates:** each event is dated by the item's own date, `subscribedAt` or `convertedAt`. Future dates are moved back to now.
- **Retention:** an event is written only when that date is within retention.
  - An old app that was offline and pushes days later still counts.
  - A first sync or a reinstall that restores old history cannot pass as recent, because each event keeps its real date, and retention drops anything older.
- **Reads:** the triggers read nothing beyond the change, except the retention setting. They read it only when something was added, and each instance keeps it for 10 minutes.
- **Writes:** they write with `set()`, so they agree with the daily job when both see the same item.

### Converted podcast listens written by the app

No synced document shows that a user listened to a converted podcast, so the app writes that event itself.

- **Document:** `converted_podcast_audit/listen_{uid}_{podcastId}`, where `podcastId` is the `p-` form.
- **Fields:** exactly `podcast_id`, `book_guid`, `user_guid`, `action: 'listen'` and `timestamp`, with `timestamp` set to the server time.

The rules let a signed-in user create this document, or update it, only when all of these hold:

- The id is `'listen_' + uid + '_' + podcast_id`.
- `user_guid` is the user's own uid.
- `action` is `'listen'`.
- `timestamp` is the request time.
- `podcast_id` and `book_guid` are non-empty strings of at most 200 characters.
- The document has exactly the five fields above.

An update must also keep `podcast_id` and `user_guid` unchanged, and the stored `timestamp` must be more than a day old, so each listen is re-dated at most once a day. A second write within the day is refused with PERMISSION_DENIED, which the app should ignore. Clients cannot read, list or delete these documents. `convert_` documents and everything in `podcast_audit` stay server-only.

## Firestore documents

No client can read the audit or state documents, and the only client write allowed is the converted listen described above (see `firestore.rules`). The chart documents can be read by anyone.

| Document | Fields |
|---|---|
| `podcast_audit/follow_{uid}_{podcastId}` | `podcast_id`, `user_guid`, `action: 'follow'`, `timestamp` |
| `podcast_audit/listen_{uid}_{podcastId}` | `podcast_id`, `user_guid`, `action: 'listen'`, `timestamp` |
| `converted_podcast_audit/convert_{uid}_{podcastId}` | `podcast_id`, `book_guid`, `user_guid`, `action: 'convert'`, `timestamp` |
| `converted_podcast_audit/listen_{uid}_{podcastId}` | `podcast_id`, `book_guid`, `user_guid`, `action: 'listen'`, `timestamp` (written by the app) |
| `podcast_audit_state/daily` | `lastRunAt` |
| `popular_podcasts_v2/popular_podcasts` | `popular_podcasts: [{podcast_id, users, title, image, podcastIndexId, itunesId?, podcastGuid?, author?, owner?}]`, `date_added`, `date_updated` |
| `popular_podcasts_v2/popular_converted_podcasts` | Same shape as `popular_podcasts` |

- `podcast_id` is the app's podcast id: `p-` plus the Podcast Index feed id, such as `p-920666`. A bare feed id in older data is stored in that form too.
- `timestamp` is a Firestore Timestamp.
- A `/` in an id is replaced with `_`.
- In a chart entry:
  - `title` and `image` are non-empty strings.
  - `podcastIndexId` is the feed id as an integer.
  - `itunesId` is an integer, and `podcastGuid`, `author` and `owner` are strings. Each of these four is left out when unknown.
- The charts are sorted by `users`, highest first, with ties ordered by feed id.

## Settings

The settings are optional fields in `settings/mantooqAppSettings`, the same document the book chart reads. When a field is absent or not a positive number, the default applies.

| Field | Default | Meaning |
|---|---|---|
| `popularPodcastsDays` | 60 | The window the charts count. |
| `popularPodcastsAuditRetentionDays` | 65 | How long audit records are kept, and how old an item the triggers still record. It is never set below the window plus one day. |
| `numberOfPopularPodcastsToReturn` | 50 | How many entries each chart keeps. |

Clients cannot read this settings document.

## One-off backfill

`scripts/backfill/podcast-audit.mjs` fills the audit collections from everything users have already synced, so the charts start full. Run it once, near the first deploy. It uses Application Default Credentials (`gcloud auth application-default login`), and it goes to the emulator instead when `FIRESTORE_EMULATOR_HOST` is set.

```bash
npm run build
npm run backfill:podcast-audit -- --project mantooq-test
```

The dry run reads every document in the three source collections and writes nothing to Firestore. It saves the events it would write, with totals and the top 20 of each chart, to `backfill-podcast-audit-<project>-<time>.json`. That file holds user ids and is gitignored.

Review the file, then write it:

```bash
npm run backfill:podcast-audit -- --commit --from <file> --project mantooq-test
```

- The commit step reads no source documents, so it writes exactly what was reviewed.
- It refuses a file made for another project.
- A file older than 24 hours needs `--yes-stale`, because by then the daily job may have written newer dates that the file would overwrite.
- Running it again rewrites the same documents, so a repeat does no harm.

Dry-run options: `--retention-days`, `--page-size`.

## Deploy

Deploy by name only. A plain `firebase deploy --only functions` would offer to delete functions that have no source here.

```bash
npm run build
firebase deploy --only functions:popularPodcastsV1,functions:podcastFollowAuditTrigger,functions:podcastConvertAuditTrigger --project mantooq-test
npm run test:rules
firebase deploy --only firestore:rules --project mantooq-test
```

`firestore:rules` deploys the rules alone. The charts need no new index: every query filters on one field, which Firestore indexes on its own.

## Turn off after about 6 months

**Which functions:** `podcastFollowAuditTrigger` and `podcastConvertAuditTrigger`.

**Why they exist:** they exist only for app versions older than the release that writes a top-level `updatedAt` on `podcast_subscriptions` and `converted_podcasts`. `popularPodcastsV1` cannot find changes in documents written by those older versions. Each trigger runs on every sync push of its document, from every app version, and each run costs one function invocation.

**How to decide:** check in analytics what share of active users is still on versions older than that release. Turn the triggers off once that share is small enough that their follows and conversions no longer change the charts.

**What stops counting:** follows and conversions made on those older versions. Listens are unaffected, because the daily job reads `episode_progress`, which every version updates.

**How to remove them:**

```bash
firebase functions:delete podcastFollowAuditTrigger podcastConvertAuditTrigger --region europe-west2
```

Then remove their two exports from `src/index.ts`, and delete `src/functions/podcasts/podcastFollowAuditTrigger.ts`, `src/functions/podcasts/podcastConvertAuditTrigger.ts` and `src/handlers/podcastAuditTriggerHandlers.ts`.
