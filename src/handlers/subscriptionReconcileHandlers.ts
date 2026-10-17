import * as crypto from "crypto";
import {
  DocumentData,
  DocumentReference,
  FieldValue,
  Timestamp,
} from "firebase-admin/firestore";
import * as functions from "firebase-functions";
import { admin } from "../config/admin";
import {
  AcknowledgementPhaseSummary,
  runAcknowledgementPhase,
} from "../services/subscriptions/acknowledgements";
import {
  APPLE_HISTORY_START_TOO_EARLY_CODE,
  AppleStoreEnvironment,
  decodeAppleNotificationIdentity,
  getAppleHistoryApi,
} from "../services/subscriptions/apple";
import { sha256Reference } from "../services/subscriptions/crypto";
import { safeErrorCode, SubscriptionError } from "../services/subscriptions/errors";
import {
  getPlayApi,
  googleHttpStatus,
  mapGoogleError,
} from "../services/subscriptions/google";
import { storeEventExists } from "../services/subscriptions/persistence";
import {
  applyAppleNotification,
  applyGoogleStoreEvent,
} from "./verifiedSubscriptionHandlers";

export const SUBSCRIPTION_RECONCILE_COLLECTION = "subscription_reconcile_state";
/** The Voided Purchases API refuses a start time older than 30 days, measured when the request lands; one day of margin. */
export const GOOGLE_VOIDED_LOOKBACK_MS = 29 * 24 * 60 * 60 * 1000;
/** Get Notification History covers 180 days; one day of margin, and the window shrinks further when Apple refuses the start. */
export const APPLE_HISTORY_LOOKBACK_MS = 179 * 24 * 60 * 60 * 1000;
/** Shorter windows tried, in order, when Apple says the start date is too early. */
export const APPLE_HISTORY_FALLBACK_LOOKBACKS_MS = [90, 30, 7].map(
  (days) => days * 24 * 60 * 60 * 1000
);
/** Failed items kept for the next run; past this the checkpoint stops instead. */
export const MAX_RETAINED_FAILURES = 100;
/** Apple payloads are a few kilobytes each, so fewer fit one state document. */
export const MAX_RETAINED_APPLE_FAILURES = 40;
/** A retained item that keeps failing is dropped after this many runs, with an error log. */
const MAX_RETAINED_ATTEMPTS = 20;

const TOTAL_BUDGET_MS = 480_000;
const PHASE_BUDGETS_MS = {
  acknowledgements: 120_000,
  googleVoided: 120_000,
  appleHistoryProduction: 100_000,
  appleHistorySandbox: 100_000,
};

export interface ReconcileWindow {
  startAt: Date;
  endAt: Date;
  pageToken?: string;
}

export interface RetainedItem {
  key: string;
  item: DocumentData;
  attempts: number;
  code: string;
  failedAt: Date;
}

export interface ReconcileState {
  checkpointAt?: Date;
  window?: ReconcileWindow;
  retained: RetainedItem[];
}

export interface FeedPhaseSummary {
  pages: number;
  processed: number;
  applied: number;
  skipped: number;
  dropped: number;
  retained: number;
  /** False when time ran out, a page failed, or the retry list was full. */
  completed: boolean;
}

/** One item of a store feed: how to key, replay, store and apply it. */
export interface FeedPhase<T> {
  source: string;
  lookbackMs: number;
  maxRetained: number;
  fetchPage(
    window: ReconcileWindow
  ): Promise<{ items: T[]; nextPageToken?: string }>;
  itemKey(item: T): string;
  toData(item: T): DocumentData;
  fromData(data: DocumentData): T;
  apply(item: T): Promise<"applied" | "skipped">;
}

/**
 * The window a run covers. A stored window (a run cut short mid-feed) is
 * resumed as it was, because the feed ignores its time filters once a page
 * token is set. Otherwise it runs from the checkpoint to now, clamped to what
 * the feed still serves; the clamp is a gap the feed can no longer fill.
 */
