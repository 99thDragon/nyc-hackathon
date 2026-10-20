import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { decideStop, reliabilityScore } from "../src/rules.ts";
import { explain } from "../src/explain.ts";
import { rateCars } from "../src/cars.ts";
import type { Context, Outage, StopInput, Unit, Verdict, VerdictName } from "../src/types.ts";

const sample = JSON.parse(fs.readFileSync(new URL("../data/sample.json", import.meta.url), "utf8")) as {
  availabilityAsOf: string;
  equipment: Record<string, Unit>;
  outages: Outage[];
  stops: Record<string, StopInput>;
};
const NOW = Date.parse("2026-10-19T22:00:00Z");
const ARRIVAL = new Date(NOW + 10 * 60_000).toISOString();

const ctx = (over: Partial<Context> = {}, outages: Outage[] = sample.outages): Context => ({
  equipment: sample.equipment,
  availabilityAsOf: sample.availabilityAsOf,
  feed: { source: "test", fetchedAt: new Date(NOW).toISOString(), outages },
  now: NOW,
  ...over,
});
const stop = (key: string): StopInput => ({ ...structuredClone(sample.stops[key]!), arrivalAt: ARRIVAL });
const get = (vs: Verdict[], name: VerdictName) => vs.find((v) => v.verdict === name)!;

test("active outage: step-free is No and the MTA values pass through unchanged", async () => {
  const v = get(await decideStop(stop("S59:uptown"), ctx()), "step_free_now");
  assert.equal(v.answer, "no");
  assert.equal(v.decided_by, "rule");
  assert.equal(v.official.unit, "EL-S59-2");
  assert.equal(v.official.estReturn, "10/21/2026 06:00:00 PM");
  assert.equal(v.official.altRouteText, "Use 50 St, a 4 min walk");
});

test("no outage: step-free Yes", async () => {
  const v = get(await decideStop(stop("S59:downtown"), ctx()), "step_free_now");
  assert.equal(v.answer, "yes");
});

test("'Under Investigation' is a No with unknown return time (never the false 4:00 AM)", async () => {
  const o: Outage = { unitId: "EL-S59-3", reason: "Under Investigation", estReturn: "10/20/2026 04:00:00 AM", planned: false, startsAt: null, endsAt: null };
  const v = get(await decideStop(stop("S59:downtown"), ctx({}, [o])), "elevator_working_at_arrival");
  assert.equal(v.answer, "no");
  assert.match(v.reason, /return time unknown/);
  assert.doesNotMatch(v.reason + v.reasons.join(" "), /4:00/);
});

test("planned outage covering arrival is No; one outside the window is not", async () => {
  const mk = (s: string, e: string): Outage => ({ unitId: "EL-S59-3", reason: "Planned", estReturn: null, planned: true, startsAt: s, endsAt: e });
  const covering = mk("2026-10-19T21:00:00Z", "2026-10-20T03:00:00Z");
  const later = mk("2026-10-21T09:00:00Z", "2026-10-21T17:00:00Z");
  assert.equal(get(await decideStop(stop("S59:downtown"), ctx({}, [covering])), "elevator_working_at_arrival").answer, "no");
  assert.equal(get(await decideStop(stop("S59:downtown"), ctx({}, [later])), "elevator_working_at_arrival").answer, "yes");
});

test("planned outage with no time window is not_enough_data", async () => {
  const o: Outage = { unitId: "EL-S59-3", reason: "Planned", estReturn: null, planned: true, startsAt: null, endsAt: null };
  assert.equal(get(await decideStop(stop("S59:downtown"), ctx({}, [o])), "elevator_working_at_arrival").answer, "not_enough_data");
});

test("unit missing from the equipment list is not_enough_data", async () => {
  const s = stop("S59:downtown");
  s.requiredUnitIds = ["EL-NOPE"];
  const vs = await decideStop(s, ctx());
  assert.equal(get(vs, "step_free_now").answer, "not_enough_data");
  assert.equal(get(vs, "elevator_working_at_arrival").answer, "not_enough_data");
});

test("station with no elevator is No on both facts", async () => {
  const vs = await decideStop(stop("S99:uptown"), ctx());
  assert.equal(get(vs, "step_free_now").answer, "no");
  assert.equal(get(vs, "elevator_working_at_arrival").answer, "no");
});

