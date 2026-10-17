import {
  DocumentData,
  DocumentReference,
  DocumentSnapshot,
  FieldValue,
  Timestamp,
} from "firebase-admin/firestore";
import * as functions from "firebase-functions";
import { admin } from "../../config/admin";
import { VerifiedSubscription } from "../../types/subscriptions";
import { getPlayApi, googleHttpStatus } from "./google";
import {
  googleOwnershipDocumentId,
  SUBSCRIPTION_OWNERSHIP_COLLECTION,
} from "./keys";

export const SUBSCRIPTION_ACKNOWLEDGEMENT_COLLECTION =
  "subscription_acknowledgements";

/** Play refunds a purchase that is not acknowledged within three days of purchase. */
export const ACKNOWLEDGEMENT_DEADLINE_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_RETRY_DELAY_MS = 6 * 60 * 60 * 1000;
const FIRST_RETRY_DELAY_MS = 15 * 60 * 1000;
/** Pauses between the prompt attempts made right after a purchase is persisted. */
export const PROMPT_RETRY_DELAYS_MS = [2_000, 5_000];
const PHASE_BATCH_SIZE = 50;

export type AcknowledgementStatus =
  | "awaiting-owner"
  | "pending"
  | "done"
  | "abandoned";

export type AcknowledgementOutcome = "done" | "transient" | "permanent";

/**
 * Whether Play still waits for an acknowledgement of this purchase.
 *
 * Renewals arrive already acknowledged. A pending purchase is not acknowledged
 * until the payment completes, when it arrives again as an active purchase.
 */
export function acknowledgementNeeded(verified: VerifiedSubscription): boolean {
  return (
    verified.subscription.platform === "google" &&
    verified.google?.acknowledgementState === "ACKNOWLEDGEMENT_STATE_PENDING" &&
    verified.google.subscriptionState !== "SUBSCRIPTION_STATE_PENDING"
  );
}

export function acknowledgementData(
  verified: VerifiedSubscription,
  uid: string | undefined,
  now: Timestamp
): DocumentData {
  const purchasedAt = Timestamp.fromDate(
    verified.google?.startTime ?? now.toDate()
  );
  const current = verified.ownership.find(
    (identity) => identity.platform === "google"
  );
  const data: DocumentData = {
    status: uid ? "pending" : "awaiting-owner",
    platform: "google",
    environment: verified.subscription.environment,
    productId: verified.subscription.productId,
    purchaseReference: verified.subscription.purchaseReference,
    purchaseToken:
      current && current.platform === "google"
        ? current.currentPurchaseToken
        : undefined,
    purchasedAt,
    deadlineAt: Timestamp.fromMillis(
      purchasedAt.toMillis() + ACKNOWLEDGEMENT_DEADLINE_MS
    ),
    attempts: 0,
    nextAttemptAt: now,
    createdAt: now,
    updatedAt: now,
  };
  if (uid) {
    data.uid = uid;
  }
  return data;
}

/** The update that moves an `awaiting-owner` document to `pending` once an account claims the purchase. */
export function claimedAcknowledgementUpdate(
  uid: string,
  now: Timestamp
): DocumentData {
  return { status: "pending", uid, nextAttemptAt: now, updatedAt: now };
}

/** The update after one acknowledgement attempt. `nextAttemptAt` exists only while work remains. */
export function attemptUpdate(
  attempts: number,
  outcome: AcknowledgementOutcome,
  now: Date,
  code?: string
): DocumentData {
  const nowTimestamp = Timestamp.fromDate(now);
  const next = attempts + 1;
  switch (outcome) {
    case "done":
      return {
        status: "done",
        attempts: next,
        nextAttemptAt: FieldValue.delete(),
        acknowledgedAt: nowTimestamp,
        updatedAt: nowTimestamp,
      };
    case "permanent":
      return {
        status: "abandoned",
        attempts: next,
        nextAttemptAt: FieldValue.delete(),
        abandonedAt: nowTimestamp,
        abandonReason: code ?? "rejected",
        updatedAt: nowTimestamp,
      };
    case "transient":
      return {
        status: "pending",
        attempts: next,
        nextAttemptAt: Timestamp.fromMillis(now.getTime() + retryDelayMs(next)),
        updatedAt: nowTimestamp,
      };
  }
}

