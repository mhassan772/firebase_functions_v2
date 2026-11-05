const assert = require("node:assert/strict");
const test = require("node:test");
const {
  DAY_MS,
  DEFAULT_URL_POLICY,
  allowanceFor,
  decideGrants,
  parseUrlPolicy,
  policyApplies,
  refusalEntry,
  summarizeGrants,
  tierFor,
} = require("../lib/shared/urlPolicy");

const NOW = 1_762_300_000_000;
const HOUR = 3600 * 1000;
const ago = (hours) => NOW - hours * HOUR;
const entry = (guid, hoursAgo) => ({ guid, at: ago(hoursAgo) });

function ledger({ knownBooks = [], knownSamples = [], recentBooks = [], recentSamples = [] } = {}) {
  return { knownBooks: new Set(knownBooks), knownSamples: new Set(knownSamples), recentBooks, recentSamples };
}

function decide({ books, state = ledger(), device = null, allowance = { books: 2, samples: 2 }, enforce = true }) {
  return decideGrants({ books, ledger: state, device, allowance, enforce, nowMs: NOW });
}

const stream = (guid) => ({ guid, reason: "stream" });
const sample = (guid) => ({ guid, reason: "sample" });

test("parseUrlPolicy returns null for a missing or non-object block", () => {
  assert.equal(parseUrlPolicy(undefined), null);
  assert.equal(parseUrlPolicy(null), null);
  assert.equal(parseUrlPolicy("on"), null);
});

test("parseUrlPolicy fills an empty block with the defaults", () => {
  assert.deepEqual(parseUrlPolicy({}), DEFAULT_URL_POLICY);
});

test("parseUrlPolicy parses numeric strings and keeps defaults for invalid values", () => {
  const policy = parseUrlPolicy({
    minBuild: "616",
    enforce: true,
    appCheckTier: false,
    newAccountDays: -3,
    linkTtlHours: "abc",
    keyVersion: 2,
    attested: { guest: { books: "3" }, premium: "x" },
  });
  assert.equal(policy.minBuild, 616);
  assert.equal(policy.enforce, true);
  assert.equal(policy.appCheckTier, false);
  assert.equal(policy.newAccountDays, DEFAULT_URL_POLICY.newAccountDays);
  assert.equal(policy.linkTtlHours, DEFAULT_URL_POLICY.linkTtlHours);
  assert.equal(policy.keyVersion, "2");
  assert.deepEqual(policy.attested.guest, { books: 3, samples: DEFAULT_URL_POLICY.attested.guest.samples });
  assert.deepEqual(policy.attested.premium, DEFAULT_URL_POLICY.attested.premium);
  assert.deepEqual(policy.unattested, DEFAULT_URL_POLICY.unattested);
});

test("parseUrlPolicy turns enforce on only for true", () => {
  assert.equal(parseUrlPolicy({ enforce: "true" }).enforce, false);
});

test("policyApplies gates by build", () => {
  assert.equal(policyApplies(null, "999"), false);
  const everyBuild = parseUrlPolicy({ minBuild: 0 });
  assert.equal(policyApplies(everyBuild, undefined), true);
  const gated = parseUrlPolicy({ minBuild: 616 });
  assert.equal(policyApplies(gated, "615"), false);
  assert.equal(policyApplies(gated, "616"), true);
  assert.equal(policyApplies(gated, 700), true);
  assert.equal(policyApplies(gated, undefined), false);
  assert.equal(policyApplies(gated, "abc"), false);
});

test("tierFor: premium beats guest and age, guests stay guests, young accounts are new", () => {
  const policy = parseUrlPolicy({ newAccountDays: 10 });
  const id = (over) => ({ anonymous: false, createdAtMs: null, premium: false, attested: true, ...over });
  assert.equal(tierFor(id({ premium: true, anonymous: true }), policy, NOW), "premium");
  assert.equal(tierFor(id({ premium: true, createdAtMs: NOW }), policy, NOW), "premium");
  assert.equal(tierFor(id({ anonymous: true, createdAtMs: NOW - 400 * DAY_MS }), policy, NOW), "guest");
  assert.equal(tierFor(id({ createdAtMs: NOW - 9 * DAY_MS }), policy, NOW), "newAccount");
  assert.equal(tierFor(id({ createdAtMs: NOW - 10 * DAY_MS }), policy, NOW), "free");
  assert.equal(tierFor(id({ createdAtMs: null }), policy, NOW), "free");
});

