// Live loader: real MTA elevator feeds (no key needed) + per-unit availability.
//   nyct_ene.json            current + planned outages (refreshes in under 30 min)
//   nyct_ene_equipments.json 707 units: description, next accessible stations, alternative route
//   rc78-7x78 (data.ny.gov)  monthly per-unit availability, currently through 2026-08
// MTA terms: serve from our servers, do not modify values, say the data comes from the MTA.
import type { Context, Feed, Outage, StopInput, Unit } from "./types.ts";

const MTA = "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds";
const OUTAGES_URL = `${MTA}/nyct%2Fnyct_ene.json`;
const EQUIPMENT_URL = `${MTA}/nyct%2Fnyct_ene_equipments.json`;
const AVAIL_URL = "https://data.ny.gov/resource/rc78-7x78.json";

export interface OutageRow {
  station: string;
  equipment: string;
  equipmenttype: string;
  serving: string;
  outagedate: string;
  estimatedreturntoservice: string;
  reason: string;
  isupcomingoutage: string;
}
export interface EquipmentRow {
  station: string;
  trainno: string;
  equipmentno: string;
  equipmenttype: string;
  serving: string;
  ADA: string;
  isactive: string;
  shortdescription: string;
  stationcomplexid: string;
  nextadanorth: string;
  nextadasouth: string;
  alternativeroute: string;
  redundant?: number;
}

// "10/19/2026 07:38:00 PM" in New York time -> ISO UTC. Returns null for anything else.
export function parseNyTime(text: string | undefined): string | null {
  const m = /^(\d\d)\/(\d\d)\/(\d{4}) (\d\d):(\d\d):(\d\d) (AM|PM)$/.exec(text ?? "");
  if (!m) return null;
  const [, mo, d, y, h12, mi, s, ap] = m;
  const hour = (Number(h12) % 12) + (ap === "PM" ? 12 : 0);
  const asUtc = Date.UTC(Number(y), Number(mo) - 1, Number(d), hour, Number(mi), Number(s));
  const offset = (at: number) => {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York", hourCycle: "h23",
        year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
      }).formatToParts(new Date(at)).map((x) => [x.type, x.value]),
    );
    return Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!) - at;
  };
  let utc = asUtc - offset(asUtc);
  utc = asUtc - offset(utc); // second pass settles DST edges
  return new Date(utc).toISOString();
}

export function toOutages(rows: OutageRow[]): Outage[] {
  return rows
    .filter((r) => r.equipmenttype === "EL")
    .map((r) => ({
      unitId: r.equipment,
      reason: r.reason,
      estReturn: r.estimatedreturntoservice || null, // raw feed text, unchanged
      planned: r.isupcomingoutage === "Y",
      startsAt: parseNyTime(r.outagedate),
      endsAt: parseNyTime(r.estimatedreturntoservice),
    }));
}

export function toEquipment(
  rows: EquipmentRow[],
  availability: Map<string, number>,
  // Units under long-term work (e.g. capital replacement) are marked isactive = "N" but are still on the
  // step-free route and still listed as outages. Keep any unit the outage feed mentions.
  reportedOut: Set<string> = new Set(),
): Record<string, Unit> {
  const out: Record<string, Unit> = {};
  for (const r of rows) {
    if (r.equipmenttype !== "EL" || (r.isactive !== "Y" && !reportedOut.has(r.equipmentno))) continue;
    out[r.equipmentno] = {
      id: r.equipmentno,
      desc: r.shortdescription || r.serving,
      backupUnitId: null,
      nextAccessibleNorth: r.nextadanorth || null,
      nextAccessibleSouth: r.nextadasouth || null,
      altRouteText: r.alternativeroute || null,
      availability90Pct: availability.get(r.equipmentno) ?? null,
      stationName: r.station,
      complexId: r.stationcomplexid,
      serving: r.serving,
      redundant: r.redundant === 1,
    };
  }
  return out;
}

// Elevators a rider needs for one platform. Descriptions are free text, so this is
// approximate: units whose text mentions the platform label, plus units that name no
// platform at all (street and mezzanine access). With no label we require every
// elevator at the station, which is the conservative reading.
export function requiredUnitIds(equipment: Record<string, Unit>, complexId: string, platform?: string): string[] {
  const here = Object.values(equipment).filter((u) => u.complexId === complexId);
  if (!platform) return here.map((u) => u.id);
  const p = platform.toLowerCase();
  return here
    .filter((u) => {
      const text = `${u.desc} ${u.serving ?? ""}`.toLowerCase();
      return text.includes(p) || !text.includes("platform");
    })
    .map((u) => u.id);
}

