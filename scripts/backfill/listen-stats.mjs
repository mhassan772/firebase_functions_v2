/**
 * Seeds `podcast_listeners` and `listener_totals` from everything users have already synced, then
 * sets the listeners count and hours in `public_stats/site`. After this, only the listen-time
 * triggers add listening. See docs/listening-stats.md.
 *
 * Two steps, so what gets written is reviewed first, and the users' documents are read once:
 *
 *   npm run build
 *   npm run backfill:listen-stats -- --project <id>
 *       Dry run. Reads every device_sessions_v2 and device_sessions document and writes the
 *       documents it would set to backfill-listen-stats-<project>-<time>.ndjson, with a summary
 *       next to it (.summary.json): users, listeners, hours, the top 20 podcasts, and any podcast
 *       ids in an old or unknown shape. Writes nothing to Firestore.
 *
 *   npm run backfill:listen-stats -- --commit --from <file.ndjson> --project <id> [--yes-stale]
 *       Writes the documents in that file. Reads no session documents. A document already
 *       stored, by the triggers since the dry run or by an earlier commit, is merged, keeping
 *       the larger totals, so a commit that stopped partway can be run again. It ends by counting
 *       listeners and summing hours from what is now stored (aggregate queries, about one read
 *       per 1,000 documents) and writing them to public_stats/site. Deploy the triggers first, so
 *       listening synced after the dry run is not lost. A file older than 24 hours needs
 *       --yes-stale.
 *
 *   npm run backfill:listen-stats -- --publish --project <id>
 *       Only that last step: counts and sums what is stored and writes public_stats/site. For
 *       when a commit wrote its documents but stopped before publishing.
 *
 * Options for the dry run: --page-size <n> (default 200).
 *
 * Credentials come from Application Default Credentials (`gcloud auth application-default
 * login`). With FIRESTORE_EMULATOR_HOST set, everything goes to the emulator instead.
 */
