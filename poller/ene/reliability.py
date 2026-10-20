"""Reliability computed from the append-only log.

The whole point of this project is a number nobody else publishes: how much
of the time a *particular* elevator actually works. The MTA publishes
availability only as a systemwide monthly percentage.

The honest version of that number has to account for when we were not
looking. If the poller was down for six hours and the elevator broke during
them, counting that as uptime is a lie that favours us. So observation gaps
are removed from the denominator and reported alongside the score, and a unit
with too little coverage returns no score at all rather than a confident one.
"""

from datetime import datetime, timedelta, timezone

# A gap between successful polls longer than the threshold counts as "not
# observed" rather than as continuous knowledge. The threshold is derived from
# the cadence actually observed in the data rather than hard-coded, because a
# fixed 20 minutes silently breaks the maths for anyone polling every 30.
GAP_FLOOR = timedelta(minutes=10)
GAP_CEILING = timedelta(hours=2)
GAP_MULTIPLIER = 4

# Below this share of the window observed, we refuse to publish a score.
MIN_COVERAGE = 0.50


def _dt(value):
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _overlap(a, b):
    """Seconds of overlap between two (start, end) intervals."""
    start = max(a[0], b[0])
    end = min(a[1], b[1])
    return max(0.0, (end - start).total_seconds())


