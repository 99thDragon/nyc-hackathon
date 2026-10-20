"""Publish the current outage set as JSON for the web page.

The page reads this file from our own origin rather than calling the MTA
directly -- which the MTA's terms require, and which also sidesteps CORS and
keeps the feed key (when one is used) off the client.

Written atomically: the page may be fetching this file at the moment the
poller rewrites it, and half a JSON document renders as "no outages", which
is the one wrong answer this product must never give.
"""

import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path


def current_outages(conn):
    """The live set, keyed by equipment code, from the working state table."""
    out = {}
    for row in conn.execute(
            """SELECT c.equipment_code, c.first_observed_utc, c.raw_json,
                      e.station_name, e.ada_compliant
               FROM current_outages c
               LEFT JOIN equipment e ON e.equipment_code = c.equipment_code"""):
        try:
            raw = json.loads(row["raw_json"])
        except (TypeError, ValueError):
            raw = {}
        out[row["equipment_code"]] = {
            "since": row["first_observed_utc"],
            "reason": raw.get("reason") or None,
            "est_return": raw.get("estimatedreturntoservice") or None,
            "serving": raw.get("serving") or None,
            "station": row["station_name"] or raw.get("station") or None,
            "ada": row["ada_compliant"] or raw.get("ada") or None,
        }
    return out


def write_outages_json(conn, path):
    """Atomic write of the live outage set. Returns the number of units out."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)

    last = conn.execute(
        "SELECT id, started_utc FROM polls WHERE ok=1 ORDER BY id DESC LIMIT 1"
    ).fetchone()
    failures = conn.execute(
        """SELECT count(*) FROM polls
           WHERE ok=0 AND id > coalesce((SELECT max(id) FROM polls WHERE ok=1), 0)"""
    ).fetchone()[0]

    out = current_outages(conn)
    payload = {
        "as_of": last["started_utc"] if last else None,
        "poll_id": last["id"] if last else None,
        "generated": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "source": "MTA live elevator & escalator outage feed",
        # Non-zero means the newest figures are older than as_of suggests.
        # The page says so rather than showing a spinner or stale data silently.
        "failed_polls_since": failures,
        "count": len(out),
        "out": out,
    }

    fd, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, separators=(",", ":"))
        # mkstemp creates 0600; this file is served to browsers.
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return len(out)
