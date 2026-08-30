# GISEC 2026 — DMATICS Arena

**How the three booth experiences became one show.**

DMATICS IT Solutions LLC · Hall 4, Dubai World Trade Centre

---

## What was built

Three projects existed. They did not know about each other.

| | Surface | What it was | What it is now |
|---|---|---|---|
| **Cyber Arcade** | iPad | Three 60-second games, own leaderboard | Also feeds the wall's globe and the shared board |
| **Red Team Challenge** | 2 laptops | Five-stage CTF, own SQLite leaderboard | Every action is a live detection on the wall; the SOC now fights back |
| **SOC Wall** | Big screen | Cinematic demo telemetry | Same globe, plus real booth activity and a live arena board |

One new service — the **Arena Hub** — sits between them. It is about 600 lines of dependency-free Node and it does four things: take in telemetry, normalise it into the wall's alert shape, keep one leaderboard, and fan events out over Server-Sent Events.

**The governing rule: the hub is never load-bearing.** Unplug it mid-show and three games keep running exactly as they did before. Only the shared board and the cross-screen theatre stop. Every integration point in this document was built that way on purpose, and it was tested with the hub killed and with the hub pointed at a black-hole address — worst-case request time went from 23 ms to 26 ms.

---

## The show, in one paragraph

A visitor sits at Laptop 02 and starts breaching *Aegis Vault Systems*. On the big screen, an arc lights up on the globe and the AEGIS AI panel says what it just saw. The visitor fumbles a password. The wall's operation card switches to their name, and a heat bar starts filling — the crowd can see how close they are to being caught before they can. They fumble another. The wall flashes **SOC RESPONSE — ADAPTIVE THROTTLE ENGAGED**, and *1.9 seconds later* the laptop screen is taken over: session held, twelve-second countdown, clock still running. People look at the big screen, then at the laptop, and understand what a SOC does without anyone explaining it. When the run ends, their name lands on the arena board next to the arcade players.

---

## Architecture

```
   iPad                    Laptop 01 / 02              Big screen
   Cyber Arcade            Red Team Challenge          SOC Wall
   (Next.js)               (Flask)                     (Vite)
       │                        │                          │
       │ scores + round starts  │ every action, every      │ SSE  /api/stream
       │ POST /api/scores       │ escalation               │  ├── alert
       │ POST /api/events       │ POST /api/events         │  ├── score
       │                        │ POST /api/scores         │  ├── station
       │                        │ POST /api/command        │  └── command
       └───────────┬────────────┴──────────┬───────────────┘
                   ▼                       ▲
            ┌──────────────────────────────────────┐
            │        ARENA HUB  :7788              │
            │  ingest · normalise · score · fan out│
            │  data/arena.json (atomic writes)     │
            └──────────────────────────────────────┘
                   │
                   └── SSE /api/command/stream?station=…
                       (operator-issued containment, wall → laptop)
```

### Why a separate service

The arcade's board lives on Vercel KV; the challenge's lives in SQLite; the wall queries Wazuh. Making any one of them the hub would have coupled the booth to that one deploy target and to internet access. A standalone process with no dependencies runs from a USB stick on any laptop with Node 18, offline, and each game keeps its own storage as a fallback.

### The alert contract

The hub emits alerts already shaped to `fetchAlerts()`'s return type. That is the whole trick: a failed password on Laptop 02 enters `alertStore.add()` and the globe, the origin list, the MITRE heatmap and the threat timeline pick it up with **zero** downstream changes. Arena-specific panels read an extra `gisec` block the hub attaches; nothing else looks at it.

### Where the attacks appear on the globe

The stations are physically forty metres from the wall, so a truthful arc would be a dot on Dubai. Instead each technique is plotted at the exit infrastructure a real operator would route it through — which is also exactly what a SOC sees in source-IP geolocation:

| Technique | Plotted origin | | Technique | Plotted origin |
|---|---|---|---|---|
| T1595 Scanning | Amsterdam | | T1068 Priv-esc | Pyongyang |
| T1110 Brute force | Moscow | | T1005 Local data | Singapore |
| T1078 Valid accounts | Bucharest | | T1041 Exfiltration | Beijing |
| T1039 Network share | Frankfurt | | T1531 Containment | Dubai |
| T1059 Shell | Hanoi | | T1204 Arcade | Dubai |

Long arcs converging on the Dubai perimeter — the shot the booth wants, and defensible if a visitor asks how it works.

---

## The SOC defence loop

