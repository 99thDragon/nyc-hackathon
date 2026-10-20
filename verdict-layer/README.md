# Verdict layer

Rules + explanation layers from `Magic Carpet Engineering.md`. For one stop on a trip it returns verdicts in the team's output contract (section 3.3).

| Verdict | Answer | Decided by |
| --- | --- | --- |
| `step_free_now` | yes / no / not_enough_data | rule |
| `elevator_working_at_arrival` | yes / no / not_enough_data (+ probability when a decision model is plugged in) | rule, then optional decision model |
| `elevator_reliability` | 1-5 (weakest elevator on the route) | rule (formula from the notes) |
| `which_car` | car number | lookup, surveyed stations only |
| `car_conditions` | best car by smell, cleanliness, A/C, crowding | rule on rider reports; < 3 reports = "not rated yet" |

- **`src/rules.ts`** (layer 1): `decideStop(stop, ctx)`. Handles active, planned and "Under Investigation" outages, missing units, the 60 s stale warning, and a hard stale cutoff.
- **`src/explain.ts`** (layer 3): `explain(verdict, question, generate)`. Claude rewrites only `reason`. Empty, over-long or people/safety-worded output falls back to the rule-written reason.
- **`src/server.ts`**: thin demo server (`POST /ask`, `GET /stops`, `/help`, `/health`). In the Next.js app, call `decideStop()` and `explain()` from a route handler instead.
- **No people or safety fields, by design.** A test enforces it. Every response also carries the 311 / 911 pointer; nothing is submitted to 311.

## Run

```bash
cd verdict-layer
npm install
npm test            # node --test, TypeScript run natively (Node 22.18+)
npm run typecheck
cp .env.example .env   # ANTHROPIC_API_KEY optional; without it the rule-written reasons are used
npm start
```

```bash
curl -X POST localhost:3000/ask -H 'content-type: application/json' \
  -d '{"stationId":"S59","direction":"uptown","question":"Can I get to the uptown platform without stairs?"}'
```

## Live MTA data

`src/live.ts` reads the real feeds (no key needed): `nyct_ene.json` (outages), `nyct_ene_equipments.json` (426 active elevators), and `rc78-7x78` (per-unit availability, last 3 months, currently Jun–Aug 2026).

```bash
curl 'localhost:3000/live/stations?q=149%20St'          # find a station, list its platforms
curl -X POST localhost:3000/ask -H 'content-type: application/json' \
  -d '{"station":"149 St-Hostos","platform":"Manhattan"}'   # real verdicts
```

- If the MTA feeds fail, `/ask` returns 502. It never falls back to sample data for a live question.
- Units missing from `rc78-7x78` (for example EL100-EL102 at 149 St-Hostos) get `not_enough_data` for reliability, not a guess.
- **Known approximation:** elevators for a platform are matched from description text (units naming that platform, plus units that name no platform). Replace with `94fv-bak7` inventory data when someone has time. With no platform given, every elevator at the station is required.
- The outage file carries no timestamp, so `data_age_s` is measured from when we fetched it, and the file itself can lag up to 30 minutes.
- `test/fixtures/mta-live-slice.json` is a slice of real rows recorded 2026-10-19; the live tests run offline against it.

## For teammates: what plugs in where

- **Fetchers** (done for elevators/outages/availability; GTFS-RT arrivals and 311 are not) produce `Unit[]` (equipment + `availability90Pct`), `Outage[]` and a `Feed` with `fetchedAt`. Shapes are in `src/types.ts`; `loadContext()` in `src/server.ts` is the one place that reads sample data.
- **Decision model** (Builder 1): pass `decisionModel` in the context. It returns `{answer, probability}`. Probability under 0.6, or any error, becomes `not_enough_data`.
- **AI Gateway**: swap `anthropicGenerate` in `src/explain.ts` for a gateway call. Default model is `claude-sonnet-5-5` (override with `VERDICT_MODEL`).
- **Contract addition to agree on:** `data_age_s` on every verdict, so the UI can show "data may not be current" (NFR4).

`data/sample.json` is illustrative; IDs and numbers are made up and the feed is labeled as sample data in `sources`.
