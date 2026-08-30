# Deploying

Four pieces, three places they can run. The short version:

| | Windows | Linux / macOS | Vercel |
|---|---|---|---|
| **Arena Hub** | yes | yes | **no** — see below |
| **SOC Wall** | yes | yes | yes, but demo mode only |
| **Cyber Arcade** | yes | yes | **yes** — this is its natural home |
| **Red Team Challenge** | yes (Docker *or* native) | yes | no |

---

## Locally — the same two commands everywhere

You need [Node 18 or newer](https://nodejs.org). Nothing else, for the hub and
the wall.

```bash
npm start            # Windows, Linux, macOS
```

or on Windows, double-click **`run-local.cmd`**.

That builds the wall if it has not been built, starts the hub, prints every LAN
address the iPad and the phones can reach it on, and opens a browser. `Ctrl-C`
stops it cleanly — including on Windows, where child processes have to be taken
down with `taskkill` rather than a signal, which the launcher handles.

```bash
npm start -- --build          # force a rebuild of the wall first
npm start -- --redteam        # also bring up the challenge (needs Docker)
npm start -- --port 8080      # something else already has 7788
npm start -- --no-open        # do not open a browser
```

Rehearse a run without a visitor — also cross-platform:

```bash
npm run simulate              # a noisy operator: held a few times, finishes
npm run simulate:clean        # careful operator: the SOC leaves them alone
npm run simulate:bust         # fails four passwords and gets contained
npm run simulate:arcade       # just drop scores on the leaderboard
```

> The older `run-local.sh`, `simulate.sh` and `network-check.sh` still work and
> still do a little more on Linux — `network-check.sh --fix` in particular knows
> about firewalld, ufw, nftables and iptables. They are the Linux comfort path; the
> Node scripts are the ones that behave identically everywhere.

### The Red Team Challenge

**With Docker** (any OS, including Windows with Docker Desktop):

`.dockerignore` keeps `.env`, `.git` and the live leaderboard out of the image —
without it, `COPY . .` baked the operator's real `SECRET_KEY` into a layer that
survives every `docker save`, registry push and `docker history`. Gunicorn runs
with `--preload` so all workers share one signing key even when `SECRET_KEY` is
unset, and the image carries a `HEALTHCHECK` that asks the app rather than the
process.


```bash
cd DMATICS-Red-Team-Challenge-main
cp .env.example .env          # then put a SECRET_KEY in it
docker compose up -d --build
```

**Without Docker** — this is the path that makes Windows work natively:

```bash
cd DMATICS-Red-Team-Challenge-main
pip install -r requirements.txt
python serve.py
```

`serve.py` picks the right server for the machine: **waitress** on Windows,
**gunicorn** elsewhere. This matters because gunicorn imports `fcntl`, which
Windows does not have — installing it there fails, and running it there is
impossible. The requirements file marks each one with the platform it belongs to,
so `pip install` does the right thing on both.

`serve.py` runs two workers when `SECRET_KEY` is set and **one** when it is not —
because without it each worker invents its own key, rejects the other's cookies,
and a player is logged out at random. That is a guard rail, not a substitute:
set the key.

The leaderboard lands in `DMATICS-Red-Team-Challenge-main/data/leaderboard.db`
unless `DB_PATH` says otherwise. (Docker still uses `/app/data`, set by compose.)

Run state lives in the Flask session cookie rather than in process memory, so
workers do not need to share anything except `SECRET_KEY`. That is precisely why
`SECRET_KEY` matters: two workers with different keys reject each other's
cookies, and a player's run resets at random mid-attempt.

---

## Vercel

### The arcade — yes, and this is where it wants to live

```bash
cd dmatics-cyber-arcade-main
vercel                        # or import the repo at vercel.com/new
```

Verified: `next build` completes clean, with the three API routes as serverless
functions.

Set these in the Vercel project:

| Variable | Why |
|---|---|
| `ADMIN_USER`, `ADMIN_PASSWORD` | The leaderboard reset endpoint. **Unset, it refuses every request** — there is no default password in this repository, on purpose. |
| `NEXT_PUBLIC_GISEC_HUB` | Bakes the hub address into the deploy so tablets do not need `?hub=` on the URL. Leave it blank if the arcade is running standalone. |

Attach a Redis-compatible database (Vercel KV, Upstash) for a leaderboard that
is shared across devices and survives a redeploy. Without one the board still
works, but each serverless instance keeps its own copy and it is lost on
redeploy — the arcade detects which of the two it has with a real round-trip,
not by trusting an environment variable, and tells the UI so the stand is never
lying about whether scores are saved.

### Where the hub is allowed to be

Both the wall and the arcade refuse a hub address that is not on the booth LAN —
loopback, `10.x`, `192.168.x`, `172.16–31.x`, `*.local`, or the same host that
served the page. Everything else is ignored with a console warning.

That is not tidiness. `?hub=` is a URL parameter, and the arcade persisted it: a
QR code reading `…?hub=https://someone-elses-host` and one tap on the iPad
redirected every player's name and score to a stranger, permanently, with nothing
on screen changing. The same parameter on the wall URL would have re-pointed the
big screen's entire data feed.

It also fixes the Vercel case. Without the rule, an arcade on
`https://arcade.vercel.app` fell back to `https://arcade.vercel.app:7788` and hung
on every score.

**If the hub really is somewhere public** (Railway, Render, Fly), name it in
`soc-wall-main/dist/soc-config.js` under `hub.url`. That file is trusted, because
only someone at the booth machine can edit it — a URL parameter is not.

### The SOC wall — yes, with one honest caveat

```bash
cd soc-wall-main
vercel
```

`vercel.json` is already there: it builds with Vite, serves `dist`, and marks
`soc-config.js` and `index.html` as never-cacheable so a show-floor edit takes
effect on a refresh, while the hashed assets are cached for a year.

**The caveat.** Vercel serves over HTTPS. A booth hub on the LAN serves over
plain HTTP. Browsers block that combination as mixed content, so a wall on
Vercel **cannot reach a hub on your LAN** — it will run its ambient telemetry and
the globe will look alive, but the leaderboards will stay empty and no booth
event will ever appear.

That is fine for showing the wall to someone remotely, and useless at the stand.
**At GISEC, the wall should be served by the hub** (`http://<hub>:7788/`), which
is what `npm start` sets up. Only put the wall on Vercel if the hub is also
reachable over HTTPS.

### The hub — no, and it is worth understanding why

The Arena Hub is not a Vercel-shaped thing, and forcing it there would break the
show:

- **It holds connections open.** The wall and both laptops each keep a
  Server-Sent Events stream open for hours. Serverless functions have a maximum
  duration; every time one expires the wall reconnects, and the containment
  channel to the laptops has a hole in it.
- **It owns state on disk.** `arena.json` is the leaderboard. Vercel's filesystem
  is ephemeral and per-instance, so the board would reset unpredictably and two
  instances would disagree about who is winning.

Neither is a flaw in the hub — it is a LAN service for a stand that is designed
to work with **no internet at all**, which is the right call for a trade show
where the wifi is other people's.

If it genuinely has to be online, host it somewhere that runs a persistent
process — Railway, Render, Fly.io — all of which take the existing
`gisec-hub/package.json` unchanged (`npm start`, one process, a volume mounted at
`DATA_DIR`). Nothing in the code needs to change.

---

## Before any of it

Every admin endpoint reads its secret from the environment and refuses to run
without one. Copy the templates:

```bash
cp DMATICS-Red-Team-Challenge-main/.env.example DMATICS-Red-Team-Challenge-main/.env
cp gisec-hub/.env.example                        gisec-hub/.env
cp dmatics-cyber-arcade-main/.env.example        dmatics-cyber-arcade-main/.env.local

openssl rand -hex 32     # SECRET_KEY
openssl rand -hex 24     # ADMIN_TOKEN
```

On Windows without OpenSSL:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

None of the `.env` files are committed. `.gitignore` keeps them out, and
`push-to-github.sh` scans for credentials before every push and refuses if it
finds one.