import { createReadStream, createWriteStream, readFileSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { initializeApp } from 'firebase-admin/app'
import { AggregateField, FieldPath, FieldValue, getFirestore, Timestamp } from 'firebase-admin/firestore'

const require = createRequire(import.meta.url)
let books
let stats
try {
  books = require('../../lib/handlers/bookListenHandlers.js')
  stats = require('../../lib/handlers/listenStatsHandlers.js')
} catch {
  fail('lib/ is missing or stale. Run `npm run build` first.')
}

const STALE_AFTER_MS = 24 * 60 * 60 * 1000
const LOOKUP_SIZE = 300
/** Firestore's ALREADY_EXISTS: the triggers wrote the document after the dry run. */
const ALREADY_EXISTS = 6
/** Documents queued before waiting for them, so memory stays flat on a file of millions. */
const FLUSH_EVERY = 5000
const PROGRESS_EVERY = 50000

function fail(message) {
  console.error(message)
  process.exit(1)
}

function parseArgs(argv) {
  const args = { commit: false, yesStale: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = () => {
      const next = argv[++i]
      if (next === undefined || next.startsWith('--')) fail(`${arg} needs a value.`)
      return next
    }
    if (arg === '--project') args.project = value()
    else if (arg === '--commit') args.commit = true
    else if (arg === '--from') args.from = value()
    else if (arg === '--yes-stale') args.yesStale = true
    else if (arg === '--publish') args.publish = true
    else if (arg === '--page-size') {
      args.pageSize = Number(value())
      if (!Number.isFinite(args.pageSize) || args.pageSize <= 0) fail('--page-size must be a positive number.')
    } else fail(`Unknown option ${arg}. See the comment at the top of scripts/backfill/listen-stats.mjs.`)
  }
  if (!args.project) fail('--project <id> is required.')
  if (args.publish && (args.commit || args.from)) fail('--publish is used on its own.')
  if (args.commit && !args.from) fail('--commit needs --from <dry run file>.')
  if (!args.commit && args.from) fail('--from is only used with --commit.')
  return args
}

function describeTarget(project) {
  const emulator = process.env.FIRESTORE_EMULATOR_HOST
  console.log(emulator ? `Firestore emulator ${emulator}, project ${project}` : `LIVE Firestore, project ${project}`)
}

/** One `{uid, data}` per document of a collection, in document id order. */
async function* usersOf(db, collection, pageSize, counts) {
  let last
  for (;;) {
    let query = db.collection(collection).orderBy(FieldPath.documentId()).limit(pageSize)
    if (last) query = query.startAfter(last)
    const snapshot = await query.get()
    for (const doc of snapshot.docs) {
      counts[collection] = (counts[collection] ?? 0) + 1
      yield { uid: doc.id, data: doc.data() }
    }
    if (snapshot.size < pageSize) return
    last = snapshot.docs[snapshot.docs.length - 1]
  }
}

/** Walks two user-ordered streams together, yielding each user once with what each has for them. */
async function* byUser(streams) {
  const iterators = Object.entries(streams).map(([name, stream]) => ({ name, stream, head: undefined }))
  for (const it of iterators) it.head = (await it.stream.next()).value
  for (;;) {
    const live = iterators.filter((it) => it.head)
    if (live.length === 0) return
    const uid = live.reduce((min, it) => (it.head.uid < min ? it.head.uid : min), live[0].head.uid)
    const user = { uid }
    for (const it of live) {
      if (it.head.uid === uid) {
        user[it.name] = it.head.data
        it.head = (await it.stream.next()).value
      }
    }
    yield user
  }
}

/** Podcast ids as the app stored them that start with `podcast-`, to report old and unknown shapes. */
function prefixedPodcastIds(data) {
  return [...books.secondsByContent(data, (id) => (typeof id === 'string' && id.trim().startsWith('podcast-') ? id.trim() : null)).keys()]
}

async function dryRun(args) {
  const db = getFirestore()
  const settings = books.resolvePopularBooksSettings((await db.doc('settings/mantooqAppSettings').get()).data())
  const min = settings.minListenSeconds
  const pageSize = args.pageSize ?? 200
  const now = new Date()
  const createdAt = now.toISOString()
  const base = `backfill-listen-stats-${args.project}-${createdAt.replace(/[:.]/g, '-')}`
  const out = createWriteStream(`${base}.ndjson`)
  // The app writes local time without a zone, so a date can read a few hours ahead.
  const iso = (date) => (date ? (date > now ? now : date).toISOString() : null)
  const write = async (entry) => {
    if (!out.write(`${JSON.stringify(entry)}\n`)) await once(out, 'drain')
  }

  const documents = {}
  const totals = { users: 0, usersWithListening: 0, listeners: 0, podcastLines: 0, bookSeconds: 0, podcastSeconds: 0 }
  const podcastIds = { strippedPrefix: 0, unknownShape: 0, examples: [] }
  const byPodcast = new Map()
  const users = byUser({
    sessionsV2: usersOf(db, 'device_sessions_v2', pageSize, documents),
    sessionsLegacy: usersOf(db, 'device_sessions', pageSize, documents),
  })
  for await (const user of users) {
    totals.users++
    for (const id of [...prefixedPodcastIds(user.sessionsV2), ...prefixedPodcastIds(user.sessionsLegacy)]) {
      if (id.startsWith('podcast-p-')) podcastIds.strippedPrefix++
      else podcastIds.unknownShape++
      if (podcastIds.examples.length < 10 && !podcastIds.examples.includes(id)) podcastIds.examples.push(id)
    }
    const result = stats.backfillUser(user.uid, user.sessionsV2, user.sessionsLegacy, min)
    for (const line of result.podcasts) {
      totals.podcastLines++
      const podcast = byPodcast.get(line.podcast_id) ?? { seconds: 0, listeners: 0 }
      podcast.seconds += line.seconds
      podcast.listeners++
      byPodcast.set(line.podcast_id, podcast)
      await write({
        kind: 'podcast',
        id: stats.podcastListenerDocId(user.uid, line.podcast_id),
        data: { ...line, updatedAt: iso(line.updatedAt) },
      })
    }
    if (result.totals) {
      totals.usersWithListening++
      if (result.totals.isListener) totals.listeners++
      totals.bookSeconds += result.totals.bookSeconds
      totals.podcastSeconds += result.totals.podcastSeconds
      await write({ kind: 'totals', id: user.uid, data: { ...result.totals, lastListenAt: iso(result.totals.lastListenAt) } })
    }
  }
  out.end()
  await once(out, 'finish')

  const hours = {
    books: stats.wholeHours(totals.bookSeconds),
    podcasts: stats.wholeHours(totals.podcastSeconds),
    all: stats.wholeHours(totals.bookSeconds + totals.podcastSeconds),
  }
  const topPodcasts = [...byPodcast]
    .sort((a, b) => b[1].seconds - a[1].seconds || (a[0] < b[0] ? -1 : 1))
    .slice(0, 20)
    .map(([podcast_id, podcast]) => ({ podcast_id, hours: stats.wholeHours(podcast.seconds), listeners: podcast.listeners }))
  const summary = {
    project: args.project,
    createdAt,
    minListenSeconds: min,
    documents,
    totals: { ...totals, documentsToWrite: totals.podcastLines + totals.usersWithListening },
    hours,
    podcastsWithListeners: byPodcast.size,
    podcastIds,
    topPodcasts,
  }
  writeFileSync(`${base}.summary.json`, JSON.stringify(summary, null, 2))

  console.log(`A listener is a user with at least ${min} s of listening in all.`)
  console.log('Documents read:')
  console.table(documents)
  console.table(summary.totals)
  console.log('Hours listened:')
  console.table(hours)
  console.log(`Podcast ids: ${podcastIds.strippedPrefix} had "podcast-" in front of "p-…" and were joined to the plain id; ${podcastIds.unknownShape} start with "podcast-" in another shape and were kept as they are.`)
  if (podcastIds.examples.length > 0) console.log(`  Examples: ${podcastIds.examples.join(', ')}`)
  console.log('Top 20 podcasts by hours:')
  console.table(topPodcasts)
  console.log(`\nWrote ${base}.ndjson and ${base}.summary.json. Nothing was written to Firestore.`)
  console.log(`To write these documents: npm run backfill:listen-stats -- --commit --from ${base}.ndjson --project ${args.project}`)
}

function date(value, index) {
  if (value === null) return null
  const parsed = new Date(value)
  if (typeof value !== 'string' || Number.isNaN(parsed.getTime())) fail(`Line ${index + 1} of the file has a bad date; stopped.`)
  return parsed
}

/** Validates one file line; dates come back as Date. */
function parseLine(text, index) {
  let entry
  try {
    entry = JSON.parse(text)
  } catch {
    fail(`Line ${index + 1} of the file is not JSON; stopped.`)
  }
  const { kind, id, data } = entry ?? {}
  const idOk = typeof id === 'string' && id !== '' && !id.includes('/')
  if (kind === 'podcast' && idOk && typeof data?.podcast_id === 'string' && data.podcast_id !== ''
    && typeof data?.user_guid === 'string' && Number.isFinite(data?.seconds)) {
    return {
      kind,
      id,
      data: { podcast_id: data.podcast_id, user_guid: data.user_guid, seconds: data.seconds, updatedAt: date(data.updatedAt, index) },
    }
  }
  if (kind === 'totals' && idOk && data?.user_guid === id && Number.isFinite(data?.bookSeconds)
    && Number.isFinite(data?.podcastSeconds) && typeof data?.isListener === 'boolean') {
    return {
      kind,
      id,
      data: {
        user_guid: id,
        bookSeconds: data.bookSeconds,
        podcastSeconds: data.podcastSeconds,
        totalSeconds: data.bookSeconds + data.podcastSeconds,
        lastListenAt: date(data.lastListenAt, index),
        isListener: data.isListener,
      },
    }
  }
  fail(`Line ${index + 1} of the file is malformed; stopped.`)
}

const timestamp = (value) => (value ? Timestamp.fromDate(value) : null)
const toDate = (value) => (typeof value?.toDate === 'function' ? value.toDate() : null)

/** The document to store for a file line, merged into `existing` when one is already stored. */
function toStore(line, existing, minListenSeconds) {
  if (line.kind === 'podcast') {
    const storedAt = toDate(existing?.updatedAt)
    const updatedAt = storedAt && (!line.data.updatedAt || storedAt > line.data.updatedAt) ? storedAt : line.data.updatedAt
    return {
      ...line.data,
      seconds: Math.max(Number(existing?.seconds) || 0, line.data.seconds),
      updatedAt: timestamp(updatedAt),
    }
  }
  const totals = existing
    ? stats.mergedTotals({ ...existing, lastListenAt: toDate(existing.lastListenAt) }, line.data, minListenSeconds)
    : line.data
  return { ...totals, lastListenAt: timestamp(totals.lastListenAt) }
}

/** The file's lines one at a time, so a file of millions of lines stays out of memory. */
async function* readLines(path) {
  let rest = ''
  for await (const chunk of createReadStream(path, { encoding: 'utf8' })) {
    const parts = (rest + chunk).split('\n')
    rest = parts.pop()
    yield* parts
  }
  if (rest !== '') yield rest
}

async function commit(args) {
  const summaryPath = args.from.replace(/\.ndjson$/, '.summary.json')
  let summary
  try {
    summary = JSON.parse(readFileSync(summaryPath, 'utf8'))
  } catch (error) {
    fail(`Could not read ${summaryPath}, which the dry run writes next to the documents: ${error.message}`)
  }
  if (summary.project !== args.project) fail(`${args.from} was made for project ${summary.project}, not ${args.project}.`)
  const age = Date.now() - new Date(summary.createdAt).getTime()
  if (!(age <= STALE_AFTER_MS)) {
    const hours = Number.isFinite(age) ? `${Math.round(age / 3600000)} hours` : 'an unknown time'
    console.warn(`${args.from} is ${hours} old; listening synced since then is only in what the triggers wrote.`)
    if (!args.yesStale) fail('Run a new dry run, or pass --yes-stale to write it anyway.')
  }
  const min = summary.minListenSeconds
  const expected = summary.totals?.documentsToWrite
  const started = Date.now()
  const elapsed = () => `${Math.round((Date.now() - started) / 1000)} s`

  const db = getFirestore()
  const refOf = (line) =>
    db.collection(line.kind === 'podcast' ? stats.PODCAST_LISTENERS_COLLECTION : stats.LISTENER_TOTALS_COLLECTION).doc(line.id)
  const writer = db.bulkWriter()
  const counts = { read: 0, created: 0, merged: 0, failed: 0 }
  let conflicts = []
  writer.onWriteError((error) => {
    if (error.code === ALREADY_EXISTS) return false
    if (error.failedAttempts < 5) return true
    counts.failed++
    console.error(`Failed ${error.documentRef.path}: ${error.message}`)
    return false
  })

  // Documents already stored are read in one call per group, merged, and written back.
  const mergeConflicts = async () => {
    while (conflicts.length > 0) {
      const group = conflicts.splice(0, LOOKUP_SIZE)
      const docs = await db.getAll(...group.map(refOf))
      docs.forEach((doc, i) => {
        writer.set(doc.ref, toStore(group[i], doc.data() ?? {}, min)).then(() => counts.merged++, () => {})
      })
    }
    await writer.flush()
  }

  for await (const text of readLines(args.from)) {
    if (text.trim() === '') continue
    const line = parseLine(text, counts.read++)
    writer.create(refOf(line), toStore(line, undefined, min)).then(
      () => counts.created++,
      (error) => {
        if (error.code === ALREADY_EXISTS) conflicts.push(line)
      },
    )
    // Waiting here keeps only a few thousand writes queued, however long the file is.
    if (counts.read % FLUSH_EVERY === 0) {
      await writer.flush()
      await mergeConflicts()
      if (counts.read % PROGRESS_EVERY === 0) {
        console.log(`${counts.read} of ${expected ?? '?'} documents: created ${counts.created}, merged ${counts.merged}, failed ${counts.failed}, ${elapsed()}`)
      }
    }
  }
  await writer.flush()
  await mergeConflicts()
  await writer.close()
  console.log(`Documents: created ${counts.created}, merged ${counts.merged} already stored, failed ${counts.failed}, of ${counts.read}, in ${elapsed()}.`)
  if (counts.failed > 0) fail('Some documents failed; the public numbers were not set. Fix the cause and run the commit again.')

  await publish(db)
  console.log(`${elapsed()} in all.`)
}

/**
 * Sets listeners and hours in public_stats/site from what is stored now, so running it again
 * never adds to them. Each field is summed in its own query: summing two fields in one query
 * needs a composite index, and one field does not.
 */
async function publish(db) {
  const totals = db.collection(stats.LISTENER_TOTALS_COLLECTION)
  const [listeners, books_, podcasts] = await Promise.all([
    totals.where('isListener', '==', true).count().get(),
    totals.aggregate({ seconds: AggregateField.sum('bookSeconds') }).get(),
    totals.aggregate({ seconds: AggregateField.sum('podcastSeconds') }).get(),
  ])
  const bookSeconds = Number(books_.data().seconds) || 0
  const podcastSeconds = Number(podcasts.data().seconds) || 0
  const published = {
    listeners: listeners.data().count,
    hoursListened: stats.wholeHours(bookSeconds + podcastSeconds),
    bookHoursListened: stats.wholeHours(bookSeconds),
    podcastHoursListened: stats.wholeHours(podcastSeconds),
  }
  await db.doc(stats.PUBLIC_STATS_PATH).set(
    { ...published, updatedAt: FieldValue.serverTimestamp(), listenersCheckedAt: FieldValue.serverTimestamp() },
    { merge: true },
  )
  console.log(`Set ${stats.PUBLIC_STATS_PATH}:`)
  console.table(published)
  console.log('Audiobooks and donors are filled in by refreshPublicStats on its next run.')
}

const args = parseArgs(process.argv.slice(2))
initializeApp({ projectId: args.project })
describeTarget(args.project)
await (args.publish ? publish(getFirestore()) : args.commit ? commit(args) : dryRun(args))
