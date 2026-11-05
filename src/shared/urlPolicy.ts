/**
 * The audio URL allowance policy: who may be issued how many new books a day.
 *
 * Shared by the Firebase `getUrls` function and the Cloudflare Worker, so both issuers take the
 * same decision from the same ledger. Pure: no I/O, no runtime-specific imports, times in epoch
 * milliseconds. Each runtime reads the ledger documents, calls [decideGrants] inside a Firestore
 * transaction and writes what it returns.
 */

export type Tier = "guest" | "newAccount" | "free" | "premium";
export type GrantKind = "books" | "samples";
export type GrantReason = "stream" | "download" | "sample";

export interface Allowance {
  books: number;
  samples: number;
}

export type AllowanceTable = Record<Tier, Allowance>;

export interface UrlPolicy {
  /** Requests from builds below it get the policy-free response; 0 applies it to every build. */
  minBuild: number;
  /** When false the ledger is kept but nothing is refused. */
  enforce: boolean;
  /** When false every request gets the attested numbers. */
  appCheckTier: boolean;
  newAccountDays: number;
  maxBooksPerRequest: number;
  linkTtlHours: number;
  /** Written into each signed link as `k`, so a secret can rotate alongside its version. */
  keyVersion: string;
  attested: AllowanceTable;
  unattested: AllowanceTable;
}

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Entries a recent list keeps while `enforce` is off, so a scraper cannot grow the document. */
const RECENT_LIST_CAP = 500;

export const DEFAULT_URL_POLICY: UrlPolicy = {
  minBuild: 0,
  enforce: false,
  appCheckTier: true,
  newAccountDays: 10,
  maxBooksPerRequest: 40,
  linkTtlHours: 168,
  keyVersion: "1",
  attested: {
    guest: { books: 2, samples: 5 },
    newAccount: { books: 5, samples: 5 },
    free: { books: 10, samples: 10 },
    premium: { books: 50, samples: 50 },
  },
  unattested: {
    guest: { books: 1, samples: 2 },
    newAccount: { books: 2, samples: 2 },
    free: { books: 5, samples: 5 },
    premium: { books: 25, samples: 25 },
  },
};

/**
 * Reads the `urlPolicy` block of `settings/mantooqAppSettings`.
 *
 * Returns null when there is no block, which means the policy is off. Missing fields inside a
 * block take the defaults above, so the block can stay short.
 */
export function parseUrlPolicy(raw: unknown): UrlPolicy | null {
  if (!raw || typeof raw !== "object") return null;
  const block = raw as Record<string, unknown>;
  return {
    minBuild: numberOr(block.minBuild, DEFAULT_URL_POLICY.minBuild),
    enforce: block.enforce === true,
    appCheckTier: block.appCheckTier !== false,
    newAccountDays: numberOr(block.newAccountDays, DEFAULT_URL_POLICY.newAccountDays),
    maxBooksPerRequest: numberOr(block.maxBooksPerRequest, DEFAULT_URL_POLICY.maxBooksPerRequest),
    linkTtlHours: numberOr(block.linkTtlHours, DEFAULT_URL_POLICY.linkTtlHours),
    keyVersion:
      typeof block.keyVersion === "string" || typeof block.keyVersion === "number"
        ? String(block.keyVersion)
        : DEFAULT_URL_POLICY.keyVersion,
    attested: parseTable(block.attested, DEFAULT_URL_POLICY.attested),
    unattested: parseTable(block.unattested, DEFAULT_URL_POLICY.unattested),
  };
}

function parseTable(raw: unknown, defaults: AllowanceTable): AllowanceTable {
  const block = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const tier = (name: Tier): Allowance => {
    const entry = (block[name] && typeof block[name] === "object" ? block[name] : {}) as Record<
      string,
      unknown
    >;
    return {
      books: numberOr(entry.books, defaults[name].books),
      samples: numberOr(entry.samples, defaults[name].samples),
    };
  };
  return { guest: tier("guest"), newAccount: tier("newAccount"), free: tier("free"), premium: tier("premium") };
}

