import { AuthEmailLang } from "./actionLink";
import { escapeHtml, RenderedEmail, renderEmail } from "./layout";

interface Copy {
  subject: string;
  greeting: string;
  paragraphs: string[];
  note: string;
}

const COPY: Record<AuthEmailLang, Copy> = {
  ar: {
    subject: "حُذف حسابك في منطوق",
    greeting: "السلام عليكم،",
    paragraphs: [
      "حُذف حسابك في منطوق مع بياناته كما طلبت.",
      "حذفُ الحساب لا يُلغي اشتراكًا اشتريته من App Store أو Google Play. إن كان لديك اشتراك فألغِه من إعدادات الاشتراكات في المتجر حتى لا يتجدّد.",
    ],
    note: "إن بقي الحساب مفتوحًا على جهاز آخر، فما يحفظه ذلك الجهاز بعد الحذف يُزال خلال سبعة أيام.",
  },
  en: {
    subject: "Your Mantooq account has been deleted",
    greeting: "Assalamu alaikum,",
    paragraphs: [
      "Your Mantooq account and its data have been deleted, as you asked.",
      "Deleting the account does not cancel a subscription bought through the App Store or Google Play. If you have one, cancel it in the store's subscription settings so it does not renew.",
    ],
    note: "If the account was still signed in on another device, anything that device saved afterwards is removed within 7 days.",
  },
};

/** The confirmation sent once `deleteAccount` has removed an account; it informs only, so it has no button. */
export function renderAccountDeletedEmail(lang: AuthEmailLang): RenderedEmail {
  const copy = COPY[lang];
  return renderEmail(lang, {
    subject: copy.subject,
    greeting: copy.greeting,
    paragraphsHtml: copy.paragraphs.map(escapeHtml),
    paragraphsText: copy.paragraphs,
    note: copy.note,
  });
}
