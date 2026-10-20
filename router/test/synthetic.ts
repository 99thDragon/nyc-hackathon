// Hand-compiled Wednesday 2026-09-30 timetable of scaffold `SyntheticFeed.swift`: line 1 A -> X -> Y, the M2
// bus from XB (100 m from X) to DB, line 3 from Y's other platform to D. Previous-day 1-2350 and next-day 1-0005
// are included as the compiler would shift them; 1-0830's untimed XS is interpolated to 08:37:30.

import { Timetable, type TimetableData } from "../src/timetable.ts";

export const hms = (h: number, m: number, s = 0) => h * 3600 + m * 60 + s;

const stops: [string, string, number, number, number, number][] = [
  // id, name, lat, lon, location type, parent
  ["t:A", "A Av", 40.7, -74.0, 1, -1],
  ["t:AS", "A Av", 40.7, -74.0, 0, 0],
  ["t:AN", "A Av", 40.7, -74.0, 0, 0],
  ["t:X", "X St", 40.72, -74.0, 1, -1],
  ["t:XS", "X St", 40.72, -74.0, 0, 3],
  ["t:XN", "X St", 40.72, -74.0, 0, 3],
  ["t:XB", "X St, Bus Stop", 40.7209, -74.0, 0, -1],
  ["t:Y", 'Y Sq "Center"', 40.74, -74.0, 1, -1],
  ["t:YS", "Y Sq", 40.74, -74.0, 0, 7],
  ["t:YN", "Y Sq", 40.74, -74.0, 0, 7],
  ["t:D", "D Blvd", 40.765, -73.99, 1, -1],
  ["t:DS", "D Blvd", 40.765, -73.99, 0, 10],
  ["t:DB", "D Blvd Bus", 40.76, -73.98, 0, -1],
];

interface PatternDraft {
  route: number;
  stops: number[];
  flags: number[];
  shape: number;
  shapePoints: number[];
  trips: { id: string; headsign: string; day: number; times: number[] }[];
}

export const patterns: PatternDraft[] = [
  {
    route: 0, stops: [1, 4, 8], flags: [0, 0, 0], shape: 0, shapePoints: [0, 2, 4],
    trips: [
      { id: "1-2350", headsign: "Y Sq", day: -1, times: [-600, 300, 600] },
      { id: "1-0005", headsign: "Y Sq", day: 0, times: [hms(0, 5), hms(0, 15), hms(0, 20)] },
      { id: "1-0800", headsign: "Y Sq", day: 0, times: [hms(8, 0), hms(8, 10), hms(8, 15)] },
      { id: "1-0830", headsign: "Y Sq", day: 0, times: [hms(8, 30), hms(8, 37, 30), hms(8, 45)] },
      { id: "1-2350", headsign: "Y Sq", day: 0, times: [hms(23, 50), hms(24, 5), hms(24, 10)] },
      { id: "1-0005", headsign: "Y Sq", day: 1, times: [hms(24, 5), hms(24, 15), hms(24, 20)] },
    ],
  },
  {
    route: 2, stops: [6, 12], flags: [2, 1], shape: -1, shapePoints: [-1, -1],
    trips: [{ id: "M2-0820", headsign: "", day: 0, times: [hms(8, 20), hms(8, 30)] }],
  },
  {
    route: 1, stops: [9, 11], flags: [0, 0], shape: -1, shapePoints: [-1, -1],
    trips: [{ id: "3-0830", headsign: "D Blvd", day: 0, times: [hms(8, 30), hms(8, 40)] }],
  },
];