export function reconcileWindow(
  state: ReconcileState,
  now: Date,
  lookbackMs: number
): { window: ReconcileWindow; gapMs: number } {
  if (state.window) {
    return { window: state.window, gapMs: 0 };
  }
  const earliest = now.getTime() - lookbackMs;
  const wanted = state.checkpointAt?.getTime() ?? earliest;
  const startAt = Math.max(wanted, earliest);
  return {
    window: { startAt: new Date(startAt), endAt: now },
    gapMs: Math.max(0, earliest - wanted),
  };
}

/** Subscription renewals share a token, so a voided entry is told apart by its order. */
export function voidedEventKey(entry: {
  orderId?: string | null;
  purchaseToken: string;
  voidedTimeMillis?: string | null;
}): string {
  if (entry.orderId) {
    return `voided:${entry.orderId}`;
  }
  return `voided:${sha256Reference(entry.purchaseToken)}:${entry.voidedTimeMillis ?? "0"}`;
}

/**
 * Whether a failed item is worth another run. Store outages, permission and
 * internal errors are; data the store rejects is not, and neither is a
 * purchase owned by another account, which the live handler also lets go.
 */
export function isRetainableFailure(error: unknown): boolean {
  if (!(error instanceof SubscriptionError)) {
    return true;
  }
  return (
    error.retryable ||
    error.kind === "store-unavailable" ||
    error.kind === "configuration" ||
    error.kind === "internal"
  );
}

async function readState(ref: DocumentReference): Promise<ReconcileState> {
  const snapshot = await ref.get();
  const data = snapshot.data() ?? {};
  const checkpointAt =
    data.checkpointAt instanceof Timestamp ? data.checkpointAt.toDate() : undefined;
  const window =
    data.window &&
    data.window.startAt instanceof Timestamp &&
    data.window.endAt instanceof Timestamp
      ? {
        startAt: data.window.startAt.toDate(),
        endAt: data.window.endAt.toDate(),
        ...(typeof data.window.pageToken === "string"
          ? { pageToken: data.window.pageToken }
          : {}),
      }
      : undefined;
  const retained: RetainedItem[] = Array.isArray(data.retained)
    ? data.retained
      .filter(
        (row: DocumentData) =>
          typeof row?.key === "string" && row.item && typeof row.item === "object"
      )
      .map((row: DocumentData) => ({
        key: row.key,
        item: row.item,
        attempts: typeof row.attempts === "number" ? row.attempts : 0,
        code: typeof row.code === "string" ? row.code : "unknown",
        failedAt:
          row.failedAt instanceof Timestamp ? row.failedAt.toDate() : new Date(0),
      }))
    : [];
  return { checkpointAt, window, retained };
}

async function writeState(
  ref: DocumentReference,
  state: ReconcileState,
  now: Date
): Promise<void> {
  const data: DocumentData = {
    retained: state.retained.map((row) => ({
      key: row.key,
      item: row.item,
      attempts: row.attempts,
      code: row.code,
      failedAt: Timestamp.fromDate(row.failedAt),
    })),
    lastRunAt: Timestamp.fromDate(now),
    updatedAt: Timestamp.fromDate(now),
    checkpointAt: state.checkpointAt
      ? Timestamp.fromDate(state.checkpointAt)
      : FieldValue.delete(),
    window: state.window
      ? {
        startAt: Timestamp.fromDate(state.window.startAt),
        endAt: Timestamp.fromDate(state.window.endAt),
        ...(state.window.pageToken ? { pageToken: state.window.pageToken } : {}),
      }
      : FieldValue.delete(),
  };
  await ref.set(data, { merge: true });
}

/**
 * Replays one store feed from its checkpoint. Retained failures go first;
 * then pages, each completed in full before its token is stored, so a run cut
 * short re-reads the same page and the event keys make that harmless. The
 * checkpoint moves to the window's end only when the last page is done, and a
 * window outlives the run only together with a page token. A failure that
 * cannot be retained stops the run instead of being forgotten.
 */
