# BRAIN.md — everything a fresh session needs to know

**DMATICS IT Solutions LLC · GISEC 2026, Dubai World Trade Centre**

This file exists so a new conversation can pick this project up cold. It is the
memory: what the thing is, every decision that was made and why, every bug that
was found and how it was reproduced, what is verified and what is not, and what
is still open.

If you are an assistant reading this at the start of a new chat: read this file
first, then [CODE-EXPLAINED.md](CODE-EXPLAINED.md) for the architecture and
[HOW-TO-RUN.md](HOW-TO-RUN.md) for operations. Do not re-derive what is written
here — it was expensive to learn.

Last updated: 23 August 2026.

---

## 1. Who and what

**Jeff (palamattomjeffrey@gmail.com), DMATICS IT Solutions LLC.** Building a
four-screen interactive stand for GISEC 2026, a security trade show in Dubai.

The show is one connected experience across four surfaces:

| Surface | Runs on | Port | What a visitor does |
|---|---|---|---|
| **Cyber Arcade** | an iPad | served by the hub, or its own Next.js | Three 60-second games |
| **Red Team Challenge** | two laptops | 8000 | A 10-minute, 5-stage CTF |
| **SOC Wall** | the big screen | served by the hub | Watches everything happen |
| **Arena Hub** | the machine driving the wall | 7788 | Ties the other three together |

**The load-bearing idea.** The SOC on the wall *detects the red team and
interrupts them*. The detection appears on the big screen roughly 1.9 seconds
before the containment lands on the laptop, so the interruption reads as
consequence rather than as a bug. Everything else serves that moment.

**The other load-bearing idea.** The hub is never required. Kill it and all three
games keep working on local fallbacks; only the shared view goes away. Do not
introduce a dependency that breaks this.

**Local paths.** Working copy in the cloud session: `/home/claude/gisec`.
Jeff's machine: `/home/jeff/Downloads/Project` (connected folder, mounted at
`$HOME/mnt/Project` for `device_bash`). That mount **cannot delete files** —
`mv` things into `_to_delete/` instead, and `tar -x` over it fails because tar
unlinks first; extract elsewhere and `cp` over (cp truncates in place).

---

## 2. What was asked for, in order

1. Make the SOC wall fit any display (it was cut off on his TV). **Done.**
2. Upload the whole project to GitHub as one project. **Prepared, not pushed** —
   `./push-to-github.sh` is ready and passes its own credential scan.
3. Stop the pages scrolling / content being cut off on phones and iPads. **Done.**
4. Make it deployable three ways: Vercel, Windows locally, Linux locally. **Done.**
5. Audit every file line by line; fix all vulnerabilities, bugs and
   misalignments. **Done — roughly 70 findings, all reproduced before fixing.**
6. A reset button that clears every leaderboard. **Done — the arcade's existing
   button now clears all three.**
7. A README covering Linux, Windows, iPad and the SOC wall. **Done —
   `HOW-TO-RUN.md`.**
8. Fix the red-team UI: sections cut off at the bottom, unreadable text, a more
   visible background, captured flags turning green. **Done.**
9. Audit the game logic in depth for inconsistencies. **Done — 13 findings, all
   fixed, 40-check regression suite added.**
10. One file explaining the whole codebase and where the leaderboards are stored.
    **Done — `CODE-EXPLAINED.md`.**
11. This file. **Done.**

**Jeff's stated constraints:** keep usage efficient, do not burn the whole
budget. No security prohibitions were ever stated — all the hardening below was
self-directed in response to request 5.

---

## 3. Decisions that must not be quietly reverted

Each of these is load-bearing. If a future change appears to contradict one,
check here first.

### The wall is drawn once at 1920×1080 and scaled

`soc-wall-main/js/fit.js` computes `--fit = min(w/1920, h/1080) × overscan` and
`.command-shell` is a fixed-size surface with `transform: scale(var(--fit))`.

**Why:** a layout that re-flows to the viewport moves the boxes but not the words
inside them, so on an untested screen the text walks out of its panels. Scaling a
finished surface removes the entire class of problem. Verified identical at ten
resolutions from 1024×768 to 4K, and in portrait. There are no viewport media
queries in `layout.css` any more — do not add one.

### Every sound is synthesised in the browser

`soc-wall-main/js/audio.js`. There is not one audio file in the repository:
nothing to lose off a USB stick, nothing that fails without internet. Six cues,
rate limited so a burst of eight detections is one sound. The ambient telemetry
is silent — every noise the stand makes was caused by a person standing in it.

### The hub address is only accepted if it is on the booth LAN

Both the wall (`js/hub.js: PRIVATE_HOST`, `safeHubUrl`) and the arcade
(`public/game.html: privateHost`, `usable`) accept only loopback, `10.x`,
`192.168.x`, `172.16–31.x`, `169.254.x`, `*.local`, or the host that served the
page.

