# ⚽ Team World Cup Predictor

A small internal web app for a team to predict 2026 FIFA World Cup match results, pick a tournament champion, and compete on a live leaderboard. Built for ~5–15 people. For fun only — no money.

## Run it

```bash
cd wc-predictor
node server.js
```

Then open **http://localhost:3000**. No build step, no `npm install` — zero dependencies, Node 18+.

Data persists to `data.json` (created on first run). Delete that file to reset everything.

## How it works

- **Join / Log in** — enter your name to join. Re-enter the same name later to log back into the same profile. Add an optional 4–8 digit PIN to keep your name yours.
- **Matches** — shows the next match day (every game on the soonest day that still has fixtures — often 2+). Pick *Team A win / Draw / Team B win*. **Betting closes 2 hours before kickoff** (configurable); change your pick freely until then. Polls every 60s. Flags shown for each team.
- **Schedule** — view-only list of all upcoming matches grouped by day, with flags. Predictions are made on the Matches tab.
- **Champion** — one-time pick of who wins the whole thing. Worth a big bonus. Locks at the tournament's first kickoff (configurable).
- **Leaderboard** — ranks everyone by total points, shows correct-prediction count and champion pick.
- **Picks** — see who picked what for each upcoming match (grouped by outcome) and every player's champion pick.

## Prediction mechanism

A prediction is one row per person per match (`a_win` / `draw` / `b_win`). Submitting again before the cutoff overwrites the previous pick. A pick is **locked** — the API rejects changes and the buttons disable — once either `now ≥ kickoff − lockLeadHours` (default 2h) or a result has been recorded. The champion pick is a separate one-per-person row that locks at the tournament's first kickoff (or on first submission, if configured).

## Where the data comes from

Out of the box the app ships with fixtures hard-coded in `fixtures.js` (the official FIFA 2026 draw, 6 Dec 2025) and seeded into `data.json` once. In **manual mode** that schedule is static and the PM edits matches/results from the terminal via `admin.js` (see Admin section).

## Live data via football-data.org (optional)

Switch to **API mode** to pull both fixtures and results automatically from [football-data.org](https://www.football-data.org) (free tier covers the FIFA World Cup, competition code `WC`).

**Get a key (free):**

1. Go to https://www.football-data.org/client/register and sign up with your email.
2. They email you an API token (a long string).

**Turn it on:**

- Easiest: start the server with the key in the environment —
  `FOOTBALL_DATA_API_KEY=your_token node server.js`
- Or store it via the CLI (see below).

Turn everything on in one command (server must be running):

```bash
node admin.js enable-api "your_token"
```

This stores the token, switches to API mode, enables auto-sync, and pulls the schedule + results immediately. From then on the server polls adaptively — every ~5 minutes when a match is live or just finished, every ~30 minutes otherwise (the free tier allows 10 requests/minute, so this stays well within limits). Results feed scoring automatically and the leaderboard updates.

Notes: free-tier scores are slightly delayed (not real-time), which is fine for this. When you first switch to API mode, leftover seeded fixtures that nobody has bet on are removed; if someone already bet on a fixture, that prediction is migrated onto the matching official match so no points are lost. The API key is stored server-side and never sent to browsers.

## Scoring

| Event | Points |
|---|---|
| Correct match outcome | 1 |
| Correct tournament champion | 10 (awarded once the winner is recorded) |
| Knockout match (if double-points flag is on) | 2 |

All configurable via the admin CLI.

## Admin — terminal only (the PM)

There is **no admin panel in the web app** (nothing sensitive is exposed in the browser). All admin actions run from the terminal via `admin.js`, while the server is running. Auth is the `ADMIN_KEY` env var (default `worldcup-admin`).

```bash
node admin.js status                         # config + leaderboard overview
node admin.js list [filter]                  # list matches with ids
node admin.js result <matchId> a_win|draw|b_win|clear
node admin.js teams <matchId> "Team A" "Team B"   # fill a knockout fixture
node admin.js winner "Spain"                 # record tournament winner (awards bonus)
node admin.js set knockoutDouble true        # toggle knockout double points
node admin.js set lockLeadHours 2            # hours before kickoff that betting closes
node admin.js set championLock first_submission
node admin.js sync                           # pull from football-data.org now
node admin.js enable-api "your_token"        # store token + API mode + auto-sync + sync
```

Use a custom key with `ADMIN_KEY=secret node admin.js ...` (and start the server with the same `ADMIN_KEY`).

## Seeded data

Real 2026 World Cup group compositions from the official draw (6 Dec 2025) — all 12 groups, 48 teams, 72 group-stage matches with real matchday-1 and matchday-3 dates. Knockout rounds (Round of 32 → Final) are seeded as `TBD` placeholders with dates; fill in teams via `node admin.js teams ...` (or let API mode populate them). Kickoff times are representative ET times and can be edited.

> Note: the group draw and dates are real; exact per-match kickoff times are approximate. Today is before the tournament starts, so the Matches screen will be empty until June 11 — set your champion pick in the meantime.

## Data model

- **Person**: `id`, `display_name` (unique), `joined_at`
- **Match**: `id`, `team_a`, `team_b`, `kickoff_time`, `stage` (group/knockout), `result` (a_win / draw / b_win / null)
- **Prediction**: `id`, `person_id`, `match_id`, `pick` — one per person per match
- **ChampionPick**: `id`, `person_id`, `team` — one per person

## Config / env

| Var | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | HTTP port |
| `ADMIN_KEY` | `worldcup-admin` | Admin access key (for `admin.js`) |
| `ACCESS_CODE` | _(none)_ | Shared team gate code; when set, players must enter it |
| `FOOTBALL_DATA_API_KEY` | _(none)_ | football-data.org token for live data |

## Private access gate (lock it behind a shared code)

So the app can live on a public domain but stay private to your team, set a single shared **access code**. Anyone reaching the site must enter it once before they can see or do anything; it's enforced server-side on every player API call (not just hidden in the UI).

```bash
node admin.js gate "TEAM2026"     # turn the gate ON with this code
node admin.js gate off            # turn it OFF
```

Or set it as an env var when starting the server: `ACCESS_CODE=TEAM2026 node server.js` (env always wins). Share the code only with your colleagues. Each person enters it once; their device remembers it. The code and signing secret are never sent to browsers. Per-person name (+optional PIN) login still applies on top.

## Deploy (host on a domain, shared for everyone)

Because all data lives in one server, hosting it once gives every colleague the same shared leaderboard. It's a single Node process serving its own static files — drop it on any small host (Render, Railway, Fly.io, or a small VPS) and point a domain at it. Two things to set there:

1. **Persistence** — host filesystems are often ephemeral, so attach a persistent volume/disk and keep `data.json` on it (or the data resets on redeploy). On a VPS this is automatic.
2. **Lock it** — set `ACCESS_CODE` (above) and a strong `ADMIN_KEY` as environment variables on the host.

Alternative without hosting a server: one teammate on the office network runs it and the rest open `http://<that-machine-ip>:3000` — the startup banner / `start.command` can show that address. Same shared data, zero cost, but only on the same network.

## Swapping the store

State lives in `data.json` via a tiny load/save layer in `server.js`. The shape mirrors the data model above, so moving to SQLite/Postgres later is a localized change in that layer.
