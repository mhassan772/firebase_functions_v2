# Listening competitions: server-side design (draft)

Status: draft for discussion, 2026-11-10. Nothing here is built.

Goal: a base for app-wide competitions and user comparisons that counts real listening time, is dated, and cannot be inflated by playback speed or by editing old days. The lifetime totals in `listener_totals` are not that base: before app 90.7 they count audio covered (2x speed counts double), they carry no dates, and they stay as the public "hours of audio played" figure only. See [listening-stats.md](listening-stats.md).

## What app 90.7 syncs

Read from the app code on 2026-11-10 (`Mantooq_Mobile`, `lib/feature/listening_history/data/sync/`). 90.7 is not in a tagged release yet.

| Document | Content |
|---|---|
| `listening_history/{uid}` | Index: `years`, `daysUpdated` and `completionsUpdated` (per year, when last written), `updatedAt`. Replaced whole on every push. |
| `listening_history/{uid}/chunks/{year}` | `days: [{d, day, m, cs, ss, sl, g, u}]`, one row per device and day. Replaced whole on every push. |
| `listening_history/{uid}/completions/{year}` | `completions: [{c, k, s, day, t, u, deleted}]`, one row per finished title and day. |

Day row fields:

| Field | Meaning |
|---|---|
| `d` | Device id |
| `day` | The "goal day": the user's local date as days since 1970-01-01, moved back one when the hour is before their day-start hour |
| `m` | Content heard, whole minutes |
| `cs` | Clock seconds listened (missing on rows from before the app's schema 85) |
| `ss`, `sl` | Seconds saved by speed and by skipped silence |
| `g` | The daily goal in minutes in force that day |
| `u` | When the row was last written |

Completion row fields: `c` content id, `k` kind (`book`, `episode`, `recitation`), `s` source (`seeded` from old progress, `manual` marked by hand, `played` heard to the end), `day`, `t` completed at.

Both are owner-only in the rules and nothing on the backend reads them today. Pushes follow the same interval as listening time (about hourly for free users).

## Gaps to close before 90.7 ships

These need an app change. After release, each one costs an update cycle, and the second one cannot be fixed later at all for users who stay on 90.7.

1. **The row has no time zone and no app build.** `day` is a local date, so the server cannot tell exactly which real hours it covers, or reject a day that is still in the future for that user. Add the UTC offset in minutes at the last write (`z`) and the build number that wrote the row (`v`).
2. **Older versions erase fields they do not know.** A row the app can read is rebuilt from its known fields when the year is pushed, and the index document is replaced whole. Any field a later version adds to a day row, a completion row or the index is deleted the next time a 90.7 device pushes that year. Carry unknown fields through a read and write them back (rows and index), so the format can grow.
3. **Optional: a per-day count of listening sessions** (`n`). It gives the server one more consistency signal (ten hours in one session overnight looks different from ten hours in twelve sessions) without sending every heartbeat.

Not needed for competitions: per-title time per day. The day row is enough for time and goal-based boards, and completions cover title-based ones.

## Server design

### Principles

- The server keeps its own copy of each day, which no client can write. Competitions read only that copy.
- A day can grow only while it is recent. After the window closes the server's copy is frozen, whatever the client writes later.
- Nothing is deleted for looking wrong. A day is capped or flagged, and a flagged user is held off boards until reviewed.
- Only users who joined a competition are processed, so cost follows participation, not the whole user base.
- Totals move by increments inside the same transaction as the day they come from, as the listen-time triggers do. No periodic recount, except a drift check.

### Collections

| Document | Fields | Notes |
|---|---|---|
| `competition_members/{seasonId}_{uid}` | `seasonId`, `uid`, `joinedAt`, `league`, `score`, `clockSeconds`, `daysGoalMet`, `completions`, `flagged`, `updatedAt` | Created when the user opts in (callable function). The board reads this. Clients read it through a callable or a restricted rule, never write it. |
| `competition_days/{uid}_{day}` | `uid`, `day`, `clockSeconds` (accepted), `rawClockSeconds`, `contentSeconds`, `goalMet`, `devices`, `flags`, `frozen`, `updatedAt` | The server's copy of one user's day, summed over devices. Written only for users in a running season. |
| `competition_seasons/{seasonId}` | `startDay`, `endDay`, `metric`, `dailyCapSeconds`, `lateWindowDays`, `minBuild`, `state` | Admin-written. Weekly, monthly or Hijri-month seasons. |

### Trigger: `listeningHistoryDaysTrigger`

onWrite on `listening_history/{uid}/chunks/{year}`. The before and after data come with the event, so a push that changed no day in a running season reads nothing.

1. Find the days whose rows changed, summed over devices. Stop if the user is in no running season (one read of a small per-user membership list, cached per instance).
2. For each changed day inside a season and inside the late window (`today − lateWindowDays ≤ day ≤ today + 1`, the `+1` covering time zones ahead of UTC):
   - `raw` = sum of `cs` over devices. A row without `cs` is not eligible.
   - Reject and flag when `raw` is over 24 hours, when it went down, or when content time and clock time disagree (`m × 60` should be close to `cs + ss + sl`, and `(cs + ss) / cs` no higher than the app's top speed).
   - `accepted` = `min(raw, dailyCapSeconds)`.
   - In one transaction: update `competition_days`, and add `accepted − previousAccepted` (and any change in `goalMet`) to the member's season totals.
3. A day outside the window is ignored: its server copy is frozen.

Completions get the same treatment from a second trigger on `completions/{year}`, counting only `s == "played"` and one completion per title per season.

### Scoring

Decide per season; the data supports all three:

- **Clock time**, capped per day (suggested cap 10 to 12 hours).
- **Days the daily goal was met**, with a minimum goal so a 1-minute goal does not count. Hardest to inflate and rewards consistency.
- **Completions heard to the end.**

### Fairness rules

- Opt-in only, and only on builds at or above `minBuild`.
- Leagues or groups of similar listeners rather than one global board; a user's league is fixed at season start.
- A user flagged in a season is hidden from boards, keeps their own numbers, and can be cleared by an admin.
- Seasons start empty. Lifetime totals are never carried in.

### What this cannot do

The numbers are reported by the app, so a modified client can still send false days. Caps, the frozen window and the consistency checks stop accidental and casual inflation. For prizes, cross-check flagged or winning users against what the server saw them request (`getUrls`, streams), accepting that offline listening will not appear there.

## Cost

Per push from a user in a running season that changed a day: 1 read and 1 write for the day, 1 write for the member's totals. With hourly pushes that is about 2 writes per participant per hour of listening. Users outside a season cost nothing beyond the trigger invocation. Board reads are one query per view (top N of a league), which should be cached or served by a callable.

## Open questions

1. Is 90.7 already in testers' or users' hands? If so, the erased-fields problem already applies to those devices.
2. Which metric for the first season, and is there a prize? A prize raises the bar for verification.
3. Global seasons or groups first (study circles, friends)?
4. Should the day-start hour matter for competitions, or should seasons use plain local dates?
