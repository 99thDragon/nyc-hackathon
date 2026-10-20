// One service day's compiled timetable, columnar, ported from scaffold `Sources/TransitGTFS/Timetable.swift`.
// Times are seconds from the service day's reference time (noon minus 12 h, local), so they stay continuous
// across DST and may pass 24:00. Previous-day trips running past midnight and next-day trips starting before
// the horizon are included, shifted onto this day.
//
// Patterns group trips with identical route, stop sequence, and pickup and drop-off rules. Trips within a
// pattern never overtake, so boarding the earliest departure is optimal (FIFO); the compiler splits patterns
// where they would.

export type Mode = "subway" | "bus" | "rail" | "ferry" | "other";
export const MODES: readonly Mode[] = ["subway", "bus", "rail", "ferry", "other"];
export const UNSERVED = 255;

export function modeOf(routeType: number): Mode {
  if (routeType === 1 || (routeType >= 400 && routeType <= 404)) return "subway";
  if (routeType === 3 || routeType === 11 || (routeType >= 700 && routeType <= 716) || routeType === 800) return "bus";
  if (routeType === 2 || (routeType >= 100 && routeType <= 117)) return "rail";
  if (routeType === 4 || routeType === 1000 || routeType === 1200) return "ferry";
  return "other";
}

// Plain columns, the unit the compiler emits and `encode`/`decode` store.
export interface TimetableData {
  serviceDate: string; // YYYYMMDD
  referenceEpoch: number; // Unix seconds at the reference time
  timeZone: string;

  stopID: string[]; // "<namespace>:<stop_id>"
  stopName: string[];
  stopLat: Float64Array;
  stopLon: Float64Array;
  stopParent: Int32Array; // -1 for none
  stopLocationType: Uint8Array; // GTFS location_type; 1 = station
  stopDirection: Uint8Array; // 0 none, 1 N, 2 S, from MTA's `<parent>N` / `<parent>S` child ids
  stopMode: Uint8Array; // index into MODES, UNSERVED when no pattern serves the stop
  stopPatternOffsets: Int32Array; // stops + 1
  stopPatternRefs: Int32Array; // pattern index
  stopPatternPositions: Int32Array; // position of the stop in that pattern

  routeID: string[]; // "<feed>:<route_id>"
  routeShortName: string[];
  routeLongName: string[];
  routeColor: string[]; // hex RGB without '#', "" when blank
  routeTextColor: string[];
  routeType: Int32Array;

  patternRoute: Int32Array;
  patternShape: Int32Array; // -1 for none
  patternStopOffsets: Int32Array; // patterns + 1
  patternTripOffsets: Int32Array; // patterns + 1
  patternEventOffsets: Int32Array; // patterns + 1
  patternStops: Int32Array;
  patternStopFlags: Uint8Array; // bit 0: no pickup, bit 1: no drop-off
  patternStopShapePoint: Int32Array; // index into shape arrays nearest each pattern stop, or -1

  tripID: string[];
  tripShortName: string[];
  tripHeadsign: string[];
  tripDayOffset: Int8Array; // -1 previous day, 0 this day, 1 next day
  // Event (pattern p, trip t within p, position i) is at patternEventOffsets[p] + t * stopCount(p) + i.
  arrivals: Int32Array;
  departures: Int32Array;

  shapeOffsets: Int32Array; // shapes + 1
  shapeLat: Float32Array;
  shapeLon: Float32Array;

  transferFrom: Int32Array;
  transferTo: Int32Array;
  transferType: Uint8Array; // 0 recommended, 1 timed, 2 minimum time, 3 not possible
  transferSeconds: Int32Array; // -1 when absent
}

export interface Point {
  lat: number;
  lon: number;
}

export interface Stop {
  index: number;
  id: string;
  name: string;
  location: Point;
  parent: number | null;
  isStation: boolean;
  direction: "N" | "S" | null;
  mode: Mode | null;
}

export interface Route {
  index: number;
  id: string;
  shortName: string;
  longName: string;
  color: string | null;
  textColor: string | null;
  mode: Mode;
}

export interface Transfer {
  from: number;
  to: number;
  type: number;
  minimumSeconds: number | null;
}

export class Timetable {
  readonly data: TimetableData;
  readonly #stopIndex = new Map<string, number>();
  readonly #children = new Map<number, number[]>();

  constructor(data: TimetableData) {
    this.data = data;
    for (let stop = 0; stop < data.stopID.length; stop++) {
      this.#stopIndex.set(data.stopID[stop], stop);
      const parent = data.stopParent[stop];
      if (parent >= 0) {
        const list = this.#children.get(parent);
        if (list) list.push(stop);
        else this.#children.set(parent, [stop]);
      }
    }
  }

  get stopCount(): number {
    return this.data.stopID.length;
  }
  get routeCount(): number {
    return this.data.routeID.length;
  }
  get patternCount(): number {
    return this.data.patternRoute.length;
  }
  get tripCount(): number {
    return this.data.tripID.length;
  }

