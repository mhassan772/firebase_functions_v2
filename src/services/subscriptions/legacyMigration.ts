import { DocumentData, Timestamp } from "firebase-admin/firestore";
import * as functions from "firebase-functions";
import { admin } from "../../config/admin";
import { sha256Hex } from "./crypto";
import { SubscriptionError } from "./errors";
import {
  LEGACY_MIRROR_SOURCE,
  applyManualMutation,
  legacyExpires,
} from "./manual";
import {
  LEGACY_MANUAL_COLLECTION,
  MANUAL_SLOT,
  SUBSCRIPTION_MASTER_COLLECTION,
  SUBSCRIPTION_STATE_COLLECTION,
  stateDocumentId,
  timestampDate,
} from "./persistence";
import {
  getAuthUser,
  isHexHash,
  looksLikeRawUid,
  scanAuthForHashes,
} from "./userResolution";

export const MIGRATION_RUNS_COLLECTION = "subscription_migration_runs";
const REPORT_FLUSH_EVERY = 10;
const LIST_PAGE_SIZE = 300;

export type MigrationResolution =
  | "user_guid"
  | "raw_uid_doc_id"
  | "hash_scan"
  | "none";

export type MigrationRowAction =
  | "imported"
  | "skipped_expired"
  | "skipped_ledger_exists"
  | "skipped_mirror"
  | "unresolved"
  | "mismatch"
  | "failed";

export interface MigrationRow {
  docId: string;
  uid?: string;
  email?: string;
  expires?: string;
  resolution: MigrationResolution;
  action: MigrationRowAction;
  detail?: string;
  existingMaster?: { platform: string; expiresAt?: string };
  rawUidDocId: boolean;
}

export interface MigrationReport {
  runId: string;
  dryRun: boolean;
  status: "running" | "finished" | "failed";
  startedAt: string;
  finishedAt?: string;
  startedBy: string;
  totals: Record<MigrationRowAction, number>;
  rows: MigrationRow[];
  error?: string;
}

const emptyTotals = (): Record<MigrationRowAction, number> => ({
  imported: 0,
  skipped_expired: 0,
  skipped_ledger_exists: 0,
  skipped_mirror: 0,
  unresolved: 0,
  mismatch: 0,
  failed: 0,
});

interface LegacyDocument {
  docId: string;
  data: DocumentData;
}

/**
 * Plans the migration: resolves every legacy document to an account and says
 * what an import would do with it. Writes nothing. Documents without a uid are
 * resolved by one in-memory scan of Firebase Auth, which is the slow part and
 * the reason the live import takes this plan's rows instead of resolving again.
 */
export async function planLegacyMigration(options: {
  runId: string;
  actor: string;
  now?: Date;
}): Promise<MigrationReport> {
  const now = options.now ?? new Date();
  const report: MigrationReport = {
    runId: options.runId,
    dryRun: true,
    status: "running",
    startedAt: now.toISOString(),
    startedBy: options.actor,
    totals: emptyTotals(),
    rows: [],
  };
  try {
    const documents = await listLegacyDocuments();
    const resolved = await resolveAll(documents);
    for (const document of documents) {
      const row = await planRow(document, resolved.get(document.docId), now);
      report.rows.push(row);
      report.totals[row.action] += 1;
    }
    report.status = "finished";
  } catch (error) {
    report.status = "failed";
    report.error = error instanceof Error ? error.message : String(error);
    functions.logger.error("legacy_migration_plan_failure", {
      runId: options.runId,
      error: report.error,
    });
  }
  report.finishedAt = new Date().toISOString();
  functions.logger.info("legacy_migration_planned", {
    runId: options.runId,
    status: report.status,
    totals: report.totals,
  });
  return report;
}

export interface ImportRow {
  docId: string;
  uid: string;
}

/**
 * Imports the rows of a reviewed plan, trusting its uids. The only check per
 * row is that the document belongs to the uid: its id is the uid's hash, or
 * the raw uid itself (verified against Auth). The transaction then re-reads
 * the legacy document and refuses an account that already has a ledger, a
 * mirror write, or an expired grant, so a stale plan cannot add time.
 *
 * Writes one transaction per row and appends to the stored report as it goes,
 * so a timeout still leaves a usable report and a re-run is safe.
 */
