// Crowd-reported car conditions. Physical conditions only: smell, cleanliness, A/C,
// crowding. There is deliberately no field about people and no safety score.
import type { CarReport } from "./types.ts";

export const MIN_REPORTS = 3; // below this a car is "not rated yet"

// Half-lives in days: fast-changing conditions decay quickly.
const HALF_LIFE_DAYS = { smell: 14, cleanliness: 14, acWorking: 7, crowding: 3 };

export interface RatedCar {
  car: number;
  rated: boolean;
  reports: number;
  smell?: number;
  cleanliness?: number;
  acWorkingLikely?: boolean;
  crowding?: number;
  score?: number;
}

const round = (n: number) => Math.round(n * 10) / 10;

function weightedAvg(rows: CarReport[], pick: (r: CarReport) => number, halfLife: number): number {
  let num = 0;
  let den = 0;
  for (const r of rows) {
    const w = Math.pow(0.5, r.daysAgo / halfLife);
    num += pick(r) * w;
    den += w;
  }
  return num / den;
}

export function rateCars(reports: CarReport[]): RatedCar[] {
  const byCar = new Map<number, CarReport[]>();
  for (const r of reports) byCar.set(r.car, [...(byCar.get(r.car) ?? []), r]);
  return [...byCar.entries()]
    .map(([car, rs]): RatedCar => {
      if (rs.length < MIN_REPORTS) return { car, rated: false, reports: rs.length };
      const smell = weightedAvg(rs, (r) => r.smell, HALF_LIFE_DAYS.smell);
      const cleanliness = weightedAvg(rs, (r) => r.cleanliness, HALF_LIFE_DAYS.cleanliness);
      const ac = weightedAvg(rs, (r) => (r.acWorking ? 1 : 0), HALF_LIFE_DAYS.acWorking);
      const crowding = weightedAvg(rs, (r) => r.crowding, HALF_LIFE_DAYS.crowding);
      const score = (smell + cleanliness + ac * 5 + (6 - crowding)) / 4;
      return {
        car,
        rated: true,
        reports: rs.length,
        smell: round(smell),
        cleanliness: round(cleanliness),
        acWorkingLikely: ac >= 0.5,
        crowding: round(crowding),
        score: round(score),
      };
    })
    .sort((a, b) => a.car - b.car);
}

export function bestAndWorst(rated: RatedCar[]): { best: RatedCar | null; avoid: RatedCar | null } {
  const ranked = rated.filter((c) => c.rated).sort((a, b) => b.score! - a.score!);
  const best = ranked[0] ?? null;
  const worst = ranked.length > 1 ? ranked[ranked.length - 1]! : null;
  return { best, avoid: worst && worst.score! <= 3 ? worst : null };
}
