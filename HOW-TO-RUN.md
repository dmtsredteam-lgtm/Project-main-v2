# How to run the DMATICS Cyber Arena

DMATICS IT Solutions LLC · GISEC 2026, Dubai. This is the practical step-by-step that [README.md](README.md)
and [DEPLOY.md](DEPLOY.md) point to. It assumes you are competent, that you have
never run this project before, and that it is 08:30.

If you have twenty minutes, read sections 1, 3 (or 4), 6 and 7. Section 9 is the
one to keep open during the show.

---

## 1. What you are setting up

Four screens and one small service. The **Arena Hub** is a LAN web server with no
npm dependencies. It serves the **SOC wall** at `/` and the **arcade** at
`/arcade`, and it is the thing everything else reports to. Two laptops run the
**Red Team Challenge**, a Flask app, and an iPad runs the arcade. A visitor's
arcade score and a red team operator's flag both land on the hub within a second
or two, and the hub pushes them to the wall over Server-Sent Events. The hub is
deliberately not load-bearing: kill it and every surface keeps working on its own
local fallbacks — only the shared view goes away.

| Surface | Machine | Port | URL |
|---|---|---|---|
| Arena Hub | the wall machine | `7788` | `http://<hub>:7788/api/health` |
| SOC wall | big screen, Chrome kiosk | served by the hub | `http://<hub>:7788/` |
| Cyber Arcade | iPad | served by the hub, or its own Next.js server | `http://<hub>:7788/arcade` |
| Red Team Challenge | two laptops | `8000` | `http://<laptop>:8000/?station=LAPTOP-01` |

All of it works with **no internet**. It only needs the devices to see each other.
Do not rely on venue Wi-Fi — bring a travel router or use a phone hotspot with the
hub machine, the iPad, the screen and both laptops joined to it.

---

## 2. Before the show

One-time preparation, best done the night before with internet available.

### Node

Node 18 or newer, from <https://nodejs.org>. Nothing else is needed for the hub
and the wall.

```bash
node --version
# expect v18.x or higher. The launcher refuses to start below 18.
```

Building the wall from source wants something newer (Vite 8 wants Node 22.13+),
but `soc-wall-main/dist` is committed pre-built, so you do not need that at the
stand.

### The three .env files

Nothing in this project has a default password. Every admin endpoint refuses to
run until it is configured, which is the correct behaviour for an endpoint that
wipes a leaderboard.

```bash
cp DMATICS-Red-Team-Challenge-main/.env.example DMATICS-Red-Team-Challenge-main/.env
cp gisec-hub/.env.example                        gisec-hub/.env
cp dmatics-cyber-arcade-main/.env.example        dmatics-cyber-arcade-main/.env.local
# three files, none of them committed — .gitignore keeps them out
```

### Generating the secrets

```bash
openssl rand -hex 32     # SECRET_KEY   — the Flask session key
openssl rand -hex 24     # ADMIN_TOKEN  — the reset token, shared by three services
```

On Windows, or anywhere without OpenSSL:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# 64 hex characters. Use randomBytes(24) for the ADMIN_TOKEN.
```

### What goes where

| Variable | File | Why |
|---|---|---|
| `SECRET_KEY` | red team `.env` | Signs the Flask session. Run state lives in the cookie, so two workers with different keys log players out at random. |
| `ADMIN_TOKEN` | hub `.env`, red team `.env` (as `HUB_TOKEN` too), arcade `.env.local` | The reset token. **Must be identical in all three.** |
| `HUB_URL` | red team `.env` | The hub's **LAN** address, e.g. `http://192.168.1.50:7788`. Not `localhost` — under Docker that is the container. |
| `ADMIN_USER`, `ADMIN_PASSWORD` | arcade `.env.local` | The login on the arcade's CLEAR LEADERBOARDS panel. Unset, that endpoint refuses every request. |
| `GISEC_HUB` | arcade `.env.local` | Where the reset button sends the hub's clear. |
| `REDTEAM_URL` | arcade `.env.local` | Where the reset button sends the red team's clear, e.g. `http://192.168.1.51:8000`. |
| `NEXT_PUBLIC_GISEC_HUB` | arcade `.env.local` | Bakes the hub address into the arcade so tablets do not need `?hub=` on the URL. |

