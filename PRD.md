# Magic Carpet — One-Night Build PRD

**RevenueCat × Pursuit build night · Oct 19, 2026**

Scoped from [Magic Carpet.md](Magic%20Carpet.md), which is a multi-quarter product plan. This document is the subset that ships tonight.

> **Assumption to fix before you start:** this ladder assumes **~150 minutes** of build time and a 3-minute pitch. If you have less, cut from the bottom of the ladder — the gates tell you what is load-bearing.

> **Before T+0, off the clock:** register at api.mta.info and get the outage-feed key, and create the RevenueCat project with Stripe test keys. Both are signup forms sitting on the critical path of a gate. Neither deserves build minutes.

---

## 1. The product, in one sentence

A mobile web page that answers one subway question with a **verdict instead of a dataset**: *can I get from the street to my platform without stairs, right now* — and when the answer is no, where to go instead.

The rider sees this:

> ## No
> **No step-free route to the downtown platform right now.**
> Elevator EL240 (street → mezzanine) is out.
> **Nearest step-free alternative: 14 St–6 Av, 4 min walk.**
> *As of 8:42pm · from MTA live outage feed · tap for evidence*

Not a status page. A judgment, with its receipts one tap away.

## 2. Why this is the right one-night cut

Phase 1 of the proposal is the only phase that needs **zero contributors**. It runs entirely on official data, which means no cold-start problem at 8pm with no users. Everything that requires field survey or crowd reports is out tonight by construction, not by compromise.

The proposal's own closing line is the other half of the argument: start the outage poller before anything else, because the event history cannot be backfilled. That makes the poller the first thing built tonight even though it has almost no history by pitch time — see §7 for why that is still the strongest beat in the demo.

## 3. Demo script — build toward this

Write the demo first and build backward to it. Three stations, chosen and rehearsed, plus the audience beat.

| Beat | What you show | Why it lands |
| --- | --- | --- |
| 1. The clean yes | A fully accessible station, direction-specific: **"Yes — step-free to the uptown platform."** | Establishes the verdict format in five seconds |
| 2. The real no | A station where an elevator is genuinely out right now, with the fallback station and walk time | This is the product. A live outage nobody staged |
| 3. "We don't know" | A station with partial or missing data, saying so plainly | The credibility move. Judges notice a product that admits gaps |
| 4. **Audience joins** | Put the URL on screen. Ask the room to look up their own home station | All 496 stations return something real, because they are seeded from official data. Nobody hits an empty state |
| 5. The moat | Show the append-only outage log with tonight's timestamps, and say how many rows it has | "The MTA publishes monthly averages seven weeks late. This started recording at 8pm; in 90 days it is the only per-outage event record that exists" |
| 6. The money | Free vs Pro, §6 | RevenueCat night. Non-negotiable |

Beat 4 is the one that maps to what the top-three projects at the benchmark event shared — the audience participates rather than watching. Beat 5 is what makes a one-night build sound like a company.

## 4. Data — verified live tonight

I queried every one of these at ~8:10pm on Oct 19, 2026. Counts are real, not from the proposal.

### Works right now, no API key

| Dataset | ID | What you take from it | Verified |
| --- | --- | --- | --- |
| MTA Subway Stations | `39hk-dx4f` | **496 stations**; `ada` (0/1/2), **`ada_northbound` / `ada_southbound`**, `ada_notes`, `gtfs_stop_id`, lat/lon, `daytime_routes`, `north_direction_label` / `south_direction_label` | ✅ |
| Subway Elevator & Escalator Asset Inventory | `94fv-bak7` | **482 elevators** (plus 277 escalators — filter on `elevator_or_escalator`); `equipment_code` (the ID the live feed uses), **`street_access`**, **`elevator_mezzanine_1_access`** / **`elevator_mezzanine_2_access`** / **`elevator_platform_access`**, `elevator_direction_serviced`, `alternative_route`, `notes`, `service_status_code`, `station_mrn` | ✅ |
| Subway Station Amenities | `6yjv-fk7g` | Monthly snapshots, latest **Sep 2026**. Distinct in latest month: **115 PUBLIC_RESTROOM**, 446 ELEVATOR, 3,076 HELP_POINT, 266 ADA_FARE_ACCESS_SYSTEM_ENTRANCE | ✅ |
| Elevator/escalator availability | `rc78-7x78` | **Per unit, monthly**, Jan 2015 → Aug 2026: `equipment_code`, total/scheduled/unscheduled outages, entrapments, AM/PM peak and 24 h availability. 416 elevators in the latest month | ✅ |
| Accessible platform availability | `thh2-syn7` | Monthly, **borough-level only**, through Aug 2026 | ✅ |

Example call that works with no key:

```bash
curl -s 'https://data.ny.gov/resource/39hk-dx4f.json?$select=stop_name,ada,ada_northbound,ada_southbound,gtfs_stop_id&$limit=5'
```

