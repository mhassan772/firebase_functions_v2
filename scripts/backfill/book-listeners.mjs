/**
 * Seeds `book_listeners` and every catalog book's `listeners_count` from everything users have
 * already synced, so the popular books chart and the per-book numbers are right from day one.
 * After this, only the book listen-time triggers add listening. See docs/book-chart.md.
 *
 * Two steps, so what gets written is reviewed first:
 *
 *   npm run build
 *   npm run backfill:book-listeners -- --project <id>
 *       Dry run. Reads every device_sessions_v2, device_sessions, playback_progress_v2 (with its
 *       chunks), playback_progress, completed_books_v2 and completed_book document, and writes
 *       the lines it would set to backfill-book-listeners-<project>-<time>.ndjson, with a
 *       summary next to it (.summary.json): totals and the top 20 books for the chart window
 *       and all-time. Writes nothing to Firestore.
 *
 *   npm run backfill:book-listeners -- --commit --from <file.ndjson> --project <id> [--yes-stale]
 *       Writes the lines in that file, then sets each catalog book's `listeners_count` to the
 *       number of qualifying lines. Reads no source documents. A line already stored, by the
 *       triggers since the dry run or by an earlier commit, is merged, keeping the higher total,
 *       so a commit that stopped partway can be run again. Run it before deploying the new
 *       mostPopularBooksV3, which would otherwise count those people a second time. A file older
 *       than 24 hours needs --yes-stale. About 2 million lines take roughly 25 minutes, with a
 *       progress line every 50,000; keep the terminal open until it prints the book counts.
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
import { FieldPath, getFirestore, Timestamp } from 'firebase-admin/firestore'

const require = createRequire(import.meta.url)
let books
try {
  books = require('../../lib/handlers/bookListenHandlers.js')
} catch {
  fail('lib/ is missing or stale. Run `npm run build` first.')
}

const STALE_AFTER_MS = 24 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const LOOKUP_SIZE = 100
/** Firestore's ALREADY_EXISTS: the triggers wrote the line after the dry run. */
const ALREADY_EXISTS = 6
/** Lines queued before waiting for them, so memory stays flat on a file of millions. */
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
    else if (arg === '--page-size') args.pageSize = positiveNumber(arg, value())
    else fail(`Unknown option ${arg}. See the comment at the top of scripts/backfill/book-listeners.mjs.`)
  }
  if (!args.project) fail('--project <id> is required.')
  if (args.commit && !args.from) fail('--commit needs --from <dry run file>.')
  if (!args.commit && args.from) fail('--from is only used with --commit.')
  return args
}

function positiveNumber(name, raw) {
  const number = Number(raw)
  if (!Number.isFinite(number) || number <= 0) fail(`${name} must be a positive number.`)
  return number
}

function describeTarget(project) {
  const emulator = process.env.FIRESTORE_EMULATOR_HOST
  console.log(emulator ? `Firestore emulator ${emulator}, project ${project}` : `LIVE Firestore, project ${project}`)
}

/** Pages of a collection in document id order, so several can be walked side by side per user. */
async function* pagedDocs(db, collection, pageSize) {
  let last
  for (;;) {
    let query = db.collection(collection).orderBy(FieldPath.documentId()).limit(pageSize)
    if (last) query = query.startAfter(last)
    const snapshot = await query.get()
    yield snapshot.docs
    if (snapshot.size < pageSize) return
    last = snapshot.docs[snapshot.docs.length - 1]
  }
}

/** One `{uid, data}` per document of a collection, in user id order. */
async function* usersOf(db, collection, pageSize, counts) {
  for await (const docs of pagedDocs(db, collection, pageSize)) {
    for (const doc of docs) {
      counts[collection] = (counts[collection] ?? 0) + 1
      yield { uid: doc.id, data: doc.data() }
    }
  }
}

/**
 * Each user's synced progress across their `playback_progress_v2` chunks, in user id order.
 *
 * The chunks a root lists are fetched for a whole page of roots at once.
 */