function numberOr(value: unknown, fallback: number): number {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Whether the request's build gets the policy; a request with no build number counts as 0. */
export function policyApplies(policy: UrlPolicy | null, buildNumber: unknown): boolean {
  if (!policy) return false;
  if (policy.minBuild <= 0) return true;
  const build = Number(buildNumber);
  return Number.isFinite(build) && build >= policy.minBuild;
}

export interface RequestIdentity {
  anonymous: boolean;
  /** Account creation time; null when unknown, which counts as an old account. */
  createdAtMs: number | null;
  premium: boolean;
  /** The request carried a valid App Check token. */
  attested: boolean;
}

/** Premium wins over age; a guest is anonymous whatever its age. */
export function tierFor(identity: RequestIdentity, policy: UrlPolicy, nowMs: number): Tier {
  if (identity.premium) return "premium";
  if (identity.anonymous) return "guest";
  if (
    identity.createdAtMs !== null &&
    nowMs - identity.createdAtMs < policy.newAccountDays * DAY_MS
  ) {
    return "newAccount";
  }
  return "free";
}

export function allowanceFor(
  identity: RequestIdentity,
  policy: UrlPolicy,
  nowMs: number
): { tier: Tier; attested: boolean; allowance: Allowance } {
  const tier = tierFor(identity, policy, nowMs);
  const attested = identity.attested || !policy.appCheckTier;
  const table = attested ? policy.attested : policy.unattested;
  return { tier, attested, allowance: table[tier] };
}

export interface RecentEntry {
  guid: string;
  /** Epoch milliseconds of the grant. */
  at: number;
}

/** What the ledger holds for one account, as read inside the transaction. */
export interface LedgerState {
  /** Books ever issued in full (stream or download). */
  knownBooks: ReadonlySet<string>;
  /** Books whose sample was issued. */
  knownSamples: ReadonlySet<string>;
  recentBooks: RecentEntry[];
  recentSamples: RecentEntry[];
}

/** The per-device lists guests share. */
export interface DeviceState {
  recentBooks: RecentEntry[];
  recentSamples: RecentEntry[];
}

export interface RequestedBook {
  guid: string;
  reason: GrantReason;
}

export interface BookDecision {
  guid: string;
  kind: GrantKind;
  granted: boolean;
  /** Granted because the account already had this book. */
  known: boolean;
  allowance: number;
  /** New books of this kind in the window after this decision. */
  used: number;
  /** Seconds until a slot frees; only on a refusal. */
  retryAfterSeconds?: number;
}

export interface NewLedgerEntry {
  guid: string;
  kind: GrantKind;
  reason: GrantReason;
}

export interface GrantResult {
  /** One decision per distinct guid, in request order. */
  decisions: BookDecision[];
  /** The recent lists to write back, pruned to the window. */
  ledger: { recentBooks: RecentEntry[]; recentSamples: RecentEntry[] };
  device: DeviceState | null;
  /** `books/{guid}` entries to create. */
  newEntries: NewLedgerEntry[];
  /** Guids that would have been refused with `enforce` on. */
  wouldRefuse: string[];
}

export interface DecideGrantsInput {
  books: RequestedBook[];
  ledger: LedgerState;
  /** Present for guests only. */
  device: DeviceState | null;
  allowance: Allowance;
  enforce: boolean;
  nowMs: number;
}

/**
 * Decides which requested books are issued.
 *
 * A book the account already has is granted first and costs nothing. New books are then taken
 * in request order until the window's allowance of that kind is spent; the rest are refused and
 * consume nothing. A sample grant never makes the full book known, but a full grant covers its
 * sample. Duplicate guids in one request collapse to the strongest reason.
 */
export function decideGrants(input: DecideGrantsInput): GrantResult {
  const { allowance, enforce, nowMs } = input;
  const windowStart = nowMs - DAY_MS;
  const prune = (entries: RecentEntry[]) =>
    entries.filter((entry) => entry.at > windowStart).sort((a, b) => a.at - b.at);

  const ledger = {
    recentBooks: prune(input.ledger.recentBooks),
    recentSamples: prune(input.ledger.recentSamples),
  };
  const device = input.device
    ? { recentBooks: prune(input.device.recentBooks), recentSamples: prune(input.device.recentSamples) }
    : null;

  const decisions: BookDecision[] = [];
  const newEntries: NewLedgerEntry[] = [];
  const wouldRefuse: string[] = [];
  const grantedNow = { books: new Set<string>(), samples: new Set<string>() };

  for (const requested of collapseDuplicates(input.books)) {
    const kind: GrantKind = requested.reason === "sample" ? "samples" : "books";
    const known =
      input.ledger.knownBooks.has(requested.guid) ||
      grantedNow.books.has(requested.guid) ||
      (kind === "samples" &&
        (input.ledger.knownSamples.has(requested.guid) || grantedNow.samples.has(requested.guid)));
    const limit = allowance[kind];
    const listKey = kind === "books" ? "recentBooks" : "recentSamples";
    const lists = [ledger[listKey], ...(device ? [device[listKey]] : [])];
    const used = Math.max(...lists.map((list) => list.length));

    if (known) {
      decisions.push({ guid: requested.guid, kind, granted: true, known: true, allowance: limit, used });
      continue;
    }

    const refused = used >= limit;
    if (refused) {
      wouldRefuse.push(requested.guid);
    }
    if (refused && enforce) {
      decisions.push({
        guid: requested.guid,
        kind,
        granted: false,
        known: false,
        allowance: limit,
        used,
        retryAfterSeconds: retryAfterSeconds(lists, limit, nowMs),
      });
      continue;
    }

    const entry = { guid: requested.guid, at: nowMs };
    for (const list of lists) {
      list.push(entry);
    }
    grantedNow[kind].add(requested.guid);
    newEntries.push({ guid: requested.guid, kind, reason: requested.reason });
    decisions.push({ guid: requested.guid, kind, granted: true, known: false, allowance: limit, used: used + 1 });
  }

  if (!enforce) {
    ledger.recentBooks = ledger.recentBooks.slice(-RECENT_LIST_CAP);
    ledger.recentSamples = ledger.recentSamples.slice(-RECENT_LIST_CAP);
    if (device) {
      device.recentBooks = device.recentBooks.slice(-RECENT_LIST_CAP);
      device.recentSamples = device.recentSamples.slice(-RECENT_LIST_CAP);
    }
  }

  return { decisions, ledger, device, newEntries, wouldRefuse };
}

/** Keeps one entry per guid, in first-seen order; a full request beats a sample. */
function collapseDuplicates(books: RequestedBook[]): RequestedBook[] {
  const byGuid = new Map<string, RequestedBook>();
  for (const book of books) {
    const existing = byGuid.get(book.guid);
    if (!existing) {
      byGuid.set(book.guid, book);
    } else if (existing.reason === "sample" && book.reason !== "sample") {
      byGuid.set(book.guid, { guid: book.guid, reason: book.reason });
    }
  }
  return [...byGuid.values()];
}

/**
 * Seconds until the count drops below [limit] in every binding list.
 *
 * A list of length L needs its L - limit + 1 oldest entries to leave the window; each list is
 * sorted by time, so that is the entry at index L - limit.
 */
function retryAfterSeconds(lists: RecentEntry[][], limit: number, nowMs: number): number {
  // An allowance of zero never frees a slot; the wait is the whole window.
  if (limit <= 0) return DAY_MS / 1000;
  let waitMs = 0;
  for (const list of lists) {
    if (list.length < limit) continue;
    const freeing = list[list.length - limit];
    if (freeing) waitMs = Math.max(waitMs, freeing.at + DAY_MS - nowMs);
  }
  return Math.max(60, Math.ceil(waitMs / 1000));
}

export interface BookRefusal {
  error: 609;
  retryAfterSeconds: number;
  allowance: number;
  used: number;
  kind: GrantKind;
}

export function refusalEntry(decision: BookDecision): BookRefusal {
  return {
    error: 609,
    retryAfterSeconds: decision.retryAfterSeconds ?? 60,
    allowance: decision.allowance,
    used: decision.used,
    kind: decision.kind,
  };
}

/** One line per request for the logs: counts only, no guids. */
export function summarizeGrants(result: GrantResult): {
  granted: number;
  known: number;
  refused: number;
  wouldRefuse: number;
} {
  const granted = result.decisions.filter((d) => d.granted).length;
  const known = result.decisions.filter((d) => d.known).length;
  return {
    granted,
    known,
    refused: result.decisions.length - granted,
    wouldRefuse: result.wouldRefuse.length,
  };
}
