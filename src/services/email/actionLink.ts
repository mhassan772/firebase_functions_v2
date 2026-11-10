import { ACCOUNTS_ACTION_URL } from "../../config/constants";

export type AuthEmailLang = "ar" | "en";

/** Modes the accounts page handles. */
export const ACTION_MODES = ["resetPassword", "verifyEmail", "verifyAndChangeEmail", "recoverEmail"] as const;
export type ActionMode = (typeof ACTION_MODES)[number];

/** Thrown when the Admin SDK hands back a link the accounts page could not open. */
export class ActionLinkError extends Error {
  constructor(readonly reason: "unparsable" | "missing_mode" | "missing_code" | "unexpected_mode") {
    super(`The generated action link is unusable (${reason}).`);
    this.name = "ActionLinkError";
  }
}

/** Anything other than "en" is Arabic, the app's only UI language today. */
export function readLang(value: unknown): AuthEmailLang {
  return value === "en" ? "en" : "ar";
}

/**
 * Moves an Admin SDK action link onto the accounts page.
 *
 * Only `mode` and `oobCode` are carried over. The `apiKey` and `continueUrl` Firebase adds are
 * dropped on purpose: the page uses its own fixed config.
 */
export function rewriteActionLink(adminLink: string, lang: AuthEmailLang, expectedMode?: ActionMode): string {
  let source: URL;
  try {
    source = new URL(adminLink);
  } catch {
    throw new ActionLinkError("unparsable");
  }
  const mode = source.searchParams.get("mode");
  const oobCode = source.searchParams.get("oobCode");
  if (!mode) throw new ActionLinkError("missing_mode");
  if (!oobCode) throw new ActionLinkError("missing_code");
  if (!(ACTION_MODES as readonly string[]).includes(mode) || (expectedMode && mode !== expectedMode)) {
    throw new ActionLinkError("unexpected_mode");
  }

  const target = new URL(ACCOUNTS_ACTION_URL);
  target.searchParams.set("mode", mode);
  target.searchParams.set("oobCode", oobCode);
  target.searchParams.set("lang", lang);
  return target.toString();
}
