# GISEC 2026 — DMATICS Cyber Arena

Four screens at a trade-show stand, wired into one show.

A visitor plays a 60-second game on an iPad. Two others try to break into a
staff portal on laptops. Everything any of them does appears on a wall-sized SOC
display within a second or two — their score on the leaderboard, their attack as
an arc across a globe, their name on the incident feed. And when the red team
pushes too hard, the SOC on the wall notices, announces it, and cuts them off
mid-run.

That last part is the whole point. **The detection is visible on the big screen
before the containment lands on the laptop**, so the interruption reads as
consequence rather than as a bug.

---

## The four surfaces

| | What it is | Runs on | Port |
|---|---|---|---|
| **`gisec-hub/`** | The service everything else talks to. Zero npm dependencies — `node:http` and `node:fs` only. | The machine driving the wall | `7788` |
| **`soc-wall-main/`** | The SOC wall. Globe, live incident feed, five leaderboards, synthesised alert audio. | Big screen, Chrome kiosk | served by the hub |
| **`DMATICS-Red-Team-Challenge-main/`** | The red team challenge, with the heat/containment engine that decides when a player gets caught. | Two laptops, Docker | `8000` |
| **`dmatics-cyber-arcade-main/`** | Three 60-second games. | iPad | served by the hub, or Vercel |

The hub is deliberately **not load-bearing**. Kill it and every surface keeps
working on its own local fallbacks — the arcade keeps its board in
`localStorage`, the challenge keeps running, the wall keeps its ambient
telemetry. Only the shared view goes away.

---

## Running it

Node 18 or newer, and nothing else. The same two commands on **Windows, Linux
and macOS**:

```bash
./setup-env.sh          # once, ever — writes the three .env files with matching secrets
npm start               # hub + wall, prints every LAN address the iPad can use
./check.sh              # is the booth working? five seconds, changes nothing
npm run simulate        # rehearse a booth run without a visitor
```

On Windows you can also just double-click **`run-local.cmd`**.

```bash
npm start -- --build    # rebuild the wall first
npm start -- --redteam  # also bring up the challenge (Docker)
npm start -- --port 8080
```

The Red Team Challenge runs with `./run-redteam.sh`, which creates a Python
virtual environment on first use — Kali and Debian 12+ refuse system-wide `pip`
installs — and then starts `serve.py`, which picks waitress on Windows and
gunicorn elsewhere. gunicorn cannot run on Windows at all. Docker works too.

**[DEPLOY.md](DEPLOY.md)** covers Vercel, including the two pieces that should
not go there and why.

The wall wants two Chrome flags:

```bash
chromium --kiosk --autoplay-policy=no-user-gesture-required http://<hub>:7788/
```

`--kiosk` buys back the ~90px of height the tab strip costs. The autoplay flag is
what lets the alert audio work from boot — browsers refuse to make a sound until
a page has been interacted with, and nobody interacts with a wall display.

### The other documents

| | |
|---|---|
| **[QUICKSTART.md](QUICKSTART.md)** | Four commands. Start here. |
| **[HOW-TO-RUN.md](HOW-TO-RUN.md)** | Step by step on Linux, on Windows, on the iPad, and getting the wall onto the big screen. The one to have open at 08:30. |
| **[CODE-EXPLAINED.md](CODE-EXPLAINED.md)** | Every file, how the four surfaces interconnect, and exactly where each of the three leaderboards is stored. |
| **[BRAIN.md](BRAIN.md)** | The project's memory — every decision and why, every bug found and how, what is verified and what is not. |
| **[DEPLOY.md](DEPLOY.md)** | The three deployment targets, and the two pieces that should not go on Vercel. |

**[The run book](runbook.html)** has the rest: architecture, the defence loop,
booth settings, the show-day checklist, and what to do when something breaks at
09:40 on day one.

---

## Configuration

`./setup-env.sh` writes all three `.env` files for you, with secrets that agree
with each other — which matters, because `ADMIN_TOKEN` has to be the identical
string in three separate places or the CLEAR EVERY LEADERBOARD button clears only
part of the show. `./setup-env.sh --show` checks it later; `./check.sh` checks it
against the running services.

Nothing has a default password. Every admin endpoint refuses to run until one is
set, which is the correct behaviour for an endpoint that wipes a leaderboard.

`push-to-github.sh` scans the working tree, any unignored `.env`, **and every
commit already in history** before it will push, and refuses on a hit.

```bash
cp DMATICS-Red-Team-Challenge-main/.env.example DMATICS-Red-Team-Challenge-main/.env
cp gisec-hub/.env.example gisec-hub/.env
cp dmatics-cyber-arcade-main/.env.example dmatics-cyber-arcade-main/.env.local
openssl rand -hex 32     # SECRET_KEY
openssl rand -hex 24     # ADMIN_TOKEN
```

The wall's own booth settings live in `soc-wall-main/dist/soc-config.js`, which
is served verbatim and **not** bundled — so the timezone, the volume, the hub
address and the overscan can all be changed on the show floor with a text editor
and a refresh. No rebuild, no toolchain, no laptop with npm on it.

---

## A few decisions worth knowing about

**The wall is drawn once at 1920×1080 and scaled to whatever it is plugged
into.** A layout that re-flows to the viewport moves the boxes but not the words
inside them, so on an untested screen the text walks out of its panels. Scaling
the finished surface removes the whole class of problem — verified identical at
ten resolutions from 1024×768 to 4K, and in portrait.

**Every sound is synthesised in the browser.** There is not one audio file in
this repository: nothing to lose off a USB stick, nothing that fails without
internet. Six cues, rate limited so a burst of eight detections is one sound.
The ambient telemetry is silent — every noise the stand makes was caused by a
person standing in it.

**The 1.9-second beat.** The gap between the wall announcing a detection and the
laptop being cut off is deliberate and load-bearing. Remove it and the show stops
making sense.

**Nothing on the wall names a third-party product.** The four feeds are called
what they do: `SENSORS`, `TICKETS`, `INTEL`, `NETWORK`.

**Typography is an enhancement, never a dependency.** The three webfonts load
non-blocking; every stack falls back to fonts already on a Windows, macOS or
Linux machine. Verified by loading the wall with the font host blocked — it looks
deliberate, not broken.

**A hub address is only accepted if it is on the booth LAN.** `?hub=` is a URL
parameter, and it used to be the origin of everything the wall and the arcade
displayed and reported. See [DEPLOY.md](DEPLOY.md) for the one place a public hub
can still be named.

**The rehearsal tells the truth.** `npm run simulate` checks what the server
actually replied to every step and exits non-zero if the run did not land. It
used to print five green ticks whatever happened, which is the opposite of what a
rehearsal is for.

---

© DMATICS IT Solutions LLC. Built for GISEC 2026, Dubai.
