#!/usr/bin/env node
/**
 * Go-live step: marks every `web/test` slot (purchases made with the Stripe sandbox key)
 * expired and re-projects each owner's master, so no sandbox purchase keeps premium after the
 * switch to the live key. Never needs a Stripe key.
 *
 *   npm run build
 *   node scripts/stripe/expire-web-test-slots.mjs --project <id>            # dry run: counts only
 *   node scripts/stripe/expire-web-test-slots.mjs --project <id> --apply    # writes
 *
 * Credentials come from Application Default Credentials (`gcloud auth application-default
 * login`). With FIRESTORE_EMULATOR_HOST set, everything goes to the emulator instead.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const projectIndex = args.indexOf('--project');
const project = projectIndex >= 0 ? args[projectIndex + 1] : undefined;
if (!project || project.startsWith('--')) {
  console.error('--project <id> is required.');
  process.exit(1);
}
for (const arg of args) {
  if (arg.startsWith('--') && !['--apply', '--project'].includes(arg)) {
    console.error(`Unknown option ${arg}.`);
    process.exit(1);
  }
}
process.env.GCLOUD_PROJECT = project;

const { admin } = require('../../lib/config/admin');
const { expireWebTestSlots } = require('../../lib/services/webSubscriptions/expireTestSlots');

const emulator = process.env.FIRESTORE_EMULATOR_HOST;
console.log(`${emulator ? `Firestore emulator ${emulator}` : 'LIVE Firestore'}, project ${project}, ${apply ? 'APPLY' : 'dry run'}`);
const result = await expireWebTestSlots(admin.firestore(), { apply });
console.log(`web/test slots: ${result.found}; still giving access or not expired: ${result.toExpire}; written: ${result.expired}`);
for (const uid of result.uids) console.log(`  ${apply ? 'expired' : 'would expire'} ${uid}`);
if (!apply && result.toExpire > 0) console.log('Run again with --apply to write.');