export async function importLegacyRows(options: {
  runId: string;
  rows: ImportRow[];
  actor: string;
  now?: Date;
}): Promise<MigrationReport> {
  const now = options.now ?? new Date();
  if (await readMigrationRun(options.runId)) {
    throw new SubscriptionError(
      "precondition",
      "migration-run-exists",
      "A run with this id already exists. Use a new run id."
    );
  }
  const report: MigrationReport = {
    runId: options.runId,
    dryRun: false,
    status: "running",
    startedAt: now.toISOString(),
    startedBy: options.actor,
    totals: emptyTotals(),
    rows: [],
  };
  await writeReport(report);

  try {
    for (const input of options.rows) {
      const row: MigrationRow = {
        docId: input.docId,
        uid: input.uid,
        resolution: "none",
        action: "imported",
        rawUidDocId: looksLikeRawUid(input.docId),
      };
      if (sha256Hex(input.uid) === input.docId) {
        row.resolution = "user_guid";
      } else if (row.rawUidDocId && input.docId === input.uid) {
        try {
          await getAuthUser(input.uid);
          row.resolution = "raw_uid_doc_id";
        } catch {
          row.action = "unresolved";
          row.detail = "the raw uid document has no account in Auth";
        }
      } else {
        row.action = "mismatch";
        row.detail = "the document id is neither the hash of the uid nor the uid itself";
      }
      if (row.action === "imported") {
        await importRow(row, options.runId);
      }
      report.rows.push(row);
      report.totals[row.action] += 1;
      if (report.rows.length % REPORT_FLUSH_EVERY === 0) {
        await writeReport(report);
      }
    }
    report.status = "finished";
  } catch (error) {
    report.status = "failed";
    report.error = error instanceof Error ? error.message : String(error);
    functions.logger.error("legacy_migration_failure", {
      runId: options.runId,
      error: report.error,
    });
  }
  report.finishedAt = new Date().toISOString();
  await writeReport(report);
  functions.logger.info("legacy_migration_finished", {
    runId: options.runId,
    status: report.status,
    totals: report.totals,
  });
  return report;
}

export async function readMigrationRun(runId: string): Promise<MigrationReport | undefined> {
  const snapshot = await admin
    .firestore()
    .collection(MIGRATION_RUNS_COLLECTION)
    .doc(runId)
    .get();
  if (!snapshot.exists) {
    return undefined;
  }
  const data = snapshot.data()!;
  return {
    runId,
    dryRun: data.dryRun === true,
    status: data.status,
    startedAt: timestampDate(data.startedAt)?.toISOString() ?? "",
    finishedAt: timestampDate(data.finishedAt)?.toISOString(),
    startedBy: typeof data.startedBy === "string" ? data.startedBy : "",
    totals: { ...emptyTotals(), ...(data.totals ?? {}) },
    rows: Array.isArray(data.rows) ? (data.rows as MigrationRow[]) : [],
    error: typeof data.error === "string" ? data.error : undefined,
  };
}

async function writeReport(report: MigrationReport): Promise<void> {
  const data: DocumentData = {
    dryRun: report.dryRun,
    status: report.status,
    startedAt: Timestamp.fromDate(new Date(report.startedAt)),
    startedBy: report.startedBy,
    totals: report.totals,
    // Rows carry optional fields; Firestore refuses undefined values.
    rows: JSON.parse(JSON.stringify(report.rows)),
    updatedAt: Timestamp.now(),
  };
  if (report.finishedAt) {
    data.finishedAt = Timestamp.fromDate(new Date(report.finishedAt));
  }
  if (report.error) {
    data.error = report.error;
  }
  await admin
    .firestore()
    .collection(MIGRATION_RUNS_COLLECTION)
    .doc(report.runId)
    .set(data);
}

async function listLegacyDocuments(): Promise<LegacyDocument[]> {
  const firestore = admin.firestore();
  const documents: LegacyDocument[] = [];
  let query = firestore
    .collection(LEGACY_MANUAL_COLLECTION)
    .orderBy("__name__")
    .limit(LIST_PAGE_SIZE);
  for (;;) {
    const page = await query.get();
    for (const snapshot of page.docs) {
      documents.push({ docId: snapshot.id, data: snapshot.data() });
    }
    if (page.size < LIST_PAGE_SIZE) {
      break;
    }
    query = query.startAfter(page.docs[page.size - 1]);
  }
  return documents;
}

interface Resolved {
  uid: string;
  email?: string;
  resolution: MigrationResolution;
}

/**
 * Resolves every document to a uid: the `user_guid` field, a raw-uid document
 * id, and finally one Auth scan shared by all the remaining hashes. Every
 * resolution except the raw-uid id is proven by recomputing the hash; the
 * raw-uid id is proven by the Auth lookup itself.
 */
