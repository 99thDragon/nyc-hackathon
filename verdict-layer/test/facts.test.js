import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { computeVerdict, rateCars, reliabilityScore, templateText } from "../src/facts.js";

const sample = JSON.parse(fs.readFileSync(new URL("../data/sample.json", import.meta.url), "utf8"));
const NOW = Date.parse("2026-10-19T22:00:00Z");
const data = (over = {}) => ({
  ...structuredClone(sample),
  source: "test",
  feedFetchedAt: new Date(NOW).toISOString(),
  ...over,
});

test("elevator down gives No with the nearest working alternative", () => {
  const v = computeVerdict(data(), { stationId: "S59", direction: "uptown" }, NOW);
  assert.equal(v.answer, "no");
  assert.equal(v.reason, "elevator-down");
  assert.equal(v.alternative.stationId, "S50");
  assert.equal(v.outages[0].elevatorId, "EL-S59-2");
});

test("all elevators up gives Yes", () => {
  const v = computeVerdict(data(), { stationId: "S59", direction: "downtown" }, NOW);
  assert.equal(v.answer, "yes");
});

test("no alternative is reported as null, not invented", () => {
  const d = data({ outages: [{ elevatorId: "EL-S14-2", reason: "Repair", estReturn: "unknown" }] });
  const v = computeVerdict(d, { stationId: "S14", direction: "uptown" }, NOW);
  assert.equal(v.answer, "no");
  assert.equal(v.alternative, null);
});

test("non-ADA station is a No on a good day too", () => {
  const v = computeVerdict(data(), { stationId: "S99", direction: "uptown" }, NOW);
  assert.equal(v.answer, "no");
  assert.equal(v.reason, "not-ada");
});

test("stale data is Unknown, and slightly old data is flagged", () => {
  const old = data({ feedFetchedAt: new Date(NOW - 20 * 60_000).toISOString() });
  assert.equal(computeVerdict(old, { stationId: "S59", direction: "downtown" }, NOW).answer, "unknown");
  const lagged = data({ feedFetchedAt: new Date(NOW - 120_000).toISOString() });
  const v = computeVerdict(lagged, { stationId: "S59", direction: "downtown" }, NOW);
  assert.equal(v.answer, "yes");
  assert.equal(v.evidence.mayNotBeCurrent, true);
});

test("unknown station is Unknown", () => {
  assert.equal(computeVerdict(data(), { stationId: "NOPE", direction: "uptown" }, NOW).answer, "unknown");
});

test("cars below the minimum sample are 'not rated yet'", () => {
  const cars = rateCars(data(), "S59", "downtown"); // one report only
  assert.equal(cars[0].rated, false);
});

test("car guidance picks the best car and flags the worst on conditions", () => {
  const v = computeVerdict(data(), { stationId: "S59", direction: "uptown" }, NOW);
  assert.equal(v.cars.best.car, 3);
  assert.equal(v.cars.avoid.car, 7);
  assert.equal(v.cars.elevatorCar, 3);
});

test("reliability bands match the proposal (1 = out > 25% of the time)", () => {
  assert.equal(reliabilityScore(31), 1);
  assert.equal(reliabilityScore(2), 5);
  assert.equal(reliabilityScore(undefined), null);
});

test("nothing in the data model or text mentions people or safety", () => {
  const v = computeVerdict(data(), { stationId: "S59", direction: "uptown" }, NOW);
  const blob = JSON.stringify(v) + templateText(v) + JSON.stringify(sample.carReports);
  assert.doesNotMatch(blob, /homeless|safe|unsafe|sketch|danger/i);
});