def gap_threshold(stamps):
    """How long a silence counts as a gap, from the cadence in the data.

    Uses the median interval between successful polls, so a 5-minute poller and
    a 30-minute poller both get a sensible threshold without configuration.
    """
    if len(stamps) < 3:
        return GAP_CEILING
    deltas = sorted((b - a).total_seconds()
                    for a, b in zip(stamps, stamps[1:]) if b > a)
    if not deltas:
        return GAP_CEILING
    median = deltas[len(deltas) // 2]
    return max(GAP_FLOOR, min(GAP_CEILING, timedelta(seconds=median * GAP_MULTIPLIER)))


def observed_intervals(conn, window_start, window_end):
    """Stretches of the window we actually had eyes on.

    Built from successful polls only. A failed poll is not observation.
    """
    rows = conn.execute(
        """SELECT started_utc FROM polls
           WHERE ok=1 AND started_utc >= ? AND started_utc <= ?
           ORDER BY started_utc""",
        (window_start.isoformat(), window_end.isoformat())).fetchall()
    stamps = [t for t in (_dt(r["started_utc"]) for r in rows) if t]
    if not stamps:
        return []

    max_gap = gap_threshold(stamps)
    intervals, run_start, prev = [], stamps[0], stamps[0]
    for stamp in stamps[1:]:
        if stamp - prev > max_gap:
            intervals.append((run_start, prev))
            run_start = stamp
        prev = stamp
    intervals.append((run_start, prev))
    # A single poll observes an instant, not a span; drop zero-length runs.
    return [iv for iv in intervals if (iv[1] - iv[0]).total_seconds() > 0]


def outage_intervals(conn, equipment_code, window_start, window_end):
    """Stretches the unit was out, clipped to the window.

    State at the window's start comes from the last event before it, so an
    outage that began last month still counts against this month.
    """
    prior = conn.execute(
        """SELECT event FROM outage_events
           WHERE equipment_code=? AND observed_utc < ?
           ORDER BY observed_utc DESC, id DESC LIMIT 1""",
        (equipment_code, window_start.isoformat())).fetchone()
    out_since = window_start if (prior and prior["event"] in
                                 ("outage_began", "outage_updated")) else None

    rows = conn.execute(
        """SELECT event, observed_utc FROM outage_events
           WHERE equipment_code=? AND observed_utc >= ? AND observed_utc <= ?
           ORDER BY observed_utc, id""",
        (equipment_code, window_start.isoformat(), window_end.isoformat())).fetchall()

    spans = []
    for row in rows:
        stamp = _dt(row["observed_utc"])
        if stamp is None:
            continue
        if row["event"] == "outage_began" and out_since is None:
            out_since = stamp
        elif row["event"] == "returned_to_service" and out_since is not None:
            spans.append((out_since, stamp))
            out_since = None
    if out_since is not None:
        spans.append((out_since, window_end))
    return spans


def known_since(conn, equipment_code):
    """When this unit first appeared in our inventory.

    A newly commissioned elevator must not be credited with a month of
    uptime it was never around for, and a unit we only started tracking
    last week has no 30-day history to report.
    """
    row = conn.execute(
        "SELECT first_seen_utc FROM equipment WHERE equipment_code=?",
        (equipment_code,)).fetchone()
    return _dt(row["first_seen_utc"]) if row and row["first_seen_utc"] else None


def availability(conn, equipment_code, days=30, now=None):
    """Share of observed time the unit was in service.

    Returns `availability` as None when coverage is too thin to say. That is a
    feature: a rider deciding whether to trust an elevator is better served by
    "we don't know yet" than by a number built on four hours of data.
    """
    end = now or datetime.now(timezone.utc)
    start = end - timedelta(days=days)

    # Never claim history from before we knew the unit existed.
    since = known_since(conn, equipment_code)
    if since and since > start:
        start = since

    observed = observed_intervals(conn, start, end)
    observed_s = sum((b - a).total_seconds() for a, b in observed)
    window_s = (end - start).total_seconds()

    outages = outage_intervals(conn, equipment_code, start, end)
    down_s = sum(_overlap(o, w) for o in outages for w in observed)

    coverage = observed_s / window_s if window_s else 0.0
    enough = observed_s > 0 and coverage >= MIN_COVERAGE
    return {
        "equipment_code": equipment_code,
        "window_days": days,
        "window_start": start.isoformat(),
        "window_end": end.isoformat(),
        "observed_hours": round(observed_s / 3600, 2),
        "known_since": since.isoformat() if since else None,
        "coverage": round(coverage, 4),
        "outage_count": len(outages),
        "downtime_hours": round(down_s / 3600, 2),
        "availability": round((observed_s - down_s) / observed_s, 4) if enough else None,
        "reason_unavailable": None if enough else (
            "no successful polls in window" if observed_s == 0
            else f"only {coverage:.0%} of the window observed (need {MIN_COVERAGE:.0%})"),
        "window_hours": round(window_s / 3600, 2),
    }


def rating_1_to_5(avail):
    """Map availability to the proposal's 1-5 reliability scale.

    Anchors, per the proposal: 1 = out more than a quarter of the time, do not
    plan around it; 5 = essentially always up.
    """
    if avail is None:
        return None
    if avail < 0.75:
        return 1
    if avail < 0.90:
        return 2
    if avail < 0.96:
        return 3
    if avail < 0.99:
        return 4
    return 5


def worst_units(conn, days=30, limit=20, equipment_type="Elevator", now=None):
    """Least reliable units with enough coverage to say so."""
    rows = conn.execute(
        """SELECT DISTINCT e.equipment_code, e.station_name, e.borough, e.ada_compliant
           FROM equipment e WHERE e.equipment_type = ?
           UNION
           SELECT DISTINCT o.equipment_code, NULL, NULL, NULL
           FROM outage_events o
           WHERE o.equipment_code NOT IN (SELECT equipment_code FROM equipment)""",
        (equipment_type,)).fetchall()

    scored = []
    for row in rows:
        stats = availability(conn, row["equipment_code"], days=days, now=now)
        if stats["availability"] is None:
            continue
        stats["station_name"] = row["station_name"]
        stats["borough"] = row["borough"]
        stats["ada_compliant"] = row["ada_compliant"]
        stats["rating"] = rating_1_to_5(stats["availability"])
        scored.append(stats)

    scored.sort(key=lambda s: s["availability"])
    return scored[:limit]
