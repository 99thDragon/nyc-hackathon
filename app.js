// Magic Carpet prototype: live step-free verdicts for NYC subway stations on a 3D map.
// Data: MTA Subway Stations (data.ny.gov) + MTA elevator/escalator feeds (no key needed).

const STATIONS_URL = "https://data.ny.gov/resource/39hk-dx4f.json?$limit=1000";
const OUTAGES_URL = "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fnyct_ene.json";
const EQUIPMENT_URL = "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fnyct_ene_equipments.json";
const REFRESH_MS = 60_000;

const COLORS = { yes: "#2fd47a", out: "#ff4d4d", no: "#6b7078" };
const HEIGHTS = { yes: 260, out: 520, no: 90 };

const $ = (id) => document.getElementById(id);
let complexes = new Map(); // complex_id -> station complex
let equipment = new Map(); // equipmentno -> equipment record
let selectedId = null;

const map = new maplibregl.Map({
  container: "map",
  style: "https://tiles.openfreemap.org/styles/dark",
  center: [-73.975, 40.735],
  zoom: 11.3,
  pitch: 55,
  bearing: -29,
  antialias: true,
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");

// ---------- data ----------

function groupStations(rows) {
  const out = new Map();
  for (const r of rows) {
    const id = r.complex_id;
    const c = out.get(id) || { id, names: new Set(), nameCount: {}, routes: new Set(), lat: 0, lng: 0, n: 0, ada: 0, notes: new Set() };
    c.names.add(r.stop_name);
    c.nameCount[r.stop_name] = (c.nameCount[r.stop_name] || 0) + 1;
    (r.daytime_routes || "").split(" ").filter(Boolean).forEach((x) => c.routes.add(x));
    c.lat += +r.gtfs_latitude;
    c.lng += +r.gtfs_longitude;
    c.n += 1;
    const ada = +r.ada;
    // 1 = fully accessible beats 2 = partial beats 0 = none
    if (ada === 1 || (ada === 2 && c.ada === 0)) c.ada = ada;
    if (r.ada_notes && r.ada_notes !== "NaN") c.notes.add(r.ada_notes);
    out.set(id, c);
  }
  for (const c of out.values()) {
    c.lat /= c.n;
    c.lng /= c.n;
    // Most common platform name wins (Times Sq-42 St, not Port Authority); ties go to the shorter name.
    c.name = Object.entries(c.nameCount).sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0][0];
    c.routes = [...c.routes].sort();
    c.outages = [];
  }
  return out;
}

function applyOutages(outages) {
  for (const c of complexes.values()) c.outages = [];
  for (const o of outages) {
    if (o.isupcomingoutage !== "N" || o.equipmenttype !== "EL" || o.ADA !== "Y") continue;
    const eq = equipment.get(o.equipment);
    if (!eq) continue;
    const c = complexes.get(eq.stationcomplexid);
    if (c) c.outages.push({ ...o, alt: eq.alternativeroute, redundant: eq.redundant === 1 });
  }
  for (const c of complexes.values()) {
    const blocking = c.outages.filter((o) => !o.redundant);
    c.status = c.ada === 0 ? "no" : blocking.length ? "out" : "yes";
  }
}

async function getJSON(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
  return res.json();
}

async function loadAll() {
  const [stations, eq, outages] = await Promise.all([getJSON(STATIONS_URL), getJSON(EQUIPMENT_URL), getJSON(OUTAGES_URL)]);
  complexes = groupStations(stations);
  equipment = new Map(eq.map((e) => [e.equipmentno, e]));
  applyOutages(outages);
}

async function refreshOutages() {
  try {
    applyOutages(await getJSON(OUTAGES_URL));
    render();
  } catch (err) {
    $("fresh").textContent = `Couldn't refresh MTA data (${err.message}). Showing last known state.`;
  }
}

// ---------- map ----------

// A small circle polygon so each station can be extruded into a 3D pillar.
function pillar(lng, lat, meters = 55, steps = 16) {
  const dLat = meters / 111_320;
  const dLng = meters / (111_320 * Math.cos((lat * Math.PI) / 180));
  const ring = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * 2 * Math.PI;
    ring.push([lng + dLng * Math.cos(a), lat + dLat * Math.sin(a)]);
  }
  return [ring];
}

