"""SQLite storage for the elevator/escalator outage log.

Design rule: `outage_events` is append-only. Rows are never updated or
deleted. Reliability is recomputed from the log, so the scoring formula can
change later without losing data.

`polls` records every poll attempt including failures. This matters more than
it looks: you cannot honestly say "this elevator was in service 97% of the
month" if you do not know when you were looking. Gaps in observation are
excluded from the denominator rather than silently counted as uptime.
"""

import sqlite3
from pathlib import Path

DEFAULT_DB = Path(__file__).resolve().parent.parent / "data" / "ene.sqlite3"

SCHEMA = """
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Reference data from the MTA asset inventory. Refreshed daily; upserted,
-- because this is a description of the physical world, not an event log.
CREATE TABLE IF NOT EXISTS equipment (
    equipment_code              TEXT PRIMARY KEY,
    equipment_type              TEXT,
    station_name                TEXT,
    station_mrn                 TEXT,
    station_complex_mrn         INTEGER,
    station_complex_description TEXT,
    subway_line                 TEXT,
    borough                     TEXT,
    ada_compliant               TEXT,
    serving                     TEXT,
    alternative_route           TEXT,
    latitude                    REAL,
    longitude                   REAL,
    raw_json                    TEXT NOT NULL,
    first_seen_utc              TEXT NOT NULL,
    last_seen_utc               TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_equipment_station ON equipment(station_complex_mrn);
CREATE INDEX IF NOT EXISTS idx_equipment_type    ON equipment(equipment_type);

-- Every poll attempt, successful or not. Never deleted.
CREATE TABLE IF NOT EXISTS polls (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    source         TEXT    NOT NULL,
    started_utc    TEXT    NOT NULL,
    finished_utc   TEXT,
    ok             INTEGER NOT NULL DEFAULT 0,
    http_status    INTEGER,
    units_reported INTEGER,
    events_written INTEGER DEFAULT 0,
    error          TEXT
);

CREATE INDEX IF NOT EXISTS idx_polls_started ON polls(started_utc);
CREATE INDEX IF NOT EXISTS idx_polls_ok      ON polls(ok, started_utc);

-- APPEND-ONLY. One row per observed state change, not per poll.
CREATE TABLE IF NOT EXISTS outage_events (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    equipment_code       TEXT    NOT NULL,
    event                TEXT    NOT NULL,  -- outage_began | outage_updated | returned_to_service
    observed_utc         TEXT    NOT NULL,  -- when WE saw it (authoritative for our own history)
    outage_key           TEXT,              -- identifies one continuous outage
    reason               TEXT,
    outage_began_utc     TEXT,              -- as reported by the feed; may be absent or wrong
    estimated_return_utc TEXT,
    is_upcoming          INTEGER DEFAULT 0, -- planned future work, NOT a current outage
    is_maintenance       INTEGER DEFAULT 0,
    raw_json             TEXT    NOT NULL,
    poll_id              INTEGER NOT NULL REFERENCES polls(id)
);

CREATE INDEX IF NOT EXISTS idx_events_equipment ON outage_events(equipment_code, observed_utc);
CREATE INDEX IF NOT EXISTS idx_events_observed  ON outage_events(observed_utc);

-- Derived working state, used only to diff one poll against the last.
-- Fully rebuildable from outage_events; safe to drop.
CREATE TABLE IF NOT EXISTS current_outages (
    equipment_code     TEXT PRIMARY KEY,
    outage_key         TEXT,
    first_observed_utc TEXT NOT NULL,
    last_observed_utc  TEXT NOT NULL,
    fingerprint        TEXT NOT NULL,
    raw_json           TEXT NOT NULL
);

-- Guard rails: the log is append-only, enforced in the database rather than
-- by convention, because convention does not survive a tired afternoon.
CREATE TRIGGER IF NOT EXISTS outage_events_no_update
BEFORE UPDATE ON outage_events
BEGIN
    SELECT RAISE(ABORT, 'outage_events is append-only: updates are not allowed');
END;

CREATE TRIGGER IF NOT EXISTS outage_events_no_delete
BEFORE DELETE ON outage_events
BEGIN
    SELECT RAISE(ABORT, 'outage_events is append-only: deletes are not allowed');
END;
"""


def connect(path=None):
    """Open the database, creating it and its schema if needed."""
    path = Path(path) if path else DEFAULT_DB
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), timeout=30)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    return conn


def stats(conn):
    """Counts for the status command."""
    q = lambda sql: conn.execute(sql).fetchone()[0]
    return {
        "equipment": q("SELECT count(*) FROM equipment"),
        "elevators": q("SELECT count(*) FROM equipment WHERE equipment_type='Elevator'"),
        "escalators": q("SELECT count(*) FROM equipment WHERE equipment_type='Escalator'"),
        "polls": q("SELECT count(*) FROM polls"),
        "polls_ok": q("SELECT count(*) FROM polls WHERE ok=1"),
        "polls_failed": q("SELECT count(*) FROM polls WHERE ok=0"),
        "events": q("SELECT count(*) FROM outage_events"),
        "currently_out": q("SELECT count(*) FROM current_outages"),
        "first_poll": q("SELECT coalesce(min(started_utc),'-') FROM polls WHERE ok=1"),
        "last_poll": q("SELECT coalesce(max(started_utc),'-') FROM polls WHERE ok=1"),
    }
