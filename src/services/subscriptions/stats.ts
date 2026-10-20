import * as functions from "firebase-functions";
import { DocumentData, FieldPath, QuerySnapshot } from "firebase-admin/firestore";
import { admin } from "../../config/admin";
import { MANUAL_GRANT_TIME_ZONE } from "../../config/constants";
import { ManualGrant, ManualGrantSource } from "../../types/subscriptions";
import {
  WallDate,
  endOfWallDay,
  grantsFromData,
  isLegacyGrant,
  replayGrants,
  wallDateIn,
} from "./manual";
import {
  MANUAL_SLOT,
  STATE_SLOTS,
  SUBSCRIPTION_EVENT_COLLECTION,
  SUBSCRIPTION_MASTER_COLLECTION,
  SUBSCRIPTION_STATE_COLLECTION,
  timestampDate,
} from "./persistence";

// ---------------------------------------------------------------------------
// Contract
//
// Mirrors `src/lib/subscriptionStatsTypes.ts` in the admin portal
// (Mantooq_admin_web_v2), which reads `subscription_stats/current` straight from
// Firestore. Change both together; the field definitions live in that file.
// ---------------------------------------------------------------------------

export const SUBSCRIPTION_STATS_COLLECTION = "subscription_stats";
export const SUBSCRIPTION_STATS_DOC_ID = "current";
export const SUBSCRIPTION_STATS_SCHEMA_VERSION = 1;
/** Exact end-of-day totals, one document per Cairo day, id `YYYY-MM-DD`. */
export const SUBSCRIPTION_STATS_DAILY_COLLECTION = "subscription_stats_daily";
export const EGYPT_QUEUE_COLLECTION = "subscriptions_to_be_approved";
export const MIGRATION_QUEUE_COLLECTION = "subscription_migration_restoration";
export const STATS_DAILY_DAYS = 90;
export const STATS_MONTHLY_MONTHS = 24;

export type ManualGrantSourceKey = ManualGrantSource | "unknown";

export interface ActiveBySource {
  total: number;
  apple: number;
  google: number;
  manual: number;
}

export interface SubscriptionStatsSummary {
  active: ActiveBySource & { manualBySource: Record<ManualGrantSourceKey, number> };
  activeMultiSource: number;
  activeChange30d: number | null;
  newToday: number;
  newThisMonth: number;
  newLastMonth: number;
  expiring7d: number;
  expiring30d: number;
  expiring7dNotRenewing: number;
  pendingRequests: { egypt: number; migration: number };
  revenueThisMonthEgp: number;
  revenueLastMonthEgp: number;
  revenueByMethodThisMonth: Record<string, number>;
  medianHoursToApproval30d: number | null;
}

export interface PeriodCounts {
  new: number;
  renewals: number;
  expirations: number;
  refunds: number;
  requestsReceived: number;
  requestsApproved: number;
  requestsRejected: number;
  manualGrants: number;
  revenueEgp: number;
  revenueByMethod: Record<string, number>;
}

export interface DailyStatsPoint extends PeriodCounts {
  date: string;
  active: ActiveBySource;
  estimated: boolean;
}

export interface MonthlyStatsPoint extends PeriodCounts {
  month: string;
}