**Why ADMIN_TOKEN must be the same on all three.** The arcade has one
`CLEAR EVERY LEADERBOARD` button. Pressing it clears the arcade's own board, then
fans out to the hub's arena board (`POST /api/admin/reset` with `{"token": …}`)
and the red team's SQLite (`POST /admin/reset` with an `X-Admin-Token` header) —
using that one token for both. A mismatch on any of them gives `bad token` for
that surface and the button reports it, honestly, as not cleared.

**And GISEC_HUB / REDTEAM_URL must be set**, or the fan-out has nowhere to go. It
does not guess. With them unset the button reports `GISEC_HUB is not set` and
`REDTEAM_URL is not set` per surface — verified.

### One honest caveat about .env files

**Nothing auto-loads `gisec-hub/.env` or the red team's `.env` when you run them
directly.** The hub reads `process.env.ADMIN_TOKEN`; there is no dotenv anywhere
in it. Those files are templates for values you put into the environment. Only
three things read them on their own: `docker compose` (which refuses to start
without `SECRET_KEY`), `run-local.sh` (which greps `SECRET_KEY` out of the red
team `.env`), and Next.js (which reads `.env.local`). For `npm start`, export the
values into the shell first — see the next section.

---

## 3. Running on Linux

### Bring up the hub and the wall

```bash
cd /path/to/gisec
set -a; . ./gisec-hub/.env; set +a    # put ADMIN_TOKEN into the environment
npm start
```

You should see this, and then nothing until you press Ctrl-C:

```
== Starting the Arena Hub
GISEC Arena Hub listening on http://0.0.0.0:7788

Open these:
   SOC wall    http://127.0.0.1:7788/
   Arcade      http://127.0.0.1:7788/arcade

From the iPad, phones and the other laptops:
   http://192.168.1.50:7788/  (wlan0)

ready — Ctrl-C to stop
```

Write down the LAN address it prints. Wireless interfaces are listed first,
because that is the one the tablets need.

Confirm it is genuinely up:

```bash
curl -s http://127.0.0.1:7788/api/health
# {"ok":true,"service":"gisec-arena-hub","event":"GISEC 2026","uptimeSeconds":5503,
#  "wallClients":0,"stations":{},"totals":{...}}
```

`wallClients` is the number of big screens currently attached. It should become
`1` once the wall is open — that is the fastest way to tell the wall is really
connected rather than merely displaying.

### The launcher's flags

| Flag | What it does |
|---|---|
| *(none)* | Hub plus wall. Builds the wall first if `dist/index.html` is missing. |
| `--build` | Force a rebuild of the wall before starting. Needs internet on a first run. |
| `--redteam` | Also bring up the challenge with `docker compose up -d --build`. |
| `--port 8080` | Serve on a different port. Rejects a non-numeric value rather than binding a random one. |
| `--no-open` | Do not open a browser window. Use this on the wall machine. |
| `--help` | Prints the list above. |

Through npm, flags need the `--` separator:

```bash
npm start -- --redteam --no-open
# npm run booth is a shorthand for: node start.mjs --redteam
```

On Ctrl-C the launcher stops the hub, and if `--redteam` brought Docker up it runs
`docker compose down` as well — so the container does not hold port 8000 and
yesterday's database into the next morning.

### The Red Team Challenge — Docker

Read from `docker-compose.yml`. It sets `DB_PATH=/app/data/leaderboard.db`,
mounts `./data`, and refuses to start without `SECRET_KEY`.

```bash
cd DMATICS-Red-Team-Challenge-main
docker compose up -d --build
# then: docker compose ps   — the container is "healthy" once the app answers
```

The image carries a `HEALTHCHECK` that queries `/health` rather than checking the
process exists, so a wedged worker shows as unhealthy.

### The Red Team Challenge — native

This is the path that also makes Windows work, and it is one less moving part at
a stand.

```bash
cd DMATICS-Red-Team-Challenge-main
pip install -r requirements.txt
# gunicorn installs on Linux/macOS, waitress on Windows — the requirements file
# marks each with its platform.
```

```bash
export SECRET_KEY=<the value from .env>
export ADMIN_TOKEN=<the same token as the hub>
export HUB_URL=http://192.168.1.50:7788
python serve.py
#   DMATICS Red Team Challenge  ->  http://0.0.0.0:8000
#   station URLs: ?station=LAPTOP-01  /  ?station=LAPTOP-02
```

`serve.py` picks **gunicorn** on Linux and macOS, **waitress** on Windows. It runs
two workers when `SECRET_KEY` is set and drops to one when it is not — because
without a shared key each worker invents its own, rejects the other's cookies, and
a player is logged out mid-run. That is a guard rail, not a substitute. Set the key.

