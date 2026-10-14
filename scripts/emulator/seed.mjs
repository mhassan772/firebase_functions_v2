/**
 * Wipes the LOCAL Auth and Firestore emulators and fills them with the little the app needs
 * to start and sign in. Run through `npm run emulators` (which calls this once the emulators
 * are up) or on its own with `npm run emulators:seed` while they are running.
 *
 * The project id is the real one (see start.sh), so this script refuses to write anything
 * until it has confirmed the emulators answer: the emulator hosts are forced below, and the
 * first request is an emulator-only wipe that fails when no emulator is running.
 *
 * No user data is copied from production. The only production values are the public
 * category names in SUB_CATEGORIES, which the admin portal matches by exact name.
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

// categories/main.sub_categories as in production (ids 1000–1070). The admin portal's add-book
// details step lists these names, and the content classifier skill's JSON names them exactly.
const SUB_CATEGORIES = {
  '1000': 'تدبر القرآن',
  '1001': 'التهيئة والعلاقة مع القرآن',
  '1002': 'التنمية وتطوير السلوك',
  '1003': 'الروايات',
  '1004': 'القصص القصيرة',
  '1005': 'بوصلة المصلح',
  '1006': 'وعي المسلم المعاصر',
  '1007': 'أخلاق وفضائل طلب العلم',
  '1008': 'مهارات طالب العلم',
  '1009': 'التفاسير وغريب القرآن',
  '1010': 'علوم القرآن',
  '1011': 'التجويد والقراءات',
  '1012': 'آداب حملة القرآن وفضائله',
  '1013': 'السيرة النبوية والمغازي',
  '1014': 'شمائل النبي وفضله',
  '1015': 'المرأة المسلمة',
  '1016': 'جمالية الإسلام',
  '1017': 'التفنيدات والمناقشات',
  '1018': 'إثبات صحة الإسلام',
  '1019': 'الدفاع عن السنة وحجيتها',
  '1020': 'كتب الحديث وشروحها',
  '1021': 'علوم الحديث',
  '1022': 'كتب التاريخ الموجزة والشاملة',
  '1023': 'التاريخ الحديث',
  '1024': 'التاريخ الإسلامي',
  '1025': 'الدولة العثمانية',
  '1026': 'الدولة الأموية',
  '1027': 'الدولة العباسية',
  '1028': 'دولة المغرب',
  '1029': 'تاريخ الدول الغربية',
  '1030': 'رحلات ومذكرات',
  '1031': 'التاريخ القديم',
  '1032': 'أدعية وأذكار',
  '1033': 'فضائل الأعمال والأوقات',
  '1034': 'المواعظ',
  '1035': 'الأخلاق',
  '1036': 'التزكية وأعمال القلوب',
  '1037': 'الفقه الميسر',
  '1038': 'الفقه العام',
  '1039': 'بحوث فقهية',
  '1040': 'اليوم الآخر وعلاماته',
  '1041': 'الفقه الشافعي وأصوله',
  '1042': 'الفقه الحنبلي وأصوله',
  '1043': 'الفقه المالكي وأصوله',
  '1044': 'الفقه الحنفي وأصوله',
  '1045': 'العقيدة المبسطة الشاملة',
  '1046': 'كتب تأصيلية عقدية',
  '1047': 'كتب ردود عقدية',
  '1048': 'بحوث في العقيدة',
  '1049': 'مقارنة الأديان',
  '1050': 'الفكر الإسلامي',
  '1051': 'الفلسفة وعلم المنطق',
  '1052': 'السياسة والاقتصاد',
  '1053': 'التربية',
  '1054': 'علم النفس',
  '1055': 'علم الاجتماع ونفس الجماهير',
  '1056': 'تراجم الصحابة والتابعين',
  '1057': 'تراجم المسلمين',
  '1058': 'تراجم غير المسلمين',
  '1059': 'رواية حفص عن عاصم',
  '1060': 'الروايات الأخرى',
  '1061': 'النحو والصرف والإملاء',
  '1062': 'البلاغة',
  '1063': 'الشعر',
  '1064': 'المقالات',
  '1065': 'لغة عربية وأدب - أخرى',
  '1066': 'أخرى',
  '1067': 'الفقه المقارن',
  '1068': 'مصاحف الحدر للحفاظ',
  '1069': 'الزواج',
  '1070': 'قصص للأطفال',
}

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
      // The admin portal lets a user in only when the record is active and has a valid role.
      await db.doc(`users_adminv2/${account.uid}`).set({ role: account.role, email: account.email, active: true })
    }
  }

  // The app requires this document to exist. Without catalog timestamps it keeps the
  // catalog it already has instead of downloading one.
  await db.doc('settings_app/settings_metadata').set({ note: 'Firestore emulator' })
  await db.doc('settings_app/archived_books').set({ books: [] })
  await db.doc('categories/main').set({ sub_categories: SUB_CATEGORIES })
}

await wipe()
await seed()
console.log(`Seeded ${ACCOUNTS.length} accounts: ${ACCOUNTS.map((account) => account.email).join(', ')}`)