export function findStations(equipment: Record<string, Unit>, query: string) {
  const q = query.toLowerCase();
  const byComplex = new Map<string, { complexId: string; name: string; platforms: Set<string> }>();
  for (const u of Object.values(equipment)) {
    if (!u.stationName || !u.complexId || !u.stationName.toLowerCase().includes(q)) continue;
    const e = byComplex.get(u.complexId) ?? { complexId: u.complexId, name: u.stationName, platforms: new Set() };
    for (const m of (u.serving ?? "").matchAll(/([A-Z][\w.'-]*(?: [A-Z][\w.'-]*)*)-bound/g)) e.platforms.add(m[1]!);
    byComplex.set(u.complexId, e);
  }
  return [...byComplex.values()].map((e) => ({ ...e, platforms: [...e.platforms] }));
}

export function stopFor(
  equipment: Record<string, Unit>,
  complexId: string,
  platform: string | undefined,
  arrivalAt: string,
): StopInput | null {
  const ids = requiredUnitIds(equipment, complexId, platform);
  const first = equipment[ids[0] ?? ""];
  if (!first) return null;
  return {
    stationId: complexId,
    name: first.stationName ?? complexId,
    ada: 1, // listed with elevators and ADA = Y; partial access is not in these feeds
    direction: platform ?? "all platforms",
    requiredUnitIds: ids,
    arrivalAt,
    carSurvey: null, // no open car data; only surveyed stations get one
    carReports: [],
  };
}

async function getJson<T>(url: string): Promise<T> {
  // No HEAD requests: the MTA answers them with 403. Content-type on these files is unreliable,
  // so we check the body instead.
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
  const body = (await res.json()) as T;
  if (!Array.isArray(body)) throw new Error(`${url} did not return a JSON array`);
  return body;
}

async function fetchAvailability(): Promise<{ byUnit: Map<string, number>; asOf: string }> {
  const latest = (await getJson<{ latest: string }[]>(`${AVAIL_URL}?$select=max(month)%20as%20latest`))[0]?.latest;
  if (!latest) throw new Error("availability dataset returned no months");
  const end = new Date(latest.slice(0, 10) + "T00:00:00Z");
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 2, 1)); // last 3 months
  const where = encodeURIComponent(`equipment_type='Elevator' AND month>='${start.toISOString().slice(0, 19)}'`);
  const rows = await getJson<{ equipment_code: string; avail: string; total: string }[]>(
    `${AVAIL_URL}?$select=equipment_code,sum(_24_hour_hours_available)%20as%20avail,sum(_24_hour_total_hours)%20as%20total` +
      `&$where=${where}&$group=equipment_code&$limit=5000`,
  );
  const byUnit = new Map<string, number>();
  for (const r of rows) {
    const total = Number(r.total);
    if (total > 0) byUnit.set(r.equipment_code, Math.round((Number(r.avail) / total) * 1000) / 10);
  }
  return { byUnit, asOf: `${start.toISOString().slice(0, 7)} to ${latest.slice(0, 7)}` };
}

// Small TTL cache so repeated asks don't hammer the MTA.
const cache = new Map<string, { at: number; value: Promise<unknown> }>();
function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as Promise<T>;
  const value = load();
  cache.set(key, { at: Date.now(), value });
  value.catch(() => cache.delete(key)); // never cache a failure
  return value;
}

export async function loadLiveContext(now = Date.now()): Promise<Context> {
  const [outageRows, equipmentRows, avail] = await Promise.all([
    cached("outages", 30_000, async () => ({ rows: await getJson<OutageRow[]>(OUTAGES_URL), at: Date.now() })),
    cached("equipment", 3_600_000, () => getJson<EquipmentRow[]>(EQUIPMENT_URL)),
    cached("availability", 12 * 3_600_000, fetchAvailability),
  ]);
  const feed: Feed = {
    source: "MTA elevator and escalator outages (nyct_ene.json)",
    fetchedAt: new Date(outageRows.at).toISOString(), // the file carries no timestamp of its own
    outages: toOutages(outageRows.rows),
  };
  return {
    equipment: toEquipment(equipmentRows, avail.byUnit, new Set(feed.outages.map((o) => o.unitId))),
    feed,
    availabilityAsOf: avail.asOf,
    now,
  };
}