**Why:** `?hub=` is a URL parameter, and the arcade *persisted* it to
localStorage. A QR code reading `…?hub=https://someone-elses-host` and one tap on
the iPad permanently redirected every player's name and score to a stranger, with
nothing on screen changing. The same parameter on the wall URL re-pointed the big
screen's entire data feed.

**The escape hatch** for a genuinely public hub is `hub.url` in
`soc-wall-main/dist/soc-config.js`, which is trusted because only someone at the
booth machine can edit it. A URL parameter is not. Do not add a second escape
hatch that a URL can reach.

### Typography is an enhancement, never a dependency

The three Google Fonts load with `media="print"` and are flipped to `all` from
`js/main.js` (not an inline `onload=`, because the CSP has no `unsafe-inline` for
script). Every stack in `theme.css` falls back to fonts already present on
Windows, macOS and Linux. Verified by loading the wall with the font host
blocked — it looks deliberate, not broken.

### The rehearsal tells the truth

`simulate.mjs` checks what the server actually replied to every step and exits
non-zero if a run did not land. It used to print five green ticks whatever
happened. A rehearsal that cannot fail is not a rehearsal.

### Both entry points load their own `.env`

`start.mjs` reads `gisec-hub/.env` and `serve.py` reads its own, before anything
touches `process.env` / `os.environ`. Neither project has a dotenv dependency, so
before this the operator had to remember `set -a; . ./.env; set +a` — and setting
a value, restarting, and watching nothing change reads as a broken feature rather
than an unloaded one. A real environment variable still wins in both.

### `soc-config.js` is served unbundled

Timezone, volume, hub address and overscan can be changed on the show floor with
a text editor and a refresh. No rebuild, no toolchain, no laptop with npm on it.
Do not let a bundler swallow this file.

---

## 4. The red-team game, as it now works

This is the part with the most subtlety. `app.py` is ~1200 lines and the mechanic
is the show.

### Stages

Five flags, 10/20/20/25/25 = 100 points. Two independent gates:

- **`STAGE_REQUIRES`** — page access and flag chaining. FLAG-*n* needs FLAG-*n−1*.
- **`PLAY_EVIDENCE`** — added during the logic audit. Each flag also requires the
  thing you must have *done* to have found it: read the directory, logged into
  the portal, read the credential file, got a shell, read the vault file.

**Why both:** the flag values are constants in the source and never change
between players. The chain alone was satisfied by pasting five known strings in
order — measured at 100 points, rank 1, "full clear", in 0.02 seconds, without
loading a single page, and with heat at 0 so the wall showed a full compromise
with a blank kill-chain. One visitor reading another's screen was enough to ruin
the day's headline artefact.

### Heat, holds and containment

Heat rises with noisy actions (`HEAT_COST`) and decays at `HEAT_DECAY` per second.
Posture is *derived*, never stored: `CLEAR → WATCHED (34) → THROTTLED (62) →
CONTAINED`.

**Three holds end the run.** `THROTTLE_LIMIT = 3`. Strikes expire: every
`THROTTLE_FORGIVE` seconds (90) of play without a hold takes one back, computed
read-side in `effective_strikes()` so the number visibly falls on the player's own
meter.

**Why this shape.** The original design relied on the heat floor pushing a
stubborn player over the containment line. It could not: the floor saturates at
0.85 × 62 = 52.7, and 52.7 plus the loudest single action (exfil, 40) is 92.7 —
under 96. Measured: thirty consecutive vault reads produced twenty-nine throttles
and no containment. The code delivered exactly the infinite slideshow its own
comment claimed to prevent. Counting holds is deterministic; hoping the
arithmetic gets there is not. Expiry was added because a run-long counter meant
one fumble in the first minute still counted against you at the finale.

**Hard rules unchanged:** 4 bad portal logins, 3 bad SSH logins, any `sudo` other
than `sudo -l`.

### The clock

`expire_if_over()` runs from `require_player`, so the run ends server-side
wherever the player is. Before this, `record_score()` was only reachable through
`/finish`, and the only thing that sent a live player there was a JS countdown on
one page — so running out of time in the SSH console, or simply walking away,
recorded nothing at all.

`elapsed()` is clamped to `[0, GAME_SECONDS]`. A booth laptop correcting its clock
could make `started_at` land in the future, producing a negative `seconds` that
the display clamped but `ORDER BY seconds ASC` did not — rank 1 ahead of every
honest hundred-pointer.

### The vault

`find` is charged as `shell_cmd` (7); only the `cat` is `exfil` (40), and it is
de-duplicated with `note_stage("exfil")`. Both used to cost 40 with no dedupe, so
two commands typed seconds apart put 80 heat on a 62 threshold and a *flawless*
run was throttled at the climax every single time.