```bash
curl -s http://127.0.0.1:8000/health
# {"event":"GISEC 2026","hub":{"configured":true,"dropped":0,"failed":0,"sent":59,
#  "url":"http://192.168.1.50:7788"},"station":"LAPTOP-01","status":"ok"}
```

`hub.configured` must be `true` and `hub.failed` must stay low. If `sent` climbs
and `failed` climbs with it, the laptop can see the hub's address but is not
getting through — go to section 9.

### The Linux comfort path

`run-local.sh` brings up the hub **and** the red team on one machine, with no
Docker and no npm build. It uses the Python venv at `.venv` and runs the red
team's built-in Flask server, which is fine for a rehearsal rig and for a
two-laptop booth. Logs land in `./logs/`.

```bash
./run-local.sh            # start both, print every address, show a QR code
./run-local.sh --open     # start, then open the browser tabs
./run-local.sh --reset    # wipe local scores first
./run-local.sh --stop     # stop anything left running
LAN_IP=10.0.0.5 ./run-local.sh    # pin the address on a multi-homed box
```

### When another device cannot reach you

```bash
./network-check.sh
```

Run it while the hub is up. It answers exactly one question — can a phone, an iPad
or the big screen open the wall running on this machine — and if not, which of the
four usual reasons it is: the service is not running or is bound to loopback, the
machine is in a VM using NAT, a firewall is dropping the ports, or the two devices
are not on the same network. A successful HTTP fetch to a LAN address is treated
as ground truth; everything else exists only to explain a failure.

A healthy run ends with `✓ the hub answers on this machine`, `✓ answers on
192.168.1.50 (wlan0)`, `✓ not behind VM NAT`, `✓ no active firewall found` and
**Nothing is wrong on this machine** — then a QR code for the wall URL, if
`qrencode` is installed (`sudo apt install -y qrencode`).

```bash
./network-check.sh --fix
# knows firewalld, ufw, nftables and iptables. Prints the exact commands and
# asks [y/N] first — answer anything but yes and nothing is changed.
```

```bash
sudo ./network-check.sh
# reading firewall state needs root; without it a real block can look like
# "no active firewall found", and the script says so.
```

---

## 4. Running on Windows

Same job, same launcher, a handful of real differences.

### Start it

Double-click **`run-local.cmd`**. That is the whole procedure. It switches the
console to UTF-8, checks Node is on `PATH` and tells you where to get it if not,
then runs `node start.mjs` and forwards any arguments you gave it. If the launcher
exits non-zero it prints the code and pauses, so the window does not vanish before
you can read the error.

From a terminal, with the environment set first:

```bat
set ADMIN_TOKEN=<your token>
run-local.cmd --redteam
```

```powershell
$env:ADMIN_TOKEN = "<your token>"
node start.mjs
```

`set` and `$env:` last only for that window. Use `setx ADMIN_TOKEN "<token>"` and
open a fresh window if you want it to survive a reboot.

### What actually differs

| | On Windows |
|---|---|
| **npm shims** | `npm`, `npx`, `yarn` and `pnpm` are `.cmd` files, and `spawn()` cannot find them without the shim. The launcher appends `.cmd` for exactly those four. `docker` is `docker.exe` and is deliberately left alone — asking for `docker.cmd` is an ENOENT that reads as "Docker is not available" when Docker is running perfectly well. |
| **Shutdown** | There is no `SIGTERM` for a child process. Ctrl-C raises `CTRL_C_EVENT` for the whole console, so the hub begins flushing on its own; the launcher waits up to 2.5 seconds for children to leave, then uses `taskkill /pid <pid> /T /F` on whatever is still standing. `/T` takes the tree, which matters because npm spawns node underneath itself. Killing immediately would interrupt the leaderboard write. |
| **Closing the window** | `SIGHUP` (window closed) and `SIGBREAK` (Ctrl+Break) are handled too, so both non-Ctrl-C ways of ending a show day still take the `--redteam` containers down. |
| **Ctrl-C reliability** | The launcher opens a readline interface on a real console so Ctrl-C reaches Node as `SIGINT`. |
| **Red team server** | `python serve.py` runs **waitress**, not gunicorn. Gunicorn imports `fcntl`, which does not exist on Windows: installing it there fails and running it there is impossible. `requirements.txt` marks each with its platform, so `pip install -r requirements.txt` does the right thing on both. |

