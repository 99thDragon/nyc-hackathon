// Browser entry for the static map app. Build: npm run build:browser (writes ../router.js).
// Loads data/timetable.bin once, applies live trip updates for trips leaving within 2 hours, and returns up to
// 3 plans between two stations given as 39hk-dx4f `gtfs_stop_id` values (parent stations such as "A42").
import { decode } from "./encode.ts";
import { standardFootpaths } from "./footpaths.ts";
import { selectPlans } from "./plans.ts";
import { decodeFeedMessage } from "./realtime/protobuf.ts";
import type { FeedMessage } from "./realtime/protobuf.ts";
import { SUBWAY_FEEDS } from "./realtime/feeds.ts";
import type { RealtimeFeed } from "./realtime/feeds.ts";
import { buildOverlay, buildRealtimeIndex } from "./realtime/overlay.ts";
import type { RealtimeIndex } from "./realtime/overlay.ts";
import { TransitRouter } from "./router.ts";
import { Timetable } from "./timetable.ts";
import type { Footpaths } from "./footpaths.ts";
import { DEFAULT_PREFERENCES } from "./types.ts";
import type { Journey, RideLeg, StopAccess } from "./types.ts";

interface Loaded {
  timetable: Timetable;
  footpaths: Footpaths;
  index: RealtimeIndex;
}

const TRIP_FEEDS = SUBWAY_FEEDS.filter((feed) => feed.content.kind === "tripUpdates");
const REALTIME_WINDOW_S = 2 * 3600;
const FEED_TIMEOUT_MS = 3000;
// Previous-day trips past midnight and next-day trips before 4:00 are compiled in, so one file covers until 28:00.
const COVERED_UNTIL_S = 28 * 3600;

let loading: Promise<Loaded> | null = null;

function load(url: string): Promise<Loaded> {
  loading ??= fetch(url)
    .then((res) => {
      if (!res.ok) throw new Error(`timetable ${res.status}`);
      return res.arrayBuffer();
    })
    .then((buffer) => {
      const timetable = new Timetable(decode(new Uint8Array(buffer)));
      return {
        timetable,
        footpaths: standardFootpaths(timetable, DEFAULT_PREFERENCES),
        index: buildRealtimeIndex(timetable, TRIP_FEEDS),
      };
    });
  loading.catch(() => (loading = null));
  return loading;
}

async function fetchFeed(feed: RealtimeFeed): Promise<[RealtimeFeed, FeedMessage] | null> {
  try {
    const res = await fetch(feed.url, { cache: "no-store", signal: AbortSignal.timeout(FEED_TIMEOUT_MS) });
    // A bad feed path answers 200 with a JSON or HTML error body; trip feeds come as text/plain.
    if (!res.ok || /json|html|xml/.test(res.headers.get("content-type") ?? "")) return null;
    return [feed, decodeFeedMessage(new Uint8Array(await res.arrayBuffer()))];
  } catch {
    return null;
  }
}

function access(timetable: Timetable, stationIDs: string[]): StopAccess[] {
  const result: StopAccess[] = [];
  for (const id of stationIDs) {
    const stop = timetable.stopIndex(`subway:${id}`);
    if (stop !== undefined) result.push({ stop, seconds: 0, cost: 0 });
  }
  return result;
}

// The 39hk-dx4f station id of a platform: its parent's GTFS id without the namespace.
function stationID(timetable: Timetable, stop: number): string {
  const s = timetable.stop(stop);
  const station = s.parent === null ? s : timetable.stop(s.parent);
  return station.id.slice(station.id.indexOf(":") + 1);
}

function describe(timetable: Timetable, journey: Journey) {
  const iso = (seconds: number) => timetable.dateAt(seconds).toISOString();
  const rides = journey.legs.filter((leg): leg is RideLeg => leg.kind === "ride");
  return {
    departs: iso(journey.departure),
    arrives: iso(journey.arrival),
    minutes: Math.round((journey.arrival - journey.departure) / 60),
    transfers: Math.max(rides.length - 1, 0),
    rides: rides.map((ride) => ({
      line: ride.route.shortName || ride.route.longName,
      color: ride.route.color,
      headsign: ride.headsign,
      tripID: ride.tripID,
      from: { stationID: stationID(timetable, ride.from), name: timetable.stop(ride.from).name },
      to: { stationID: stationID(timetable, ride.to), name: timetable.stop(ride.to).name },
      departs: iso(ride.departure),
      arrives: iso(ride.arrival),
      delayMin: ride.scheduled?.arrival != null ? Math.round((ride.arrival - ride.scheduled.arrival) / 60) : null,
      path: ride.path.map((p) => [p.lon, p.lat]),
    })),
  };
}

export type Plan = ReturnType<typeof describe>;

async function plan(
  fromStationIDs: string[],
  toStationIDs: string[],
  { when = new Date(), url = "data/timetable.bin" }: { when?: Date; url?: string } = {},
): Promise<{ serviceDate: string; live: boolean; plans: Plan[] } | { error: string }> {
  const { timetable, footpaths, index } = await load(url);
  const departure = timetable.secondsAt(when);
  if (departure < 0 || departure > COVERED_UNTIL_S) {
    return { error: `The timetable is for ${timetable.data.serviceDate}; it needs a rebuild for this date.` };
  }
  const from = access(timetable, fromStationIDs), to = access(timetable, toStationIDs);
  if (!from.length || !to.length) return { error: "No scheduled subway service at one end of the trip." };

  const nearNow = Math.abs(when.getTime() - Date.now()) / 1000 <= REALTIME_WINDOW_S;
  const messages = nearNow ? (await Promise.all(TRIP_FEEDS.map(fetchFeed))).filter((m) => m !== null) : [];
  const overlay = messages.length ? buildOverlay(timetable, index, messages) : undefined;
  const router = new TransitRouter(timetable, footpaths, overlay);
  const journeys = router.journeys({ departure, access: from, egress: to });
  return {
    serviceDate: timetable.data.serviceDate,
    live: overlay !== undefined,
    plans: selectPlans(journeys, timetable, { limit: 3 })
      .sort((a, b) => a.arrival - b.arrival)
      .map((journey) => describe(timetable, journey)),
  };
}

(globalThis as unknown as { MagicCarpetRouter: unknown }).MagicCarpetRouter = { plan };
