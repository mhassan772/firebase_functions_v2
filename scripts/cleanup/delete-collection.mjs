/**
 * Deletes every document of one top-level collection that nothing writes or reads any more.
 * Made for `books_download_audit` and `books_download_audit_long_term` once the popular books
 * chart counts listening instead of downloads. See docs/book-chart.md.
 *
 *   npm run cleanup:delete-collection -- --collection <name> --project <id>
 *       Dry run: prints how many documents the collection holds. Deletes nothing.
 *
 *   npm run cleanup:delete-collection -- --collection <name> --project <id> --commit
 *       Deletes them in pages, reading ids only. Safe to stop and run again.
 *
 * Only the collections listed in ALLOWED can be deleted, so a typo cannot remove user data.
 * To keep a copy, export first:
 *   gcloud firestore export gs://<bucket>/<folder> --collection-ids=<name> --project <id>
 *
 * Credentials come from Application Default Credentials (`gcloud auth application-default
 * login`). With FIRESTORE_EMULATOR_HOST set, everything goes to the emulator instead.
 */
import { initializeApp } from 'firebase-admin/app'
import { FieldPath, getFirestore } from 'firebase-admin/firestore'

const ALLOWED = new Set(['books_download_audit', 'books_download_audit_long_term'])
const PAGE_SIZE = 1000

function fail(message) {
  console.error(message)
  process.exit(1)
}

function parseArgs(argv) {
  const args = { commit: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = () => {
      const next = argv[++i]
      if (next === undefined || next.startsWith('--')) fail(`${arg} needs a value.`)
      return next
    }
    if (arg === '--project') args.project = value()
    else if (arg === '--collection') args.collection = value()
    else if (arg === '--commit') args.commit = true
    else fail(`Unknown option ${arg}. See the comment at the top of scripts/cleanup/delete-collection.mjs.`)
  }
  if (!args.project) fail('--project <id> is required.')
  if (!ALLOWED.has(args.collection)) fail(`--collection must be one of: ${[...ALLOWED].join(', ')}.`)
  return args
}

const args = parseArgs(process.argv.slice(2))
initializeApp({ projectId: args.project })
const emulator = process.env.FIRESTORE_EMULATOR_HOST
console.log(emulator ? `Firestore emulator ${emulator}, project ${args.project}` : `LIVE Firestore, project ${args.project}`)

const db = getFirestore()
const collection = db.collection(args.collection)
const total = (await collection.count().get()).data().count
console.log(`${args.collection} holds ${total} documents.`)
if (!args.commit) {
  console.log('Dry run: nothing was deleted. Add --commit to delete them.')
  process.exit(0)
}

const writer = db.bulkWriter()
let failed = 0
writer.onWriteError((error) => {
  if (error.failedAttempts < 5) return true
  failed++
  console.error(`Failed ${error.documentRef.path}: ${error.message}`)
  return false
})
let deleted = 0
let last
for (;;) {
  let query = collection.orderBy(FieldPath.documentId()).select().limit(PAGE_SIZE)
  if (last) query = query.startAfter(last)
  const snapshot = await query.get()
  for (const doc of snapshot.docs) {
    // Rejections are counted by the handler above.
    writer.delete(doc.ref).then(() => deleted++, () => {})
  }
  await writer.flush()
  if (deleted > 0 && deleted % 100000 < PAGE_SIZE) console.log(`Deleted ${deleted} of ${total}...`)
  if (snapshot.size < PAGE_SIZE) break
  last = snapshot.docs[snapshot.docs.length - 1]
}
await writer.close()
console.log(`Deleted ${deleted}, failed ${failed}, of ${total}.`)
if (failed > 0) process.exit(1)