This is the mechanic the brief asked for: *"if a password error or certain things get triggered, the SOC defence acts and interrupts the game."*

### Heat

Every noisy action raises a **heat** score on the session. Heat decays at 0.9 points per second, so a careful player who takes a minute per stage sheds more than the stage costs and never trips anything. A player who fumbles passwords or hammers the shell climbs.

| Action | Heat | | Action | Heat |
|---|---|---|---|---|
| Recon page | +6 | | SSH failure | +28 |
| Failed portal login | +20 | | Shell command | +7 |
| Successful login | +10 | | Flag captured | +12 |
| Share / file read | +14 | | Vault access | +40 |
| SSH success | +16 | | Sudo escalation | +70 |

### Three thresholds

| Heat | Response | What the player gets | What the wall shows |
|---|---|---|---|
| **34** | `MONITOR` | Amber advisory banner, keeps playing | Station turns amber, AI panel narrates |
| **62** | `THROTTLE` | Screen taken over, 12-second hold, **clock keeps running** | Red response band, heat bar spikes |
| **96** | `CONTAIN` | Run over, score banked | Containment band, station goes red |

The original hard rules are untouched: four bad portal logins, three bad SSH logins, or any `sudo` escalation still end a run instantly. The heat ladder adds the **middle tier** — the part a visitor can feel building, and the part a crowd can watch building.

### Why the throttle is the good one

A bust is binary and it ends the visit. A throttle costs twelve seconds of a ten-minute clock, teaches that detection has consequences short of game-over, and — critically — happens *while people are watching*. It is also the only response that can fire more than once in a run.

Two details that make it work rather than annoy:

- **A throttled attempt does not burn an attempt.** The SOC took the time instead. A player never loses a life to the mechanic.
- **Heat drops 26 points when a throttle fires.** Without that bleed-off, the next action re-trips it immediately and the run becomes a slideshow.

### The 1.9-second beat

`hubwatch.js` shows *"SOC IS RESPONDING"* for 1.9 seconds before the lockout lands. This is the single most important number in the build. Without it, the wall and the laptop fire together and the causal link between them is invisible. With it, the crowd sees the detection appear on the big screen, turns to look at the laptop, and *then* the takeover happens. Cause, then effect.

The same principle governs the event ordering server-side: a detection always reaches the wall **before** the escalation it triggered. Getting that backwards was a real bug found during testing, and it destroyed the effect completely.

### It is enforced, not just drawn

The overlay is theatre. The `throttled_until` timestamp in the Flask session is what means it: while a hold is active, `/portal/login`, `/console/auth` and `/console/exec` refuse outright. Closing the overlay or reloading gains nothing — which matters, because the crowd just watched the SOC act.

### It works with the hub off

Heat is computed in the game, in Flask, and the interruption is delivered in the HTTP reply to the action that caused it. The hub *mirrors* it to the wall. If the hub is down, the defence still works; only the big screen goes quiet.

---

## Trying it on one machine first

Before any of this goes near the show floor, `run-local.sh` brings the whole booth
up on a single laptop. No Docker, no npm build — `soc-wall-main/dist/` is committed
pre-built, so the rig needs only Node 18+ and Python 3.

```bash
cd ~/Downloads/Project
chmod +x run-local.sh simulate.sh
./run-local.sh
```

Two processes come up: the Arena Hub on `:7788` (also serving the wall and the
arcade) and the Red Team Challenge on `:8000`. The script checks its
prerequisites, creates a `.venv` and installs Flask the first time, waits for both
to actually answer, prints the URLs, and tears everything down on Ctrl-C. If a
service dies it says so and shows the last dozen log lines.

| | |
|---|---|
| SOC Wall | `http://127.0.0.1:7788/` |
| Laptop 01 | `http://127.0.0.1:8000/?station=LAPTOP-01` |
| Laptop 02 | `http://127.0.0.1:8000/?station=LAPTOP-02` |
| Arcade | `http://127.0.0.1:7788/arcade` |

The two laptop URLs need **separate cookies** to be separate operators — use two
different browsers, or one normal window and one private window.

### The simulator

`simulate.sh` plays a whole run against the real Flask routes — same session, same
heat engine a visitor hits — so you can watch the wall react without clicking
through five stages.

```bash
./simulate.sh            # noisy operator: throttled repeatedly, still finishes
./simulate.sh --clean    # careful operator at human pace: SOC never interrupts
./simulate.sh --bust     # four bad passwords, contained
./simulate.sh --arcade   # drop a morning's arcade scores on the board
```

