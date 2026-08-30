# GISEC 2026 — Laptop "Depth Tier" Plan (Games #4–#10)

**Split confirmed:** the tablet runs the arcade (Phish Hunter / Alert Rush / Breach Point,
built and done). The laptop runs the longer games for the visitor who leans in. This document
covers only the laptop tier, and every claim below was checked against the actual repo or
site — not against the description in the brief.

---

## 1. What I verified, and what it changes

| # | Game | Claim in the brief | What's actually true | Verdict |
|---|------|--------------------|----------------------|---------|
| 4 | SOC Simulator (soc-sim.vercel.app) | "Already hosted and free" | Correct — no account, 20 levels, monitor → investigate → respond loop. **Hosted only; needs internet.** | Bonus, not core |
| 5 | SOC Analyst Simulator | "Clone and run locally… verify build steps" | **Better than described.** One 64 KB `index.html`, no build, no server, no npm. **Verified running with all network blocked: zero errors.** | ⭐ **Primary** |
| 8 | Splunk Attack Range | "Needs a beefy machine or cloud account" | **v5 is cloud-only** — AWS/Azure/GCP, Docker, cloud credentials. Offline operation is not supported. | ❌ **Drop** |
| 9 | GOAD | "Heavy to deploy, multiple VMs" | Confirmed. GOAD-Light = **5 Windows Server 2019 VMs**, docs say "min ~20GB". Runs on VirtualBox / VMware / Proxmox, so offline is possible. | Theatre only, if hardware |

### The two findings that matter

**Attack Range can't do what the booth needs.** Version 5 builds instrumented environments in
AWS, Azure or GCP and needs cloud credentials mounted into Docker containers. There is no
local/offline path. On a show floor with unreliable Wi-Fi it is not a demo, it is a risk. It
was already flagged as the highest-effort item — it is now also the one that cannot work.
**Cut it and reclaim the prep time.**

