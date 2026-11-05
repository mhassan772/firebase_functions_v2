const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const { signAudioUrl, uidHash } = require("../lib/shared/audioSigning");

const SECRETS = { cloudflare: "cf-secret", bunny: "bunny-secret", keyVersion: "1" };
const ISSUED = 1762300000;
const TTL = 604800;
const PATH = "12/abc/12/64/64_1.opus";

const hmac = (secret, message) => crypto.createHmac("sha256", secret).update(message).digest("base64url");

test("uidHash is the first 8 hex characters of SHA-256(uid)", async () => {
  const expected = crypto.createHash("sha256").update("user-1").digest("hex").slice(0, 8);
  assert.equal(expected, "c6c289e4");
  assert.equal(await uidHash("user-1"), expected);
  assert.match(await uidHash("another-uid"), /^[0-9a-f]{8}$/);
});

test("Cloudflare links carry the timed HMAC as the last parameter", async () => {
  const u = await uidHash("user-1");
  const url = await signAudioUrl("https://books.good-storage.click", PATH, { uidHash: u, issuedAtSec: ISSUED, ttlSec: TTL }, SECRETS);
  const mac = hmac("cf-secret", `/${PATH}?u=${u}&k=1` + String(ISSUED));
  assert.equal(url, `https://books.good-storage.click/${PATH}?u=${u}&k=1&verify=${ISSUED}-${mac}`);
});

test("Bunny links carry the HS256 token and the expiry", async () => {
  const u = await uidHash("user-1");
  const url = await signAudioUrl("https://good-storage.b-cdn.net", PATH, { uidHash: u, issuedAtSec: ISSUED, ttlSec: TTL }, SECRETS);
  const expires = ISSUED + TTL;
  assert.equal(expires, 1762904800);
  const mac = hmac("bunny-secret", `/${PATH}` + String(expires) + `k=1&u=${u}`);
  assert.equal(url, `https://good-storage.b-cdn.net/${PATH}?u=${u}&k=1&token=HS256-${mac}&expires=${expires}`);
});

test("leading slashes on the path and a trailing slash on the domain are ignored", async () => {
  const context = { uidHash: "c6c289e4", issuedAtSec: ISSUED, ttlSec: TTL };
  const clean = await signAudioUrl("https://books.good-storage.click", PATH, context, SECRETS);
  assert.equal(await signAudioUrl("https://books.good-storage.click/", `//${PATH}`, context, SECRETS), clean);
  const bunny = await signAudioUrl("https://good-storage.b-cdn.net", PATH, context, SECRETS);
  assert.equal(await signAudioUrl("https://good-storage.b-cdn.net", `/${PATH}`, context, SECRETS), bunny);
});

test("the CDN is chosen by a .b-cdn.net host only", async () => {
  const context = { uidHash: "c6c289e4", issuedAtSec: ISSUED, ttlSec: TTL };
  assert.match(await signAudioUrl("https://GOOD-storage.B-CDN.net", PATH, context, SECRETS), /token=HS256-/);
  assert.match(await signAudioUrl("https://b-cdn.net.example.com", PATH, context, SECRETS), /verify=/);
});
