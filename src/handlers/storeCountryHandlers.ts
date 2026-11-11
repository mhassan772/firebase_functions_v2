import * as crypto from "crypto";
import * as functions from "firebase-functions";
import {
  STORE_COUNTRY_SOURCES,
  StoreCountryReport,
  StoreCountrySource,
  StoreCountryStore,
} from "../services/storeCountry";
import { CallerContext, errorCodeOf, hasAppCheck, reasonOf, refusal, requireCaller } from "../utils/callableAuth";
import { toAlpha2 } from "../utils/countryCodes";

export interface StoreCountryDeps {
  store: StoreCountryStore;
  now: () => number;
}

export interface ReportStoreCountryResult {
  /** The two-letter code stored for this report. */
  country: string;
  /** Whether the account's app report now counts as pricing evidence for exactly this country. */
  counted: boolean;
}

/** Where a non-refusal failure happened, so logs say which step broke without its message. */
type Stage = "validate" | "write" | "read";

const REQUEST_KEYS = ["country", "source"];

/**
 * Records the store or SIM country the app reports for the signed-in account.
 *
 * The answer says whether the report counts, so the app keeps re-sending one that does not,
 * such as a report made while App Check was off.
 */
export async function handleReportStoreCountry(
  data: unknown,
  context: CallerContext,
  deps: StoreCountryDeps
): Promise<ReportStoreCountryResult> {
  const event = "store_country_report";
  const operationId = crypto.randomUUID();
  const state: { stage: Stage } = { stage: "validate" };
  try {
    const uid = requireCaller(context, { allowAnonymous: false, withReason: true });
    const report = readReport(data, hasAppCheck(context));
    logInfo(`${event}_start`, operationId, { uid, source: report.source, attested: report.attested });

    state.stage = "write";
    const decision = await deps.store.record(uid, report, deps.now());

    state.stage = "read";
    const known = await deps.store.knownCountries(uid);
    const counted = known.appReport === report.country;
    logInfo(`${event}_success`, operationId, {
      uid,
      country: report.country,
      source: report.source,
      attested: report.attested,
      written: decision.write,
      replaced: decision.write && decision.replaced,
      counted,
    });
    return { country: report.country, counted };
  } catch (error) {
    throw toCallableError(event, operationId, state.stage, error);
  }
}

function readReport(data: unknown, attested: boolean): StoreCountryReport {
  if (!isPlainObject(data)) throw invalidRequest();
  const keys = Object.keys(data);
  if (keys.length !== REQUEST_KEYS.length || !REQUEST_KEYS.every((key) => keys.includes(key))) {
    throw invalidRequest();
  }
  const { country: raw, source } = data;
  if (typeof raw !== "string" || typeof source !== "string") throw invalidRequest();

  const country = toAlpha2(raw);
  if (!country) throw refusal("invalid-argument", "country is not a known ISO 3166-1 code.", "country_unknown");
  if (!(STORE_COUNTRY_SOURCES as readonly string[]).includes(source)) {
    throw refusal("invalid-argument", "source is not a known source.", "source_unknown");
  }
  return { country, raw: raw.toUpperCase(), source: source as StoreCountrySource, attested };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalidRequest() {
  return refusal("invalid-argument", "The request must be exactly { country, source } as strings.", "invalid_request");
}

/**
 * Turns any failure into the callable error the app sees, logging it once.
 *
 * Only codes and the stage are logged, never a message: Firestore messages can carry document paths.
 */
function toCallableError(
  event: string,
  operationId: string,
  stage: Stage,
  error: unknown
): functions.https.HttpsError {
  if (error instanceof functions.https.HttpsError) {
    functions.logger.warn(`${event}_rejection`, {
      operationId,
      code: error.code,
      ...(reasonOf(error) ? { reason: reasonOf(error) } : {}),
    });
    return error;
  }
  functions.logger.error(`${event}_failure`, {
    operationId,
    stage,
    errorName: error instanceof Error ? error.name : typeof error,
    ...(errorCodeOf(error) ? { errorCode: errorCodeOf(error) } : {}),
    ...(grpcCodeOf(error) !== undefined ? { grpcCode: grpcCodeOf(error) } : {}),
  });
  return new functions.https.HttpsError("internal", "The store country could not be saved.");
}

/** Firestore reports failures with a numeric gRPC status, which `errorCodeOf` does not read. */
function grpcCodeOf(error: unknown): number | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "number" && Number.isInteger(code) ? code : undefined;
}

function logInfo(event: string, operationId: string, fields: Record<string, unknown> = {}): void {
  functions.logger.info(event, { operationId, ...fields });
}
