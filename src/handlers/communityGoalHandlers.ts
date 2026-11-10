// Pure logic for the monthly community listening goal, shared by its triggers, its hourly job and
// the tests. Like listenStatsHandlers, it must not import firebase-admin at runtime.
// See docs/community-goal.md.

/** One document per Hijri month, readable by anyone. */
export const COMMUNITY_GOALS_COLLECTION = "community_goals";

/** One document per Hijri month with the numbers only admins see, and the recount's progress. */
export const COMMUNITY_GOAL_STATS_COLLECTION = "community_goal_stats";

/** The app's listening history: an index document per user, and per year a `chunks/{year}` days document. */
export const LISTENING_HISTORY_COLLECTION = "listening_history";
export const LISTENING_HISTORY_CHUNKS = "chunks";

/** The map in `listener_totals/{uid}` holding a user's value per month. */
export const MONTHS_FIELD = "months";

/** Months kept per user; the oldest goes when another is added. */
export const MAX_MONTHS = 60;

export const DAY_MS = 86_400_000;

export const DEFAULT_DAILY_CAP_SECONDS = 43_200;
export const DEFAULT_CLOSE_AFTER_DAYS = 3;
export const DEFAULT_SHOW: GoalShow = { participants: false, pace: false, target: false, history: true };

/** The goal fields the admin portal may change; everything else is the server's. */
export const PORTAL_EDITABLE_FIELDS = [
  "firstDay",
  "lastDay",
  "targetHours",
  "dailyCapSeconds",
  "closeAfterDays",
  "show",
  "auto",
  "recount",
  "participants",
  "updatedAt",
  "updatedBy",
] as const;

export interface GoalShow {
  participants: boolean;
  pace: boolean;
  target: boolean;
  history: boolean;
}

/** What the counting needs from a goal document. */
export interface GoalWindow {
  key: string;
  firstDay: number;
  lastDay: number;
  dailyCapSeconds: number;
  closeAfterDays: number;
  status: "open" | "closed";
}

/** A user's stored value for one month: counted and actual seconds. */
export interface MonthEntry {
  c?: number;
  a?: number;
}

/** The days of one Hijri month in the Umm al-Qura calendar, as goal days. */
export interface HijriMonthBounds {
  firstDay: number;
  lastDay: number;
}

const isInt = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);

/** `h{hijriYear}{MM}`: letters and digits only, so it is safe as a field-path segment. */
export function goalKey(hijriYear: number, hijriMonth: number): string {
  return `h${hijriYear}${String(hijriMonth).padStart(2, "0")}`;
}

/** The Hijri year and month a key names, or null when it is not a goal key. */
export function parseGoalKey(key: string): { hijriYear: number; hijriMonth: number } | null {
  const match = /^h(\d+)(\d\d)$/.exec(key);
  if (!match) {
    return null;
  }
  const hijriMonth = Number(match[2]);
  return hijriMonth >= 1 && hijriMonth <= 12 ? { hijriYear: Number(match[1]), hijriMonth } : null;
}

/** The month before or after a Hijri month. */
export function shiftHijriMonth(hijriYear: number, hijriMonth: number, by: number): { hijriYear: number; hijriMonth: number } {
  const index = hijriYear * 12 + (hijriMonth - 1) + by;
  return { hijriYear: Math.floor(index / 12), hijriMonth: (index % 12) + 1 };
}

/** The goal day of a UTC instant. */
export function utcDay(ms: number): number {
  return Math.floor(ms / DAY_MS);
}

/** The year of the chunk that holds a goal day: the UTC year of its date. */
export function yearOfDay(day: number): number {
  return new Date(day * DAY_MS).getUTCFullYear();
}

/** Never stored: derived everywhere by this one rule. */
export function closesAtMs(goal: { lastDay: number; closeAfterDays: number }): number {
  return (goal.lastDay + 1 + goal.closeAfterDays) * DAY_MS;
}

/** Whether counted seconds may still change: not closed, and before closesAt. */
export function isGoalOpen(goal: GoalWindow, nowMs: number): boolean {
  return goal.status !== "closed" && nowMs < closesAtMs(goal);
}

/**
 * The counting fields of a goal document, or null when its window is unusable.
 *
 * A missing or invalid cap or closing delay falls back to the defaults rather than stopping the
 * count, since the portal validates them and a bad value should not freeze a month.
 */
export function goalFromData(key: string, data: unknown): GoalWindow | null {
  if (!data || typeof data !== "object") {
    return null;
  }
  const d = data as Record<string, unknown>;
  if (!isInt(d.firstDay) || !isInt(d.lastDay) || d.lastDay < d.firstDay) {
    return null;
  }
  return {
    key,
    firstDay: d.firstDay,
    lastDay: d.lastDay,
    dailyCapSeconds: isInt(d.dailyCapSeconds) && d.dailyCapSeconds >= 0 ? d.dailyCapSeconds : DEFAULT_DAILY_CAP_SECONDS,
    closeAfterDays: isInt(d.closeAfterDays) && d.closeAfterDays >= 0 ? d.closeAfterDays : DEFAULT_CLOSE_AFTER_DAYS,
    status: d.status === "closed" ? "closed" : "open",
  };
}

