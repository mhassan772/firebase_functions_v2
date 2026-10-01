/**
 * Wipes the LOCAL Auth and Firestore emulators and fills them with the little the app needs
 * to start and sign in. Run through `npm run emulators` (which calls this once the emulators
 * are up) or on its own with `npm run emulators:seed` while they are running.
 *
 * The project id is the real one (see start.sh), so this script refuses to write anything
 * until it has confirmed the emulators answer: the emulator hosts are forced below, and the
 * first request is an emulator-only wipe that fails when no emulator is running.
 *
 * Everything here is made up; nothing is copied from production.
 */
import { createHash } from 'node:crypto'
import { initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore, Timestamp } from 'firebase-admin/firestore'

const PROJECT_ID = 'mantooq-test'
const FIRESTORE_HOST = '127.0.0.1:8086'
const AUTH_HOST = '127.0.0.1:9098'

// Emulator-only accounts. The password exists only in the local Auth emulator.
const EMULATOR_PASSWORD = 'mantooq-emulator'
const ACCOUNTS = [
  { uid: 'emulator-premium', email: 'premium@mantooq.test', displayName: 'Premium tester', premium: true },
  { uid: 'emulator-free', email: 'free@mantooq.test', displayName: 'Free tester', premium: false },
  { uid: 'emulator-admin', email: 'admin@mantooq.test', displayName: 'Admin tester', premium: false, role: 'admin' },
]

process.env.FIRESTORE_EMULATOR_HOST = FIRESTORE_HOST
process.env.FIREBASE_AUTH_EMULATOR_HOST = AUTH_HOST
process.env.GCLOUD_PROJECT = PROJECT_ID

async function wipe() {
  const firestore = await fetch(
    `http://${FIRESTORE_HOST}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`,
    { method: 'DELETE' },
  )
  if (!firestore.ok) throw new Error(`Could not clear the Firestore emulator (${firestore.status}). Is it running?`)
  const auth = await fetch(`http://${AUTH_HOST}/emulator/v1/projects/${PROJECT_ID}/accounts`, { method: 'DELETE' })
  if (!auth.ok) throw new Error(`Could not clear the Auth emulator (${auth.status}). Is it running?`)
}

async function seed() {
  // Only after the wipe has proven the emulators are the ones answering.
  initializeApp({ projectId: PROJECT_ID })
  const db = getFirestore()
  const auth = getAuth()
  const now = Timestamp.now()
  const inOneYear = Timestamp.fromMillis(Date.now() + 365 * 24 * 60 * 60 * 1000)

  for (const account of ACCOUNTS) {
    await auth.createUser({
      uid: account.uid,
      email: account.email,
      password: EMULATOR_PASSWORD,
      displayName: account.displayName,
      emailVerified: true,
    })
    await db.doc(`users/${account.uid}`).set({
      id: account.uid,
      email: account.email,
      name: account.displayName,
      createdAt: now,
    })
    if (account.premium) {
      // The app looks up manual grants by sha256 of the uid.
      const key = createHash('sha256').update(account.uid).digest('hex')
      await db.doc(`subscriptions_manual/${key}`).set({ active: true, expiresAt: inOneYear, productId: 'emulator' })
    }
    if (account.role) {
      await db.doc(`users_adminv2/${account.uid}`).set({ role: account.role, email: account.email })
    }
  }

  // The app requires this document to exist. Without catalog timestamps it keeps the
  // catalog it already has instead of downloading one.
  await db.doc('settings_app/settings_metadata').set({ note: 'Firestore emulator' })
  await db.doc('settings_app/archived_books').set({ books: [] })
}

await wipe()
await seed()
console.log(`Seeded ${ACCOUNTS.length} accounts: ${ACCOUNTS.map((account) => account.email).join(', ')}`)