/** Fifteen minutes, doubling, capped at the pass interval. */
export function retryDelayMs(attempts: number): number {
  return Math.min(
    MAX_RETRY_DELAY_MS,
    FIRST_RETRY_DELAY_MS * 2 ** Math.max(0, attempts - 1)
  );
}

/** The update for an unowned purchase whose deadline passed with no claim. */
export function unresolvedOwnerUpdate(now: Date): DocumentData {
  const nowTimestamp = Timestamp.fromDate(now);
  return {
    status: "abandoned",
    nextAttemptAt: FieldValue.delete(),
    abandonedAt: nowTimestamp,
    abandonReason: "owner-unresolved",
    updatedAt: nowTimestamp,
  };
}

/**
 * Sorts an acknowledge failure. Rate limits, conflicts, server errors and
 * network failures are retried; a permission problem is retried too, because
 * abandoning it would turn a configuration mistake into a refund. Any other
 * rejection is permanent unless Play already shows the purchase acknowledged.
 */
export async function classifyAcknowledgeFailure(
  error: unknown,
  productId: string,
  token: string
): Promise<{ outcome: AcknowledgementOutcome; code: string }> {
  const status = googleHttpStatus(error);
  if (
    status === undefined ||
    status === 401 ||
    status === 403 ||
    status === 409 ||
    status === 429 ||
    status >= 500
  ) {
    return { outcome: "transient", code: `http-${status ?? "network"}` };
  }
  try {
    const purchase = await getPlayApi().getSubscription(token);
    if (purchase.acknowledgementState === "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED") {
      return { outcome: "done", code: "already-acknowledged" };
    }
  } catch {
    return { outcome: "transient", code: `http-${status}-unconfirmed` };
  }
  void productId;
  return { outcome: "permanent", code: `http-${status}` };
}

interface AcknowledgementRecord {
  ref: DocumentReference;
  status: AcknowledgementStatus;
  productId: string;
  purchaseToken: string;
  purchaseReference: string;
  attempts: number;
  deadlineAt: Date | undefined;
}

function readRecord(snapshot: DocumentSnapshot): AcknowledgementRecord | undefined {
  if (!snapshot.exists) {
    return undefined;
  }
  const productId = snapshot.get("productId");
  const purchaseToken = snapshot.get("purchaseToken");
  const status = snapshot.get("status");
  if (
    typeof productId !== "string" ||
    typeof purchaseToken !== "string" ||
    typeof status !== "string"
  ) {
    return undefined;
  }
  const deadline = snapshot.get("deadlineAt");
  return {
    ref: snapshot.ref,
    status: status as AcknowledgementStatus,
    productId,
    purchaseToken,
    purchaseReference: snapshot.get("purchaseReference") ?? snapshot.id,
    attempts: typeof snapshot.get("attempts") === "number" ? snapshot.get("attempts") : 0,
    deadlineAt: deadline instanceof Timestamp ? deadline.toDate() : undefined,
  };
}

/** One acknowledge call, with the document updated for its outcome. */
async function attempt(
  record: AcknowledgementRecord,
  now: Date
): Promise<AcknowledgementOutcome> {
  let outcome: AcknowledgementOutcome;
  let code = "ok";
  try {
    await getPlayApi().acknowledgeSubscription(
      record.productId,
      record.purchaseToken
    );
    outcome = "done";
  } catch (error) {
    ({ outcome, code } = await classifyAcknowledgeFailure(
      error,
      record.productId,
      record.purchaseToken
    ));
  }
  await record.ref.update(attemptUpdate(record.attempts, outcome, now, code));
  record.attempts += 1;
  const fields = {
    purchaseReference: record.purchaseReference,
    attempts: record.attempts,
    code,
  };
  if (outcome === "done") {
    functions.logger.info("subscription_acknowledged", fields);
  } else if (outcome === "transient") {
    functions.logger.warn("subscription_acknowledgement_retry_scheduled", fields);
  } else {
    functions.logger.error("subscription_acknowledgement_abandoned", fields);
  }
  return outcome;
}

