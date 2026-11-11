import { AuthEmailLang } from "./actionLink";
import { escapeHtml, FRAME, RenderedEmail, renderEmail } from "./layout";

export { escapeHtml, RenderedEmail } from "./layout";

export type AuthEmailKind = "passwordReset" | "verification" | "emailChange";

export interface AuthEmailContent {
  /** The accounts-page link the button opens. */
  link: string;
  /** The address the email is about: the account's for a reset, the new one for a change. */
  email: string;
}

/** Marks where the address goes in a sentence, so it can be bidi-isolated in both parts. */
const EMAIL = "\u0000EMAIL\u0000";

interface Copy {
  subject: string;
  greeting: string;
  /** Paragraphs before the button; EMAIL is replaced by the address. */
  intro: string[];
  button: string;
  note: string;
}

const COPY: Record<AuthEmailLang, { kinds: Record<AuthEmailKind, Copy> }> = {
  ar: {
    kinds: {
      passwordReset: {
        subject: "إعادة تعيين كلمة المرور في منطوق",
        greeting: "السلام عليكم،",
        intro: [`طلبتَ إعادة تعيين كلمة المرور لحسابك ${EMAIL}`],
        button: "تعيين كلمة مرور جديدة",
        note: "الرابط صالح لمدة ساعة واحدة. إن لم تطلب ذلك فتجاهل هذه الرسالة، وستبقى كلمة مرورك كما هي.",
      },
      verification: {
        subject: "أكّد بريدك الإلكتروني في منطوق",
        greeting: "أهلًا بك في منطوق،",
        intro: ["بقيت خطوة واحدة: أكّد أن هذا البريد لك لتفعيل حسابك."],
        button: "تأكيد البريد الإلكتروني",
        note: "إن لم تنشئ حسابًا في منطوق فتجاهل هذه الرسالة.",
      },
      emailChange: {
        subject: "أكّد بريدك الإلكتروني الجديد في منطوق",
        greeting: "السلام عليكم،",
        intro: [
          `وصلنا طلب لجعل ${EMAIL} البريدَ الإلكتروني لحساب في منطوق.`,
          "أكّد أن هذا البريد لك لإتمام التغيير.",
        ],
        button: "تأكيد البريد الجديد",
        note: "إن لم تطلب ذلك فتجاهل هذه الرسالة، ولن يتغيّر شيء.",
      },
    },
  },
  en: {
    kinds: {
      passwordReset: {
        subject: "Reset your Mantooq password",
        greeting: "Assalamu alaikum,",
        intro: [`You asked to reset the password for your account ${EMAIL}.`],
        button: "Set a new password",
        note: "The link is valid for one hour. If you didn't ask for this, ignore this email and your password will stay the same.",
      },
      verification: {
        subject: "Confirm your email for Mantooq",
        greeting: "Welcome to Mantooq,",
        intro: ["One step left: confirm that this email is yours to activate your account."],
        button: "Confirm email",
        note: "If you didn't create a Mantooq account, ignore this email.",
      },
      emailChange: {
        subject: "Confirm your new email address for Mantooq",
        greeting: "Assalamu alaikum,",
        intro: [
          `We received a request to make ${EMAIL} the email address of a Mantooq account.`,
          "Confirm that this address is yours to finish the change.",
        ],
        button: "Confirm new email",
        note: "If you didn't ask for this, ignore this email and nothing will change.",
      },
    },
  },
};

/** The sender's display name in the email's language. */
export function senderName(lang: AuthEmailLang): string {
  return FRAME[lang].brand;
}

export function renderAuthEmail(kind: AuthEmailKind, lang: AuthEmailLang, content: AuthEmailContent): RenderedEmail {
  const copy = COPY[lang].kinds[kind];
  const emailHtml = `<span dir="ltr" style="font-weight:700;unicode-bidi:isolate;">${escapeHtml(content.email)}</span>`;
  // In Arabic text the address is isolated (LRI ... PDI) so its dots and @ keep their order.
  const emailText = lang === "ar" ? `\u2066${content.email}\u2069` : content.email;
  return renderEmail(lang, {
    subject: copy.subject,
    greeting: copy.greeting,
    paragraphsHtml: copy.intro.map((paragraph) => escapeHtml(paragraph).split(EMAIL).join(emailHtml)),
    paragraphsText: copy.intro.map((paragraph) => paragraph.split(EMAIL).join(emailText)),
    button: { label: copy.button, link: content.link },
    note: copy.note,
  });
}
