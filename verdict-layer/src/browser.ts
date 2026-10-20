// Browser entry for the static map app: rules + live MTA data, no server and no API key.
// Build: npm run build:browser  (writes ../verdicts.js). Claude-written reasons are server-side
// only; the browser shows the rule-written reasons.
import { decideStop } from "./rules.ts";
import { loadLiveContext, stopFor } from "./live.ts";
import type { Verdict } from "./types.ts";

async function forStation(complexId: string, platform?: string): Promise<Verdict[] | null> {
  const ctx = await loadLiveContext();
  const arrival = new Date(Date.now() + 10 * 60_000).toISOString();
  const stop = stopFor(ctx.equipment, complexId, platform, arrival);
  return stop ? decideStop(stop, ctx) : null;
}

(globalThis as unknown as { MagicCarpetVerdicts: unknown }).MagicCarpetVerdicts = { forStation };
