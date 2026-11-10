const assert = require("node:assert/strict");
const test = require("node:test");
const {
  DEFAULT_SHOW,
  boundedMonths,
  changedDays,
  closesAtMs,
  goalFromData,
  goalKey,
  hijriMonthBounds,
  hijriOfDay,
  isGoalOpen,
  mergeDays,
  monthValue,
  newGoalFields,
  nextMonthEntry,
  pace,
  parseGoalKey,
  secondsByDay,
  shiftHijriMonth,
  touchedGoals,
  yearOfDay,
  yearsOfWindow,
} = require("../lib/handlers/communityGoalHandlers");

const day = (iso) => Date.UTC(...iso.split("-").map((part, i) => Number(part) - (i === 1 ? 1 : 0))) / 86_400_000;
const row = (d, dayNumber, cs, extra = {}) => ({ d, day: dayNumber, m: 1, ss: 0, sl: 0, g: 0, u: 0, ...extra, ...(cs === undefined ? {} : { cs }) });
const goal = (overrides = {}) => ({
  key: "h144805",
  firstDay: day("2026-10-12"),
  lastDay: day("2026-11-10"),
  dailyCapSeconds: 43_200,
  closeAfterDays: 3,
  status: "open",
  ...overrides,
});

test("goal keys are h, the Hijri year and a two-digit month, and parse back", () => {
  assert.equal(goalKey(1448, 7), "h144807");
  assert.equal(goalKey(1448, 12), "h144812");
  assert.deepEqual(parseGoalKey("h144807"), { hijriYear: 1448, hijriMonth: 7 });
  assert.equal(parseGoalKey("h144813"), null);
  assert.equal(parseGoalKey("x144807"), null);
  assert.deepEqual(shiftHijriMonth(1448, 12, 1), { hijriYear: 1449, hijriMonth: 1 });
  assert.deepEqual(shiftHijriMonth(1448, 1, -1), { hijriYear: 1447, hijriMonth: 12 });
});

test("closesAt is the day after the last day plus the grace days, in UTC", () => {
  const g = goal();
  assert.equal(closesAtMs(g), Date.parse("2026-11-14T00:00:00Z"));
  assert.equal(isGoalOpen(g, Date.parse("2026-11-13T23:59:59Z")), true);
  assert.equal(isGoalOpen(g, Date.parse("2026-11-14T00:00:00Z")), false);
  assert.equal(isGoalOpen({ ...g, status: "closed" }, Date.parse("2026-11-01T00:00:00Z")), false);
});

test("goalFromData needs a valid window and falls back to the default cap and grace", () => {
  assert.equal(goalFromData("h144805", { firstDay: 10, lastDay: 9 }), null);
  assert.equal(goalFromData("h144805", { firstDay: "10", lastDay: 20 }), null);
  assert.deepEqual(goalFromData("h144805", { firstDay: 10, lastDay: 20, dailyCapSeconds: -1, status: "closed" }), {
    key: "h144805",
    firstDay: 10,
    lastDay: 20,
    dailyCapSeconds: 43_200,
    closeAfterDays: 3,
    status: "closed",
  });
});

test("seconds per day add devices together and count an absent or invalid cs as 0", () => {
  const d = day("2026-11-01");
  const chunk = {
    days: [
      row("phone", d, 600),
      row("tablet", d, 300, { z: 1, v: 2, unknown: "kept" }),
      row("watch", d, undefined),
      row("old", d, -5),
      row("bad", d, "100"),
      row("inf", d, Infinity),
      row("phone", d + 1, 50.5),
      { d: "phone", day: "x", cs: 99 },
      null,
    ],
  };
  const days = secondsByDay(chunk);
  assert.equal(days.get(d), 900);
  assert.equal(days.get(d + 1), 50.5);
  assert.equal(days.size, 2);
  assert.equal(secondsByDay(undefined).size, 0);
  assert.equal(secondsByDay({ days: "nope" }).size, 0);
});

test("a year filter skips a row filed in the wrong year's chunk", () => {
  const chunk = { days: [row("phone", day("2026-12-31"), 100), row("phone", day("2027-01-01"), 200)] };
  assert.deepEqual([...secondsByDay(chunk, 2026).values()], [100]);
  assert.deepEqual([...secondsByDay(chunk, 2027).values()], [200]);
  assert.equal(yearOfDay(day("2026-12-31")), 2026);
  assert.equal(yearOfDay(day("2027-01-01")), 2027);
});

