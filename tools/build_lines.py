"""Build data/lines.json for the map: subway track shapes and stop coordinates.

Source: MTA static GTFS (https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip), no key.
Run:    python tools/build_lines.py
Shapes are simplified (Douglas-Peucker, ~8 m) so the file stays small.
"""

import csv
import io
import json
import math
import urllib.request
import zipfile
from collections import defaultdict
from pathlib import Path

GTFS_URL = "https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip"
OUT = Path(__file__).resolve().parent.parent / "data" / "lines.json"
TOLERANCE = 0.00008  # degrees, about 8 m


def simplify(pts, tol):
    if len(pts) < 3:
        return pts
    (x1, y1), (x2, y2) = pts[0], pts[-1]
    dx, dy = x2 - x1, y2 - y1
    norm = math.hypot(dx, dy) or 1e-12
    far, idx = -1.0, 0
    for i in range(1, len(pts) - 1):
        x, y = pts[i]
        d = abs(dy * x - dx * y + x2 * y1 - y2 * x1) / norm
        if d > far:
            far, idx = d, i
    if far <= tol:
        return [pts[0], pts[-1]]
    return simplify(pts[: idx + 1], tol)[:-1] + simplify(pts[idx:], tol)


def main():
    with urllib.request.urlopen(GTFS_URL) as res:
        z = zipfile.ZipFile(io.BytesIO(res.read()))
    read = lambda name: csv.DictReader(io.TextIOWrapper(z.open(name), encoding="utf-8-sig"))

    colors = {r["route_id"]: "#" + (r["route_color"] or "808183") for r in read("routes.txt")}
    shape_route = {}
    for t in read("trips.txt"):
        shape_route.setdefault(t["shape_id"], t["route_id"])

    raw = defaultdict(list)
    for p in read("shapes.txt"):
        raw[p["shape_id"]].append((int(p["shape_pt_sequence"]), float(p["shape_pt_lon"]), float(p["shape_pt_lat"])))

    shapes = {}
    for sid, rows in raw.items():
        rows.sort()
        pts = simplify([(lon, lat) for _, lon, lat in rows], TOLERANCE)
        route = shape_route.get(sid) or sid.split(".")[0]
        shapes[sid] = {
            "route": route,
            "color": colors.get(route, "#808183"),
            "coords": [[round(x, 5), round(y, 5)] for x, y in pts],
        }

    stops = {
        s["stop_id"]: [round(float(s["stop_lon"]), 5), round(float(s["stop_lat"]), 5)]
        for s in read("stops.txt")
        if s["location_type"] == "1"
    }

    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps({"shapes": shapes, "stops": stops}, separators=(",", ":")), encoding="utf-8")
    print(f"{len(shapes)} shapes, {len(stops)} stops -> {OUT} ({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
