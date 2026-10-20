// Multi-criteria RAPTOR over arrival time and generalized cost (McRAPTOR; Delling, Pajor, Werneck,
// "Round-Based Public Transit Routing", 2012), ported from scaffold `TransitRouter.swift`. Round k boards the
// k-th vehicle. Each stop keeps one Pareto bag across rounds, since transfers are priced into cost rather than
// tracked as a third criterion.

import type { Footpaths } from "./footpaths.ts";
import type { Timetable } from "./timetable.ts";
import {
  CLOSED,
  DEFAULT_PREFERENCES,
  type Journey,
  type Leg,
  type RealtimeOverlay,
  type RideLeg,
  type TransitQuery,
} from "./types.ts";

const INT32_MAX = 2147483647;
const INT32_MIN = -2147483648;

const ACCESS = 0;
const RIDE = 1;
const WALK = 2;

function satAdd(a: number, b: number): number {
  const sum = a + b;
  return sum > INT32_MAX ? INT32_MAX : sum < INT32_MIN ? INT32_MIN : sum;
}

function clamp32(value: number): number {
  return value > INT32_MAX ? INT32_MAX : value < INT32_MIN ? INT32_MIN : Math.trunc(value);
}

export class TransitRouter {
  readonly timetable: Timetable;
  readonly footpaths: Footpaths;
  // Replaces the scheduled trips of the patterns it covers.
  readonly realtime: RealtimeOverlay | undefined;

  constructor(timetable: Timetable, footpaths: Footpaths, realtime?: RealtimeOverlay) {
    this.timetable = timetable;
    this.footpaths = footpaths;
    this.realtime = realtime;
  }

  // Pareto set over (arrival, cost) within the arrival slack, earliest arrival first.
  journeys(query: TransitQuery): Journey[] {
    const search = new McRaptorSearch(this.timetable, this.footpaths, this.realtime, query);
    search.run();
    return search.journeys();
  }
}

// Minimizes cost + latenessWeight * (arrival - earliest arrival), skipping journeys that arrive more than
// maxLatenessSeconds after the earliest. Ties go to the earlier arrival.
export function preferredJourney(
  journeys: Journey[],
  latenessWeight = 1,
  maxLatenessSeconds?: number,
): Journey | null {
  if (journeys.length === 0) return null;
  const earliest = Math.min(...journeys.map((j) => j.arrival));
  let best: Journey | null = null;
  let bestScore = Infinity;
  for (const journey of journeys) {
    if (maxLatenessSeconds !== undefined && journey.arrival - earliest > maxLatenessSeconds) continue;
    const score = journey.cost + latenessWeight * (journey.arrival - earliest);
    if (best === null || score < bestScore || (score === bestScore && journey.arrival < best.arrival)) {
      best = journey;
      bestScore = score;
    }
  }
  return best;
}

// Struct-of-arrays label storage. Access labels keep the access index in `pattern`; ride labels keep the trip
// (absolute, or the index in the pattern's realtime trips); walk labels keep the footpath edge in `trip`.
class Labels {
  size = 0;
  arrival = new Int32Array(1024);
  cost = new Float64Array(1024);
  stop = new Int32Array(1024);
  parent = new Int32Array(1024);
  round = new Int32Array(1024);
  kind = new Uint8Array(1024);
  pattern = new Int32Array(1024);
  trip = new Int32Array(1024);
  board = new Int32Array(1024);
  alight = new Int32Array(1024);

  push(
    arrival: number,
    cost: number,
    stop: number,
    parent: number,
    round: number,
    kind: number,
    pattern: number,
    trip: number,
    board: number,
    alight: number,
  ): number {
    if (this.size === this.arrival.length) this.grow();
    const id = this.size++;
    this.arrival[id] = arrival;
    this.cost[id] = cost;
    this.stop[id] = stop;
    this.parent[id] = parent;
    this.round[id] = round;
    this.kind[id] = kind;
    this.pattern[id] = pattern;
    this.trip[id] = trip;
    this.board[id] = board;
    this.alight[id] = alight;
    return id;
  }