export interface SubscriptionStatsDocument {
  schemaVersion: number;
  generatedAt: string;
  timeZone: typeof MANUAL_GRANT_TIME_ZONE;
  today: string;
  summary: SubscriptionStatsSummary;
  daily: DailyStatsPoint[];
  monthly: MonthlyStatsPoint[];
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

const RENEWAL_EVENTS = new Set(["DID_RENEW", "SUBSCRIPTION_RENEWED"]);
const EXPIRY_EVENTS = new Set(["EXPIRED", "SUBSCRIPTION_EXPIRED"]);
const REFUND_EVENTS = new Set(["REFUND", "SUBSCRIPTION_REVOKED", "VOIDED_PURCHASE"]);
/** Store statuses that still entitle the user until `expiresAt`. */
const ENTITLED_STATUSES = new Set(["active", "canceled", "grace_period"]);
const MANUAL_SOURCE_KEYS: ManualGrantSourceKey[] = [
  "egypt_request",
  "migration_restoration",
  "admin_manual_add",
  "legacy_import",
  "unknown",
];
const UNKNOWN_METHOD = "unknown";
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** One Firestore document as the computation needs it; `updateTime` is the last write. */
export interface StatsSourceDocument {
  id: string;
  data: DocumentData;
  updateTime?: Date;
}

export interface StatsInput {
  masters: StatsSourceDocument[];
  /** Every `subscription_store_state` document, store and manual slots alike. */
  slots: StatsSourceDocument[];
  events: StatsSourceDocument[];
  egyptRequests: StatsSourceDocument[];
  migrationRequests: StatsSourceDocument[];
  /** `subscription_stats_daily` rows already written, at least those in the daily window. */
  archive: StatsSourceDocument[];
}

export interface StatsResult {
  document: SubscriptionStatsDocument;
  /** Archive rows to write: today, yesterday, and every window day that has no row yet. */
  archiveRows: DailyStatsPoint[];
}

type Platform = "apple" | "google" | "manual";

/** One production source of one user, as far back as the records reach. */
interface SourceSpan {
  platform: Platform;
  /** Undefined when the source began before any record the backend keeps. */
  start?: Date;
  expiresAt: Date;
}

interface UserTimeline {
  /** True when some production source predates the records, so the user is never "new". */
  startedBeforeRecords: boolean;
  firstStart?: Date;
  spans: SourceSpan[];
}

interface QueueRequest {
  collection: string;
  id: string;
  uid?: string;
  status?: string;
  createdAt?: Date;
  updateTime?: Date;
  amountPaid?: number;
  paymentMethod?: string;
}

/**
 * Builds the dashboard document from the raw collections. Pure: `now` is the
 * only clock, so the same input always gives the same document.
 *
 * Days and months are Cairo calendar days. Only production data counts.
 *
 * - Active (summary and today's point): the master's `active` is true, its
 *   `expiresAt` is after `now` (the stored flag can be stale) and its
 *   `environment` is production. The split follows the master's `platform`,
 *   and manual is split again by `manual.grantSource`.
 * - New on day D: the user's first production start falls on D. A start is
 *   the `createdAt` of a production store slot, the `grantedAt` of a manual
 *   grant that was not reversed, or the approval of one of their requests.
 *   Store slots are created when the backend first verifies a purchase, so
 *   during the backend rollout (September to October 2026) a long-standing
 *   store subscriber shows up as new on the day their app first reported the
 *   purchase; the store keeps no earlier purchase date the backend can read.
 *   A source that predates the records makes the user never new: a legacy
 *   baseline whose old document carried no date (it is dated at the import),
 *   and a migration restoration, which restores an old-system subscription.
 * - Renewals, expirations and refunds: production store events by `eventType`
 *   and `eventAt`. Expirations also count manual access that ran out and was
 *   neither extended by a later grant nor covered by a store subscription at
 *   that moment; revoking access is not an expiration.
 * - Requests: both queues. Received is dated by `created_at`. Approval is
 *   dated by the grant that approved it (`grant.queue`); an approval from the
 *   old portal has no grant, so it takes the user's dated legacy baseline when
 *   that baseline followed it, otherwise the request's last write. Rejection
 *   writes no date of its own: it is dated by the reversed grant's
 *   `statusChangedAt` when there is one, otherwise by the request's last
 *   write (a later "reviewed" toggle moves that date).
 * - Manual grants: grants that were not reversed, by `grantedAt`, except a
 *   legacy baseline that carried no date.
 * - Revenue (EGP): approved Egypt requests by `amount_paid` and `created_at`,
 *   plus grants given without a request that carry `metadata.amountPaid`. The
 *   old portal copied a request's amount into the legacy document it wrote,
 *   so a legacy baseline whose user has an approved request of the same
 *   amount from before the baseline is that same payment and is not counted
 *   again. A legacy amount with no date is left out rather than dated at the
 *   import.
 * - Past active points come from the daily archive when a run recorded them.
 *   Otherwise they are estimated (`estimated: true`): a user counts on day D
 *   when one of their sources started on or before D and its last known
 *   expiry is after the end of D. Gaps between subscriptions are invisible to
 *   this, and store subscribers count only from their slot's `createdAt`, so
 *   estimates before the rollout undercount store subscribers.
 * - `activeChange30d` is null while the day 30 days back is an estimate, not
 *   only when the series has no value: the estimate is not comparable with
 *   the live total.
 */
export function computeStats(input: StatsInput, now: Date): StatsResult {
  const calendar = new CairoCalendar();
  const today = calendar.dayKey(now);
  const currentMonth = today.slice(0, 7);
  const counts = new PeriodTally(calendar);

  const manualSlots = new Map<string, { grants: ManualGrant[]; createdAt?: Date }>();
  const storeSlots: Array<{ uid: string; platform: Platform; createdAt?: Date; expiresAt: Date }> = [];
  for (const slot of input.slots) {
    const data = slot.data;
    const uid = typeof data.uid === "string" ? data.uid : undefined;
    if (!uid) {
      continue;
    }
    if (data.platform === MANUAL_SLOT.platform) {
      manualSlots.set(uid, {
        grants: grantsFromData(data.grants),
        createdAt: timestampDate(data.createdAt),
      });
      continue;
    }
    const expiresAt = timestampDate(data.expiresAt);
    if (isProductionStoreSlot(data) && expiresAt) {
      storeSlots.push({
        uid,
        platform: data.platform,
        createdAt: timestampDate(data.createdAt),
        expiresAt,
      });
    }
  }

  // Grants by the request they approved, and legacy baselines by user.
  const grantsByQueue = new Map<string, ManualGrant[]>();
  const datedBaselines = new Map<string, ManualGrant>();
  const undatedGrants = new Set<ManualGrant>();
  for (const [uid, slot] of manualSlots) {
    for (const grant of slot.grants) {
      if (grant.queue) {
        const key = queueKey(grant.queue.collection, grant.queue.id);
        grantsByQueue.set(key, [...(grantsByQueue.get(key) ?? []), grant]);
      }
      if (isLegacyGrant(grant)) {
        // The import dates a baseline whose document had no date at the
        // import itself, which is also when it created the slot.
        if (slot.createdAt && grant.grantedAt.getTime() === slot.createdAt.getTime()) {
          undatedGrants.add(grant);
        } else if (grant.status !== "reversed") {
          datedBaselines.set(uid, grant);
        }
      }
    }
  }

  const requests = [
    ...input.egyptRequests.map((row) => readRequest(EGYPT_QUEUE_COLLECTION, row)),
    ...input.migrationRequests.map((row) => readRequest(MIGRATION_QUEUE_COLLECTION, row)),
  ];
  const approvedByUser = new Map<string, QueueRequest[]>();
  for (const request of requests) {
    if (request.status === "approved" && request.uid) {
      approvedByUser.set(request.uid, [...(approvedByUser.get(request.uid) ?? []), request]);
    }
  }

  const timelines = new Map<string, UserTimeline>();
  const timeline = (uid: string): UserTimeline => {
    let found = timelines.get(uid);
    if (!found) {
      found = { startedBeforeRecords: false, spans: [] };
      timelines.set(uid, found);
    }
    return found;
  };
  const addStart = (uid: string, start: Date | undefined): void => {
    const entry = timeline(uid);
    if (!start) {
      entry.startedBeforeRecords = true;
    } else if (!entry.firstStart || start.getTime() < entry.firstStart.getTime()) {
      entry.firstStart = start;
    }
  };

  // Requests: received, approved, rejected, pending, approval times, revenue.
  const pending = { egypt: 0, migration: 0 };
  const approvalHours: number[] = [];
  const revenueRequests = new Map<string, QueueRequest[]>();
  for (const request of requests) {
    if (request.createdAt) {
      counts.add(request.createdAt, (period) => period.requestsReceived++);
    }
    if (request.status === "pending") {
      if (request.collection === EGYPT_QUEUE_COLLECTION) {
        pending.egypt++;
      } else {
        pending.migration++;
      }
      continue;
    }
    const linked = grantsByQueue.get(queueKey(request.collection, request.id)) ?? [];
    if (request.status === "approved") {
      const approvedAt = approvalDate(request, linked, datedBaselines, approvedByUser);
      if (approvedAt) {
        counts.add(approvedAt, (period) => period.requestsApproved++);
        if (request.createdAt && now.getTime() - approvedAt.getTime() <= 30 * DAY_MS) {
          approvalHours.push((approvedAt.getTime() - request.createdAt.getTime()) / HOUR_MS);
        }
      }
      if (request.uid && request.collection === MIGRATION_QUEUE_COLLECTION) {
        addStart(request.uid, undefined);
      } else if (request.uid && approvedAt) {
        addStart(request.uid, approvedAt);
      }
      if (
        request.collection === EGYPT_QUEUE_COLLECTION &&
        request.createdAt &&
        request.amountPaid !== undefined &&
        request.amountPaid > 0
      ) {
        counts.addRevenue(request.createdAt, request.amountPaid, request.paymentMethod);
        if (request.uid) {
          revenueRequests.set(request.uid, [...(revenueRequests.get(request.uid) ?? []), request]);
        }
      }
    } else if (request.status === "rejected") {
      const rejectedAt = rejectionDate(request, linked);
      if (rejectedAt) {
        counts.add(rejectedAt, (period) => period.requestsRejected++);
      }
    }
  }

  // Manual ledgers: starts, grants given, revenue without a request, spans.
  for (const [uid, slot] of manualSlots) {
    const given = slot.grants.filter((grant) => grant.status !== "reversed");
    for (const grant of given) {
      const undated = undatedGrants.has(grant);
      const predates = undated || grant.metadata.grantSource === "migration_restoration";
      addStart(uid, predates ? undefined : grant.grantedAt);
      if (!undated) {
        counts.add(grant.grantedAt, (period) => period.manualGrants++);
      }
      const amount = grant.metadata.amountPaid;
      if (grant.queue || amount === undefined || amount <= 0 || undated) {
        continue;
      }
      if (isLegacyGrant(grant) && claimMatchingRequest(revenueRequests.get(uid), grant)) {
        continue;
      }
      counts.addRevenue(grant.grantedAt, amount, grant.metadata.paymentMethod);
    }
    const expiresAt = manualLastExpiry(given);
    if (expiresAt) {
      const predates = given.some(
        (grant) =>
          undatedGrants.has(grant) || grant.metadata.grantSource === "migration_restoration"
      );
      const dated = given
        .filter((grant) => !undatedGrants.has(grant))
        .map((grant) => grant.grantedAt.getTime());
      timeline(uid).spans.push({
        platform: "manual",
        start: predates || dated.length === 0 ? undefined : new Date(Math.min(...dated)),
        expiresAt,
      });
    }
  }

  for (const slot of storeSlots) {
    // A slot always carries `createdAt`; one without it has no date to start from.
    addStart(slot.uid, slot.createdAt);
    timeline(slot.uid).spans.push({
      platform: slot.platform,
      start: slot.createdAt,
      expiresAt: slot.expiresAt,
    });
  }

  // Manual access that ran out with nothing to continue it.
  for (const [uid, slot] of manualSlots) {
    const storeSpans = (timelines.get(uid)?.spans ?? []).filter((span) => span.platform !== "manual");
    for (const lapse of manualLapses(slot.grants, now)) {
      const covered = storeSpans.some(
        (span) =>
          (!span.start || span.start.getTime() <= lapse.getTime()) &&
          span.expiresAt.getTime() > lapse.getTime()
      );
      if (!covered) {
        counts.add(lapse, (period) => period.expirations++);
      }
    }
  }

  for (const event of input.events) {
    const data = event.data;
    if (data.environment !== "production" || data.eventType === "TEST") {
      continue;
    }
    const eventAt = timestampDate(data.eventAt) ?? timestampDate(data.createdAt);
    if (!eventAt) {
      continue;
    }
    const type = String(data.eventType);
    if (RENEWAL_EVENTS.has(type)) {
      counts.add(eventAt, (period) => period.renewals++);
    } else if (EXPIRY_EVENTS.has(type)) {
      counts.add(eventAt, (period) => period.expirations++);
    } else if (REFUND_EVENTS.has(type)) {
      counts.add(eventAt, (period) => period.refunds++);
    }
  }

  for (const entry of timelines.values()) {
    if (!entry.startedBeforeRecords && entry.firstStart) {
      counts.add(entry.firstStart, (period) => period.new++);
    }
  }

  // Live totals from the master projection.
  const live = emptyActive();
  const manualBySource = Object.fromEntries(
    MANUAL_SOURCE_KEYS.map((key) => [key, 0])
  ) as Record<ManualGrantSourceKey, number>;
  let activeMultiSource = 0;
  let expiring7d = 0;
  let expiring30d = 0;
  let expiring7dNotRenewing = 0;
  for (const master of input.masters) {
    const data = master.data;
    const expiresAt = timestampDate(data.expiresAt);
    if (
      data.active !== true ||
      data.environment !== "production" ||
      !expiresAt ||
      expiresAt.getTime() <= now.getTime() ||
      !isPlatform(data.platform)
    ) {
      continue;
    }
    live.total++;
    live[data.platform as Platform]++;
    if (data.platform === "manual") {
      const source = data.manual?.grantSource;
      manualBySource[isManualSourceKey(source) ? source : "unknown"]++;
    }
    if (entitledSourceCount(data.sources, now) > 1) {
      activeMultiSource++;
    }
    const remaining = expiresAt.getTime() - now.getTime();
    if (remaining <= 30 * DAY_MS) {
      expiring30d++;
    }
    if (remaining <= 7 * DAY_MS) {
      expiring7d++;
      if (data.platform === "manual" || data.autoRenewing === false) {
        expiring7dNotRenewing++;
      }
    }
  }

  // Daily series: exact where a run recorded the day, estimated elsewhere.
  const recorded = new Map<string, ActiveBySource>();
  const archived = new Set<string>();
  for (const row of input.archive) {
    archived.add(row.id);
    const active = readActive(row.data.active);
    if (row.data.estimated === false && active) {
      recorded.set(row.id, active);
    }
  }
  const yesterday = calendar.addDays(today, -1);
  const daily: DailyStatsPoint[] = [];
  for (let offset = STATS_DAILY_DAYS - 1; offset >= 0; offset--) {
    const date = calendar.addDays(today, -offset);
    let active: ActiveBySource;
    let estimated = false;
    if (date === today) {
      active = { ...live };
    } else if (recorded.has(date)) {
      active = recorded.get(date)!;
    } else {
      active = estimateActive(timelines, calendar.endOfDay(date));
      estimated = true;
    }
    daily.push({ date, active, estimated, ...counts.day(date) });
  }

  const monthly: MonthlyStatsPoint[] = [];
  for (let offset = STATS_MONTHLY_MONTHS - 1; offset >= 0; offset--) {
    const month = calendar.addMonths(currentMonth, -offset);
    monthly.push({ month, ...counts.month(month) });
  }

  const thisMonth = monthly[monthly.length - 1];
  const lastMonth = monthly[monthly.length - 2];
  const thirtyDaysAgo = daily[daily.length - 31];
  const summary: SubscriptionStatsSummary = {
    active: { ...live, manualBySource },
    activeMultiSource,
    // An estimated point is not a total anyone recorded, and before the
    // archive fills the estimate undercounts store subscribers (see above),
    // so the change is only given against a recorded day.
    activeChange30d:
      thirtyDaysAgo && !thirtyDaysAgo.estimated ? live.total - thirtyDaysAgo.active.total : null,
    newToday: daily[daily.length - 1].new,
    newThisMonth: thisMonth.new,
    newLastMonth: lastMonth.new,
    expiring7d,
    expiring30d,
    expiring7dNotRenewing,
    pendingRequests: pending,
    revenueThisMonthEgp: thisMonth.revenueEgp,
    revenueLastMonthEgp: lastMonth.revenueEgp,
    revenueByMethodThisMonth: { ...thisMonth.revenueByMethod },
    medianHoursToApproval30d: median(approvalHours),
  };

  const archiveRows = daily.filter(
    (point) => point.date === today || point.date === yesterday || !archived.has(point.date)
  );

  return {
    document: {
      schemaVersion: SUBSCRIPTION_STATS_SCHEMA_VERSION,
      generatedAt: now.toISOString(),
      timeZone: MANUAL_GRANT_TIME_ZONE,
      today,
      summary,
      daily,
      monthly,
    },
    archiveRows,
  };
}

function isProductionStoreSlot(data: DocumentData): boolean {
  return STATE_SLOTS.some(
    (slot) =>
      slot.platform !== MANUAL_SLOT.platform &&
      slot.environment === "production" &&
      slot.platform === data.platform &&
      slot.environment === data.environment
  );
}

function isPlatform(value: unknown): value is Platform {
  return value === "apple" || value === "google" || value === "manual";
}

function isManualSourceKey(value: unknown): value is ManualGrantSourceKey {
  return MANUAL_SOURCE_KEYS.includes(value as ManualGrantSourceKey);
}

function queueKey(collection: string, id: string): string {
  return `${collection}/${id}`;
}

function readRequest(collection: string, row: StatsSourceDocument): QueueRequest {
  const data = row.data;
  return {
    collection,
    id: row.id,
    uid: typeof data.user_guid === "string" ? data.user_guid : undefined,
    status: typeof data.status === "string" ? data.status : undefined,
    createdAt: timestampDate(data.created_at),
    updateTime: row.updateTime,
    amountPaid:
      typeof data.amount_paid === "number" && Number.isFinite(data.amount_paid)
        ? data.amount_paid
        : undefined,
    paymentMethod: typeof data.payment_method === "string" ? data.payment_method : undefined,
  };
}

/** See `computeStats` for the order; never earlier than the request itself. */
function approvalDate(
  request: QueueRequest,
  linked: ManualGrant[],
  datedBaselines: Map<string, ManualGrant>,
  approvedByUser: Map<string, QueueRequest[]>
): Date | undefined {
  let approvedAt: Date | undefined;
  const byDate = [...linked].sort((left, right) => right.grantedAt.getTime() - left.grantedAt.getTime());
  const grant = byDate.find((candidate) => candidate.status === "active") ?? byDate[0];
  if (grant) {
    approvedAt = grant.grantedAt;
  } else {
    const baseline = request.uid ? datedBaselines.get(request.uid) : undefined;
    if (baseline && request.createdAt && baseline.grantedAt.getTime() >= request.createdAt.getTime()) {
      // The old portal rewrote the legacy document on every approval, so the
      // baseline dates only the user's latest approval before it.
      const latestBefore = (approvedByUser.get(request.uid!) ?? [])
        .filter(
          (candidate) =>
            candidate.createdAt &&
            candidate.createdAt.getTime() <= baseline.grantedAt.getTime()
        )
        .sort((left, right) => right.createdAt!.getTime() - left.createdAt!.getTime())[0];
      if (latestBefore === request) {
        approvedAt = baseline.grantedAt;
      }
    }
    approvedAt = approvedAt ?? request.updateTime ?? request.createdAt;
  }
  if (approvedAt && request.createdAt && approvedAt.getTime() < request.createdAt.getTime()) {
    return request.createdAt;
  }
  return approvedAt;
}

function rejectionDate(request: QueueRequest, linked: ManualGrant[]): Date | undefined {
  const reversed = linked
    .filter((grant) => grant.status === "reversed" && grant.statusChangedAt)
    .sort((left, right) => right.statusChangedAt!.getTime() - left.statusChangedAt!.getTime())[0];
  return reversed?.statusChangedAt ?? request.updateTime ?? request.createdAt;
}

/** Marks and returns the approved request a legacy amount was copied from, if any. */
function claimMatchingRequest(
  candidates: QueueRequest[] | undefined,
  grant: ManualGrant
): boolean {
  const index = (candidates ?? []).findIndex(
    (request) =>
      request.amountPaid === grant.metadata.amountPaid &&
      request.createdAt !== undefined &&
      request.createdAt.getTime() <= grant.grantedAt.getTime()
  );
  if (index < 0) {
    return false;
  }
  candidates!.splice(index, 1);
  return true;
}

/**
 * The last moment the ledger gave access. Revoked grants count until they
 * were revoked; reversed grants never existed.
 */
function manualLastExpiry(given: ManualGrant[]): Date | undefined {
  const active = replayGrants(given.filter((grant) => grant.status === "active")).expiresAt;
  const revokedAt = given
    .filter((grant) => grant.status === "revoked")
    .map((grant) => grant.statusChangedAt?.getTime() ?? grant.grantedAt.getTime());
  if (revokedAt.length === 0) {
    return active;
  }
  const untilRevoked = replayGrants(given.map((grant) => ({ ...grant, status: "active" as const })))
    .expiresAt;
  const revoked =
    untilRevoked && new Date(Math.min(untilRevoked.getTime(), Math.max(...revokedAt)));
  if (!active) {
    return revoked;
  }
  return revoked && revoked.getTime() > active.getTime() ? revoked : active;
}

/** Each moment, up to `now`, when the active grants' running end passed with no next grant yet. */
function manualLapses(grants: ManualGrant[], now: Date): Date[] {
  const active = grants
    .filter((grant) => grant.status === "active")
    .sort((left, right) => left.grantedAt.getTime() - right.grantedAt.getTime());
  const lapses: Date[] = [];
  for (let index = 0; index < active.length; index++) {
    const end = replayGrants(active.slice(0, index + 1)).expiresAt;
    const next = active[index + 1];
    if (!end || end.getTime() > now.getTime()) {
      continue;
    }
    if (!next || next.grantedAt.getTime() > end.getTime()) {
      lapses.push(end);
    }
  }
  return lapses;
}

function entitledSourceCount(sources: unknown, now: Date): number {
  if (!Array.isArray(sources)) {
    return 0;
  }
  return sources.filter((row: DocumentData) => {
    const expiresAt = timestampDate(row?.expiresAt);
    return (
      row?.environment === "production" &&
      ENTITLED_STATUSES.has(row.status) &&
      expiresAt !== undefined &&
      expiresAt.getTime() > now.getTime()
    );
  }).length;
}

/** Users covered at `instant`, each under the covering source that lasts longest. */
function estimateActive(timelines: Map<string, UserTimeline>, instant: Date): ActiveBySource {
  const active = emptyActive();
  for (const entry of timelines.values()) {
    let winner: SourceSpan | undefined;
    for (const span of entry.spans) {
      const started = !span.start || span.start.getTime() <= instant.getTime();
      if (started && span.expiresAt.getTime() > instant.getTime()) {
        if (!winner || span.expiresAt.getTime() > winner.expiresAt.getTime()) {
          winner = span;
        }
      }
    }
    if (winner) {
      active.total++;
      active[winner.platform]++;
    }
  }
  return active;
}

function readActive(value: unknown): ActiveBySource | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const fields = ["total", "apple", "google", "manual"] as const;
  if (!fields.every((field) => typeof record[field] === "number")) {
    return undefined;
  }
  return {
    total: record.total as number,
    apple: record.apple as number,
    google: record.google as number,
    manual: record.manual as number,
  };
}