It prints the heat and posture after every action, so the terminal and the wall
tell the same story side by side. Put the wall on one half of the screen and the
terminal on the other.

**Kali note.** The hub needs Node 18, which stock Kali has. Rebuilding the wall
needs Node 22.13+ for Vite 8, which stock Kali usually does not — that is why
`dist/` ships pre-built. You only need the newer Node if you change something
under `soc-wall-main/`, and `nvm install 22` is the easiest way to get it.

---

## Running it

### Startup order

Order does not actually matter — everything reconnects — but this is the least confusing sequence.

**1. Arena Hub** (the machine driving the big screen)

```bash
cd gisec-hub
node server.js                 # :7788
```

To have the hub also serve the wall and the arcade, so the booth runs one process:

```bash
cd soc-wall-main && npm install && npm run build
cd ../gisec-hub && node server.js
#   wall    → http://<hub>:7788/
#   arcade  → http://<hub>:7788/arcade
```

**2. SOC Wall** (big screen, Chrome fullscreen, F11)

Edit `dist/soc-config.js` — it is deliberately unbundled so it can be changed on the show floor with a text editor and a refresh, no rebuild:

```js
hub: { url: "", sameOrigin: true, port: 7788 }
```

Set `sameOrigin: true` when the hub serves the wall. Otherwise set `url` to the hub's LAN address. `?hub=http://10.0.0.5:7788` on the wall URL overrides everything — the fastest way to repoint the screen mid-show.

**3. Red Team Challenge** (both laptops)

```bash
cd DMATICS-Red-Team-Challenge-main
docker compose up -d --build
```

`HUB_URL` in `docker-compose.yml` must be the hub's **LAN address**, not `localhost` — this runs inside a container, where localhost is the container.

Then open each laptop once at its station URL, which is remembered in the session:

```
Laptop 1 → http://<host>:8000/?station=LAPTOP-01
Laptop 2 → http://<host>:8000/?station=LAPTOP-02
```

One container can serve both laptops. Two containers also works — set `STATION_ID` per container.

**4. Arcade** (iPad)

```
http://<hub>:7788/arcade?hub=http://<hub>:7788
```

The `hub` parameter is remembered in the tablet's local storage, so this is a once-per-device setup, not a daily one. Add to Home Screen for fullscreen. `?hub=off` takes a device off the wall.

Hosted on Vercel instead? Set `NEXT_PUBLIC_GISEC_HUB` and the address is baked into the deploy.

### Ports

| Service | Port |
|---|---|
| Arena Hub | 7788 |
| Red Team Challenge | 8000 |
| SOC Wall (dev) | 5173 |

All three laptops, the iPad and the screen must be on the same LAN. No internet is required for any of it.

---

## What changed in each project

Nothing was redesigned. The wall's grid geometry is byte-identical; the arcade and the challenge kept every existing code path.

### `gisec-hub/` — new

`server.js`, `package.json`. Zero dependencies. State in `data/arena.json`, written atomically.

### `soc-wall-main/`

| File | |
|---|---|
| `js/hub.js` | **new** — SSE client, own reconnect with backoff, snapshot handshake |
| `js/arena.js` | **new** — the leaderboard panel, auto-rotating across five boards |
| `js/response.js` | **new** — live operation card, response band, station posture |
| `public/soc-config.js` | **new** — unbundled booth config |
| `index.html` | infrastructure-health panel → arena panel; ids for live fields |
| `js/main.js` | hub wiring; arena and response surfaces |
| `js/ai.js` | `speak()` — a real detection interrupts the scripted assessment |
| `js/health.js` | no-ops when its list element is absent |
| `css/layout.css` | appended arena / heat-bar / response-band styles |

The **infrastructure health** panel was the one thing removed. It showed six invented services and was the least useful square metre on a stand. Its availability data is still polled and still drives the adapter-health state in the top bar — it just has nowhere to draw. Putting it back is a matter of restoring the markup; nothing else depends on the change.

### `DMATICS-Red-Team-Challenge-main/`

| File | |
|---|---|
| `hub.py` | **new** — queued, daemon-threaded, never blocks, never raises |
| `static/js/hubwatch.js` | **new** — heat meter, advisory, hold overlay, operator channel |
| `app.py` | heat engine, station identity, emitters, server-side hold enforcement |
| `templates/base.html` | heat meter in the nav, `hubwatch.js`, session globals |
| `templates/{brief,console,login}.html` | route SOC responses through `SOCDEF.apply()` |
| `static/css/style.css` | appended heat meter / advisory / hold-overlay styles |
| `docker-compose.yml` | hub address, station ids, defence tuning |