  private grow(): void {
    const capacity = this.arrival.length * 2;
    const grow = <T extends Int32Array | Float64Array | Uint8Array>(old: T, make: (n: number) => T): T => {
      const next = make(capacity);
      next.set(old as never);
      return next;
    };
    this.arrival = grow(this.arrival, (n) => new Int32Array(n));
    this.cost = grow(this.cost, (n) => new Float64Array(n));
    this.stop = grow(this.stop, (n) => new Int32Array(n));
    this.parent = grow(this.parent, (n) => new Int32Array(n));
    this.round = grow(this.round, (n) => new Int32Array(n));
    this.kind = grow(this.kind, (n) => new Uint8Array(n));
    this.pattern = grow(this.pattern, (n) => new Int32Array(n));
    this.trip = grow(this.trip, (n) => new Int32Array(n));
    this.board = grow(this.board, (n) => new Int32Array(n));
    this.alight = grow(this.alight, (n) => new Int32Array(n));
  }
}

// A trip being ridden during a pattern scan. Cost at a later stop is base + rideWeight * arrival, so a label
// with an earlier or equal trip and lower or equal base stays no worse at every later stop (trips are FIFO and
// rideWeight is non-negative). Dominance on (trip, base) is therefore exact.
interface RouteLabel {
  parent: number;
  trip: number;
  board: number;
  base: number;
}

interface Target {
  arrival: number;
  cost: number;
  label: number;
  egress: number;
}

class McRaptorSearch {
  readonly timetable: Timetable;
  readonly footpaths: Footpaths;
  readonly realtime: RealtimeOverlay | undefined;
  readonly query: TransitQuery;
  readonly rideWeight: number;
  readonly waitFallback: number;
  readonly penalty: number;
  readonly slack: number;
  readonly maxRounds: number;

  // Earliest destination arrival plus the slack; later labels cannot lead to a kept journey.
  arrivalLimit = INT32_MAX;
  labels = new Labels();
  bags: number[][];
  targets: Target[] = [];
  egressByStop = new Map<number, number[]>();
  hasEgress: Uint8Array;
  marked: number[] = [];
  isMarked: Uint8Array;
  boardList: number[] = [];
  boardStart: Int32Array;
  boardEnd: Int32Array;
  patternStart: Int32Array;
  queued: number[] = [];
  routeBag: RouteLabel[] = [];

  constructor(timetable: Timetable, footpaths: Footpaths, realtime: RealtimeOverlay | undefined, query: TransitQuery) {
    this.timetable = timetable;
    this.footpaths = footpaths;
    this.realtime = realtime;
    this.query = query;
    const preferences = query.preferences ?? DEFAULT_PREFERENCES;
    this.rideWeight = Math.max(preferences.rideWeight, 0);
    this.waitFallback = preferences.waitWeight;
    this.penalty = preferences.transferPenaltySeconds;
    this.slack = clamp32(Math.max(query.arrivalSlackSeconds ?? 1800, 0));
    this.maxRounds = query.maxRounds ?? 3;
    const stops = timetable.stopCount;
    this.bags = Array.from({ length: stops }, () => []);
    this.hasEgress = new Uint8Array(stops);
    this.isMarked = new Uint8Array(stops);
    this.boardStart = new Int32Array(stops);
    this.boardEnd = new Int32Array(stops);
    this.patternStart = new Int32Array(timetable.patternCount).fill(INT32_MAX);
    query.egress.forEach((egress, index) => {
      for (const stop of timetable.platforms(egress.stop)) {
        const list = this.egressByStop.get(stop);
        if (list) list.push(index);
        else this.egressByStop.set(stop, [index]);
        this.hasEgress[stop] = 1;
      }
    });
  }

  waitWeight(stop: number): number {
    const weights = this.query.waitWeights;
    return weights && stop >= 0 && stop < weights.length ? weights[stop] : this.waitFallback;
  }