/** The chunk years a goal's window spans: one, or two when it crosses 1 January. */
export function yearsOfWindow(goal: { firstDay: number; lastDay: number }): number[] {
  const years: number[] = [];
  for (let year = yearOfDay(goal.firstDay); year <= yearOfDay(goal.lastDay); year++) {
    years.push(year);
  }
  return years;
}

/**
 * Listening seconds per goal day in a days document, all devices together.
 *
 * A row's seconds are its `cs`; one whose `cs` is not a finite number of at least 0 counts as 0.
 * Rows without an integer `day` are skipped and other keys are ignored. With `year`, only rows
 * whose day belongs to that year's chunk are read, so a misplaced row is never counted twice.
 */
export function secondsByDay(chunk: unknown, year?: number): Map<number, number> {
  const result = new Map<number, number>();
  const rows = chunk && typeof chunk === "object" ? (chunk as { days?: unknown }).days : undefined;
  if (!Array.isArray(rows)) {
    return result;
  }
  for (const row of rows) {
    if (!row || typeof row !== "object") {
      continue;
    }
    const { day, cs } = row as { day?: unknown; cs?: unknown };
    if (!isInt(day) || (year !== undefined && yearOfDay(day) !== year)) {
      continue;
    }
    const seconds = typeof cs === "number" && Number.isFinite(cs) && cs >= 0 ? cs : 0;
    result.set(day, (result.get(day) ?? 0) + seconds);
  }
  return result;
}

/** The days of several chunks together. */
export function mergeDays(...maps: Map<number, number>[]): Map<number, number> {
  const result = new Map<number, number>();
  for (const map of maps) {
    for (const [day, seconds] of map) {
      result.set(day, (result.get(day) ?? 0) + seconds);
    }
  }
  return result;
}

/**
 * A user's value for a month: each day of the window up to one day after today (UTC), capped
 * at the daily cap, summed. The allowance of one day covers time zones ahead of UTC; anything
 * later is a wrong clock.
 */
export function monthValue(days: Map<number, number>, goal: GoalWindow, todayUtcDay: number): number {
  const last = Math.min(goal.lastDay, todayUtcDay + 1);
  const cap = Math.max(0, goal.dailyCapSeconds);
  let total = 0;
  for (const [day, seconds] of days) {
    if (day >= goal.firstDay && day <= last) {
      total += Math.min(seconds, cap);
    }
  }
  return Math.round(total);
}

/** The days whose seconds differ between two versions of a days document. */
export function changedDays(before: unknown, after: unknown): Set<number> {
  const a = secondsByDay(before);
  const b = secondsByDay(after);
  const changed = new Set<number>();
  for (const day of new Set([...a.keys(), ...b.keys()])) {
    if ((a.get(day) ?? 0) !== (b.get(day) ?? 0)) {
      changed.add(day);
    }
  }
  return changed;
}

/**
 * The goals whose value a write to a days document can change: those with a changed day inside
 * their window and no later than one day after today. Closed goals are included, because their
 * actual seconds still move.
 */
export function touchedGoals(goals: GoalWindow[], before: unknown, after: unknown, todayUtcDay: number): GoalWindow[] {
  const days = [...changedDays(before, after)].filter((day) => day <= todayUtcDay + 1);
  if (days.length === 0) {
    return [];
  }
  return goals.filter((goal) => days.some((day) => day >= goal.firstDay && day <= goal.lastDay));
}

/** Goal keys in calendar order; anything that is not a goal key sorts first, so it goes first. */
export function compareGoalKeys(a: string, b: string): number {
  const rank = (key: string): number => {
    const parsed = parseGoalKey(key);
    return parsed ? parsed.hijriYear * 100 + parsed.hijriMonth : -1;
  };
  return rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0);
}

/**
 * Which keys of a user's `months` map to delete when `adding` is written, keeping at most `max`
 * keys. When `adding` would itself be the oldest it is not written at all.
 */
export function boundedMonths(existing: string[], adding: string, max = MAX_MONTHS): { write: boolean; remove: string[] } {
  const all = [...new Set([...existing, adding])].sort(compareGoalKeys);
  const overflow = all.slice(0, Math.max(0, all.length - max));
  return { write: !overflow.includes(adding), remove: overflow.filter((key) => key !== adding) };
}

/**
 * The entry to merge into `months.<key>`, or null when what is stored already says it.
 *
 * `a` is always the value. `c` is the value only while the month is open; afterwards it is left as
 * stored, so the entry written holds `a` alone. A user with nothing stored and a value of 0 gets
 * no entry.
 */
export function nextMonthEntry(stored: unknown, value: number, open: boolean): MonthEntry | null {
  const entry = stored && typeof stored === "object" ? (stored as MonthEntry) : undefined;
  if (!entry && value === 0) {
    return null;
  }
  const sameA = entry?.a === value;
  const sameC = !open || entry?.c === value;
  if (sameA && sameC) {
    return null;
  }
  return open ? { c: value, a: value } : { a: value };
}