  dateAt(seconds: number): Date {
    return new Date((this.data.referenceEpoch + seconds) * 1000);
  }

  secondsAt(date: Date): number {
    return Math.floor(date.getTime() / 1000 - this.data.referenceEpoch);
  }

  stopIndex(id: string): number | undefined {
    return this.#stopIndex.get(id);
  }

  stop(index: number): Stop {
    const d = this.data;
    const parent = d.stopParent[index];
    const direction = d.stopDirection[index];
    const mode = d.stopMode[index];
    return {
      index,
      id: d.stopID[index],
      name: d.stopName[index],
      location: this.location(index),
      parent: parent >= 0 ? parent : null,
      isStation: d.stopLocationType[index] === 1,
      direction: direction === 1 ? "N" : direction === 2 ? "S" : null,
      mode: mode < MODES.length ? MODES[mode] : null,
    };
  }

  location(stop: number): Point {
    return { lat: this.data.stopLat[stop], lon: this.data.stopLon[stop] };
  }

  // Child platforms of a station, empty for other stops.
  children(stop: number): number[] {
    return this.#children.get(stop) ?? [];
  }

  // True when at least one trip on this service day stops here.
  isServed(stop: number): boolean {
    return this.data.stopPatternOffsets[stop + 1] > this.data.stopPatternOffsets[stop];
  }

  // The stop itself when served, else its served child platforms.
  platforms(stop: number): number[] {
    if (stop < 0 || stop >= this.stopCount) return [];
    return this.isServed(stop) ? [stop] : this.children(stop).filter((child) => this.isServed(child));
  }

  route(index: number): Route {
    const d = this.data;
    return {
      index,
      id: d.routeID[index],
      shortName: d.routeShortName[index],
      longName: d.routeLongName[index],
      color: d.routeColor[index] || null,
      textColor: d.routeTextColor[index] || null,
      mode: modeOf(d.routeType[index]),
    };
  }

  routeOfPattern(pattern: number): Route {
    return this.route(this.data.patternRoute[pattern]);
  }

  patternsAtStop(stop: number): number[] {
    const d = this.data;
    const result: number[] = [];
    for (let entry = d.stopPatternOffsets[stop]; entry < d.stopPatternOffsets[stop + 1]; entry++) {
      result.push(d.stopPatternRefs[entry]);
    }
    return result;
  }

  stopsOfPattern(pattern: number): number[] {
    const d = this.data;
    return Array.from(d.patternStops.subarray(d.patternStopOffsets[pattern], d.patternStopOffsets[pattern + 1]));
  }

  patternStopCount(pattern: number): number {
    return this.data.patternStopOffsets[pattern + 1] - this.data.patternStopOffsets[pattern];
  }

  patternTripCount(pattern: number): number {
    return this.data.patternTripOffsets[pattern + 1] - this.data.patternTripOffsets[pattern];
  }

  transfers(): Transfer[] {
    const d = this.data;
    return Array.from(d.transferFrom, (from, index) => ({
      from,
      to: d.transferTo[index],
      type: d.transferType[index],
      minimumSeconds: d.transferSeconds[index] >= 0 ? d.transferSeconds[index] : null,
    }));
  }

  // Served stops within `radiusMeters` of `point`, nearest first, by straight-line distance.
  stopsNear(point: Point, radiusMeters: number): { stop: number; meters: number }[] {
    const result: { stop: number; meters: number }[] = [];
    for (let stop = 0; stop < this.stopCount; stop++) {
      if (!this.isServed(stop)) continue;
      const meters = distanceMeters(point, this.location(stop));
      if (meters <= radiusMeters) result.push({ stop, meters });
    }
    return result.sort((a, b) => a.meters - b.meters);
  }

  // Polyline along the pattern's shape between two positions, or straight segments between its stops when the
  // feed has no shape.
  path(pattern: number, board: number, alight: number): Point[] {
    const d = this.data;
    const base = d.patternStopOffsets[pattern];
    const first = d.patternStopShapePoint[base + board];
    const last = d.patternStopShapePoint[base + alight];
    const points: Point[] = [];
    if (d.patternShape[pattern] >= 0 && first >= 0 && last >= first) {
      for (let i = first; i <= last; i++) points.push({ lat: d.shapeLat[i], lon: d.shapeLon[i] });
      return points;
    }
    for (let i = board; i <= alight; i++) points.push(this.location(d.patternStops[base + i]));
    return points;
  }
}

// Equirectangular approximation, within 0.1% of haversine below a few kilometers.
export function distanceMeters(a: Point, b: Point): number {
  const metersPerDegree = 111_195;
  const dy = (b.lat - a.lat) * metersPerDegree;
  const dx = (b.lon - a.lon) * metersPerDegree * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  return Math.sqrt(dx * dx + dy * dy);
}
