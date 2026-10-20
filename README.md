# NYC Hackathon: Magic Carpet

RevenueCat x Pursuit build night, Oct 19 2026. Proposal: [Magic Carpet.md](Magic%20Carpet.md).

## Prototype (branch `feat/3d-map-prototype`)

A 3D map of every NYC subway station that answers one question: **can I get to the train without stairs, right now?**

- **Green pillar:** step-free right now
- **Red pillar (tall):** an accessibility elevator is out right now
- **Gray pillar (short):** stairs only

Pick a station (search box or click a pillar) to get a YES / NOT RIGHT NOW / NO verdict, the outage details, and the nearest working step-free station.

**Voice:** the "Talk to Magic Carpet" button starts an ElevenLabs voice agent. Say a station name; the agent calls the page's `get_station_verdict` tool, the map flies there, and it speaks the verdict.

## Run it

No install and no keys. It's a static page:

```bash
python -m http.server 8792
```

Then open http://localhost:8792. Voice needs a microphone and works on localhost or https.

## Data (all live, no API key)

- Stations and accessibility: [MTA Subway Stations](https://data.ny.gov/resource/39hk-dx4f.json) (data.ny.gov)
- Elevator outages: `https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fnyct_ene.json` (refreshed every 60s)
- Elevator details and alternative routes: `.../nyct%2Fnyct_ene_equipments.json`
- Map: MapLibre GL + OpenFreeMap tiles

## Files

| File | What it does |
|---|---|
| `index.html` | Page layout, loads MapLibre and the ElevenLabs widget |
| `app.js` | Loads MTA data, decides each station's verdict, draws 3D pillars, voice tool |
| `style.css` | Dark theme, mobile layout |
