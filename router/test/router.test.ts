import { test } from "node:test";
import assert from "node:assert/strict";
import { standardFootpaths, Footpaths } from "../src/footpaths.ts";
import { preferredJourney, TransitRouter } from "../src/router.ts";
import { planAccess, selectPlans } from "../src/plans.ts";
import { CLOSED, DEFAULT_PREFERENCES, PASSED, type Journey, type RealtimeOverlay, type RideLeg, type TransitQuery, type WaitLeg } from "../src/types.ts";
import { hms, wednesday } from "./synthetic.ts";

const tt = wednesday();
// Scaffold CoverPreferences defaults: in-station walks 1.0, street walks 2.0.
const scaffoldPreferences = { ...DEFAULT_PREFERENCES, streetWalkWeight: 2 };
const footpaths = standardFootpaths(tt, scaffoldPreferences);
const router = new TransitRouter(tt, footpaths);
const id = (s: string) => tt.stopIndex(`t:${s}`)!;
const rides = (j: Journey) => j.legs.filter((l): l is RideLeg => l.kind === "ride");

// Indoor everywhere except the exposed XB and DB bus stops.
const exposureWeights = () => {
  const w = new Float64Array(tt.stopCount).fill(1);
  w[id("XB")] = 2.5;
  w[id("DB")] = 2.5;
  return w;
};
const query = (waitWeights?: Float64Array): TransitQuery => ({
  departure: hms(7, 50),
  access: [{ stop: id("A"), seconds: 300, cost: 600 }],
  egress: [{ stop: id("DB"), seconds: 60, cost: 120 }, { stop: id("D"), seconds: 90, cost: 90 }],
  preferences: scaffoldPreferences,
  waitWeights,
  maxRounds: 5,
});
const legCost = (j: Journey) => j.legs.reduce((sum, l) => sum + l.cost, 0);

test("Pareto set holds the fast and the sheltered journeys", () => {
  const journeys = router.journeys(query(exposureWeights()));
  assert.equal(journeys.length, 2);
  const [fast, sheltered] = journeys;
  assert.equal(fast.departure, hms(7, 55));
  assert.equal(fast.arrival, hms(8, 31));
  assert.equal(fast.cost, 3360);
  assert.deepEqual(fast.legs.map((l) => l.kind), ["access", "wait", "ride", "transfer", "wait", "ride", "egress"]);
  assert.deepEqual(fast.legs[3], { kind: "transfer", from: id("XS"), to: id("XB"), start: hms(8, 10), seconds: 120, cost: 120 });
  assert.deepEqual(fast.legs[4], { kind: "wait", stop: id("XB"), start: hms(8, 12), seconds: 480, cost: 1200 });
  assert.deepEqual(fast.legs[6], { kind: "egress", index: 0, stop: id("DB"), start: hms(8, 30), seconds: 60, cost: 120 });
  const r = rides(fast);
  assert.deepEqual(r.map((x) => x.tripID), ["1-0800", "M2-0820"]);
  assert.deepEqual(r.map((x) => x.route.shortName), ["1", "M2"]);
  assert.deepEqual(r.map((x) => x.route.color), ["EE352E", null]);
  assert.deepEqual(r.map((x) => x.headsign), ["Y Sq", "D Blvd Bus"]);
  assert.deepEqual(r.map((x) => [x.from, x.to]), [[id("AS"), id("XS")], [id("XB"), id("DB")]]);
  assert.deepEqual(r.map((x) => x.cost), [600, 600]);
  assert.deepEqual(r.map((x) => x.serviceDayOffset), [0, 0]);
  assert.deepEqual(r[0].path, [[40.7, -74.0], [40.71, -74.001], [40.72, -74.0]].map(([lat, lon]) => ({ lat: Math.fround(lat), lon: Math.fround(lon) })));
  assert.deepEqual(r[1].path, [tt.location(id("XB")), tt.location(id("DB"))]);

  assert.equal(sheltered.arrival, hms(8, 41, 30));
  assert.equal(sheltered.cost, 3210);
  assert.deepEqual(rides(sheltered).map((x) => x.tripID), ["1-0800", "3-0830"]);
  assert.deepEqual(sheltered.legs.filter((l): l is WaitLeg => l.kind === "wait").map((w) => [w.stop, w.seconds, w.cost]),
    [[id("AS"), 0, 0], [id("YN"), 840, 840]]);
  assert.deepEqual(sheltered.legs.at(-1), { kind: "egress", index: 1, stop: id("DS"), start: hms(8, 40), seconds: 90, cost: 90 });
  for (const j of journeys) assert.ok(Math.abs(legCost(j) + 120 * (rides(j).length - 1) - j.cost) < 1e-9);
});

test("uniform wait weights leave only the fast journey", () => {
  const journeys = router.journeys(query());
  assert.deepEqual(journeys.map((j) => j.cost), [2640]);
  assert.deepEqual(journeys.map((j) => j.arrival), [hms(8, 31)]);
});

