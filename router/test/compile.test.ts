import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compile, type TimetableSource } from "../src/compile.ts";
import { decode, encode } from "../src/encode.ts";
import { addDays, nextWeekday, parseServiceDate, referenceEpoch, weekday } from "../src/service-date.ts";
import { Timetable, type TimetableData } from "../src/timetable.ts";

// Mirrors scaffold Tests/TransitGTFSTests/SyntheticFeed.swift. Line 1 runs A, X, Y; the M2 bus leaves XB for DB;
// line 3 leaves Y's other platform for D. WK runs weekdays except 2026-11-11, when HOL replaces it. 1-2350 runs
// past midnight, 1-0005 starts just after it, 1-0830 has an untimed middle stop and rows out of order.
const SYNTHETIC: Record<string, string> = {
  "agency.txt": "agency_id,agency_name,agency_url,agency_timezone\nT,Test Transit,https://example.com,America/New_York\n",
  "stops.txt":
    "﻿" +
    [
      "stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station",
      "A,A Av,40.7000,-74.0000,1,",
      "AS,A Av,40.7000,-74.0000,0,A",
      "AN,A Av,40.7000,-74.0000,0,A",
      "X,X St,40.7200,-74.0000,1,",
      "XS,X St,40.7200,-74.0000,0,X",
      "XN,X St,40.7200,-74.0000,0,X",
      'XB,"X St, Bus Stop",  40.7209, -74.0000,0,',
      'Y,"Y Sq ""Center""",40.7400,-74.0000,1,',
      "YS,Y Sq,40.7400,-74.0000,0,Y",
      "YN,Y Sq,40.7400,-74.0000,0,Y",
      "D,D Blvd,40.7650,-73.9900,1,",
      "DS,D Blvd,40.7650,-73.9900,0,D",
      "DB,D Blvd Bus,40.7600,-73.9800,0,",
      "",
    ].join("\r\n"),
  "routes.txt": [
    "route_id,agency_id,route_short_name,route_long_name,route_type,route_color,route_text_color",
    "1,T,1,Broadway Local,1,EE352E,FFFFFF",
    "3,T,3,Seventh Av Express,1,ee352e,",
    "M2,T,M2,Fifth Av,3,,",
    "",
  ].join("\n"),
  "calendar.txt": [
    "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date",
    "WK,1,1,1,1,1,0,0,20260901,20261231",
    "HOL,0,0,0,0,0,0,0,20260901,20261231",
    "",
  ].join("\n"),
  "calendar_dates.txt": "service_id,date,exception_type\nWK,20261111,2\nHOL,20261111,1\n",
  "trips.txt": [
    "route_id,service_id,trip_id,trip_headsign,direction_id,shape_id",
    "1,WK,1-0005,Y Sq,1,1S",
    "1,WK,1-0800,Y Sq,1,1S",
    "1,WK,1-0830,Y Sq,1,1S",
    "1,WK,1-2350,Y Sq,1,1S",
    "1,HOL,1-H0900,Y Sq,1,1S",
    "M2,WK,M2-0820,,0,",
    "3,WK,3-0830,D Blvd,0,",
    "",
  ].join("\n"),
  "stop_times.txt": [
    "trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type",
    "1-0005,0:05:00,0:05:00,AS,1,0,0",
    "1-0005,0:15:00,0:15:00,XS,2,0,0",
    "1-0005,0:20:00,0:20:00,YS,3,0,0",
    "1-0800,08:00:00,08:00:00,AS,1,0,0",
    "1-0800,08:10:00,08:10:00,XS,2,0,0",
    "1-0800,08:15:00,08:15:00,YS,3,0,0",
    "1-0830,08:45:00,08:45:00,YS,3,0,0",
    "1-0830,,,XS,2,0,0",
    "1-0830,08:30:00,08:30:00,AS,1,0,0",
    "1-2350,23:50:00,23:50:00,AS,1,0,0",
    "1-2350,24:05:00,24:05:00,XS,2,0,0",
    "1-2350,24:10:00,24:10:00,YS,3,0,0",
    "1-H0900,09:00:00,09:00:00,AS,1,0,0",
    "1-H0900,09:10:00,09:10:00,XS,2,0,0",
    "1-H0900,09:15:00,09:15:00,YS,3,0,0",
    "M2-0820,08:20:00,08:20:00,XB,1,0,1",
    "M2-0820,08:30:00,08:30:00,DB,2,1,0",
    "3-0830,08:30:00,08:30:00,YN,1,0,0",
    "3-0830,08:40:00,08:40:00,DS,2,0,0",
    "",
  ].join("\n"),
  "transfers.txt": "from_stop_id,to_stop_id,transfer_type,min_transfer_time\nX,XB,2,120\nY,Y,2,60\n",
  "shapes.txt": [
    "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence",
    "1S,40.7400,-74.0000,5",
    "1S,40.7000,-74.0000,1",
    "1S,40.7100,-74.0010,2",
    "1S,40.7200,-74.0000,3",
    "1S,40.7300,-74.0010,4",
    "",
  ].join("\n"),
};