function emptyActive(): ActiveBySource {
  return { total: 0, apple: 0, google: 0, manual: 0 };
}

function emptyCounts(): PeriodCounts {
  return {
    new: 0,
    renewals: 0,
    expirations: 0,
    refunds: 0,
    requestsReceived: 0,
    requestsApproved: 0,
    requestsRejected: 0,
    manualGrants: 0,
    revenueEgp: 0,
    revenueByMethod: {},
  };
}

/** Median rounded to a tenth, or null when there is nothing to take it of. */
function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const value =
    sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return Math.round(value * 10) / 10;
}

/** Counts per Cairo day and month, filled as the sources are walked. */
class PeriodTally {
  private readonly days = new Map<string, PeriodCounts>();
  private readonly months = new Map<string, PeriodCounts>();

  constructor(private readonly calendar: CairoCalendar) {}

  add(at: Date, change: (period: PeriodCounts) => void): void {
    const day = this.calendar.dayKey(at);
    change(this.bucket(this.days, day));
    change(this.bucket(this.months, day.slice(0, 7)));
  }

  addRevenue(at: Date, amount: number, method: string | undefined): void {
    const key = method && method.trim() ? method.trim() : UNKNOWN_METHOD;
    this.add(at, (period) => {
      period.revenueEgp += amount;
      period.revenueByMethod[key] = (period.revenueByMethod[key] ?? 0) + amount;
    });
  }