A containment during the vault read returns `ok:false, busted:true` with no flag
in the output. It used to return `ok:true` with the crown jewel in `out`, so the
page played the flag-captured sound and printed the flag two seconds before the
containment overlay arrived.

### Regression suite

`DMATICS-Red-Team-Challenge-main/tests/test_game_logic.py` — 40 checks, no
pytest, runs in about a minute. **Read its header before editing it:** a test that
fires nine actions in under a second *will* be throttled, correctly. Tests of
normal play must use the `pace()` helper.

---

## 5. Findings history

Roughly 70 findings across two audit passes. Every one was reproduced before it
was fixed. The full narrative is in `runbook.html` section L. The ones worth
remembering:

### Would have broken the show

| Finding | Symptom at the stand |
|---|---|
| `run-local.sh` used undefined `$D` under `set -u` | The Linux launcher aborted at the line that prints the iPad's address |
| `static/img/dmatics-white.png` did not exist | Broken-image icon where the company logo goes, on every page of both laptops |
| Rehearsal never read a single reply | Five green ticks and "Full compromise" whatever the server said |
| Rehearsal waited on `throttle_left`; the app sends `throttleLeft` | The throttle mechanic it exists to demonstrate never ran |
| Threat badge could not reach `GUARDED` (baseline 14 > threshold 8) | The wall read ELEVATED from boot whether the stand was empty or not |
| Arcade board read the newest 200 rows | Day one's top score deleted on day two |
| `docker compose up -d` survived Ctrl-C | Yesterday's container still on :8000 the next morning |
| Shutdown wrote `arena.json` non-atomically | On Windows, `taskkill /F` mid-write leaves a zero-length file — the whole show's leaderboard |
| SIGHUP unhandled | Closing the console window skipped every flush and cleanup |
| `persist()` sat after a `return` in `ingestEvent()` | Never executed once; red-team-only activity was never written to disk |
| Reset button did not fan out when the hub served the arcade | The booth's actual configuration — the button answered `bad token` and cleared nothing |

### Security

| Finding | Fix |
|---|---|
| `?hub=` accepted any host, arcade persisted it | Booth-LAN allowlist on both surfaces (17 cases tested) |
| No security headers anywhere | CSP shaped per surface, plus nosniff / Referrer-Policy / X-Frame-Options / Permissions-Policy |
| Unauthenticated score POST, ceiling 100 000 | Ceiling 20 000 with a per-device write budget (30/min) |
| Admin compare returned early on length | Both sides SHA-256'd, then `timingSafeEqual` |
| `COPY . .` baked the real `SECRET_KEY` into an image layer | `.dockerignore` |
| `HUB_PORT` from the environment reached `eval` under sudo | Ports validated as integers first |
| Credential scanner skipped `.mjs`, `.cmd`, `.ts` and all history | Scans everything plus every commit |
| Windows `/files/..\app.py` charged heat before being refused | Guard uses the same `safe_join` that serves the file |
| `/api/command` completely ungated | Same-origin check plus `ADMIN_TOKEN` |
| XSS via hub-sourced values on the wall | One shared escaper, `js/escape.js`, imported everywhere |

### Windows-only (reviewed, not executed — no Windows here)

`docker.cmd` (docker is `.exe`), container-only `DB_PATH` writing to
`C:\app\data`, a `→` character crashing a redirected log, `taskkill /F` racing the
hub's flush, readline stealing stdin during the build, `start ""` losing its
placeholder under `shell:true`, `run-local.cmd` always exiting 0, NTFS alternate
data streams defeating the MIME lookup.

---

## 6. Current state

### Verified working

- **Ten resolutions** 1024×768 → 4K, both portraits: correct scale factor,
  surface inside the viewport, no page overflow, no clipped text.
- **All four rehearsal presets** against a live hub and challenge: clean
  finishes, noisy is held twice and recovers, bust reaches containment, arcade
  fills the boards.
- **The full show** with a browser watching the wall: GUARDED → ELEVATED →
  SEVERE, the response band walking advisory → throttle → contained, the station
  going red, the run landing on the RED OPS board.
- **The arcade in a browser** — a complete 60-second round under the new CSP with
  no console errors.
- **The global reset** in both deployments, including the honest partial-failure
  path.
- **40/40** game-logic regression checks.
- **Both builds** clean: `vite build` and `next build`.
- **Two gunicorn workers** sharing a session across twelve requests with a key
  set; exactly one worker without.

### Not verified

- **Windows.** No Windows machine available. Every Windows branch was read line
  by line and eleven defects fixed, but nothing was executed.