test("feed older than 60 s is flagged; far older is not_enough_data", async () => {
  const lagged = ctx({ feed: { source: "test", fetchedAt: new Date(NOW - 120_000).toISOString(), outages: [] } });
  const v = get(await decideStop(stop("S59:downtown"), lagged), "step_free_now");
  assert.equal(v.answer, "yes");
  assert.equal(v.data_age_s, 120);
  assert.ok(v.reasons.some((r) => /may not be current/.test(r)));
  const dead = ctx({ feed: { source: "test", fetchedAt: new Date(NOW - 3 * 3600_000).toISOString(), outages: [] } });
  assert.equal(get(await decideStop(stop("S59:downtown"), dead), "step_free_now").answer, "not_enough_data");
});

test("reliability bands match the notes", () => {
  assert.equal(reliabilityScore(99.5), 5);
  assert.equal(reliabilityScore(98), 4);
  assert.equal(reliabilityScore(95), 3);
  assert.equal(reliabilityScore(80), 2);
  assert.equal(reliabilityScore(65.6), 1);
});

test("reliability verdict uses the weakest elevator; unknown history is not_enough_data", async () => {
  const v = get(await decideStop(stop("S59:uptown"), ctx()), "elevator_reliability");
  assert.equal(v.answer, 1);
  assert.equal(get(await decideStop(stop("S14:uptown"), ctx()), "elevator_reliability").answer, "not_enough_data");
});

test("which car: lookup when surveyed, 'no data' otherwise", async () => {
  const yes = get(await decideStop(stop("S59:uptown"), ctx()), "which_car");
  assert.equal(yes.answer, 3);
  assert.equal(yes.decided_by, "lookup");
  assert.equal(yes.sources[0]!.kind, "survey");
  assert.equal(get(await decideStop(stop("S59:downtown"), ctx()), "which_car").answer, "not_enough_data");
});

test("car conditions: below the minimum sample a car is 'not rated yet'", async () => {
  const rated = rateCars(sample.stops["S59:uptown"]!.carReports);
  assert.equal(rated.find((c) => c.car === 5)!.rated, false);
  const v = get(await decideStop(stop("S59:uptown"), ctx()), "car_conditions");
  assert.equal(v.answer, 3);
  assert.match(v.reason, /Car 7 rates low/);
});

test("decision model: used when no outage, low confidence and errors become not_enough_data", async () => {
  const ok = get(await decideStop(stop("S59:downtown"), ctx({ decisionModel: async () => ({ answer: "yes", probability: 0.82 }) })), "elevator_working_at_arrival");
  assert.equal(ok.decided_by, "decision_model");
  assert.equal(ok.probability, 0.82);
  const low = get(await decideStop(stop("S59:downtown"), ctx({ decisionModel: async () => ({ answer: "yes", probability: 0.4 }) })), "elevator_working_at_arrival");
  assert.equal(low.answer, "not_enough_data");
  const boom = get(await decideStop(stop("S59:downtown"), ctx({ decisionModel: async () => { throw new Error("timeout"); } })), "elevator_working_at_arrival");
  assert.equal(boom.answer, "not_enough_data");
});

test("every verdict has the full contract shape", async () => {
  for (const v of await decideStop(stop("S59:uptown"), ctx())) {
    for (const k of ["verdict", "answer", "probability", "decided_by", "reason", "reasons", "official", "sources", "trace_id", "data_age_s"]) {
      assert.ok(k in v, `${v.verdict} is missing ${k}`);
    }
  }
});

test("explain() changes only `reason`, and rejects unsafe or empty text", async () => {
  const [v] = await decideStop(stop("S59:uptown"), ctx());
  const good = await explain(v!, undefined, async () => "The mezzanine elevator is out; 50 St is a 4 min walk.");
  assert.equal(good.reason, "The mezzanine elevator is out; 50 St is a 4 min walk.");
  assert.deepEqual({ ...good, reason: "" }, { ...v!, reason: "" });
  for (const bad of ["", "Avoid it, other people there make it unsafe.", "x".repeat(400)]) {
    assert.equal((await explain(v!, undefined, async () => bad)).reason, v!.reason);
  }
  assert.equal((await explain(v!, undefined, async () => { throw new Error("down"); })).reason, v!.reason);
});

test("nothing in the data model or default text mentions people or safety", async () => {
  const vs = await decideStop(stop("S59:uptown"), ctx());
  const blob = JSON.stringify(vs) + JSON.stringify(sample);
  assert.doesNotMatch(blob, /homeless|unsafe|\bsafe(ty)?\b|sketch|danger/i);
});

test("an outage on a redundant unit does not block the route, and says why", async () => {
  const equipment = { ...sample.equipment, "EL-S59-2": { ...sample.equipment["EL-S59-2"]!, redundant: true } };
  const v = get(await decideStop(stop("S59:uptown"), ctx({ equipment })), "step_free_now");
  assert.equal(v.answer, "yes");
  assert.ok(v.reasons.some((r) => /redundant/.test(r)));
});
