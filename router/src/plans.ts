// Plan selection and endpoint access, ported from scaffold `PlanSelection.swift` and `CoverTripPlanner.swift`.

import { distanceMeters, type Point, type Timetable } from "./timetable.ts";
import { DEFAULT_PREFERENCES, type Journey, type Preferences, type RideLeg, type StopAccess } from "./types.ts";

const rides = (journey: Journey): RideLeg[] => journey.legs.filter((leg): leg is RideLeg => leg.kind === "ride");

// Same number of rides on the same routes, boarding and alighting within stopMeters of each other.
export function nearIdentical(timetable: Timetable, a: Journey, b: Journey, stopMeters: number): boolean {
  const ridesA = rides(a);
  const ridesB = rides(b);
  return ridesA.length === ridesB.length && ridesA.every((x, i) => {
    const y = ridesB[i];
    return x.route.id === y.route.id
      && distanceMeters(timetable.location(x.from), timetable.location(y.from)) <= stopMeters
      && distanceMeters(timetable.location(x.to), timetable.location(y.to)) <= stopMeters;
  });
}

// Cheapest first by cost, then arrival, dropping journeys near-identical to a better one, capped at limit (at
// least 2). The cheapest and the fastest always stay.
export function selectPlans(
  journeys: Journey[],
  timetable: Timetable,
  { limit = 3, stopMeters = 300 }: { limit?: number; stopMeters?: number } = {},
): Journey[] {
  const ranked = [...journeys].sort((a, b) => a.cost - b.cost || a.arrival - b.arrival);
  const cheapest = ranked[0];
  if (!cheapest) return [];
  const fastest = ranked.reduce((best, j) => (j.arrival < best.arrival || (j.arrival === best.arrival && j.cost < best.cost) ? j : best));
  const cap = Math.max(limit, 2);
  const kept: Journey[] = [];
  for (const plan of ranked) {
    if (kept.length >= cap) break;
    const required = plan === cheapest || plan === fastest;
    if (required || !kept.some((k) => nearIdentical(timetable, k, plan, stopMeters))) kept.push(plan);
  }
  if (!kept.includes(fastest)) kept[kept.length - 1] = fastest;
  return kept;
}

// Straight-line walks from a coordinate to served stops within radiusMeters, as scaffold estimates walks when
// the sidewalk graph is absent: meters * 1.3 detour / speed, costed at streetWalkWeight.
export function planAccess(
  timetable: Timetable,
  point: Point,
  {
    radiusMeters = 1000,
    speedMetersPerSecond = 1.3,
    preferences = DEFAULT_PREFERENCES,
  }: { radiusMeters?: number; speedMetersPerSecond?: number; preferences?: Preferences } = {},
): StopAccess[] {
  return timetable.stopsNear(point, radiusMeters).map(({ stop, meters }) => {
    const seconds = (meters * 1.3) / speedMetersPerSecond;
    return { stop, seconds, cost: seconds * preferences.streetWalkWeight };
  });
}