### Windows Firewall

The first time the hub binds port 7788, Windows Defender Firewall shows
**"Allow Node.js JavaScript Runtime to communicate on these networks"**.

- Tick **Private networks** and click **Allow access**.
- Do **not** tick Public networks. A trade-show Wi-Fi may be classified Public, in
  which case set the booth network to Private in Settings → Network & Internet →
  the adapter → **Private network profile**, then restart the launcher so the
  prompt reappears.
- If you dismissed it: Windows Defender Firewall → Allow an app through firewall →
  Change settings → find Node.js → tick Private.

Until this is allowed, the hub answers on `127.0.0.1` and on nothing else, which
looks exactly like "the iPad cannot see it".

### Red team on Windows

```bat
cd DMATICS-Red-Team-Challenge-main
pip install -r requirements.txt
set SECRET_KEY=<the value from .env>
set ADMIN_TOKEN=<the same token as the hub>
set HUB_URL=http://192.168.1.50:7788
python serve.py
```

Docker Desktop also works, with the same `docker compose up -d --build`.

---

## 5. The iPad (the arcade)

### Get the address onto the tablet

The launcher printed it. It is the LAN line, not `127.0.0.1`:

```
http://192.168.1.50:7788/arcade
```

Type it in full, **starting with `http://`**. Without the scheme an iPad treats
`192.168.1.50:7788` as a search term, and some browsers silently try `https://`,
which the hub does not serve. If `qrencode` is installed, `./network-check.sh`
prints a QR code — scanning it is faster and cannot be mistyped.

### Lock the tablet down

Ten minutes, once per device, not once per day.

1. **Add to Home Screen.** Safari → Share → *Add to Home Screen*. Launch from that
   icon, not from Safari: it opens without the address bar, which is the only way
   to get real fullscreen on iOS.
2. **Guided Access.** Settings → Accessibility → Guided Access → on, and set a
   passcode. Then triple-click the side button inside the arcade to start it.
   A visitor cannot leave the app. Triple-click and enter the passcode to end it.
   (Android: Screen Pinning.)
3. **Display sleep off.** Settings → Display & Brightness → Auto-Lock → **Never**.
   A tablet that sleeps mid-queue reads as a broken stand.
4. **Brightness up.** Exhibition halls are bright. Turn off True Tone and Night
   Shift as well.
5. **Booth setup panel.** In the arcade, tap **Booth setup** on the hub screen. It
   restates steps 1–4 and carries the music and sound-effect pickers, saved per
   device, so one tablet can be quiet and another loud.

### Pointing a tablet at a hub: `?hub=`

```
http://192.168.1.50:7788/arcade?hub=http://192.168.1.50:7788
```

Resolution order, cheapest guess first: `window.GISEC_HUB` set by the host page,
then `?hub=` on the URL, then a remembered value in `localStorage`, then this page's
own host on port 7788. A `?hub=` value is remembered afterwards, so a tablet is
configured once rather than daily. `?hub=off` takes one device off the wall.

### Why a public address is refused

`?hub=` is only accepted when it names a machine on the booth LAN: `10.x.x.x`,
`192.168.x.x`, `172.16.x.x`–`172.31.x.x`, loopback (`127.x.x.x`, `localhost`,
`[::1]`), a `*.local` or `*.localhost` name, or the host that served the page.
Anything else — every public hostname — is ignored, with a console warning:
`[hub] refusing <host> — the arena hub must be on the booth LAN`.

This is not tidiness. The value was persisted to `localStorage` and used as the
POST target for every player's name and score. A QR code reading
`…?hub=https://someone-elses-host` and one tap on the iPad redirected the booth's
entire telemetry to a stranger, permanently, with nothing on screen changing. The
same parameter on the wall URL would have re-pointed the big screen's whole data
feed.

It also fixes the Vercel case: without the rule, an arcade on
`https://arcade.vercel.app` fell back to `https://arcade.vercel.app:7788` and hung
on every score.

**If the hub genuinely is public** (Railway, Render, Fly), name it in
`soc-wall-main/dist/soc-config.js` under `hub.url`. That file is trusted, because
only someone at the booth machine can edit it. A URL parameter is not.

---

## 6. The SOC wall on the big screen

### Which machine

