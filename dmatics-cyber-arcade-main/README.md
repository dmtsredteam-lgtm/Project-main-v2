# DMATICS Cyber Arcade 🕹️

Three 60-second cybersecurity games for the **DMATICS IT Solutions** booth at **GISEC 2026**:

- **Phish Hunter** — spot the phishing email (awareness / blue team)
- **Alert Rush** — triage a live SOC alert queue (blue team)
- **Breach Point** — find the weakest link a pentester would hit (red team)

Full arcade feel (CRT scanlines, neon, chiptune music, live animated backgrounds, confetti), a **shared online leaderboard with a Hall of Fame on the main menu**, and a per-round **answer review** that explains *why* each answer was right or wrong **and what to do about it**. Fully responsive — phones, Android tablets, touchscreens, laptops and big screens.

---

## What makes the questions feel fresh

The content is **UAE-specific** — UAE PASS, Emirates ID, Dubai Police fines, DEWA, Salik, RTA, MOHRE, GDRFA, the Federal Tax Authority, Emirates NBD / FAB / ADCB / Mashreq / ADIB, Etisalat by e&, du, Mahzooz and Emirates Draw prize scams, Golden Visa fees, Dubai rental deposit scams, and Ramadan charity fraud — alongside the universal ones (BEC gift cards, invoice redirection, ransomware, LSASS dumps, Kerberoasting).

| | Hand-written templates | Distinct questions actually generated |
|---|---|---|
| Phish Hunter | 72 phishing + 42 legitimate | **~14,600** |
| Alert Rush | 36 threats + 28 false positives | **~11,500** |
| Breach Point | 32 attack archetypes | **~9,600 boards** |
| **Total** | **210 templates** | **35,000+ question instances** |

Those "distinct" figures are measured, not estimated — generating 20,000 items produced that many unique ones.

**No-repeat guarantee.** Every bank is a shuffled deck drawn *without replacement*, and recent draws are remembered in `localStorage`. Verified by test: zero repeats inside a single game, and zero-to-one overlap between back-to-back games. A visitor can play all day and keep meeting new questions.

---

## Deploy to Vercel from GitHub (5 minutes)

### 1. Put this project on GitHub
```bash
cd gisec-arcade
git init
git add .
git commit -m "DMATICS Cyber Arcade"
git branch -M main
git remote add origin https://github.com/<your-username>/dmatics-cyber-arcade.git
git push -u origin main
```

### 2. Import into Vercel
1. Go to **vercel.com/new**.
2. Pick the GitHub repo you just pushed.
3. Framework preset is auto-detected as **Next.js** — leave everything default.
4. Click **Deploy**. You get a live URL like `dmatics-cyber-arcade.vercel.app`.

After the first import, **every `git push` redeploys automatically** — no further steps.

The app runs immediately. Out of the box the leaderboard uses in-memory storage (works, but resets on redeploy). To make it a **permanent, shared** leaderboard, add a database in one click:

### 3. (Recommended) Turn on the persistent shared leaderboard
1. In your Vercel project → **Storage** tab → **Create Database** → choose **KV** (Upstash Redis, free tier available).
2. Connect it to this project. Vercel auto-injects `KV_REST_API_URL` and `KV_REST_API_TOKEN`.
3. **Redeploy** (Deployments → ⋯ → Redeploy). Scores now persist and are shared across **every device** hitting the site.

No code changes needed — the app detects the KV env vars and uses them automatically (`lib/store.js`).

---

## Run locally
```bash
npm install
npm run dev      # http://localhost:3000
```
`npm run build && npm start` for a production build. Local dev uses the in-memory leaderboard unless you set the KV env vars in `.env.local`.

---

## How it works

| Path | What it is |
|------|-----------|
| `app/page.js` | Mounts the arcade full-screen |
| `public/game.html` | The entire arcade (all 3 games, music, animated backgrounds, review) — self-contained & offline-capable |
| `app/api/scores/route.js` | Leaderboard API — `GET /api/scores?game=phish`, `POST /api/scores` |
| `lib/store.js` | Storage: Vercel KV if configured, else in-memory. Client also keeps a localStorage copy |

The game auto-syncs to the shared board when served over http(s), and falls back to on-device localStorage when opened as a plain file — so the **same `public/game.html`** doubles as an offline kiosk file (AirDrop it to a tablet, "Add to Home Screen").

### Hall of Fame
The main menu carries a live leaderboard with tabs for **All Games / Phish Hunter / Alert Rush / Breach Point**. "All Games" merges every board into one ranking so the booth always has a single champion on show. A badge tells the crew whether the board is **LIVE · SHARED** (served online) or **THIS DEVICE** (offline file).

### Animated backgrounds
A single canvas paints a different field per screen, so each game feels like its own cabinet:

- **Arcade menu** — drifting neon sparks over a synthwave grid floor
- **Phish Hunter** (blue team) — inbox sonar sweeps + floating envelopes
- **Alert Rush** (blue team) — streaming SOC telemetry + a live heartbeat trace
- **Breach Point** (red team) — code rain + an attack-path node graph lighting up hop by hop

All of it honours `prefers-reduced-motion` — the canvas is disabled entirely for visitors who need that.

---

## Booth kiosk tips
- Open the Vercel URL on the tablet → browser share → **Add to Home Screen** → launch fullscreen.
- **Guided Access** (iPad: Settings → Accessibility) or **Screen Pinning** (Android) locks visitors into the arcade.
- Set the display to never sleep, brightness up.
- The in-app **♪ Music** and **🔊 SFX** chips (top-right) toggle audio; **◄ ARCADE** returns to the menu from any game.

---

*Built for DMATICS IT Solutions LLC · SOC · NOC · Pentesting · GISEC 2026*
