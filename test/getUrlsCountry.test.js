const assert = require("node:assert/strict");
const test = require("node:test");
const { buildGroupedResponse, buildSuccessResponse } = require("../lib/shared/getUrlsCore");

// Replace only authentication and Firestore I/O; exercise the real HTTP entry
// point, IP extraction, bundled country lookup and URL builder together.
const authenticationPath = require.resolve("../lib/utils/authentication");
const handlerPath = require.resolve("../lib/handlers/downloadHandlers");
require.cache[authenticationPath] = { id: authenticationPath, filename: authenticationPath, loaded: true,
  exports: { validateRequestAuthentication: async () => ({ uid: "test-user" }) } };
require.cache[handlerPath] = { id: handlerPath, filename: handlerPath, loaded: true,
  exports: { handleGetUrls: async (request, uid, domain) => {
    assert.equal(uid, "test-user");
    return buildSuccessResponse(buildGroupedResponse(request, [{ bookExists: true, recordings: {
      one: { name: "Chapter", duration: 1, url_list: { "64kb_url": "/book/1.opus" } },
    } }], domain));
  } } };
const { getUrls } = require("../lib/functions/downloads/getUrls");

for (const [ip, domain] of [
  ["197.32.0.1", "https://good-storage.b-cdn.net"],
  ["2c0f:fc88::1", "https://good-storage.b-cdn.net"],
  ["41.96.0.1", "https://good-storage.b-cdn.net"],
  ["2001:4340::1", "https://good-storage.b-cdn.net"],
  ["77.42.128.1", "https://good-storage.b-cdn.net"],
  ["2001:67c:1150::1", "https://good-storage.b-cdn.net"],
  ["8.8.8.8", "https://books.good-storage.click"],
  [undefined, "https://books.good-storage.click"],
]) {
  test(`Firebase getUrls HTTP handler returns the selected host for ${ip}`, async () => {
    const req = {
      method: "POST",
      headers: ip ? { "x-forwarded-for": `${ip}, 127.0.0.1` } : {},
      socket: { remoteAddress: "127.0.0.1" },
      body: { books: [{ bookGuid: "book", quality: 64, reason: "stream" }], platform: "ios", country: "EG" },
    };
    let status, body;
    const res = { status(code) { status = code; return this; }, json(value) { body = value; return this; } };
    await getUrls(req, res);
    assert.equal(status, 200);
    assert.equal(body.data.book.recordings[0].url, `${domain}/book/1.m4a`);
  });
}
