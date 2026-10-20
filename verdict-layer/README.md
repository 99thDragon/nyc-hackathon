# Verdict layer

Turns MTA elevator and station data into a rider-ready verdict: **Yes. / No. / Not sure.**, one short explanation, and the evidence behind it.

- **Code decides the answer** (`src/facts.js`): step-free now, nearest working alternative, per-elevator reliability (1-5), and car guidance.
- **Claude only phrases it** (`src/phrase.js`). It cannot change the yes/no. With no `ANTHROPIC_API_KEY`, or if the call fails, a plain template is used instead.
- **Car guidance rates physical conditions only**: smell, cleanliness, A/C, crowding, and which car sits at the elevator. Cars with fewer than 3 reports show as "not rated yet".
- **There is no field about people and no safety score**, by design (see the safety-rating trap in `Magic Carpet.md`). A test enforces this.
- **Help link**: every response carries the 311 website/phone and 911. It does not submit anything to 311.

## Run

```bash
cd verdict-layer
npm install
cp .env.example .env   # add ANTHROPIC_API_KEY (optional for the demo)
npm start              # http://localhost:3000
npm test
```

```bash
curl -X POST localhost:3000/ask -H 'content-type: application/json' \
  -d '{"stationId":"S59","direction":"uptown","question":"Can I get to the uptown platform without stairs?"}'
```

Endpoints: `POST /ask`, `GET /stations`, `GET /help`, `GET /health`.

## Data

`data/sample.json` is **illustrative sample data**; the IDs and numbers are made up. The response labels it as such in `verdict.evidence.sources`. To go live, replace `loadData()` in `src/server.js` with the MTA equipment and outage feeds (join on GTFS stop ID) and the outage-history poller, and keep the same shape. Per the MTA terms, show official values alongside our ratings and warn when the feed is more than a minute old (already handled by `mayNotBeCurrent`).