The wall runs on the machine driving the big screen, and it should be **the same
machine that runs the hub**. The launcher rewrites `sameOrigin: true` into
`dist/soc-config.js` on every launch, so a wall served from the hub finds the hub
with no configuration at all. That single line is the difference between a wall
that loads and a wall whose leaderboards never fill.

A separate machine works too — point it at `http://<hub>:7788/` and it is
same-origin anyway, because the hub is serving the page.

### The kiosk command line

```bash
chromium --kiosk --autoplay-policy=no-user-gesture-required http://127.0.0.1:7788/
```

On Windows the binary is `chrome.exe` and the flags are identical:

```bat
"C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk --autoplay-policy=no-user-gesture-required http://127.0.0.1:7788/
```

| Flag | What it buys |
|---|---|
| `--kiosk` | No tab strip, no address bar, no window chrome. Recovers roughly 90px of height — on a 1080p screen that is 8% of the wall. It also stops a visitor navigating away. |
| `--autoplay-policy=no-user-gesture-required` | Alert audio works from boot. Browsers refuse to make a sound until a page has been interacted with, and nobody interacts with a wall display. |

If you cannot pass flags — an unmanaged screen, a locked-down machine — open the
URL and press **F11**, then arm the audio by hand (below).

### Resolution

**Nothing to configure.** The wall is drawn once at 1920×1080 and the finished
surface is scaled to whatever it is plugged into. A layout that re-flows to the
viewport moves the boxes but not the words inside them, so on an untested screen
the text walks out of its panels; scaling the finished surface removes the whole
class of problem. Verified identical from 1024×768 to 4K, and in portrait.

The one exception is a television that crops the picture — see `overscan` below.

### Arming the audio

With the autoplay flag, the wall is audible from boot and nothing appears.

Without it, a pill sits in the corner reading **ALERT AUDIO OFF · CLICK TO
ENABLE**. Click it once. It deletes itself the instant audio is running and does
not come back until the page reloads. It lives outside the scaled surface, so it
cannot disturb the wall's geometry.

Every sound is synthesised in the browser — there is not one audio file in the
repository, so there is nothing to lose off a USB stick and nothing that fails
without internet. Ambient telemetry is silent. Every noise the stand makes was
caused by a person standing in it.

### Booth settings: `dist/soc-config.js`

This file is served verbatim and is **not** bundled. Edit it with any text
editor and refresh the browser. No rebuild, no npm, no laptop with a toolchain.
Delete a key to fall back to its default.

| Key | Default | When you would change it |
|---|---|---|
| `timezone` / `timezoneLabel` | `"Asia/Dubai"` / `"GST"` | Any IANA zone. Every timestamp on the wall reads this, so the screen agrees with the clock in the hall. |
| `sound.volume` | `0.7` | `0.9` for a loud hall, `0.45` for a quiet one. `sound.enabled: false` switches the wall silent; `sound.scoreBlips: false` drops the tick when the arcade is constantly busy. |
| `hub.url` | `""` | Only when the hub is somewhere the same-origin rule cannot find — a public host. `hub.sameOrigin` is set by the launcher; `hub.port` (7788) is used with the wall's own hostname when `url` is unset. |
| `overscan` | `1` | Drop to `0.95` if a television crops the ticker or the top bar. `0.75` is the floor. |
| `designWidth` / `designHeight` | `1920` / `1080` | Almost never. It changes what counts as full size and re-tunes nothing. |
| `demo` | `true` | Leave it `true` at GISEC. It only controls the ambient background traffic that keeps the globe alive between visitors; live booth activity arrives through the hub either way. |
| `globeMotion` | `true` | `"auto"` follows the OS reduce-motion setting. The default is `true` on purpose, so a machine with animations turned down does not show a dead globe. |

For a single screen, mid-show, without editing anything:

```
http://127.0.0.1:7788/?fit=0.95      # overscan for this screen only (clamped 0.75–1)
http://127.0.0.1:7788/?sound=off     # silence this screen
http://127.0.0.1:7788/?volume=0.3    # quieter
http://127.0.0.1:7788/?hub=http://192.168.1.50:7788   # repoint the feed
```

### The Vercel caveat

`soc-wall-main` deploys to Vercel and `vercel.json` is already there. But Vercel
serves HTTPS and a booth hub serves plain HTTP, and browsers block that
combination as mixed content. **A wall on Vercel cannot reach a hub on your LAN.**
The globe will look alive on ambient telemetry, the leaderboards will stay empty
and no booth event will ever appear. Useful for showing someone the wall remotely;
useless at the stand. At GISEC, the wall is served by the hub.

