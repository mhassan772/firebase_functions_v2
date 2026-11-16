/// Page strings in Arabic and English, keyed by the same names.

// The address the account emails take replies at, so the terms name the mailbox someone reads.
import { AUTH_EMAIL_REPLY_TO_ADDRESS as CONTACT_ADDRESS } from "../../src/config/constants";

export type Lang = "ar" | "en";

/// One clause of the subscription terms: its numbered title and its paragraph.
export interface TermsClause {
  title: string;
  body: string;
}

/// When the terms below last changed, shown at the top of `/terms`. Change it with the text.
export const TERMS_UPDATED = "2026-11-16";

/// The contact address the terms name; `/terms` makes it a mail link wherever it appears.
export const TERMS_CONTACT = CONTACT_ADDRESS;

/// How a store is named in each place of a sentence; Arabic uses the name alone everywhere.
export interface StoreWords {
  name: string;
  /// "an App Store", "a Google Play".
  a: string;
  /// "in the App Store", "on Google Play".
  in: string;
  /// "through the App Store", "through Google Play".
  through: string;
}

const ar = {
  brand: "منطوق",
  switchLanguage: "English",
  switchLanguageLang: "en",
  footer: "منطوق · mantooq.com",
  loading: "جارٍ التحقق من الرابط…",

  resetTitle: "كلمة مرور جديدة",
  resetIntro: "اختر كلمة مرور جديدة لحسابك.",
  account: "الحساب:",
  newPassword: "كلمة المرور الجديدة",
  confirmPassword: "تأكيد كلمة المرور",
  show: "إظهار",
  hide: "إخفاء",
  showNew: "إظهار كلمة المرور الجديدة",
  hideNew: "إخفاء كلمة المرور الجديدة",
  showConfirm: "إظهار تأكيد كلمة المرور",
  hideConfirm: "إخفاء تأكيد كلمة المرور",
  ruleLength: "٨ أحرف على الأقل",
  ruleMatch: "كلمتا المرور متطابقتان",
  errorLength: "يجب أن تتكون كلمة المرور من ٨ أحرف على الأقل.",
  errorMatch: "كلمتا المرور غير متطابقتين.",
  errorWeak: "كلمة المرور ضعيفة. اختر كلمة أطول.",
  save: "حفظ كلمة المرور",
  saving: "جارٍ الحفظ…",

  resetDoneTitle: "تم تغيير كلمة المرور",
  resetDoneBody: "يمكنك الآن تسجيل الدخول في التطبيق بكلمة المرور الجديدة.",

  verifiedTitle: "تم تأكيد بريدك الإلكتروني",
  verifiedBody: "حسابك جاهز. عد إلى التطبيق لتبدأ الاستماع.",

  changedTitle: "تم تغيير بريدك الإلكتروني",
  changedBody: (email: string) => `أصبح بريد الدخول إلى حسابك ${email}.`,
  changedBodyNoEmail: "تغيّر بريد الدخول إلى حسابك.",

  recoveredTitle: "أُعيد بريدك الإلكتروني السابق",
  recoveredBody: (email: string) => `عاد بريد الدخول إلى حسابك ${email}. إن لم تكن أنت من غيّره، فغيّر كلمة المرور الآن.`,
  sendReset: "أرسل رابط تغيير كلمة المرور",
  sending: "جارٍ الإرسال…",
  resetSent: (email: string) => `أرسلنا رابط تغيير كلمة المرور إلى ${email}.`,
  resetSendFailed: "تعذّر إرسال الرابط. حاول مرة أخرى بعد قليل.",

  expiredTitle: "انتهت صلاحية الرابط",
  expiredBody: "هذا الرابط استُخدم من قبل أو انتهت مدته. اطلب رابطًا جديدًا من التطبيق.",
  invalidTitle: "الرابط غير صالح",
  invalidBody: "تأكد من فتح الرابط كاملًا كما وصلك في الرسالة، أو اطلب رابطًا جديدًا من التطبيق.",
  disabledTitle: "هذا الحساب موقوف",
  disabledBody: "لا يمكن إكمال هذا الطلب لحساب موقوف. تواصل معنا من التطبيق.",
  networkTitle: "تعذّر الاتصال",
  networkBody: "تحقق من اتصالك بالإنترنت ثم حاول مرة أخرى. إن استمرت المشكلة في بلدك، جرّب تفعيل VPN.",
  tooManyTitle: "محاولات كثيرة",
  tooManyBody: "انتظر قليلًا ثم حاول مرة أخرى.",
  genericTitle: "حدث خطأ",
  genericBody: "لم نتمكن من إكمال الطلب. حاول مرة أخرى.",
  retry: "حاول مرة أخرى",

  openApp: "افتح منطوق",
  backToAppOnPhone: "عد إلى تطبيق منطوق على هاتفك.",

  // Product names, the same in both languages.
  googleName: "Google",
  appleName: "Apple",
  appStoreName: "App Store",
  playStoreName: "Google Play",

  notFoundTitle: "الصفحة غير موجودة",
  notFoundBody: "تأكد من الرابط وحاول مرة أخرى.",
  goHome: "الذهاب إلى mantooq.com",

  // Sign-in view, shared by every page that needs an account.
  signInTitle: "سجّل الدخول للمتابعة",
  signInIntro: "سجّل الدخول بالطريقة نفسها التي تستخدمها في التطبيق.",
  continueWithGoogle: "المتابعة باستخدام Google",
  continueWithApple: "المتابعة باستخدام Apple",
  or: "أو",
  email: "البريد الإلكتروني",
  password: "كلمة المرور",
  showPassword: "إظهار كلمة المرور",
  hidePassword: "إخفاء كلمة المرور",
  signIn: "تسجيل الدخول",
  signingIn: "جارٍ تسجيل الدخول…",
  forgotPasswordHint: "نسيت كلمة المرور؟ يمكنك تغييرها من شاشة تسجيل الدخول في التطبيق.",
  errorEmailMissing: "أدخل بريدك الإلكتروني.",
  errorPasswordMissing: "أدخل كلمة المرور.",
  errorWrongCredentials: "البريد الإلكتروني أو كلمة المرور غير صحيحة.",
  errorTooMany: "محاولات كثيرة. انتظر قليلًا ثم حاول مرة أخرى.",
  errorNetwork: "تعذّر الاتصال. تحقق من اتصالك بالإنترنت ثم حاول مرة أخرى.",
  errorPopupBlocked: "منع المتصفح فتح نافذة تسجيل الدخول. اسمح بالنوافذ المنبثقة لهذا الموقع ثم حاول مرة أخرى.",
  errorProviderDisabled: "طريقة الدخول هذه غير متاحة الآن. جرّب طريقة أخرى.",
  errorOtherMethod: "هذا البريد مسجّل بطريقة دخول أخرى. استخدم الطريقة التي سجّلت بها في التطبيق.",
  errorWrongPassword: "كلمة المرور غير صحيحة.",
  errorDifferentAccount: "هذا حساب آخر. أكّد هويتك بالحساب نفسه الذي سجّلت الدخول به.",
  errorDisabled: "هذا الحساب موقوف. تواصل معنا من التطبيق.",
  errorSignInGeneric: "تعذّر تسجيل الدخول. حاول مرة أخرى.",
  signedInAnnouncement: "تم تسجيل الدخول.",

  // Re-authentication before a sensitive step.
  reauthTitle: "تأكيد هويتك",
  reauthBody: "مضى وقت على تسجيل دخولك. للحماية، أكّد هويتك قبل حذف الحساب.",
  confirmWithGoogle: "التأكيد باستخدام Google",
  confirmWithApple: "التأكيد باستخدام Apple",
  confirmWithPassword: "تأكيد",
  confirming: "جارٍ التأكيد…",
  cancel: "إلغاء",
  reauthSignInAgain: "لا يمكن تأكيد طريقة الدخول هذه هنا. سجّل الدخول من جديد للمتابعة.",

  // /delete
  deleteTitle: "حذف حساب منطوق",
  deleteIntro: "من هذه الصفحة تحذف حسابك في تطبيق منطوق (Mantooq) للكتب الصوتية والبودكاست، والبيانات المحفوظة معه.",
  deletedHeading: "ما الذي يُحذف",
  deletedBody:
    "الحساب وطريقة الدخول إليه، وكل البيانات المحفوظة معه: مكتبتك، وتقدّم الاستماع، والمفضلة، والقوائم، وسجل الاستماع، والإعدادات، وسجلات الاشتراك.",
  keptHeading: "ما الذي يبقى",
  keptPayments: "سجلات المدفوعات التي تمت من قبل، دون أي شيء يدل على حسابك.",
  keptLateWrites: "إن بقي جهاز مسجّل الدخول، فما يحفظه بعد الحذف يُزال خلال ٧ أيام.",
  storeNotice:
    "حذف الحساب لا يلغي اشتراكًا اشتريته من App Store أو Google Play. ألغِه من المتجر حتى لا يُجدَّد ويُخصم منك.",
  appStoreLink: "اشتراكات App Store",
  playStoreLink: "اشتراكات Google Play",
  opensInNewTab: "(يفتح في نافذة جديدة)",
  cannotUndo: "لا يمكن التراجع عن الحذف ولا استعادة الحساب بعده.",
  inAppPath: "يمكنك أيضًا حذف الحساب من التطبيق: الإعدادات ← الحساب ← مسح الحساب.",
  checkingSignIn: "جارٍ التحقق من تسجيل الدخول…",
  signInFailedTitle: "تعذّر تجهيز تسجيل الدخول",

  confirmTitle: "تأكيد الحذف",
  signedInAs: "الحساب:",
  signedInWith: (provider: string) => `حساب مسجّل عبر ${provider}`,
  notYou: "لست أنت؟ سجّل الخروج",
  signedOutAnnouncement: "تم تسجيل الخروج.",
  activeStoreWarning: (store: string) =>
    `لديك اشتراك في ${store} يتجدد تلقائيًا. حذف الحساب لا يلغيه، وسيستمر الخصم حتى تلغيه من ${store}.`,
  cancelInStore: (store: string) => `إلغاء الاشتراك في ${store}`,
  manageInStore: (store: StoreWords) => `إدارة الاشتراك في ${store.in}`,
  understand: "أفهم أن حسابي وبياناته ستُحذف نهائيًا، وأن الحذف لا يمكن التراجع عنه.",
  tickFirst: "حدّد مربع التأكيد أولًا.",
  deleteButton: "احذف حسابي نهائيًا",
  deleting: "جارٍ حذف الحساب…",
  retryDelete: "حاول حذف الحساب مرة أخرى",
  deleteFailed: "تعذّر إكمال حذف الحساب. لم يُسجَّل خروجك، حاول مرة أخرى بعد قليل.",
  deleteNoAnswer: "لم يصل رد، وحسابك ما زال موجودًا. تحقق من اتصالك بالإنترنت ثم حاول مرة أخرى.",
  deleteUnknown: "لم يصل رد، ولم نتمكن من التأكد من حذف الحساب. تحقق من اتصالك بالإنترنت ثم حاول مرة أخرى.",

  doneTitle: "حُذف حسابك",
  doneBody: "حُذف حسابك وبياناته من منطوق، وتم تسجيل خروجك.",
  doneEmail: "أرسلنا رسالة تأكيد إلى بريدك الإلكتروني، وقد تصل خلال دقائق.",
  doneStore: "إن كان لديك اشتراك من App Store أو Google Play، فألغِه من المتجر نفسه، فحذف الحساب لا يلغيه.",
  // The account page, at /subscribe and /manage
  dollars: (amount: string) => `${amount} دولار`,
  dollarsInFull: (amount: string) => `${amount} دولار أمريكي`,
  planMonthly: "شهري",
  planYearly: "سنوي",
  planLifetime: "مدى الحياة",
  perMonth: (price: string) => `${price} شهريًا`,
  perYear: (price: string) => `${price} سنويًا`,
  once: (price: string) => `${price} مرة واحدة`,
  yearlyPerMonth: (price: string) => `أي ${price} في الشهر`,
  savePercent: (percent: number) => `وفّر ${percent.toLocaleString("ar-u-nu-arab")}٪`,
  anyStore: "المتجر",
  storeWords: (_platform: "apple" | "google" | null, name: string): StoreWords => ({ name, a: name, in: name, through: name }),
  lifetimeHint: "دفعة واحدة، دون تجديد.",
  accountTitle: "اشتراكك في منطوق بريميوم",
  accountIntro: "سجّل الدخول لترى اشتراكك، أو لتشترك بالبطاقة.",
  loadingAccount: "جارٍ تحميل اشتراكك…",
  attention: "تنبيه:",

  statusOn: "بريميوم مفعّل",
  statusOnUntil: (date: string | null) => (date ? `بريميوم مفعّل حتى ${date}` : "بريميوم مفعّل حتى نهاية المدة المدفوعة"),
  statusLifetime: "بريميوم مدى الحياة",
  statusLifetimeBody: "دفعة واحدة، فلا يتجدد ولا يُخصم منك شيء بعدها.",
  statusNeedsAction: "يطلب مصرفك تأكيد دفعة التجديد",
  statusNeedsActionBody: (date: string | null) =>
    date ? `يبقى بريميوم مفعّلًا حتى ${date}. أكّد الدفعة ليستمر بعد ذلك.` : "أكّد الدفعة ليستمر بريميوم.",
  statusPaymentFailed: "لم تنجح دفعة التجديد",
  statusPaymentFailedBody: (date: string | null) =>
    date ? `يبقى بريميوم مفعّلًا حتى ${date}. غيّر البطاقة لتحتفظ به.` : "غيّر البطاقة لتحتفظ ببريميوم.",
  statusActiveBody: (plan: string | null, date: string | null, amount: string | null) =>
    `${plan ? `اشتراكك ال${plan}` : "اشتراكك"} يتجدد ${date ? `في ${date}` : "تلقائيًا"}${amount ? ` بمبلغ ${amount}` : ""}.`,
  statusCancellingBody: "التجديد متوقف، فلن يُخصم منك شيء بعد الآن.",
  statusStoreBody: (store: StoreWords, date: string | null) =>
    date ? `اشتراكك عبر ${store.through} يتجدد في ${date}.` : `اشتراكك عبر ${store.through} يتجدد تلقائيًا.`,
  statusStoreManagedThere: (store: StoreWords) => `يُدار هذا الاشتراك من ${store.in}، لا من هنا.`,
  statusFromCancelledStore: (store: StoreWords) => `من اشتراكك عبر ${store.through}، وقد أوقفت تجديده.`,
  statusFromGrant: "فعّله لك فريق منطوق.",
  statusEnded: (date: string | null) => (date ? `انتهى اشتراكك في ${date}` : "انتهى اشتراكك"),
  statusNone: "ليس لديك بريميوم",
  statusChoosePlan: "اختر خطة من الخطط أدناه.",
  premiumStoreRenews: (store: StoreWords, date: string | null) => `اشتراك عبر ${store.through}، ${date ? `يتجدد في ${date}` : "يتجدد تلقائيًا"}.`,
  premiumStoreCancelling: (store: StoreWords, date: string | null) =>
    `اشتراك عبر ${store.through}، تجديده متوقف، ويبقى بريميوم حتى ${date ?? "نهاية مدته"}.`,
  premiumManual: (date: string | null) => (date ? `بريميوم من فريق منطوق حتى ${date}.` : "بريميوم من فريق منطوق."),
  storeAlsoActive: (store: StoreWords) =>
    `لديك أيضًا اشتراك عبر ${store.through} يتجدد تلقائيًا، فأنت تدفع مرتين. أوقف التجديد في ${store.in}، أو ألغِ اشتراكك هنا.`,
  storeAlsoActiveLifetime: (store: StoreWords) =>
    `لديك أيضًا اشتراك عبر ${store.through} يتجدد تلقائيًا، ولا حاجة إليه مع «مدى الحياة». أوقف التجديد في ${store.in} حتى لا يُخصم منك.`,

  labelCard: "البطاقة:",
  cardEnding: (brand: string, last4: string) => `${brand} المنتهية بـ ${last4}`,
  changeCard: "تغيير البطاقة",
  confirmPayment: "تأكيد الدفعة",
  confirmingPayment: "جارٍ تأكيد الدفعة…",
  verifiedAnnouncement: "تم تأكيد الدفعة.",
  verifyNotCompleted: "لم يكتمل تأكيد الدفعة. حاول مرة أخرى.",
  noActionRequiredError: "لا توجد دفعة تنتظر التأكيد.",
  resumeButton: "استئناف التجديد",
  resuming: "جارٍ استئناف التجديد…",
  resumedAnnouncement: "عاد التجديد التلقائي.",
  lifetimeInstead: "اشترِ «مدى الحياة» بدلًا من ذلك",
  upgradeHeading: "ترقية خطتك",
  payByCardHeading: "تريد الدفع بالبطاقة من هذا الموقع؟",
  payByCardBody: (store: StoreWords, date: string | null) =>
    `أوقف التجديد في ${store.in} أولًا، ثم عد إلى صفحة اشتراكك واختر خطة. يبقى بريميوم مفعّلًا حتى ${date ?? "نهاية مدته"}.`,
  buyLifetimeNow: "أو اشترِ «مدى الحياة» الآن",
  continueAfterHeading: "للاستمرار بعد ذلك",
  buyLifetimeHeading: "شراء مدى الحياة",
  back: "رجوع",

  choosePlan: "اختر الخطة",
  cardHeading: "بيانات البطاقة",
  cardsOnly: "تُقبل البطاقات فقط، ومنها Apple Pay وGoogle Pay.",
  loadingCardForm: "جارٍ تحميل نموذج الدفع…",
  cardFormFailed: "تعذّر تحميل نموذج الدفع. تحقق من اتصالك بالإنترنت ثم حاول مرة أخرى.",
  unknownCountryNote: "هذه هي الأسعار العامة. لترى سعر بلدك، افتح تطبيق منطوق بهذا الحساب، ثم أعد تحميل هذه الصفحة.",
  salesDisabled: "الدفع بالبطاقة غير متاح الآن. يمكنك الاشتراك من داخل التطبيق.",
  emailUnverified: "أكّد بريدك الإلكتروني أولًا من الرابط الذي أرسلناه إليك، ثم اضغط «تحقّق مرة أخرى».",
  checkAgain: "تحقّق مرة أخرى",
  confirmStartsToday: "ما تشتريه الآن يبدأ اليوم، لا بعد انتهاء ما لديك، ولا تُضاف مدته إليه.",
  storeKeepsRenewing: (store: StoreWords) => `إن اشتريت «مدى الحياة» فأوقف التجديد في ${store.in} بنفسك، فهو لا يتوقف وحده.`,
  acknowledge: "فهمت ذلك",
  acknowledgeFirst: "حدّد مربع «فهمت ذلك» أولًا.",
  existingPremiumChanged: "لديك بريميوم لم يكن ظاهرًا حين فتحت الصفحة، ولم يُخصم أي مبلغ. راجعه، ثم حدّد «فهمت ذلك» قبل الدفع.",
  payNoteMonthly: (today: string) =>
    `تدفع اليوم ${today}، ثم يتجدد الاشتراك كل شهر بالمبلغ نفسه حتى تلغيه. لا تُسترد المبالغ المدفوعة.`,
  payNoteYearly: (today: string) =>
    `تدفع اليوم ${today}، ثم يتجدد الاشتراك كل سنة بالمبلغ نفسه حتى تلغيه. لا تُسترد المبالغ المدفوعة.`,
  payNoteLifetime: (today: string) =>
    `تدفع اليوم ${today} مرة واحدة، ولا يتجدد. لا تُسترد المبالغ المدفوعة.`,
  noticeNoRefunds: "لا تُسترد المبالغ المدفوعة.",
  // The sentence under every pay and confirm button; `terms` is the link's own text.
  termsAccept: (terms: string) => `بالدفع توافق على ${terms}.`,
  termsLinkText: "شروط الاشتراك",
  pay: (amount: string) => `ادفع ${amount}`,
  paying: (amount: string) => `جارٍ دفع ${amount}…`,
  verifyingPayment: "يطلب مصرفك تأكيد الدفع. أكمله في النافذة التي فُتحت.",
  checkingPayment: "جارٍ التأكد من الدفع…",
  quoteHeading: "تغيّر السعر",
  quoteTaxHeading: (total: string) => `الإجمالي مع الضريبة: ${total}`,
  quotePrice: "السعر",
  quoteTax: "الضريبة",
  quoteTotal: "الإجمالي",
  quoteReasonCardCountry: "صدرت بطاقتك في بلد سعره أعلى من سعر بلدك المعروف لدينا.",
  quoteReasonTax: "تُضاف ضريبة بحسب عنوانك.",
  quoteReasonBoth: "صدرت بطاقتك في بلد سعره أعلى، وتُضاف ضريبة بحسب عنوانك.",
  quoteReasonPriceChanged: "تغيّر السعر منذ فتحت الصفحة.",
  quoteNothingCharged: "لم يُخصم أي مبلغ. راجع الإجمالي الجديد، ثم اضغط زر الدفع إن وافقت عليه.",
  quoteTaxBody: "تُضاف الضريبة بحسب عنوانك، ولم يُخصم أي مبلغ. اضغط زر الدفع إن وافقت.",
  quoteAnnouncement: (total: string) => `تغيّر السعر، والإجمالي الجديد ${total}. لم يُخصم أي مبلغ.`,
  quoteTaxAnnouncement: (total: string) => `الإجمالي مع الضريبة ${total}. لم يُخصم أي مبلغ.`,
  provinceLabel: "المقاطعة أو الإقليم في كندا",
  provinceChoose: "اختر…",
  provinceNeeded: "اختر مقاطعتك أو إقليمك في كندا لنحسب الضريبة، ثم اضغط زر الدفع.",
  cardIncomplete: "بيانات البطاقة غير مكتملة أو غير صحيحة. صحّحها في النموذج ثم حاول مرة أخرى.",
  declined: "رفض المصرف البطاقة، ولم يُخصم أي مبلغ. جرّب بطاقة أخرى أو تواصل مع مصرفك.",
  declinedFunds: "لا يكفي رصيد البطاقة، ولم يُخصم أي مبلغ. جرّب بطاقة أخرى.",
  declinedExpired: "انتهت صلاحية البطاقة، ولم يُخصم أي مبلغ. استخدم بطاقة أخرى.",
  declinedDetails: "بيانات البطاقة غير صحيحة، ولم يُخصم أي مبلغ. تحقق من الرقم وتاريخ الانتهاء ورمز الأمان.",
  declinedAuthentication: "لم يؤكد المصرف الدفع، ولم يُخصم أي مبلغ. حاول مرة أخرى أو استخدم بطاقة أخرى.",
  tokenExpired: "انتهت صلاحية بيانات البطاقة المدخلة، ولم يُخصم أي مبلغ. أدخلها مرة أخرى ثم حاول.",
  cardRequired: "تُقبل البطاقات فقط، ولم يُخصم أي مبلغ. ادفع ببطاقة.",
  throttled: "محاولات دفع كثيرة اليوم، ولم يُخصم أي مبلغ. حاول مرة أخرى غدًا.",
  billingIncomplete: "العنوان في نموذج البطاقة غير مكتمل، ولم يُخصم أي مبلغ. أكمل البلد والرمز البريدي ثم حاول مرة أخرى.",
  planUnavailable: "هذه الخطة غير متاحة بسعر بلد بطاقتك، ولم يُخصم أي مبلغ. اختر خطة أخرى.",
  alreadySubscribedError: "لديك اشتراك من هذا الموقع بالفعل، ولم يُخصم أي مبلغ.",
  lifetimeActiveError: "لديك «مدى الحياة» بالفعل، ولم يُخصم أي مبلغ.",
  storeActiveError: (store: StoreWords) =>
    `لديك اشتراك عبر ${store.through} يتجدد تلقائيًا، ولم يُخصم أي مبلغ. أوقف التجديد في ${store.in} أولًا، أو اختر «مدى الحياة».`,
  paymentNoAnswer: "لم يصل رد. حاول مرة أخرى: لن يُخصم منك مرتين للدفعة نفسها.",
  paymentFailed: "تعذّر إكمال الدفع. حاول مرة أخرى بعد قليل، ولن يُخصم منك مرتين للدفعة نفسها.",
  authenticationNotCompleted: "لم يكتمل تأكيد الدفع، ولم يُخصم أي مبلغ. حاول مرة أخرى.",
  purchaseInProgress: "هناك دفعة أخرى لهذا الحساب قيد التنفيذ، ولم يُخصم شيء من هذه المحاولة. أكملها في النافذة الأخرى، أو انتظر بضع دقائق ثم حاول مرة أخرى.",
  accountDeleted: "لا يمكن المتابعة بهذا الحساب، وتم تسجيل خروجك.",
  actionNoAnswer: "لم يصل رد. تحقق من اتصالك بالإنترنت ثم حاول مرة أخرى.",
  actionFailed: "تعذّر إكمال الطلب. حاول مرة أخرى بعد قليل.",
  purchasedAnnouncement: "تم الدفع، وفُعّل بريميوم لهذا الحساب.",
  confirmingTitle: "الدفع قيد التأكيد",
  confirmingBody: "لا حاجة إلى دفع شيء آخر. قد يستغرق التأكيد بضع دقائق.",
  stillConfirming: "ما زال الدفع قيد التأكيد. تحقّق مرة أخرى بعد قليل.",
  paymentNotCompleted: "لم يتم الدفع، ولم يُخصم أي مبلغ. يمكنك اختيار خطة من جديد.",
  chargeIncomplete: "لم يكتمل الدفع، ولم يُخصم أي مبلغ. حاول مرة أخرى.",

  cancelButton: "إلغاء الاشتراك",
  cancelDialogTitle: "إلغاء الاشتراك؟",
  cancelDialogBody: (date: string | null) =>
    date
      ? `لن يتجدد اشتراكك، ويبقى بريميوم مفعّلًا حتى ${date}. لا تُسترد المبالغ المدفوعة.`
      : "لن يتجدد اشتراكك، ويبقى بريميوم مفعّلًا حتى نهاية المدة المدفوعة. لا تُسترد المبالغ المدفوعة.",
  confirmCancel: "نعم، ألغِ الاشتراك",
  keepSubscription: "لا، أبقِ الاشتراك",
  cancellingSubscription: "جارٍ إلغاء الاشتراك…",
  cancelledAnnouncement: "أُلغي الاشتراك، ولن يتجدد.",

  replaceIntro: "تُستخدم البطاقة الجديدة في التجديدات القادمة.",
  replaceIntroPastDue: "تُستخدم البطاقة الجديدة لتسديد المبلغ المستحق الآن، وفي التجديدات القادمة.",
  saveCard: "احفظ البطاقة",
  saveCardAccept: (price: string) => `احفظ البطاقة ووافق على ${price}`,
  savingCard: "جارٍ حفظ البطاقة…",
  cardSavedAnnouncement: "حُفظت البطاقة الجديدة.",
  renewalReprice: (price: string, date: string | null) =>
    date
      ? `صدرت هذه البطاقة في بلد سعره أعلى. إن حفظتها يصبح سعر التجديد ${price} ابتداءً من ${date}. لم يُخصم أي مبلغ.`
      : `صدرت هذه البطاقة في بلد سعره أعلى. إن حفظتها يصبح سعر التجديد ${price}. لم يُخصم أي مبلغ.`,
  verifyingCard: "يطلب مصرفك تأكيد البطاقة. أكمله في النافذة التي فُتحت.",
  cardVerifyNotCompleted: "لم يكتمل تأكيد البطاقة، ولم تُحفظ. حاول مرة أخرى.",
  cardVerifyFailed: "لم يؤكد المصرف البطاقة، ولم تُحفظ. حاول مرة أخرى أو استخدم بطاقة أخرى.",
  noSubscriptionError: "لم نجد اشتراكًا يمكن تغييره. أعد تحميل صفحة اشتراكك.",
  stripeUnavailable: "تغيير البطاقة وتأكيد الدفعة غير متاحين الآن. حاول لاحقًا.",

  switchYearly: "التحويل إلى الاشتراك السنوي",
  switchIntro: "يُخصم المبلغ اليوم من بطاقتك المحفوظة، ويصبح اشتراكك سنويًا ابتداءً من اليوم. وتُخصم من السعر قيمة الأيام المتبقية من شهرك الحالي.",
  loadingSwitchQuote: "جارٍ حساب المبلغ…",
  switchQuoteFailed: "تعذّر حساب المبلغ. حاول مرة أخرى.",
  switchQuoteReady: (total: string) => `يُخصم منك اليوم ${total} إن أكّدت التحويل.`,
  switchYearlyPrice: "السعر السنوي:",
  switchCredit: "خصم الأيام المتبقية من هذا الشهر:",
  switchTax: "الضريبة:",
  switchTotalToday: "المبلغ الذي يُخصم اليوم:",
  switchRenews: (date: string | null, price: string) =>
    date
      ? `يتجدد الاشتراك تلقائيًا في ${date}، ثم كل سنة بمبلغ ${price}، حتى تلغيه.`
      : `يتجدد الاشتراك تلقائيًا كل سنة بمبلغ ${price} حتى تلغيه.`,
  switchResumes: "كنت قد أوقفت التجديد، والتحويل يعيده.",
  switchConfirm: (total: string) => `ادفع ${total} وحوّل إلى السنوي`,
  switching: "جارٍ الدفع والتحويل…",
  switchedAnnouncement: "أصبح اشتراكك سنويًا.",
  switchRepriced: (total: string) =>
    `تغيّر المبلغ قليلًا منذ عرضه، وأصبح ${total}. لم يُخصم أي مبلغ. راجعه، ثم اضغط زر الدفع إن وافقت عليه.`,
  switchUnavailableAnnouncement: "لم يعد التحويل إلى السنوي متاحًا لهذا الاشتراك.",
  switchVerifyNotCompleted: "لم يكتمل تأكيد الدفع، ولم يُخصم أي مبلغ، وما زال اشتراكك شهريًا. حاول مرة أخرى.",
  upgradeLifetime: "الترقية إلى مدى الحياة",
  lifetimeIntro: "يُخصم المبلغ اليوم من بطاقتك المحفوظة، ويُفعَّل بريميوم مدى الحياة فورًا. وتُخصم من السعر قيمة المدة غير المستخدمة من اشتراكك الحالي.",
  lifetimeQuoteReady: (total: string) => `يُخصم منك اليوم ${total} إن أكّدت الترقية.`,
  lifetimePrice: "سعر مدى الحياة:",
  lifetimeCredit: (plan: string) => `خصم المدة غير المستخدمة من الاشتراك ال${plan}:`,
  lifetimeStops: (plan: string) => `يتوقف اشتراكك ال${plan} الآن، ولن يتجدد ولن يُخصم منه شيء بعد اليوم.`,
  lifetimeConfirm: (total: string) => `ادفع ${total} وارتقِ إلى مدى الحياة`,
  upgrading: "جارٍ الدفع والترقية…",
  upgradedAnnouncement: "أصبح لديك بريميوم مدى الحياة.",
  lifetimeUnavailableAnnouncement: "لم تعد الترقية إلى مدى الحياة متاحة لهذا الاشتراك.",
  lifetimeVerifyNotCompleted: "لم يكتمل تأكيد الدفع، ولم يُخصم أي مبلغ، وما زال اشتراكك كما هو. حاول مرة أخرى.",

  // /terms, a legal text the owner reviews before it is deployed: change it only with them.
  termsFooterLink: "شروط الاشتراك",
  termsTitle: "شروط الاشتراك في منطوق بريميوم",
  termsUpdated: (date: string) => `آخر تحديث: ${date}`,
  termsClauses: [
    { title: "١. من نحن", body: `منطوق خدمة تقدّمها مؤسسة بصيرة الإسلامية في كندا. للتواصل: ${CONTACT_ADDRESS}` },
    {
      title: "٢. ما الذي تشتريه",
      body: "بريميوم يفتح مزايا إضافية في تطبيق منطوق على حسابك. يُفعَّل على الحساب الذي اشتريت به، ولا يُنقل إلى حساب آخر.",
    },
    {
      title: "٣. الخطط والأسعار",
      body: "الخطة الشهرية والخطة السنوية تتجددان تلقائيًا حتى تلغيهما. خطة «مدى الحياة» دفعة واحدة دون تجديد. الأسعار بالدولار الأمريكي، وقد تختلف بحسب بلدك، ويظهر لك السعر كاملًا قبل الدفع. تُضاف الضريبة حيث يوجبها القانون، وتظهر لك قبل الدفع.",
    },
    {
      title: "٤. التجديد والإلغاء",
      body: "عند كل تجديد يُخصم سعر خطتك من بطاقتك المحفوظة. يمكنك إيقاف التجديد في أي وقت من صفحة اشتراكك، ويبقى بريميوم مفعّلًا حتى نهاية المدة التي دفعت ثمنها.",
    },
    {
      title: "٥. إذا لم تنجح دفعة التجديد",
      body: "نعيد المحاولة عدة مرات خلال أسبوعين، ويبقى بريميوم مفعّلًا سبعة أيام بعد موعد التجديد. إن لم تنجح أي محاولة ينتهي الاشتراك.",
    },
    {
      title: "٦. تغيير الخطة",
      body: "يمكنك التحويل من الشهري إلى السنوي، أو الترقية إلى «مدى الحياة»، من صفحة اشتراكك. تدفع الفرق اليوم بعد خصم قيمة المدة غير المستخدمة من خطتك الحالية.",
    },
    {
      title: "٧. خطة «مدى الحياة»",
      body: "يستمر بريميوم «مدى الحياة» على حسابك ما دام الحساب قائمًا وخدمة منطوق مقدَّمة، ولمدة أقصاها ٩٩ سنة من تاريخ الشراء.",
    },
    { title: "٨. لا استرداد", body: "جميع المدفوعات نهائية ولا تُسترد، إلا حيث يوجب القانون غير ذلك." },
    {
      title: "٩. الاشتراك عبر App Store أو Google Play",
      body: "الاشتراك الذي اشتريته من أحد المتجرين يُدار من ذلك المتجر. شراء خطة من هذا الموقع لا يلغيه، وعليك إيقاف تجديده هناك بنفسك.",
    },
    { title: "١٠. حذف الحساب", body: "حذف حسابك ينهي بريميوم ويوقف أي اشتراك اشتريته من هذا الموقع، دون استرداد." },
    {
      title: "١١. تغيير هذه الشروط",
      body: "قد نحدّث هذه الشروط، ويظهر تاريخ آخر تحديث أعلى الصفحة. أي تغيير في سعر خطتك يسري من التجديد التالي، ونبلّغك به قبل ذلك.",
    },
  ] as readonly TermsClause[],
  provinces: {
    AB: "ألبرتا",
    BC: "كولومبيا البريطانية",
    MB: "مانيتوبا",
    NB: "نيو برونزويك",
    NL: "نيوفاوندلاند ولابرادور",
    NS: "نوفا سكوشا",
    NT: "الأقاليم الشمالية الغربية",
    NU: "نونافوت",
    ON: "أونتاريو",
    PE: "جزيرة الأمير إدوارد",
    QC: "كيبك",
    SK: "ساسكاتشوان",
    YT: "يوكون",
  } as Record<string, string>,
};