### `dmatics-cyber-arcade-main/`

| File | |
|---|---|
| `public/game.html` | `HUB` bridge (~40 lines); two call sites in `begin()` and `saveScore()` |
| `app/page.js` | forwards `?hub=` into the iframe, which cannot see the page's query string |

The localStorage board and the `/api/scores` server board are untouched and still authoritative for everything the arcade shows on screen. The hub is a third destination.

---

## The arena board

Five boards, rotating every nine seconds with a progress sweep: **OVERALL · PHISH · ALERTS · BREACH · RED OPS**. A wall has nobody standing at it to click tabs, and the rotation is what makes a visitor stop and wait for their own game to come round. Booth staff can still tap a tab to hold one for a full cycle. A score that lands jumps to that board and pulses the row once, so a player watching from the stand sees their own name arrive.

**The overall board is not a points total.** Red Team maxes at 100; Breach Point can pass 2,000. Summing them would make the arcade the only game that mattered. Each game is normalised to 1,000 points at that game's current top score — so being best-in-class counts the same everywhere, and playing more games beats grinding one. That is the right incentive for a stand: it moves people between the iPad and the laptops.

---

## Failure modes

| If this happens | What the visitor sees | Fix |
|---|---|---|
| Hub process dies | Games play normally; wall keeps ambient telemetry, board freezes | Restart it — the wall reconnects on its own, scores are on disk |
| Wall loses the hub | `ARENA LINKED` pill returns to `DEMO TELEMETRY LINKED` | Nothing; it retries with backoff |
| Wall restarted mid-day | Board and stations repopulate instantly from the hub snapshot | Nothing |
| Booth Wi-Fi blips | A telemetry event or two is dropped, never retried | Nothing — retrying would stall a player's request |
| A laptop can't reach the hub | That laptop plays fine, nothing appears on the wall | Check `HUB_URL` is the LAN address, not localhost |
| Both laptops show one station | Someone opened the second without `?station=LAPTOP-02` | Reopen with the parameter |
| Board fills with test scores | — | `POST /api/admin/reset {"token": "..."}` |

### Health checks

```bash
curl http://<hub>:7788/api/health      # clients, stations, event totals
curl http://<host>:8000/health         # includes hub emitter sent/failed/dropped
```

`sent` climbing and `failed` at zero means the laptop is reaching the hub.

---

## Change these before the show

| Where | What | Why |
|---|---|---|
| `DMATICS-Red-Team-Challenge-main/.env` | `SECRET_KEY` | Copy `.env.example`, run `openssl rand -hex 32`. Compose refuses to start without it |
| `docker-compose.yml` | `HUB_URL` | Currently a placeholder LAN address |
| Hub environment | `ADMIN_TOKEN` | Defaults to a value that is in this repository |
| Arcade | `ADMIN_PASSWORD` | Same — the fallback is in the repo |

---

## Tuning on the day

All in `docker-compose.yml`, no rebuild:

- **Queue is long, move people through** → `HEAT_DECAY=1.4`, `THROTTLE_SECONDS=8`
- **Quiet spell, want the drama** → `HEAT_THROTTLE=45`
- **A VIP demo you do not want interrupted** → `HEAT_THROTTLE=200`

The wall's ambient telemetry is `demo: true` in `soc-config.js`. Leave it on — booth activity arrives through the hub either way, and the ambient traffic is what keeps the globe alive between visitors.

---

## Show-day checklist

**Morning**

- [ ] Hub up, `/api/health` answers
- [ ] Wall fullscreen, pill reads **ARENA LINKED · 4 GAMES**
- [ ] Both laptops opened with their `?station=` parameter
- [ ] iPad opened with its `hub` parameter, added to Home Screen
- [ ] One test run per station — confirm it reaches the wall
- [ ] Clear the test scores
- [ ] Everything on mains, screens set to never sleep

**One rehearsal worth doing:** have someone deliberately fail three passwords on Laptop 02 while a colleague watches the wall. If they see the detection *before* the laptop locks, the show works. That is the whole thing.

**Close of day**

- [ ] Screenshot the overall board for the trophy
- [ ] `POST /api/admin/reset` for tomorrow
- [ ] `data/arena.json` is the day's record if you want it