  run(): void {
    const departure = clamp32(this.query.departure);
    this.query.access.forEach((access, index) => {
      for (const stop of this.timetable.platforms(access.stop)) {
        this.insert(satAdd(departure, clamp32(Math.ceil(access.seconds))), access.cost, stop, -1, 0, ACCESS, index, -1, -1, -1);
      }
    });
    for (let round = 1; round <= this.maxRounds; round++) {
      if (this.marked.length === 0) break;
      this.scanPatterns(round);
      this.relaxFootpaths(round);
    }
  }

  // Adds the label unless a bag label or a destination label dominates it, evicting what it dominates.
  insert(
    arrival: number,
    cost: number,
    stop: number,
    parent: number,
    round: number,
    kind: number,
    pattern: number,
    trip: number,
    board: number,
    alight: number,
  ): boolean {
    if (arrival > this.arrivalLimit) return false;
    for (const target of this.targets) {
      if (target.arrival <= arrival && target.cost <= cost) return false;
    }
    const labels = this.labels;
    const bag = this.bags[stop];
    for (const id of bag) {
      if (labels.arrival[id] <= arrival && labels.cost[id] <= cost) return false;
    }
    let kept = 0;
    for (const id of bag) {
      if (!(labels.arrival[id] >= arrival && labels.cost[id] >= cost)) bag[kept++] = id;
    }
    bag.length = kept;
    const id = labels.push(arrival, cost, stop, parent, round, kind, pattern, trip, board, alight);
    bag.push(id);
    if (!this.isMarked[stop]) {
      this.isMarked[stop] = 1;
      this.marked.push(stop);
    }
    if (kind === RIDE && this.hasEgress[stop]) {
      for (const index of this.egressByStop.get(stop) ?? []) this.addTarget(id, index);
    }
    return true;
  }

  addTarget(id: number, index: number): void {
    const egress = this.query.egress[index];
    const arrival = satAdd(this.labels.arrival[id], clamp32(Math.ceil(egress.seconds)));
    const cost = this.labels.cost[id] + egress.cost;
    if (arrival > this.arrivalLimit) return;
    for (const target of this.targets) {
      if (target.arrival <= arrival && target.cost <= cost) return;
    }
    this.arrivalLimit = Math.min(this.arrivalLimit, satAdd(arrival, this.slack));
    const limit = this.arrivalLimit;
    this.targets = this.targets.filter((t) => !((t.arrival >= arrival && t.cost >= cost) || t.arrival > limit));
    this.targets.push({ arrival, cost, label: id, egress: index });
  }

  scanPatterns(round: number): void {
    const d = this.timetable.data;
    const labels = this.labels;
    const stops = this.marked;
    this.marked = [];
    this.boardList.length = 0;
    // Boarding uses the previous round's labels as they stood when the round began, so the scan order of
    // patterns within a round cannot change the result.
    for (const stop of stops) {
      this.isMarked[stop] = 0;
      this.boardStart[stop] = this.boardList.length;
      for (const id of this.bags[stop]) {
        if (labels.round[id] === round - 1) this.boardList.push(id);
      }
      this.boardEnd[stop] = this.boardList.length;
      if (this.boardEnd[stop] <= this.boardStart[stop]) continue;
      for (let entry = d.stopPatternOffsets[stop]; entry < d.stopPatternOffsets[stop + 1]; entry++) {
        const pattern = d.stopPatternRefs[entry];
        const position = d.stopPatternPositions[entry];
        if (this.patternStart[pattern] === INT32_MAX) this.queued.push(pattern);
        if (position < this.patternStart[pattern]) this.patternStart[pattern] = position;
      }
    }
    for (const pattern of this.queued) {
      this.scan(pattern, this.patternStart[pattern], round);
      this.patternStart[pattern] = INT32_MAX;
    }
    this.queued.length = 0;
    for (const stop of stops) {
      this.boardStart[stop] = 0;
      this.boardEnd[stop] = 0;
    }
  }

