// Thin demo server around the rules. In the Next.js app, call decideStop() and explain()
// from a route handler instead.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decideStop } from "./rules.ts";
import { explain } from "./explain.ts";
import type { Context, StopInput, Unit, Outage } from "./types.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const sample = JSON.parse(fs.readFileSync(path.join(here, "../data/sample.json"), "utf8")) as {
  availabilityAsOf: string;
  equipment: Record<string, Unit>;
  outages: Outage[];
  stops: Record<string, StopInput>;
};

// Swap this for the live nyct_ene feeds + rc78-7x78 + the outage log; keep the shapes.
export function loadContext(now = Date.now()): Context {
  return {
    equipment: sample.equipment,
    availabilityAsOf: sample.availabilityAsOf,
    feed: {
      source: "SAMPLE DATA (illustrative, not real MTA data)",
      fetchedAt: new Date(now).toISOString(),
      outages: sample.outages,
    },
    now,
  };
}

// Static pointer, not an API. Every response carries it.
export const HELP = {
  forSomeoneWhoNeedsHelp:
    "If you see someone who needs assistance, call 311 or use the 311 website. In an emergency, call 911.",
  phone: "311",
  website: "https://portal.311.nyc.gov",
  emergency: "911",
};

export async function ask(
  input: { stationId: string; direction: string; question?: string },
  now = Date.now(),
) {
  const stop = sample.stops[`${input.stationId}:${input.direction}`];
  if (!stop) return null;
  const arrival = new Date(now + 10 * 60_000).toISOString(); // assume 10 min to arrive
  const verdicts = await decideStop({ ...stop, arrivalAt: arrival }, loadContext(now));
  return {
    verdicts: await Promise.all(verdicts.map((v) => explain(v, input.question))),
    help: HELP,
  };
}

const send = (res: http.ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(body));
};

export const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" });
    return void res.end();
  }
  if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true });
  if (req.method === "GET" && req.url === "/help") return send(res, 200, HELP);
  if (req.method === "GET" && req.url === "/stops") return send(res, 200, Object.keys(sample.stops));
  if (req.method === "POST" && req.url === "/ask") {
    try {
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 10_000) throw new Error("body too large");
      }
      const input = JSON.parse(raw);
      if (!input.stationId || !input.direction) {
        return send(res, 400, { error: "stationId and direction are required" });
      }
      const result = await ask(input);
      return result ? send(res, 200, result) : send(res, 404, { error: "unknown stop" });
    } catch (err) {
      return send(res, 400, { error: (err as Error).message });
    }
  }
  send(res, 404, { error: "not found" });
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000);
  server.listen(port, () => console.log(`verdict-layer listening on :${port}`));
}
