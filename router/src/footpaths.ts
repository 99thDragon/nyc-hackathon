// Stop-to-stop transfer walks in CSR form, ported from scaffold `Footpaths.swift`. RAPTOR relaxes one footpath
// between rides, so the set should be transitively closed for exact results; a 400 m radius makes chained walks
// rare.

import { distanceMeters, type Timetable } from "./timetable.ts";
import type { Preferences } from "./types.ts";

export interface FootpathEdge {
  from: number;
  to: number;
  seconds: number;
  cost: number;
}

export interface FootpathOptions {
  radiusMeters: number;
  speedMetersPerSecond: number;
  // Street-network distance over straight-line distance.
  detourFactor: number;
}

export const DEFAULT_FOOTPATH_OPTIONS: FootpathOptions = {
  radiusMeters: 400,
  speedMetersPerSecond: 1.15,
  detourFactor: 1.3,
};

export class Footpaths {
  readonly stopCount: number;
  readonly offsets: Int32Array;
  readonly targets: Int32Array;
  readonly seconds: Int32Array;
  readonly costs: Float64Array;

  // Seconds round up to whole seconds. Self-loops and edges with out-of-range stops are dropped.
  constructor(stopCount: number, edges: FootpathEdge[]) {
    const valid = edges
      .filter((e) => e.from !== e.to && e.from >= 0 && e.from < stopCount && e.to >= 0 && e.to < stopCount)
      .sort((a, b) => a.from - b.from || a.to - b.to);
    const offsets = new Int32Array(stopCount + 1);
    for (const edge of valid) offsets[edge.from + 1]++;
    for (let stop = 0; stop < stopCount; stop++) offsets[stop + 1] += offsets[stop];
    this.stopCount = stopCount;
    this.offsets = offsets;
    this.targets = Int32Array.from(valid, (e) => e.to);
    this.seconds = Int32Array.from(valid, (e) => clampInt32(Math.ceil(e.seconds)));
    this.costs = Float64Array.from(valid, (e) => e.cost);
  }

  get count(): number {
    return this.targets.length;
  }

  edgesFrom(stop: number): FootpathEdge[] {
    const result: FootpathEdge[] = [];
    for (let i = this.offsets[stop]; i < this.offsets[stop + 1]; i++) {
      result.push({ from: stop, to: this.targets[i], seconds: this.seconds[i], cost: this.costs[i] });
    }
    return result;
  }

  edges(): FootpathEdge[] {
    const result: FootpathEdge[] = [];
    for (let stop = 0; stop < this.stopCount; stop++) result.push(...this.edgesFrom(stop));
    return result;
  }

  // Replaces or drops edges, for example to substitute pedestrian-network times and costs.
  mapped(transform: (edge: FootpathEdge) => FootpathEdge | null): Footpaths {
    const edges: FootpathEdge[] = [];
    for (const edge of this.edges()) {
      const next = transform(edge);
      if (next) edges.push(next);
    }
    return new Footpaths(this.stopCount, edges);
  }
}

export function walkSeconds(meters: number, options: FootpathOptions = DEFAULT_FOOTPATH_OPTIONS): number {
  return (meters * options.detourFactor) / options.speedMetersPerSecond;
}

// transfers.txt pairs plus straight-line walks between served stops within `radiusMeters`. Transfers between
// stations expand to their served platforms and take precedence over the straight-line estimate for the same
// pair; transfer_type 3 removes the pair. Transfer walks cost `transferWalkWeight`, street walks
// `streetWalkWeight`.
export function standardFootpaths(
  timetable: Timetable,
  preferences: Preferences,
  options: FootpathOptions = DEFAULT_FOOTPATH_OPTIONS,
): Footpaths {
  const stopCount = timetable.stopCount;
  const served: number[] = [];
  for (let stop = 0; stop < stopCount; stop++) if (timetable.isServed(stop)) served.push(stop);

  // Key from * stopCount + to; null marks a removed pair.
  const explicit = new Map<number, FootpathEdge | null>();
  for (const transfer of timetable.transfers()) {
    for (const from of timetable.platforms(transfer.from)) {
      for (const to of timetable.platforms(transfer.to)) {
        if (from === to) continue;
        const key = from * stopCount + to;
        if (transfer.type === 3) {
          explicit.set(key, null);
          continue;
        }
        const seconds =
          transfer.minimumSeconds ??
          walkSeconds(distanceMeters(timetable.location(from), timetable.location(to)), options);
        explicit.set(key, { from, to, seconds, cost: seconds * preferences.transferWalkWeight });
      }
    }
  }

  const edges: FootpathEdge[] = [];
  for (const edge of explicit.values()) if (edge) edges.push(edge);
  const cellDegrees = options.radiusMeters / 111_195;
  if (!(cellDegrees > 0)) return new Footpaths(stopCount, edges);

  const lat = timetable.data.stopLat;
  const lon = timetable.data.stopLon;
  // Cells are sized at the most poleward stop so every cell spans at least the radius.
  let poleward = 0;
  for (const stop of served) poleward = Math.max(poleward, Math.abs(lat[stop]));
  const longitudeDegrees = cellDegrees / Math.cos((Math.min(poleward, 89) * Math.PI) / 180);
  const cellKey = (x: number, y: number) => `${x},${y}`;
  const grid = new Map<string, number[]>();
  const cellX = (stop: number) => Math.floor(lon[stop] / longitudeDegrees);
  const cellY = (stop: number) => Math.floor(lat[stop] / cellDegrees);
  for (const stop of served) {
    const key = cellKey(cellX(stop), cellY(stop));
    const list = grid.get(key);
    if (list) list.push(stop);
    else grid.set(key, [stop]);
  }
  for (const stop of served) {
    const origin = timetable.location(stop);
    const x = cellX(stop);
    const y = cellY(stop);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const other of grid.get(cellKey(x + dx, y + dy)) ?? []) {
          if (other === stop || explicit.has(stop * stopCount + other)) continue;
          const meters = distanceMeters(origin, timetable.location(other));
          if (meters > options.radiusMeters) continue;
          const seconds = walkSeconds(meters, options);
          edges.push({ from: stop, to: other, seconds, cost: seconds * preferences.streetWalkWeight });
        }
      }
    }
  }
  return new Footpaths(stopCount, edges);
}

export function clampInt32(value: number): number {
  if (value >= 2147483647) return 2147483647;
  if (value <= -2147483648) return -2147483648;
  return value | 0;
}