/** Where a month stands against its target. Null without a target. */
export function pace(
  goal: { firstDay: number; lastDay: number; targetHours: unknown; totalSeconds: unknown },
  todayDay: number,
): { daysTotal: number; elapsed: number; expected: number; ratio: number; daysAhead: number; state: "ahead" | "behind" | "onPlan" } | null {
  const target = goal.targetHours;
  if (typeof target !== "number" || !Number.isFinite(target) || target <= 0) {
    return null;
  }
  const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
  const daysTotal = goal.lastDay - goal.firstDay + 1;
  if (daysTotal <= 0) {
    return null;
  }
  const elapsed = clamp(todayDay - goal.firstDay + 1, 0, daysTotal);
  const expected = clamp((elapsed - 1) / daysTotal, 0, 1);
  const total = typeof goal.totalSeconds === "number" && Number.isFinite(goal.totalSeconds) ? goal.totalSeconds : 0;
  const ratio = total / (target * 3600);
  const daysAhead = (ratio - expected) * daysTotal;
  // A margin, so floating-point error never moves an exact day across the edge; the portal and the app use the same.
  const edge = 1 - 1e-9;
  const state = daysAhead >= edge ? "ahead" : daysAhead <= -edge ? "behind" : "onPlan";
  return { daysTotal, elapsed, expected, ratio, daysAhead, state };
}

const hijriFormat = new Intl.DateTimeFormat("en-u-ca-islamic-umalqura", {
  timeZone: "UTC",
  year: "numeric",
  month: "numeric",
  day: "numeric",
});

/** The Umm al-Qura date of a goal day. */
export function hijriOfDay(day: number): { hijriYear: number; hijriMonth: number; hijriDay: number } {
  const parts = hijriFormat.formatToParts(new Date(day * DAY_MS));
  const part = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  return { hijriYear: part("year"), hijriMonth: part("month"), hijriDay: part("day") };
}

/** 1 Muharram 1 AH (16 July 622) as a goal day, and the mean month, for a first guess. */
const HIJRI_EPOCH_DAY = Math.round(Date.UTC(622, 6, 16) / DAY_MS);
const MEAN_MONTH_DAYS = 29.530588853;

function firstDayOfHijriMonth(hijriYear: number, hijriMonth: number): number {
  const guess = Math.round(HIJRI_EPOCH_DAY + ((hijriYear - 1) * 12 + (hijriMonth - 1)) * MEAN_MONTH_DAYS);
  for (let offset = -5; offset <= 5; offset++) {
    const date = hijriOfDay(guess + offset);
    if (date.hijriYear === hijriYear && date.hijriMonth === hijriMonth && date.hijriDay === 1) {
      return guess + offset;
    }
  }
  throw new Error(`no first day found for Hijri month ${hijriYear}-${hijriMonth}`);
}

/** The first and last goal day of a Hijri month in the Umm al-Qura calendar. */
export function hijriMonthBounds(hijriYear: number, hijriMonth: number): HijriMonthBounds {
  const next = shiftHijriMonth(hijriYear, hijriMonth, 1);
  return {
    firstDay: firstDayOfHijriMonth(hijriYear, hijriMonth),
    lastDay: firstDayOfHijriMonth(next.hijriYear, next.hijriMonth) - 1,
  };
}

/**
 * The fields of a month created by the server.
 *
 * It copies the target, cap, closing delay and switches from the month before, else uses the
 * defaults. Its first day follows the previous month's last day when that month exists, so an
 * edited end date moves the next start with it; its last day is the calendar's, never before
 * the first.
 */
export function newGoalFields(
  hijriYear: number,
  hijriMonth: number,
  bounds: HijriMonthBounds,
  previous: unknown,
): Record<string, unknown> {
  const prev = previous && typeof previous === "object" ? (previous as Record<string, unknown>) : undefined;
  const firstDay = prev && isInt(prev.lastDay) ? prev.lastDay + 1 : bounds.firstDay;
  const prevShow = prev?.show && typeof prev.show === "object" ? (prev.show as Record<string, unknown>) : undefined;
  const show: GoalShow = prev
    ? {
        participants: prevShow?.participants === true,
        pace: prevShow?.pace === true,
        target: prevShow?.target === true,
        history: prevShow?.history === true,
      }
    : { ...DEFAULT_SHOW };
  const targetHours =
    prev && typeof prev.targetHours === "number" && Number.isFinite(prev.targetHours) ? prev.targetHours : null;
  return {
    hijriYear,
    hijriMonth,
    firstDay,
    lastDay: Math.max(bounds.lastDay, firstDay),
    targetHours,
    dailyCapSeconds:
      prev && isInt(prev.dailyCapSeconds) && prev.dailyCapSeconds >= 0 ? prev.dailyCapSeconds : DEFAULT_DAILY_CAP_SECONDS,
    closeAfterDays:
      prev && isInt(prev.closeAfterDays) && prev.closeAfterDays >= 0 ? prev.closeAfterDays : DEFAULT_CLOSE_AFTER_DAYS,
    show,
    auto: true,
    status: "open",
    totalSeconds: 0,
  };
}
