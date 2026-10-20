import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Timetable } from "../src/timetable.ts";
import type { TimetableData } from "../src/timetable.ts";
import { CLOSED, PASSED } from "../src/types.ts";
import { decodeFeedMessage, MalformedFeedError } from "../src/realtime/protobuf.ts";
import type { FeedMessage, TripUpdate } from "../src/realtime/protobuf.ts";
import { buildOverlay, buildRealtimeIndex, subwayKey } from "../src/realtime/overlay.ts";
import { SUBWAY_FEEDS } from "../src/realtime/feeds.ts";
import type { RealtimeFeed } from "../src/realtime/feeds.ts";

const fixture = (name: string) => new Uint8Array(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

test("subway G feed decodes", () => {
  const message = decodeFeedMessage(fixture("subway-g.pb"));
  assert.equal(message.timestamp, 1_790_814_001);
  assert.equal(message.tripUpdates.length, 25);
  assert.ok(message.tripUpdates.every((u) => u.trip.routeID === "G" && u.trip.startDate === "20260930"));
  const first = message.tripUpdates[0];
  assert.equal(first.trip.tripID, "118400_G..S14R");
  assert.deepEqual(first.stopTimes.map((s) => s.stopID), ["F26S", "F27S"]);
  assert.equal(first.stopTimes[0].arrival?.time, 1_790_814_060);
  assert.equal(message.alerts.length, 0);
});

test("alert feed decodes", () => {
  const message = decodeFeedMessage(fixture("lirr-alerts.pb"));
  assert.equal(message.alerts.length, 15);
  const alert = message.alerts[0];
  assert.equal(alert.id, "lmm:alert:269742:26");
  assert.ok(alert.header.startsWith("There are delays and one cancellation along the Port Jefferson Branch"));
  assert.deepEqual(alert.periods, [{ start: 1_790_812_063, end: null }]);
  assert.deepEqual(alert.entities[0], { agencyID: "LI", routeID: "10", stopID: null, tripID: null });
  assert.ok(message.alerts.some((a) => a.entities.some((e) => e.tripID !== null)));
});

test("truncated data throws", () => {
  assert.throws(() => decodeFeedMessage(fixture("subway-g.pb").subarray(0, 1000)), MalformedFeedError);
});

test("subway keys match static and realtime ids", () => {
  assert.equal(subwayKey("ASP26GEN-1038-Sunday-00_000600_1..S03R"), "000600_1..S");
  assert.equal(subwayKey("110000_A..N"), "110000_A..N");
  assert.equal(subwayKey("ASP26GEN-GS013-Saturday-00_036000_GS.N01R"), "036000_GS.N");
  assert.equal(subwayKey("036000_GS.N"), "036000_GS.N");
  assert.equal(subwayKey("BSP26GEN-D042-Weekday-00_145650_D..N05R"), "001650_D..N");
  assert.equal(subwayKey("GO202_26_20"), null);
});

test("subway feeds: 8 trip update feeds and the MTA alerts feed", () => {
  assert.equal(SUBWAY_FEEDS.filter((f) => f.content.kind === "tripUpdates").length, 8);
  assert.ok(SUBWAY_FEEDS.some((f) => f.id === "subway-gtfs-g" && f.url.endsWith("nyct%2Fgtfs-g")));
});

// Line 1 runs AS -> XS -> YS. 1-0005 is the next day's trip, shifted onto this day.
const H = (h: number, m: number, s = 0) => h * 3600 + m * 60 + s;
const EPOCH = 1_790_740_800; // 2026-09-30 00:00 New York
const TRIPS: [string, number, number[]][] = [
  ["1-0800", 0, [H(8, 0), H(8, 10), H(8, 15)]],
  ["1-0830", 0, [H(8, 30), H(8, 37, 30), H(8, 45)]],
  ["1-2350", 0, [H(23, 50), H(24, 0), H(24, 10)]],
  ["1-0005", 1, [H(24, 5), H(24, 15), H(24, 20)]],
];

function lineOne(): Timetable {
  const times = Int32Array.from(TRIPS.flatMap(([, , t]) => t));
  const data: TimetableData = {
    serviceDate: "20260930",
    referenceEpoch: EPOCH,
    timeZone: "America/New_York",
    stopID: ["t:AS", "t:XS", "t:YS"],
    stopName: ["A St", "X St", "Y Sq"],
    stopLat: Float64Array.from([40.7, 40.71, 40.72]),
    stopLon: Float64Array.from([-74, -74, -74]),
    stopParent: Int32Array.from([-1, -1, -1]),
    stopLocationType: new Uint8Array(3),
    stopDirection: new Uint8Array(3),
    stopMode: new Uint8Array(3),
    stopPatternOffsets: Int32Array.from([0, 1, 2, 3]),
    stopPatternRefs: Int32Array.from([0, 0, 0]),
    stopPatternPositions: Int32Array.from([0, 1, 2]),
    routeID: ["t:1"],
    routeShortName: ["1"],
    routeLongName: [""],
    routeColor: [""],
    routeTextColor: [""],
    routeType: Int32Array.from([1]),
    patternRoute: Int32Array.from([0]),
    patternShape: Int32Array.from([-1]),
    patternStopOffsets: Int32Array.from([0, 3]),
    patternTripOffsets: Int32Array.from([0, TRIPS.length]),
    patternEventOffsets: Int32Array.from([0, times.length]),
    patternStops: Int32Array.from([0, 1, 2]),
    patternStopFlags: new Uint8Array(3),
    patternStopShapePoint: Int32Array.from([-1, -1, -1]),
    tripID: TRIPS.map(([id]) => id),
    tripShortName: TRIPS.map(() => ""),
    tripHeadsign: TRIPS.map(() => "Y Sq"),
    tripDayOffset: Int8Array.from(TRIPS.map(([, day]) => day)),
    arrivals: times,
    departures: times.slice(),
    shapeOffsets: Int32Array.from([0]),
    shapeLat: new Float32Array(0),
    shapeLon: new Float32Array(0),
    transferFrom: new Int32Array(0),
    transferTo: new Int32Array(0),
    transferType: new Uint8Array(0),
    transferSeconds: new Int32Array(0),
  };
  return new Timetable(data);
}

const FEED: RealtimeFeed = { id: "t-rt", url: "", content: { kind: "tripUpdates", namespace: "t", match: "tripID" } };

function update(tripID: string, stops: [string, number | null][], relationship = 0, startDate: string | null = null): TripUpdate {
  return {
    entityID: tripID,
    trip: { tripID, routeID: "1", startDate, relationship },
    stopTimes: stops.map(([stopID, seconds]) => {
      const event = seconds === null ? null : { delay: null, time: EPOCH + seconds };
      return { stopID, arrival: event, departure: event, skipped: seconds === null };
    }),
  };
}

function overlay(timetable: Timetable, updates: TripUpdate[]) {
  const message: FeedMessage = { timestamp: null, tripUpdates: updates, alerts: [] };
  return buildOverlay(timetable, buildRealtimeIndex(timetable, [FEED]), [[FEED, message]]);
}

// Row of a realtime trip: [arrivals, departures].
function row(o: ReturnType<typeof overlay>, tripID: string) {
  const trips = o.patterns.get(0)!;
  const i = trips.trips.findIndex((t) => t.tripID === tripID);
  assert.ok(i >= 0, tripID);
  return { trip: trips.trips[i], arrivals: [...trips.arrivals.subarray(i * 3, i * 3 + 3)], departures: [...trips.departures.subarray(i * 3, i * 3 + 3)] };
}

test("delay propagates and moves the trip behind the next one", () => {
  const o = overlay(lineOne(), [update("1-0800", [["AS", H(8, 40)]])]);
  assert.equal(o.updatedTrips, 1);
  const trips = o.patterns.get(0)!;
  assert.deepEqual(trips.trips.map((t) => t.tripID), ["1-0830", "1-0800", "1-2350", "1-0005"]);
  assert.deepEqual(trips.blocks, [{ start: 0, end: 4 }]);
  const late = row(o, "1-0800");
  assert.equal(late.trip.updated, true);
  assert.equal(late.trip.base, 0);
  assert.deepEqual(late.departures, [H(8, 40), H(8, 50), H(8, 55)]);
  assert.equal(row(o, "1-0830").trip.updated, false);
});

test("overtaking trips split into blocks", () => {
  const o = overlay(lineOne(), [update("1-0800", [["AS", H(8, 20)], ["XS", H(8, 40)], ["YS", H(8, 50)]])]);
  const trips = o.patterns.get(0)!;
  assert.deepEqual(trips.trips.map((t) => t.tripID), ["1-0800", "1-2350", "1-0005", "1-0830"]);
  assert.deepEqual(trips.blocks, [{ start: 0, end: 3 }, { start: 3, end: 4 }]);
});

test("canceled, added, and skipped stops apply", () => {
  const o = overlay(lineOne(), [
    update("1-0830", [], 3),
    update("1-extra", [["AS", H(8, 50)], ["XS", H(9, 0)], ["YS", H(9, 5)]]),
    update("1-2350", [["AS", H(23, 50)], ["XS", null], ["YS", H(24, 10)]]),
  ]);
  assert.equal(o.canceledTrips, 1);
  assert.equal(o.addedTrips, 1);
  assert.equal(o.updatedTrips, 1);
  assert.equal(o.unmatchedTrips, 0);
  assert.ok(!o.patterns.get(0)!.trips.some((t) => t.tripID === "1-0830"));
  const added = row(o, "1-extra");
  assert.equal(added.trip.base, -1);
  assert.deepEqual(added.departures, [H(8, 50), H(9, 0), H(9, 5)]);
  const skipped = row(o, "1-2350");
  assert.deepEqual(skipped.arrivals, [H(23, 50), CLOSED, H(24, 10)]);
  assert.deepEqual(skipped.departures, [H(23, 50), PASSED, H(24, 10)]);
});

test("stops before the first update are passed; a delay-only update shifts the rest", () => {
  const timetable = lineOne();
  const message: FeedMessage = {
    timestamp: null,
    tripUpdates: [{
      entityID: "e",
      trip: { tripID: "1-0830", routeID: "1", startDate: null, relationship: 0 },
      stopTimes: [{ stopID: "XS", arrival: { delay: 120, time: null }, departure: null, skipped: false }],
    }],
    alerts: [],
  };
  const o = buildOverlay(timetable, buildRealtimeIndex(timetable, [FEED]), [[FEED, message]]);
  const r = row(o, "1-0830");
  assert.deepEqual(r.arrivals, [PASSED, H(8, 39, 30), H(8, 47)]);
  assert.deepEqual(r.departures, [PASSED, H(8, 39, 30), H(8, 47)]);
});

test("unmatched updates on unknown routes are counted; updates naming no known stop are skipped", () => {
  const o = overlay(lineOne(), [
    { ...update("x", [["AS", H(9, 0)], ["YS", H(9, 10)]]), trip: { tripID: "x", routeID: "9", startDate: null, relationship: 0 } },
    update("1-0800", [["ZZ", H(9, 0)]]),
  ]);
  assert.equal(o.unmatchedTrips, 1);
  assert.equal(o.patterns.size, 0);
});

test("subway ids pick the instance nearest in time, else the one on start_date", () => {
  // The same static trip on this day and the next, as previous- and next-day instances appear in a compiled day.
  const base = lineOne();
  const d = base.data;
  d.tripID = ["A_048000_1..S01R", "B_051000_1..S01R", "C_142000_1..S01R", "A_048000_1..S01R"];
  d.departures.set([H(32, 0), H(32, 10), H(32, 15)], 9);
  d.arrivals.set([H(32, 0), H(32, 10), H(32, 15)], 9);
  const timetable = new Timetable(d);
  const feed: RealtimeFeed = { id: "s", url: "", content: { kind: "tripUpdates", namespace: "t", match: "subwayTripID" } };
  const run = (u: TripUpdate) =>
    buildOverlay(timetable, buildRealtimeIndex(timetable, [feed]), [[feed, { timestamp: null, tripUpdates: [u], alerts: [] }]]);

  const tomorrow = run(update("048000_1..S", [["AS", H(32, 3)]]));
  assert.equal(tomorrow.updatedTrips, 1);
  assert.equal(tomorrow.patterns.get(0)!.trips.find((t) => t.updated)!.base, 3);

  const canceledToday = run(update("048000_1..S", [], 3, "20260930"));
  assert.ok(!canceledToday.patterns.get(0)!.trips.some((t) => t.base === 0));
  const canceledTomorrow = run(update("048000_1..S", [], 3, "20261001"));
  assert.ok(!canceledTomorrow.patterns.get(0)!.trips.some((t) => t.base === 3));
});