**SOC Analyst Simulator is the easy win.** The brief hedged ("if it's Node-based: npm install
&& npm run build"). It isn't. It's a single self-contained HTML file — exactly the same
deployment model as your arcade. I cloned it and ran it in a browser with **every external
request blocked**: it loaded, the mission brief rendered, difficulty selection (ROOKIE /
ANALYST / SENIOR) and the ESCALATE / FALSE POS controls all present, **zero page errors**.

One caveat: it pulls three Google Fonts from the internet. Offline they fail and it falls back
to system fonts — it still looks good (the monospace fallback suits the aesthetic), but it is
not pixel-identical to the author's design. If you want it exact offline, the fonts need
downloading and inlining — a small patch I can do.

---

## 2. Recommended laptop lineup

| Priority | Game | Length | Offline | Effort |
|---|---|---|---|---|
| 1 | **SOC Analyst Simulator** (#5) | 5–15 min | ✅ verified | Copy one file |
| 2 | **Incident Command** (custom, see §4) | 3–5 min | ✅ by design | 4–6 days |
| 3 | **GOAD-Light staff demo** (#9) | Scheduled | ✅ if pre-built | High — needs 32 GB laptop + an engineer |
| 4 | **SOC Simulator** (#4) | 5–10 min | ❌ needs internet | Bookmark it |
| — | ~~Attack Range~~ (#8) | — | ❌ cloud-only | **Cut** |

**If you do nothing else:** get #5 onto the laptop. It is one file, it is verified offline, and
it fills the depth slot immediately at effectively zero cost and zero risk.

---

## 3. Deployment — laptop, no internet

### #5 SOC Analyst Simulator — do this at the office, this week

```bash
git clone https://github.com/ibrahimiyawa/soc-analyst-simulator
```

The game is `soc-analyst-simulator/Soc-Analyst-Simulator/index.html`. Copy **that single file**
to the laptop — desktop, USB stick, anywhere. Double-click to open. That's the whole install.

Booth setup:
- Open it in Chrome, then **⋮ → Cast, save and share → Install page as app** for a
  fullscreen window with no address bar.
- Or just press **F11**.
- Screen never sleeps, mains power not battery.

**Test it once with Wi-Fi switched off** before the show. That is the only verification that
matters, and it takes thirty seconds.

### #4 SOC Simulator — internet-permitting only

Open `https://soc-sim.vercel.app` in a tab and leave it loaded. It's a third-party site, so
there is nothing to mirror and no offline fallback. Pre-load it in the morning and treat it as
a bonus: if the venue Wi-Fi holds, it's there; if not, nobody notices, because #5 is already
carrying the depth slot.

### #9 GOAD-Light — only if you have the hardware and a driver

Five Windows Server 2019 VMs, ~20 GB disk minimum per the docs, realistically a **32 GB RAM**
laptop to run them together with any comfort. VirtualBox or VMware Workstation both work
offline once built.

- **Build it three weeks out, not show week.** Provisioning downloads a lot and fails in
  interesting ways; you do not want to discover that on the Tuesday.
- Snapshot every VM once provisioned, so a broken demo is a 30-second rollback.
- Run it as **scheduled theatre** — "live AD attack, every hour on the hour" — with an engineer
  narrating Kerberoasting or pass-the-hash on an external monitor.
- It is not self-serve. A visitor cannot be handed this.

**If you don't have a 32 GB laptop and a free engineer, skip it.** Breach Point already covers
the pentest crowd-pull, and a half-working AD lab is worse than no AD lab.

---

## 4. The custom long game — Incident Command

Worth building because none of the ready-made tools tell *your* story. This one is
UAE-anchored, DMATICS-branded, offline by construction, and shares the arcade's engine.

**Length:** 3–5 min · **Players:** 1 (2 can huddle) · **Effort:** 4–6 days, mostly content

One breach, five stages, on a laptop-sized layout:

1. **Detect** — an alert lands. Real, or noise?
2. **Triage** — EDR timeline, mail logs, firewall, or the user?
3. **Contain** — isolate the host, disable the account, block the domain, or hold?
4. **Eradicate** — find the entry point and close it, or get reinfected.
5. **Communicate** — who hears about it, in what order, and what do you say?

**The design point:** choices *constrain* later stages. Contain too early and you destroy the
evidence Eradicate needs. Wait for certainty and the attacker moves laterally. A 60-second
quiz structurally cannot teach this — and it is precisely what a managed SOC sells.

**Ends with an incident report card** — time to detect, time to contain, data lost, each
decision graded. That card is what visitors photograph and what your team talks them through.

**Reuses:** alert templates, breach archetypes, review screen, scoring, audio, backgrounds,
leaderboard. **New:** a stage machine, a branching scenario schema, the report card.

**Content is the long pole** — ~20 scenarios × 5 stages. Start writing before any code. Suggested
UAE scenarios: ransomware via a Dubai supplier invoice, Emirates ID phishing → payroll
redirect, MOHRE-themed BEC, DEWA payment fraud, exposed RDP at a branch office, insider USB
exfil, Salik credential harvest, cloud storage misconfiguration.

**Optional smaller adds** (#6, #7, #10 in the brief) — Password Cracker Challenge, Spot the
Vulnerability, Cyber Trivia Wheel. Each ~1 day as a self-contained offline HTML file in the
arcade's style. Good filler if the laptop needs more variety; not required.

---

## 5. One thing to fix in the arcade before adding any game

The game list is hardcoded in **seven** places: `GAMES` in `lib/store.js`, the `META` object,
`GLABEL`, three separate `['phish','soc','breach']` arrays inside `renderHall`, the `GS` array
in `sync`, and the Hall of Fame tab markup.

Collapsing those into `Object.keys(META)` and rendering the tabs from it is **half a day**, and
it means game four touches two files instead of seven places. It also removes the most likely
source of the "one number updated, another went stale" bugs already fixed this session. Do it
before, not after.

---

## 6. Three-week timeline

**Week 1 — lock it down**
- Manager signs off on cutting Attack Range and the reasoning above
- Clone #5, copy the single HTML to the booth laptop, **test with Wi-Fi off**
- Decide GOAD in or out — that decision is really "do we have a 32 GB laptop and a free engineer"
- Start writing Incident Command scenarios (longest lead time)
- Collapse the hardcoded game arrays in the arcade

**Week 2 — build**
- Incident Command stage machine + report card
- If GOAD is in: build and snapshot it now
- Attach the local database so the arcade board survives restarts
- Draft the booth show schedule if you're running scheduled demos

**Week 3 — rehearse and harden**
- Everything on the **actual** hardware, tested with the network off
- Two colleagues play each game end to end; watch where they hesitate
- One-line pitch per game for booth staff
- Laptop: never-sleep, mains power, fullscreen, spare charger

**Day before:** clear test scores, charge everything, print the "TOP SCORE OF THE DAY" sign,
and make sure someone other than you can restart all of it.

---

## 7. Decisions I need from you

1. **Cut Attack Range?** My recommendation is yes — it cannot run offline.
2. **GOAD in or out?** Only if a 32 GB laptop and an engineer are both genuinely available.
3. **Build Incident Command?** If yes, I start on the scenario content now.
4. **Inline the fonts into #5** so it's pixel-perfect offline? Small patch, say the word.
5. **A laptop launcher page** — one offline menu listing every depth game, in DMATICS branding,
   so the booth laptop opens on something tidy rather than a browser tab. ~half a day.
