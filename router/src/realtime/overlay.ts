// Trip updates applied to one timetable, ported from scaffold RealtimeOverlay.swift. Every pattern with an updated,
// canceled, or added trip gets realtime times for all its trips, split into blocks that never overtake one another.
// Browser-safe.

import type { Timetable } from "../timetable.ts";
import { CLOSED, PASSED } from "../types.ts";
import type { RealtimeOverlay, RealtimePatternTrips, RealtimeTrip } from "../types.ts";
import type { RealtimeFeed, TripMatch } from "./feeds.ts";
import { isCanceled } from "./protobuf.ts";
import type { FeedMessage, StopTimeEvent, StopTimeUpdate, TripUpdate } from "./protobuf.ts";

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
const clamp32 = (value: number) => Math.min(INT32_MAX, Math.max(INT32_MIN, Math.trunc(value)));

// Origin time in hundredths of a minute and route through the direction letter: `000600_1..S`, `036000_GS.N`.
// Static ids count past 24:00 on the service day, realtime ids from midnight, so the time is taken modulo a day.
export function subwayKey(tripID: string): string | null {
  const parts = tripID.split("_").filter((part) => part.length > 0);
  if (parts.length < 2) return null;
  const originText = parts[parts.length - 2];
  const route = parts[parts.length - 1];
  if (!/^[+-]?\d+$/.test(originText)) return null;
  const dot = route.indexOf(".");
  if (dot < 0) return null;
  let direction = dot;
  while (direction < route.length && route[direction] === ".") direction++;
  if (direction >= route.length) return null;
  const origin = Number.parseInt(originText, 10) % 144_000;
  const padded = origin < 0 ? "-" + String(-origin).padStart(5, "0") : String(origin).padStart(6, "0");
  return `${padded}_${route.slice(0, direction + 1)}`;
}

function staticKey(match: TripMatch, tripID: string): string | null {
  return match === "subwayTripID" ? subwayKey(tripID) : tripID;
}

function realtimeKey(match: TripMatch, update: TripUpdate): string | null {
  const id = update.trip.tripID;
  if (id === null) return null;
  return match === "subwayTripID" ? subwayKey(id) : id;
}

// Static trips by stop namespace and match key, and patterns by `<namespace>:<route_id>`.
export interface RealtimeIndex {
  trips: Map<string, Map<string, number[]>>;
  patternsByRoute: Map<string, number[]>;
  patternOfTrip: Int32Array;
}

function namespaceOf(id: string): string {
  const colon = id.indexOf(":");
  return colon < 0 ? id : id.slice(0, colon);
}

