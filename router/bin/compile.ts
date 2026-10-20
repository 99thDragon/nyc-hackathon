// Usage: node bin/compile.ts [YYYYMMDD] [--offline] [--out file]. Writes .cache/timetable-YYYYMMDD.bin by default, the file a Cron job
// would upload to Blob storage.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { compile } from "../src/compile.ts";
import { encode } from "../src/encode.ts";
import { downloadSubwayFeed } from "../src/gtfs-feed.ts";
import { serviceDateAt } from "../src/service-date.ts";

const args = process.argv.slice(2);
const date = args.find((arg) => /^\d{8}$/.test(arg)) ?? serviceDateAt(Date.now() / 1000, "America/New_York");
const cache = path.join(import.meta.dirname, "..", ".cache");
const source = await downloadSubwayFeed(cache, { offline: args.includes("--offline") });
const started = performance.now();
const data = await compile([source], date);
const seconds = (performance.now() - started) / 1000;
const bytes = encode(data);
const outFlag = args.indexOf("--out");
const output = outFlag >= 0 && args[outFlag + 1] ? path.resolve(args[outFlag + 1]) : path.join(cache, `timetable-${date}.bin`);
fs.writeFileSync(output, bytes);
console.log(JSON.stringify({
  date,
  stops: data.stopID.length,
  patterns: data.patternRoute.length,
  trips: data.tripID.length,
  events: data.arrivals.length,
  compileSeconds: Number(seconds.toFixed(2)),
  peakRSSMB: Math.round(process.resourceUsage().maxRSS / 1024),
  bytes: bytes.length,
  gzipBytes: zlib.gzipSync(bytes).length,
  output,
}, null, 2));