test("the month value caps each day and ignores days outside the window or beyond tomorrow", () => {
  const g = goal({ dailyCapSeconds: 3600 });
  const today = day("2026-10-20");
  const days = new Map([
    [g.firstDay - 1, 1000], // before the window
    [g.firstDay, 5000], // capped to 3600
    [g.firstDay + 1, 1200],
    [today + 1, 100], // tomorrow: a zone ahead of UTC
    [today + 2, 999], // a wrong clock
    [g.lastDay + 1, 777],
  ]);
  assert.equal(monthValue(days, g, today), 3600 + 1200 + 100);
  assert.equal(monthValue(days, { ...g, dailyCapSeconds: 0 }, today), 0);
  // Two devices on one day share the cap.
  const two = secondsByDay({ days: [row("a", g.firstDay, 30_000), row("b", g.firstDay, 30_000)] });
  assert.equal(monthValue(two, goal(), today), 43_200);
});

test("a window crossing 1 January spans both years and merges their days", () => {
  const rajab = hijriMonthBounds(1448, 7);
  assert.deepEqual(yearsOfWindow(rajab), [2026, 2027]);
  assert.deepEqual(yearsOfWindow(goal()), [2026]);
  const g = goal({ key: "h144807", ...rajab });
  const days = mergeDays(
    secondsByDay({ days: [row("a", day("2026-12-31"), 100)] }, 2026),
    secondsByDay({ days: [row("a", day("2027-01-01"), 200)] }, 2027),
  );
  assert.equal(monthValue(days, g, day("2027-01-05")), 300);
});

test("only goals with a changed day inside their window, and no later than tomorrow, are touched", () => {
  const a = goal();
  const b = goal({ key: "h144806", firstDay: a.lastDay + 1, lastDay: a.lastDay + 29 });
  const today = a.lastDay;
  const before = { days: [row("p", a.lastDay, 100), row("p", a.lastDay - 1, 50, { m: 1 })] };
  const same = { days: [row("p", a.lastDay, 100), row("p", a.lastDay - 1, 50, { m: 2, z: 9 })] };
  assert.deepEqual(changedDays(before, same), new Set());
  assert.deepEqual(touchedGoals([a, b], before, same, today), []);
  const grown = { days: [...same.days, row("p", a.lastDay + 1, 10)] };
  assert.deepEqual(touchedGoals([a, b], before, grown, today).map((g) => g.key), ["h144806"]);
  const far = { days: [...same.days, row("p", a.lastDay + 2, 10)] };
  assert.deepEqual(touchedGoals([a, b], before, far, today), []);
  // A deleted document touches every goal it had days in.
  assert.deepEqual(touchedGoals([a, b], before, undefined, today).map((g) => g.key), ["h144805"]);
});

test("the 61st month removes the oldest key; a month older than all 60 is not written", () => {
  const keys = Array.from({ length: 60 }, (_, i) => goalKey(1443 + Math.floor(i / 12), (i % 12) + 1));
  assert.deepEqual(boundedMonths(keys, "h144801"), { write: true, remove: ["h144301"] });
  assert.deepEqual(boundedMonths(keys, keys[10]), { write: true, remove: [] });
  assert.deepEqual(boundedMonths(keys, "h144212"), { write: false, remove: [] });
  assert.deepEqual(boundedMonths(["h144801"], "h144802"), { write: true, remove: [] });
  // Anything that is not a goal key goes first.
  assert.deepEqual(boundedMonths([...keys.slice(1), "junk"], "h144801").remove, ["junk"]);
});

test("the entry sets a always and c only while open, and is null when nothing changes", () => {
  assert.equal(nextMonthEntry(undefined, 0, true), null);
  assert.deepEqual(nextMonthEntry(undefined, 50, true), { c: 50, a: 50 });
  assert.equal(nextMonthEntry({ c: 50, a: 50 }, 50, true), null);
  assert.deepEqual(nextMonthEntry({ c: 50, a: 50 }, 20, true), { c: 20, a: 20 });
  assert.deepEqual(nextMonthEntry({ c: 50, a: 50 }, 80, false), { a: 80 });
  assert.equal(nextMonthEntry({ c: 50, a: 80 }, 80, false), null);
  assert.deepEqual(nextMonthEntry({ c: 50, a: 50 }, 0, true), { c: 0, a: 0 });
});

