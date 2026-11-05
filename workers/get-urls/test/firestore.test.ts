import { afterEach, describe, expect, it, vi } from "vitest";
import { clearAccessTokenCacheForTests } from "../src/google/accessToken";
import {
  batchGet,
  decodeFields,
  encodeFields,
  encodeValue,
  FirestoreError,
  FirestoreTimestamp,
  timestampMillis,
} from "../src/google/firestore";
import { createEnv, FakeKV } from "./helpers";

describe("decodeFields", () => {
  it("decodes nested maps, arrays and numbers like the Admin SDK", () => {
    const decoded = decodeFields({
      name: { stringValue: "book" },
      count: { integerValue: "39" },
      rating: { doubleValue: 4.5 },
      missing: { nullValue: null },
      tags: { arrayValue: { values: [{ stringValue: "a" }, { booleanValue: true }] } },
      empty: { arrayValue: {} },
      recordings: {
        mapValue: {
          fields: {
            "2": { mapValue: { fields: { duration: { integerValue: "17865" } } } },
            "1": { mapValue: { fields: { duration: { integerValue: "18874" } } } },
          },
        },
      },
    });

    expect(decoded).toEqual({
      name: "book",
      count: 39,
      rating: 4.5,
      missing: null,
      tags: ["a", true],
      empty: [],
      recordings: { "1": { duration: 18874 }, "2": { duration: 17865 } },
    });
    expect(Object.keys(decoded.recordings as object)).toEqual(["1", "2"]);
  });
});

describe("encodeValue", () => {
  it("stores integers as integerValue, other numbers as doubleValue and undefined as null", () => {
    expect(encodeValue(643)).toEqual({ integerValue: "643" });
    expect(encodeValue(1.5)).toEqual({ doubleValue: 1.5 });
    expect(encodeValue(undefined)).toEqual({ nullValue: null });
    expect(encodeValue("643")).toEqual({ stringValue: "643" });
  });
});

describe("encodeFields", () => {
  it("round-trips timestamps, maps, arrays and integers", () => {
    const at = Date.parse("2026-11-05T12:34:56.789Z");
    const encoded = encodeFields({
      at: new FirestoreTimestamp(at),
      date: new Date(at),
      count: 3,
      ratio: 0.25,
      flag: false,
      list: [{ guid: "b1", at: new FirestoreTimestamp(at) }, 7],
      nested: { inner: { name: "x" } },
    });

    expect(encoded.at).toEqual({ timestampValue: "2026-11-05T12:34:56.789Z" });
    expect(encoded.date).toEqual({ timestampValue: "2026-11-05T12:34:56.789Z" });
    expect(encoded.count).toEqual({ integerValue: "3" });
    expect(encoded.list).toEqual({
      arrayValue: {
        values: [
          {
            mapValue: {
              fields: { guid: { stringValue: "b1" }, at: { timestampValue: "2026-11-05T12:34:56.789Z" } },
            },
          },
          { integerValue: "7" },
        ],
      },
    });

    const decoded = decodeFields(JSON.parse(JSON.stringify(encoded)));
    expect(decoded).toEqual({
      at: "2026-11-05T12:34:56.789Z",
      date: "2026-11-05T12:34:56.789Z",
      count: 3,
      ratio: 0.25,
      flag: false,
      list: [{ guid: "b1", at: "2026-11-05T12:34:56.789Z" }, 7],
      nested: { inner: { name: "x" } },
    });
    expect(timestampMillis(decoded.at)).toBe(at);
    expect(timestampMillis(3)).toBeNull();
    expect(timestampMillis("not a date")).toBeNull();
  });
});

describe("FirestoreError", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function failWith(status: number, body: string): Promise<FirestoreError> {
    clearAccessTokenCacheForTests();
    const env = await createEnv(new FakeKV());
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (String(input) === "https://oauth2.googleapis.com/token") {
        return Response.json({ access_token: "access-token", expires_in: 3600 });
      }
      return new Response(body, { status });
    });
    const error = await batchGet(env, ["projects/p/databases/(default)/documents/a/b"]).catch((e) => e);
    expect(error).toBeInstanceOf(FirestoreError);
    return error;
  }

  it("reads the status name from the error body", async () => {
    const error = await failWith(409, JSON.stringify({ error: { code: 409, status: "ABORTED" } }));

    expect(error.grpcStatus).toBe("ABORTED");
    expect(error.status).toBe(409);
    expect(error.method).toBe("batchGet");
  });

  it("leaves the status name undefined for a body that is not JSON", async () => {
    const error = await failWith(503, "Service Unavailable");

    expect(error.grpcStatus).toBeUndefined();
    expect(error.message).toContain("HTTP 503");
  });
});