---

## 7. Rehearse before the doors open

```bash
npm run simulate
```

It drives a whole booth run with no visitor and no clicking, and it **reports what
the server actually replied** at every step. It exits non-zero if the run did not
land. Point it at another machine with environment variables:

```bash
RT=http://192.168.1.51:8000 HUB=http://192.168.1.50:7788 node simulate.mjs
```

| Preset | What it does | What you should see |
|---|---|---|
| `npm run simulate` | Noisy operator: gets held a few times, backs off, finishes | Five green `✓ FLAG-n` lines, `✓ Full compromise`, exit 0 |
| `npm run simulate:clean` | Careful operator at human pace, about three minutes | The SOC posture stays `CLEAR` or `WATCHED`, five flags, exit 0 |
| `npm run simulate:bust` | Fails four passwords and gets contained | Posture walks `CLEAR → WATCHED → THROTTLED → CONTAINED`, then `✗ Contained.` Exit 0 — containment is the point of this preset |
| `npm run simulate:arcade` | Drops eight arcade scores on the board | Eight name/game/score lines, `✓ 8 scores on the board`, exit 0 |

A real `simulate:bust` run:

```
▸ Stage 2 · Credential Access
   bad password 1 of 4
   SOC WATCHED    ████████············  42
   bad password 3 of 4
   SOC THROTTLED  █████···············  25
   held for 11s — waiting, this is the SOC working
   bad password 4 of 4
   SOC CONTAINED  ████████████████████ 100

✗ Contained. Check the wall: containment band, station goes red.
```

Watch the big screen while it runs. That is the actual test.

### What a failure looks like

The rehearsal used to print five green ticks whatever happened, which is the
opposite of what a rehearsal is for. It now checks the reply to every step:

```
   ✗ FLAG-3 — no JSON back (HTTP 302, session lost or the run has ended)
...
✗ 1 step did not land — SIM-081455 did NOT fully compromise.
   Scroll up for the first red line; that is where the run broke.
```

and exits `1`. Preflight failures are separate and also exit `1`:

```
The hub is not answering at http://127.0.0.1:7788.
Start it with:  node start.mjs
```

```
The Red Team Challenge is not answering at http://127.0.0.1:8000.
Start it with:  node start.mjs --redteam
```

Run at least `simulate:arcade` and `simulate:bust` before the doors open. Clear
the boards afterwards — section 8.

---

## 8. Clearing the boards between days

There are three separate leaderboards: the arcade's, the hub's arena board that
feeds the SOC wall, and the red team's SQLite. One button clears all three.

1. Open the arcade on the iPad.
2. Tap **Booth setup** on the hub screen.
3. Scroll to **ADMIN — CLEAR EVERY LEADERBOARD**.
4. Enter `ADMIN_USER` and `ADMIN_PASSWORD`.
5. Tap **🗑 CLEAR LEADERBOARDS** and confirm the dialogue.

Credentials are checked on the server, so the check cannot be bypassed by editing
the page. A wrong password costs a deliberate one-second delay.

### Reading the result

It is best-effort by design and honest about it. A surface that is switched off or
unreachable is reported, not fatal — refusing to clear the arcade because the hub
is down would be worse.

All three reached:

```
✓ Cleared: arcade, hub, red team.
```

One could not be reached:

```
⚠ Arcade cleared. NOT cleared: red team (unreachable at http://192.168.1.51:8000
  — is it running, and on this network?)
```

Other per-surface reasons you will actually see:

| Reason | What it means |
|---|---|
| `REDTEAM_URL is not set` / `GISEC_HUB is not set` | The arcade does not know that surface's address. Set it in `.env.local`. |
| `ADMIN_TOKEN is not set on the arcade` | The arcade has no token to present. |
| `bad token` | The token on that surface differs from the arcade's. |
| `ADMIN_TOKEN is not set on the hub; reset is disabled.` | The hub was started without the token in its environment. |
| `no answer within 6s — is it running?` | The service is up but wedged. A wedged booth service must not hang the button. |

"All leaderboards cleared" when the hub was unreachable is the worst thing this
button could say — the crew walks away and the wall is still showing yesterday. It
does not say it.

### It works in both deployments

The button reaches the other boards whichever way the iPad is being served, but
the route differs, and the wording in the result tells you which one you are on.

