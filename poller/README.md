# MTA elevator & escalator outage poller

Records the state of every NYC subway elevator and escalator over time, so
that per-unit reliability history accumulates from day one.

## Why this exists

Per-unit reliability *does* exist: [`rc78-7x78`](https://data.ny.gov/d/rc78-7x78)
publishes outages, entrapments and peak availability per `equipment_code`
every month back to 2015. An earlier draft of the proposal was wrong to say
otherwise.

What nobody publishes is the **event record underneath**: when each outage
began and ended, how long it ran, which hours of the day it hit — and
anything fresher than a monthly release running about seven weeks behind.

So the MTA can tell you an elevator averaged 93% last August. It cannot tell
you that this elevator fails most weekday evenings, or that it is out right
now and has been for six hours. That is what this records, at 5-minute
resolution, and it is the part that cannot be backfilled.

## What it collects

| Source | Needs a key? | What it gives |
| --- | --- | --- |
| [data.ny.gov `94fv-bak7`](https://data.ny.gov/resource/94fv-bak7.json) | No | Asset inventory: 482 elevators + 277 escalators, station, ADA flag, direction served, alternate route |
| `api-endpoint.mta.info` elevator/escalator outages | No, in practice | Which units are out, why, estimated return |

Both work with no setup today.

**The host is `api-endpoint.mta.info`, not `api.mta.info`.** The latter is a
different S3 bucket that returns `403 AccessDenied` for these paths whether or
not you hold a key — which makes a wrong host look exactly like a missing key.
This cost an hour; it is written down here so it does not cost another.

The feed currently serves these paths without any credential. The poller still
sends `MTA_API_KEY` when one is set, because the MTA's own documentation says
to register and the terms let them change access at any time.

## The API key

A key from <https://api.mta.info> goes in `.env` (already created, `chmod 600`):

```
MTA_API_KEY=your-key-here
```

The poller sends it as an `x-api-key` header when present. At the time of
writing the feed serves these paths without it, so the key is belt and braces
rather than a requirement.

To point at a different feed URL, uncomment `MTA_OUTAGES_URL` in `.env` rather
than editing code.

Every command also works offline against the samples in `fixtures/` via
`--fixture`.

## Usage

```bash
./run.py sync-equipment                            # refresh the inventory (no key)
./run.py poll                                      # one poll of the live feed
./run.py poll --fixture fixtures/ene_outages_t0.xml   # one poll from a sample
./run.py run --interval 300                        # poll every 5 minutes until stopped
./run.py status                                    # what the database holds
./run.py report EL101                              # availability for one unit
./run.py report --worst --days 30                  # least reliable units
```

No dependencies. Python 3.9+ standard library only.

## Storage

SQLite at `data/ene.sqlite3` (override with `--db`).

| Table | Role |
| --- | --- |
| `equipment` | Asset inventory. Upserted — it describes the physical world, not events. |
| `polls` | Every poll attempt, **including failures**. |
| `outage_events` | **Append-only.** One row per observed state change. |
| `current_outages` | Working state for diffing one poll against the last. Rebuildable; safe to drop. |

Three decisions worth knowing about:

**The event log is append-only, enforced by database triggers** rather than by
convention. `UPDATE` and `DELETE` on `outage_events` raise. Reliability is
recomputed from the log, so the scoring formula can change later — and it
will — without losing the underlying observations.

**Events are written on change, not per poll.** An elevator out for three days
produces one `outage_began` row, not 864 identical ones.

**Failed polls are recorded.** This matters more than it looks: you cannot
honestly say "97% available" if you do not know when you were looking. A poll
that fails is not observation, and the uptime maths excludes it.

**An unreadable feed is never treated as an empty one.** A mistyped path on
this host returns **HTTP 200 with an S3 `<Error>` body**. Parsed naively that
is a feed with zero outages, which would be written to the log as every
elevator in the system simultaneously returning to service — corrupting
exactly the history this project exists to build. So the response envelope is
checked before anything is believed: an `<Error>` root, a non-zero
`responsecode`, or an unrecognised root element all become failed polls.

## How availability is computed

```
availability = (observed time − downtime) / observed time
```

Not wall-clock time. Three things keep it honest:

- **Gaps are excluded from the denominator.** If the poller was down for six
  hours and the elevator broke during them, counting that as uptime would be a
  lie that flatters us. The gap threshold is derived from the poll cadence
  actually present in the data, so a 5-minute poller and a 30-minute poller
  both behave sensibly with no configuration.
- **The window is clamped to when we first knew the unit existed.** A newly
  commissioned elevator is not credited with a month of uptime it was never
  around for.
- **Thin coverage returns no score.** Below 50% of the window observed,
  `availability` comes back `None` with a reason, rather than a confident
  number built on four hours of data.

Planned future outages (`isupcomingoutage = Y`) are parsed, flagged and
**never counted as downtime** — otherwise every scheduled maintenance window
would look like a failure.

The 1–5 rating bands:

| Rating | Availability |
| --- | --- |
| 1 | below 75% — do not plan around it |
| 2 | 75–90% |
| 3 | 90–96% |
| 4 | 96–99% |
| 5 | 99%+ — essentially always up |

## Seeing it work before 30 days have passed

```bash
python3 tools/seed_demo.py
./run.py --db data/demo.sqlite3 report --worst
```

Builds a **synthetic** 30-day history in its own database file, using real
equipment codes. The outage patterns are invented; it exists so the query can
be seen working before real history exists. It never touches `data/ene.sqlite3`.

### Querying it directly

The log is plain SQLite, so you can answer the basic question in SQL:

```sql
SELECT equipment_code, count(*) AS outages
FROM outage_events
WHERE event = 'outage_began'
  AND observed_utc >= datetime('now', '-30 days')
GROUP BY equipment_code ORDER BY outages DESC;
```

Be aware that hand-written SQL like this measures against wall-clock time. It
does **not** apply the coverage clamp or the known-since window, so it will
report a confident figure where `./run.py report` correctly declines to. Use
the CLI for numbers you intend to show anyone.

## Scheduling — already installed

Two launchd agents are installed in `~/Library/LaunchAgents` and loaded:

| Job | Runs | Does |
| --- | --- | --- |
| `com.pursuit.ene-poller` | every 5 minutes | polls the outages feed |
| `com.pursuit.ene-equipment` | daily at 04:17 | refreshes the asset inventory |

They invoke `/usr/bin/python3` — the system interpreter, chosen because its
path never moves and the full suite passes on 3.9.6. The API key lives in
`.env`, not in the plists, so it is not sitting in readable XML under
`~/Library`.

```bash
launchctl list | grep pursuit                        # are they registered?
tail -f data/poll.err                                # what the poller is saying
launchctl kickstart -k gui/$UID/com.pursuit.ene-poller   # force a run now
```

To stop or remove them:

```bash
launchctl bootout gui/$UID/com.pursuit.ene-poller
launchctl bootout gui/$UID/com.pursuit.ene-equipment
rm ~/Library/LaunchAgents/com.pursuit.ene-*.plist
```

The plists in `tools/` are the installed source. They contain absolute paths,
so if you move this directory, regenerate and reload them.

A note on sleep: launchd runs a missed `StartInterval` job once after the Mac
wakes, not once per interval missed. Overnight sleep therefore shows up as an
observation gap — which the availability maths already excludes rather than
counting as uptime.

The database is small. At one poll every 5 minutes, `polls` grows by about
105,000 rows a year, and `outage_events` only when something actually changes.

## Testing

```bash
python3 -m unittest discover -s tests -t .
```

32 tests, covering feed parsing and schema drift, the envelope guard above,
the change-detection diff, failure handling, the append-only guard, and the
gap-aware availability maths.

## MTA terms

From the [developer terms](https://www.mta.info/developers/terms-and-conditions):

- Data must be hosted on **non-MTA servers** — do not proxy the feed.
- Data may be subsetted but **not modified or deleted**, so derived ratings
  must sit visibly alongside official values rather than replacing them.
- If realtime lag exceeds one minute, users must be told the data may not be
  current.
- You may say data came from the MTA; you may **not** imply MTA endorsement.
- You may not state or imply the data is accurate, complete or timely.
- **The MTA may suspend the feed or change the terms at any time, without
  notice.** The accumulated history stays yours and keeps its value if that
  happens.
- Commercial use may require a separate MTA licence — resolve that before
  monetising anything built on this.
