#!/usr/bin/env python3
"""CLI for the MTA elevator/escalator outage poller.

    ./run.py sync-equipment          refresh the asset inventory (no API key needed)
    ./run.py poll                    one poll of the outages feed
    ./run.py poll --fixture F.xml    one poll from a saved sample
    ./run.py run --interval 300      poll on a loop until stopped
    ./run.py status                  what the database holds
    ./run.py report EL123            availability for one unit
    ./run.py report --worst          least reliable units
"""

import argparse
import json
import os
import signal
import sys
import time
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from ene import db, export, poller, reliability  # noqa: E402

_stop = False


def _handle_signal(signum, frame):
    global _stop
    _stop = True
    print(f"\n[{datetime.now(timezone.utc):%H:%M:%S}] signal {signum}: finishing current poll, "
          "then stopping.", flush=True)


HERE = os.path.dirname(os.path.abspath(__file__))


def _load_dotenv(path=None):
    """Read KEY=value lines from .env into the environment.

    Keeps the API key out of the launchd plist, where it would sit in
    world-readable XML under ~/Library/LaunchAgents. Existing environment
    variables win, so an explicit export still overrides the file.
    """
    path = path or os.path.join(HERE, ".env")
    try:
        with open(path, "r", encoding="utf-8") as fh:
            lines = fh.readlines()
    except OSError:
        return
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and value and key not in os.environ:
            os.environ[key] = value


def _feed_url(args):
    """Explicit flag, then .env, then the built-in default.

    The exact outages URL is confirmed on the api.mta.info portal after you
    register. If it has moved, a wrong URL and a missing key both return 403,
    so this is settable without touching code.
    """
    _load_dotenv()
    return args.url or os.environ.get("MTA_OUTAGES_URL") or None


def _api_key(args):
    _load_dotenv()
    key = args.api_key or os.environ.get("MTA_API_KEY") or None
    # A placeholder left in .env is not a key; treat it as absent so the
    # error message stays honest rather than reporting an HTTP 403.
    if key and key.strip().upper() in ("", "CHANGE_ME", "YOUR_KEY_HERE", "PASTE_YOUR_KEY_HERE"):
        return None
    return key


def cmd_sync_equipment(args, conn):
    result = poller.sync_equipment(conn)
    print(f"equipment: fetched {result['fetched']}, "
          f"{result['added']} new, {result['updated']} refreshed")
    return 0


# The repo root is the served static site (index.html, data/lines.json), so
# the outage file lands beside the data the page already loads. Serving it
# from our own origin is what the MTA terms ask for; the app may still prefer
# its own live fetch.
WEB_DATA = os.path.join(os.path.dirname(HERE), "data", "outages.json")


def _publish(conn, result):
    """Refresh the page's outage file after a successful poll.

    Only on success: a failed poll must leave the last good file in place
    rather than replacing it with an empty set.
    """
    if not result.get("ok"):
        return ""
    try:
        n = export.write_outages_json(conn, WEB_DATA)
        return f" published={n}"
    except Exception as exc:  # publishing must never fail the poll
        print(f"  (publish failed: {exc!r})", file=sys.stderr)
        return " publish-failed"


def cmd_poll(args, conn):
    key = _api_key(args)
    if not key and not args.fixture:
        print(f"No API key yet. Paste it into {os.path.join(HERE, '.env')} as:\n"
              "    MTA_API_KEY=your-key-here\n"
              "Get a free key at https://api.mta.info\n"
              "Or run against a saved sample with --fixture.", file=sys.stderr)
        return 2
    result = poller.poll_once(conn, api_key=key, fixture=args.fixture,
                              url=_feed_url(args))
    published = _publish(conn, result)
    stamp = f"{datetime.now(timezone.utc):%Y-%m-%d %H:%M:%S}"
    if result["ok"]:
        print(f"[{stamp}] ok  out_now={result['out_now']} upcoming={result['upcoming']} "
              f"began={result['began']} updated={result['updated']} "
              f"returned={result['returned']}{published}")
        return 0
    print(f"[{stamp}] FAILED  {result['error']}", file=sys.stderr)
    return 1


def cmd_run(args, conn):
    """Poll on a loop. Survives feed failures; only a signal stops it."""
    key = _api_key(args)
    if not key and not args.fixture:
        print(f"No API key yet. Paste it into {os.path.join(HERE, '.env')} as:\n"
              "    MTA_API_KEY=your-key-here\n"
              "Get a free key at https://api.mta.info", file=sys.stderr)
        return 2

    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)

    print(f"polling every {args.interval}s. Ctrl-C to stop.", flush=True)
    consecutive_failures = 0
    while not _stop:
        started = time.monotonic()
        try:
            result = poller.poll_once(conn, api_key=key, fixture=args.fixture,
                                      url=_feed_url(args))
            _publish(conn, result)
        except Exception as exc:  # a bug here must not kill the schedule
            print(f"unexpected error, continuing: {exc!r}", file=sys.stderr, flush=True)
            result = {"ok": False, "error": repr(exc)}

        stamp = f"{datetime.now(timezone.utc):%Y-%m-%d %H:%M:%S}"
        if result["ok"]:
            consecutive_failures = 0
            if result["began"] or result["updated"] or result["returned"]:
                print(f"[{stamp}] out_now={result['out_now']} "
                      f"began={result['began']} updated={result['updated']} "
                      f"returned={result['returned']}", flush=True)
        else:
            consecutive_failures += 1
            print(f"[{stamp}] poll failed ({consecutive_failures} in a row): "
                  f"{result['error']}", file=sys.stderr, flush=True)

        # Back off on sustained failure, but keep trying: the feed coming back
        # matters more than being polite about it.
        delay = args.interval
        if consecutive_failures:
            delay = min(args.interval * min(consecutive_failures, 6), 1800)

        elapsed = time.monotonic() - started
        remaining = max(0.0, delay - elapsed)
        while remaining > 0 and not _stop:
            nap = min(1.0, remaining)
            time.sleep(nap)
            remaining -= nap

    print("stopped.")
    return 0