**On `http://<hub>:7788/arcade`** — the booth default — the arcade is a static
file served by the hub, so the button's POST lands on the *hub's*
`/api/admin/reset`. The hub accepts the username and password, clears its own
arena board, and calls the red team itself. The page clears its local copy. You
will see:

```
✓ Cleared: hub, red team.
```

For this the HUB needs `ADMIN_USER`, `ADMIN_PASSWORD`, `ADMIN_TOKEN` and
`REDTEAM_URL` in its environment.

**On the arcade's own Next.js server** (`npm start`, or a Vercel deploy) the
button hits the arcade's own API route, which clears the arcade store and then
calls the hub and the red team:

```
✓ Cleared: arcade, hub, red team.
```

For this the ARCADE needs `ADMIN_USER`, `ADMIN_PASSWORD`, `ADMIN_TOKEN`,
`GISEC_HUB` and `REDTEAM_URL`.

A Vercel-hosted arcade cannot reach anything on your LAN, so there it will clear
its own board and report the other two as unreachable. That is the truth, and it
is why the button says so rather than claiming success.

### Doing it from a terminal instead

```bash
# the hub — and, because REDTEAM_URL is set on it, the red team too
curl -s -X POST http://127.0.0.1:7788/api/admin/reset \
  -H 'Content-Type: application/json' -d "{\"token\":\"$ADMIN_TOKEN\"}"
# {"ok":true,"surfaces":[{"name":"hub",...},{"name":"red team",...}],
#  "message":"Cleared hub, red team."}
```

```bash
# the red team on its own
curl -s -X POST http://192.168.1.51:8000/admin/reset \
  -H "X-Admin-Token: $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{}'
# {"cleared":"redteam","ok":true,"rows":37}
```

Clearing the red team board does **not** end a run in progress. A player mid-attempt
keeps their session and is written to the fresh board when they finish.

There is also a nuclear option, with everything stopped:

```bash
./run-local.sh --reset      # deletes gisec-hub/data/arena.json and the red team db
```

---

## 9. When something breaks

| Symptom | Likely cause | Confirm it | Fix |
|---|---|---|---|
| iPad cannot reach the hub | Firewall, wrong address, or the devices are on different networks | On the iPad open `http://<hub>:7788/api/health` — one line of text, no scripts. If that loads, the network is fine and the problem is the page. | Linux: `./network-check.sh`, then `--fix`. Windows: allow Node on **Private** networks in Defender Firewall. Check the iPad's own IP is on the same subnet (Settings → Wi-Fi → ⓘ). Type `http://` in full. |
| iPad on the same subnet, health check still fails | Router client isolation ("AP isolation", "guest mode"), or the hub machine is in a VM using NAT | `./network-check.sh` names both | Client isolation cannot be fixed on the laptop — use a travel router or a hotspot. For the VM, set the adapter to **Bridged** and reboot it. |
| Wall shows no leaderboard | The wall is not connected to the hub | `curl -s http://127.0.0.1:7788/api/health` → `"wallClients":0` means no big screen is attached | Reload the wall. Check the browser console for `[arena] refusing …` or `[arena] no hub configured`. Confirm `hub.sameOrigin: true` in `dist/soc-config.js`, or repoint with `?hub=http://<hub>:7788`. |
| Wall on Vercel, boards always empty | Mixed content — HTTPS page, HTTP LAN hub | The console shows a blocked request | Serve the wall from the hub: `http://<hub>:7788/`. This is not fixable on Vercel. |
| Wall is silent | Audio never armed | The pill **ALERT AUDIO OFF · CLICK TO ENABLE** is on screen | Click it once. To avoid it, relaunch with `--autoplay-policy=no-user-gesture-required`. |
| Wall is silent, no pill | `sound.enabled: false`, `volume: 0`, or `?sound=off` on the URL — or nothing has happened yet, because ambient telemetry is always silent | Check `dist/soc-config.js` and the address bar | Edit and refresh, or drop `?sound=off`. Then run `npm run simulate:bust` and listen. Check the screen's own volume and HDMI audio too. |
| Red team will not start | Docker: `SECRET_KEY` missing from `.env`. Native: dependencies not installed | `set SECRET_KEY in .env — see .env.example`, or `ModuleNotFoundError: No module named 'gunicorn'` | Put a 64-hex key in `DMATICS-Red-Team-Challenge-main/.env`; run `pip install -r requirements.txt`. On Windows, any error mentioning `fcntl` means gunicorn — use `python serve.py`, which picks waitress. |
| Red team runs, nothing on the wall | `HUB_URL` unset, or pointing at `localhost` from inside a container | `curl -s http://<laptop>:8000/health` → `"hub":{"configured":false}`, or `failed` climbing alongside `sent` | Set `HUB_URL` to the hub's **LAN** address. Restart the challenge. |
| Players logged out at random | Two workers with different signing keys | `serve.py` printed *SECRET_KEY is not set* on startup | Set `SECRET_KEY` and restart. |
| Port already in use | Something is on 7788 or 8000 — often a detached `--redteam` container from yesterday | `node start.mjs` fails with *Port 7788 is already in use. Stop whatever is on it, or use --port.* On Linux, `lsof -iTCP:7788 -sTCP:LISTEN` names the process | `./run-local.sh --stop`, or `docker compose down` in the red team directory, or `npm start -- --port 8080`. |
| Scores not saving on the arcade | No shared database behind the Next.js arcade | `curl -s http://<arcade>:3000/api/health` → `"verdict":"Scores are NOT being saved — the board is in serverless memory and resets."` | Attach a Redis-compatible database and set `REDIS_URL` (or `KV_URL`, or the Vercel KV REST pair). The arcade tests this with a real round-trip rather than trusting an environment variable, so the verdict is trustworthy. |
| Scores save on the iPad but never reach the wall | The arcade's hub bridge is off or refused | The browser console shows `[hub] refusing <host> — the arena hub must be on the booth LAN`, or the device once had `?hub=off` | Reload with `?hub=http://<hub>:7788`. It is remembered afterwards. |
| Wall picture cropped, or the clock is wrong | Television overscan; wrong timezone | Ticker or top bar cut off; header clock | `?fit=0.95` on the URL, or `overscan: 0.95` / `timezone` in `dist/soc-config.js` and refresh. No rebuild. |

