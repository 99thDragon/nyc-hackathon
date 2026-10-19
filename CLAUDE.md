# Context for Claude

This folder is hackathon prep, built in a Claude Code session on my desktop on 2026-10-19. Read this before helping me.

## About me
- I describe myself as usually non-technical. Explain step by step in plain English and define jargon.
- I play product owner / pitch / tester on teams. I prompt Claude Code to build.
- GitHub: 99thDragon. Portfolio: https://99thdragon.github.io/Portfolio/. LinkedIn: https://linkedin.com/in/ErasmoConcepcion

## The event
- **RevenueCat × Pursuit build night**, Mon Oct 19 2026, 6:30pm, Pursuit HQ. One evening.
- Mixed teams, pick a real NYC problem, build a working app with open data + public APIs, pitch to industry judges.
- Prize: Claude Code / Codex subscriptions. No sponsor "Best Use of X" prizes tonight.
- RevenueCat = subscriptions/paywalls for apps. Always include a free vs Pro tier and a money slide.

## Benchmark I want to hit
I attended the **Daytona HackSprint w/ Arize, NYC, Oct 16 2026** (gallery: https://daytona-hacksprint-nyc.devpost.com/project-gallery).
- 1st: Just Standup (phone-sensor punch game + NYC workout spots + AI room coach). 2nd: Relay (multi-agent storm relief with follow-up). 3rd: SIGNAL (NFC tag, then AI troubleshoots/escalates).
- My friend Eric Liu won the AWS prize with Tenant Advocate. I don't want to copy anyone's app; I want top-3 level.
- What the top 3 share: sense the real world, then several agents decide, act, and follow up until resolved; the audience joins the demo.

## Our idea
The team came up with a new idea on the night (none of the earlier prep ideas). Details to be added.

## Tools / credits I have (from the Daytona HackSprint)
Daytona sandboxes, Anchor Browser (cloud browser, live view), SurrealDB Agent Memory, Arize AX tracing, ElevenLabs voice, AWS lab (likely expired). Coupon codes are in my email. Never put them in code, slides or this repo.
Docs: https://www.daytona.io/docs/llms-full.txt · https://docs.anchorbrowser.io/integrations/sandboxes/daytona · https://surrealdb.com/docs/agent-memory/quickstarts/hosted

## NYC data (checked live 2026-10-19, no key needed)
- 311: `erm2-nwe9`, about a day behind. Heat complaints Oct 1-18: 8,106. One Brooklyn building: 83.
- HPD violations `wvxf-dwi5` · Restaurant inspections `43nn-pn8j` · Parking tickets `nc67-uf89` · DOT parking signs `nfid-uabd`
- Benefits & programs `kvhd-5fmu` · Evictions `6z8x-wfk4` · DOB permits `ipu4-2q9a` · After-hours variances `g76y-dcqj` · Film permits `tg4x-b46p`
- Citi Bike live: https://gbfs.citibikenyc.com/gbfs/gbfs.json · MTA needs a free key
- Crash data (`h9gi-nx95`) stops at 2026-06-11, too stale for live demos.

## Rules for building tonight
- Build new code on the night; don't reuse other people's projects.
- Secrets only in environment variables. Use claude-sonnet-5-5 for speed in app code.
- Browser agents stop before any final Submit; a human approves.
- Demo with team members' own data only (e.g. their own plate).
