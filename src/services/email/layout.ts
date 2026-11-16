import { AuthEmailLang } from "./actionLink";

/**
 * The branded frame every Mantooq account email shares: header, body, optional button, note
 * and footer. Each kind of email supplies only its words.
 */

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
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

export interface FrameCopy {
  brand: string;
  tagline: string;
  team: string;
}

export const FRAME: Record<AuthEmailLang, FrameCopy> = {
  ar: {
    brand: "منطوق",
    tagline: "آلاف الكتب الصوتية والبودكاست في تطبيق واحد",
    team: "فريق منطوق",
  },
  en: {
    brand: "Mantooq",
    tagline: "Thousands of audiobooks and podcasts in one app",
    team: "The Mantooq team",
  },
};

export interface EmailParts {
  subject: string;
  greeting: string;
  /** Body paragraphs as HTML, already escaped. */
  paragraphsHtml: string[];
  /** Body paragraphs as plain text. */
  paragraphsText: string[];
  /** The call to action; an email that only informs has none. */
  button?: { label: string; link: string };
  /** A plain link under the button, such as the terms beside the manage page. */
  link?: { label: string; link: string };
  note: string;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderEmail(lang: AuthEmailLang, parts: EmailParts): RenderedEmail {
  return {
    subject: parts.subject,
    html: renderHtml(lang, FRAME[lang], parts),
    text: renderText(FRAME[lang], parts),
  };
}

function renderHtml(lang: AuthEmailLang, t: FrameCopy, parts: EmailParts): string {
  const dir = lang === "ar" ? "rtl" : "ltr";
  const align = lang === "ar" ? "right" : "left";
  const intro = parts.paragraphsHtml
    .map((paragraph) => `<p style="margin:0;">${paragraph}</p>`)
    .join("\n        ");
  const button = parts.button
    ? `
    <tr>
      <td align="center" style="padding:18px 24px 6px;">
        <table role="presentation" cellpadding="0" cellspacing="0">
          <tr>
            <td style="border-radius:999px;background:${BRAND.button};">
              <a href="${escapeHtml(parts.button.link)}" style="display:inline-block;padding:13px 34px;color:#ffffff;font-size:16px;font-weight:700;text-decoration:none;border-radius:999px;">${escapeHtml(parts.button.label)}</a>
            </td>
          </tr>
        </table>
      </td>
    </tr>`
    : "";
  const link = parts.link
    ? `
    <tr>
      <td align="center" style="padding:8px 24px 0;font-size:14px;line-height:1.8;">
        <a href="${escapeHtml(parts.link.link)}" style="color:${BRAND.deepGreen};font-weight:700;">${escapeHtml(parts.link.label)}</a>
      </td>
    </tr>`
    : "";

  return `<!DOCTYPE html>
<html dir="${dir}" lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(parts.subject)}</title>
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
        <p style="margin:0 0 6px;font-size:18px;font-weight:700;">${escapeHtml(parts.greeting)}</p>
        ${intro}
      </td>
    </tr>${button}${link}
    <tr>
      <td dir="${dir}" style="padding:14px 24px 24px;color:${BRAND.muted};font-size:13px;line-height:1.8;text-align:${align};">
        ${escapeHtml(parts.note)}
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

function renderText(t: FrameCopy, parts: EmailParts): string {
  const lines = [
    parts.greeting,
    "",
    ...parts.paragraphsText,
    "",
    ...(parts.button ? [`${parts.button.label}:`, parts.button.link, ""] : []),
    ...(parts.link ? [`${parts.link.label}:`, parts.link.link, ""] : []),
    parts.note,
    "",
    `${t.team} · mantooq.com`,
  ];
  return lines.join("\n");
}