### The one gated dependency

**MTA live elevator/escalator outage feed** — `api.mta.info` returned **403** to me, so it needs a free account and key. The legacy open endpoint `web.mta.info/developers/data/nyct/nyct_ene.xml` is **404 — dead**. There is no live outage dataset on data.ny.gov; I searched.

This is the critical path. It is the only source of "right now," and the entire verdict depends on it. Hence Gate 1.

### Accessibility reality, from the live data

- **166** stations fully accessible (`ada=1`), **8** partial (`ada=2`), **322** not accessible — of **496**.
- Only **168 of 482 elevators have `street_access = YES`**. 308 are `NO`, and **6 are blank** — 168 + 308 is 476, not 482. Those 6 must route to **unknown**, never to "no."

That second number drives the verdict logic: a step-free trip needs a **working street elevator and a working platform elevator**, chained. One working elevator is not a step-free route.

Build the chain from the **structured columns, not from `notes`**: `street_access`, `elevator_mezzanine_1_access`, `elevator_mezzanine_2_access` and `elevator_platform_access` each describe one leg directly, and `elevator_direction_serviced` gives direction at the elevator rather than inferring it from the station record. Two cautions, both from sampling the live data tonight. The fields are **sparsely populated** — `EL748` carries neither a mezzanine nor a platform flag. And they can **contradict the notes** — `EL748` has `street_access = NO` while its notes read `MEZZANINE TO STREET`. So: structured fields first, `notes` as a tiebreak, and **"unknown" wired into the function from its first line** rather than bolted on once the sparse cases surface. `alternative_route` is also published per elevator and is worth reading before computing a fallback from geography.

## 5. Scope — in and out

### In tonight

1. Direction-aware step-free verdict (yes / no / unknown) for all 496 stations
2. Nearest step-free alternative when the answer is no, with walk time
3. Evidence on tap: which elevator, which feed, as-of timestamp
4. Amenity badges: restroom exists, help point, accessible fare gate — **existence, from official data**
5. The outage poller, append-only, running from T+0
6. RevenueCat free vs Pro paywall

### Out tonight, and why

| Cut | Why |
| --- | --- |
| Car and door guidance | No feed exists. Exit Strategy took two people fifteen years. Impossible tonight |
| Crowd reports and 1–5 ratings | Cold start. No users at 8pm, and moderation is unbuilt |
| Cleanliness / smell / noise | No current data. The Passenger Environment Survey stopped after 2019 |
| Routing and directions | Google already does this well. Not the wedge |
| Native app | The proposal already says no app at launch. A link beats an install for a trip someone is late for |
| **Any safety or "sketchiness" rating** | **Cut on principle — see §9. Keep this cut and be ready to defend it** |

Precision that matters for honesty in the demo: the amenities data tells you a **restroom exists**, not that it is **open and working**. Say "there is a restroom here" and never "the restroom works." The working-or-not question stays a crowd field, and crowd fields are out tonight.

## 6. Free vs Pro — the RevenueCat requirement

The proposal never addresses monetization; it leaves "civic or commercial?" explicitly open. Tonight that question has to be answered, because this is RevenueCat night and a paywall plus a money slide is the brief.

The split follows the cost structure, which is what makes it defensible rather than arbitrary: **everything that is a free read of public data is free. Everything that costs us to produce and accumulate is Pro.**

| | Free | Pro — $4.99/mo or $39/yr |
| --- | --- | --- |
| Live step-free verdict | ✅ Any station | ✅ |
| Nearest step-free alternative | ✅ | ✅ |
| Amenity badges | ✅ | ✅ |
| **Elevator reliability history** | — | ✅ Monthly per-unit baseline from `rc78-7x78` **plus** the event record the poller accumulates — real data tonight, not an empty log |
| **Saved routes** | — | ✅ |
| **Proactive alerts** when an elevator on a saved route goes down | — | ✅ Push, before you leave the house — on iOS this needs the page added to the home screen; say so if asked |
| **Offline station pack** | — | ✅ Works on a dead platform signal |

Pro is the thing the poller makes possible. That is the whole argument: the free tier is a public service on public data, and the paid tier is the dataset we built and the alerts only we can send.

### The money slide

Build it bottom-up and do not hand-wave a TAM:

- **The problem, verified:** 322 of 496 NYC subway stations have no step-free route at all. The MTA settlement commits to 95% accessibility by **2055** — three decades where routing around the gaps is the rider's problem.
- **Who pays:** accessibility-first riders — wheelchair and walker users, stroller parents, riders with luggage — for whom a broken elevator is a dead end, not an inconvenience. A $4.99 alert that prevents one stranding pays for itself.
- **Arithmetic:** pull current daily ridership from `ak4z-sape` (MTA Subway Station Monthly Ridership) so the number is cited, then state conversion honestly. At 0.1% of daily riders converting at $4.99/mo, show the MRR. Label the conversion rate as the assumption it is. **`ak4z-sape` is the one dataset cited here that I did not verify tonight — check it returns before T+130, not during the slide.**
- **Comp:** Exit Strategy NYC has sold static exit data as a paid app for fifteen years. Live accessibility data is worth more than static exit maps.
- **The moat, in one line:** the MTA publishes per-elevator availability only as a monthly average, running about seven weeks behind. Nobody publishes the event record underneath — when each outage started, how long it lasted, which hours it hit. Every day the poller runs that gap widens, and it cannot be backfilled by a competitor. **Do not say per-unit history is unpublished:** `rc78-7x78` is one query away and a judge may know it.

## 7. Build ladder

Two people in parallel from T+0. Gates are stops, not checkpoints to wave through.

