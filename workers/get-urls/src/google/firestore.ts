import { Env } from "../env";
import { getGoogleAccessToken } from "./accessToken";

export type FirestoreValue =
  | { nullValue: null }
  | { booleanValue: boolean }
  | { integerValue: string }
  | { doubleValue: number }
  | { timestampValue: string }
  | { stringValue: string }
  | { bytesValue: string }
  | { referenceValue: string }
  | { geoPointValue: { latitude: number; longitude: number } }
  | { arrayValue: { values?: FirestoreValue[] } }
  | { mapValue: { fields?: Record<string, FirestoreValue> } };

export type FirestoreFields = Record<string, FirestoreValue>;

export interface FirestoreDocument {
  name: string;
  fields?: FirestoreFields;
}

/** Converts a REST value to plain JS the way the Admin SDK does; integers become numbers. */
export function decodeValue(value: FirestoreValue): unknown {
  if ("nullValue" in value) return null;
  if ("booleanValue" in value) return value.booleanValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return Number(value.doubleValue);
  if ("timestampValue" in value) return value.timestampValue;
  if ("stringValue" in value) return value.stringValue;
  if ("bytesValue" in value) return value.bytesValue;
  if ("referenceValue" in value) return value.referenceValue;
  if ("geoPointValue" in value) return value.geoPointValue;
  if ("arrayValue" in value) return (value.arrayValue.values ?? []).map(decodeValue);
  if ("mapValue" in value) return decodeFields(value.mapValue.fields ?? {});
  return undefined;
}

export function decodeFields(fields: FirestoreFields): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    result[key] = decodeValue(value);
  }
  return result;
}

/** A value written as a Firestore timestamp; plain numbers stay integers. */
export class FirestoreTimestamp {
  constructor(readonly millis: number) {}
  toJSON(): string {
    return new Date(this.millis).toISOString();
  }
}

export type EncodableValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | Date
  | FirestoreTimestamp
  | EncodableValue[]
  | { [key: string]: EncodableValue };

/** Encodes what this Worker writes; undefined is stored as null. */
export function encodeValue(value: EncodableValue): FirestoreValue {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (typeof value === "string") return { stringValue: value };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (value instanceof FirestoreTimestamp) return { timestampValue: value.toJSON() };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encodeValue) } };
  return { mapValue: { fields: encodeFields(value) } };
}

export function encodeFields(fields: { [key: string]: EncodableValue }): FirestoreFields {
  const result: FirestoreFields = {};
  for (const [key, value] of Object.entries(fields)) {
    result[key] = encodeValue(value);
  }
  return result;
}

/** Epoch milliseconds of a decoded `timestampValue`, or null when the field is not one. */
export function timestampMillis(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis : null;
}

/** A failed Firestore call; `grpcStatus` is the API's status name, such as ABORTED. */
export class FirestoreError extends Error {
  constructor(
    readonly method: string,
    readonly status: number,
    readonly grpcStatus: string | undefined,
    body: string
  ) {
    super(`Firestore ${method} failed with HTTP ${status}: ${body}`);
  }
}

export function documentName(env: Env, path: string): string {
  return `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`;
}

async function call<T>(env: Env, method: string, body: unknown): Promise<T> {
  const response = await fetch(
    `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents:${method}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${await getGoogleAccessToken(env)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );
  if (!response.ok) {
    const body = await response.text();
    let grpcStatus: string | undefined;
    try {
      grpcStatus = (JSON.parse(body) as { error?: { status?: string } }).error?.status;
    } catch {
      grpcStatus = undefined;
    }
    throw new FirestoreError(method, response.status, grpcStatus, body);
  }
  return (await response.json()) as T;
}

/**
 * Reads documents by full name; the map holds null for each missing document.
 *
 * With a [transaction] id the reads are part of that transaction and the commit fails if any of
 * them changes before it.
 */
export async function batchGet(
  env: Env,
  names: string[],
  transaction?: string
): Promise<Map<string, FirestoreFields | null>> {
  if (names.length === 0) return new Map();
  const results = await call<({ found: FirestoreDocument } | { missing: string })[]>(
    env,
    "batchGet",
    transaction ? { documents: names, transaction } : { documents: names }
  );

  const documents = new Map<string, FirestoreFields | null>();
  for (const result of results) {
    if ("found" in result) {
      documents.set(result.found.name, result.found.fields ?? {});
    } else if ("missing" in result) {
      documents.set(result.missing, null);
    }
  }
  return documents;
}

/** A full-document write: the document is created or replaced with [fields]. */
export interface FirestoreWrite {
  update: { name: string; fields: FirestoreFields };
}

export async function beginTransaction(env: Env): Promise<string> {
  const { transaction } = await call<{ transaction: string }>(env, "beginTransaction", {});
  return transaction;
}

/** Commits [writes] under [transaction]; the transaction ends either way. */
export async function commit(env: Env, writes: FirestoreWrite[], transaction: string): Promise<void> {
  await call(env, "commit", { writes, transaction });
}

export async function runQuery(env: Env, structuredQuery: unknown): Promise<FirestoreDocument[]> {
  const results = await call<{ document?: FirestoreDocument }[]>(env, "runQuery", {
    structuredQuery,
  });
  return results.flatMap((result) => (result.document ? [result.document] : []));
}
