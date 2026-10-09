/**
 * Seeds `podcast_audit` and `converted_podcast_audit` from the data users have already synced,
 * so the podcast rankings start full instead of filling over two months. popularPodcastsV1
 * only collects documents changed since its last run; this covers everything before that.
 * See docs/podcast-charts.md.
 *
 * Two steps, so what gets written is reviewed first:
 *
 *   npm run build
 *   npm run backfill:podcast-audit -- --project <id>
 *       Dry run. Reads every podcast_subscriptions, converted_podcasts and episode_progress
 *       document, and writes the events it would set to
 *       backfill-podcast-audit-<project>-<time>.json, with totals and the top 20 of each
 *       ranking. Writes nothing to Firestore.
 *
 *   npm run backfill:podcast-audit -- --commit --from <file> --project <id> [--yes-stale]
 *       Writes the events in that file with set(), one document per user, podcast and action.
 *       Reads no source documents, so it writes exactly what was reviewed. Rerunning it rewrites
 *       the same documents, so it is harmless. A file older than 24 hours needs --yes-stale,
 *       because the daily job may have written newer dates since, which it would overwrite.
 *
 * Options for the dry run: --retention-days <n>, --page-size <n>.
 * They default to the values in settings/mantooqAppSettings, then to the code defaults.
 *
 * Credentials come from Application Default Credentials (`gcloud auth application-default
 * login`). With FIRESTORE_EMULATOR_HOST set, everything goes to the emulator instead.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { initializeApp } from 'firebase-admin/app'
import { FieldPath, getFirestore, Timestamp } from 'firebase-admin/firestore'

const require = createRequire(import.meta.url)
let audit
try {
  audit = require('../../lib/handlers/podcastAuditHandlers.js')
} catch {
  fail('lib/ is missing or stale. Run `npm run build` first.')
}

const STALE_AFTER_MS = 24 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const SOURCES = Object.keys(audit.AUDIT_SOURCES)
const AUDIT_COLLECTIONS = new Set([audit.PODCAST_AUDIT_COLLECTION, audit.CONVERTED_PODCAST_AUDIT_COLLECTION])

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
    else if (arg === '--retention-days') args.retentionDays = positiveNumber(arg, value())
    else if (arg === '--page-size') args.pageSize = positiveNumber(arg, value())
    else fail(`Unknown option ${arg}. See the comment at the top of scripts/backfill/podcast-audit.mjs.`)
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

async function* pagedDocs(db, collection, pageSize) {
  let last
  for (;;) {
    let query = db.collection(collection).orderBy(FieldPath.documentId()).limit(pageSize)
    if (last) query = query.startAfter(last)
    const snapshot = await query.get()
    for (const doc of snapshot.docs) yield doc
    if (snapshot.size < pageSize) return
    last = snapshot.docs[snapshot.docs.length - 1]
  }
}

async function readDenied(db) {
  const metadata = await db.doc('settings_app/settings_metadata').get()
  const count = audit.denyDocCountFrom(metadata.data())
  if (count === 0) return new Set()
  const refs = Array.from({ length: count }, (_, i) => db.doc(`settings_app/admin_deny${i + 1}`))
  const docs = await db.getAll(...refs)
  return audit.deniedPodcastIdsFrom(docs.map((doc) => doc.data()))
}

async function dryRun(args) {
  const db = getFirestore()
  const stored = (await db.doc('settings/mantooqAppSettings').get()).data()
  const resolved = audit.resolvePopularPodcastsSettings(stored)
  const settings = {
    ...resolved,
    retentionDays: args.retentionDays ?? resolved.retentionDays,
  }
  const pageSize = args.pageSize ?? 200
  const now = new Date()
  const windowStart = now.getTime() - settings.windowDays * DAY_MS

  // Each user has one document per source, so ids never repeat across documents.
  const all = []
  const totals = {}
  const skipped = {}
  for (const source of SOURCES) {
    const counts = { documents: 0, events: 0, outsideRetention: 0 }
    skipped[source] = 0
    for await (const doc of pagedDocs(db, source, pageSize)) {
      counts.documents++
      const result = audit.eventsFromSourceDoc({ source, uid: doc.id, data: doc.data() })
      const kept = audit.withinRetention(result.events, now, settings.retentionDays)
      skipped[source] += result.skipped
      counts.events += kept.length
      counts.outsideRetention += result.events.length - kept.length
      all.push(...kept)
    }
    totals[source] = counts
  }

  const inWindow = (event) => event.data.timestamp.getTime() > windowStart
  const denied = await readDenied(db)
  const top20Popular = audit.rankPodcastsByDistinctUsers(
    all.filter((e) => e.collection === audit.PODCAST_AUDIT_COLLECTION && inWindow(e)).map((e) => e.data),
    denied,
    20,
  )
  const top20Converted = audit.rankPodcastsByDistinctUsers(
    all.filter((e) => e.collection === audit.CONVERTED_PODCAST_AUDIT_COLLECTION && inWindow(e)).map((e) => e.data),
    denied,
    20,
  )

  const createdAt = now.toISOString()
  const file = `backfill-podcast-audit-${args.project}-${createdAt.replace(/[:.]/g, '-')}.json`
  const output = {
    project: args.project,
    createdAt,
    retentionDays: settings.retentionDays,
    windowDays: settings.windowDays,
    events: all.map((event) => ({
      collection: event.collection,
      id: event.id,
      data: { ...event.data, timestamp: event.data.timestamp.toISOString() },
    })),
    totals,
    top20Popular,
    top20Converted,
    skipped,
  }
  writeFileSync(file, JSON.stringify(output, null, 2))

  console.log(`Retention ${settings.retentionDays} days, ranking window ${settings.windowDays} days, ${denied.size} denied podcasts.`)
  console.table(totals)
  console.log('Skipped for unreadable data:', skipped)
  console.log(`Events to write: ${all.length}`)
  console.log('Top 20 popular (follow + listen):')
  console.table(top20Popular)
  console.log('Top 20 converted:')
  console.table(top20Converted)
  console.log(`\nWrote ${file}. Nothing was written to Firestore.`)
  console.log(`To write these events: npm run backfill:podcast-audit -- --commit --from ${file} --project ${args.project}`)
}

function toWrite(entry, index) {
  const { collection, id, data } = entry ?? {}
  const timestamp = new Date(data?.timestamp)
  if (!AUDIT_COLLECTIONS.has(collection) || typeof id !== 'string' || id === '' || id.includes('/')
    || typeof data?.podcast_id !== 'string' || typeof data?.user_guid !== 'string'
    || Number.isNaN(timestamp.getTime())) {
    fail(`Event ${index} in the file is malformed; nothing was written.`)
  }
  return { collection, id, data: { ...data, timestamp: Timestamp.fromDate(timestamp) } }
}

async function commit(args) {
  let file
  try {
    file = JSON.parse(readFileSync(args.from, 'utf8'))
  } catch (error) {
    fail(`Could not read ${args.from}: ${error.message}`)
  }
  if (file.project !== args.project) {
    fail(`${args.from} was made for project ${file.project}, not ${args.project}.`)
  }
  const age = Date.now() - new Date(file.createdAt).getTime()
  if (!(age <= STALE_AFTER_MS)) {
    const hours = Number.isFinite(age) ? `${Math.round(age / 3600000)} hours` : 'an unknown time'
    console.warn(`${args.from} is ${hours} old; it may overwrite newer dates the daily job wrote since, and events now out of retention would be written.`)
    if (!args.yesStale) fail('Run a new dry run, or pass --yes-stale to write it anyway.')
  }
  if (!Array.isArray(file.events)) fail(`${args.from} has no events list.`)
  const writes = file.events.map(toWrite)

  const db = getFirestore()
  const writer = db.bulkWriter()
  let written = 0
  let failed = 0
  writer.onWriteResult(() => {
    written++
  })
  writer.onWriteError((error) => {
    if (error.failedAttempts < 5) return true
    failed++
    console.error(`Failed ${error.documentRef.path}: ${error.message}`)
    return false
  })
  for (const write of writes) {
    // Rejections are counted by the handlers above.
    writer.set(db.collection(write.collection).doc(write.id), write.data).catch(() => {})
  }
  await writer.close()

  console.log(`Wrote ${written}, failed ${failed}, of ${writes.length}.`)
  if (failed > 0) process.exit(1)
}

const args = parseArgs(process.argv.slice(2))
initializeApp({ projectId: args.project })
describeTarget(args.project)
await (args.commit ? commit(args) : dryRun(args))
