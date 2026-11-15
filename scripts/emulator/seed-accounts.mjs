/**
 * Wipes the LOCAL accounts-page test stack (firebase.accounts-test.json) and seeds the accounts
 * for trying /delete, /subscribe and /manage. Run through `npm run emulators:accounts`, or on its own with
 * `npm run emulators:accounts:seed` while that stack is running.
 *
 * Only the `demo-mantooq` project and the stack's own ports are ever used. A demo project id
 * cannot reach a real Firebase project, and the first request is an emulator-only wipe that
 * fails when no emulator is answering, so nothing is written anywhere else.
 */
import { createHash } from 'node:crypto'
import { initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore, Timestamp } from 'firebase-admin/firestore'
import { getStorage } from 'firebase-admin/storage'

const PROJECT_ID = 'demo-mantooq'
const FIRESTORE_HOST = '127.0.0.1:8089'
const AUTH_HOST = '127.0.0.1:9096'
const STORAGE_HOST = '127.0.0.1:9196'
// The bucket the backend's purge deletes uploads from (STORAGE_BUCKET in src/config/constants.ts).
const STORAGE_BUCKET = 'mantooq-images-p'

// Test-only password, shared by every seeded account. It exists only in the local Auth emulator.
export const TEST_PASSWORD = 'mantooq-accounts-test'

// Uids shaped like real ones (letters and digits, 20 to 40 long): the purge refuses any other shape.
export const ACCOUNTS = {
  plain: { uid: 'AccountsTestPlainUser00000001', email: 'plain@example.com', displayName: 'Plain tester' },
  apple: { uid: 'AccountsTestAppleRenewing0001', email: 'apple-renewing@example.com', displayName: 'Apple subscriber' },
  data: { uid: 'AccountsTestWithData000000001', email: 'with-data@example.com', displayName: 'Tester with data' },
  // Known countries for the price tiers on /subscribe (see WEB_PRICING below).
  lowTier: { uid: 'AccountsTestKnownSaudi000001', email: 'sa-buyer@example.com', displayName: 'Saudi buyer' },
  reducedTier: { uid: 'AccountsTestKnownEmirati0001', email: 'ae-buyer@example.com', displayName: 'Emirati buyer' },
}

/**
 * `web_pricing/config` for buying with Stripe's sandbox. Every seeded account is a tester, since a
 * sandbox key sells only to testers. Stripe has no Egyptian or Turkish test card, so Saudi Arabia
 * stands in for the low tier and the United Arab Emirates for the reduced one; the rest of the
 * country table is the backend's default (DEFAULT_WEB_PRICING in src/services/webSubscriptions/pricing.ts).
 */
const WEB_PRICING = {
  salesEnabled: true,
  taxEnabled: false,
  testers: Object.values(ACCOUNTS).map((account) => account.uid),
  countries: {
    DZ: 'reduced',
    IQ: 'reduced',
    JO: 'reduced',
    LB: 'reduced',
    LY: 'reduced',
    MA: 'reduced',
    TN: 'reduced',
    YE: 'reduced',
    EG: 'low',
    TR: 'low',
    SA: 'low',
    AE: 'reduced',
  },
}

if (!PROJECT_ID.startsWith('demo-')) throw new Error('This seed only ever runs against a demo- project.')
process.env.FIRESTORE_EMULATOR_HOST = FIRESTORE_HOST
process.env.FIREBASE_AUTH_EMULATOR_HOST = AUTH_HOST
process.env.FIREBASE_STORAGE_EMULATOR_HOST = STORAGE_HOST
process.env.STORAGE_EMULATOR_HOST = `http://${STORAGE_HOST}`
process.env.GCLOUD_PROJECT = PROJECT_ID

async function wipe() {
  const firestore = await fetch(
    `http://${FIRESTORE_HOST}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`,
    { method: 'DELETE' },
  )
  if (!firestore.ok) throw new Error(`Could not clear the Firestore emulator (${firestore.status}). Is the stack running?`)
  const auth = await fetch(`http://${AUTH_HOST}/emulator/v1/projects/${PROJECT_ID}/accounts`, { method: 'DELETE' })
  if (!auth.ok) throw new Error(`Could not clear the Auth emulator (${auth.status}). Is the stack running?`)
}