test("scalarized pick", () => {
  const journeys = router.journeys(query(exposureWeights()));
  assert.equal(preferredJourney(journeys, 0)?.cost, 3210);
  assert.equal(preferredJourney(journeys, 0.2)?.cost, 3210);
  assert.equal(preferredJourney(journeys, 1)?.cost, 3360);
  assert.equal(preferredJourney(journeys, 0, 300)?.cost, 3360);
  assert.equal(preferredJourney([], 1), null);
});

test("arrival slack drops late journeys", () => {
  assert.deepEqual(router.journeys({ ...query(exposureWeights()), arrivalSlackSeconds: 629 }).map((j) => j.cost), [3360]);
  assert.deepEqual(router.journeys({ ...query(exposureWeights()), arrivalSlackSeconds: 630 }).map((j) => j.cost), [3360, 3210]);
});

test("maxRounds limits rides", () => {
  assert.deepEqual(router.journeys({ ...query(exposureWeights()), maxRounds: 1 }), []);
});

const direct = (from: string, to: string, departure: number): TransitQuery => ({
  departure,
  access: [{ stop: id(from), seconds: 0, cost: 0 }],
  egress: [{ stop: id(to), seconds: 0, cost: 0 }],
});

test("previous-day trips run past midnight; next-day trips extend late queries", () => {
  const noWalks = new TransitRouter(tt, new Footpaths(tt.stopCount, []));
  const early = noWalks.journeys(direct("X", "Y", 0));
  assert.equal(early.length, 1);
  assert.equal(rides(early[0])[0].tripID, "1-2350");
  assert.equal(rides(early[0])[0].serviceDayOffset, -1);
  assert.equal(rides(early[0])[0].departure, hms(0, 5));
  assert.equal(tt.dateAt(hms(0, 5)).getTime(), (1_790_827_200 - 86_400 + 300) * 1000);
  const late = rides(noWalks.journeys(direct("X", "Y", hms(24, 6)))[0])[0];
  assert.equal(late.tripID, "1-0005");
  assert.equal(late.serviceDayOffset, 1);
  assert.equal(late.departure, hms(24, 15));
});

test("untimed stop is interpolated", () => {
  const r = router.journeys(direct("XS", "YS", hms(8, 20))).flatMap(rides);
  assert.deepEqual(r.map((x) => [x.tripID, x.departure, x.arrival]), [["1-0830", hms(8, 37, 30), hms(8, 45)]]);
});

test("realtime overlay: delayed trip and a skipped stop", () => {
  const p = 0;
  const length = tt.patternStopCount(p);
  const base = tt.data.patternEventOffsets[p];
  const count = tt.patternTripCount(p);
  const arrivals = tt.data.arrivals.slice(base, base + count * length);
  const departures = tt.data.departures.slice(base, base + count * length);
  // 1-0800 (trip 2) runs 2 min late after A; 1-0830 (trip 3) skips XS.
  for (const i of [1, 2]) {
    arrivals[2 * length + i] += 120;
    departures[2 * length + i] += 120;
  }
  arrivals[3 * length + 1] = CLOSED;
  departures[3 * length + 1] = PASSED;
  const overlay: RealtimeOverlay = {
    patterns: new Map([[p, {
      trips: Array.from({ length: count }, (_, t) => ({ base: tt.data.patternTripOffsets[p] + t, tripID: tt.data.tripID[t], updated: t === 2 || t === 3 })),
      arrivals,
      departures,
      blocks: [{ start: 0, end: 3 }, { start: 3, end: 4 }, { start: 4, end: count }],
    }]]),
    updatedTrips: 2, addedTrips: 0, canceledTrips: 0, unmatchedTrips: 0,
  };
  const live = new TransitRouter(tt, new Footpaths(tt.stopCount, []), overlay);
  const delayed = rides(live.journeys(direct("AS", "YS", hms(7, 50)))[0])[0];
  assert.equal(delayed.tripID, "1-0800");
  assert.equal(delayed.arrival, hms(8, 17));
  assert.deepEqual(delayed.scheduled, { departure: hms(8, 0), arrival: hms(8, 15) });
  const skipped = rides(live.journeys(direct("AS", "XS", hms(8, 20)))[0])[0];
  assert.equal(skipped.tripID, "1-2350");
  assert.equal(skipped.scheduled, null);
});

test("plan selection keeps the cheapest and the fastest and drops near-identical plans", () => {
  const journeys = router.journeys(query(exposureWeights()));
  const [fast, sheltered] = journeys;
  assert.deepEqual(selectPlans(journeys, tt), [sheltered, fast]);
  const shifted = { ...sheltered, cost: sheltered.cost + 1 };
  assert.deepEqual(selectPlans([fast, sheltered, shifted], tt), [sheltered, fast]);
  assert.deepEqual(selectPlans([fast, sheltered, shifted], tt, { limit: 1 }), [sheltered, fast]);
  assert.deepEqual(selectPlans([], tt), []);
});

test("planAccess finds platforms near a coordinate", () => {
  const access = planAccess(tt, { lat: 40.7205, lon: -74.0 }, { radiusMeters: 200 });
  assert.deepEqual(access.map((a) => a.stop).sort(), [id("XS"), id("XB")].sort());
  for (const a of access) assert.equal(a.cost, a.seconds);
});