- **Docker.** Not usable in this sandbox. The Dockerfile changes (`--preload`,
  `HEALTHCHECK`, `.dockerignore`) are reasoned, not run. **A non-root container
  user was deliberately NOT added** because the bind mount's ownership could not
  be tested and breaking it on show day is worse than running as root.
- **Vercel.** Builds verified locally; not deployed.
- **A real iPad.** Tested at iPad viewports in Chromium.

### Open items for Jeff

1. Set `SECRET_KEY`, `ADMIN_TOKEN`, `ADMIN_USER` / `ADMIN_PASSWORD`, and — for the
   reset button — `REDTEAM_URL` and `GISEC_HUB`. **`ADMIN_TOKEN` must be the same
   value on the hub, the challenge and the arcade.**
2. Run `./push-to-github.sh` when he wants the repo up.
3. Delete `_to_delete/` and the `_backup-*` folder in his Project directory.
4. Read `HOW-TO-RUN.md` section 9 before the doors open.

---

## 7. Traps for a future session

Things that cost time here and will cost it again.

**`pgrep -f X | xargs kill` kills your own shell** when the command line contains
`X`. Same for `pkill -f`. Use a Python `ps` walk, or split the pattern
(`pkill -f "guni""corn"`).

**A backgrounded process dies when its parent bash call times out.** Use
`setsid … < /dev/null &`.

**Playwright `wait_until="networkidle"` never fires on these pages** — the SSE
stream stays open. Use `domcontentloaded` plus an explicit wait.

**Headless Chromium may report `prefers-reduced-motion: reduce`.** This is how the
static-background bug was found; pass `reduced_motion=` explicitly when testing.

**Geometry probes must ignore clipped ancestors and `text-overflow: ellipsis`.**
The first resolution battery reported ten failures, all of them the scrolling
ticker doing exactly what a marquee does.

**The artifact host is blocked in this environment.** `Artifact` publishes fail
with a network error, so the run book cannot be republished from here — deliver
`runbook.html` as a file instead.

**Kali refuses system-wide pip (PEP 668).** `pip install -r requirements.txt`
errors with `externally-managed-environment`. `./run-redteam.sh` handles it; do
not tell him to run bare pip, and do not suggest `--break-system-packages` on a
machine he uses for work.

**Node 22.13+ warns on `url.parse()`** with DEP0169, which says CVEs are not
issued for its vulnerabilities. The hub uses the WHATWG `URL` constructor now —
that warning on a security company's booth console is bad optics.

**Jeff's mount cannot delete.** `rm` fails. `tar -x` over it fails because tar
unlinks first. Extract to `$HOME/unpack` and `cp` over.

---

## 8. File map

Beyond the four project directories:

| File | What it is |
|---|---|
| `BRAIN.md` | this file |
| `CODE-EXPLAINED.md` | every file, how they interconnect, where each leaderboard lives (1300 lines) |
| `HOW-TO-RUN.md` | Linux / Windows / iPad / big screen, step by step (740 lines) |
| `README.md` | the short front door |
| `DEPLOY.md` | the three deployment targets and their honest caveats |
| `runbook.html` | the show-day artefact — architecture, defence loop, checklist, audit (section L) |
| `GISEC-2026-INTEGRATION.md` | the original integration design note |
| `QUICKSTART.md` | four commands, the whole thing on one machine |
| `setup-env.sh` | writes the three `.env` files with a matching `ADMIN_TOKEN`; `--show` audits, `--force` regenerates |
| `run-redteam.sh` | starts the challenge, creating `.venv` on first run — Kali/Debian 12+ refuse system-wide pip (PEP 668) |
| `check.sh` | five-second booth health check — surfaces up, wired together, reset button viable, LAN addresses reachable. Exits non-zero on a problem |
| `start.mjs` | the cross-platform launcher — this is the one that runs everywhere. Loads `gisec-hub/.env` itself |
| `simulate.mjs` | the rehearsal, four presets |
| `run-local.sh`, `simulate.sh`, `network-check.sh` | the Linux comfort path; `network-check.sh --fix` knows firewalld, ufw, nftables and iptables |
| `run-local.cmd` | the Windows double-click entry point; a thin wrapper over `start.mjs` |
| `push-to-github.sh` | scans the tree, unignored `.env` files and all history before pushing |
| `DMATICS-Red-Team-Challenge-main/tests/test_game_logic.py` | 40 game-logic checks |

Published artifacts (may need re-publishing from a session where the artifact
host is reachable):

- Run book — `https://claude.ai/code/artifact/bb156255-748e-4416-8a14-64c153b0e0de`
- Sound check — `https://claude.ai/code/artifact/aa0b2f21-c9fd-41e6-b82d-be48a10a986f`

---

© DMATICS IT Solutions LLC. Built for GISEC 2026, Dubai.
