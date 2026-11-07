const assert = require("node:assert/strict");
const test = require("node:test");
const { readFileSync } = require("node:fs");
const { packCountries } = require("../scripts/build-country-database.cjs");
const { CountryDatabase } = require("../lib/utils/countryDatabase");
const { clientPublicIp, createAudioDomainResolver, COUNTRY_DATABASE_PATH } = require("../lib/utils/audioCountry");
const { buildGroupedResponse, audioDomainFor, audioDomainForCountry } = require("../lib/shared/getUrlsCore");

const BUNNY = "https://good-storage.b-cdn.net";
const ORIGINAL = "https://books.good-storage.click";
const request = (forwarded, remoteAddress = "127.0.0.1") => ({
  headers: forwarded === undefined ? {} : { "x-forwarded-for": forwarded }, socket: { remoteAddress },
});
const realDatabase = new CountryDatabase(readFileSync(COUNTRY_DATABASE_PATH));

test("bundled full database matches selected and other countries in IPv4/IPv6", () => {
  assert.ok(realDatabase.metadata.countries >= 200);
  for (const [ip, country] of [
    ["197.32.0.1", "EG"], ["41.32.0.1", "EG"], ["2c0f:fc88::1", "EG"],
    ["41.96.0.1", "DZ"], ["2001:4340::1", "DZ"],
    ["77.42.128.1", "LB"], ["2001:67c:1150::1", "LB"],
    ["8.8.8.8", "US"], ["2001:4860:4860::8888", "US"], ["81.2.69.160", "GB"],
  ]) {
    assert.equal(realDatabase.get(ip), country, ip);
    assert.equal(createAudioDomainResolver(() => realDatabase)(request(ip)), ["EG", "DZ", "LB"].includes(country) ? BUNNY : ORIGINAL);
  }
});

test("normalizes IPv4-mapped IPv6 and uses client address before proxies", () => {
  for (const value of ["197.32.0.1, 8.8.8.8", ["197.32.0.1, 8.8.8.8"], " ::ffff:197.32.0.1 ", "::ffff:c520:1"]) {
    assert.equal(clientPublicIp(request(value)), "197.32.0.1");
  }
  assert.equal(clientPublicIp(request(undefined, "197.32.0.1")), "197.32.0.1");
  assert.equal(clientPublicIp(request("8.8.8.8", "197.32.0.1")), "8.8.8.8");
});

test("invalid, missing, private and reserved clients stay unknown without looking up a proxy", () => {
  let lookups = 0;
  const resolve = createAudioDomainResolver(() => ({ get() { lookups++; return "EG"; } }));
  for (const ip of [undefined, "", "bad, 197.32.0.1", "10.0.0.1, 197.32.0.1", "192.168.1.1", "127.0.0.1",
    "169.254.1.1", "100.64.0.1", "0.0.0.0", "255.255.255.255", "224.0.0.1", "::", "::1", "fc00::1",
    "fe80::1", "fe80::1%en0", "ff02::1", "::ffff:10.0.0.1", "192.0.2.1", "2001:db8::1", "197.32.0.1:1234"]) {
    assert.equal(resolve(request(ip)), ORIGINAL, String(ip));
  }
  assert.equal(lookups, 0);
});

test("only explicit EG, DZ and LB use Bunny; unknown lookup and client country headers do not", () => {
  for (const country of ["EG", "DZ", "LB"]) assert.equal(audioDomainForCountry(country), BUNNY);
  for (const country of [undefined, "", "US", "ZZ", "eg"]) assert.equal(audioDomainForCountry(country), ORIGINAL);
  const req = request("8.8.8.8");
  req.headers["cf-ipcountry"] = "EG";
  req.body = { country: "EG" };
  assert.equal(createAudioDomainResolver(() => ({ get: () => undefined }))(req), ORIGINAL);
});

