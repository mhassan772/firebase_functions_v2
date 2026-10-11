/**
 * Admin actions on one account's manual grant, from the command line, through the same
 * service the `adminManageSubscription` callable uses. Made for the live sandbox stage, which
 * runs before the admin portal is deployed, and for support when the portal is unavailable.
 *
 *   npm run admin:manual-grant -- --project <id> --user <uid|email> [--hash <64-hex>] get
 *       Prints the account: master, every source row, the grant ledger, the legacy document.
 *       --hash is the id the user pasted to support; it only confirms the account found.
 *
 *   npm run admin:manual-grant -- --project <id> --user <ref> grant --months 1 [--base extend|today] [--note "..."] --commit
 *   npm run admin:manual-grant -- --project <id> --user <ref> grant --until 2027-01-31 [--note "..."] --commit
 *   npm run admin:manual-grant -- --project <id> --user <ref> reverse --grant-id <id> --reason "..." --commit
 *   npm run admin:manual-grant -- --project <id> --user <ref> revoke --reason "..." --commit
 *   npm run admin:manual-grant -- --project <id> --user <ref> set-baseline --until 2027-01-31 --reason "..." --commit
 *
 * Without --commit a mutation only prints what it would send. Every mutation needs --op-id
 * (any 8 to 128 url-safe characters); repeating the same op id replays the earlier result
 * instead of applying twice. Edits need --expected-revision, the ledgerRevision shown by `get`.
 *
 * Credentials come from Application Default Credentials (`gcloud auth application-default
 * login`). With FIRESTORE_EMULATOR_HOST and FIREBASE_AUTH_EMULATOR_HOST set, everything goes to
 * the emulators instead. Build first (`npm run build`); the script loads from lib/.
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

function fail(message) {
  console.error(message)
  process.exit(1)
}

function parseArgs(argv) {
  const args = { commit: false, base: 'extend' }
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = () => {
      const next = argv[++i]
      if (next === undefined || next.startsWith('--')) fail(`${arg} needs a value.`)
      return next
    }
    if (arg === '--project') args.project = value()
    else if (arg === '--user') args.user = value()
    else if (arg === '--hash') args.hash = value()
    else if (arg === '--months') args.months = Number(value())
    else if (arg === '--until') args.until = value()
    else if (arg === '--base') args.base = value()
    else if (arg === '--note') args.note = value()
    else if (arg === '--reason') args.reason = value()
    else if (arg === '--grant-id') args.grantId = value()
    else if (arg === '--op-id') args.opId = value()
    else if (arg === '--expected-revision') args.expectedRevision = Number(value())
    else if (arg === '--actor') args.actor = value()
    else if (arg === '--commit') args.commit = true
    else if (arg.startsWith('--')) fail(`Unknown option ${arg}. See the comment at the top of scripts/admin/manual-grant.mjs.`)
    else positional.push(arg)
  }
  if (!args.project) fail('--project <id> is required.')
  if (!args.user) fail('--user <uid|email> is required.')
  args.command = positional[0]
  if (!['get', 'grant', 'reverse', 'revoke', 'set-baseline'].includes(args.command)) {
    fail('The command must be one of: get, grant, reverse, revoke, set-baseline.')
  }
  return args
}

function userReference(value, hash) {
  const reference = value.includes('@') ? { email: value } : { uid: value }
  if (hash) reference.hashedId = hash
  return reference
}

const args = parseArgs(process.argv.slice(2))
process.env.GCLOUD_PROJECT = args.project
const { admin } = require('../../lib/config/admin')
const { resolveUser } = require('../../lib/services/subscriptions/userResolution')
const { applyManualMutation, readAccountSubscription } = require('../../lib/services/subscriptions/manual')

const emulator = process.env.FIRESTORE_EMULATOR_HOST
console.log(emulator ? `Firestore emulator ${emulator}, project ${args.project}` : `LIVE Firestore, project ${args.project}`)

const user = await resolveUser(userReference(args.user, args.hash))
console.log(`Account ${user.uid} (${user.email ?? 'no email'}), resolved by ${user.resolvedBy}${user.hashConfirmed ? ', hash confirmed' : ''}`)

if (args.command === 'get') {
  console.log(JSON.stringify(await readAccountSubscription(user.uid), null, 2))
  process.exit(0)
}

if (!args.opId) fail('--op-id is required for a mutation.')
let mutation
switch (args.command) {
  case 'grant': {
    if (!args.until && !(Number.isInteger(args.months) && args.months >= 1)) fail('grant needs --months <n> or --until <date>.')
    mutation = {
      action: 'grant',
      intent: args.until
        ? { kind: 'absolute', expiresAt: new Date(args.until) }
        : { kind: 'months', months: args.months, base: args.base },
      metadata: { grantSource: 'admin_manual_add', ...(args.note ? { note: args.note } : {}) },
    }
    break
  }
  case 'reverse':
    if (!args.grantId || !args.reason) fail('reverse needs --grant-id and --reason.')
    mutation = { action: 'reverseRequest', grantId: args.grantId, reason: args.reason, expectedLedgerRevision: args.expectedRevision }
    break
  case 'revoke':
    if (!args.reason) fail('revoke needs --reason.')
    mutation = { action: 'revokeAccess', reason: args.reason, expectedLedgerRevision: args.expectedRevision }
    break
  case 'set-baseline':
    if (!args.until || !args.reason) fail('set-baseline needs --until and --reason.')
    mutation = { action: 'setBaseline', expiresAt: new Date(args.until), reason: args.reason, expectedLedgerRevision: args.expectedRevision }
    break
}
if ('expectedLedgerRevision' in mutation && !Number.isInteger(mutation.expectedLedgerRevision)) {
  fail('--expected-revision <n> is required for this command; take it from `get`.')
}

console.log(`Mutation: ${JSON.stringify(mutation)}`)
if (!args.commit) {
  console.log('Dry run: nothing was written. Add --commit to apply it.')
  process.exit(0)
}

const result = await applyManualMutation(
  { uid: user.uid, opId: args.opId, actor: args.actor ?? `cli:${process.env.USER ?? 'unknown'}` },
  mutation,
)
console.log(result.replayedOperation ? 'Replayed an earlier operation; nothing changed.' : 'Applied.')
console.log(JSON.stringify(result.account, null, 2))
await admin.app().delete()
