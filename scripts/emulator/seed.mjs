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
  // A manual (admin) grant, the way the backend writes it: a manual slot with one grant, projected to the master.
  { uid: 'emulator-premium', email: 'premium@mantooq.test', displayName: 'Premium tester', premium: 'manual' },
  // An active Google production subscription, so the portal can be tried against an account that already pays a store.
  { uid: 'emulator-google', email: 'google@mantooq.test', displayName: 'Google subscriber', premium: 'google' },
  { uid: 'emulator-free', email: 'free@mantooq.test', displayName: 'Free tester', premium: false },
  { uid: 'emulator-admin', email: 'admin@mantooq.test', displayName: 'Admin tester', premium: false, role: 'admin' },
]

process.env.FIRESTORE_EMULATOR_HOST = FIRESTORE_HOST
process.env.FIREBASE_AUTH_EMULATOR_HOST = AUTH_HOST
process.env.GCLOUD_PROJECT = PROJECT_ID

// Mirrors the shapes in src/services/subscriptions/persistence.ts and manual.ts: one slot
// document per source in subscription_store_state, keyed by base64url sha256 of the uid, and
// the master projection with its `sources` rows. Only the fields the app and the portal read.
async function seedSubscription(db, uid, kind, now, expiresAt) {
  const slotKey = createHash('sha256').update(uid).digest('base64url')
  const common = {
    uid,
    active: true,
    expiresAt,
    inGracePeriod: false,
    lastStoreEventAt: now,
    lastVerifiedAt: now,
    createdAt: now,
    updatedAt: now,
  }
  let state
  if (kind === 'manual') {
    state = {
      ...common,
      status: 'active',
      platform: 'manual',
      productId: 'manual_grant',
      environment: 'production',
      autoRenewing: false,
      manual: { activeGrantCount: 1, grantSource: 'admin_manual_add', ledgerRevision: 1 },
      grants: [
        {
          grantId: 'seed-grant-1',
          kind: 'absolute',
          base: 'extend',
          expiresAt,
          grantedAt: now,
          grantedBy: 'seed',
          metadata: { grantSource: 'admin_manual_add', note: 'emulator seed' },
          status: 'active',
        },
      ],
      ledgerRevision: 1,
      recentOperations: [],
    }
    await db.doc(`subscription_store_state/${slotKey}_manual_production`).set(state)
  } else {
    state = {
      ...common,
      status: 'active',
      platform: 'google',
      productId: 'premium_access',
      environment: 'production',
      autoRenewing: true,
      purchaseReference: 'emulator-google-reference',
    }
    await db.doc(`subscription_store_state/${slotKey}_google_production`).set(state)
  }
  const { uid: _uid, grants, ledgerRevision, recentOperations, ...master } = state
  await db.doc(`subscription_master/${uid}`).set({
    ...master,
    sources: [
      {
        platform: state.platform,
        environment: state.environment,
        status: state.status,
        expiresAt,
        autoRenewing: state.autoRenewing,
      },
    ],
  })
}

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
      await seedSubscription(db, account.uid, account.premium, now, inOneYear)
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
