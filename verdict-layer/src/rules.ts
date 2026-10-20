// Layer 1: rules (section 3.1 of the engineering notes). Code decides facts and clear cases.
// The optional decision model only handles "no outage right now".
import { bestAndWorst, rateCars } from "./cars.ts";
import type {
  Context,
  DecidedBy,
  Outage,
  Source,
  StopInput,
  Unit,
  Verdict,
  VerdictName,
} from "./types.ts";

export const STALE_WARN_S = 60; // MTA terms: warn if realtime lag exceeds one minute
// nyct_ene.json refreshes in under 30 min, so only refuse to assert well past that.
export const OUTAGE_FEED_HARD_STALE_S = 45 * 60;
export const MIN_PROBABILITY = 0.6; // below this the decision model's answer is not shown

export function reliabilityScore(availability90Pct: number): 1 | 2 | 3 | 4 | 5 {
  if (availability90Pct >= 99) return 5;
  if (availability90Pct >= 97) return 4;
  if (availability90Pct >= 93) return 3;
  if (availability90Pct >= 75) return 2;
  return 1; // do not plan around it
}

const UNDER_INVESTIGATION = /under investigation/i;

function make(
  verdict: VerdictName,
  answer: string | number,
  decided_by: DecidedBy,
  reason: string,
  reasons: string[],
  official: Record<string, unknown>,
  sources: Source[],
  data_age_s: number,
  probability: number | null = null,
): Verdict {
  return {
    verdict,
    answer,
    probability,
    decided_by,
    reason,
    reasons,
    official,
    sources,
    trace_id: crypto.randomUUID(),
    data_age_s,
  };
}

const notEnough = (
  verdict: VerdictName,
  why: string,
  sources: Source[],
  age: number,
  official: Record<string, unknown> = {},
) => make(verdict, "not_enough_data", "not_enough_data", why, [why], official, sources, age);

function covers(o: Outage, arrivalMs: number): boolean | null {
  if (!o.startsAt || !o.endsAt) return null; // window unknown
  return Date.parse(o.startsAt) <= arrivalMs && arrivalMs <= Date.parse(o.endsAt);
}

function officialFor(o: Outage, unit: Unit | undefined) {
  // Pass MTA values through unchanged (the terms forbid modifying them).
  return {
    unit: o.unitId,
    reason: o.reason,
    estReturn: o.estReturn,
    planned: o.planned,
    desc: unit?.desc ?? null,
    nextAccessibleNorth: unit?.nextAccessibleNorth ?? null,
    nextAccessibleSouth: unit?.nextAccessibleSouth ?? null,
    altRouteText: unit?.altRouteText ?? null,
  };
}

function returnText(o: Outage): string {
  // The feed shows a false 4:00 AM for "Under Investigation", so never repeat it.
  return UNDER_INVESTIGATION.test(o.reason) || !o.estReturn
    ? "return time unknown"
    : `expected back ${o.estReturn}`;
}