export type Strings = typeof ar;

const en: Strings = {
  brand: "Mantooq",
  switchLanguage: "العربية",
  switchLanguageLang: "ar",
  footer: "Mantooq · mantooq.com",
  loading: "Checking your link…",

  resetTitle: "New password",
  resetIntro: "Choose a new password for your account.",
  account: "Account:",
  newPassword: "New password",
  confirmPassword: "Confirm password",
  show: "Show",
  hide: "Hide",
  showNew: "Show new password",
  hideNew: "Hide new password",
  showConfirm: "Show password confirmation",
  hideConfirm: "Hide password confirmation",
  ruleLength: "At least 8 characters",
  ruleMatch: "Passwords match",
  errorLength: "Your password needs at least 8 characters.",
  errorMatch: "The passwords don't match.",
  errorWeak: "That password is too weak. Choose a longer one.",
  save: "Save password",
  saving: "Saving…",

  resetDoneTitle: "Password changed",
  resetDoneBody: "You can now sign in to the app with your new password.",

  verifiedTitle: "Email verified",
  verifiedBody: "Your account is ready. Go back to the app to start listening.",

  changedTitle: "Email changed",
  changedBody: (email: string) => `Your sign-in email is now ${email}.`,
  changedBodyNoEmail: "Your sign-in email has changed.",

  recoveredTitle: "Your previous email is back",
  recoveredBody: (email: string) =>
    `Your sign-in email is ${email} again. If you didn't make the change, change your password now.`,
  sendReset: "Send a password reset link",
  sending: "Sending…",
  resetSent: (email: string) => `We sent a password reset link to ${email}.`,
  resetSendFailed: "Couldn't send the link. Try again in a moment.",

  expiredTitle: "This link has expired",
  expiredBody: "It was already used or is too old. Request a new link from the app.",
  invalidTitle: "This link isn't valid",
  invalidBody: "Make sure you opened the whole link from the email, or request a new one from the app.",
  disabledTitle: "This account is disabled",
  disabledBody: "This request can't be completed for a disabled account. Contact us from the app.",
  networkTitle: "Couldn't connect",
  networkBody: "Check your internet connection and try again. If it keeps failing where you are, try a VPN.",
  tooManyTitle: "Too many attempts",
  tooManyBody: "Wait a moment, then try again.",
  genericTitle: "Something went wrong",
  genericBody: "We couldn't complete the request. Try again.",
  retry: "Try again",

  openApp: "Open Mantooq",
  backToAppOnPhone: "Go back to the Mantooq app on your phone.",

  googleName: "Google",
  appleName: "Apple",
  appStoreName: "App Store",
  playStoreName: "Google Play",

  notFoundTitle: "Page not found",
  notFoundBody: "Check the link and try again.",
  goHome: "Go to mantooq.com",

  signInTitle: "Sign in to continue",
  signInIntro: "Sign in the same way you do in the app.",
  continueWithGoogle: "Continue with Google",
  continueWithApple: "Continue with Apple",
  or: "or",
  email: "Email",
  password: "Password",
  showPassword: "Show password",
  hidePassword: "Hide password",
  signIn: "Sign in",
  signingIn: "Signing in…",
  forgotPasswordHint: "Forgot your password? You can change it from the app's sign-in screen.",
  errorEmailMissing: "Enter your email.",
  errorPasswordMissing: "Enter your password.",
  errorWrongCredentials: "The email or password is incorrect.",
  errorTooMany: "Too many attempts. Wait a moment, then try again.",
  errorNetwork: "Couldn't connect. Check your internet connection and try again.",
  errorPopupBlocked: "Your browser blocked the sign-in window. Allow pop-ups for this site, then try again.",
  errorProviderDisabled: "This sign-in method isn't available right now. Try another one.",
  errorOtherMethod: "This email uses a different sign-in method. Use the one you signed up with in the app.",
  errorWrongPassword: "The password is incorrect.",
  errorDifferentAccount: "That's a different account. Confirm with the account you signed in with.",
  errorDisabled: "This account is disabled. Contact us from the app.",
  errorSignInGeneric: "Couldn't sign in. Try again.",
  signedInAnnouncement: "Signed in.",

  reauthTitle: "Confirm it's you",
  reauthBody: "It's been a while since you signed in. To keep your account safe, confirm it's you before deleting it.",
  confirmWithGoogle: "Confirm with Google",
  confirmWithApple: "Confirm with Apple",
  confirmWithPassword: "Confirm",
  confirming: "Confirming…",
  cancel: "Cancel",
  reauthSignInAgain: "This sign-in method can't be confirmed here. Sign in again to continue.",

  deleteTitle: "Delete your Mantooq account",
  deleteIntro:
    "Use this page to delete your account in Mantooq (منطوق), the audiobooks and podcasts app, and the data stored with it.",
  deletedHeading: "What is deleted",
  deletedBody:
    "Your account and its sign-in, and all the data stored with it: your library, listening progress, favourites, lists, listening history, settings and subscription records.",
  keptHeading: "What is kept",
  keptPayments: "Records of payments already made, without anything that identifies your account.",
  keptLateWrites: "If a device is still signed in, anything it saves after the deletion is removed within 7 days.",
  storeNotice:
    "Deleting your account doesn't cancel a subscription bought in the App Store or Google Play. Cancel it in the store so it doesn't renew and charge you.",
  appStoreLink: "App Store subscriptions",
  playStoreLink: "Google Play subscriptions",
  opensInNewTab: "(opens in a new tab)",
  cannotUndo: "Deletion can't be undone, and the account can't be recovered afterwards.",
  inAppPath: "You can also delete your account in the app: Settings → Account → Delete My Account.",
  checkingSignIn: "Checking your sign-in…",
  signInFailedTitle: "Couldn't prepare sign-in",

  confirmTitle: "Confirm deletion",
  signedInAs: "Account:",
  signedInWith: (provider: string) => `Account signed in with ${provider}`,
  notYou: "Not you? Sign out",
  signedOutAnnouncement: "Signed out.",
  activeStoreWarning: (store: string) =>
    `You have a ${store} subscription that renews automatically. Deleting your account doesn't cancel it: you'll keep being charged until you cancel it in ${store}.`,
  cancelInStore: (store: string) => `Cancel the subscription in ${store}`,
  manageInStore: (store: StoreWords) => `Manage the subscription ${store.in}`,
  understand: "I understand that my account and its data will be deleted permanently, and that this can't be undone.",
  tickFirst: "Tick the confirmation box first.",
  deleteButton: "Delete my account permanently",
  deleting: "Deleting your account…",
  retryDelete: "Try deleting my account again",
  deleteFailed: "We couldn't finish deleting your account. You're still signed in; try again in a moment.",
  deleteNoAnswer: "We didn't get an answer, and your account still exists. Check your internet connection and try again.",
  deleteUnknown:
    "We didn't get an answer and couldn't check whether your account was deleted. Check your internet connection and try again.",

  doneTitle: "Your account has been deleted",
  doneBody: "Your account and its data have been deleted from Mantooq, and you've been signed out.",
  doneEmail: "We've sent a confirmation to your email. It may take a few minutes to arrive.",
  doneStore:
    "If you have a subscription from the App Store or Google Play, cancel it in that store: deleting your account doesn't cancel it.",
  // The account page, at /subscribe and /manage
  dollars: (amount: string) => `$${amount}`,
  dollarsInFull: (amount: string) => `$${amount} (US dollars)`,
  planMonthly: "Monthly",
  planYearly: "Yearly",
  planLifetime: "Lifetime",
  perMonth: (price: string) => `${price} a month`,
  perYear: (price: string) => `${price} a year`,
  once: (price: string) => `${price} once`,
  yearlyPerMonth: (price: string) => `That's ${price} a month`,
  savePercent: (percent: number) => `Save ${percent}%`,
  anyStore: "store",
  storeWords: (platform: "apple" | "google" | null, name: string): StoreWords =>
    platform === "apple"
      ? { name, a: `an ${name}`, in: `in the ${name}`, through: `through the ${name}` }
      : platform === "google"
        ? { name, a: `a ${name}`, in: `on ${name}`, through: `through ${name}` }
        : { name, a: `a ${name}`, in: `in the ${name}`, through: `through the ${name}` },
  lifetimeHint: "One payment, no renewals.",
  accountTitle: "Your Mantooq Premium",
  accountIntro: "Sign in to see your subscription, or to subscribe by card.",
  loadingAccount: "Loading your subscription…",
  attention: "Attention:",

  statusOn: "Premium is on",
  statusOnUntil: (date: string | null) => (date ? `Premium is on until ${date}` : "Premium is on until the end of the paid period"),
  statusLifetime: "Lifetime Premium",
  statusLifetimeBody: "One payment, so nothing renews and nothing more is charged.",
  statusNeedsAction: "Your bank wants to confirm the renewal payment",
  statusNeedsActionBody: (date: string | null) =>
    date ? `Premium stays on until ${date}. Confirm the payment to keep it after that.` : "Confirm the payment to keep Premium.",
  statusPaymentFailed: "The renewal payment didn't go through",
  statusPaymentFailedBody: (date: string | null) =>
    date ? `Premium stays on until ${date}. Change the card to keep it.` : "Change the card to keep Premium.",
  statusActiveBody: (plan: string | null, date: string | null, amount: string | null) =>
    `${plan ? `Your ${plan.toLowerCase()} plan` : "Your plan"} renews ${date ? `on ${date}` : "automatically"}${amount ? ` for ${amount}` : ""}.`,
  statusCancellingBody: "Renewal is off, so nothing more is charged.",
  statusStoreBody: (store: StoreWords, date: string | null) =>
    date ? `Your subscription ${store.through} renews on ${date}.` : `Your subscription ${store.through} renews automatically.`,
  statusStoreManagedThere: (store: StoreWords) => `It's managed ${store.in}, not here.`,
  statusFromCancelledStore: (store: StoreWords) => `It comes from your subscription ${store.through}, whose renewal you turned off.`,
  statusFromGrant: "Turned on for you by the Mantooq team.",
  statusEnded: (date: string | null) => (date ? `Your subscription ended on ${date}` : "Your subscription has ended"),
  statusNone: "You don't have Premium",
  statusChoosePlan: "Choose a plan below.",
  premiumStoreRenews: (store: StoreWords, date: string | null) =>
    `Subscription ${store.through}, ${date ? `renews on ${date}` : "renews automatically"}.`,
  premiumStoreCancelling: (store: StoreWords, date: string | null) =>
    `Subscription ${store.through}, renewal off; Premium stays on until ${date ?? "the end of its period"}.`,
  premiumManual: (date: string | null) => (date ? `Premium from the Mantooq team until ${date}.` : "Premium from the Mantooq team."),
  storeAlsoActive: (store: StoreWords) =>
    `You also have ${store.a} subscription that renews automatically, so you're paying twice. Turn off its renewal ${store.in}, or cancel this one here.`,
  storeAlsoActiveLifetime: (store: StoreWords) =>
    `You also have ${store.a} subscription that renews automatically, which you don't need with lifetime. Turn off its renewal ${store.in} so you aren't charged.`,

  labelCard: "Card:",
  cardEnding: (brand: string, last4: string) => `${brand} ending in ${last4}`,
  changeCard: "Change card",
  confirmPayment: "Confirm the payment",
  confirmingPayment: "Confirming the payment…",
  verifiedAnnouncement: "The payment is confirmed.",
  verifyNotCompleted: "The payment wasn't confirmed. Try again.",
  noActionRequiredError: "No payment is waiting to be confirmed.",
  resumeButton: "Resume renewal",
  resuming: "Resuming the renewal…",
  resumedAnnouncement: "Automatic renewal is back on.",
  lifetimeInstead: "Buy lifetime instead",
  upgradeHeading: "Upgrade your plan",
  payByCardHeading: "Want to pay by card on this site?",
  payByCardBody: (store: StoreWords, date: string | null) =>
    `Turn off renewal ${store.in} first, then come back to your subscription page and choose a plan. Premium stays on until ${date ?? "the end of its period"}.`,
  buyLifetimeNow: "Or buy lifetime now",
  continueAfterHeading: "To continue after that",
  buyLifetimeHeading: "Buy lifetime",
  back: "Back",

  choosePlan: "Choose a plan",
  cardHeading: "Card details",
  cardsOnly: "Only cards are accepted, including Apple Pay and Google Pay.",
  loadingCardForm: "Loading the payment form…",
  cardFormFailed: "Couldn't load the payment form. Check your internet connection and try again.",
  unknownCountryNote: "These are the standard prices. To see your country's price, open the Mantooq app with this account, then reload this page.",
  salesDisabled: "Paying by card isn't available right now. You can subscribe in the app.",
  emailUnverified: "Verify your email first with the link we sent you, then press “Check again”.",
  checkAgain: "Check again",
  confirmStartsToday: "What you buy now starts today, not when what you have ends, and isn't added to it.",
  storeKeepsRenewing: (store: StoreWords) => `If you buy lifetime, turn off renewal ${store.in} yourself: it doesn't stop on its own.`,
  acknowledge: "I understand",
  acknowledgeFirst: "Tick “I understand” first.",
  existingPremiumChanged:
    "You have Premium that wasn't shown when you opened this page, and nothing was charged. Check it, then tick “I understand” before paying.",
  payNoteMonthly: (today: string) => `You pay ${today} today. It renews every month for the same amount until you cancel. Payments are not refundable.`,
  payNoteYearly: (today: string) => `You pay ${today} today. It renews every year for the same amount until you cancel. Payments are not refundable.`,
  payNoteLifetime: (today: string) =>
    `You pay ${today} once, today, and it never renews. Payments are not refundable.`,
  noticeNoRefunds: "Payments are not refundable.",
  termsAccept: (terms: string) => `By paying, you accept the ${terms}.`,
  termsLinkText: "subscription terms",
  pay: (amount: string) => `Pay ${amount}`,
  paying: (amount: string) => `Paying ${amount}…`,
  verifyingPayment: "Your bank is asking you to confirm the payment. Complete it in the window that opened.",
  checkingPayment: "Checking the payment…",
  quoteHeading: "The price changed",
  quoteTaxHeading: (total: string) => `Total with tax: ${total}`,
  quotePrice: "Price",
  quoteTax: "Tax",
  quoteTotal: "Total",
  quoteReasonCardCountry: "Your card was issued in a country with a higher price than the country we know for your account.",
  quoteReasonTax: "Tax is added for your address.",
  quoteReasonBoth: "Your card was issued in a country with a higher price, and tax is added for your address.",
  quoteReasonPriceChanged: "The price changed since you opened this page.",
  quoteNothingCharged: "Nothing was charged. Check the new total, then press the pay button if you accept it.",
  quoteTaxBody: "Tax is added for your address, and nothing was charged. Press the pay button if you agree.",
  quoteAnnouncement: (total: string) => `The price changed. The new total is ${total}. Nothing was charged.`,
  quoteTaxAnnouncement: (total: string) => `The total with tax is ${total}. Nothing was charged.`,
  provinceLabel: "Province or territory in Canada",
  provinceChoose: "Choose…",
  provinceNeeded: "Choose your province or territory in Canada so tax can be worked out, then press the pay button.",
  cardIncomplete: "The card details are incomplete or incorrect. Correct them in the form, then try again.",
  declined: "Your bank declined the card, and nothing was charged. Try another card or contact your bank.",
  declinedFunds: "The card doesn't have enough funds, and nothing was charged. Try another card.",
  declinedExpired: "The card has expired, and nothing was charged. Use another card.",
  declinedDetails: "The card details are incorrect, and nothing was charged. Check the number, expiry date and security code.",
  declinedAuthentication: "Your bank didn't confirm the payment, and nothing was charged. Try again or use another card.",
  tokenExpired: "The card details you entered have expired, and nothing was charged. Enter them again, then try again.",
  cardRequired: "Only cards are accepted, and nothing was charged. Pay with a card.",
  throttled: "Too many payment attempts today, and nothing was charged. Try again tomorrow.",
  billingIncomplete: "The address in the card form is incomplete, and nothing was charged. Fill in the country and postal code, then try again.",
  planUnavailable: "This plan isn't available at your card country's price, and nothing was charged. Choose another plan.",
  alreadySubscribedError: "You already have a subscription from this site, and nothing was charged.",
  lifetimeActiveError: "You already have lifetime Premium, and nothing was charged.",
  storeActiveError: (store: StoreWords) =>
    `You have ${store.a} subscription that renews automatically, and nothing was charged. Turn off its renewal ${store.in} first, or choose lifetime.`,
  paymentNoAnswer: "We didn't get an answer. Try again: you won't be charged twice for the same payment.",
  paymentFailed: "We couldn't complete the payment. Try again in a moment: you won't be charged twice for the same payment.",
  authenticationNotCompleted: "The payment wasn't confirmed, and nothing was charged. Try again.",
  purchaseInProgress:
    "Another payment for this account is already in progress, and nothing was charged for this attempt. Finish it in the other tab, or wait a few minutes and try again.",
  accountDeleted: "This account can't continue, and you've been signed out.",
  actionNoAnswer: "We didn't get an answer. Check your internet connection and try again.",
  actionFailed: "We couldn't complete the request. Try again in a moment.",
  purchasedAnnouncement: "Payment complete. Premium is on for this account.",
  confirmingTitle: "Your payment is being confirmed",
  confirmingBody: "There's nothing more to pay. Confirming can take a few minutes.",
  stillConfirming: "The payment is still being confirmed. Check again in a little while.",
  paymentNotCompleted: "The payment didn't go through, and nothing was charged. You can choose a plan again.",
  chargeIncomplete: "The payment didn't complete, and nothing was charged. Try again.",

  cancelButton: "Cancel subscription",
  cancelDialogTitle: "Cancel your subscription?",
  cancelDialogBody: (date: string | null) =>
    date
      ? `Your subscription won't renew, and Premium stays on until ${date}. Payments are not refundable.`
      : "Your subscription won't renew, and Premium stays on until the end of the paid period. Payments are not refundable.",
  confirmCancel: "Yes, cancel",
  keepSubscription: "No, keep it",
  cancellingSubscription: "Cancelling your subscription…",
  cancelledAnnouncement: "Your subscription is cancelled and won't renew.",

  replaceIntro: "The new card is used for future renewals.",
  replaceIntroPastDue: "The new card pays the amount due now, and future renewals.",
  saveCard: "Save card",
  saveCardAccept: (price: string) => `Save card and accept ${price}`,
  savingCard: "Saving the card…",
  cardSavedAnnouncement: "The new card is saved.",
  renewalReprice: (price: string, date: string | null) =>
    date
      ? `This card was issued in a country with a higher price. If you save it, renewals cost ${price} from ${date}. Nothing was charged.`
      : `This card was issued in a country with a higher price. If you save it, renewals cost ${price}. Nothing was charged.`,
  verifyingCard: "Your bank is asking you to confirm the card. Complete it in the window that opened.",
  cardVerifyNotCompleted: "The card wasn't confirmed, and it wasn't saved. Try again.",
  cardVerifyFailed: "Your bank didn't confirm the card, and it wasn't saved. Try again or use another card.",
  noSubscriptionError: "We couldn't find a subscription to change. Reload your subscription page.",
  stripeUnavailable: "Changing the card and confirming payments aren't available right now. Try later.",

  switchYearly: "Switch to the yearly plan",
  switchIntro: "Your saved card is charged today, and your plan becomes yearly from today. The days left in your current month are taken off the price.",
  loadingSwitchQuote: "Working out the amount…",
  switchQuoteFailed: "We couldn't work out the amount. Try again.",
  switchQuoteReady: (total: string) => `If you confirm the switch, you're charged ${total} today.`,
  switchYearlyPrice: "Yearly price:",
  switchCredit: "Credit for the days left this month:",
  switchTax: "Tax:",
  switchTotalToday: "Charged today:",
  switchRenews: (date: string | null, price: string) =>
    date
      ? `It renews automatically on ${date}, then every year at ${price}, until you cancel.`
      : `It renews automatically every year at ${price} until you cancel.`,
  switchResumes: "You had turned off renewal; switching turns it back on.",
  switchConfirm: (total: string) => `Pay ${total} and switch to yearly`,
  switching: "Paying and switching…",
  switchedAnnouncement: "Your subscription is now yearly.",
  switchRepriced: (total: string) =>
    `The amount changed slightly since it was shown and is now ${total}. Nothing was charged. Check it, then press the pay button if you agree.`,
  switchUnavailableAnnouncement: "Switching to yearly is no longer available for this subscription.",
  switchVerifyNotCompleted: "The payment wasn't confirmed. Nothing was charged, and your plan is still monthly. Try again.",
  upgradeLifetime: "Upgrade to lifetime",
  lifetimeIntro: "Your saved card is charged today, and lifetime Premium starts at once. The unused time of your current subscription is taken off the price.",
  lifetimeQuoteReady: (total: string) => `If you confirm the upgrade, you're charged ${total} today.`,
  lifetimePrice: "Lifetime price:",
  lifetimeCredit: (plan: string) => `Credit for the unused time of your ${plan.toLowerCase()} plan:`,
  lifetimeStops: (plan: string) => `Your ${plan.toLowerCase()} subscription stops now. It won't renew, and nothing more is charged for it.`,
  lifetimeConfirm: (total: string) => `Pay ${total} and upgrade to lifetime`,
  upgrading: "Paying and upgrading…",
  upgradedAnnouncement: "You now have lifetime Premium.",
  lifetimeUnavailableAnnouncement: "Upgrading to lifetime is no longer available for this subscription.",
  lifetimeVerifyNotCompleted: "The payment wasn't confirmed. Nothing was charged, and your subscription is unchanged. Try again.",

  termsFooterLink: "Subscription terms",
  termsTitle: "Mantooq Premium subscription terms",
  termsUpdated: (date: string) => `Last updated: ${date}`,
  termsClauses: [
    { title: "1. Who we are", body: `Mantooq is a service of Basira Islamic Foundation, Canada. Contact: ${CONTACT_ADDRESS}` },
    {
      title: "2. What you buy",
      body: "Premium unlocks extra features in the Mantooq app for your account. It applies to the account you bought it with and can't be moved to another account.",
    },
    {
      title: "3. Plans and prices",
      body: "The monthly and yearly plans renew automatically until you cancel. The lifetime plan is one payment with no renewal. Prices are in US dollars and may differ by country; you see the full price before you pay. Tax is added where the law requires it, and you see it before you pay.",
    },
    {
      title: "4. Renewal and cancelling",
      body: "At each renewal your plan's price is charged to your saved card. You can turn off renewal at any time on your subscription page, and Premium stays on until the end of the period you paid for.",
    },
    {
      title: "5. If a renewal payment fails",
      body: "We try again several times over two weeks, and Premium stays on for seven days after the renewal date. If no attempt succeeds, the subscription ends.",
    },
    {
      title: "6. Changing your plan",
      body: "You can switch from monthly to yearly, or upgrade to lifetime, on your subscription page. You pay the difference today, after a credit for the unused time of your current plan.",
    },
    {
      title: "7. The lifetime plan",
      body: "Lifetime Premium stays on your account for as long as the account exists and Mantooq is offered, up to 99 years from the date of purchase.",
    },
    { title: "8. No refunds", body: "All payments are final and are not refunded, except where the law requires otherwise." },
    {
      title: "9. Subscriptions through the App Store or Google Play",
      body: "A subscription bought in one of the stores is managed in that store. Buying a plan on this site doesn't cancel it; you need to turn off its renewal there yourself.",
    },
    { title: "10. Deleting your account", body: "Deleting your account ends Premium and stops any subscription bought on this site, with no refund." },
    {
      title: "11. Changes to these terms",
      body: "We may update these terms; the date of the last update is at the top of the page. A change to your plan's price applies from the next renewal, and we tell you before then.",
    },
  ],
  provinces: {
    AB: "Alberta",
    BC: "British Columbia",
    MB: "Manitoba",
    NB: "New Brunswick",
    NL: "Newfoundland and Labrador",
    NS: "Nova Scotia",
    NT: "Northwest Territories",
    NU: "Nunavut",
    ON: "Ontario",
    PE: "Prince Edward Island",
    QC: "Quebec",
    SK: "Saskatchewan",
    YT: "Yukon",
  },
};

export const STRINGS: Record<Lang, Strings> = { ar, en };

/// Arabic unless the link asks for English, matching the project's default auth locale.
export function langFromParam(value: string | null): Lang {
  return value?.toLowerCase().startsWith("en") ? "en" : "ar";
}
