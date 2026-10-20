// GTFS service days as "YYYYMMDD" strings, ported from scaffold `ServiceDate.swift`. Browser-safe.
// Stop times count seconds from the day's reference time, local noon minus 12 h, so times stay continuous across
// DST changes and may exceed 24:00:00.

export interface CivilDate {
  year: number;
  month: number;
  day: number;
}

export function parseServiceDate(text: string): CivilDate | null {
  const trimmed = text.trim();
  if (!/^\d{8}$/.test(trimmed)) return null;
  const value = Number(trimmed);
  const date = { year: Math.floor(value / 10_000), month: Math.floor(value / 100) % 100, day: value % 100 };
  if (date.month < 1 || date.month > 12 || date.day < 1 || date.day > 31) return null;
  return date;
}

export function formatServiceDate(date: CivilDate): string {
  return String(date.year * 10_000 + date.month * 100 + date.day).padStart(8, "0");
}

function required(text: string): CivilDate {
  const date = parseServiceDate(text);
  if (!date) throw new Error(`invalid service date ${text}`);
  return date;
}

// Days from civil, after Howard Hinnant's proleptic Gregorian algorithm.
export function daysSinceEpoch(date: CivilDate): number {
  const y = date.month <= 2 ? date.year - 1 : date.year;
  const era = Math.floor((y >= 0 ? y : y - 399) / 400);
  const yearOfEra = y - era * 400;
  const monthIndex = (date.month + 9) % 12;
  const dayOfYear = Math.floor((153 * monthIndex + 2) / 5) + date.day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
}

export function civilFromDays(days: number): CivilDate {
  const z = days + 719_468;
  const era = Math.floor((z >= 0 ? z : z - 146_096) / 146_097);
  const dayOfEra = z - era * 146_097;
  const yearOfEra = Math.floor(
    (dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36_524) - Math.floor(dayOfEra / 146_096)) / 365,
  );
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthIndex = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthIndex + 2) / 5) + 1;
  const month = monthIndex < 10 ? monthIndex + 3 : monthIndex - 9;
  return { year: yearOfEra + era * 400 + (month <= 2 ? 1 : 0), month, day };
}

export function addDays(date: string, days: number): string {
  return formatServiceDate(civilFromDays(daysSinceEpoch(required(date)) + days));
}

// 0 is Monday, matching the column order of calendar.txt.
export function weekday(date: string): number {
  const days = daysSinceEpoch(required(date));
  return (((days % 7) + 7 + 3) % 7);
}

// The first date after `date` that falls on `target` (0 is Monday).
export function nextWeekday(date: string, target: number): string {
  const ahead = (((target - weekday(date)) % 7) + 7) % 7;
  return addDays(date, ahead === 0 ? 7 : ahead);
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, format);
  }
  return format;
}

function wallClock(epochSeconds: number, timeZone: string): { date: CivilDate; seconds: number } {
  const parts: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(epochSeconds * 1000))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return {
    date: { year: parts.year, month: parts.month, day: parts.day },
    seconds: parts.hour * 3600 + parts.minute * 60 + parts.second,
  };
}

// Seconds east of UTC at `epochSeconds`.
export function utcOffsetSeconds(epochSeconds: number, timeZone: string): number {
  const local = wallClock(epochSeconds, timeZone);
  return daysSinceEpoch(local.date) * 86_400 + local.seconds - Math.floor(epochSeconds);
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

// Unix seconds at the reference time of `date` in `timeZone`.
export function referenceEpoch(date: string, timeZone: string): number {
  const noonUTC = daysSinceEpoch(required(date)) * 86_400 + 43_200;
  return noonUTC - utcOffsetSeconds(noonUTC, timeZone) - 43_200;
}

export function serviceDateAt(epochSeconds: number, timeZone: string): string {
  return formatServiceDate(wallClock(epochSeconds, timeZone).date);
}
