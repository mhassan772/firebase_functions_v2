import { describe, expect, it } from "vitest";
import { decodeFields, encodeValue } from "../src/google/firestore";

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
