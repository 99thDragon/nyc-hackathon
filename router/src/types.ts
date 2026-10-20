// Query, journey, and realtime overlay shapes shared by the router, the compiler, and the realtime client.
// Ported from scaffold `Journey.swift`, `TransitRouter.swift`, and `RealtimeOverlay.swift`, without shelter
// weights. Times are seconds from the timetable's reference time; costs are weighted seconds.

import type { Point, Route } from "./timetable.ts";

// A walk between the origin (or destination) and a stop. Access to a station expands to its served platforms.
export interface StopAccess {
  stop: number;
  seconds: number;
  cost: number;
}

export interface Preferences {
  rideWeight: number;
  waitWeight: number;
  // In-station walks from transfers.txt.
  transferWalkWeight: number;
  // Straight-line street walks between nearby stops.
  streetWalkWeight: number;
  transferPenaltySeconds: number;
}

export const DEFAULT_PREFERENCES: Preferences = {
  rideWeight: 1,
  waitWeight: 1,
  transferWalkWeight: 1,
  streetWalkWeight: 1,
  transferPenaltySeconds: 120,
};

export interface TransitQuery {
  // Earliest departure from the origin.
  departure: number;
  access: StopAccess[];
  egress: StopAccess[];
  preferences?: Preferences;
  // Per-stop multiplier on waiting seconds; stops past the end use `preferences.waitWeight`.
  waitWeights?: Float64Array;
  // Maximum number of rides. Default 3.
  maxRounds?: number;
  // Journeys arriving more than this after the earliest arrival are dropped. Waiting at the origin is free, so
  // without a bound a trip hours later that rides slightly faster would be Pareto-optimal. Default 1800.
  arrivalSlackSeconds?: number;
}

export interface AccessLeg {
  kind: "access";
  index: number; // position in query.access
  stop: number;
  start: number;
  seconds: number;
  cost: number;
}

export interface WaitLeg {
  kind: "wait";
  stop: number;
  start: number;
  seconds: number;
  cost: number;
}

export interface RideLeg {
  kind: "ride";
  pattern: number;
  trip: number; // absolute trip index; -1 for a trip only realtime data lists
  tripID: string;
  serviceDayOffset: number; // -1 previous-day trip past midnight, 1 next-day trip
  route: Route;
  headsign: string;
  from: number;
  to: number;
  departure: number;
  arrival: number;
  // Static times of a realtime ride; null when the times are scheduled. Inner nulls for an added trip.
  scheduled: { departure: number | null; arrival: number | null } | null;
  cost: number;
  path: Point[];
}

export interface TransferLeg {
  kind: "transfer";
  from: number;
  to: number;
  start: number;
  seconds: number;
  cost: number;
}

export interface EgressLeg {
  kind: "egress";
  index: number; // position in query.egress
  stop: number;
  start: number;
  seconds: number;
  cost: number;
}

export type Leg = AccessLeg | WaitLeg | RideLeg | TransferLeg | EgressLeg;

// A Pareto-optimal journey over (arrival, cost). `cost` is the sum of leg costs plus the transfer penalty per
// transfer. `departure` is the latest departure from the origin that makes the first boarding.
export interface Journey {
  departure: number;
  arrival: number;
  cost: number;
  legs: Leg[];
}

// ---- Realtime overlay, produced by src/realtime and consumed by the router ----

// A stop the vehicle has passed takes PASSED for both times. A skipped stop, or one after an added trip's last
// update, takes CLOSED arrival and PASSED departure. Neither can be boarded; CLOSED arrivals cannot be alighted.
export const PASSED = -2147483648;
export const CLOSED = 2147483647;

export interface RealtimeTrip {
  base: number; // absolute trip index in the timetable; -1 for a trip only realtime data lists
  tripID: string;
  updated: boolean;
}

// Every trip of one pattern with realtime times, split into blocks that never overtake one another, so the
// router scans each block as its own route.
export interface RealtimePatternTrips {
  trips: RealtimeTrip[];
  arrivals: Int32Array; // trips.length rows of the pattern's stop count
  departures: Int32Array;
  blocks: { start: number; end: number }[]; // half-open trip ranges
}

export interface RealtimeOverlay {
  patterns: Map<number, RealtimePatternTrips>;
  updatedTrips: number;
  addedTrips: number;
  canceledTrips: number;
  unmatchedTrips: number;
}