  day(key: string): PeriodCounts {
    return copyCounts(this.days.get(key));
  }

  month(key: string): PeriodCounts {
    return copyCounts(this.months.get(key));
  }

  private bucket(map: Map<string, PeriodCounts>, key: string): PeriodCounts {
    let found = map.get(key);
    if (!found) {
      found = emptyCounts();
      map.set(key, found);
    }
    return found;
  }
}

function copyCounts(counts: PeriodCounts | undefined): PeriodCounts {
  const source = counts ?? emptyCounts();
  return { ...source, revenueByMethod: { ...source.revenueByMethod } };
}

/** `YYYY-MM-DD` keys for Cairo days, with the end-of-day instants cached. */
class CairoCalendar {
  private readonly ends = new Map<string, Date>();

  dayKey(date: Date): string {
    return formatWall(wallDateIn(date, MANUAL_GRANT_TIME_ZONE));
  }

  addDays(key: string, days: number): string {
    const wall = parseWall(key);
    const shifted = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + days));
    return formatWall({
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
    });
  }

  addMonths(month: string, months: number): string {
    const [year, number] = month.split("-").map(Number);
    const shifted = new Date(Date.UTC(year, number - 1 + months, 1));
    return formatWall({
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: 1,
    }).slice(0, 7);
  }

  endOfDay(key: string): Date {
    let end = this.ends.get(key);
    if (!end) {
      end = endOfWallDay(parseWall(key), MANUAL_GRANT_TIME_ZONE);
      this.ends.set(key, end);
    }
    return end;
  }
}

