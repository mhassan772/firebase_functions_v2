/// Page strings in Arabic and English, keyed by the same names.

export type Lang = "ar" | "en";

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
};

type Strings = typeof ar;

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
};

export const STRINGS: Record<Lang, Strings> = { ar, en };

/// Arabic unless the link asks for English, matching the project's default auth locale.
export function langFromParam(value: string | null): Lang {
  return value?.toLowerCase().startsWith("en") ? "en" : "ar";
}
