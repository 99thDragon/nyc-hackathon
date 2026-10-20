#!/usr/bin/env python3
"""Build a SYNTHETIC 30-day history so the reliability query can be seen working
before a real API key exists and before 30 days of real polling have elapsed.

This writes to its own database file (data/demo.sqlite3 by default) and never
touches the real one. The outage patterns are invented; the equipment codes and
station names are real, pulled from the inventory if it has been synced.

    python3 tools/seed_demo.py
    ./run.py --db data/demo.sqlite3 report --worst
"""

import os
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from ene import db, poller  # noqa: E402

INTERVAL = timedelta(minutes=5)
DAYS = 30

# (code, [(day_offset_start, duration_hours), ...], reason)
SCENARIOS = [
    ("EL101", [(2, 31), (9, 54), (17, 22), (24, 40)], "Repair"),
    ("EL103", [(11, 73)], "Awaiting Parts"),
    ("EL105", [(5, 6), (20, 4)], "Water Condition"),
    ("EL102", [], None),
]

# This unit only entered our inventory 3 days ago, so a 30-day score would be
# a fiction. It must come back "not enough data" rather than a number.
LATE_ARRIVAL = ("EL104", 3)


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else "data/demo.sqlite3"
    if os.path.exists(path):
        os.remove(path)
    conn = db.connect(path)

    # Copy real equipment rows across if the inventory has been synced.
    real = db.connect(None)
    codes = [c for c, _, _ in SCENARIOS] + [LATE_ARRIVAL[0]]
    copied = 0
    for code in codes:
        row = real.execute("SELECT * FROM equipment WHERE equipment_code=?", (code,)).fetchone()
        if row:
            conn.execute(
                f"INSERT OR REPLACE INTO equipment VALUES ({','.join('?' * len(row))})",
                tuple(row))
            copied += 1
    real.close()

    # Backdate first_seen so the scenario units have a real 30-day history,
    # except the late arrival, which we only started tracking 3 days ago.
    now0 = datetime.now(timezone.utc).replace(second=0, microsecond=0)
    old = (now0 - timedelta(days=DAYS)).isoformat()
    recent = (now0 - timedelta(days=LATE_ARRIVAL[1])).isoformat()
    conn.execute("UPDATE equipment SET first_seen_utc=?", (old,))
    conn.execute("UPDATE equipment SET first_seen_utc=? WHERE equipment_code=?",
                 (recent, LATE_ARRIVAL[0]))
    conn.commit()

    now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
    start = now - timedelta(days=DAYS)

    windows = {}
    for code, spans, reason in SCENARIOS:
        windows[code] = ([(start + timedelta(days=d), start + timedelta(days=d, hours=h))
                          for d, h in spans], reason)

    late_code, late_days = LATE_ARRIVAL
    late_start = now - timedelta(days=late_days)

    t, polls = start, 0
    while t <= now:
        out = []
        for code, (spans, reason) in windows.items():
            if any(a <= t < b for a, b in spans):
                out.append({"equipment_code": code, "reason": reason,
                            "outage_began_utc": None, "estimated_return_utc": None,
                            "is_upcoming": 0, "is_maintenance": 0, "raw": {}})
        if t >= late_start:
            out.append({"equipment_code": late_code, "reason": "Repair",
                        "outage_began_utc": None, "estimated_return_utc": None,
                        "is_upcoming": 0, "is_maintenance": 0, "raw": {}})

        stamp = t.isoformat()
        cur = conn.execute(
            "INSERT INTO polls (source, started_utc, finished_utc, ok) VALUES (?,?,?,1)",
            ("demo-seed", stamp, stamp))
        poller.apply_snapshot(conn, cur.lastrowid, out, observed_utc=stamp)
        polls += 1
        t += INTERVAL

    conn.commit()
    s = db.stats(conn)
    print(f"seeded {path}")
    print(f"  {polls} polls over {DAYS} days, {s['events']} state changes, "
          f"{copied} real equipment rows copied")
    conn.close()


if __name__ == "__main__":
    main()
