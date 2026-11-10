import { AuthEmailLang } from "./actionLink";

export type AuthEmailKind = "passwordReset" | "verification" | "emailChange";

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export interface AuthEmailContent {
  /** The accounts-page link the button opens. */
  link: string;
  /** The address the email is about: the account's for a reset, the new one for a change. */
  email: string;
}

const BRAND = {
  deepGreen: "#045E46",
  button: "#00805C",
  ink: "#10241C",
  muted: "#4F625A",
  headerText: "#D5EEE4",
  mintBg: "#E2F6EE",
  surface: "#F3F9F6",
};

const LOGO_URL = "https://accounts.mantooq.com/email-logo.png";

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

interface LangCopy {
  brand: string;
  tagline: string;
  team: string;
  kinds: Record<AuthEmailKind, Copy>;
}

const COPY: Record<AuthEmailLang, LangCopy> = {
  ar: {
    brand: "منطوق",
    tagline: "آلاف الكتب الصوتية والبودكاست في تطبيق واحد",
    team: "فريق منطوق",
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
    brand: "Mantooq",
    tagline: "Thousands of audiobooks and podcasts in one app",
    team: "The Mantooq team",
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

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The sender's display name in the email's language. */
export function senderName(lang: AuthEmailLang): string {
  return COPY[lang].brand;
}

export function renderAuthEmail(kind: AuthEmailKind, lang: AuthEmailLang, content: AuthEmailContent): RenderedEmail {
  const t = COPY[lang];
  const copy = t.kinds[kind];
  return {
    subject: copy.subject,
    html: renderHtml(lang, t, copy, content),
    text: renderText(lang, t, copy, content),
  };
}

function renderHtml(lang: AuthEmailLang, t: LangCopy, copy: Copy, content: AuthEmailContent): string {
  const dir = lang === "ar" ? "rtl" : "ltr";
  const align = lang === "ar" ? "right" : "left";
  const email = `<span dir="ltr" style="font-weight:700;unicode-bidi:isolate;">${escapeHtml(content.email)}</span>`;
  const intro = copy.intro
    .map((paragraph) => `<p style="margin:0;">${escapeHtml(paragraph).split(EMAIL).join(email)}</p>`)
    .join("\n        ");
  const href = escapeHtml(content.link);

  return `<!DOCTYPE html>
<html dir="${dir}" lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(copy.subject)}</title>
</head>
<body style="margin:0;padding:0;background:${BRAND.surface};">
<div dir="${dir}" lang="${lang}" style="margin:0;padding:24px 12px;background:${BRAND.surface};font-family:'IBM Plex Sans Arabic','Segoe UI',Tahoma,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;">
    <tr>
      <td style="background:${BRAND.deepGreen};padding:26px 24px;text-align:center;">
        <img src="${LOGO_URL}" width="48" height="48" alt="" style="display:block;margin:0 auto 6px;border:0;">
        <div style="color:#ffffff;font-size:24px;font-weight:700;line-height:1.4;">${escapeHtml(t.brand)}</div>
        <div style="color:${BRAND.headerText};font-size:13px;line-height:1.6;">${escapeHtml(t.tagline)}</div>
      </td>
    </tr>
    <tr>
      <td dir="${dir}" style="padding:28px 24px 8px;color:${BRAND.ink};font-size:15px;line-height:1.9;text-align:${align};">
        <p style="margin:0 0 6px;font-size:18px;font-weight:700;">${escapeHtml(copy.greeting)}</p>
        ${intro}
      </td>
    </tr>
    <tr>
      <td align="center" style="padding:18px 24px 6px;">
        <table role="presentation" cellpadding="0" cellspacing="0">
          <tr>
            <td style="border-radius:999px;background:${BRAND.button};">
              <a href="${href}" style="display:inline-block;padding:13px 34px;color:#ffffff;font-size:16px;font-weight:700;text-decoration:none;border-radius:999px;">${escapeHtml(copy.button)}</a>
            </td>
          </tr>
        </table>
      </td>
    </tr>
    <tr>
      <td dir="${dir}" style="padding:14px 24px 24px;color:${BRAND.muted};font-size:13px;line-height:1.8;text-align:${align};">
        ${escapeHtml(copy.note)}
      </td>
    </tr>
    <tr>
      <td style="background:${BRAND.mintBg};padding:14px 24px;text-align:center;color:${BRAND.deepGreen};font-size:12px;line-height:1.8;">
        ${escapeHtml(t.team)} · <a href="https://mantooq.com" style="color:${BRAND.deepGreen};">mantooq.com</a>
      </td>
    </tr>
  </table>
</div>
</body>
</html>`;
}

function renderText(lang: AuthEmailLang, t: LangCopy, copy: Copy, content: AuthEmailContent): string {
  // In Arabic text the address is isolated (LRI ... PDI) so its dots and @ keep their order.
  const email = lang === "ar" ? `⁦${content.email}⁩` : content.email;
  const lines = [
    copy.greeting,
    "",
    ...copy.intro.map((paragraph) => paragraph.split(EMAIL).join(email)),
    "",
    `${copy.button}:`,
    content.link,
    "",
    copy.note,
    "",
    `${t.team} · mantooq.com`,
  ];
  return lines.join("\n");
}