async function* progressV2Users(db, pageSize, counts) {
  for await (const roots of pagedDocs(db, 'playback_progress_v2', pageSize)) {
    const refs = []
    const owners = []
    for (const root of roots) {
      for (const info of Array.isArray(root.get('info')) ? root.get('info') : []) {
        if (typeof info?.docId === 'string' && info.docId !== '') {
          refs.push(root.ref.collection('chunks').doc(info.docId))
          owners.push(root.id)
        }
      }
    }
    const chunks = refs.length > 0 ? await db.getAll(...refs) : []
    const booksByUser = new Map(roots.map((root) => [root.id, []]))
    chunks.forEach((chunk, i) => {
      const playbackBooks = chunk.exists ? chunk.get('playbackBooks') : undefined
      if (Array.isArray(playbackBooks)) booksByUser.get(owners[i]).push(...playbackBooks)
    })
    counts.playback_progress_v2 = (counts.playback_progress_v2 ?? 0) + roots.length
    counts['playback_progress_v2 chunks'] = (counts['playback_progress_v2 chunks'] ?? 0) + chunks.length
    for (const root of roots) yield { uid: root.id, data: { playbackBooks: booksByUser.get(root.id) } }
  }
}

/**
 * Walks several user-ordered streams together, yielding each user once with whatever each
 * stream has for them.
 */
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

/** Book guids the user's old data shows they listened to, before listening time was tracked. */
function listenedBefore(user, minListenSeconds) {
  const guids = new Set()
  for (const source of [user.progressV2, user.progressLegacy]) {
    for (const book of Array.isArray(source?.playbackBooks) ? source.playbackBooks : []) {
      if (books.listenedByProgress(book, minListenSeconds)) guids.add(book.bookGuid)
    }
  }
  for (const list of [user.completedV2, user.completedLegacy]) {
    for (const guid of books.completedBookGuids(list)) guids.add(guid)
  }
  return guids
}

/** Names of the catalog books among `guids`; a guid missing from the map is not in the catalog. */
async function catalogNames(db, guids) {
  const names = new Map()
  // An id Firestore cannot address is never a catalog book, and reading it would throw.
  const readable = guids.filter((id) => id !== '' && id !== '.' && id !== '..' && !id.includes('/') && !/^__.*__$/.test(id))
  for (let i = 0; i < readable.length; i += LOOKUP_SIZE) {
    const page = readable.slice(i, i + LOOKUP_SIZE)
    const docs = await db.getAll(...page.map((guid) => db.collection('books').doc(guid)), { fieldMask: ['name'] })
    docs.forEach((doc, j) => {
      if (doc.exists) names.set(page[j], doc.get('name') ?? '')
    })
  }
  return names
}

/** The first 20 catalog books of a count map, most first, ties by guid, with their names. */
async function top20(db, counts) {
  const ranked = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 60)
  const names = await catalogNames(db, ranked.map(([guid]) => guid))
  return ranked
    .filter(([guid]) => names.has(guid))
    .slice(0, 20)
    .map(([book_guid, listeners]) => ({ book_guid, name: names.get(book_guid), listeners }))
}

