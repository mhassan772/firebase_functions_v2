import { escapeHtml, RenderedEmail, renderEmail } from "./layout";

/**
 * The billing emails of web subscriptions, in Arabic and English.
 *
 * Plan names and terms follow the accounts pages (`accounts-page/src/i18n.ts`), and money and
 * dates are formatted as the pages format them, so an email never says something the manage
 * page puts differently. Stripe's own customer emails are off, so these are the only messages
 * a web subscriber gets.
 */

export type BillingLang = "ar" | "en";

export type BillingKind =
  | "purchase_confirmed"
  | "renewed"
  | "payment_failed"
  | "payment_failed_final"
  | "action_required"
  | "renewal_reminder"
  | "cancellation_confirmed"
  | "switched_yearly";

export interface BillingContent {
  plan?: string;
  /** Integer cents. */
  amount?: number;
  /** The credit for unused time (a plan switch, an upgrade to lifetime), a positive number. */
  credit?: number;
  /** An upgrade to lifetime: `web_monthly` or `web_yearly`, the plan credited and stopped. */
  creditedPlan?: string;
  tax?: number;
  total?: number;
  currency?: string;
  renewsAt?: Date;
  endsAt?: Date;
  graceEndsAt?: Date;
  cardExpiresFirst?: boolean;
  /** False for the Stripe sandbox: the subject then starts with `[TEST] `. */
  livemode: boolean;
}

/** A field the email needs is missing; the sender marks the email failed rather than send it. */
export class BillingEmailIncompleteError extends Error {
  constructor(readonly field: string) {
    super(`The billing email is missing ${field}.`);
    this.name = "BillingEmailIncompleteError";
  }
}

const LOCALE: Record<BillingLang, string> = { ar: "ar-u-nu-arab-ca-gregory", en: "en" };

/** US dollars as the pages write them: the number, then the currency's name in Arabic. */
const DOLLARS: Record<BillingLang, (amount: string) => string> = {
  ar: (amount) => `${amount} دولار`,
  en: (amount) => `$${amount}`,
};

/**
 * Integer cents as the pages show them, such as "$49.99" or "٤٩٫٩٩ دولار", so an email and the
 * page never write the same amount two ways. Another currency keeps the platform's format.
 */
