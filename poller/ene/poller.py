"""Poll the outages feed and append observed state changes.

One poll writes rows only where something changed. A unit that has been out
of service for three days produces one `outage_began` row, not 864 identical
ones. The `polls` table records that we looked, so uptime maths can tell
"in service" apart from "not observed".
"""

import hashlib
import json

from . import feeds
from .feeds import FeedError, utcnow


def _fingerprint(item):
    """Identifies a *version* of an outage. Changes when the feed revises it."""
    parts = [item.get("reason") or "", item.get("outage_began_utc") or "",
             item.get("estimated_return_utc") or "", str(item.get("is_maintenance") or 0)]
    return hashlib.sha1("|".join(parts).encode("utf-8")).hexdigest()[:16]


def _outage_key(item, observed_utc):
    """Identifies one continuous outage, so a unit that breaks, is fixed and
    breaks again produces two distinguishable outages rather than one blur."""
    anchor = item.get("outage_began_utc") or observed_utc
    return f"{item['equipment_code']}@{anchor}"


def _append_event(conn, poll_id, observed_utc, event, item, outage_key):
    conn.execute(
        """INSERT INTO outage_events
           (equipment_code, event, observed_utc, outage_key, reason,
            outage_began_utc, estimated_return_utc, is_upcoming,
            is_maintenance, raw_json, poll_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (item["equipment_code"], event, observed_utc, outage_key,
         item.get("reason"), item.get("outage_began_utc"),
         item.get("estimated_return_utc"), item.get("is_upcoming", 0),
         item.get("is_maintenance", 0), json.dumps(item.get("raw", {}), sort_keys=True), poll_id),
    )


def apply_snapshot(conn, poll_id, current, observed_utc=None):
    """Diff one feed snapshot against the last and append what changed.

    Returns a dict of counts. Everything here is one transaction: either the
    whole snapshot lands or none of it does, so a crash mid-write cannot leave
    the log claiming an elevator came back when it did not.
    """
    observed_utc = observed_utc or utcnow()
    counts = {"began": 0, "updated": 0, "returned": 0}

    previous = {
        row["equipment_code"]: row
        for row in conn.execute("SELECT * FROM current_outages")
    }
    seen = {}
    for item in current:
        seen[item["equipment_code"]] = item  # last write wins on duplicate codes

    for code, item in seen.items():
        fp = _fingerprint(item)
        raw_json = json.dumps(item.get("raw", {}), sort_keys=True)
        prior = previous.get(code)
        if prior is None:
            key = _outage_key(item, observed_utc)
            _append_event(conn, poll_id, observed_utc, "outage_began", item, key)
            counts["began"] += 1
            conn.execute(
                """INSERT INTO current_outages
                   (equipment_code, outage_key, first_observed_utc,
                    last_observed_utc, fingerprint, raw_json)
                   VALUES (?,?,?,?,?,?)""",
                (code, key, observed_utc, observed_utc, fp, raw_json))
        elif prior["fingerprint"] != fp:
            key = prior["outage_key"]
            _append_event(conn, poll_id, observed_utc, "outage_updated", item, key)
            counts["updated"] += 1
            conn.execute(
                """UPDATE current_outages
                   SET last_observed_utc=?, fingerprint=?, raw_json=?
                   WHERE equipment_code=?""",
                (observed_utc, fp, raw_json, code))
        else:
            conn.execute(
                "UPDATE current_outages SET last_observed_utc=? WHERE equipment_code=?",
                (observed_utc, code))

    for code, prior in previous.items():
        if code in seen:
            continue
        restored = {"equipment_code": code, "reason": None,
                    "outage_began_utc": None, "estimated_return_utc": None,
                    "is_upcoming": 0, "is_maintenance": 0,
                    "raw": {"returned_from": prior["outage_key"]}}
        _append_event(conn, poll_id, observed_utc, "returned_to_service",
                      restored, prior["outage_key"])
        counts["returned"] += 1
        conn.execute("DELETE FROM current_outages WHERE equipment_code=?", (code,))

    return counts


def poll_once(conn, api_key=None, fixture=None, url=None):
    """One poll. Records the attempt whether or not it succeeds.

    Never raises on feed trouble: a bad response is a recorded failed poll, not
    a dead scheduler. Only a genuine programming error propagates.
    """
    source = fixture if fixture else (url or feeds.MTA_OUTAGES_XML)
    started = utcnow()
    cur = conn.execute(
        "INSERT INTO polls (source, started_utc, ok) VALUES (?,?,0)", (source, started))
    poll_id = cur.lastrowid
    conn.commit()

    try:
        if fixture:
            current, upcoming, status = feeds.load_outages_from_file(fixture)
        else:
            current, upcoming, status = feeds.fetch_outages(
                api_key, url=url or feeds.MTA_OUTAGES_XML)
    except FeedError as exc:
        conn.execute(
            "UPDATE polls SET finished_utc=?, ok=0, http_status=?, error=? WHERE id=?",
            (utcnow(), getattr(exc, "status", None), str(exc)[:1000], poll_id))
        conn.commit()
        return {"ok": False, "poll_id": poll_id, "error": str(exc)}

    try:
        with conn:  # one transaction for the whole snapshot
            counts = apply_snapshot(conn, poll_id, current, observed_utc=started)
            conn.execute(
                """UPDATE polls SET finished_utc=?, ok=1, http_status=?,
                   units_reported=?, events_written=? WHERE id=?""",
                (utcnow(), status, len(current),
                 counts["began"] + counts["updated"] + counts["returned"], poll_id))
    except Exception as exc:
        conn.execute(
            "UPDATE polls SET finished_utc=?, ok=0, error=? WHERE id=?",
            (utcnow(), f"write failed: {exc!r}"[:1000], poll_id))
        conn.commit()
        return {"ok": False, "poll_id": poll_id, "error": repr(exc)}

    return {"ok": True, "poll_id": poll_id, "out_now": len(current),
            "upcoming": len(upcoming), **counts}


def sync_equipment(conn):
    """Refresh the asset inventory. Upsert: this describes the physical world."""
    rows = feeds.fetch_equipment()
    now = utcnow()
    added = updated = 0
    with conn:
        for rec in rows:
            item = feeds.normalise_equipment(rec)
            if item is None:
                continue
            exists = conn.execute(
                "SELECT 1 FROM equipment WHERE equipment_code=?",
                (item["equipment_code"],)).fetchone()
            conn.execute(
                """INSERT INTO equipment
                   (equipment_code, equipment_type, station_name, station_mrn,
                    station_complex_mrn, station_complex_description, subway_line,
                    borough, ada_compliant, serving, alternative_route,
                    latitude, longitude, raw_json, first_seen_utc, last_seen_utc)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                   ON CONFLICT(equipment_code) DO UPDATE SET
                     equipment_type=excluded.equipment_type,
                     station_name=excluded.station_name,
                     station_mrn=excluded.station_mrn,
                     station_complex_mrn=excluded.station_complex_mrn,
                     station_complex_description=excluded.station_complex_description,
                     subway_line=excluded.subway_line,
                     borough=excluded.borough,
                     ada_compliant=excluded.ada_compliant,
                     serving=excluded.serving,
                     alternative_route=excluded.alternative_route,
                     latitude=excluded.latitude,
                     longitude=excluded.longitude,
                     raw_json=excluded.raw_json,
                     last_seen_utc=excluded.last_seen_utc""",
                (item["equipment_code"], item["equipment_type"], item["station_name"],
                 item["station_mrn"], item["station_complex_mrn"],
                 item["station_complex_description"], item["subway_line"],
                 item["borough"], item["ada_compliant"], item["serving"],
                 item["alternative_route"], item["latitude"], item["longitude"],
                 json.dumps(item["raw"], sort_keys=True), now, now))
            if exists:
                updated += 1
            else:
                added += 1
    return {"fetched": len(rows), "added": added, "updated": updated}
