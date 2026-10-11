/**
 * Imports the unexpired `subscriptions_manual` documents into the subscription master, through
 * the same service the `adminManageSubscription` callable uses. Made for running the migration
 * before the admin portal is deployed, and for re-running it later (a re-run only imports
 * accounts that still have no grant ledger).
 *
 *   npm run admin:migrate-legacy -- --project <id> [--out <dir>]
 *       Plan: resolves every document to an account, classifies it, prints the report and
 *       writes <dir>/<runId>.json. Writes nothing to Firestore.
 *
 *   npm run admin:migrate-legacy -- --project <id> --from <plan.json> --run-id <id> --commit [--out <dir>]
 *       Imports the plan's `imported` rows, trusting their uids (each is still checked to own its
 *       document). One transaction per account; the report is also stored in
 *       `subscription_migration_runs/<runId>`. A run id cannot be reused for a live run.
 *
 * Credentials come from Application Default Credentials (`gcloud auth application-default
 * login`). With FIRESTORE_EMULATOR_HOST and FIREBASE_AUTH_EMULATOR_HOST set, everything goes to
 * the emulators instead. Build first (`npm run build`); the script loads from lib/.
 */
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const require = createRequire(import.meta.url)

function fail(message) {
  console.error(message)
  process.exit(1)
}

function parseArgs(argv) {
  const args = { commit: false, out: 'migration-reports' }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = () => {
      const next = argv[++i]
      if (next === undefined || next.startsWith('--')) fail(`${arg} needs a value.`)
      return next
    }
    if (arg === '--project') args.project = value()
    else if (arg === '--run-id') args.runId = value()
    else if (arg === '--from') args.from = value()
    else if (arg === '--out') args.out = value()
    else if (arg === '--actor') args.actor = value()
    else if (arg === '--commit') args.commit = true
    else fail(`Unknown option ${arg}. See the comment at the top of scripts/admin/migrate-legacy.mjs.`)
  }
  if (!args.project) fail('--project <id> is required.')
  if (args.commit && !args.runId) fail('--run-id <id> is required with --commit.')
  if (args.commit && !args.from) fail('--from <plan.json> is required with --commit; run a plan first.')
  if (!args.runId) args.runId = `dry-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(args.runId)) fail('--run-id must be 8 to 64 url-safe characters.')
  return args
}

const args = parseArgs(process.argv.slice(2))
process.env.GCLOUD_PROJECT = args.project
const { admin } = require('../../lib/config/admin')
const { planLegacyMigration, importLegacyRows } = require('../../lib/services/subscriptions/legacyMigration')

const emulator = process.env.FIRESTORE_EMULATOR_HOST
console.log(emulator ? `Firestore emulator ${emulator}, project ${args.project}` : `LIVE Firestore, project ${args.project}`)
const actor = args.actor ?? `cli:${process.env.USER ?? 'unknown'}`

let report
if (args.commit) {
  const plan = JSON.parse(readFileSync(args.from, 'utf8'))
  const rows = (plan.rows ?? []).filter((row) => row.action === 'imported' && row.uid).map(({ docId, uid }) => ({ docId, uid }))
  if (rows.length === 0) fail(`${args.from} holds no imported rows.`)
  console.log(`LIVE RUN ${args.runId}: importing ${rows.length} rows from ${args.from}.`)
  report = await importLegacyRows({ runId: args.runId, rows, actor })
} else {
  console.log(`Plan ${args.runId}: nothing will be written.`)
  report = await planLegacyMigration({ runId: args.runId, actor })
}

mkdirSync(args.out, { recursive: true })
const file = join(args.out, `${args.runId}.json`)
writeFileSync(file, JSON.stringify(report, null, 2))

console.log(`\nStatus: ${report.status}${report.error ? ` (${report.error})` : ''}`)
console.log('Totals:')
for (const [action, count] of Object.entries(report.totals)) {
  if (count > 0) console.log(`  ${action.padEnd(22)} ${count}`)
}
const day = (iso) => (iso ? iso.slice(0, 10) : '-')
const byAction = {}
for (const row of report.rows) (byAction[row.action] ??= []).push(row)
for (const [action, rows] of Object.entries(byAction)) {
  console.log(`\n== ${action} (${rows.length})`)
  for (const row of rows) {
    const master = row.existingMaster ? ` MASTER ${row.existingMaster.platform} until ${day(row.existingMaster.expiresAt)}` : ''
    console.log(
      `  ${row.docId.slice(0, 10)}  expires ${day(row.expires)}  ${(row.resolution ?? '-').padEnd(14)} ${(row.uid ?? '-').padEnd(28)} ${row.email ?? '-'}${master}${row.detail ? `  [${row.detail}]` : ''}`,
    )
  }
}
console.log(`\nFull report: ${file}`)
await admin.app().delete()