export function buildRealtimeIndex(timetable: Timetable, feeds: RealtimeFeed[]): RealtimeIndex {
  const d = timetable.data;
  const matches = new Map<string, TripMatch>();
  for (const feed of feeds) if (feed.content.kind === "tripUpdates") matches.set(feed.content.namespace, feed.content.match);
  const trips = new Map<string, Map<string, number[]>>();
  const patternsByRoute = new Map<string, number[]>();
  const patternOfTrip = new Int32Array(timetable.tripCount).fill(-1);
  for (let pattern = 0; pattern < timetable.patternCount; pattern++) {
    const namespace = namespaceOf(d.stopID[d.patternStops[d.patternStopOffsets[pattern]]]);
    const match = matches.get(namespace);
    if (!match) continue;
    const routeID = d.routeID[d.patternRoute[pattern]];
    const colon = routeID.indexOf(":");
    const routeKey = namespace + (colon < 0 ? "" : routeID.slice(colon));
    push(patternsByRoute, routeKey, pattern);
    let byKey = trips.get(namespace);
    if (!byKey) trips.set(namespace, (byKey = new Map()));
    for (let trip = d.patternTripOffsets[pattern]; trip < d.patternTripOffsets[pattern + 1]; trip++) {
      patternOfTrip[trip] = pattern;
      const key = staticKey(match, d.tripID[trip]);
      if (key !== null) push(byKey, key, trip);
    }
  }
  return { trips, patternsByRoute, patternOfTrip };
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

interface Times {
  arrivals: Int32Array;
  departures: Int32Array;
}

type Located = [number, StopTimeUpdate];

export function buildOverlay(
  timetable: Timetable,
  index: RealtimeIndex,
  messages: [RealtimeFeed, FeedMessage][],
): RealtimeOverlay {
  const d = timetable.data;
  const epoch = d.referenceEpoch;
  const changed = new Map<number, Times | null>();
  const added = new Map<number, { trip: RealtimeTrip; times: Times }[]>();
  let unmatched = 0;
  for (const [feed, message] of messages) {
    if (feed.content.kind !== "tripUpdates") continue;
    const { namespace, match } = feed.content;
    for (const update of message.tripUpdates) {
      const stops: Located[] = [];
      for (const stopTime of update.stopTimes) {
        const stop = stopTime.stopID === null ? undefined : timetable.stopIndex(`${namespace}:${stopTime.stopID}`);
        if (stop !== undefined) stops.push([stop, stopTime]);
      }
      // Nothing to apply.
      if (stops.length === 0 && !isCanceled(update.trip)) continue;
      const key = realtimeKey(match, update);
      const candidates = (key === null ? undefined : index.trips.get(namespace)?.get(key)) ?? [];
      const trip = closest(candidates, stops, update, timetable, index, epoch);
      if (trip !== null) {
        if (isCanceled(update.trip)) changed.set(trip, null);
        else {
          const times = tripTimes(trip, index.patternOfTrip[trip], stops, timetable, epoch);
          if (times) changed.set(trip, times);
        }
        continue;
      }
      const routeID = update.trip.routeID;
      const placed =
        !isCanceled(update.trip) && routeID !== null
          ? addedTimes(stops, index.patternsByRoute.get(`${namespace}:${routeID}`) ?? [], timetable, epoch)
          : null;
      if (placed) {
        push(added, placed.pattern, {
          trip: { base: -1, tripID: update.trip.tripID ?? update.entityID, updated: true },
          times: placed.times,
        });
      } else {
        unmatched++;
      }
    }
  }

  const touched = new Set<number>(added.keys());
  for (const trip of changed.keys()) touched.add(index.patternOfTrip[trip]);
  const patterns = new Map<number, RealtimePatternTrips>();
  for (const pattern of touched) {
    const length = timetable.patternStopCount(pattern);
    const eventBase = d.patternEventOffsets[pattern];
    const tripBase = d.patternTripOffsets[pattern];
    const rows: { trip: RealtimeTrip; times: Times }[] = [];
    for (let offset = 0; offset < timetable.patternTripCount(pattern); offset++) {
      const trip = tripBase + offset;
      const event = eventBase + offset * length;
      const id = d.tripID[trip];
      const times = changed.get(trip);
      if (times === null) continue;
      if (times) rows.push({ trip: { base: trip, tripID: id, updated: true }, times });
      else
        rows.push({
          trip: { base: trip, tripID: id, updated: false },
          times: { arrivals: d.arrivals.slice(event, event + length), departures: d.departures.slice(event, event + length) },
        });
    }
    rows.push(...(added.get(pattern) ?? []));
    patterns.set(pattern, split(rows, length));
  }
  let updatedTrips = 0;
  let canceledTrips = 0;
  for (const times of changed.values()) times ? updatedTrips++ : canceledTrips++;
  let addedTrips = 0;
  for (const list of added.values()) addedTrips += list.length;
  return { patterns, updatedTrips, addedTrips, canceledTrips, unmatchedTrips: unmatched };
}

function positionInPattern(timetable: Timetable, pattern: number, stop: number, from = 0): number {
  const d = timetable.data;
  const base = d.patternStopOffsets[pattern];
  const end = d.patternStopOffsets[pattern + 1];
  for (let i = base + from; i < end; i++) if (d.patternStops[i] === stop) return i - base;
  return -1;
}

// The candidate whose scheduled departure at the first timed updated stop is nearest the realtime one; without
// times, the one running on the update's start date.
function closest(
  candidates: number[],
  stops: Located[],
  update: TripUpdate,
  timetable: Timetable,
  index: RealtimeIndex,
  epoch: number,
): number | null {
  if (candidates.length <= 1) return candidates[0] ?? null;
  const d = timetable.data;
  for (const [stop, stopTime] of stops) {
    const time = stopTime.departure?.time ?? stopTime.arrival?.time ?? null;
    if (time === null) continue;
    const target = time - epoch;
    let best: number | null = null;
    let bestGap = Infinity;
    for (const trip of candidates) {
      const pattern = index.patternOfTrip[trip];
      const position = positionInPattern(timetable, pattern, stop);
      if (position < 0) continue;
      const event = d.patternEventOffsets[pattern] + (trip - d.patternTripOffsets[pattern]) * timetable.patternStopCount(pattern) + position;
      const gap = Math.abs(d.departures[event] - target);
      if (gap < bestGap) {
        best = trip;
        bestGap = gap;
      }
    }
    if (best !== null) return best;
  }
  const date = validDate(update.trip.startDate);
  const found = candidates.find((trip) =>
    date !== null ? addDays(d.serviceDate, d.tripDayOffset[trip]) === date : d.tripDayOffset[trip] === 0,
  );
  return found ?? null;
}

function validDate(text: string | null): string | null {
  const trimmed = text?.trim() ?? "";
  if (!/^\d{8}$/.test(trimmed)) return null;
  const month = Number(trimmed.slice(4, 6));
  const day = Number(trimmed.slice(6, 8));
  return month >= 1 && month <= 12 && day >= 1 && day <= 31 ? trimmed : null;
}

function addDays(yyyymmdd: string, days: number): string {
  const date = new Date(Date.UTC(Number(yyyymmdd.slice(0, 4)), Number(yyyymmdd.slice(4, 6)) - 1, Number(yyyymmdd.slice(6, 8)) + days));
  const pad = (value: number, width: number) => String(value).padStart(width, "0");
  return pad(date.getUTCFullYear(), 4) + pad(date.getUTCMonth() + 1, 2) + pad(date.getUTCDate(), 2);
}

// Scheduled times moved by the updates. Stops between updates, and after the last, keep the last delay; stops
// before the first are passed. Null when no update names a stop of the trip.
function tripTimes(trip: number, pattern: number, stops: Located[], timetable: Timetable, epoch: number): Times | null {
  const d = timetable.data;
  const length = timetable.patternStopCount(pattern);
  const event = d.patternEventOffsets[pattern] + (trip - d.patternTripOffsets[pattern]) * length;
  const scheduledArrivals = d.arrivals.subarray(event, event + length);
  const scheduledDepartures = d.departures.subarray(event, event + length);
  const arrivals = scheduledArrivals.slice();
  const departures = scheduledDepartures.slice();
  let cursor = 0;
  let first: number | null = null;
  let delay = 0;
  const shift = (from: number, to: number) => {
    for (let position = from; position < to; position++) {
      arrivals[position] = (scheduledArrivals[position] + delay) | 0;
      departures[position] = (scheduledDepartures[position] + delay) | 0;
    }
  };
  const timeOf = (e: StopTimeEvent | null, scheduled: number): number | null => {
    if (!e) return null;
    if (e.time !== null) return clamp32(e.time - epoch);
    return e.delay === null ? null : (scheduled + clamp32(e.delay)) | 0;
  };
  for (const [stop, update] of stops) {
    const position = positionInPattern(timetable, pattern, stop, cursor);
    if (position < 0) continue;
    if (first === null) first = position;
    else shift(cursor, position);
    cursor = position + 1;
    if (update.skipped) {
      arrivals[position] = CLOSED;
      departures[position] = PASSED;
      continue;
    }
    const dwell = scheduledDepartures[position] - scheduledArrivals[position];
    const arrival = timeOf(update.arrival, scheduledArrivals[position]);
    const departure = timeOf(update.departure, scheduledDepartures[position]);
    const realArrival = arrival ?? (departure === null ? null : departure - dwell);
    if (realArrival === null) {
      shift(position, cursor);
      continue;
    }
    arrivals[position] = realArrival;
    departures[position] = Math.max(departure ?? realArrival + dwell, realArrival);
    delay = departures[position] - scheduledDepartures[position];
  }
  if (first === null) return null;
  shift(cursor, length);
  for (let position = 0; position < first; position++) {
    arrivals[position] = PASSED;
    departures[position] = PASSED;
  }
  monotone(arrivals, departures);
  return { arrivals, departures };
}

// A trip only realtime data lists, placed in the first pattern of its route whose stops contain the updated stops
// as one run. Every update needs a time.
function addedTimes(
  stops: Located[],
  patterns: number[],
  timetable: Timetable,
  epoch: number,
): { pattern: number; times: Times } | null {
  const sequence = stops.map(([stop]) => stop);
  if (sequence.length < 2) return null;
  for (const pattern of patterns) {
    const patternStops = timetable.stopsOfPattern(pattern);
    let start = -1;
    for (let i = 0; i + sequence.length <= patternStops.length && start < 0; i++) {
      if (sequence.every((stop, offset) => patternStops[i + offset] === stop)) start = i;
    }
    if (start < 0) continue;
    const arrivals = new Int32Array(patternStops.length).fill(PASSED);
    const departures = new Int32Array(patternStops.length).fill(PASSED);
    for (let offset = 0; offset < stops.length; offset++) {
      const update = stops[offset][1];
      const position = start + offset;
      const time = update.arrival?.time ?? update.departure?.time ?? null;
      if (time === null) return null;
      arrivals[position] = update.skipped ? CLOSED : clamp32(time - epoch);
      departures[position] = update.skipped ? PASSED : clamp32((update.departure?.time ?? time) - epoch);
    }
    for (let position = start + sequence.length; position < patternStops.length; position++) arrivals[position] = CLOSED;
    monotone(arrivals, departures);
    return { pattern, times: { arrivals, departures } };
  }
  return null;
}

// Times never decrease along a trip; markers are left alone.
function monotone(arrivals: Int32Array, departures: Int32Array): void {
  let floor = INT32_MIN;
  for (let position = 0; position < arrivals.length; position++) {
    if (arrivals[position] === PASSED || arrivals[position] === CLOSED || departures[position] === PASSED) continue;
    arrivals[position] = Math.max(arrivals[position], floor);
    departures[position] = Math.max(departures[position], arrivals[position]);
    floor = departures[position];
  }
}

// Sorted by first departure, then greedily into blocks where no trip is later than the next at any stop.
function split(rows: { trip: RealtimeTrip; times: Times }[], length: number): RealtimePatternTrips {
  const ordered = rows
    .map((row, offset) => ({ row, offset }))
    .sort(
      (a, b) =>
        a.row.times.departures[0] - b.row.times.departures[0] ||
        a.row.times.arrivals[length - 1] - b.row.times.arrivals[length - 1] ||
        a.offset - b.offset,
    )
    .map(({ row }) => row);
  const blocks: number[][] = [];
  ordered.forEach((row, index) => {
    const target = blocks.find((block) => {
      const last = ordered[block[block.length - 1]].times;
      for (let i = 0; i < length; i++) {
        if (last.arrivals[i] > row.times.arrivals[i] || last.departures[i] > row.times.departures[i]) return false;
      }
      return true;
    });
    if (target) target.push(index);
    else blocks.push([index]);
  });
  const trips: RealtimeTrip[] = [];
  const arrivals = new Int32Array(ordered.length * length);
  const departures = new Int32Array(ordered.length * length);
  const ranges: { start: number; end: number }[] = [];
  for (const block of blocks) {
    const start = trips.length;
    for (const index of block) {
      arrivals.set(ordered[index].times.arrivals, trips.length * length);
      departures.set(ordered[index].times.departures, trips.length * length);
      trips.push(ordered[index].trip);
    }
    ranges.push({ start, end: trips.length });
  }
  return { trips, arrivals, departures, blocks: ranges };
}
