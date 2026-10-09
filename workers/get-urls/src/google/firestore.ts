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

/** Encodes the scalar values this Worker writes; undefined is stored as null. */
export function encodeValue(value: string | number | boolean | null | undefined): FirestoreValue {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  return { stringValue: value };
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
    throw new Error(`Firestore ${method} failed with HTTP ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

/** Reads documents by full name; the map holds null for each missing document. */
export async function batchGet(
  env: Env,
  names: string[]
): Promise<Map<string, FirestoreFields | null>> {
  const results = await call<({ found: FirestoreDocument } | { missing: string })[]>(
    env,
    "batchGet",
    { documents: names }
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

export async function runQuery(env: Env, structuredQuery: unknown): Promise<FirestoreDocument[]> {
  const results = await call<{ document?: FirestoreDocument }[]>(env, "runQuery", {
    structuredQuery,
  });
  return results.flatMap((result) => (result.document ? [result.document] : []));
}
