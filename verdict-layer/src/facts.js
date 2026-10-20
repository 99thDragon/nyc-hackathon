// Deterministic verdict logic. Code decides yes/no/unknown; Claude only phrases it.
// Car guidance rates physical conditions only (smell, cleanliness, A/C, crowding).
// There is deliberately no field about people or a "safety" score.

export const MIN_REPORTS = 3; // below this a car is "not rated yet"
const STALE_WARN_SECONDS = 60; // MTA terms: warn if realtime lag exceeds one minute
const STALE_UNKNOWN_SECONDS = 15 * 60; // past this we refuse to assert anything

// Half-lives in days: fast-changing conditions decay quickly.
const HALF_LIFE_DAYS = { smell: 14, cleanliness: 14, acWorking: 7, crowding: 3 };

export function reliabilityScore(outageDaysLast90) {
  if (outageDaysLast90 == null) return null;
  const upPct = 100 * (1 - outageDaysLast90 / 90);
  if (upPct < 75) return 1; // out more than a quarter of the time
  if (upPct < 85) return 2;
  if (upPct < 92) return 3;
  if (upPct < 97) return 4;
  return 5;
}

function pathStatus(data, stationId, direction) {
  const station = data.stations[stationId];
  const dir = station?.directions?.[direction];
  if (!dir) return { known: false };
  if (station.ada === 0) return { known: true, accessible: false, reason: "not-ada" };
  const down = dir.requiresElevators
    .map((id) => data.outages.find((o) => o.elevatorId === id))
    .filter(Boolean);
  return { known: true, accessible: down.length === 0, down };
}

function findAlternative(data, stationId, direction) {
  for (const n of data.stations[stationId].nearby ?? []) {
    const alt = data.stations[n.stationId];
    if (!alt) continue;
    const s = pathStatus(data, n.stationId, direction);
    if (s.known && s.accessible) {
      return { stationId: n.stationId, name: alt.name, walkMinutes: n.walkMinutes };
    }
  }
  return null;
}

function weightedAvg(rows, key, halfLife) {
  let num = 0;
  let den = 0;
  for (const r of rows) {
    const v = key === "acWorking" ? (r.acWorking ? 1 : 0) : r[key];
    if (v == null) continue;
    const w = Math.pow(0.5, r.daysAgo / halfLife);
    num += v * w;
    den += w;
  }
  return den ? num / den : null;
}

export function rateCars(data, stationId, direction) {
  const rows = data.carReports.filter(
    (r) => r.stationId === stationId && r.direction === direction,
  );
  const byCar = new Map();
  for (const r of rows) byCar.set(r.car, [...(byCar.get(r.car) ?? []), r]);
  return [...byCar.entries()]
    .map(([car, rs]) => {
      if (rs.length < MIN_REPORTS) return { car, rated: false, reports: rs.length };
      const smell = weightedAvg(rs, "smell", HALF_LIFE_DAYS.smell);
      const cleanliness = weightedAvg(rs, "cleanliness", HALF_LIFE_DAYS.cleanliness);
      const ac = weightedAvg(rs, "acWorking", HALF_LIFE_DAYS.acWorking);
      const crowding = weightedAvg(rs, "crowding", HALF_LIFE_DAYS.crowding); // 5 = packed
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
        newestReportDaysAgo: Math.min(...rs.map((r) => r.daysAgo)),
      };
    })
    .sort((a, b) => a.car - b.car);
}

const round = (n) => Math.round(n * 10) / 10;

function carGuidance(data, stationId, direction) {
  const dir = data.stations[stationId].directions[direction];
  const rated = rateCars(data, stationId, direction);
  const ranked = rated.filter((c) => c.rated).sort((a, b) => b.score - a.score);
  const best = ranked[0] ?? null;
  const worst = ranked.length > 1 ? ranked[ranked.length - 1] : null;
  return {
    elevatorCar: dir.elevatorCar,
    trainCars: dir.trainCars,
    best,
    avoid: worst && worst.score <= 3 ? worst : null,
    unratedCars: rated.filter((c) => !c.rated).map((c) => c.car),
    ratedCount: ranked.length,
  };
}

export function computeVerdict(data, { stationId, direction }, now = Date.now()) {
  const station = data.stations[stationId];
  if (!station || !station.directions[direction]) {
    return { answer: "unknown", reason: "unknown-station-or-direction", stationId, direction };
  }

  const ageSeconds = Math.round((now - Date.parse(data.feedFetchedAt)) / 1000);
  const evidence = {
    sources: [data.source],
    outageFeedAsOf: data.feedFetchedAt,
    outageFeedAgeSeconds: ageSeconds,
    mayNotBeCurrent: ageSeconds > STALE_WARN_SECONDS,
  };

  const base = {
    station: station.name,
    stationId,
    direction,
    lines: station.lines,
    evidence,
  };

  if (ageSeconds > STALE_UNKNOWN_SECONDS) {
    return { ...base, answer: "unknown", reason: "stale-data" };
  }

  const status = pathStatus(data, stationId, direction);
  const stepFreeOnGoodDay = station.ada !== 0;
  const cars = stepFreeOnGoodDay ? carGuidance(data, stationId, direction) : null;

  if (!stepFreeOnGoodDay) {
    return { ...base, answer: "no", reason: "not-ada", stepFreeOnGoodDay, cars };
  }

  const elevators = station.directions[direction].requiresElevators.map((id) => ({
    id,
    desc: data.elevators[id]?.desc ?? null,
    down: status.down.some((o) => o.elevatorId === id),
    reliability: reliabilityScore(data.outageDaysLast90[id]),
  }));

  if (status.accessible) {
    return {
      ...base,
      answer: "yes",
      reason: "all-elevators-up",
      stepFreeOnGoodDay,
      elevators,
      cars,
    };
  }
  return {
    ...base,
    answer: "no",
    reason: "elevator-down",
    stepFreeOnGoodDay,
    elevators,
    outages: status.down,
    alternative: findAlternative(data, stationId, direction),
    cars,
  };
}

// Plain-text fallback used when no API key is set or the model call fails.
export function templateText(v) {
  if (v.answer === "unknown") {
    return "We don't have current enough data to say. Check the MTA elevator status page before you travel.";
  }
  const lines = [];
  if (v.reason === "not-ada") {
    lines.push(`${v.station} has no step-free route.`);
  } else if (v.answer === "yes") {
    lines.push(`Every elevator on the ${v.direction} route at ${v.station} is reporting in service.`);
  } else {
    const ids = v.outages.map((o) => `${o.elevatorId} (${o.reason}, back ${o.estReturn})`).join(", ");
    lines.push(`Out of service: ${ids}.`);
    lines.push(
      v.alternative
        ? `Nearest step-free option: ${v.alternative.name}, a ${v.alternative.walkMinutes} min walk.`
        : "We have no step-free alternative on file nearby.",
    );
  }
  if (v.cars?.best) {
    lines.push(`Best-rated car: ${v.cars.best.car} of ${v.cars.trainCars}.`);
  }
  if (v.cars?.avoid) {
    lines.push(`Car ${v.cars.avoid.car} rates low on conditions (smell/cleanliness/A-C).`);
  }
  return lines.join(" ");
}