test("allowanceFor picks the table by attestation unless appCheckTier is off", () => {
  const identity = { anonymous: true, createdAtMs: null, premium: false, attested: false };
  const tiered = allowanceFor(identity, parseUrlPolicy({}), NOW);
  assert.deepEqual(tiered, { tier: "guest", attested: false, allowance: DEFAULT_URL_POLICY.unattested.guest });

  const attested = allowanceFor({ ...identity, attested: true }, parseUrlPolicy({}), NOW);
  assert.deepEqual(attested.allowance, DEFAULT_URL_POLICY.attested.guest);

  const flat = allowanceFor(identity, parseUrlPolicy({ appCheckTier: false }), NOW);
  assert.equal(flat.attested, true);
  assert.deepEqual(flat.allowance, DEFAULT_URL_POLICY.attested.guest);
});

test("known books are free; new books are taken in request order until the allowance", () => {
  const result = decide({
    books: [stream("n1"), stream("k"), stream("n2"), stream("n3")],
    state: ledger({ knownBooks: ["k"] }),
  });
  assert.deepEqual(
    result.decisions.map((d) => [d.guid, d.granted, d.known, d.used]),
    [["n1", true, false, 1], ["k", true, true, 1], ["n2", true, false, 2], ["n3", false, false, 2]]
  );
  assert.deepEqual(result.newEntries, [
    { guid: "n1", kind: "books", reason: "stream" },
    { guid: "n2", kind: "books", reason: "stream" },
  ]);
  assert.deepEqual(result.ledger.recentBooks.map((e) => e.guid), ["n1", "n2"]);
  assert.deepEqual(result.wouldRefuse, ["n3"]);
});

test("a refusal waits for the oldest binding entry to leave the window", () => {
  const result = decide({ books: [stream("c")], state: ledger({ recentBooks: [entry("b", 10), entry("a", 20)] }) });
  const [decision] = result.decisions;
  assert.equal(decision.granted, false);
  assert.equal(decision.retryAfterSeconds, 4 * 3600);
  assert.deepEqual(refusalEntry(decision), {
    error: 609,
    retryAfterSeconds: 4 * 3600,
    allowance: 2,
    used: 2,
    kind: "books",
  });
  assert.deepEqual(result.newEntries, []);
});

test("retryAfterSeconds is at least a minute", () => {
  const result = decide({
    books: [stream("c")],
    state: ledger({ recentBooks: [{ guid: "a", at: NOW - DAY_MS + 1000 }] }),
    allowance: { books: 1, samples: 1 },
  });
  assert.equal(result.decisions[0].retryAfterSeconds, 60);
});

test("refusalEntry defaults retryAfterSeconds to 60", () => {
  assert.equal(refusalEntry({ guid: "x", kind: "samples", granted: false, known: false, allowance: 1, used: 1 }).retryAfterSeconds, 60);
});

test("entries older than 24 hours are pruned and no longer count", () => {
  const result = decide({
    books: [stream("new")],
    state: ledger({ recentBooks: [entry("old", 25), entry("edge", 24), entry("fresh", 1)] }),
  });
  assert.equal(result.decisions[0].granted, true);
  assert.deepEqual(result.ledger.recentBooks.map((e) => e.guid), ["fresh", "new"]);
});

test("a known sample does not make the full book known", () => {
  const result = decide({
    books: [stream("x")],
    state: ledger({ knownSamples: ["x"], recentBooks: [entry("a", 1), entry("b", 2)] }),
  });
  assert.equal(result.decisions[0].known, false);
  assert.equal(result.decisions[0].granted, false);
});

test("a known full book covers its sample", () => {
  const result = decide({
    books: [sample("x")],
    state: ledger({ knownBooks: ["x"], recentSamples: [entry("a", 1), entry("b", 2)] }),
  });
  assert.deepEqual(
    [result.decisions[0].kind, result.decisions[0].granted, result.decisions[0].known],
    ["samples", true, true]
  );
  assert.deepEqual(result.newEntries, []);
});

