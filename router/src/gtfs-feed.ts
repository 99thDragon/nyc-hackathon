// Downloads and unpacks the MTA subway GTFS. Node-only. GET only: MTA's bucket answers HEAD with 403.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TimetableSource } from "./compile.ts";

export const SUBWAY_FEED_URL = "https://rrgtfsfeeds.s3.amazonaws.com/gtfs_supplemented.zip";

export async function downloadSubwayFeed(cacheDir: string, { offline = false } = {}): Promise<TimetableSource> {
  const zip = path.join(cacheDir, "gtfs_supplemented.zip");
  const directory = path.join(cacheDir, "subway");
  fs.mkdirSync(cacheDir, { recursive: true });
  if (!offline || !fs.existsSync(zip)) {
    const response = await fetch(SUBWAY_FEED_URL);
    if (!response.ok) throw new Error(`${SUBWAY_FEED_URL}: HTTP ${response.status}`);
    fs.writeFileSync(zip, new Uint8Array(await response.arrayBuffer()));
  }
  fs.rmSync(directory, { recursive: true, force: true });
  await promisify(execFile)("unzip", ["-q", "-o", zip, "-d", directory]);
  return { feedID: "subway", namespace: "subway", directory };
}
