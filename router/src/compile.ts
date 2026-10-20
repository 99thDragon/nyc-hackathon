// GTFS directories to one service day's TimetableData, ported from scaffold `TimetableCompiler.swift`. Node-only.
import fs from "node:fs";
import path from "node:path";
import { double, field, forEachRow, gtfsTime, int } from "./csv.ts";
import { addDays, isValidTimeZone, parseServiceDate, referenceEpoch, weekday } from "./service-date.ts";
import { MODES, UNSERVED, modeOf, type TimetableData } from "./timetable.ts";

export interface TimetableSource {
  feedID: string;
  namespace: string;
  directory: string;
}

export interface CompileOptions {
  // Next-day trips whose first departure is earlier than this, in seconds after the next day's reference time,
  // are included shifted by one day so late-evening queries can continue past the end of service.
  nextDayHorizonSeconds?: number;
}

const MISSING = -2147483648;

interface Row {
  sequence: number;
  stop: number;
  arrival: number;
  departure: number;
  flags: number;
}

interface Draft {
  route: number;
  tripID: string;
  shortName: string;
  headsign: string;
  shape: number;
  // Bit 0: active the previous day. Bit 1: this day. Bit 2: the next day.
  days: number;
}

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

export async function compile(sources: TimetableSource[], date: string, options: CompileOptions = {}): Promise<TimetableData> {
  if (!parseServiceDate(date)) throw new Error(`invalid service date ${date}`);
  const horizon = options.nextDayHorizonSeconds ?? 4 * 3600;
  const dayDates = [addDays(date, -1), date, addDays(date, 1)];

  let timeZoneName: string | null = null;
  const stopIndex = new Map<string, number>();
  const stopLat: number[] = [], stopLon: number[] = [], stopID: string[] = [], stopName: string[] = [];
  const stopParent: number[] = [], stopLocationType: number[] = [], stopDirection: number[] = [];
  const routeID: string[] = [], routeShortName: string[] = [], routeLongName: string[] = [];
  const routeColor: string[] = [], routeTextColor: string[] = [], routeType: number[] = [];
  const drafts: Draft[] = [];
  const rows: Row[][] = [];
  const shapePoints: { sequence: number; lat: number; lon: number }[][] = [];
  const transferFrom: number[] = [], transferTo: number[] = [], transferType: number[] = [], transferSeconds: number[] = [];

  for (const source of sources) {
    const file = (name: string, required = true): string | null => {
      const location = path.join(source.directory, name);
      if (fs.existsSync(location)) return location;
      if (required) throw new Error(`missing file ${source.feedID}/${name}`);
      return null;
    };

    const agency = file("agency.txt", false);
    if (timeZoneName === null && agency) {
      await forEachRow(agency, (h, r) => {
        const zone = field(r, h("agency_timezone"));
        if (timeZoneName === null && zone) timeZoneName = zone;
      });
    }

    const services = new Map<string, number>();
    const calendar = file("calendar.txt", false);
    if (calendar) {
      await forEachRow(calendar, (h, r) => {
        const id = field(r, h("service_id"));
        const start = field(r, h("start_date"));
        const end = field(r, h("end_date"));
        if (!parseServiceDate(start) || !parseServiceDate(end)) return;
        let mask = services.get(id) ?? 0;
        dayDates.forEach((day, bit) => {
          if (start <= day && day <= end && int(r, h(WEEKDAYS[weekday(day)])) === 1) mask |= 1 << bit;
        });
        services.set(id, mask);
      });
    }
    const exceptions = file("calendar_dates.txt", false);
    if (exceptions) {
      await forEachRow(exceptions, (h, r) => {
        const bit = dayDates.indexOf(field(r, h("date")));
        if (bit < 0) return;
        const id = field(r, h("service_id"));
        const type = int(r, h("exception_type"));
        if (type === 1) services.set(id, (services.get(id) ?? 0) | (1 << bit));
        else if (type === 2) services.set(id, (services.get(id) ?? 0) & ~(1 << bit));
      });
    }

    const routesFile = file("routes.txt")!, stopsFile = file("stops.txt")!;
    const tripsFile = file("trips.txt")!, stopTimesFile = file("stop_times.txt")!;

    const routes = new Map<string, number>();
    await forEachRow(routesFile, (h, r) => {
      const id = field(r, h("route_id"));
      if (routes.has(id)) return;
      routes.set(id, routeID.length);
      routeID.push(`${source.feedID}:${id}`);
      routeShortName.push(field(r, h("route_short_name")));
      routeLongName.push(field(r, h("route_long_name")));
      routeColor.push(field(r, h("route_color")).toUpperCase());
      routeTextColor.push(field(r, h("route_text_color")).toUpperCase());
      routeType.push(int(r, h("route_type")) ?? 3);
    });

    const stops = new Map<string, number>();
    const parents: { child: number; parent: string }[] = [];
    await forEachRow(stopsFile, (h, r) => {
      const id = field(r, h("stop_id"));
      const key = `${source.namespace}:${id}`;
      const existing = stopIndex.get(key);
      if (existing !== undefined) {
        stops.set(id, existing);
        return;
      }
      const index = stopID.length;
      stops.set(id, index);
      stopIndex.set(key, index);
      stopID.push(key);
      stopName.push(field(r, h("stop_name")));
      stopLat.push(double(r, h("stop_lat")) ?? 0);
      stopLon.push(double(r, h("stop_lon")) ?? 0);
      stopLocationType.push(Math.min(Math.max(int(r, h("location_type")) ?? 0, 0), 255));
      stopParent.push(-1);
      const parent = field(r, h("parent_station"));
      stopDirection.push(parent === "" ? 0 : id === parent + "N" ? 1 : id === parent + "S" ? 2 : 0);
      if (parent !== "") parents.push({ child: index, parent });
    });
    for (const { child, parent } of parents) {
      const index = stops.get(parent);
      if (index !== undefined) stopParent[child] = index;
    }

    const trips = new Map<string, number>();
    const shapes = new Map<string, number>();
    await forEachRow(tripsFile, (h, r) => {
      const days = services.get(field(r, h("service_id")));
      const route = routes.get(field(r, h("route_id")));
      if (!days || route === undefined) return;
      const tripID = field(r, h("trip_id"));
      if (trips.has(tripID)) return;
      let shape = -1;
      const shapeID = field(r, h("shape_id"));
      if (shapeID !== "") {
        const slot = shapes.get(shapeID);
        if (slot !== undefined) shape = slot;
        else {
          shape = shapePoints.length;
          shapes.set(shapeID, shape);
          shapePoints.push([]);
        }
      }
      trips.set(tripID, drafts.length);
      drafts.push({
        route,
        tripID,
        shortName: field(r, h("trip_short_name")),
        headsign: field(r, h("trip_headsign")),
        shape,
        days,
      });
      rows.push([]);
    });

    let lastTrip: string | null = null;
    let lastDraft = -1;
    await forEachRow(stopTimesFile, (h, r) => {
      const tripField = field(r, h("trip_id"));
      if (tripField !== lastTrip) {
        lastTrip = tripField;
        lastDraft = trips.get(tripField) ?? -1;
      }
      if (lastDraft < 0) return;
      const stop = stops.get(field(r, h("stop_id")));
      if (stop === undefined) return;
      let flags = 0;
      if (int(r, h("pickup_type")) === 1) flags |= 1;
      if (int(r, h("drop_off_type")) === 1) flags |= 2;
      // Riders can neither board nor alight, as at railroad yards that crews use.
      if (flags === 3) return;
      rows[lastDraft].push({
        sequence: int(r, h("stop_sequence")) ?? 0,
        stop,
        arrival: gtfsTime(r, h("arrival_time")) ?? MISSING,
        departure: gtfsTime(r, h("departure_time")) ?? MISSING,
        flags,
      });
    });

    const transfers = file("transfers.txt", false);
    if (transfers) {
      await forEachRow(transfers, (h, r) => {
        if (field(r, h("from_trip_id")) !== "" || field(r, h("to_trip_id")) !== "") return;
        const from = stops.get(field(r, h("from_stop_id")));
        const to = stops.get(field(r, h("to_stop_id")));
        if (from === undefined || to === undefined) return;
        transferFrom.push(from);
        transferTo.push(to);
        transferType.push(Math.min(Math.max(int(r, h("transfer_type")) ?? 0, 0), 255));
        transferSeconds.push(int(r, h("min_transfer_time")) ?? -1);
      });
    }

    const shapesFile = shapes.size > 0 ? file("shapes.txt", false) : null;
    if (shapesFile) {
      await forEachRow(shapesFile, (h, r) => {
        const slot = shapes.get(field(r, h("shape_id")));
        const lat = double(r, h("shape_pt_lat"));
        const lon = double(r, h("shape_pt_lon"));
        if (slot === undefined || lat === null || lon === null) return;
        shapePoints[slot].push({ sequence: int(r, h("shape_pt_sequence")) ?? 0, lat: Math.fround(lat), lon: Math.fround(lon) });
      });
    }
  }

  const zone = timeZoneName && isValidTimeZone(timeZoneName) ? timeZoneName : "America/New_York";
  const reference = referenceEpoch(date, zone);
  const dayShift = dayDates.map((day) => referenceEpoch(day, zone) - reference);

  // Trip instances: one per (trip, active day), times shifted onto this day's clock.
  const instanceDraft: number[] = [], instanceDay: number[] = [], instanceStart: number[] = [];
  const instanceArrivals: number[] = [], instanceDepartures: number[] = [];
  const groups = new Map<string, number>();
  const groupKeys: { route: number; stops: number[]; flags: number[] }[] = [];
  const groupInstances: number[][] = [];

  for (let draftIndex = 0; draftIndex < drafts.length; draftIndex++) {
    const tripRows = rows[draftIndex];
    rows[draftIndex] = [];
    if (!normalize(tripRows)) continue;
    const draft = drafts[draftIndex];
    const stops = tripRows.map((row) => row.stop);
    const flags = tripRows.map((row) => row.flags);
    const key = `${draft.route}|${stops.join(",")}|${flags.join("")}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = groupKeys.length;
      groups.set(key, group);
      groupKeys.push({ route: draft.route, stops, flags });
      groupInstances.push([]);
    }
    for (let bit = 0; bit < 3; bit++) {
      if ((draft.days & (1 << bit)) === 0) continue;
      const shift = dayShift[bit];
      if (bit === 0 && tripRows[tripRows.length - 1].arrival + shift < 0) continue;
      if (bit === 2 && tripRows[0].departure >= horizon) continue;
      groupInstances[group].push(instanceDraft.length);
      instanceDraft.push(draftIndex);
      instanceDay.push(bit - 1);
      instanceStart.push(instanceArrivals.length);
      for (const row of tripRows) {
        instanceArrivals.push(row.arrival + shift);
        instanceDepartures.push(row.departure + shift);
      }
    }
  }

  const patternRoute: number[] = [], patternShapeSlot: number[] = [];
  const patternStopOffsets = [0], patternTripOffsets = [0], patternEventOffsets = [0];
  const patternStops: number[] = [], patternStopFlags: number[] = [];
  const tripID: string[] = [], tripShortName: string[] = [], tripHeadsign: string[] = [], tripDayOffset: number[] = [];
  const arrivals: number[] = [], departures: number[] = [];

  groupKeys.forEach((key, group) => {
    const length = key.stops.length;
    const arrival = (instance: number, position: number) => instanceArrivals[instanceStart[instance] + position];
    const departure = (instance: number, position: number) => instanceDepartures[instanceStart[instance] + position];
    const ordered = groupInstances[group].slice().sort(
      (a, b) => departure(a, 0) - departure(b, 0) || arrival(a, length - 1) - arrival(b, length - 1) || a - b,
    );
    // Greedy split into overtaking-free sub-patterns. Checking only each sub-pattern's last trip suffices: trips
    // are sorted by first departure and "no later at every stop" is transitive.
    const splits: number[][] = [];
    for (const instance of ordered) {
      const target = splits.find((split) => {
        const last = split[split.length - 1];
        for (let i = 0; i < length; i++) {
          if (arrival(last, i) > arrival(instance, i) || departure(last, i) > departure(instance, i)) return false;
        }
        return true;
      });
      if (target) target.push(instance);
      else splits.push([instance]);
    }
    for (const split of splits) {
      patternRoute.push(key.route);
      patternShapeSlot.push(drafts[instanceDraft[split[0]]].shape);
      patternStops.push(...key.stops);
      patternStopFlags.push(...key.flags);
      patternStopOffsets.push(patternStops.length);
      for (const instance of split) {
        const draft = drafts[instanceDraft[instance]];
        tripID.push(draft.tripID);
        tripShortName.push(draft.shortName);
        tripHeadsign.push(draft.headsign);
        tripDayOffset.push(instanceDay[instance]);
        const start = instanceStart[instance];
        for (let i = 0; i < length; i++) {
          arrivals.push(instanceArrivals[start + i]);
          departures.push(instanceDepartures[start + i]);
        }
      }
      patternTripOffsets.push(tripID.length);
      patternEventOffsets.push(arrivals.length);
    }
  });

  // Shapes used by emitted patterns, and each pattern stop's nearest shape point.
  const shapeOutput = new Map<number, number>();
  const shapeOffsets = [0];
  const shapeLat: number[] = [], shapeLon: number[] = [];
  const patternShape: number[] = [], patternStopShapePoint: number[] = [];
  for (let pattern = 0; pattern < patternRoute.length; pattern++) {
    const begin = patternStopOffsets[pattern], end = patternStopOffsets[pattern + 1];
    const slot = patternShapeSlot[pattern];
    if (slot < 0 || shapePoints[slot].length < 2) {
      patternShape.push(-1);
      for (let i = begin; i < end; i++) patternStopShapePoint.push(-1);
      continue;
    }
    let output = shapeOutput.get(slot);
    if (output === undefined) {
      output = shapeOffsets.length - 1;
      shapeOutput.set(slot, output);
      const points = shapePoints[slot].slice().sort((a, b) => a.sequence - b.sequence);
      for (const point of points) {
        shapeLat.push(point.lat);
        shapeLon.push(point.lon);
      }
      shapeOffsets.push(shapeLat.length);
    }
    patternShape.push(output);
    const rangeEnd = shapeOffsets[output + 1];
    let cursor = shapeOffsets[output];
    for (let i = begin; i < end; i++) {
      const stop = patternStops[i];
      cursor = nearestShapePoint(stopLat[stop], stopLon[stop], shapeLat, shapeLon, cursor, rangeEnd);
      patternStopShapePoint.push(cursor);
    }
  }

  // Stop to (pattern, position) index, and each served stop's mode.
  const stopCount = stopID.length;
  const stopPatternOffsets = new Int32Array(stopCount + 1);
  const stopMode = new Uint8Array(stopCount).fill(UNSERVED);
  for (let pattern = 0; pattern < patternRoute.length; pattern++) {
    const code = MODES.indexOf(modeOf(routeType[patternRoute[pattern]]));
    for (let i = patternStopOffsets[pattern]; i < patternStopOffsets[pattern + 1]; i++) {
      const stop = patternStops[i];
      stopPatternOffsets[stop + 1] += 1;
      if (stopMode[stop] === UNSERVED) stopMode[stop] = code;
      const parent = stopParent[stop];
      if (parent >= 0 && stopMode[parent] === UNSERVED) stopMode[parent] = code;
    }
  }
  for (let stop = 0; stop < stopCount; stop++) stopPatternOffsets[stop + 1] += stopPatternOffsets[stop];
  const fill = stopPatternOffsets.slice(0, stopCount);
  const stopPatternRefs = new Int32Array(stopPatternOffsets[stopCount]);
  const stopPatternPositions = new Int32Array(stopPatternOffsets[stopCount]);
  for (let pattern = 0; pattern < patternRoute.length; pattern++) {
    const base = patternStopOffsets[pattern];
    for (let i = base; i < patternStopOffsets[pattern + 1]; i++) {
      const stop = patternStops[i];
      stopPatternRefs[fill[stop]] = pattern;
      stopPatternPositions[fill[stop]] = i - base;
      fill[stop] += 1;
    }
  }

  return {
    serviceDate: date,
    referenceEpoch: reference,
    timeZone: zone,
    stopID,
    stopName,
    stopLat: Float64Array.from(stopLat),
    stopLon: Float64Array.from(stopLon),
    stopParent: Int32Array.from(stopParent),
    stopLocationType: Uint8Array.from(stopLocationType),
    stopDirection: Uint8Array.from(stopDirection),
    stopMode,
    stopPatternOffsets,
    stopPatternRefs,
    stopPatternPositions,
    routeID,
    routeShortName,
    routeLongName,
    routeColor,
    routeTextColor,
    routeType: Int32Array.from(routeType),
    patternRoute: Int32Array.from(patternRoute),
    patternShape: Int32Array.from(patternShape),
    patternStopOffsets: Int32Array.from(patternStopOffsets),
    patternTripOffsets: Int32Array.from(patternTripOffsets),
    patternEventOffsets: Int32Array.from(patternEventOffsets),
    patternStops: Int32Array.from(patternStops),
    patternStopFlags: Uint8Array.from(patternStopFlags),
    patternStopShapePoint: Int32Array.from(patternStopShapePoint),
    tripID,
    tripShortName,
    tripHeadsign,
    tripDayOffset: Int8Array.from(tripDayOffset),
    arrivals: Int32Array.from(arrivals),
    departures: Int32Array.from(departures),
    shapeOffsets: Int32Array.from(shapeOffsets),
    shapeLat: Float32Array.from(shapeLat),
    shapeLon: Float32Array.from(shapeLon),
    transferFrom: Int32Array.from(transferFrom),
    transferTo: Int32Array.from(transferTo),
    transferType: Uint8Array.from(transferType),
    transferSeconds: Int32Array.from(transferSeconds),
  };
}

// Sorts by stop_sequence, fills a missing arrival or departure from the other, interpolates runs of untimed stops
// by position, and clamps times to be non-decreasing. False when the ends are untimed.
function normalize(rows: Row[]): boolean {
  if (rows.length < 2) return false;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i - 1].sequence > rows[i].sequence) {
      rows.sort((a, b) => a.sequence - b.sequence);
      break;
    }
  }
  for (const row of rows) {
    if (row.arrival === MISSING) row.arrival = row.departure;
    if (row.departure === MISSING) row.departure = row.arrival;
  }
  const first = rows[0], last = rows[rows.length - 1];
  if (first.departure === MISSING || last.arrival === MISSING) return false;
  let known = 0;
  for (let index = 1; index < rows.length; index++) {
    if (rows[index].arrival === MISSING) continue;
    const gap = index - known;
    if (gap > 1) {
      const start = rows[known].departure;
      const span = rows[index].arrival - start;
      for (let step = 1; step < gap; step++) {
        const time = start + Math.trunc((span * step) / gap);
        rows[known + step].arrival = time;
        rows[known + step].departure = time;
      }
    }
    known = index;
  }
  let floor = first.arrival;
  for (const row of rows) {
    row.arrival = Math.max(row.arrival, floor);
    row.departure = Math.max(row.departure, row.arrival);
    floor = row.departure;
  }
  return true;
}

// Scans forward from `start` and stops once the distance climbs well past the best match, so loop routes that pass
// a stop twice match the pass that comes first after the previous stop.
function nearestShapePoint(lat: number, lon: number, shapeLat: number[], shapeLon: number[], start: number, end: number): number {
  const metersPerDegree = 111_195;
  const longitudeScale = Math.cos((lat * Math.PI) / 180);
  let best = start;
  let bestMeters = Infinity;
  for (let index = start; index < end; index++) {
    const dy = (shapeLat[index] - lat) * metersPerDegree;
    const dx = (shapeLon[index] - lon) * metersPerDegree * longitudeScale;
    const meters = Math.sqrt(dx * dx + dy * dy);
    if (meters < bestMeters) {
      best = index;
      bestMeters = meters;
    } else if (bestMeters < 50 && meters > bestMeters + 500) break;
  }
  return best;
}