export async function runFeedPhase<T>(
  phase: FeedPhase<T>,
  now: Date,
  deadline: Date
): Promise<FeedPhaseSummary> {
  const summary: FeedPhaseSummary = {
    pages: 0,
    processed: 0,
    applied: 0,
    skipped: 0,
    dropped: 0,
    retained: 0,
    completed: false,
  };
  const ref = admin
    .firestore()
    .collection(SUBSCRIPTION_RECONCILE_COLLECTION)
    .doc(phase.source);
  const state = await readState(ref);
  const outOfTime = () => Date.now() >= deadline.getTime();

  const applyItem = async (item: T, key: string, retainedRow?: RetainedItem) => {
    summary.processed += 1;
    try {
      const outcome = await phase.apply(item);
      summary[outcome] += 1;
      return true;
    } catch (error) {
      const code = safeErrorCode(error);
      if (!isRetainableFailure(error)) {
        summary.dropped += 1;
        functions.logger.warn("subscription_reconcile_item_dropped", {
          source: phase.source,
          key,
          code,
        });
        return true;
      }
      if (retainedRow) {
        retainedRow.attempts += 1;
        retainedRow.code = code;
        retainedRow.failedAt = now;
        if (retainedRow.attempts >= MAX_RETAINED_ATTEMPTS) {
          summary.dropped += 1;
          functions.logger.error("subscription_reconcile_item_given_up", {
            source: phase.source,
            key,
            code,
            attempts: retainedRow.attempts,
          });
          return true;
        }
        summary.retained += 1;
        return "kept";
      }
      if (state.retained.length >= phase.maxRetained) {
        functions.logger.error("subscription_reconcile_retry_list_full", {
          source: phase.source,
          key,
          code,
        });
        return false;
      }
      state.retained.push({
        key,
        item: phase.toData(item),
        attempts: 1,
        code,
        failedAt: now,
      });
      summary.retained += 1;
      return true;
    }
  };

  // Retained failures first, oldest first.
  const stillRetained: RetainedItem[] = [];
  for (const row of state.retained) {
    if (outOfTime()) {
      stillRetained.push(row);
      continue;
    }
    const result = await applyItem(phase.fromData(row.item), row.key, row);
    if (result === "kept") {
      stillRetained.push(row);
    }
  }
  state.retained = stillRetained;

  const { window, gapMs } = reconcileWindow(state, now, phase.lookbackMs);
  if (gapMs > 0) {
    functions.logger.warn("subscription_reconcile_gap", {
      source: phase.source,
      gapMs,
    });
  }
  state.window = window;

  for (;;) {
    if (outOfTime()) {
      break;
    }
    let page: { items: T[]; nextPageToken?: string };
    try {
      page = await phase.fetchPage(window);
    } catch (error) {
      functions.logger.error("subscription_reconcile_page_failure", {
        source: phase.source,
        code: safeErrorCode(error),
        httpStatus: googleHttpStatus(error),
        detail: error instanceof Error ? error.message.slice(0, 200) : undefined,
      });
      break;
    }
    summary.pages += 1;
    let pageDone = true;
    for (const item of page.items) {
      if (outOfTime()) {
        pageDone = false;
        break;
      }
      const ok = await applyItem(item, phase.itemKey(item));
      if (ok === false) {
        pageDone = false;
        break;
      }
    }
    if (!pageDone) {
      break;
    }
    if (page.nextPageToken) {
      window.pageToken = page.nextPageToken;
      await writeState(ref, state, now);
      continue;
    }
    state.checkpointAt = window.endAt;
    state.window = undefined;
    summary.completed = true;
    break;
  }

  // A window is worth keeping only mid-feed, where its page token continues
  // it. One whose first page never came back is recomputed from the
  // checkpoint next time, or a start the feed refused would be retried forever.
  if (state.window && !state.window.pageToken) {
    state.window = undefined;
  }
  await writeState(ref, state, now);
  return summary;
}

/** Entries of the Voided Purchases API as the retry list stores them. */
interface VoidedEntry {
  orderId?: string;
  purchaseToken: string;
  voidedTimeMillis?: string;
  voidedReason?: number;
  voidedSource?: number;
}