const WEDNESDAY = "20260930";
const HOLIDAY = "20261111";
const hms = (h: number, m: number, s = 0) => h * 3600 + m * 60 + s;

function writeFeed(files: Record<string, string>): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "router-gtfs-"));
  for (const [name, contents] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), contents);
  return directory;
}

const syntheticDir = writeFeed(SYNTHETIC);
const synthetic = (date: string) => compile([{ feedID: "t", namespace: "t", directory: syntheticDir }], date);
const fixture = path.join(import.meta.dirname, "fixtures", "subway-g");

function tripTimes(t: Timetable, trip: number): { pattern: number; arrivals: number[]; departures: number[] } {
  const d = t.data;
  let pattern = 0;
  while (d.patternTripOffsets[pattern + 1] <= trip) pattern++;
  const length = t.patternStopCount(pattern);
  const base = d.patternEventOffsets[pattern] + (trip - d.patternTripOffsets[pattern]) * length;
  return {
    pattern,
    arrivals: Array.from(d.arrivals.subarray(base, base + length)),
    departures: Array.from(d.departures.subarray(base, base + length)),
  };
}

function assertFIFO(t: Timetable) {
  const d = t.data;
  for (let p = 0; p < t.patternCount; p++) {
    const length = t.patternStopCount(p);
    const base = d.patternEventOffsets[p];
    for (let trip = 1; trip < t.patternTripCount(p); trip++) {
      for (let i = 0; i < length; i++) {
        const a = base + (trip - 1) * length + i, b = base + trip * length + i;
        assert.ok(d.arrivals[a] <= d.arrivals[b] && d.departures[a] <= d.departures[b], `pattern ${p} overtakes`);
      }
    }
  }
}

test("service date arithmetic and reference times", () => {
  assert.equal(weekday(WEDNESDAY), 2);
  assert.equal(addDays(WEDNESDAY, 1), "20261001");
  assert.equal(addDays("20261231", 1), "20270101");
  assert.equal(addDays("20280228", 1), "20280229");
  assert.equal(nextWeekday("20260927", 2), WEDNESDAY);
  assert.equal(nextWeekday(WEDNESDAY, 2), "20261007");
  assert.deepEqual(parseServiceDate("20261111"), { year: 2026, month: 11, day: 11 });
  assert.equal(parseServiceDate("2026111"), null);
  // DST ends 2026-11-01, so noon minus 12 h is 01:00 EDT rather than midnight.
  assert.equal(referenceEpoch("20261101", "America/New_York"), 1_793_509_200);
  assert.equal(referenceEpoch(WEDNESDAY, "America/New_York"), 1_790_740_800);
});

test("stops carry namespaces, parents, directions, and modes", async () => {
  const t = new Timetable(await synthetic(WEDNESDAY));
  assert.equal(t.stopCount, 13);
  assert.equal(t.data.timeZone, "America/New_York");
  const platform = t.stop(t.stopIndex("t:XS")!);
  const station = t.stop(platform.parent!);
  assert.equal(station.id, "t:X");
  assert.ok(station.isStation);
  assert.equal(station.mode, "subway");
  assert.equal(platform.direction, "S");
  assert.equal(platform.mode, "subway");
  assert.deepEqual(t.children(station.index).map((s) => t.stop(s).id).sort(), ["t:XN", "t:XS"]);
  const bus = t.stop(t.stopIndex("t:XB")!);
  assert.equal(bus.name, "X St, Bus Stop");
  assert.deepEqual(bus.location, { lat: 40.7209, lon: -74 });
  assert.equal(bus.mode, "bus");
  assert.equal(bus.direction, null);
  assert.equal(t.stop(t.stopIndex("t:Y")!).name, 'Y Sq "Center"');
  assert.equal(t.stop(t.stopIndex("t:XN")!).mode, null);
});