export async function decideStop(stop: StopInput, ctx: Context): Promise<Verdict[]> {
  const now = ctx.now ?? Date.now();
  const age = Math.max(0, Math.round((now - Date.parse(ctx.feed.fetchedAt)) / 1000));
  const feedSource: Source = { name: ctx.feed.source, kind: "official", as_of: ctx.feed.fetchedAt };
  const warn = age > STALE_WARN_S ? ["Data may not be current (older than 60 s)"] : [];
  const out: Verdict[] = [];

  const units = stop.requiredUnitIds.map((id) => ctx.equipment[id]);
  const missing = stop.requiredUnitIds.filter((id) => !ctx.equipment[id]);
  const outNow = ctx.feed.outages.filter((o) => !o.planned && stop.requiredUnitIds.includes(o.unitId));
  // An outage on a unit the MTA marks redundant does not block the route (same reading as the map app).
  const current = outNow.filter((o) => !ctx.equipment[o.unitId]?.redundant);
  const planned = ctx.feed.outages.filter((o) => o.planned && stop.requiredUnitIds.includes(o.unitId));
  const arrivalMs = Date.parse(stop.arrivalAt);

  // ---- step_free_now ----
  if (stop.ada === 0) {
    out.push(
      make("step_free_now", "no", "rule", `${stop.name} has no elevator.`, ["Station ADA flag is 0", ...warn],
        { ada: 0 }, [feedSource], age, 1),
    );
  } else if (age > OUTAGE_FEED_HARD_STALE_S) {
    out.push(notEnough("step_free_now", "The outage feed is too old to say.", [feedSource], age));
  } else if (stop.requiredUnitIds.length === 0 || missing.length > 0) {
    out.push(notEnough("step_free_now", "We don't know which elevators serve this platform.", [feedSource], age,
      { missingUnits: missing }));
  } else if (current.length > 0) {
    const o = current[0]!;
    const unit = ctx.equipment[o.unitId];
    const backup = unit?.backupUnitId && !ctx.feed.outages.some((x) => x.unitId === unit.backupUnitId && !x.planned)
      ? [`Backup unit ${unit.backupUnitId} is not reported out`] : [];
    out.push(
      make("step_free_now", "no", "rule",
        `${unit?.desc ?? o.unitId} is out of service (${o.reason}); ${returnText(o)}.`,
        [`${o.unitId} is out: ${o.reason}`, returnText(o), ...backup, ...(stop.ada === 2 ? ["Station is only partly accessible"] : []), ...warn],
        officialFor(o, unit), [feedSource], age, 1),
    );
  } else {
    out.push(
      make("step_free_now", "yes", "rule",
        `Every elevator on this route at ${stop.name} is reporting in service.`,
        [`${stop.requiredUnitIds.join(", ")} not in the current outage list`, ...(outNow.length > current.length ? [`${outNow.map((o) => o.unitId).join(", ")} is out, but the MTA marks it redundant`] : []), ...(stop.ada === 2 ? ["Station is only partly accessible"] : []), ...warn],
        { units: stop.requiredUnitIds }, [feedSource], age, 1),
    );
  }

  // ---- elevator_working_at_arrival ----
  const atArrival = ((): Promise<Verdict> | Verdict => {
    if (stop.ada === 0) {
      return make("elevator_working_at_arrival", "no", "rule", `${stop.name} has no elevator.`,
        ["Station ADA flag is 0", ...warn], { ada: 0 }, [feedSource], age, 1);
    }
    if (age > OUTAGE_FEED_HARD_STALE_S || stop.requiredUnitIds.length === 0 || missing.length > 0) {
      return notEnough("elevator_working_at_arrival", "Not enough data on these elevators.", [feedSource], age,
        { missingUnits: missing });
    }
    if (current.length > 0) {
      const o = current[0]!;
      return make("elevator_working_at_arrival", "no", "rule",
        `${ctx.equipment[o.unitId]?.desc ?? o.unitId} is out now; ${returnText(o)}.`,
        [`${o.unitId} is out: ${o.reason}`, returnText(o), ...warn],
        officialFor(o, ctx.equipment[o.unitId]), [feedSource], age, 1);
    }
    for (const o of planned) {
      const c = covers(o, arrivalMs);
      if (c === null) {
        return notEnough("elevator_working_at_arrival", "A planned outage has no start and end time in the feed.",
          [feedSource], age, officialFor(o, ctx.equipment[o.unitId]));
      }
      if (c) {
        return make("elevator_working_at_arrival", "no", "rule",
          `${ctx.equipment[o.unitId]?.desc ?? o.unitId} has planned work covering your arrival.`,
          [`Planned outage ${o.startsAt} to ${o.endsAt}`, ...warn],
          officialFor(o, ctx.equipment[o.unitId]), [feedSource], age, 1);
      }
    }
    const evidence = {
      units: units.map((u) => ({ id: u!.id, availability90Pct: u!.availability90Pct, backup: u!.backupUnitId })),
      dataAgeSeconds: age,
    };
    const base = ["No active or planned outage covers your arrival", ...warn];
    if (!ctx.decisionModel) {
      return make("elevator_working_at_arrival", "yes", "rule",
        "No outage is reported now or planned for your arrival.", base, evidence, [feedSource], age);
    }
    return ctx.decisionModel(evidence).then(
      (r) =>
        r.probability < MIN_PROBABILITY
          ? notEnough("elevator_working_at_arrival", "The model is not confident enough to say.", [feedSource], age, evidence)
          : make("elevator_working_at_arrival", r.answer, "decision_model",
              `Likely ${r.answer === "yes" ? "working" : "not working"} when you arrive.`, base, evidence,
              [feedSource, { name: "Decision model", kind: "derived", as_of: new Date(now).toISOString() }], age, r.probability),
      () => notEnough("elevator_working_at_arrival", "The decision model did not answer.", [feedSource], age, evidence),
    );
  })();
  out.push(await atArrival);

  // ---- elevator_reliability (1-5, rule formula) ----
  const relSource: Source = { name: "MTA elevator availability (rc78-7x78) + outage log", kind: "derived", as_of: ctx.availabilityAsOf };
  const known = units.filter((u): u is Unit => !!u && u.availability90Pct != null);
  if (stop.ada === 0 || known.length === 0 || known.length < stop.requiredUnitIds.length) {
    out.push(notEnough("elevator_reliability", "No 90-day history for these elevators.", [relSource], age));
  } else {
    const worst = known.reduce((a, b) => (a.availability90Pct! <= b.availability90Pct! ? a : b));
    const score = reliabilityScore(worst.availability90Pct!);
    out.push(
      make("elevator_reliability", score, "rule",
        score === 1
          ? `${worst.desc} was up only ${worst.availability90Pct}% over the last 3 months of MTA data. Do not plan around it.`
          : `Weakest elevator on this route was up ${worst.availability90Pct}% over the last 3 months of MTA data.`,
        known.map((u) => `${u.id}: ${u.availability90Pct}% over 3 months`),
        { units: known.map((u) => ({ id: u.id, availability90Pct: u.availability90Pct })) },
        [relSource], age),
    );
  }

  // ---- which_car (lookup of surveyed positions only) ----
  if (stop.carSurvey) {
    const s = stop.carSurvey;
    out.push(
      make("which_car", s.elevatorCar, "lookup",
        `Board car ${s.elevatorCar} of ${s.trainCars} to be at the elevator.`,
        [`Surveyed ${s.surveyedAt}`], { elevatorCar: s.elevatorCar, trainCars: s.trainCars },
        [{ name: "Car survey", kind: "survey", as_of: s.surveyedAt }], age),
    );
  } else {
    out.push(notEnough("which_car", "No data for this station.", [], age));
  }

  // ---- car_conditions (crowd reports; physical conditions only) ----
  const rated = rateCars(stop.carReports);
  const { best, avoid } = bestAndWorst(rated);
  const crowdSource: Source = { name: "Rider reports", kind: "crowd", as_of: new Date(now).toISOString() };
  if (!best) {
    out.push(notEnough("car_conditions", "Not rated yet.", [crowdSource], age));
  } else {
    out.push(
      make("car_conditions", best.car, "rule",
        `Car ${best.car} rates best on smell, cleanliness, A/C and crowding.` +
          (avoid ? ` Car ${avoid.car} rates low on those conditions.` : ""),
        rated.map((c) => c.rated
          ? `Car ${c.car}: ${c.score}/5 from ${c.reports} reports`
          : `Car ${c.car}: not rated yet (${c.reports} reports)`),
        {}, [crowdSource], age),
    );
  }

  return out;
}