export function googleVoidedPhase(operationId: string): FeedPhase<VoidedEntry> {
  return {
    source: "google-voided",
    lookbackMs: GOOGLE_VOIDED_LOOKBACK_MS,
    maxRetained: MAX_RETAINED_FAILURES,
    async fetchPage(window) {
      let response;
      try {
        response = await getPlayApi().listVoidedPurchases({
          startTimeMillis: window.startAt.getTime(),
          endTimeMillis: window.endAt.getTime(),
          pageToken: window.pageToken,
        });
      } catch (error) {
        throw mapGoogleError(error);
      }
      const items: VoidedEntry[] = (response.voidedPurchases ?? [])
        .filter((row) => typeof row.purchaseToken === "string" && row.purchaseToken)
        .map((row) => ({
          purchaseToken: row.purchaseToken!,
          ...(row.orderId ? { orderId: row.orderId } : {}),
          ...(row.voidedTimeMillis ? { voidedTimeMillis: row.voidedTimeMillis } : {}),
          ...(typeof row.voidedReason === "number"
            ? { voidedReason: row.voidedReason }
            : {}),
          ...(typeof row.voidedSource === "number"
            ? { voidedSource: row.voidedSource }
            : {}),
        }));
      return {
        items,
        nextPageToken: response.tokenPagination?.nextPageToken ?? undefined,
      };
    },
    itemKey: voidedEventKey,
    toData: (item) => ({ ...item }),
    fromData: (data) => data as VoidedEntry,
    async apply(item) {
      const voidedAt = Number(item.voidedTimeMillis);
      const outcome = await applyGoogleStoreEvent({
        purchaseToken: item.purchaseToken,
        eventType: "VOIDED_PURCHASE",
        eventKey: voidedEventKey(item),
        eventAt: Number.isFinite(voidedAt) && voidedAt > 0 ? new Date(voidedAt) : new Date(),
        voidedReason: item.voidedReason,
        voidedSource: item.voidedSource,
        operationId,
        logEvent: "subscription_reconcile_voided_event",
      });
      return outcome.claimed && outcome.stateApplied ? "applied" : "skipped";
    },
  };
}

interface AppleHistoryEntry {
  signedPayload: string;
}

export function appleHistoryPhase(
  environment: AppleStoreEnvironment,
  operationId: string,
  apply: (signedPayload: string, operationId: string, logEvent: string) => Promise<{
    stateApplied: boolean;
  }> = applyAppleNotification
): FeedPhase<AppleHistoryEntry> {
  return {
    source: `apple-history-${environment}`,
    lookbackMs: APPLE_HISTORY_LOOKBACK_MS,
    maxRetained: MAX_RETAINED_APPLE_FAILURES,
    async fetchPage(window) {
      let response;
      for (;;) {
        try {
          response = await getAppleHistoryApi().getNotificationHistory(
            environment,
            window.pageToken,
            { startDate: window.startAt.getTime(), endDate: window.endAt.getTime() }
          );
          break;
        } catch (error) {
          // Apple keeps less history in some environments than the documented
          // 180 days. Move the start forward until it is accepted; what is
          // skipped is a gap the feed cannot fill anyway.
          const later = APPLE_HISTORY_FALLBACK_LOOKBACKS_MS.map(
            (lookback) => window.endAt.getTime() - lookback
          ).find((start) => start > window.startAt.getTime());
          if (
            !(error instanceof SubscriptionError) ||
            error.safeCode !== APPLE_HISTORY_START_TOO_EARLY_CODE ||
            later === undefined ||
            window.pageToken
          ) {
            throw error;
          }
          functions.logger.warn("subscription_reconcile_gap", {
            source: `apple-history-${environment}`,
            gapMs: later - window.startAt.getTime(),
            reason: APPLE_HISTORY_START_TOO_EARLY_CODE,
          });
          window.startAt = new Date(later);
        }
      }
      return {
        items: (response.notificationHistory ?? [])
          .filter((row) => typeof row.signedPayload === "string" && row.signedPayload)
          .map((row) => ({ signedPayload: row.signedPayload! })),
        nextPageToken:
          response.hasMore && response.paginationToken
            ? response.paginationToken
            : undefined,
      };
    },
    itemKey: (item) => {
      try {
        return decodeAppleNotificationIdentity(item.signedPayload).notificationUUID;
      } catch {
        return `undecodable:${sha256Reference(item.signedPayload)}`;
      }
    },
    toData: (item) => ({ signedPayload: item.signedPayload }),
    fromData: (data) => ({ signedPayload: String(data.signedPayload) }),
    async apply(item) {
      // Only the dedupe key is read unverified; a record that is new goes
      // through the verified path, which re-reads the status from Apple.
      const identity = decodeAppleNotificationIdentity(item.signedPayload);
      if (identity.environment !== environment) {
        return "skipped";
      }
      if (await storeEventExists("apple", environment, identity.notificationUUID)) {
        return "skipped";
      }
      const outcome = await apply(
        item.signedPayload,
        operationId,
        "subscription_reconcile_apple_history_event"
      );
      return outcome.stateApplied ? "applied" : "skipped";
    },
  };
}