async function dryRun(args) {
  const db = getFirestore()
  const settings = books.resolvePopularBooksSettings((await db.doc('settings/mantooqAppSettings').get()).data())
  const pageSize = args.pageSize ?? 200
  const now = new Date()
  const windowStart = now.getTime() - settings.windowDays * DAY_MS
  const createdAt = now.toISOString()
  const base = `backfill-book-listeners-${args.project}-${createdAt.replace(/[:.]/g, '-')}`
  const out = createWriteStream(`${base}.ndjson`)

  const documents = {}
  const totals = { users: 0, lines: 0, qualifying: 0, onlyFromOldData: 0, inWindow: 0 }
  const allTime = new Map()
  const window = new Map()
  const users = byUser({
    sessionsV2: usersOf(db, 'device_sessions_v2', pageSize, documents),
    sessionsLegacy: usersOf(db, 'device_sessions', pageSize, documents),
    progressV2: progressV2Users(db, pageSize, documents),
    progressLegacy: usersOf(db, 'playback_progress', pageSize, documents),
    completedV2: usersOf(db, 'completed_books_v2', pageSize, documents),
    completedLegacy: usersOf(db, 'completed_book', pageSize, documents),
  })
  for await (const user of users) {
    totals.users++
    const lines = books.backfillLines(
      user.uid,
      books.secondsByBook(user.sessionsV2),
      books.secondsByBook(user.sessionsLegacy),
      listenedBefore(user, settings.minListenSeconds),
      settings.minListenSeconds,
    )
    for (const line of lines) {
      totals.lines++
      if (line.qualifies) {
        totals.qualifying++
        allTime.set(line.book_guid, (allTime.get(line.book_guid) ?? 0) + 1)
        if (line.listenedBeforeSessions) totals.onlyFromOldData++
        if (line.updatedAt && line.updatedAt.getTime() > windowStart) {
          totals.inWindow++
          window.set(line.book_guid, (window.get(line.book_guid) ?? 0) + 1)
        }
      }
      const entry = {
        id: books.bookListenerDocId(user.uid, line.book_guid),
        data: { ...line, updatedAt: line.updatedAt ? line.updatedAt.toISOString() : null },
      }
      if (!out.write(`${JSON.stringify(entry)}\n`)) await once(out, 'drain')
    }
  }
  out.end()
  await once(out, 'finish')

  const summary = {
    project: args.project,
    createdAt,
    minListenSeconds: settings.minListenSeconds,
    windowDays: settings.windowDays,
    documents,
    totals,
    booksWithListeners: allTime.size,
    top20Window: await top20(db, window),
    top20AllTime: await top20(db, allTime),
  }
  writeFileSync(`${base}.summary.json`, JSON.stringify(summary, null, 2))

  console.log(`Minimum ${settings.minListenSeconds} s, chart window ${settings.windowDays} days.`)
  console.log('Documents read:')
  console.table(documents)
  console.table(totals)
  console.log(`Top 20 for the last ${settings.windowDays} days:`)
  console.table(summary.top20Window)
  console.log('Top 20 all-time:')
  console.table(summary.top20AllTime)
  console.log(`\nWrote ${base}.ndjson and ${base}.summary.json. Nothing was written to Firestore.`)
  console.log(`To write these lines: npm run backfill:book-listeners -- --commit --from ${base}.ndjson --project ${args.project}`)
}

/** Validates one file line and turns it into the document to write; counted lines are flagged. */
function toWrite(text, index) {
  let entry
  try {
    entry = JSON.parse(text)
  } catch {
    fail(`Line ${index + 1} of the file is not JSON; stopped.`)
  }
  const { id, data } = entry ?? {}
  const updatedAt = data?.updatedAt === null ? null : new Date(data?.updatedAt)
  if (typeof id !== 'string' || id === '' || id.includes('/')
    || typeof data?.book_guid !== 'string' || data.book_guid === '' || typeof data?.user_guid !== 'string'
    || !Number.isFinite(data?.seconds) || typeof data?.qualifies !== 'boolean'
    || typeof data?.listenedBeforeSessions !== 'boolean'
    || (updatedAt !== null && Number.isNaN(updatedAt.getTime()))) {
    fail(`Line ${index + 1} of the file is malformed; stopped.`)
  }
  return {
    id,
    data: {
      book_guid: data.book_guid,
      user_guid: data.user_guid,
      seconds: data.seconds,
      updatedAt: updatedAt ? Timestamp.fromDate(updatedAt) : null,
      listenedBeforeSessions: data.listenedBeforeSessions,
      qualifies: data.qualifies,
      addedToBook: data.qualifies,
    },
  }
}

/**
 * A file line merged into one already stored, by the triggers since the dry run or by an earlier
 * commit: the higher total and later date win, and the line counts as added when either did.
 */
function mergedLine(existing, line, minListenSeconds) {
  const seconds = Math.max(Number(existing.seconds) || 0, line.seconds)
  const dates = [existing.updatedAt?.toMillis?.(), line.updatedAt?.toMillis()].filter(Number.isFinite)
  const listenedBeforeSessions = seconds < minListenSeconds && line.listenedBeforeSessions
  return {
    book_guid: line.book_guid,
    user_guid: line.user_guid,
    seconds,
    updatedAt: dates.length > 0 ? Timestamp.fromMillis(Math.max(...dates)) : null,
    listenedBeforeSessions,
    qualifies: seconds >= minListenSeconds || listenedBeforeSessions,
    addedToBook: existing.addedToBook === true || line.qualifies,
  }
}