test("patterns group trips, include adjacent-day instances, and interpolate untimed stops", async () => {
  const t = new Timetable(await synthetic(WEDNESDAY));
  // Line 1 (Tuesday's overnight trip, four Wednesday trips, Thursday's 00:05), M2, line 3.
  assert.equal(t.patternCount, 3);
  assert.equal(t.tripCount, 8);
  assertFIFO(t);
  const lineOne = [...Array(t.patternCount).keys()].find((p) => t.routeOfPattern(p).shortName === "1")!;
  assert.deepEqual(t.stopsOfPattern(lineOne).map((s) => t.stop(s).id), ["t:AS", "t:XS", "t:YS"]);
  const three = [...Array(t.routeCount).keys()].map((r) => t.route(r)).find((r) => r.shortName === "3")!;
  assert.equal(three.id, "t:3");
  assert.equal(three.color, "EE352E");
  assert.equal(three.textColor, null);

  const d = t.data;
  const index = (id: string, offset: number) => d.tripID.findIndex((x, i) => x === id && d.tripDayOffset[i] === offset);
  const overnight = tripTimes(t, index("1-2350", -1));
  assert.deepEqual(overnight.arrivals, [hms(23, 50) - 86_400, hms(0, 5), hms(0, 10)]);
  const early = tripTimes(t, index("1-0005", 1));
  assert.deepEqual(early.departures, [hms(24, 5), hms(24, 15), hms(24, 20)]);
  assert.equal(index("1-0800", 1), -1);
  assert.equal(index("1-0005", -1), -1);
  assert.deepEqual(tripTimes(t, index("1-0830", 0)).arrivals, [hms(8, 30), hms(8, 37, 30), hms(8, 45)]);

  const m2 = [...Array(t.patternCount).keys()].find((p) => t.routeOfPattern(p).shortName === "M2")!;
  assert.deepEqual(Array.from(d.patternStopFlags.subarray(d.patternStopOffsets[m2], d.patternStopOffsets[m2 + 1])), [2, 1]);
  assert.equal(d.patternShape[m2], -1);
  assert.deepEqual(t.path(lineOne, 0, 1), [
    { lat: Math.fround(40.7), lon: Math.fround(-74) },
    { lat: Math.fround(40.71), lon: Math.fround(-74.001) },
    { lat: Math.fround(40.72), lon: Math.fround(-74) },
  ]);
  assert.deepEqual(t.transfers().map((x) => [t.stop(x.from).id, t.stop(x.to).id, x.type, x.minimumSeconds]), [
    ["t:X", "t:XB", 2, 120],
    ["t:Y", "t:Y", 2, 60],
  ]);
});

test("calendar exception swaps service", async () => {
  const t = new Timetable(await synthetic(HOLIDAY));
  const trips = t.data.tripID.map((id, i) => `${id}@${t.data.tripDayOffset[i]}`).sort();
  assert.deepEqual(trips, ["1-0005@1", "1-2350@-1", "1-H0900@0"]);
});

test("DST: the previous day's shift is 25 h when clocks fall back", async () => {
  const t = new Timetable(await synthetic("20261102"));
  const trip = t.data.tripID.findIndex((id, i) => id === "1-2350" && t.data.tripDayOffset[i] === -1);
  assert.ok(trip < 0, "Sunday 2026-11-01 has no WK service");
  const monday = new Timetable(await synthetic("20261101"));
  assert.equal(monday.tripCount, 1); // Monday's 00:05 only
  assert.equal(referenceEpoch("20261031", "America/New_York") - referenceEpoch("20261101", "America/New_York"), -90_000);
});