test("pace has one day of allowance and is clamped at both edges", () => {
  const base = { firstDay: 100, lastDay: 129, targetHours: 30 };
  assert.equal(pace({ ...base, targetHours: null, totalSeconds: 0 }, 110), null);
  assert.equal(pace({ ...base, targetHours: 0, totalSeconds: 0 }, 110), null);
  // Before the start: nothing expected yet.
  const early = pace({ ...base, totalSeconds: 0 }, 90);
  assert.equal(early.elapsed, 0);
  assert.equal(early.expected, 0);
  assert.equal(early.state, "onPlan");
  // First day: still nothing expected.
  assert.equal(pace({ ...base, totalSeconds: 0 }, 100).expected, 0);
  // After the end: everything expected, and never more than everything.
  const late = pace({ ...base, totalSeconds: 31 * 3600 }, 200);
  assert.equal(late.elapsed, 30);
  assert.equal(late.expected, 29 / 30);
  assert.equal(late.state, "ahead");
  // Two days ahead, half a day ahead, two days behind.
  const day11 = { ...base, totalSeconds: 0 };
  assert.equal(pace({ ...day11, totalSeconds: 12 * 3600 }, 110).state, "ahead");
  assert.equal(pace({ ...day11, totalSeconds: 10.5 * 3600 }, 110).state, "onPlan");
  assert.equal(pace({ ...day11, totalSeconds: 8 * 3600 }, 110).state, "behind");
});

test("hijriMonthBounds follows Umm al-Qura: 1 Ramadan 1448 is 8 February 2027", () => {
  const ramadan = hijriMonthBounds(1448, 9);
  assert.equal(ramadan.firstDay, day("2027-02-08"));
  assert.equal(ramadan.lastDay - ramadan.firstDay + 1, 29);
  const jumada = hijriMonthBounds(1448, 5);
  assert.equal(jumada.lastDay - jumada.firstDay + 1, 30);
  assert.deepEqual(hijriOfDay(day("2027-02-08")), { hijriYear: 1448, hijriMonth: 9, hijriDay: 1 });
  assert.deepEqual(hijriOfDay(day("2026-11-10")), { hijriYear: 1448, hijriMonth: 5, hijriDay: 30 });
});

test("consecutive Hijri months are contiguous across two years, and each is 29 or 30 days", () => {
  let previous = null;
  for (let index = 0; index < 24; index++) {
    const { hijriYear, hijriMonth } = shiftHijriMonth(1447, 1, index);
    const bounds = hijriMonthBounds(hijriYear, hijriMonth);
    const length = bounds.lastDay - bounds.firstDay + 1;
    assert.ok(length === 29 || length === 30, `${hijriYear}-${hijriMonth} has ${length} days`);
    if (previous) {
      assert.equal(bounds.firstDay, previous.lastDay + 1, `${hijriYear}-${hijriMonth} follows its previous month`);
    }
    previous = bounds;
  }
});

test("a new month takes the defaults when there is no previous month", () => {
  const bounds = hijriMonthBounds(1448, 6);
  assert.deepEqual(newGoalFields(1448, 6, bounds, undefined), {
    hijriYear: 1448,
    hijriMonth: 6,
    firstDay: bounds.firstDay,
    lastDay: bounds.lastDay,
    targetHours: null,
    dailyCapSeconds: 43_200,
    closeAfterDays: 3,
    show: DEFAULT_SHOW,
    auto: true,
    status: "open",
    totalSeconds: 0,
  });
  assert.deepEqual(DEFAULT_SHOW, { participants: false, pace: false, target: false, history: true });
});

test("a new month copies the previous month's settings, and its start follows an edited end", () => {
  const bounds = hijriMonthBounds(1448, 6);
  const previous = {
    lastDay: bounds.firstDay + 1, // the portal moved the end two days later
    targetHours: 5000,
    dailyCapSeconds: 7200,
    closeAfterDays: 5,
    show: { participants: true, pace: true },
    totalSeconds: 999,
    status: "closed",
    auto: false,
  };
  const fields = newGoalFields(1448, 6, bounds, previous);
  assert.equal(fields.firstDay, bounds.firstDay + 2);
  assert.equal(fields.lastDay, bounds.lastDay);
  assert.equal(fields.targetHours, 5000);
  assert.equal(fields.dailyCapSeconds, 7200);
  assert.equal(fields.closeAfterDays, 5);
  assert.deepEqual(fields.show, { participants: true, pace: true, target: false, history: false });
  assert.equal(fields.auto, true);
  assert.equal(fields.status, "open");
  assert.equal(fields.totalSeconds, 0);
  // An end moved past the whole next month never leaves a last day before the first.
  const beyond = newGoalFields(1448, 6, bounds, { ...previous, lastDay: bounds.lastDay + 5 });
  assert.equal(beyond.firstDay, bounds.lastDay + 6);
  assert.equal(beyond.lastDay, beyond.firstDay);
  // An earlier end moves the start earlier.
  assert.equal(newGoalFields(1448, 6, bounds, { ...previous, lastDay: bounds.firstDay - 3 }).firstDay, bounds.firstDay - 2);
});
