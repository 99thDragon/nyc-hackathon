# Router

A-to-B subway routing for "Magic Carpet Engineering.md" section 5.2. It is a TypeScript port of the router in scaffold (`~/Projects/apps/iOS/scaffold`, Swift), written tonight from that design.

| Part | File | Scaffold source |
| --- | --- | --- |
| Columnar timetable, accessors | `src/timetable.ts` | `TransitGTFS/Timetable.swift` |
| GTFS compiler: service days, FIFO patterns, previous and next day trips | `src/compile.ts`, `src/csv.ts`, `src/service-date.ts` | `TimetableCompiler.swift`, `ServiceDate.swift` |
| Binary timetable file | `src/encode.ts` | `TimetableFile.swift` |
| McRAPTOR over (arrival, cost), 3 rides by default | `src/router.ts` | `TransitRouter.swift` |
| Transfer walks | `src/footpaths.ts` | `Footpaths.swift` |
| Plan ranking: cheapest and fastest always kept, near-duplicates dropped | `src/plans.ts` | `TripPlanner/PlanSelection.swift` |
| GTFS-realtime decoding, trip update overlay, alerts | `src/realtime/` | `GTFSRealtime.swift`, `RealtimeOverlay.swift`, `GTFSRealtimeClient.swift` |

Differences from scaffold: subway only, no shelter weights, at most 3 rides, rides keep `tripID` and the route for board-or-wait.

## Run

Node 24 runs the TypeScript directly.

```sh
npm install
npm test
npm run typecheck
node bin/compile.ts            # downloads gtfs_supplemented.zip, writes .cache/timetable-YYYYMMDD.bin
```

The runtime modules (timetable, encode, router, footpaths, plans, realtime) import nothing from Node, so the static page can load them after type stripping. The compiler and `bin/` need Node.

Tests run on the G-line fixture from scaffold (`test/fixtures/subway-g/`) and on a small hand-built network.

## Data terms

MTA terms ask that feeds be served from our own servers. Compile the timetable in a job and host the file; do not have clients download `gtfs_supplemented.zip` from the MTA bucket. GET works on the MTA feeds without a key; HEAD returns 403.