def cmd_status(args, conn):
    s = db.stats(conn)
    print(f"""database   {args.db or db.DEFAULT_DB}

equipment  {s['equipment']} units ({s['elevators']} elevators, {s['escalators']} escalators)
polls      {s['polls']} total -- {s['polls_ok']} ok, {s['polls_failed']} failed
events     {s['events']} state changes recorded
out now    {s['currently_out']} units
coverage   {s['first_poll']}  ->  {s['last_poll']}""")
    if s["polls_failed"]:
        print("\nrecent failures:")
        for row in conn.execute(
                """SELECT started_utc, http_status, error FROM polls
                   WHERE ok=0 ORDER BY started_utc DESC LIMIT 5"""):
            print(f"  {row['started_utc']}  {row['http_status'] or '-'}  "
                  f"{(row['error'] or '')[:100]}")
    return 0


def _print_unit(stats, label=None):
    avail = stats["availability"]
    rating = reliability.rating_1_to_5(avail)
    print(f"\n{stats['equipment_code']}" + (f"  {label}" if label else ""))
    print(f"  window        last {stats['window_days']} days")
    print(f"  observed      {stats['observed_hours']}h of "
          f"{stats['window_hours']}h ({stats['coverage']:.1%} of the window)")
    if stats.get("known_since"):
        print(f"  known since   {stats['known_since'][:16].replace('T', ' ')}")
    print(f"  outages       {stats['outage_count']}, "
          f"{stats['downtime_hours']}h down")
    if avail is None:
        print(f"  availability  not enough data -- {stats['reason_unavailable']}")
    else:
        print(f"  availability  {avail:.2%}")
        print(f"  rating        {rating}/5")


def cmd_report(args, conn):
    if args.worst:
        rows = reliability.worst_units(conn, days=args.days, limit=args.limit)
        if not rows:
            print(f"No unit has enough coverage in the last {args.days} days to score.\n"
                  "Run the poller for a while first -- `./run.py status` shows coverage.")
            return 0
        print(f"Least reliable elevators, last {args.days} days "
              f"(only units with enough observation):\n")
        print(f"{'unit':<10} {'avail':>7} {'rating':>6} {'down(h)':>8} {'n':>3}  station")
        for r in rows:
            print(f"{r['equipment_code']:<10} {r['availability']:>6.1%} "
                  f"{reliability.rating_1_to_5(r['availability']):>6} "
                  f"{r['downtime_hours']:>8.1f} {r['outage_count']:>3}  "
                  f"{(r['station_name'] or '')[:40]}")
        return 0

    if not args.equipment_code:
        print("Give an equipment code (./run.py report EL123) or --worst.", file=sys.stderr)
        return 2

    code = args.equipment_code.upper()
    stats = reliability.availability(conn, code, days=args.days)
    row = conn.execute(
        "SELECT station_name, borough, ada_compliant, alternative_route "
        "FROM equipment WHERE equipment_code=?", (code,)).fetchone()
    label = f"{row['station_name']} ({row['borough']})" if row else "not in inventory"
    _print_unit(stats, label)
    if row and row["ada_compliant"]:
        print(f"  ADA           {row['ada_compliant']}")
    if row and row["alternative_route"]:
        print(f"  alt route     {row['alternative_route'][:70]}")
    if args.json:
        print("\n" + json.dumps(stats, indent=2))
    return 0


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--db", help="path to the SQLite file")
    sub = p.add_subparsers(dest="command", required=True)

    sub.add_parser("sync-equipment", help="refresh the asset inventory")

    for name, helptext in (("poll", "one poll"), ("run", "poll on a loop")):
        sp = sub.add_parser(name, help=helptext)
        sp.add_argument("--api-key", help="api.mta.info key (or set MTA_API_KEY)")
        sp.add_argument("--fixture", help="read from a saved sample instead of the network")
        sp.add_argument("--url", help="override the feed URL")
        if name == "run":
            sp.add_argument("--interval", type=int, default=300,
                            help="seconds between polls (default 300)")

    sub.add_parser("status", help="what the database holds")

    rp = sub.add_parser("report", help="availability for a unit, or the worst units")
    rp.add_argument("equipment_code", nargs="?")
    rp.add_argument("--worst", action="store_true")
    rp.add_argument("--days", type=int, default=30)
    rp.add_argument("--limit", type=int, default=20)
    rp.add_argument("--json", action="store_true")

    args = p.parse_args(argv)
    conn = db.connect(args.db)
    try:
        handler = {
            "sync-equipment": cmd_sync_equipment, "poll": cmd_poll, "run": cmd_run,
            "status": cmd_status, "report": cmd_report,
        }[args.command]
        return handler(args, conn)
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