test("samples and books have separate allowances", () => {
  const result = decide({
    books: [sample("s1"), sample("s2"), stream("b1")],
    allowance: { books: 1, samples: 1 },
  });
  assert.deepEqual(result.decisions.map((d) => [d.guid, d.kind, d.granted]), [
    ["s1", "samples", true],
    ["s2", "samples", false],
    ["b1", "books", true],
  ]);
  assert.deepEqual(result.ledger.recentSamples.map((e) => e.guid), ["s1"]);
});

test("duplicate guids collapse to the strongest reason in first-seen order", () => {
  const result = decide({
    books: [sample("x"), stream("y"), { guid: "x", reason: "download" }, sample("y")],
  });
  assert.deepEqual(result.decisions.map((d) => [d.guid, d.kind]), [["x", "books"], ["y", "books"]]);
  assert.deepEqual(result.newEntries, [
    { guid: "x", kind: "books", reason: "download" },
    { guid: "y", kind: "books", reason: "stream" },
  ]);
});

test("a guest's device list binds when it is longer than the account's", () => {
  const result = decide({
    books: [stream("c")],
    state: ledger({ recentBooks: [entry("a", 2)] }),
    device: { recentBooks: [entry("a", 2), entry("z", 20)], recentSamples: [] },
  });
  const [decision] = result.decisions;
  assert.equal(decision.granted, false);
  assert.equal(decision.used, 2);
  assert.equal(decision.retryAfterSeconds, 4 * 3600);
});

test("a guest's grant is added to both the account and the device list", () => {
  const result = decide({
    books: [stream("c")],
    state: ledger(),
    device: { recentBooks: [entry("z", 25), entry("y", 3)], recentSamples: [] },
  });
  assert.equal(result.decisions[0].granted, true);
  assert.deepEqual(result.ledger.recentBooks.map((e) => e.guid), ["c"]);
  assert.deepEqual(result.device.recentBooks.map((e) => e.guid), ["y", "c"]);
});

test("with enforce off everything is granted and the over-limit books are listed", () => {
  const result = decide({
    books: [stream("a"), stream("b"), stream("c")],
    allowance: { books: 1, samples: 1 },
    enforce: false,
  });
  assert.ok(result.decisions.every((d) => d.granted));
  assert.deepEqual(result.wouldRefuse, ["b", "c"]);
  assert.equal(result.newEntries.length, 3);
  assert.deepEqual(summarizeGrants(result), { granted: 3, known: 0, refused: 0, wouldRefuse: 2 });
});

test("with enforce off the recent lists are capped at 500 entries, newest kept", () => {
  const many = Array.from({ length: 600 }, (_, i) => ({ guid: `g${i}`, at: NOW - 600 + i }));
  const result = decide({
    books: [stream("new")],
    state: ledger({ recentBooks: many }),
    device: { recentBooks: many.slice(), recentSamples: [] },
    allowance: { books: 1, samples: 1 },
    enforce: false,
  });
  assert.equal(result.ledger.recentBooks.length, 500);
  assert.equal(result.ledger.recentBooks.at(-1).guid, "new");
  assert.equal(result.device.recentBooks.length, 500);

  const enforced = decide({ books: [stream("new")], state: ledger({ recentBooks: many }), enforce: true });
  assert.equal(enforced.ledger.recentBooks.length, 600);
});

test("summarizeGrants counts known and refused decisions", () => {
  const result = decide({
    books: [stream("k"), stream("n1"), stream("n2")],
    state: ledger({ knownBooks: ["k"] }),
    allowance: { books: 1, samples: 1 },
  });
  assert.deepEqual(summarizeGrants(result), { granted: 2, known: 1, refused: 1, wouldRefuse: 1 });
});

test("an allowance of zero refuses with a whole-day wait instead of crashing", () => {
  const { decideGrants } = require("../lib/shared/urlPolicy");
  const result = decideGrants({
    books: [{ guid: "b1", reason: "stream" }],
    ledger: { knownBooks: new Set(), knownSamples: new Set(), recentBooks: [], recentSamples: [] },
    device: null,
    allowance: { books: 0, samples: 0 },
    enforce: true,
    nowMs: 1_762_300_000_000,
  });
  assert.equal(result.decisions[0].granted, false);
  assert.equal(result.decisions[0].retryAfterSeconds, 86400);
});