function formatWall(wall: WallDate): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${wall.year}-${pad(wall.month)}-${pad(wall.day)}`;
}

function parseWall(key: string): WallDate {
  const [year, month, day] = key.split("-").map(Number);
  return { year, month, day };
}

// ---------------------------------------------------------------------------
// Firestore
// ---------------------------------------------------------------------------

/**
 * Reads everything the stats are computed from. Full scans: about 1,400
 * documents today, growing with subscribers; move to incremental counters if
 * `subscription_master` passes about 20k documents.
 */
export async function loadStatsInput(now: Date = new Date()): Promise<StatsInput> {
  const firestore = admin.firestore();
  const calendar = new CairoCalendar();
  const windowStart = calendar.addDays(calendar.dayKey(now), -(STATS_DAILY_DAYS - 1));
  const [masters, slots, events, egyptRequests, migrationRequests, archive] = await Promise.all([
    firestore.collection(SUBSCRIPTION_MASTER_COLLECTION).get(),
    firestore.collection(SUBSCRIPTION_STATE_COLLECTION).get(),
    firestore.collection(SUBSCRIPTION_EVENT_COLLECTION).get(),
    firestore.collection(EGYPT_QUEUE_COLLECTION).get(),
    firestore.collection(MIGRATION_QUEUE_COLLECTION).get(),
    firestore
      .collection(SUBSCRIPTION_STATS_DAILY_COLLECTION)
      .where(FieldPath.documentId(), ">=", windowStart)
      .get(),
  ]);
  return {
    masters: rows(masters),
    slots: rows(slots),
    events: rows(events),
    egyptRequests: rows(egyptRequests),
    migrationRequests: rows(migrationRequests),
    archive: rows(archive),
  };
}

function rows(snapshot: QuerySnapshot): StatsSourceDocument[] {
  return snapshot.docs.map((doc) => ({
    id: doc.id,
    data: doc.data(),
    updateTime: doc.updateTime?.toDate(),
  }));
}

export interface RefreshStatsResult {
  generatedAt: string;
  archiveRowsWritten: number;
}

/**
 * Recomputes `subscription_stats/current` and records today's and
 * yesterday's totals in the daily archive, plus any window day that has no
 * row yet. Run by the daily job and by the admin "Refresh now" action.
 */
export async function refreshSubscriptionStats(now: Date = new Date()): Promise<RefreshStatsResult> {
  const startedAt = Date.now();
  functions.logger.info("subscription_stats_refresh_start", { now: now.toISOString() });
  try {
    const input = await loadStatsInput(now);
    const { document, archiveRows } = computeStats(input, now);

    const firestore = admin.firestore();
    const batch = firestore.batch();
    batch.set(
      firestore.collection(SUBSCRIPTION_STATS_COLLECTION).doc(SUBSCRIPTION_STATS_DOC_ID),
      document
    );
    for (const row of archiveRows) {
      batch.set(firestore.collection(SUBSCRIPTION_STATS_DAILY_COLLECTION).doc(row.date), {
        ...row,
        generatedAt: document.generatedAt,
      });
    }
    await batch.commit();

    functions.logger.info("subscription_stats_refresh_success", {
      masters: input.masters.length,
      slots: input.slots.length,
      events: input.events.length,
      requests: input.egyptRequests.length + input.migrationRequests.length,
      archiveRowsRead: input.archive.length,
      archiveRowsWritten: archiveRows.length,
      activeTotal: document.summary.active.total,
      durationMs: Date.now() - startedAt,
    });
    return { generatedAt: document.generatedAt, archiveRowsWritten: archiveRows.length };
  } catch (error) {
    functions.logger.error("subscription_stats_refresh_failure", {
      detail: error instanceof Error ? error.message.slice(0, 200) : String(error),
      durationMs: Date.now() - startedAt,
    });
    throw error;
  }
}