export function wednesday(): Timetable {
  const n = stops.length;
  const routeType = [1, 1, 3];
  const stopMode = new Uint8Array(n).fill(255);
  const refs: number[][] = Array.from({ length: n }, () => []);
  const patternStops: number[] = [];
  const flags: number[] = [];
  const shapePoint: number[] = [];
  const stopOffsets = [0];
  const tripOffsets = [0];
  const eventOffsets = [0];
  const trip = { id: [] as string[], short: [] as string[], headsign: [] as string[], day: [] as number[] };
  const times: number[] = [];
  patterns.forEach((p, index) => {
    const mode = routeType[p.route] === 3 ? 1 : 0;
    p.stops.forEach((stop, position) => {
      refs[stop].push(index, position);
      if (stopMode[stop] === 255) stopMode[stop] = mode;
      const parent = stops[stop][5];
      if (parent >= 0 && stopMode[parent] === 255) stopMode[parent] = mode;
    });
    patternStops.push(...p.stops);
    flags.push(...p.flags);
    shapePoint.push(...p.shapePoints);
    stopOffsets.push(patternStops.length);
    for (const t of p.trips) {
      trip.id.push(t.id);
      trip.short.push("");
      trip.headsign.push(t.headsign);
      trip.day.push(t.day);
      times.push(...t.times);
    }
    tripOffsets.push(trip.id.length);
    eventOffsets.push(times.length);
  });
  const stopPatternOffsets = [0];
  const stopPatternRefs: number[] = [];
  const stopPatternPositions: number[] = [];
  for (const list of refs) {
    for (let i = 0; i < list.length; i += 2) {
      stopPatternRefs.push(list[i]);
      stopPatternPositions.push(list[i + 1]);
    }
    stopPatternOffsets.push(stopPatternRefs.length);
  }
  const data: TimetableData = {
    serviceDate: "20260930",
    referenceEpoch: 1_790_827_200 - 86_400,
    timeZone: "America/New_York",
    stopID: stops.map((s) => s[0]),
    stopName: stops.map((s) => s[1]),
    stopLat: Float64Array.from(stops, (s) => s[2]),
    stopLon: Float64Array.from(stops, (s) => s[3]),
    stopParent: Int32Array.from(stops, (s) => s[5]),
    stopLocationType: Uint8Array.from(stops, (s) => s[4]),
    stopDirection: Uint8Array.from(stops, (s) => {
      const parent = s[5] >= 0 ? stops[s[5]][0] : null;
      return parent === null ? 0 : s[0] === parent + "N" ? 1 : s[0] === parent + "S" ? 2 : 0;
    }),
    stopMode,
    stopPatternOffsets: Int32Array.from(stopPatternOffsets),
    stopPatternRefs: Int32Array.from(stopPatternRefs),
    stopPatternPositions: Int32Array.from(stopPatternPositions),
    routeID: ["t:1", "t:3", "t:M2"],
    routeShortName: ["1", "3", "M2"],
    routeLongName: ["Broadway Local", "Seventh Av Express", "Fifth Av"],
    routeColor: ["EE352E", "EE352E", ""],
    routeTextColor: ["FFFFFF", "", ""],
    routeType: Int32Array.from(routeType),
    patternRoute: Int32Array.from(patterns, (p) => p.route),
    patternShape: Int32Array.from(patterns, (p) => p.shape),
    patternStopOffsets: Int32Array.from(stopOffsets),
    patternTripOffsets: Int32Array.from(tripOffsets),
    patternEventOffsets: Int32Array.from(eventOffsets),
    patternStops: Int32Array.from(patternStops),
    patternStopFlags: Uint8Array.from(flags),
    patternStopShapePoint: Int32Array.from(shapePoint),
    tripID: trip.id,
    tripShortName: trip.short,
    tripHeadsign: trip.headsign,
    tripDayOffset: Int8Array.from(trip.day),
    arrivals: Int32Array.from(times),
    departures: Int32Array.from(times),
    shapeOffsets: Int32Array.from([0, 5]),
    shapeLat: Float32Array.from([40.7, 40.71, 40.72, 40.73, 40.74]),
    shapeLon: Float32Array.from([-74.0, -74.001, -74.0, -74.001, -74.0]),
    transferFrom: Int32Array.from([3, 7]),
    transferTo: Int32Array.from([6, 7]),
    transferType: Uint8Array.from([2, 2]),
    transferSeconds: Int32Array.from([120, 60]),
  };
  return new Timetable(data);
}