async function resolveAll(
  documents: LegacyDocument[]
): Promise<Map<string, Resolved | { mismatch: string }>> {
  const result = new Map<string, Resolved | { mismatch: string }>();
  const pendingHashes = new Set<string>();

  for (const document of documents) {
    const guid = document.data.user_guid;
    // The one document keyed by a raw uid also carries that uid as user_guid;
    // its identity is proven by the Auth lookup, not by the hash.
    const rawUidDocument =
      looksLikeRawUid(document.docId) && (typeof guid !== "string" || guid === document.docId);
    if (typeof guid === "string" && guid && !rawUidDocument) {
      if (sha256Hex(guid) === document.docId) {
        result.set(document.docId, {
          uid: guid,
          resolution: "user_guid",
        });
      } else {
        result.set(document.docId, {
          mismatch: `user_guid ${guid} does not hash to the document id`,
        });
      }
      continue;
    }
    if (rawUidDocument) {
      try {
        const user = await getAuthUser(document.docId);
        result.set(document.docId, {
          uid: user.uid,
          email: user.email,
          resolution: "raw_uid_doc_id",
        });
      } catch {
        // Falls through to the unresolved row.
      }
      continue;
    }
    if (isHexHash(document.docId)) {
      pendingHashes.add(document.docId);
    }
  }

  if (pendingHashes.size > 0) {
    const found = await scanAuthForHashes(pendingHashes);
    for (const [hash, uid] of found) {
      result.set(hash, { uid, resolution: "hash_scan" });
    }
  }

  for (const [docId, entry] of result) {
    if ("uid" in entry && !entry.email) {
      try {
        entry.email = (await getAuthUser(entry.uid)).email;
      } catch {
        result.set(docId, { mismatch: `uid ${entry.uid} no longer exists in Auth` });
      }
    }
  }
  return result;
}

async function planRow(
  document: LegacyDocument,
  resolved: Resolved | { mismatch: string } | undefined,
  now: Date
): Promise<MigrationRow> {
  const expires = legacyExpires(document.data);
  const row: MigrationRow = {
    docId: document.docId,
    expires: expires?.toISOString(),
    resolution: "none",
    action: "unresolved",
    rawUidDocId: looksLikeRawUid(document.docId),
    email: typeof document.data.email === "string" ? document.data.email.trim() : undefined,
  };
  if (resolved && "mismatch" in resolved) {
    row.action = "mismatch";
    row.detail = resolved.mismatch;
    return row;
  }
  if (!resolved) {
    row.detail = "no account hashes to this document id";
    return row;
  }
  row.uid = resolved.uid;
  row.email = resolved.email ?? row.email;
  row.resolution = resolved.resolution;

  if (!expires || expires.getTime() <= now.getTime()) {
    row.action = "skipped_expired";
    return row;
  }

  const firestore = admin.firestore();
  const [masterSnapshot, manualSnapshot] = await firestore.getAll(
    firestore.collection(SUBSCRIPTION_MASTER_COLLECTION).doc(resolved.uid),
    firestore
      .collection(SUBSCRIPTION_STATE_COLLECTION)
      .doc(stateDocumentId(resolved.uid, MANUAL_SLOT.platform, MANUAL_SLOT.environment))
  );
  if (masterSnapshot.exists) {
    row.existingMaster = {
      platform: masterSnapshot.get("platform"),
      expiresAt: timestampDate(masterSnapshot.get("expiresAt"))?.toISOString(),
    };
  }
  const grants = manualSnapshot.get("grants");
  if (Array.isArray(grants) && grants.length > 0) {
    // Also covers a document the backend mirrored: the ledger is the truth there.
    row.action = "skipped_ledger_exists";
    return row;
  }
  if (document.data.source === LEGACY_MIRROR_SOURCE) {
    row.action = "skipped_mirror";
    return row;
  }
  row.action = "imported";
  return row;
}

async function importRow(row: MigrationRow, runId: string): Promise<void> {
  try {
    await applyManualMutation(
      {
        uid: row.uid!,
        opId: `legacy-import:${runId}:${row.docId}`,
        actor: "legacy-migration",
      },
      { action: "importLegacy", runId, legacyDocId: row.docId }
    );
  } catch (error) {
    // The transaction re-reads the legacy document, so it can reach a different
    // conclusion than the plan did a moment earlier; report what it found.
    if (error instanceof SubscriptionError) {
      switch (error.safeCode) {
        case "ledger-exists":
          row.action = "skipped_ledger_exists";
          return;
        case "legacy-document-is-mirror":
          row.action = "skipped_mirror";
          return;
        case "legacy-grant-expired":
          row.action = "skipped_expired";
          return;
      }
      row.detail = error.safeCode;
    } else {
      row.detail = error instanceof Error ? error.message : String(error);
    }
    row.action = "failed";
    functions.logger.error("legacy_migration_row_failure", {
      runId,
      docId: row.docId,
      detail: row.detail,
    });
  }
}
