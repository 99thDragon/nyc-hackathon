// Output contract from "Magic Carpet Engineering.md" section 3.3, plus one addition:
// `data_age_s`, so the UI can show "data may not be current" (NFR4, MTA terms).

export type Kind = "official" | "derived" | "crowd" | "survey";
export type DecidedBy = "rule" | "decision_model" | "lookup" | "not_enough_data";
export type VerdictName =
  | "step_free_now"
  | "elevator_working_at_arrival"
  | "elevator_reliability"
  | "which_car"
  | "car_conditions";

export interface Source {
  name: string;
  kind: Kind;
  as_of: string;
}

export interface Verdict {
  verdict: VerdictName;
  // "yes" | "no" | "not_enough_data" for facts, 1-5 for scores, a car number for lookups.
  answer: string | number;
  probability: number | null;
  decided_by: DecidedBy;
  reason: string;
  reasons: string[];
  // MTA values passed through unchanged. The MTA terms forbid modifying them.
  official: Record<string, unknown>;
  sources: Source[];
  trace_id: string;
  data_age_s: number;
}

// ---- Inputs (shapes the data fetchers should produce) ----

export interface Unit {
  id: string;
  desc: string;
  backupUnitId: string | null;
  nextAccessibleNorth: string | null;
  nextAccessibleSouth: string | null;
  altRouteText: string | null;
  // 90-day availability, 0-100, from rc78-7x78 and the poller log. null = unknown.
  availability90Pct: number | null;
  // Set by the live loader; used to pick the elevators for a platform.
  stationName?: string;
  complexId?: string;
  serving?: string;
}

export interface Outage {
  unitId: string;
  reason: string;
  estReturn: string | null; // raw text from the feed
  planned: boolean;
  startsAt: string | null; // ISO
  endsAt: string | null; // ISO
}

export interface Feed {
  source: string;
  fetchedAt: string; // ISO
  outages: Outage[];
}

export interface CarReport {
  car: number;
  smell: number; // 1-5, 5 = no smell
  cleanliness: number; // 1-5
  acWorking: boolean;
  crowding: number; // 1-5, 5 = packed
  daysAgo: number;
}

export interface StopInput {
  stationId: string;
  name: string;
  ada: 0 | 1 | 2; // 2 = partial
  direction: string;
  requiredUnitIds: string[]; // elevators on the street-to-platform path for this direction
  arrivalAt: string; // ISO
  carSurvey: { elevatorCar: number; trainCars: number; surveyedAt: string } | null;
  carReports: CarReport[];
}

export interface DecisionResult {
  answer: "yes" | "no";
  probability: number;
}
// Plug in the AI Gateway decision model here. Errors and low confidence become not_enough_data.
export type DecisionModel = (evidence: Record<string, unknown>) => Promise<DecisionResult>;

export interface Context {
  equipment: Record<string, Unit>;
  feed: Feed;
  availabilityAsOf: string;
  now?: number;
  decisionModel?: DecisionModel;
}
