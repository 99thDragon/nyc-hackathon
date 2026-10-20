"""Fetching and parsing the MTA elevator/escalator feeds.

Two sources, with different access stories:

* Asset inventory -- data.ny.gov dataset 94fv-bak7. Open, no key required.
* Current outages -- api.mta.info. Requires a free account and an API key.

Parsing is deliberately forgiving. The MTA warns the display is being
redesigned and reserves the right to change the feed without notice, so the
parser matches field names case-insensitively, accepts several spellings of
each field, and keeps the raw record on every row. A field we fail to
recognise costs us one column; it must never cost us the observation.
"""

import json
import re
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

NY = ZoneInfo("America/New_York")
USER_AGENT = "subway-elevator-poller/1.0 (+https://github.com/ - civic accessibility project)"

SOCRATA_EQUIPMENT = "https://data.ny.gov/resource/94fv-bak7.json"
# Host is api-endpoint.mta.info, NOT api.mta.info -- the latter is a different
# S3 bucket that returns 403 for these paths whether or not you hold a key.
MTA_OUTAGES_XML = "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fnyct_ene.xml"
MTA_EQUIPMENT_XML = "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fnyct_ene_equipments.xml"

# Envelopes we recognise as a genuine outages feed. Seeing one of these is what
# lets an empty list mean "nothing is broken" rather than "we misread a page".
OUTAGE_ROOTS = {"nycoutages", "nyct_ene", "outages"}
EQUIPMENT_ROOTS = {"nycequipments", "nyct_ene_equipments", "equipments"}


class FeedError(Exception):
    """Fetch or parse failed. Carries an HTTP status where there was one."""

    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status


def utcnow():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


# --------------------------------------------------------------------------
# fetching
# --------------------------------------------------------------------------

