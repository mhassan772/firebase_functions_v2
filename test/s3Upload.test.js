const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const { readAlongFileKey, validateReadAlongRequest } = require("../lib/handlers/s3Handlers");
const { generateHashedFolderName } = require("../lib/utils/secrets");

const VALID = {
  bucket_name: "bucket",
  region: "us-east-2",
  type: "read_along",
  id: "1234",
  recording_key: "7",
  content_hash: "0123456789abcdef",
  content_type: "application/json",
};

test("a read-along key sits in the PDF's folder, named by recording and content hash", () => {
  const folder = generateHashedFolderName("seed", "1234", "pdf");
  assert.equal(folder, crypto.createHash("sha1").update("seed1234pdf", "utf8").digest("hex"));
  assert.equal(
    readAlongFileKey(folder, "1234", "7", "0123456789abcdef"),
    `1234/${folder}/read_along/7_0123456789abcdef.json`
  );
});

test("a well-formed read-along request passes", () => {
  assert.equal(validateReadAlongRequest(VALID), null);
});

test("other types are not checked by the read-along rules", () => {
  assert.equal(validateReadAlongRequest({ type: "pdf", id: "1234", file_key: "x/y.pdf" }), null);
  assert.equal(validateReadAlongRequest({ type: "image", id: "abc" }), null);
  assert.equal(validateReadAlongRequest(undefined), null);
});

test("recording_key must be a positive integer string", () => {
  for (const recording_key of [undefined, "", "0", "01", "-1", "1.5", " 1", "1a", "../1", 7]) {
    const error = validateReadAlongRequest({ ...VALID, recording_key });
    assert.equal(error?.code, 400, `recording_key ${JSON.stringify(recording_key)}`);
  }
  assert.equal(validateReadAlongRequest({ ...VALID, recording_key: "120" }), null);
});

test("content_hash must be exactly 16 lowercase hex characters", () => {
  for (const content_hash of [
    undefined,
    "",
    "0123456789abcde",
    "0123456789abcdef0",
    "0123456789ABCDEF",
    "0123456789abcdeg",
    "0123456789abcde/",
    1234567890123456,
  ]) {
    const error = validateReadAlongRequest({ ...VALID, content_hash });
    assert.equal(error?.code, 400, `content_hash ${JSON.stringify(content_hash)}`);
  }
});

test("the id must be a positive integer string, so the key cannot leave the book's folder", () => {
  for (const id of [undefined, "", "0", "12/34", "..", "12a", 1234]) {
    const error = validateReadAlongRequest({ ...VALID, id });
    assert.equal(error?.code, 400, `id ${JSON.stringify(id)}`);
  }
});

test("a read-along request may not name its own file_key", () => {
  const error = validateReadAlongRequest({ ...VALID, file_key: "1234/other/1.pdf" });
  assert.equal(error?.code, 400);
});

test("the content type must be application/json", () => {
  for (const content_type of [undefined, "application/octet-stream", "text/json"]) {
    const error = validateReadAlongRequest({ ...VALID, content_type });
    assert.equal(error?.code, 400, `content_type ${JSON.stringify(content_type)}`);
  }
});