export interface ReconcileRunSummary {
  operationId: string;
  durationMs: number;
  acknowledgements: AcknowledgementPhaseSummary | { error: string };
  googleVoided: FeedPhaseSummary | { error: string };
  appleHistoryProduction: FeedPhaseSummary | { error: string };
  appleHistorySandbox: FeedPhaseSummary | { error: string };
}

export interface ReconcileOptions {
  now?: Date;
  /** Shrinks every budget, for tests. */
  budgetScale?: number;
  appleApply?: Parameters<typeof appleHistoryPhase>[2];
}

/**
 * The scheduled recovery pass. Each phase has its own time budget and its own
 * failure handling, so an Apple outage never delays a Play acknowledgement.
 */
export async function handleReconcileSubscriptions(
  options: ReconcileOptions = {}
): Promise<ReconcileRunSummary> {
  const operationId = crypto.randomUUID();
  const started = Date.now();
  const now = options.now ?? new Date(started);
  const scale = options.budgetScale ?? 1;
  const hardDeadline = started + TOTAL_BUDGET_MS * scale;
  const deadlineFor = (budget: number) =>
    new Date(Math.min(Date.now() + budget * scale, hardDeadline));
  functions.logger.info("subscription_reconcile_start", { operationId });

  const runPhase = async <S>(
    name: string,
    run: () => Promise<S>
  ): Promise<S | { error: string }> => {
    try {
      return await run();
    } catch (error) {
      const code = safeErrorCode(error);
      functions.logger.error("subscription_reconcile_phase_failure", {
        operationId,
        phase: name,
        code,
      });
      return { error: code };
    }
  };

  const summary: ReconcileRunSummary = {
    operationId,
    durationMs: 0,
    acknowledgements: await runPhase("acknowledgements", () =>
      runAcknowledgementPhase(now, deadlineFor(PHASE_BUDGETS_MS.acknowledgements))
    ),
    googleVoided: await runPhase("googleVoided", () =>
      runFeedPhase(
        googleVoidedPhase(operationId),
        now,
        deadlineFor(PHASE_BUDGETS_MS.googleVoided)
      )
    ),
    appleHistoryProduction: await runPhase("appleHistoryProduction", () =>
      runFeedPhase(
        appleHistoryPhase("production", operationId, options.appleApply),
        now,
        deadlineFor(PHASE_BUDGETS_MS.appleHistoryProduction)
      )
    ),
    appleHistorySandbox: await runPhase("appleHistorySandbox", () =>
      runFeedPhase(
        appleHistoryPhase("sandbox", operationId, options.appleApply),
        now,
        deadlineFor(PHASE_BUDGETS_MS.appleHistorySandbox)
      )
    ),
  };
  summary.durationMs = Date.now() - started;
  functions.logger.info("subscription_reconcile_finished", summary);
  return summary;
}