def fetch(url, api_key=None, timeout=30):
    """GET a URL. Returns (body_bytes, http_status). Raises FeedError."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    if api_key:
        req.add_header("x-api-key", api_key)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read(), resp.status
    except urllib.error.HTTPError as exc:
        body = b""
        try:
            body = exc.read()[:500]
        except Exception:
            pass
        hint = ""
        if exc.code in (401, 403):
            hint = (" -- the outages feed needs an API key from https://api.mta.info"
                    " (free account). Set MTA_API_KEY.")
        raise FeedError(f"HTTP {exc.code} for {url}{hint} {body[:200]!r}", status=exc.code) from exc
    except urllib.error.URLError as exc:
        raise FeedError(f"network error for {url}: {exc.reason}") from exc
    except Exception as exc:  # socket timeouts, TLS failures, truncated reads
        raise FeedError(f"fetch failed for {url}: {exc!r}") from exc


# --------------------------------------------------------------------------
# parsing helpers
# --------------------------------------------------------------------------

def _lower_keys(d):
    return {str(k).strip().lower(): v for k, v in d.items()}


def _first(rec, *names, default=None):
    """First present, non-empty value among several candidate field names."""
    for n in names:
        v = rec.get(n)
        if v is not None and str(v).strip() not in ("", "-", "null", "None"):
            return str(v).strip()
    return default


def _yn(value):
    """'Y'/'YES'/'true'/'1' -> 1, anything else -> 0."""
    return 1 if str(value or "").strip().upper() in ("Y", "YES", "TRUE", "1") else 0


_DATE_FORMATS = (
    "%m/%d/%Y %I:%M:%S %p",
    "%m/%d/%Y %H:%M:%S",
    "%m/%d/%Y %I:%M %p",
    "%m/%d/%Y",
    "%Y-%m-%dT%H:%M:%S.%f",
    "%Y-%m-%dT%H:%M:%S",
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%d",
)


def parse_feed_datetime(value):
    """Feed timestamps are New York local with no zone. Return UTC ISO, or None.

    Returning None on an unparseable date is deliberate: the feed's own
    timestamps are advisory, and our observation time is what the reliability
    maths actually runs on.
    """
    if not value:
        return None
    text = str(value).strip()
    if not text or text in ("-", "null"):
        return None
    for fmt in _DATE_FORMATS:
        try:
            naive = datetime.strptime(text, fmt)
        except ValueError:
            continue
        if naive.tzinfo is None:
            naive = naive.replace(tzinfo=NY)
        return naive.astimezone(timezone.utc).replace(microsecond=0).isoformat()
    return None


def check_envelope(body, expect=None):
    """Reject error documents that arrive with a 200 status.

    A mistyped feed path on this host returns HTTP 200 with an S3
    `<Error><Code>NoSuchKey</Code>` body. Parsed naively that looks like a feed
    with zero outages, which would be written to the log as every elevator in
    the system returning to service. An empty feed and an unreadable one must
    never be confused, so this refuses anything that is not recognisably the
    feed we asked for.

    Returns the lowercased root tag.
    """
    try:
        root = ET.fromstring(body)
    except ET.ParseError as exc:
        raise FeedError(f"malformed XML: {exc}") from exc

    tag = re.sub(r"\{.*\}", "", root.tag).strip().lower()

    if tag == "error":
        code = root.findtext("Code") or root.findtext("code") or "?"
        msg = (root.findtext("Message") or root.findtext("message") or "")[:120]
        raise FeedError(f"feed returned an error document ({code}): {msg} "
                        "-- check the feed URL")

    rc = root.findtext("responsecode")
    if rc is not None and rc.strip() not in ("0", ""):
        msg = (root.findtext("message") or "")[:120]
        raise FeedError(f"feed reported responsecode={rc.strip()}: {msg}")

    if expect and tag not in expect:
        raise FeedError(f"unexpected feed root <{root.tag}> -- expected one of "
                        f"{sorted(expect)}; refusing to treat this as an empty feed")
    return tag


def _xml_records(body):
    """Every direct child of the root becomes a flat dict of tag -> text."""
    try:
        root = ET.fromstring(body)
    except ET.ParseError as exc:
        raise FeedError(f"malformed XML: {exc}") from exc
    out = []
    for child in root:
        rec = {}
        for leaf in child.iter():
            if leaf is child:
                continue
            tag = re.sub(r"\{.*\}", "", leaf.tag).strip().lower()
            text = (leaf.text or "").strip()
            if tag and tag not in rec:
                rec[tag] = text
        if rec:
            out.append(rec)
    return out


def parse_records(body):
    """Accept either XML or JSON. Returns a list of lower-keyed dicts."""
    text = body.decode("utf-8", errors="replace").lstrip()
    if not text:
        raise FeedError("empty response body")
    if text[0] in "[{":
        try:
            data = json.loads(text)
        except json.JSONDecodeError as exc:
            raise FeedError(f"malformed JSON: {exc}") from exc
        if isinstance(data, dict):
            for key in ("outages", "equipment", "results", "data", "items"):
                if isinstance(data.get(key), list):
                    data = data[key]
                    break
            else:
                data = [data]
        return [_lower_keys(r) for r in data if isinstance(r, dict)]
    return _xml_records(body)


# --------------------------------------------------------------------------
# normalising
# --------------------------------------------------------------------------

def normalise_outage(rec):
    """One feed record -> the fields we store. Unknown shapes survive as raw."""
    code = _first(rec, "equipment", "equipmentno", "equipment_code", "equipmentcode")
    if not code:
        return None
    return {
        "equipment_code": code.upper(),
        "reason": _first(rec, "reason", "outagereason"),
        "outage_began_utc": parse_feed_datetime(
            _first(rec, "outagedate", "outage_date", "outagebegan", "startdate")),
        "estimated_return_utc": parse_feed_datetime(
            _first(rec, "estimatedreturntoservice", "estimated_return_to_service",
                   "estimatedreturn", "returntoservice")),
        "is_upcoming": _yn(_first(rec, "isupcomingoutage", "is_upcoming_outage", default="N")),
        "is_maintenance": _yn(_first(rec, "ismaintenanceoutage", "is_maintenance_outage", default="N")),
        "station": _first(rec, "station", "stationname"),
        "serving": _first(rec, "serving"),
        "raw": rec,
    }


def fetch_outages(api_key, url=MTA_OUTAGES_XML, timeout=30):
    """Current outages. Returns (current, upcoming, http_status).

    `upcoming` is split out and never treated as a live outage. The feed
    includes planned future work; counting that as downtime would make every
    scheduled maintenance window look like a failure.
    """
    body, status = fetch(url, api_key=api_key, timeout=timeout)
    _check_outage_body(body)
    records = parse_records(body)
    current, upcoming = [], []
    for rec in records:
        item = normalise_outage(rec)
        if item is None:
            continue
        (upcoming if item["is_upcoming"] else current).append(item)
    return current, upcoming, status


def _check_outage_body(body):
    """Envelope check, skipped only for JSON (which has no XML root to read)."""
    text = body.decode("utf-8", errors="replace").lstrip()
    if text[:1] in ("[", "{"):
        return
    check_envelope(body, expect=OUTAGE_ROOTS)


def load_outages_from_file(path):
    """Same shape as fetch_outages, from a saved fixture. For tests and dry runs."""
    try:
        with open(path, "rb") as fh:
            body = fh.read()
    except OSError as exc:
        raise FeedError(f"cannot read fixture {path}: {exc}") from exc
    _check_outage_body(body)
    current, upcoming = [], []
    for rec in parse_records(body):
        item = normalise_outage(rec)
        if item is None:
            continue
        (upcoming if item["is_upcoming"] else current).append(item)
    return current, upcoming, 200


# --------------------------------------------------------------------------
# equipment inventory (open data, no key)
# --------------------------------------------------------------------------

def fetch_equipment(limit=2000, timeout=60):
    """Full asset inventory from data.ny.gov, paged."""
    rows, offset, page = [], 0, 1000
    while True:
        url = f"{SOCRATA_EQUIPMENT}?$limit={page}&$offset={offset}&$order=equipment_code"
        body, _ = fetch(url, timeout=timeout)
        batch = parse_records(body)
        rows.extend(batch)
        if len(batch) < page or len(rows) >= limit:
            break
        offset += page
    return rows


def normalise_equipment(rec):
    code = _first(rec, "equipment_code", "equipmentno", "equipment")
    if not code:
        return None
    lat = _first(rec, "x_coordinate", "latitude")
    lon = _first(rec, "y_coordinate", "longitude")
    try:
        lat = float(lat) if lat else None
        lon = float(lon) if lon else None
    except ValueError:
        lat = lon = None
    complex_mrn = _first(rec, "station_complex_mrn")
    try:
        complex_mrn = int(float(complex_mrn)) if complex_mrn else None
    except ValueError:
        complex_mrn = None
    return {
        "equipment_code": code.upper(),
        "equipment_type": _first(rec, "elevator_or_escalator", "equipmenttype"),
        "station_name": _first(rec, "station_description", "station_name", "station"),
        "station_mrn": _first(rec, "station_mrn"),
        "station_complex_mrn": complex_mrn,
        "station_complex_description": _first(rec, "station_complex_description"),
        "subway_line": _first(rec, "subway_line", "linesservedbyelevator"),
        "borough": _first(rec, "borough"),
        "ada_compliant": _first(rec, "ada_compliant", "ada"),
        "serving": _first(rec, "elevator_direction_serviced", "serving"),
        "alternative_route": _first(rec, "alternative_route", "alternativeroute"),
        "latitude": lat,
        "longitude": lon,
        "raw": rec,
    }