/**
 * The file's lines one at a time. Reading the stream chunk by chunk only as lines are taken keeps
 * a file of millions of lines out of memory.
 */
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
    fail(`Could not read ${summaryPath}, which the dry run writes next to the lines: ${error.message}`)
  }
  if (summary.project !== args.project) {
    fail(`${args.from} was made for project ${summary.project}, not ${args.project}.`)
  }
  const age = Date.now() - new Date(summary.createdAt).getTime()
  if (!(age <= STALE_AFTER_MS)) {
    const hours = Number.isFinite(age) ? `${Math.round(age / 3600000)} hours` : 'an unknown time'
    console.warn(`${args.from} is ${hours} old; listening synced since then is only in the lines the triggers wrote.`)
    if (!args.yesStale) fail('Run a new dry run, or pass --yes-stale to write it anyway.')
  }
  const expected = summary.totals?.lines
  const started = Date.now()
  const elapsed = () => `${Math.round((Date.now() - started) / 1000)} s`

  const db = getFirestore()
  const collection = db.collection(books.BOOK_LISTENERS_COLLECTION)
  const writer = db.bulkWriter()
  const listeners = new Map()
  const counts = { read: 0, created: 0, merged: 0, failed: 0 }
  let conflicts = []
  writer.onWriteError((error) => {
    if (error.code === ALREADY_EXISTS) return false
    if (error.failedAttempts < 5) return true
    counts.failed++
    console.error(`Failed ${error.documentRef.path}: ${error.message}`)
    return false
  })

  // Lines already stored are read in one call per group, merged, and written back.
  const mergeConflicts = async () => {
    while (conflicts.length > 0) {
      const group = conflicts.splice(0, LOOKUP_SIZE * 3)
      const docs = await db.getAll(...group.map(({ ref }) => ref))
      docs.forEach((doc, i) => {
        const { ref, line } = group[i]
        writer.set(ref, mergedLine(doc.data() ?? {}, line, summary.minListenSeconds))
          .then(() => counts.merged++, () => {})
      })
    }
    await writer.flush()
  }

  for await (const text of readLines(args.from)) {
    if (text.trim() === '') continue
    const line = toWrite(text, counts.read++)
    if (line.data.qualifies) listeners.set(line.data.book_guid, (listeners.get(line.data.book_guid) ?? 0) + 1)
    const ref = collection.doc(line.id)
    writer.create(ref, line.data).then(
      () => counts.created++,
      (error) => {
        if (error.code === ALREADY_EXISTS) conflicts.push({ ref, line: line.data })
      },
    )
    // Waiting here keeps only a few thousand writes queued, however long the file is.
    if (counts.read % FLUSH_EVERY === 0) {
      await writer.flush()
      await mergeConflicts()
      if (counts.read % PROGRESS_EVERY === 0) {
        console.log(`${counts.read} of ${expected ?? '?'} lines: created ${counts.created}, merged ${counts.merged}, failed ${counts.failed}, ${elapsed()}`)
      }
    }
  }
  await writer.flush()
  await mergeConflicts()
  await writer.close()
  console.log(`Lines: created ${counts.created}, merged ${counts.merged} already stored, failed ${counts.failed}, of ${counts.read}, in ${elapsed()}.`)
  if (counts.failed > 0) fail('Some lines failed; the book counts were not set. Fix the cause and run the commit again.')

  // Exact counts, so running the commit again does not add to them.
  console.log(`Setting listeners_count on the catalog books among ${listeners.size} books...`)
  const guids = [...listeners.keys()]
  const names = await catalogNames(db, guids)
  const bookWriter = db.bulkWriter()
  let booksSet = 0
  for (const guid of guids) {
    if (!names.has(guid)) continue
    bookWriter.update(db.collection('books').doc(guid), { listeners_count: listeners.get(guid) })
      .then(() => booksSet++)
      .catch((error) => console.error(`Failed books/${guid}: ${error.message}`))
  }
  await bookWriter.close()
  console.log(`Set listeners_count on ${booksSet} catalog books; ${guids.length - names.size} guids are not in the catalog. ${elapsed()} in all.`)
}

const args = parseArgs(process.argv.slice(2))
initializeApp({ projectId: args.project })
describeTarget(args.project)
await (args.commit ? commit(args) : dryRun(args))
