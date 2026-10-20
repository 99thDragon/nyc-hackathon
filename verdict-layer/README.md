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

## For teammates: what plugs in where

- **Fetchers** produce `Unit[]` (equipment + `availability90Pct`), `Outage[]` and a `Feed` with `fetchedAt`. Shapes are in `src/types.ts`; `loadContext()` in `src/server.ts` is the one place that reads sample data.
- **Decision model** (Builder 1): pass `decisionModel` in the context. It returns `{answer, probability}`. Probability under 0.6, or any error, becomes `not_enough_data`.
- **AI Gateway**: swap `anthropicGenerate` in `src/explain.ts` for a gateway call. Default model is `claude-sonnet-5-5` (override with `VERDICT_MODEL`).
- **Contract addition to agree on:** `data_age_s` on every verdict, so the UI can show "data may not be current" (NFR4).

`data/sample.json` is illustrative; IDs and numbers are made up and the feed is labeled as sample data in `sources`.