/** The slot and master shapes the backend writes (persistence.ts), with one renewing Apple row. */
async function seedAppleSubscription(db, uid, now, expiresAt) {
  const slotKey = createHash('sha256').update(uid).digest('base64url')
  const state = {
    active: true,
    status: 'active',
    platform: 'apple',
    productId: 'premium_access_monthly',
    environment: 'production',
    expiresAt,
    inGracePeriod: false,
    autoRenewing: true,
    originalTransactionId: '2000000999999999',
    lastStoreEventAt: now,
    lastVerifiedAt: now,
    createdAt: now,
    updatedAt: now,
  }
  await db.doc(`subscription_store_state/${slotKey}_apple_production`).set({ uid, ...state })
  await db.doc(`subscription_master/${uid}`).set({
    ...state,
    sources: [{ platform: 'apple', environment: 'production', status: 'active', expiresAt, autoRenewing: true }],
  })
}

/** Data in several of the purge's collections, one upload in Storage and one payment request. */
async function seedData(db, uid, now) {
  await db.doc(`favourites/${uid}`).set({ books: ['1001', '1002'], updatedAt: now })
  await db.doc(`playback_progress_v2/${uid}`).set({ updatedAt: now })
  await db.doc(`playback_progress_v2/${uid}/books/1001`).set({ position: 1234, updatedAt: now })
  await db.doc(`playback_progress_v2/${uid}/books/1002`).set({ position: 99, updatedAt: now })
  await db.doc(`user_settings/${uid}`).set({ playbackSpeed: 1.25, updatedAt: now })
  await db.doc(`playlists_v2/${uid}`).set({ lists: [{ id: 'list-1', name: 'Seeded list' }], updatedAt: now })
  await db.doc(`bookmarks/${uid}`).set({ items: [{ bookId: '1001', position: 50 }] })
  await db.doc(`listener_totals/${uid}`).set({ months: {} })
  await db.collection('book_listeners').add({ user_guid: uid, book_id: '1001', createdAt: now })
  await db.doc(`subscriptions_to_be_approved/seed-payment-${uid}`).set({
    user_guid: uid,
    subscription_id: 'seed-subscription-id',
    amount: 100,
    payment_method: 'vodafone_cash',
    phone_number_sent_from: '01000000000',
    notes: 'seeded',
    status: 'approved',
    createdAt: now,
  })
  await getStorage()
    .bucket(STORAGE_BUCKET)
    .file(`reportingIssues/${uid}_1731330000000_log.txt`)
    .save('seeded log file', { contentType: 'text/plain' })
}

/**
 * An attested App Store storefront report, the shape store country stores
 * (storeCountryToData in src/services/storeCountry/index.ts), so `knownCountries` reads `country`.
 */
async function seedKnownCountry(db, uid, country, now) {
  await db.doc(`user_store_country/${uid}`).set({
    country,
    raw: country,
    source: 'apple_storefront',
    attested: true,
    firstReportedAt: now,
    updatedAt: now,
    lastReportAt: now,
    history: [{ country, source: 'apple_storefront', attested: true, at: now }],
  })
}

async function seed() {
  // Only after the wipe has proven the emulators are the ones answering.
  initializeApp({ projectId: PROJECT_ID, storageBucket: STORAGE_BUCKET })
  const db = getFirestore()
  const auth = getAuth()
  const now = Timestamp.now()
  const inOneMonth = Timestamp.fromMillis(Date.now() + 30 * 24 * 60 * 60 * 1000)

  for (const account of Object.values(ACCOUNTS)) {
    await auth.createUser({
      uid: account.uid,
      email: account.email,
      password: TEST_PASSWORD,
      displayName: account.displayName,
      emailVerified: true,
    })
    await db.doc(`users/${account.uid}`).set({ id: account.uid, email: account.email, name: account.displayName, createdAt: now })
  }
  await seedAppleSubscription(db, ACCOUNTS.apple.uid, now, inOneMonth)
  await seedData(db, ACCOUNTS.data.uid, now)
  await seedKnownCountry(db, ACCOUNTS.lowTier.uid, 'SA', now)
  await seedKnownCountry(db, ACCOUNTS.reducedTier.uid, 'AE', now)
  await db.doc('web_pricing/config').set(WEB_PRICING)
}

await wipe()
await seed()
console.log(
  `Seeded ${Object.keys(ACCOUNTS).length} accounts (password ${TEST_PASSWORD}): ` +
    Object.values(ACCOUNTS)
      .map((account) => account.email)
      .join(', '),
)