Two commands worth memorising:

```bash
curl -s http://127.0.0.1:7788/api/health
# wallClients tells you if the big screen is really attached; stations tells you
# which laptops have checked in.
```

```bash
tail -f logs/hub.log        # when started via ./run-local.sh
# "wall connected (1 total)" / "score AMIRA phish 2480" / "ALL BOARDS CLEARED by admin"
```

---

## 10. Show-day checklist

### Morning — allow thirty minutes

- [ ] Hub machine, both laptops, the iPad and the big screen all on the booth
      network. Not venue Wi-Fi if you can avoid it.
- [ ] `set -a; . ./gisec-hub/.env; set +a` then `npm start` (Linux/macOS), or
      double-click `run-local.cmd` (Windows). Note the LAN address it prints.
- [ ] `curl -s http://127.0.0.1:7788/api/health` → `"ok":true`.
- [ ] Wall in kiosk mode on the big screen. Check `wallClients` is now `1`.
- [ ] Audio: click the arming pill if it is showing. Play a test with
      `npm run simulate:bust` and listen.
- [ ] Red team up on both laptops. `curl -s http://127.0.0.1:8000/health` →
      `"hub":{"configured":true,...}`.
- [ ] Laptop 01 open at `?station=LAPTOP-01`, laptop 02 at `?station=LAPTOP-02`.
      Separate browsers, or they appear as one operator.
- [ ] iPad launched from its Home Screen icon, Guided Access on, auto-lock Never,
      brightness up.
- [ ] `npm run simulate:arcade` — eight names appear on the wall's arena panel.
- [ ] `npm run simulate:bust` — watch the containment band on the wall and the
      station go red.
- [ ] Clear every board (section 8). Confirm the wall's leaderboards are empty.
- [ ] Wall clock matches the hall clock.
- [ ] Charger on the iPad. It will not last a show day at full brightness.

### Close of day

- [ ] Photograph or export the leaderboard if you are running a daily prize.
- [ ] Clear every board and read the per-surface result. Do not accept a warning.
- [ ] Stop the services: `Ctrl-C` in the launcher window (never `kill -9`), or
      `./run-local.sh --stop`. Confirm `docker compose ps` shows nothing up in
      `DMATICS-Red-Team-Challenge-main`.
- [ ] Confirm ports are free before you leave: nothing on 7788 or 8000.
- [ ] Charge the iPad overnight. Leave it plugged in.
- [ ] Leave the big screen off, not on a screensaver.

---

© DMATICS IT Solutions LLC. Built for GISEC 2026, Dubai.