test("a requested provider overrides the country; absent falls back to it", () => {
  for (const country of ["EG", "US", undefined]) {
    assert.equal(audioDomainFor("bunny", country), BUNNY);
    assert.equal(audioDomainFor("cloudflare", country), ORIGINAL);
  }
  assert.equal(audioDomainFor(undefined, "EG"), BUNNY);
  assert.equal(audioDomainFor(undefined, "US"), ORIGINAL);
  assert.equal(audioDomainFor(undefined, undefined), ORIGINAL);
});

test("database loads once per resolver; missing/corrupt data falls back and reports once", () => {
  let loads = 0, errors = 0;
  const resolve = createAudioDomainResolver(() => { loads++; throw new Error("missing database"); }, () => errors++);
  assert.equal(resolve(request("197.32.0.1")), ORIGINAL);
  assert.equal(resolve(request("8.8.8.8")), ORIGINAL);
  assert.equal(loads, 1); assert.equal(errors, 1);
  let goodLoads = 0;
  const good = createAudioDomainResolver(() => { goodLoads++; return realDatabase; });
  good(request("197.32.0.1")); good(request("8.8.8.8"));
  assert.equal(goodLoads, 1);
  const broken = createAudioDomainResolver(() => ({ get() { throw new Error("bad lookup"); } }), () => {});
  assert.equal(broken(request("197.32.0.1")), ORIGINAL);
  assert.throws(() => new CountryDatabase(Buffer.from("not a database")));
  assert.throws(() => new CountryDatabase(readFileSync(COUNTRY_DATABASE_PATH).subarray(0, 100)));
});

test("prefix boundaries, longest-match precedence, and conflicting assignments", () => {
  const database = new CountryDatabase(packCountries([
    { countryCode: "EG", prefixes: { ipv4: ["11.0.0.0/24", "12.0.0.0/24"], ipv6: ["2001:4860:abcd::/48"] } },
    { countryCode: "US", prefixes: { ipv4: ["11.0.0.128/25", "12.0.0.0/24"], ipv6: ["2001:4860:abcd:8000::/49"] } },
  ], "test", "2026-10-29T00:00:00Z"));
  for (const [ip, expected] of [
    ["10.255.255.255", undefined], ["11.0.0.0", "EG"], ["11.0.0.127", "EG"],
    ["11.0.0.128", "US"], ["11.0.0.255", "US"], ["11.0.1.0", undefined], ["12.0.0.1", undefined],
    ["2001:4860:abcc:ffff:ffff:ffff:ffff:ffff", undefined], ["2001:4860:abcd::", "EG"],
    ["2001:4860:abcd:7fff:ffff:ffff:ffff:ffff", "EG"], ["2001:4860:abcd:8000::", "US"],
    ["2001:4860:abcd:ffff:ffff:ffff:ffff:ffff", "US"], ["2001:4860:abce::", undefined],
  ]) assert.equal(database.get(ip), expected, ip);
});

test("country-selected host reaches every recording and keeps Android/iOS path conversion", () => {
  const resolve = createAudioDomainResolver(() => realDatabase);
  for (const [ip, domain] of [["197.32.0.1", BUNNY], ["41.96.0.1", BUNNY], ["77.42.128.1", BUNNY], ["8.8.8.8", ORIGINAL], [undefined, ORIGINAL]]) {
    for (const [platform, ext] of [["android", "opus"], ["ios", "m4a"]]) {
      const result = buildGroupedResponse({ books: [{ bookGuid: "book", quality: 64, reason: "stream" }], platform }, [{
        bookExists: true,
        recordings: {
          a: { name: "one", duration: 1, url_list: { "64kb_url": "/book/1.opus" } },
          b: { name: "two", duration: 2, url_list: { "64kb_url": "book/2.opus" } },
        },
      }], resolve(request(ip)));
      assert.deepEqual(result.book.recordings.map(r => r.url), [`${domain}/book/1.${ext}`, `${domain}/book/2.${ext}`]);
    }
  }
});