test("feeds sharing a namespace merge stops", async () => {
  const extra = {
    "stops.txt": "stop_id,stop_name,stop_lat,stop_lon\nXB,X St Bus,40.7209,-74.0\nZB,Z Rd,40.8,-74.0\n",
    "routes.txt": "route_id,route_short_name,route_long_name,route_type\nM2,Q1,Queens,3\n",
    "calendar.txt":
      "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nWK,1,1,1,1,1,1,1,20260101,20271231\n",
    "trips.txt": "route_id,service_id,trip_id\nM2,WK,Q1-1\n",
    "stop_times.txt": "trip_id,stop_id,arrival_time,departure_time,stop_sequence\nQ1-1,XB,09:00:00,09:00:00,1\nQ1-1,ZB,09:20:00,09:20:00,2\n",
  };
  const sources: TimetableSource[] = [
    { feedID: "t", namespace: "t", directory: syntheticDir },
    { feedID: "u", namespace: "t", directory: writeFeed(extra) },
    { feedID: "v", namespace: "v", directory: writeFeed(extra) },
  ];
  const t = new Timetable(await compile(sources, WEDNESDAY));
  assert.equal(t.stopCount, 16);
  const merged = t.stopIndex("t:XB")!;
  assert.equal(t.stop(merged).name, "X St, Bus Stop");
  assert.ok(t.stopIndex("t:ZB") !== undefined);
  assert.ok(t.stopIndex("v:XB") !== undefined);
  const routes = new Set(t.data.routeID);
  for (const id of ["t:M2", "u:M2", "v:M2"]) assert.ok(routes.has(id));
  assert.deepEqual(new Set(t.patternsAtStop(merged).map((p) => t.routeOfPattern(p).id)), new Set(["t:M2", "u:M2"]));
});

test("G line fixture compiles for 2026-10-01 with the previous day's trips shifted", async () => {
  const data = await compile([{ feedID: "subway", namespace: "subway", directory: fixture }], "20261001");
  const t = new Timetable(data);
  assert.ok(data.stopID.every((id) => id.startsWith("subway:")));
  assert.ok(t.patternCount > 0 && t.tripCount > 0);
  assertFIFO(t);
  const hoyt = t.stopIndex("subway:A42")!;
  assert.ok(t.stop(hoyt).isStation);
  assert.equal(t.stop(t.stopIndex("subway:A42N")!).direction, "N");
  assert.equal(t.stop(t.stopIndex("subway:A42S")!).parent, hoyt);
  assert.equal(t.route(0).id, "subway:G");
  assert.equal(t.route(0).color, "799534");

  const services = new Map<string, string>();
  for (const line of fs.readFileSync(path.join(fixture, "trips.txt"), "utf8").trim().split("\n").slice(1)) {
    const [, tripID, serviceID] = line.split(",");
    services.set(tripID, serviceID);
  }
  const offsets = new Set<string>();
  data.tripID.forEach((id, i) => offsets.add(`${services.get(id)}@${data.tripDayOffset[i]}`));
  assert.ok(!offsets.has("L0S8@-1") && !offsets.has("L0S8@0"));
  assert.ok([...offsets].every((x) => x === "L0S1@0" || x === "L0S9@-1"));

  const staticRows = fs.readFileSync(path.join(fixture, "stop_times.txt"), "utf8").trim().split("\n").slice(1);
  const previous = data.tripID.findIndex((_, i) => data.tripDayOffset[i] === -1);
  if (previous >= 0) {
    const first = staticRows.find((row) => row.startsWith(data.tripID[previous] + ","))!.split(",")[2];
    const [h, m, s] = first.split(":").map(Number);
    assert.equal(tripTimes(t, previous).arrivals[0], h * 3600 + m * 60 + s - 86_400);
  }
});

test("encode and decode round trip exactly, from aligned and misaligned buffers", async () => {
  const data = await compile([{ feedID: "subway", namespace: "subway", directory: fixture }], "20261001");
  const bytes = encode(data);
  assert.deepStrictEqual(decode(bytes), data);
  const shifted = new Uint8Array(bytes.length + 3);
  shifted.set(bytes, 3);
  const decoded: TimetableData = decode(shifted.subarray(3));
  assert.deepStrictEqual(decoded, data);
  assert.throws(() => decode(new Uint8Array(16)), /not a timetable/);
});
