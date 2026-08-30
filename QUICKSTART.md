# Quickstart

Four commands. This is the whole thing on one machine, on Linux.

For Windows, the iPad, the big screen and everything that can go wrong, see
**[HOW-TO-RUN.md](HOW-TO-RUN.md)**.

---

## Once, ever

```bash
cd ~/Downloads/Project
./setup-env.sh
```

Creates the three `.env` files with secrets that agree with each other. It prints
an **admin username and password** at the end — that is what you type into the
arcade's CLEAR EVERY LEADERBOARD panel. Write it down.

The one thing this is really doing for you: `ADMIN_TOKEN` has to be the identical
string in three separate files. Get it wrong and everything looks fine until
someone presses reset at the end of day one and only part of the show clears.

```bash
./setup-env.sh --show      # see the configuration any time, secrets masked
./setup-env.sh --force     # start over (logs everyone out)
```

---

## Every time

**Terminal 1 — the hub, the wall and the arcade:**

```bash
cd ~/Downloads/Project
npm start
```

No `npm install`. The hub has zero dependencies and the wall is already built.
It reads `gisec-hub/.env` itself and prints every address the iPad can use:

```
   loaded 5 setting(s) from gisec-hub/.env

Open these:
   SOC wall    http://127.0.0.1:7788/
   Arcade      http://127.0.0.1:7788/arcade

From the iPad, phones and the other laptops:
   http://192.168.1.50:7788/  (wlan0)

ready — Ctrl-C to stop
```

**Terminal 2 — the red team challenge:**

```bash
cd ~/Downloads/Project        # the project root, not the subfolder
./run-redteam.sh
```

First run takes a minute. Kali, Debian 12+ and Ubuntu 23.04+ ship PEP 668, so a
plain `pip install` is refused with `externally-managed-environment` and tells
you to make a virtual environment. This script does exactly that — creates
`.venv`, installs into it, starts from it. Every run after the first goes
straight to:

```
Starting
  Python 3.11.15 · flask 3.0.3
  loaded 14 setting(s) from .env

  DMATICS Red Team Challenge  ->  http://0.0.0.0:8000
```

Two gunicorn workers boot when `SECRET_KEY` is set, one when it is not — and it
says which. `./run-redteam.sh --reinstall` rebuilds the environment if it ever
gets into a bad state.

> By hand, if you prefer: `cd DMATICS-Red-Team-Challenge-main && python3 -m venv
> .venv && .venv/bin/pip install -r requirements.txt && .venv/bin/python
> serve.py`. Bare `pip install` will be refused.

---

## Check it

```bash
cd ~/Downloads/Project        # check.sh lives in the project root
./check.sh
```

Five seconds, changes nothing, exits non-zero if something is wrong. It answers
the four questions that actually matter:

1. Are all four surfaces up?
2. Do they know about each other — is the red team pointed at the hub, is a wall
   connected?
3. **Will the reset button work?** It probes both endpoints without credentials
   and compares the token across the three files.
4. What is on the boards, and which LAN addresses actually answer.

Every failure line says what to do about it.

```bash
./check.sh --host 192.168.1.50    # check the booth from another laptop
```

---

## Rehearse

```bash
npm run simulate           # noisy operator: held twice, adapts, finishes
npm run simulate:clean     # careful operator: the SOC never touches them
npm run simulate:bust      # four bad passwords, gets contained
npm run simulate:arcade    # just drop arcade scores on the board
```

Watch the wall while one runs. `simulate:bust` is the one to show people — the
threat condition walks GUARDED → ELEVATED → SEVERE, the response band goes
advisory → throttle → contained, and the station turns red.

These check what the server actually replied to every step and **exit non-zero
with a red line** if anything did not land. A green run means a green run.

---

## Put the wall on the big screen

```bash
chromium --kiosk --autoplay-policy=no-user-gesture-required http://127.0.0.1:7788/
```

`--kiosk` buys back the ~90px the tab strip costs. The autoplay flag is what lets
the alert audio work from boot — browsers refuse to make a sound until a page has
been interacted with, and nobody interacts with a wall display.

Any resolution works. The wall is drawn at 1920×1080 and scaled to fit whatever
it is plugged into; there is nothing to configure.

---

## The iPad

Open the LAN address `npm start` printed, plus `/arcade`:

```
http://192.168.1.50:7788/arcade
```

Then **Share → Add to Home Screen** and launch from the icon for fullscreen, and
turn on **Guided Access** (Settings → Accessibility) so a visitor stays in the
arcade. Set the display to never sleep.

---

## Clear the boards at the end of the day

On the iPad: **Booth setup → ADMIN — CLEAR EVERY LEADERBOARD**, enter the
username and password `setup-env.sh` printed, confirm.

One button clears the arcade, the hub's arena board that the wall reads, and the
red team's station board. It names each one in the result, so if one could not be
reached you find out immediately rather than the next morning.

---

## Stop

`Ctrl-C` in each terminal. Both shut down cleanly and the hub flushes the
leaderboard to disk on the way out.

---

© DMATICS IT Solutions LLC. Built for GISEC 2026, Dubai.
