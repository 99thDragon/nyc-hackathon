import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { findStations, parseNyTime, requiredUnitIds, stopFor, toEquipment, toOutages } from "../src/live.ts";
import type { EquipmentRow, OutageRow } from "../src/live.ts";
import { decideStop } from "../src/rules.ts";

// Real rows recorded from the live MTA feeds on 2026-10-19 (149 St-Hostos plus one Grand St unit).
const fx = JSON.parse(fs.readFileSync(new URL("./fixtures/mta-live-slice.json", import.meta.url), "utf8")) as {
  outages: OutageRow[];
  equipment: EquipmentRow[];
};
const NOW = Date.parse("2026-10-20T00:35:00Z"); // 8:35 PM EDT, 3 minutes after recording
const availability = new Map([["EL101", 98.2]]); // EL100 and EL102 have no history, as in the real dataset
const equipment = toEquipment(fx.equipment, availability);
const feed = (fetchedAt = new Date(NOW).toISOString()) => ({ source: "test", fetchedAt, outages: toOutages(fx.outages) });
const ctx = () => ({ equipment, feed: feed(), availabilityAsOf: "2026-06 to 2026-08", now: NOW });
const arrival = new Date(NOW + 10 * 60_000).toISOString();

test("New York timestamps convert to UTC across DST", () => {
  assert.equal(parseNyTime("10/19/2026 07:38:00 PM"), "2026-10-19T23:38:00.000Z"); // EDT, UTC-4
  assert.equal(parseNyTime("12/17/2026 06:00:00 AM"), "2026-12-17T11:00:00.000Z"); // EST, UTC-5
  assert.equal(parseNyTime("12/17/2026 12:00:00 AM"), "2026-12-17T05:00:00.000Z"); // midnight
  assert.equal(parseNyTime("garbage"), null);
  assert.equal(parseNyTime(undefined), null);
});

test("outage rows map to current vs planned, raw return text kept unchanged", () => {
  const outages = toOutages(fx.outages);
  const current = outages.find((o) => o.unitId === "EL102")!;
  assert.equal(current.planned, false);
  assert.equal(current.reason, "Under Investigation");
  assert.equal(current.estReturn, "10/20/2026 04:00:00 AM"); // the feed's false 4:00 AM, passed through
  const planned = outages.find((o) => o.planned)!;
  assert.ok(planned.startsAt && planned.endsAt);
});

test("platform matching: units for the named platform plus unnamed access, not other platforms", () => {
  const woodlawn = requiredUnitIds(equipment, "603", "Woodlawn").sort();
  assert.deepEqual(woodlawn, ["EL100", "EL101"]); // EL102 serves only the Manhattan-bound platforms
  const manhattan = requiredUnitIds(equipment, "603", "Manhattan").sort();
  assert.deepEqual(manhattan, ["EL100", "EL102"]);
  assert.equal(requiredUnitIds(equipment, "603").length, 3); // no platform: every elevator, the conservative reading
});

test("station search finds the complex and lists its platforms", () => {
  const found = findStations(equipment, "hostos");
  assert.equal(found.length, 1);
  assert.equal(found[0]!.complexId, "603");
  assert.ok(found[0]!.platforms.includes("Woodlawn"));
});

test("real outage: Manhattan platform is No, Woodlawn platform is Yes", async () => {
  const man = await decideStop(stopFor(equipment, "603", "Manhattan", arrival)!, ctx());
  const stepFree = man.find((v) => v.verdict === "step_free_now")!;
  assert.equal(stepFree.answer, "no");
  assert.equal(stepFree.official.unit, "EL102");
  assert.match(stepFree.reason, /return time unknown/); // Under Investigation hides the false 4:00 AM
  const wood = await decideStop(stopFor(equipment, "603", "Woodlawn", arrival)!, ctx());
  assert.equal(wood.find((v) => v.verdict === "step_free_now")!.answer, "yes");
});

test("units without history give not_enough_data, never a guessed score", async () => {
  const vs = await decideStop(stopFor(equipment, "603", "Woodlawn", arrival)!, ctx());
  assert.equal(vs.find((v) => v.verdict === "elevator_reliability")!.answer, "not_enough_data");
  assert.equal(vs.find((v) => v.verdict === "which_car")!.answer, "not_enough_data");
});

test("a stale outage feed is flagged on live data too", async () => {
  const stale = { ...ctx(), feed: feed(new Date(NOW - 5 * 60_000).toISOString()) };
  const v = (await decideStop(stopFor(equipment, "603", "Woodlawn", arrival)!, stale))[0]!;
  assert.equal(v.data_age_s, 300);
  assert.ok(v.reasons.some((r) => /may not be current/.test(r)));
});