/**
 * Acknowledges a purchase right after its entitlement was committed, with a
 * few prompt retries: license-tester purchases are refunded three minutes
 * after purchase, which no scheduled pass can meet. Never throws; what is not
 * done here is left for the pass.
 */
export async function acknowledgeNow(
  purchaseReference: string,
  delays: number[] = PROMPT_RETRY_DELAYS_MS
): Promise<AcknowledgementOutcome | "skipped"> {
  try {
    const ref = admin
      .firestore()
      .collection(SUBSCRIPTION_ACKNOWLEDGEMENT_COLLECTION)
      .doc(purchaseReference);
    const record = readRecord(await ref.get());
    if (!record || record.status !== "pending") {
      return "skipped";
    }
    let outcome = await attempt(record, new Date());
    for (const delay of delays) {
      if (outcome !== "transient") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
      outcome = await attempt(record, new Date());
    }
    return outcome;
  } catch (error) {
    functions.logger.error("subscription_acknowledgement_failure", {
      purchaseReference,
      code: error instanceof Error ? error.name : "unknown",
    });
    return "transient";
  }
}

export interface AcknowledgementPhaseSummary {
  examined: number;
  acknowledged: number;
  retried: number;
  abandoned: number;
  claimed: number;
}

/**
 * The scheduled retry: every document whose next attempt is due. An unowned
 * purchase is acknowledged once an account has claimed it (its entitlement was
 * committed by that claim), and abandoned once its deadline passes unclaimed.
 */
export async function runAcknowledgementPhase(
  now: Date,
  deadline: Date
): Promise<AcknowledgementPhaseSummary> {
  const summary: AcknowledgementPhaseSummary = {
    examined: 0,
    acknowledged: 0,
    retried: 0,
    abandoned: 0,
    claimed: 0,
  };
  const firestore = admin.firestore();
  const snapshot = await firestore
    .collection(SUBSCRIPTION_ACKNOWLEDGEMENT_COLLECTION)
    .where("nextAttemptAt", "<=", Timestamp.fromDate(now))
    .orderBy("nextAttemptAt")
    .limit(PHASE_BATCH_SIZE)
    .get();

  for (const doc of snapshot.docs) {
    if (Date.now() >= deadline.getTime()) {
      break;
    }
    summary.examined += 1;
    const record = readRecord(doc);
    if (!record) {
      await doc.ref.update({ nextAttemptAt: FieldValue.delete() });
      continue;
    }
    if (record.status === "done" || record.status === "abandoned") {
      await doc.ref.update({ nextAttemptAt: FieldValue.delete() });
      continue;
    }
    if (record.status === "awaiting-owner") {
      if (record.deadlineAt && record.deadlineAt.getTime() <= now.getTime()) {
        await doc.ref.update(unresolvedOwnerUpdate(now));
        functions.logger.warn("subscription_acknowledgement_abandoned", {
          purchaseReference: record.purchaseReference,
          code: "owner-unresolved",
        });
        summary.abandoned += 1;
        continue;
      }
      const ownership = await firestore
        .collection(SUBSCRIPTION_OWNERSHIP_COLLECTION)
        .doc(googleOwnershipDocumentId(record.purchaseToken))
        .get();
      const uid = ownership.get("uid");
      if (!ownership.exists || typeof uid !== "string" || !uid) {
        await doc.ref.update({
          nextAttemptAt: Timestamp.fromMillis(now.getTime() + retryDelayMs(3)),
          updatedAt: Timestamp.fromDate(now),
        });
        summary.retried += 1;
        continue;
      }
      await doc.ref.update(claimedAcknowledgementUpdate(uid, Timestamp.fromDate(now)));
      record.status = "pending";
      summary.claimed += 1;
    }
    const outcome = await attempt(record, now);
    if (outcome === "done") {
      summary.acknowledged += 1;
    } else if (outcome === "transient") {
      summary.retried += 1;
    } else {
      summary.abandoned += 1;
    }
  }
  return summary;
}