function toGeoJSON() {
  return {
    type: "FeatureCollection",
    features: [...complexes.values()].map((c) => ({
      type: "Feature",
      id: +c.id,
      properties: {
        id: c.id,
        name: c.name,
        status: c.status,
        color: COLORS[c.status],
        height: HEIGHTS[c.status] * (c.id === selectedId ? 1.6 : 1),
      },
      geometry: { type: "Polygon", coordinates: pillar(c.lng, c.lat) },
    })),
  };
}

function setupLayers() {
  // 3D buildings, dimmed so the station pillars stand out.
  if (!map.getLayer("mc-buildings") && map.getSource("openmaptiles")) {
    map.addLayer({
      id: "mc-buildings",
      type: "fill-extrusion",
      source: "openmaptiles",
      "source-layer": "building",
      minzoom: 13,
      paint: {
        "fill-extrusion-color": "#23262c",
        "fill-extrusion-height": ["coalesce", ["get", "render_height"], 10],
        "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
        "fill-extrusion-opacity": 0.75,
      },
    });
  }
  map.addSource("stations", { type: "geojson", data: toGeoJSON() });
  map.addLayer({
    id: "station-pillars",
    type: "fill-extrusion",
    source: "stations",
    paint: {
      "fill-extrusion-color": ["get", "color"],
      "fill-extrusion-height": ["get", "height"],
      "fill-extrusion-opacity": 0.92,
    },
  });

  const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 8 });
  map.on("mousemove", "station-pillars", (e) => {
    map.getCanvas().style.cursor = "pointer";
    popup.setLngLat(e.lngLat).setText(e.features[0].properties.name).addTo(map);
  });
  map.on("mouseleave", "station-pillars", () => {
    map.getCanvas().style.cursor = "";
    popup.remove();
  });
  map.on("click", "station-pillars", (e) => select(e.features[0].properties.id));
}

function render() {
  const src = map.getSource("stations");
  if (src) src.setData(toGeoJSON());

  const all = [...complexes.values()];
  const out = all.filter((c) => c.status === "out").length;
  const yes = all.filter((c) => c.status === "yes").length;
  $("s-count").textContent = `${out} accessible stations have an elevator out right now. ${yes} are step-free.`;
  $("fresh").textContent = `Data from the MTA, checked ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}. It may not be current.`;
  if (selectedId) showVerdict(complexes.get(selectedId));
}

// ---------- verdict ----------