export function formatMoney(amount: number, currency: string, lang: BillingLang): string {
  const code = currency.toUpperCase();
  if (code === "USD") {
    const number = new Intl.NumberFormat(LOCALE[lang], { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount / 100);
    return DOLLARS[lang](number);
  }
  return new Intl.NumberFormat(LOCALE[lang], { style: "currency", currency: code, minimumFractionDigits: 2 }).format(amount / 100);
}

/** A date with the day, the month's name and the year, in UTC, as the pages show it. */
export function formatDate(date: Date, lang: BillingLang): string {
  return new Intl.DateTimeFormat(LOCALE[lang], { dateStyle: "long", timeZone: "UTC" }).format(date);
}

export function manageLink(lang: BillingLang): string {
  return `https://accounts.mantooq.com/manage?lang=${lang}`;
}

interface Copy {
  greeting: string;
  planName: Record<string, string>;
  /** "your monthly subscription" and the like. */
  subscriptionOf: Record<string, string>;
  labels: { plan: string; price: string; tax: string; total: string; renews: string; paid: string };
  manageButton: string;
  replaceCardButton: string;
  verifyButton: string;
  notYou: string;
  openApp: string;
  noRefunds: string;
  whereToCancel: string;
  kinds: {
    purchase_confirmed: {
      subject: string;
      thanksSubscription: string;
      thanksLifetime: string;
      renewsUntilCancelled: string;
      lifetimeTerms: string;
      /** The upgrade's credit line, by the plan credited. */
      credit: Record<string, string>;
      /** The upgrade's subscription, by its plan, has stopped. */
      stopped: Record<string, string>;
    };
    renewed: { subject: string; body: (subscription: string) => string };
    payment_failed: { subject: string; body: string; until: (date: string) => string; replace: string; retries: string; note: string };
    payment_failed_final: { subject: string; body: string; stops: (date: string) => string; replace: string; note: string };
    action_required: { subject: string; body: string; how: string; stops: (date: string) => string; note: string };
    renewal_reminder: { subject: (date: string) => string; body: (date: string, amount: string) => string; cancel: string; cardExpires: string };
    cancellation_confirmed: { subject: string; body: string; until: (date: string) => string; resume: string; note: string };
    switched_yearly: { subject: string; body: string; yearlyPrice: string; credit: string; renewsEveryYear: string };
  };
}

const COPY: Record<BillingLang, Copy> = {
  ar: {
    greeting: "السلام عليكم،",
    planName: { web_monthly: "شهري", web_yearly: "سنوي", web_lifetime: "مدى الحياة" },
    subscriptionOf: { web_monthly: "اشتراكك الشهري", web_yearly: "اشتراكك السنوي" },
    labels: { plan: "الخطة:", price: "السعر:", tax: "الضريبة:", total: "الإجمالي:", renews: "التجديد القادم:", paid: "المبلغ المدفوع:" },
    manageButton: "إدارة اشتراكك",
    replaceCardButton: "غيّر البطاقة",
    verifyButton: "أكمل التحقق",
    notYou: "إن لم تكن أنت من دفع هذا المبلغ، فردّ على هذه الرسالة وسنساعدك.",
    openApp: "افتح تطبيق منطوق على هاتفك، بالإصدار 90.7 أو أحدث، وأنت مسجّل الدخول بهذا الحساب نفسه.",
    noRefunds: "لا تُسترد المبالغ المدفوعة.",
    whereToCancel: "يمكنك إلغاء التجديد في أي وقت من صفحة إدارة الاشتراك، ويبقى بريميوم مفعّلًا حتى نهاية المدة المدفوعة.",
    kinds: {
      purchase_confirmed: {
        subject: "تم تفعيل منطوق بريميوم",
        thanksSubscription: "شكرًا لاشتراكك. فُعّل بريميوم لحسابك في منطوق.",
        thanksLifetime: "شكرًا لشرائك. فُعّل بريميوم مدى الحياة لحسابك في منطوق.",
        renewsUntilCancelled: "يتجدد الاشتراك تلقائيًا حتى تلغيه.",
        lifetimeTerms: "هذه دفعة واحدة، دون تجديد. «مدى الحياة» تعني ٥٠ سنة، أو طوال مدة تقديم الخدمة إن كانت أقصر.",
        credit: {
          web_monthly: "خصم المدة غير المستخدمة من اشتراكك الشهري:",
          web_yearly: "خصم المدة غير المستخدمة من اشتراكك السنوي:",
        },
        stopped: {
          web_monthly: "توقف اشتراكك الشهري، ولن يتجدد ولن يُخصم منه شيء بعد اليوم.",
          web_yearly: "توقف اشتراكك السنوي، ولن يتجدد ولن يُخصم منه شيء بعد اليوم.",
        },
      },
      renewed: {
        subject: "تجدّد اشتراكك في منطوق بريميوم",
        body: (subscription) => `تجدّد ${subscription} في منطوق، ويستمر بريميوم مفعّلًا.`,
      },
      payment_failed: {
        subject: "تعذّر تجديد اشتراكك في منطوق",
        body: "لم تنجح عملية الدفع لتجديد اشتراكك.",
        until: (date) => `يبقى بريميوم مفعّلًا حتى ${date}.`,
        replace: "غيّر البطاقة من صفحة إدارة الاشتراك ليُسدَّد المبلغ الآن.",
        retries: "سنحاول الدفع بالبطاقة الحالية مرة أخرى تلقائيًا خلال هذه المدة.",
        note: "إن غيّرت البطاقة بالفعل، فتجاهل هذه الرسالة.",
      },
      payment_failed_final: {
        subject: "سيتوقف بريميوم قريبًا",
        body: "لم نتمكن بعدُ من تجديد اشتراكك.",
        stops: (date) => `سيتوقف بريميوم في ${date} إن لم تغيّر البطاقة.`,
        replace: "غيّر البطاقة من صفحة إدارة الاشتراك ليستمر بريميوم دون انقطاع.",
        note: "إن غيّرت البطاقة بالفعل، فتجاهل هذه الرسالة.",
      },
      action_required: {
        subject: "مصرفك يطلب تأكيد دفعة التجديد",
        body: "يطلب مصرفك أن تؤكد دفعة تجديد اشتراكك قبل خصمها.",
        how: "أكمل التحقق من صفحة إدارة الاشتراك.",
        stops: (date) => `إن لم تكمله، يتوقف بريميوم في ${date}.`,
        note: "إن أكملت التحقق بالفعل، فتجاهل هذه الرسالة.",
      },
      renewal_reminder: {
        subject: (date) => `يتجدد اشتراكك السنوي في ${date}`,
        body: (date, amount) => `يتجدد اشتراكك السنوي في منطوق تلقائيًا في ${date} بمبلغ ${amount}.`,
        cancel: "إن لم ترغب في التجديد، فألغِه من صفحة إدارة الاشتراك قبل هذا التاريخ، ولن يُخصم منك شيء.",
        cardExpires: "تنتهي صلاحية بطاقتك المحفوظة قبل هذا التاريخ. غيّرها من صفحة إدارة الاشتراك حتى ينجح التجديد.",
      },
      cancellation_confirmed: {
        subject: "أُلغي اشتراكك في منطوق",
        body: "أُلغي اشتراكك، ولن يتجدد.",
        until: (date) => `يبقى بريميوم مفعّلًا حتى ${date}، ثم يتوقف.`,
        resume: "يمكنك استئناف التجديد قبل ذلك من صفحة إدارة الاشتراك.",
        note: "إن لم تكن أنت من ألغى الاشتراك، فردّ على هذه الرسالة.",
      },
      switched_yearly: {
        subject: "أصبح اشتراكك في منطوق بريميوم سنويًا",
        body: "حوّلت اشتراكك إلى الاشتراك السنوي، ويستمر بريميوم مفعّلًا دون انقطاع. تبدأ السنة من يوم التحويل.",
        yearlyPrice: "السعر السنوي:",
        credit: "خصم الأيام المتبقية من الاشتراك الشهري:",
        renewsEveryYear: "يتجدد الاشتراك تلقائيًا كل سنة بالسعر السنوي حتى تلغيه.",
      },
    },
  },
  en: {
    greeting: "Assalamu alaikum,",
    planName: { web_monthly: "Monthly", web_yearly: "Yearly", web_lifetime: "Lifetime" },
    subscriptionOf: { web_monthly: "Your monthly subscription", web_yearly: "Your yearly subscription" },
    labels: { plan: "Plan:", price: "Price:", tax: "Tax:", total: "Total:", renews: "Next renewal:", paid: "Amount paid:" },
    manageButton: "Manage your subscription",
    replaceCardButton: "Replace card",
    verifyButton: "Complete verification",
    notYou: "If you didn't make this payment, reply to this email and we'll help.",
    openApp: "Open the Mantooq app on your phone, version 90.7 or later, signed in with this same account.",
    noRefunds: "Payments are not refundable.",
    whereToCancel: "You can cancel the renewal at any time on the manage page, and Premium stays on until the end of the paid period.",
    kinds: {
      purchase_confirmed: {
        subject: "Mantooq Premium is on",
        thanksSubscription: "Thank you for subscribing. Premium is now on for your Mantooq account.",
        thanksLifetime: "Thank you for your purchase. Premium is now on for your Mantooq account, for life.",
        renewsUntilCancelled: "Your subscription renews automatically until you cancel.",
        lifetimeTerms: "This is one payment, with no renewals. Lifetime means 50 years, or for as long as the service runs if that is shorter.",
        credit: {
          web_monthly: "Credit for the unused time of your monthly plan:",
          web_yearly: "Credit for the unused time of your yearly plan:",
        },
        stopped: {
          web_monthly: "Your monthly subscription has stopped. It won't renew, and nothing more is charged for it.",
          web_yearly: "Your yearly subscription has stopped. It won't renew, and nothing more is charged for it.",
        },
      },
      renewed: {
        subject: "Your Mantooq Premium subscription renewed",
        body: (subscription) => `${subscription} to Mantooq renewed, and Premium stays on.`,
      },
      payment_failed: {
        subject: "We couldn't renew your Mantooq subscription",
        body: "The payment to renew your subscription didn't go through.",
        until: (date) => `Premium stays on until ${date}.`,
        replace: "Replace the card on the manage page to pay the amount now.",
        retries: "We'll also try your current card again automatically during this time.",
        note: "If you've already replaced the card, ignore this email.",
      },
      payment_failed_final: {
        subject: "Premium stops soon",
        body: "We still couldn't renew your subscription.",
        stops: (date) => `Premium stops on ${date} unless you replace the card.`,
        replace: "Replace the card on the manage page to keep Premium without a break.",
        note: "If you've already replaced the card, ignore this email.",
      },
      action_required: {
        subject: "Your bank wants you to confirm the renewal payment",
        body: "Your bank wants you to confirm the payment that renews your subscription before it's taken.",
        how: "Complete the verification on the manage page.",
        stops: (date) => `If you don't, Premium stops on ${date}.`,
        note: "If you've already completed the verification, ignore this email.",
      },
      renewal_reminder: {
        subject: (date) => `Your yearly subscription renews on ${date}`,
        body: (date, amount) => `Your yearly Mantooq subscription renews automatically on ${date} for ${amount}.`,
        cancel: "If you don't want it to renew, cancel it on the manage page before that date and you won't be charged.",
        cardExpires: "Your saved card expires before that date. Replace it on the manage page so the renewal goes through.",
      },
      cancellation_confirmed: {
        subject: "Your Mantooq subscription is cancelled",
        body: "Your subscription is cancelled and won't renew.",
        until: (date) => `Premium stays on until ${date}, then stops.`,
        resume: "You can resume the renewal before then on the manage page.",
        note: "If you didn't cancel it, reply to this email.",
      },
      switched_yearly: {
        subject: "Your Mantooq Premium subscription is now yearly",
        body: "You switched your subscription to the yearly plan, and Premium stays on without a break. The year starts on the day you switched.",
        yearlyPrice: "Yearly price:",
        credit: "Credit for the unused days of your monthly plan:",
        renewsEveryYear: "Your subscription renews automatically every year at the yearly price until you cancel.",
      },
    },
  },
};

function need<T>(value: T | undefined, field: string): T {
  if (value === undefined || value === null) throw new BillingEmailIncompleteError(field);
  return value;
}

interface Body {
  subject: string;
  paragraphs: string[];
  /** Label-and-value lines shown as one block, such as the price breakdown. */
  details?: string[];
  button: string;
  note: string;
}

function body(kind: BillingKind, lang: BillingLang, content: BillingContent): Body {
  const t = COPY[lang];
  const money = (cents: number | undefined, field: string) => formatMoney(need(cents, field), need(content.currency, "currency"), lang);
  const date = (value: Date | undefined, field: string) => formatDate(need(value, field), lang);
  const plan = need(content.plan, "plan");
  const planName = need(t.planName[plan], "plan");
  switch (kind) {
    case "purchase_confirmed": {
      const k = t.kinds.purchase_confirmed;
      const lifetime = plan === "web_lifetime";
      const details = [`${t.labels.plan} ${planName}`, `${t.labels.price} ${money(content.amount, "amount")}`];
      // An upgrade from a subscription: its credit, under a label that says it is taken off, so
      // with no minus sign, and the plan stopped.
      const upgrade = lifetime && content.creditedPlan ? need(k.stopped[content.creditedPlan], "creditedPlan") : null;
      if (upgrade && content.credit) {
        details.push(`${k.credit[content.creditedPlan!]} ${money(content.credit, "credit")}`);
      }
      if (content.tax) details.push(`${t.labels.tax} ${money(content.tax, "tax")}`);
      details.push(`${t.labels.total} ${money(content.total, "total")}`);
      if (!lifetime) details.push(`${t.labels.renews} ${date(content.renewsAt, "renewsAt")}`);
      return {
        subject: k.subject,
        paragraphs: lifetime
          ? [k.thanksLifetime, ...(upgrade ? [upgrade] : []), k.lifetimeTerms, t.openApp, t.noRefunds]
          : [k.thanksSubscription, k.renewsUntilCancelled, t.openApp, `${t.noRefunds} ${t.whereToCancel}`],
        details,
        button: t.manageButton,
        note: t.notYou,
      };
    }
    case "renewed": {
      const k = t.kinds.renewed;
      return {
        subject: k.subject,
        paragraphs: [k.body(need(t.subscriptionOf[plan], "plan")), `${t.noRefunds} ${t.whereToCancel}`],
        details: [`${t.labels.paid} ${money(content.amount, "amount")}`, `${t.labels.renews} ${date(content.renewsAt, "renewsAt")}`],
        button: t.manageButton,
        note: t.notYou,
      };
    }
    case "payment_failed": {
      const k = t.kinds.payment_failed;
      return {
        subject: k.subject,
        paragraphs: [k.body, k.until(date(content.graceEndsAt, "graceEndsAt")), k.replace, k.retries],
        button: t.replaceCardButton,
        note: k.note,
      };
    }
    case "payment_failed_final": {
      const k = t.kinds.payment_failed_final;
      return {
        subject: k.subject,
        paragraphs: [k.body, k.stops(date(content.graceEndsAt, "graceEndsAt")), k.replace],
        button: t.replaceCardButton,
        note: k.note,
      };
    }
    case "action_required": {
      const k = t.kinds.action_required;
      return {
        subject: k.subject,
        paragraphs: [k.body, k.how, k.stops(date(content.graceEndsAt, "graceEndsAt"))],
        button: t.verifyButton,
        note: k.note,
      };
    }
    case "renewal_reminder": {
      const k = t.kinds.renewal_reminder;
      const when = date(content.renewsAt, "renewsAt");
      return {
        subject: k.subject(when),
        paragraphs: [
          k.body(when, money(content.total ?? content.amount, "amount")),
          k.cancel,
          ...(content.cardExpiresFirst ? [k.cardExpires] : []),
        ],
        button: content.cardExpiresFirst ? t.replaceCardButton : t.manageButton,
        note: t.notYou,
      };
    }
    case "cancellation_confirmed": {
      const k = t.kinds.cancellation_confirmed;
      return {
        subject: k.subject,
        paragraphs: [k.body, k.until(date(content.endsAt, "endsAt")), k.resume, t.noRefunds],
        button: t.manageButton,
        note: k.note,
      };
    }
    case "switched_yearly": {
      const k = t.kinds.switched_yearly;
      const details = [
        `${t.labels.plan} ${planName}`,
        `${k.yearlyPrice} ${money(content.amount, "amount")}`,
        // The label says the credit is taken off, so the amount carries no minus sign.
        `${k.credit} ${money(need(content.credit, "credit"), "credit")}`,
      ];
      if (content.tax) details.push(`${t.labels.tax} ${money(content.tax, "tax")}`);
      details.push(`${t.labels.paid} ${money(content.total, "total")}`, `${t.labels.renews} ${date(content.renewsAt, "renewsAt")}`);
      return {
        subject: k.subject,
        paragraphs: [k.body, k.renewsEveryYear, `${t.noRefunds} ${t.whereToCancel}`],
        details,
        button: t.manageButton,
        note: t.notYou,
      };
    }
  }
}

/**
 * Renders one billing email, or throws `BillingEmailIncompleteError` when a field it must state
 * is missing. Every email carries the manage page button.
 */
export function renderBillingEmail(kind: BillingKind, lang: BillingLang, content: BillingContent): RenderedEmail {
  const parts = body(kind, lang, content);
  const subject = content.livemode ? parts.subject : `[TEST] ${parts.subject}`;
  const detailsHtml = parts.details
    ? [`<span style="display:block;padding:10px 14px;background:#F3F9F6;border-radius:10px;">${parts.details.map(escapeHtml).join("<br>")}</span>`]
    : [];
  const [first, ...rest] = parts.paragraphs;
  return renderEmail(lang, {
    subject,
    greeting: COPY[lang].greeting,
    paragraphsHtml: [escapeHtml(first), ...detailsHtml, ...rest.map(escapeHtml)],
    paragraphsText: [first, ...(parts.details ? ["", ...parts.details, ""] : []), ...rest],
    button: { label: parts.button, link: manageLink(lang) },
    note: parts.note,
  });
}