  // Scans the scheduled trips, or each realtime block as its own route.
  scan(pattern: number, start: number, round: number): void {
    const d = this.timetable.data;
    const trips = this.realtime?.patterns.get(pattern);
    if (!trips) {
      this.scanBlock(pattern, start, round, d.arrivals, d.departures, d.patternEventOffsets[pattern],
        d.patternTripOffsets[pattern], this.timetable.patternTripCount(pattern));
      return;
    }
    const length = this.timetable.patternStopCount(pattern);
    for (const block of trips.blocks) {
      this.scanBlock(pattern, start, round, trips.arrivals, trips.departures, block.start * length, block.start,
        block.end - block.start);
    }
  }

  scanBlock(
    pattern: number,
    start: number,
    round: number,
    arrivals: Int32Array,
    departures: Int32Array,
    eventBase: number,
    tripBase: number,
    trips: number,
  ): void {
    const d = this.timetable.data;
    const labels = this.labels;
    const stopBase = d.patternStopOffsets[pattern];
    const length = d.patternStopOffsets[pattern + 1] - stopBase;
    const routeBag = this.routeBag;
    routeBag.length = 0;

    for (let position = start; position < length; position++) {
      const stop = d.patternStops[stopBase + position];
      const flags = d.patternStopFlags[stopBase + position];
      if (routeBag.length > 0 && (flags & 2) === 0) {
        // Inserting can grow routeBag only via mergeRouteLabel below, so iterate a fixed count.
        for (let r = 0, n = routeBag.length; r < n; r++) {
          const riding = routeBag[r];
          const arrival = arrivals[eventBase + riding.trip * length + position];
          if (arrival === CLOSED) continue;
          this.insert(arrival, riding.base + this.rideWeight * arrival, stop, riding.parent, round, RIDE, pattern,
            tripBase + riding.trip, riding.board, position);
        }
      }
      if (position + 1 >= length || (flags & 1) !== 0 || this.boardEnd[stop] <= this.boardStart[stop]) continue;
      const waitWeight = this.waitWeight(stop);
      for (let slot = this.boardStart[stop]; slot < this.boardEnd[stop]; slot++) {
        const id = this.boardList[slot];
        const labelArrival = labels.arrival[id];
        // Earliest trip departing at or after the label's arrival; departures are sorted per position.
        let low = 0;
        let high = trips;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (departures[eventBase + middle * length + position] < labelArrival) low = middle + 1;
          else high = middle;
        }
        if (low >= trips) continue;
        const departure = departures[eventBase + low * length + position];
        let cost = labels.cost[id];
        if (labels.kind[id] !== ACCESS) cost += (departure - labelArrival) * waitWeight + this.penalty;
        this.mergeRouteLabel({ parent: id, trip: low, board: position, base: cost - this.rideWeight * departure });
      }
    }
  }

  mergeRouteLabel(label: RouteLabel): void {
    const bag = this.routeBag;
    for (const other of bag) {
      if (other.trip <= label.trip && other.base <= label.base) return;
    }
    let kept = 0;
    for (const other of bag) {
      if (!(other.trip >= label.trip && other.base >= label.base)) bag[kept++] = other;
    }
    bag.length = kept;
    bag.push(label);
  }

  // One walk after each ride. Sources are fixed before relaxing so an eviction during relaxation cannot
  // suppress another stop's walks.
  relaxFootpaths(round: number): void {
    const labels = this.labels;
    const sources: number[] = [];
    for (const stop of this.marked) {
      for (const id of this.bags[stop]) {
        if (labels.round[id] === round && labels.kind[id] === RIDE) sources.push(id);
      }
    }
    const f = this.footpaths;
    for (const id of sources) {
      const stop = labels.stop[id];
      const arrival = labels.arrival[id];
      const cost = labels.cost[id];
      for (let edge = f.offsets[stop]; edge < f.offsets[stop + 1]; edge++) {
        this.insert(satAdd(arrival, f.seconds[edge]), cost + f.costs[edge], f.targets[edge], id, round, WALK, -1, edge,
          -1, -1);
      }
    }
  }

  journeys(): Journey[] {
    const result: Journey[] = [];
    const sorted = [...this.targets].sort((a, b) => a.arrival - b.arrival || a.cost - b.cost);
    for (const target of sorted) {
      const journey = this.journey(target);
      if (journey) result.push(journey);
    }
    return result;
  }

  journey(target: Target): Journey | null {
    const labels = this.labels;
    const chain: number[] = [];
    for (let id = target.label; id >= 0; id = labels.parent[id]) chain.push(id);
    chain.reverse();
    const origin = chain[0];
    if (chain.length < 2 || labels.kind[origin] !== ACCESS) return null;

    const accessIndex = labels.pattern[origin];
    const access = this.query.access[accessIndex];
    const legs: Leg[] = [];
    let previous = origin;
    let previousArrival = 0;
    let leave = 0;
    for (const id of chain.slice(1)) {
      const kind = labels.kind[id];
      if (kind === RIDE) {
        const ride = this.ride(id);
        if (labels.kind[previous] === ACCESS) {
          previousArrival = ride.departure;
          leave = previousArrival - Math.ceil(access.seconds);
          legs.push({ kind: "access", index: accessIndex, stop: ride.from, start: leave, seconds: access.seconds,
            cost: access.cost });
        }
        const seconds = ride.departure - previousArrival;
        legs.push({ kind: "wait", stop: ride.from, start: previousArrival, seconds,
          cost: seconds * this.waitWeight(ride.from) });
        legs.push(ride);
        previousArrival = ride.arrival;
      } else if (kind === WALK) {
        const edge = labels.trip[id];
        legs.push({ kind: "transfer", from: labels.stop[previous], to: labels.stop[id], start: previousArrival,
          seconds: this.footpaths.seconds[edge], cost: this.footpaths.costs[edge] });
        previousArrival = labels.arrival[id];
      } else {
        return null;
      }
      previous = id;
    }
    const egress = this.query.egress[target.egress];
    legs.push({ kind: "egress", index: target.egress, stop: labels.stop[previous], start: previousArrival,
      seconds: egress.seconds, cost: egress.cost });
    return { departure: leave, arrival: target.arrival, cost: target.cost, legs };
  }

  ride(id: number): RideLeg {
    const t = this.timetable;
    const d = t.data;
    const labels = this.labels;
    const pattern = labels.pattern[id];
    const stopBase = d.patternStopOffsets[pattern];
    const length = d.patternStopOffsets[pattern + 1] - stopBase;
    const board = labels.board[id];
    const alight = labels.alight[id];
    const scheduledEvent = (trip: number) =>
      d.patternEventOffsets[pattern] + (trip - d.patternTripOffsets[pattern]) * length;
    let trip: number;
    let tripID: string;
    let departure: number;
    let arrival: number;
    let scheduled: RideLeg["scheduled"] = null;
    const realtime = this.realtime?.patterns.get(pattern);
    if (realtime) {
      const index = labels.trip[id];
      const entry = realtime.trips[index];
      trip = entry.base;
      tripID = entry.tripID;
      departure = realtime.departures[index * length + board];
      arrival = realtime.arrivals[index * length + alight];
      if (entry.updated) {
        scheduled = trip < 0
          ? { departure: null, arrival: null }
          : { departure: d.departures[scheduledEvent(trip) + board], arrival: d.arrivals[scheduledEvent(trip) + alight] };
      }
    } else {
      trip = labels.trip[id];
      tripID = d.tripID[trip];
      departure = d.departures[scheduledEvent(trip) + board];
      arrival = d.arrivals[scheduledEvent(trip) + alight];
    }
    let headsign = trip < 0 ? "" : d.tripHeadsign[trip];
    if (!headsign) headsign = d.stopName[d.patternStops[stopBase + length - 1]];
    return {
      kind: "ride",
      pattern,
      trip,
      tripID,
      serviceDayOffset: trip < 0 ? 0 : d.tripDayOffset[trip],
      route: t.routeOfPattern(pattern),
      headsign,
      from: d.patternStops[stopBase + board],
      to: d.patternStops[stopBase + alight],
      departure,
      arrival,
      scheduled,
      cost: this.rideWeight * (arrival - departure),
      path: t.path(pattern, board, alight),
    };
  }
}