const distKm = (a, b) => {
  const R = 6371, toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

function nearestStepFree(c) {
  let best = null;
  for (const o of complexes.values()) {
    if (o.id === c.id || o.status !== "yes") continue;
    const d = distKm(c, o);
    if (!best || d < best.d) best = { c: o, d };
  }
  return best;
}

function showVerdict(c) {
  $("verdict").hidden = false;
  $("v-name").textContent = c.name;
  $("v-routes").textContent = c.routes.join(" ");
  const big = $("v-big");
  big.className = `big ${c.status}`;
  const outBox = $("v-out");
  outBox.replaceChildren();

  if (c.status === "yes") {
    big.textContent = "YES";
    const notes = [...c.notes];
    $("v-why").textContent = c.ada === 2
      ? `Step-free, but only partly: ${notes.join(", ") || "some platforms"}.`
      : "Every elevator on the step-free route is working right now.";
  } else if (c.status === "out") {
    big.textContent = "NOT RIGHT NOW";
    $("v-why").textContent = "An elevator on the step-free route is out of service.";
    for (const o of c.outages) {
      const div = document.createElement("div");
      div.className = "outage";
      const b = document.createElement("b");
      b.textContent = o.serving;
      const s = document.createElement("span");
      s.textContent = `${o.reason}. Back around ${o.estimatedreturntoservice}.`;
      div.append(b, s);
      outBox.append(div);
    }
  } else {
    big.textContent = "NO";
    $("v-why").textContent = "This station has stairs only. There is no elevator route.";
  }

  const alt = $("v-alt");
  if (c.status === "yes") {
    alt.hidden = true;
  } else {
    const best = nearestStepFree(c);
    alt.hidden = !best;
    if (best) {
      const mins = Math.max(1, Math.round((best.d * 1000 * 1.3) / 80)); // street detour, ~80 m/min
      alt.replaceChildren("Nearest step-free station: ");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = best.c.name;
      btn.onclick = () => select(best.c.id);
      alt.append(btn, ` (${best.c.routes.join(" ")}), about ${mins} min walk.`);
    }
  }
}

function select(id) {
  const c = complexes.get(String(id));
  if (!c) return;
  selectedId = c.id;
  render();
  $("q").value = c.name;
  map.flyTo({ center: [c.lng, c.lat], zoom: 14.6, pitch: 60, bearing: map.getBearing() + 25, duration: 2200 });
}

// ---------- search ----------

function fillSearch() {
  const list = $("stations");
  const sorted = [...complexes.values()].sort((a, b) => a.name.localeCompare(b.name));
  list.replaceChildren(...sorted.map((c) => {
    const o = document.createElement("option");
    o.value = `${c.name} (${c.routes.join(" ")})`;
    o.dataset.id = c.id;
    return o;
  }));
  $("q").addEventListener("change", (e) => {
    const v = e.target.value.trim().toLowerCase();
    const hit = sorted.find((c) => `${c.name} (${c.routes.join(" ")})`.toLowerCase() === v)
      || sorted.find((c) => c.name.toLowerCase().startsWith(v))
      || sorted.find((c) => c.name.toLowerCase().includes(v));
    if (hit) select(hit.id);
  });
}

// ---------- voice (ElevenLabs) ----------

const ALIASES = [[/\bstreet\b/g, "st"], [/\bavenue\b/g, "av"], [/\bave\b/g, "av"], [/\bsquare\b/g, "sq"],
  [/\bcenter\b/g, "ctr"], [/\bboulevard\b/g, "blvd"], [/\bparkway\b/g, "pkwy"], [/\bplace\b/g, "pl"],
  [/\broad\b/g, "rd"], [/\bheights\b/g, "hts"], [/\bjunction\b/g, "jct"], [/\bfirst\b/g, "1"], [/(\d+)(st|nd|rd|th)\b/g, "$1"]];
const norm = (s) => ALIASES.reduce((t, [re, to]) => t.replace(re, to), s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ")).split(/\s+/).filter(Boolean);

function findStation(spoken) {
  const words = norm(spoken);
  let best = null;
  for (const c of complexes.values()) {
    const hay = norm(`${[...c.names].join(" ")} ${c.routes.join(" ")}`);
    const hits = words.filter((w) => hay.includes(w)).length;
    const score = hits / words.length - hay.length * 0.001; // prefer shorter names on ties
    if (hits && (!best || score > best.score)) best = { c, score };
  }
  return best && best.score > 0.4 ? best.c : null;
}

function verdictForVoice(c) {
  const base = { station: c.name, lines: c.routes.join(" ") };
  const alt = c.status === "yes" ? null : nearestStepFree(c);
  const altText = alt ? `${alt.c.name} (${alt.c.routes.join(" ")}), about ${Math.max(1, Math.round((alt.d * 1300) / 80))} min walk` : null;
  if (c.status === "yes") return { ...base, verdict: "YES", detail: c.ada === 2 ? `Partly step-free: ${[...c.notes].join(", ")}` : "All elevators on the step-free route are working." };
  if (c.status === "out") {
    return {
      ...base,
      verdict: "NOT RIGHT NOW",
      outages: c.outages.map((o) => ({ serving: o.serving, reason: o.reason, back_around: o.estimatedreturntoservice })),
      nearest_step_free: altText,
    };
  }
  return { ...base, verdict: "NO, STAIRS ONLY", nearest_step_free: altText };
}

document.querySelector("elevenlabs-convai").addEventListener("elevenlabs-convai:call", (event) => {
  event.detail.config.clientTools = {
    get_station_verdict: ({ station }) => {
      const c = station && findStation(station);
      if (!c) return JSON.stringify({ error: `Couldn't find a station matching "${station}".` });
      select(c.id);
      return JSON.stringify(verdictForVoice(c));
    },
  };
});

// ---------- start ----------

Promise.all([loadAll(), new Promise((r) => map.on("load", r))])
  .then(() => {
    setupLayers();
    fillSearch();
    render();
    setInterval(refreshOutages, REFRESH_MS);
  })
  .catch((err) => {
    $("s-count").textContent = `Couldn't load MTA data: ${err.message}`;
  });