| Window | Work | Owner |
| --- | --- | --- |
| **Before T+0** | **A:** register at api.mta.info and get the key. **B:** create the RevenueCat project and Stripe test keys. Signup forms are not build work | Both |
| **T+0 → T+15** | **A:** confirm the live outage feed returns data. **B:** poller skeleton writing an append-only log | Both, parallel |
| **🚧 Gate 1 (T+15)** | **Live feed working, or commit to Fallback A. Decide and move — do not dither here** | — |
| T+15 → T+45 | **A:** pull `39hk-dx4f` + `94fv-bak7` to local JSON, join on `station_mrn`, write the verdict function: station + direction → yes/no/**unknown** + reason + fallback station. **B:** page scaffold against a stubbed `verdict()` — picker or geolocate, big verdict, mobile-first, static-first | Both, parallel |
| T+45 → T+75 | **A:** amenity badges from `6yjv-fk7g`. **B:** wire the real verdict in — evidence on tap, as-of timestamp | Both, parallel |
| **🚧 Gate 2 (T+75)** | **A real verdict renders for a real station on a real phone. If not, cut amenities and paywall polish and finish this** | — |
| T+75 → T+105 | **A:** reliability view — seed it from `rc78-7x78` per-unit monthly so it shows real numbers, with the poller log layered on top — then pick and pre-cache the three demo stations. **B:** RevenueCat **Web Billing** paywall — free vs Pro | Both, parallel |
| **🚧 Gate 3 (T+105)** | **Paywall present and tappable. RevenueCat night — this is the brief, not a nice-to-have** | — |
| T+105 → T+130 | Rehearse §3. Screenshot every beat as backup, including beat 2 at the moment it is true | Both |
| T+130 → T+150 | Money slide. Run the pitch once out loud, on the clock | Both |

The poller keeps running the whole time. By pitch it holds perhaps two hours of log, which across 482 elevators may be a handful of state changes or none at all. That is fine, and it is the argument §2 points here for: **beat 5 is not a claim about tonight's data, it is a claim about the clock.** The log proves the recorder runs and the schema is right; the value is that the MTA publishes only monthly averages, seven weeks behind, so every event row after tonight is one a competitor starting tomorrow can never have. Show the rows you have, say how many there are, and say when it started. A thin log with an honest timestamp makes that point. A padded one destroys it.

## 8. Architecture for one night

Static-first, because this gets read underground on a weak signal.

- **Static station data** baked at build time. 496 stations and 482 elevators is a small JSON file, not a database.
- **Live outage state** fetched client-side with a short cache, degrading to last-known with a **visible timestamp** rather than a spinner. The MTA terms require telling users when realtime lag exceeds one minute.
- **The poller** — simplest thing that is genuinely append-only: a scheduled job on a 5-minute cron appending a row per state change. A GitHub Action committing to this repo gives you append-only by construction, with git history as the audit trail and zero infrastructure. Good enough tonight and the log is portable later.
- **Join everything on `gtfs_stop_id`**, per the proposal. The MTA's own datasets key on it.
- **Accessibility is a build constraint.** Semantic HTML, real focus states, the verdict as text and not only color. A product about subway accessibility that fails a screen reader has no claim on anyone's attention — and a judge may well check.

Licence constraints worth not tripping over: serve the data from your own origin rather than proxying the MTA's, never present official values as modified, and do not imply MTA endorsement.

## 9. Keep the safety field cut

The proposal dedicates a section to this and it is right. A crowdsourced "feels safe" score for NYC stations tracks the racial composition of surrounding neighborhoods more closely than anything that happens to riders. SketchFactor launched in New York in 2014 doing exactly that and was covered as an app for avoiding Black neighborhoods.

Tonight this costs nothing to honor, because every crowd field is already out. So the discipline is simply: **do not add a safety rating as a stretch goal at T+120 because the page looks sparse.**

If a judge asks why there is no safety rating, the answer is a strength: the field is an instrument for redlining, so it was designed out. Lighting, sightlines, help-point presence and wait times cover what a rider actually acts on — and help-point presence is already in `6yjv-fk7g` tonight.

Before any public launch, the correlation audit in the proposal is a real gate. Not tonight's job, but say so if asked rather than implying it is done.

## 10. Risks and fallbacks

| Risk | Likelihood tonight | Fallback |
| --- | --- | --- |
| **api.mta.info signup slow or key doesn't work** | **Medium — this is the real one, which is why signup moved before T+0** | **Fallback A:** use `service_status_code` from `94fv-bak7` (22 of 482 elevators not in service — 13 `RNOS`, 5 `INOS`, 4 `IFOS`). Know the cost before you take it: 13 of those 22 are **removed assets**, not outages, and this is a static asset register, so **the poller logs zero state changes and beat 5 has no live rows**. Label everything "last known status," and make beat 5 the log schema plus the clock argument rather than a live tail. Beat 2 weakens; beat 5 changes shape |
| Demo wifi dies | Medium | Pre-cache the three stations. Screenshot every beat. Rehearse the pitch so it survives with no laptop |
| Feed rate-limits mid-demo | Low | Cache aggressively; never call the feed live on stage from a cold cache |
| Verdict is wrong on stage | Low, high cost | Rehearse exactly three stations. Make "unknown" a real answer so an edge case degrades honestly instead of lying |
| Scope creep into car guidance or ratings | **High — this is the other real one** | The gates. Both features are explicitly out in §5 |
| **RevenueCat web integration overruns Gate 3** | Medium | Mobile web means **Web Billing**, not the native SDKs, and native Paywalls do not render on web. That is why the project and Stripe test keys are Before-T+0 work. If T+105 arrives with no checkout, ship the paywall screen wired to a RevenueCat offering and say plainly that billing is stubbed |
| **The beat-2 outage is repaired before you pitch** | Medium | Prefer an outage whose estimated return is past pitch time. Screenshot beat 2 the moment it is true, keep a second candidate station, and re-check at T+130 |
| API key ends up in the repo | Medium | Env var only. The repo is private but that is not the point — the team rule is env vars, and judges may look |

## 11. Corrections to the proposal, verified tonight

Worth fixing in `Magic Carpet.md` before anyone outside the team reads it. All four checked live against the APIs — including item 3, which corrects a claim this PRD itself got wrong at first.

1. **The accessibility figure is out of date.** The proposal says "126 of 472 subway stations are fully accessible, or 27%." Live `39hk-dx4f` gives **166 of 496 fully accessible (33%)**, plus 8 partial. Use the live number — it is both current and verifiable on stage.
2. **Restrooms, help points and accessible fare gates are now published.** The proposal lists these as "not published in usable form — crowd and survey," and its yes/no table sources the tap-reader question to "Survey." `6yjv-fk7g` now publishes all three as official data; what I verified is the latest monthly snapshot, **Sep 2026**. **This is a real unlock: three fields the proposal budgets as months of field survey are free tonight.** The caveat in §5 stands — existence, not working status.
3. **The moat claim needs narrowing — and this PRD got it wrong at first.** Per-unit history *is* published: `rc78-7x78` carries total, scheduled and unscheduled outages, entrapments, and AM/PM peak and 24 h availability per `equipment_code`, monthly, back to Jan 2015 — 416 elevators and 278 escalators in its latest month, Aug 2026. What is genuinely unpublished is the **event record**: outage starts, ends, durations, hours, and anything fresher than a release running about seven weeks behind. Two consequences. The moat is event granularity and freshness, not existence — pitch it that way, because the dataset is one query from any judge. And the Pro reliability view can ship **tonight** with real per-elevator numbers instead of an empty log, which makes it a stronger screen than planned.
4. **A lead on car guidance.** `6yjv-fk7g` carries **446 ELEVATOR records with individual lat/lon**. That is not car position, but it does tell you **which end of the platform** an elevator sits at — which is most of what a wheelchair user needs from beat 3 of the car question. Not tonight, but it is a cheaper path into the proposal's most expensive feature than a full field survey.

Also cosmetic, from the Markdown export: two diagrams are now placeholder text at lines 221 and 229, and the prose at lines 225 and 231 refers to boxes and gates the reader cannot see.

## 12. The one decision to make before T+0

The proposal asks three questions and recommends accessibility-first. **Take the recommendation and stop discussing it.** It is the right call, it is already argued, and tonight there is no time to relitigate it: the need is acute, the elevator-reliability moat points straight at it, and a product that works for a wheelchair user at 2am works for everyone else by construction.

The genuinely open question is the second one — civic or commercial — and tonight the paywall answers it de facto. Commercial, with a free tier that is a real public service. Note in the pitch that MTA commercial licensing is unresolved and you know it; that is a mature answer, not a hole.
