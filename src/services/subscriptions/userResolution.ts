import { admin } from "../../config/admin";
import { sha256Hex } from "./crypto";
import { SubscriptionError } from "./errors";

const AUTH_PAGE_SIZE = 1000;
const HEX_HASH = /^[0-9a-f]{64}$/;
const RAW_UID = /^[A-Za-z0-9]{20,36}$/;

export interface ResolveUserInput {
  uid?: string;
  email?: string;
  /**
   * The hashed id the user pasted to support, when they did. It never finds an
   * account on its own; it only confirms that the account found by uid or
   * email is the one the user meant.
   */
  hashedId?: string;
}

export interface ResolvedUser {
  uid: string;
  email?: string;
  displayName?: string;
  hashedId: string;
  resolvedBy: "uid" | "email";
  /** True when a pasted hashed id was supplied and matched the account. */
  hashConfirmed: boolean;
}

export function isHexHash(value: string): boolean {
  return HEX_HASH.test(value);
}

export function looksLikeRawUid(value: string): boolean {
  return RAW_UID.test(value) && !HEX_HASH.test(value);
}

/** Finds an account by uid or email in Firebase Auth, and checks a pasted hash against it when given. */
export async function resolveUser(input: ResolveUserInput): Promise<ResolvedUser> {
  const uid = input.uid?.trim();
  const email = input.email?.trim();
  const hashedId = input.hashedId?.trim().toLowerCase();
  if (hashedId !== undefined && !isHexHash(hashedId)) {
    throw new SubscriptionError(
      "invalid-input",
      "hashed-id-invalid",
      "The hashed id must be 64 hexadecimal characters."
    );
  }

  let record;
  let resolvedBy: ResolvedUser["resolvedBy"];
  if (uid) {
    record = await getAuthUser(uid);
    resolvedBy = "uid";
  } else if (email) {
    try {
      record = await admin.auth().getUserByEmail(email);
    } catch (error) {
      throw notFound(error, "email-not-found", "No account has that email.");
    }
    resolvedBy = "email";
  } else {
    throw new SubscriptionError(
      "invalid-input",
      "user-reference-missing",
      "Provide a uid or an email."
    );
  }

  const actualHash = sha256Hex(record.uid);
  if (hashedId !== undefined && hashedId !== actualHash) {
    throw new SubscriptionError(
      "precondition",
      "hashed-id-mismatch",
      "The account found does not match the hashed id the user sent."
    );
  }
  return {
    uid: record.uid,
    email: record.email,
    displayName: record.displayName,
    hashedId: actualHash,
    resolvedBy,
    hashConfirmed: hashedId !== undefined,
  };
}

export async function getAuthUser(uid: string) {
  try {
    return await admin.auth().getUser(uid);
  } catch (error) {
    throw notFound(error, "uid-not-found", "No account has that uid.");
  }
}

function notFound(error: unknown, code: string, message: string): SubscriptionError {
  const authCode = (error as { code?: string } | undefined)?.code;
  if (authCode === "auth/user-not-found") {
    return new SubscriptionError("not-found", code, message);
  }
  return new SubscriptionError(
    "internal",
    "auth-lookup-failed",
    "Looking the account up failed."
  );
}

/**
 * Pages through every Auth user, hashing each uid, until all wanted hashes are
 * found or the users run out. Used only by the legacy migration planner, whose
 * documents carry no uid; nothing is written and nothing is cached.
 */
export async function scanAuthForHashes(wanted: Set<string>): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  let pageToken: string | undefined;
  do {
    const page = await admin.auth().listUsers(AUTH_PAGE_SIZE, pageToken);
    for (const user of page.users) {
      const hash = sha256Hex(user.uid);
      if (wanted.has(hash) && !found.has(hash)) {
        found.set(hash, user.uid);
      }
    }
    pageToken = page.pageToken;
  } while (pageToken && found.size < wanted.size);
  return found;
}
