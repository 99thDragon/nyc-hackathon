import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeVerdict } from "./facts.js";
import { phrase } from "./phrase.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const sample = JSON.parse(fs.readFileSync(path.join(here, "../data/sample.json"), "utf8"));

// Swap this for the live MTA elevator + outage feeds and the history poller.
export function loadData(now = Date.now()) {
  return {
    ...sample,
    source: "SAMPLE DATA (illustrative, not real MTA data)",
    feedFetchedAt: new Date(now).toISOString(),
  };
}

// Not an API: the 311 website and phone line, shown with every response.
export const HELP = {
  forSomeoneWhoNeedsHelp:
    "If you see someone who needs assistance, call 311 or use the 311 website. In an emergency, call 911.",
  phone: "311",
  website: "https://portal.311.nyc.gov",
  emergency: "911",
};

const HEADLINE = { yes: "Yes.", no: "No.", unknown: "Not sure." };

export async function ask({ stationId, direction, question }, now = Date.now()) {
  const verdict = computeVerdict(loadData(now), { stationId, direction }, now);
  const { text, by } = await phrase(verdict, question);
  return {
    headline: HEADLINE[verdict.answer],
    explanation: text,
    verdict,
    writtenBy: by,
    help: HELP,
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 10_000) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(raw));
  });
}

const send = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(body));
};

export const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type",
    });
    return res.end();
  }
  if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true });
  if (req.method === "GET" && req.url === "/help") return send(res, 200, HELP);
  if (req.method === "GET" && req.url === "/stations") {
    return send(
      res,
      200,
      Object.entries(sample.stations).map(([id, s]) => ({
        id,
        name: s.name,
        directions: Object.keys(s.directions),
      })),
    );
  }
  if (req.method === "POST" && req.url === "/ask") {
    try {
      const input = JSON.parse(await readBody(req));
      if (!input.stationId || !input.direction) {
        return send(res, 400, { error: "stationId and direction are required" });
      }
      return send(res, 200, await ask(input));
    } catch (err) {
      return send(res, 400, { error: err.message });
    }
  }
  send(res, 404, { error: "not found" });
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000);
  server.listen(port, () => console.log(`verdict-layer listening on :${port}`));
}
