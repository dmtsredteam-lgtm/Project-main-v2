#!/usr/bin/env node
/* ===========================================================================
 * GISEC 2026 — DMATICS Arena Hub
 * ---------------------------------------------------------------------------
 * One small service that ties the three booth experiences together:
 *
 *     iPad          →  Cyber Arcade      (Phish Hunter / Alert Rush / Breach Point)
 *     Laptop 01/02  →  Red Team Challenge (5-stage CTF against "Aegis Vault Systems")
 *     Big screen    →  SOC Wall           (globe, telemetry, arena leaderboard)
 *
 * The hub does four jobs and nothing else:
 *
 *   1. INGEST   every game posts its telemetry here (`POST /api/events`)
 *   2. NORMALISE each event becomes a SOC-Wall-shaped alert, so the wall's
 *                existing alert pipeline consumes booth activity with no
 *                special-casing — a failed password on Laptop 02 arrives at the
 *                globe looking exactly like any other detection.
 *   3. SCORE    one unified leaderboard across all four games
 *                (`POST /api/scores`, `GET /api/leaderboard`)
 *   4. FAN OUT  Server-Sent Events to the wall (`/api/stream`) and to the red
 *                team stations (`/api/command/stream`), so the SOC can push a
 *                containment order back down and interrupt a running game.
 *
 * DESIGN RULE — the hub is never load-bearing for gameplay.
 * Every client keeps its own local behaviour and treats the hub as a bonus:
 *   · arcade   → localStorage / Vercel KV board still works
 *   · red team → SQLite board and its own bust logic still work
 *   · wall     → falls back to its demo telemetry
 * If this process dies mid-show, three games keep running and only the shared
 * board and the cross-screen theatre stop. That is deliberate.
 *
 * Zero npm dependencies (node:http + node:fs only) so it runs on any laptop
 * with Node 18+, offline, with no install step.
 *
 *   node server.js                 # port 7788
 *   PORT=9000 node server.js
 *
 * DMATICS IT Solutions LLC · Dubai
 * ========================================================================= */

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 7788);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'arena.json');
/* No fallback on purpose: a default token committed to a repository is a
 * published token. Unset, /api/admin/reset refuses and says so. */
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

/* The arcade's CLEAR EVERY LEADERBOARD button, when the hub is serving the
 * arcade.
 *
 * At the booth the iPad opens http://<hub>:7788/arcade, which is game.html
 * served as a STATIC FILE — there is no Next.js runtime behind it, so its own
 * /api/admin/reset does not exist and the button's POST lands here instead,
 * carrying {user, pass} rather than {token}. Without these the panel answered
 * "bad token" and cleared nothing, in exactly the deployment the booth actually
 * uses. So this endpoint accepts either credential shape, and fans out to the
 * red team the same way the Next route does.
 *
 * All three are optional and all three have no default: unset, that half of the
 * feature refuses and says so. */
const ADMIN_USER = process.env.ADMIN_USER || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const REDTEAM_URL = (process.env.REDTEAM_URL || '').replace(/\/$/, '');

/* Optional: serve the SOC wall build and the arcade file straight off the hub,
 * so the booth needs one process instead of three static servers.
 * Point these at the built folders; missing folders are simply ignored. */
const WALL_DIR = process.env.WALL_DIR || path.join(__dirname, '..', 'soc-wall-main', 'dist');
const ARCADE_DIR =
  process.env.ARCADE_DIR || path.join(__dirname, '..', 'dmatics-cyber-arcade-main', 'public');

// --------------------------------------------------------------------------- //
//  Game registry — the single place a new game is declared.
//  (The arcade PLAN.md called out that its game list was hardcoded in seven
//  places; the hub deliberately keeps exactly one.)
// --------------------------------------------------------------------------- //
const GAMES = {
  phish:   { label: 'PHISH HUNTER',  short: 'PHISH',   surface: 'ARCADE · iPAD',    accent: 'cyan'     },
  soc:     { label: 'ALERT RUSH',    short: 'ALERTS',  surface: 'ARCADE · iPAD',    accent: 'emerald'  },
  breach:  { label: 'BREACH POINT',  short: 'BREACH',  surface: 'ARCADE · iPAD',    accent: 'purple'   },
  redteam: { label: 'RED TEAM OP',   short: 'RED OPS', surface: 'LAPTOP STATIONS',  accent: 'critical' },
};
const GAME_KEYS = Object.keys(GAMES);

const MAX_BOARD = 12;      // rows kept per game
const MAX_RAW = 400;       // raw score submissions retained per game
const MAX_FEED = 60;       // recent alerts replayed to a late-joining wall

// --------------------------------------------------------------------------- //
//  Event vocabulary
//  Each booth action maps to (severity, DMATICS threat class, heat, geo).
//  `heat` is what drives the SOC's escalation ladder; the wall only reads
//  severity and class, so the two concerns stay separate.
// --------------------------------------------------------------------------- //
const EVENT_TYPES = {
  // --- Red Team Challenge -------------------------------------------------
  run_start:   { level: 6,  heat: 0,  cls: 'RECON',    rule: 'New external session opened against the staff portal' },
  recon:       { level: 8,  heat: 6,  cls: 'RECON',    rule: 'Automated enumeration of public portal and staff directory' },
  auth_fail:   { level: 12, heat: 20, cls: 'CRED',     rule: 'Repeated authentication failure on the staff portal' },
  auth_ok:     { level: 11, heat: 10, cls: 'ACCESS',   rule: 'Interactive logon from an unrecognised source' },
  share_loot:  { level: 12, heat: 14, cls: 'COLLECT',  rule: 'Bulk read of a credential-bearing file on the internal share' },
  ssh_fail:    { level: 13, heat: 28, cls: 'CRED',     rule: 'Remote shell authentication failures against a production host' },
  ssh_ok:      { level: 13, heat: 16, cls: 'ACCESS',   rule: 'Service account shell session established off-window' },
  shell_cmd:   { level: 10, heat: 7,  cls: 'EXEC',     rule: 'Interactive shell command executed by a service account' },
  privesc:     { level: 15, heat: 70, cls: 'PRIVESC',  rule: 'Privilege-escalation attempt blocked by policy' },
  flag:        { level: 12, heat: 12, cls: 'COLLECT',  rule: 'Sensitive artefact accessed on a monitored asset' },
  exfil:       { level: 15, heat: 40, cls: 'EXFIL',    rule: 'Crown-jewel data staged for exfiltration' },
  // --- SOC responses ------------------------------------------------------
  soc_monitor: { level: 9,  heat: 0,  cls: 'ACCESS',   rule: 'Session placed under enhanced inspection by the SOC' },
  soc_throttle:{ level: 14, heat: 0,  cls: 'CONTAIN',  rule: 'Adaptive throttle applied — traffic held for deep inspection' },
  soc_contain: { level: 15, heat: 0,  cls: 'CONTAIN',  rule: 'Containment executed — session terminated and source blocked' },
  run_end:     { level: 7,  heat: 0,  cls: 'ACCESS',   rule: 'Adversary session closed' },
  run_win:     { level: 15, heat: 0,  cls: 'EXFIL',    rule: 'Full compromise achieved — crown jewel exfiltrated' },
  // --- Arcade -------------------------------------------------------------
  arcade_start:{ level: 6,  heat: 0,  cls: 'TRAINING', rule: 'Analyst training simulation started on the visitor tablet' },
  arcade_score:{ level: 7,  heat: 0,  cls: 'TRAINING', rule: 'Analyst training simulation completed and scored' },
};

/* DMATICS threat classification — plain kill-chain phases, no third-party
 * framework identifiers. The wall shows the short code (readable across a
 * hall); the investigation dialog shows the label. Mirrors CLASS in the wall's
 * js/api.js — keep the two in step if you add a phase. */
const CLASS_LABEL = {
  RECON: 'Reconnaissance', INITIAL: 'Initial Access', EXEC: 'Command Execution',
  PERSIST: 'Persistence', PRIVESC: 'Privilege Escalation', EVADE: 'Defence Evasion',
  CRED: 'Credential Access', ACCESS: 'Valid Account Use', DISCOVER: 'Discovery',
  LATERAL: 'Lateral Movement', COLLECT: 'Data Collection', EXFIL: 'Exfiltration',
  C2: 'Command & Control', IMPACT: 'Service Impact', CONTAIN: 'Containment Action',
  TRAINING: 'Training Simulation',
};

/* Where an event "comes from" on the globe.
 *
 * The stations are physically in Hall 4 at DWTC, so a truthful arc would be a
 * dot on Dubai and nothing to look at. Instead each phase is plotted at the
 * exit infrastructure a real operator would route it through — which is also
 * exactly what a SOC sees in the source-IP geolocation. The result is long arcs
 * converging on the Dubai perimeter, which is the shot the booth wants. */
const GEO = {
  RECON:    ['NL', 'Netherlands', 'Amsterdam',  52.3676,   4.9041],
  CRED:     ['RU', 'Russia',      'Moscow',     55.7558,  37.6173],
  ACCESS:   ['RO', 'Romania',     'Bucharest',  44.4268,  26.1025],
  COLLECT:  ['DE', 'Germany',     'Frankfurt',  50.1109,   8.6821],
  EXEC:     ['VN', 'Vietnam',     'Hanoi',      21.0278, 105.8342],
  PRIVESC:  ['KP', 'North Korea', 'Pyongyang',  39.0392, 125.7625],
  LATERAL:  ['SG', 'Singapore',   'Singapore',   1.3521, 103.8198],
  EXFIL:    ['CN', 'China',       'Beijing',    39.9042, 116.4074],
  EVADE:    ['IR', 'Iran',        'Tehran',     35.6892,  51.3890],
  CONTAIN:  ['AE', 'United Arab Emirates', 'Dubai', 25.2048, 55.2708],
  TRAINING: ['AE', 'United Arab Emirates', 'Dubai', 25.2048, 55.2708],
};
const GEO_FALLBACK = ['US', 'United States', 'Ashburn', 39.0438, -77.4874];

// --------------------------------------------------------------------------- //
//  State
// --------------------------------------------------------------------------- //
const state = {
  scores: Object.fromEntries(GAME_KEYS.map((game) => [game, []])), // raw submissions
  feed: [],        // recent normalised alerts (newest first)
  stations: {},    // stationId -> live posture
  startedAt: Date.now(),
  totals: { events: 0, runs: 0, busts: 0, wins: 0 },
};

const wallClients = new Set();                 // SSE: big screen(s)
const stationClients = new Map();              // stationId -> Set<res>

let saveTimer = null;
let dirty = false;

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('not an object');
    /* Validate each row rather than trusting the file. An entry missing `n`
     * used to sail through here and then throw inside leaderboardPayload(),
     * which on /api/stream left the wall with an open connection that never
     * sent anything — a blank screen with no error for the whole show. */
    for (const game of GAME_KEYS) {
      const rows = saved.scores?.[game];
      if (!Array.isArray(rows)) continue;
      state.scores[game] = rows
        .filter((row) => row && typeof row.n === 'string' && Number.isFinite(row.s) && Number.isFinite(row.t))
        .slice(0, MAX_RAW);
    }
    /* Explicit reads, not Object.assign: a crafted file could otherwise reshape
     * state.totals with arbitrary keys, including one named __proto__. */
    for (const key of ['events', 'runs', 'wins', 'busts']) {
      const value = Number(saved.totals?.[key]);
      if (Number.isFinite(value) && value >= 0) state.totals[key] = value;
    }
    log(`state restored — ${GAME_KEYS.reduce((n, g) => n + state.scores[g].length, 0)} score rows`);
  } catch (error) {
    if (error.code !== 'ENOENT') log(`state file unreadable, starting clean (${error.message})`);
  }
}

/* Debounced write. A booth generates a score every few seconds at most, so
 * coalescing into one write per two seconds keeps the disk quiet without
 * risking more than a couple of seconds of loss on a hard power cut. */
function persist() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    try {
      await writeState();
    } finally {
      /* Cleared in `finally`, after the write, not before it. Clearing first
       * let a persist() during an in-flight write schedule a second one, and
       * both wrote to the same .tmp path. */
      saveTimer = null;
    }
  }, 2_000);
}

async function writeState() {
  if (!dirty) return;
  try {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    const payload = JSON.stringify({ scores: state.scores, totals: state.totals, savedAt: Date.now() });
    /* rename(2) is atomic for the directory entry only — it says nothing about
     * whether the DATA reached the platter. Without the fsync, a power cut a
     * second after a write can leave a zero-length or torn arena.json, which
     * loadState then discards as unreadable: the entire leaderboard gone at the
     * start of day two. A booth loses power; that is what booths do. */
    const handle = await fsp.open(`${STATE_FILE}.tmp`, 'w');
    try {
      await handle.writeFile(payload);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsp.rename(`${STATE_FILE}.tmp`, STATE_FILE);
    dirty = false;   // only after the write actually landed, so a failure retries
  } catch (error) {
    log(`could not persist state: ${error.message}`);
  }
}

/* Flush on the way out. There was no signal handler at all, so Ctrl-C or a
 * closed lid at the end of a show day discarded up to two seconds of scores —
 * and if the very first score of a fresh data directory was in flight, all of
 * them. */
let shuttingDown = false;
function flushAndExit(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (saveTimer) clearTimeout(saveTimer);
  try {
    if (dirty) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      /* Same tmp-then-rename as writeState(), and for the same reason it gives
       * there: writeFileSync opens with 'w', which TRUNCATES first. On Windows
       * the launcher stops the hub with `taskkill /F` — TerminateProcess, no
       * unwinding — so a kill landing between the truncate and the write leaves
       * a zero-length arena.json, which loadState discards as unreadable. That
       * is the whole show's leaderboard, lost by the code written to save it.
       * A rename is atomic; the worst case becomes "the last two seconds are
       * missing" rather than "the file is gone". */
      const temporary = `${STATE_FILE}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ scores: state.scores, totals: state.totals, savedAt: Date.now() }));
      fs.renameSync(temporary, STATE_FILE);
      log('state flushed on shutdown');
    }
  } catch (error) {
    log(`could not flush on shutdown: ${error.message}`);
  }
  log(`stopped (${signal})`);
  process.exit(0);
}
/* SIGHUP is what Windows sends when the console window is closed, and SIGBREAK
 * is Ctrl+Break; neither was listened for, so the two ways an operator ends the
 * day that are NOT Ctrl-C both skipped this handler entirely. Registering them
 * is harmless on Linux. */
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  try { process.on(signal, () => flushAndExit(signal)); } catch { /* not on this platform */ }
}

const log = (message) => console.log(`[hub ${new Date().toISOString().slice(11, 19)}] ${message}`);

// --------------------------------------------------------------------------- //
//  Helpers
// --------------------------------------------------------------------------- //
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/* Same name rules as the arcade and the API route, so one player is one row on
 * the board no matter which screen they played on. */
function cleanName(value) {
  const cleaned = String(value ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ._-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 14)
    .trim();
  return cleaned || 'PLAYER';
}

function cleanStation(value) {
  const cleaned = String(value ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '')
    .slice(0, 16);
  return cleaned || 'UNKNOWN';
}

/* Escape, do not strip.
 *
 * This used to delete < and > and leave & " ' alone, which is not escaping —
 * it is mangling. A legitimate title of `user <admin@x> flagged` rendered as
 * `user admin@x flagged`, and the only thing standing between an attacker's
 * `title` and the wall's innerHTML was the incidental absence of one character.
 * The wall now escapes on its own side too; this makes it correct on both. */
const HTML_ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const MAX_STATIONS = 64;
const POSTURES = ['CLEAR', 'WATCHED', 'THROTTLED', 'CONTAINED', 'COMPROMISED'];
const escapeText = (value, max = 160) =>
  String(value ?? '').slice(0, max).replace(/[&<>"']/g, (character) => HTML_ENTITIES[character]);

let eventSequence = 0;
const nextId = (prefix) => `${prefix}-${Date.now().toString(36)}-${(eventSequence += 1).toString(36)}`;

// --------------------------------------------------------------------------- //
//  Normalisation — booth event  →  SOC Wall alert contract
//  Field-for-field the shape `fetchAlerts()` already returns, plus a `gisec`
//  block the wall uses for the arena-specific panels. Anything that only reads
//  the standard fields (globe, origins, timeline) needs no
//  changes at all.
// --------------------------------------------------------------------------- //
function normaliseEvent(input) {
  // Object.hasOwn, not truthiness: EVENT_TYPES['constructor'] is truthy, and
  // a 'constructor' kind produced an alert with null level and no class that
  // was then broadcast to every wall client.
  const kind = Object.hasOwn(EVENT_TYPES, input.kind) ? input.kind : 'shell_cmd';
  const spec = EVENT_TYPES[kind];
  const [code, country, city, latitude, longitude] = GEO[spec.cls] ?? GEO_FALLBACK;
  const station = cleanStation(input.station);
  const player = cleanName(input.player);
  const level = clamp(Number(input.level) || spec.level, 5, 15);

  return {
    id: nextId('gisec'),
    ts: Date.now(),
    level,
    rule: escapeText(input.title || spec.rule),
    agent: station,
    srcCountry: code,
    srcCountryName: country,
    srcCity: city,
    // A little scatter so repeat events from one station do not stack into a
    // single pixel on the globe.
    srcLat: latitude + (Math.random() * 0.9 - 0.45),
    srcLon: longitude + (Math.random() * 0.9 - 0.45),
    tclass: spec.cls,
    category: CLASS_LABEL[spec.cls] ?? 'Unclassified',
    confidence: clamp(level * 6 + 8, 55, 99),
    risk: clamp(level * 7, 40, 99),
    status: input.contained ? 'Contained' : 'Investigating',
    // --- arena extension ---
    gisec: {
      kind,
      source: input.source === 'arcade' ? 'arcade' : 'redteam',
      station,
      player,
      detail: escapeText(input.detail, 220),
      // spec.heat was never read anywhere: every event type carries a weight
      // (privesc 70, exfil 40) and all of them were ignored, so an event that
      // omitted `heat` scored zero AND reset the station's accumulated heat to
      // zero. The escalation ladder the wall is built around never fired from
      // server-side weights at all.
      heat: clamp(Number.isFinite(Number(input.heat)) ? Number(input.heat) : spec.heat, 0, 100),
      // The only field that used to bypass every sanitiser — unbounded length,
      // any type, and written straight into state that is re-broadcast forever.
      posture: POSTURES.includes(input.posture) ? input.posture : null,
      game: GAMES[input.game] ? input.game : null,
      points: Number.isFinite(Number(input.points)) ? Number(input.points) : null,
      stage: escapeText(input.stage, 40) || null,
    },
  };
}

// --------------------------------------------------------------------------- //
//  Station posture — what the wall shows per red team laptop
// --------------------------------------------------------------------------- //
function touchStation(alert) {
  const { station, player, heat, posture, kind } = alert.gisec;
  if (station === 'UNKNOWN') return null;
  /* A station id is any 1-16 chars of [A-Z0-9-], so the map has ~37^16 possible
   * keys and nothing capped it. Measured: ~12,000 new stations a second from a
   * single unauthenticated POST loop, each one also fanning out a broadcast to
   * every wall client. The booth has four stations; sixty-four is generous. */
  const known = Object.hasOwn(state.stations, station);
  if (!known && Object.keys(state.stations).length >= MAX_STATIONS) return null;

  const existing = state.stations[station] ?? {
    id: station, player: null, heat: 0, posture: 'CLEAR',
    stage: null, points: 0, flags: 0, events: 0, startedAt: Date.now(), lastSeen: 0, active: false,
  };
  existing.player = player !== 'PLAYER' ? player : existing.player;
  existing.heat = heat;
  existing.lastSeen = alert.ts;
  existing.events += 1;
  if (alert.gisec.stage) existing.stage = alert.gisec.stage;
  if (Number.isFinite(alert.gisec.points)) existing.points = clamp(alert.gisec.points, 0, 100_000);
  if (posture) existing.posture = posture;
  if (kind === 'run_start') {
    // player and stage were not reset, so the next visitor's fresh run showed
    // up on the wall credited to the previous one, already at the final stage.
    Object.assign(existing, {
      startedAt: alert.ts, active: true, heat: 0, posture: 'CLEAR',
      points: 0, flags: 0, events: 1,
      player: player !== 'PLAYER' ? player : null, stage: null,
    });
    state.totals.runs += 1;
  }
  if (kind === 'flag' || kind === 'exfil') existing.flags += 1;
  if (kind === 'soc_contain') { existing.active = false; existing.posture = 'CONTAINED'; state.totals.busts += 1; }
  if (kind === 'run_win') { existing.active = false; existing.posture = 'COMPROMISED'; state.totals.wins += 1; }
  if (kind === 'run_end') { existing.active = false; }
  state.stations[station] = existing;
  return existing;
}

/* Stations go quiet when a visitor simply walks away mid-run. Age them out so
 * the wall never shows a ghost operator from forty minutes ago. */
function reapStations() {
  const cutoff = Date.now() - 15 * 60_000;
  for (const [id, station] of Object.entries(state.stations)) {
    if (station.lastSeen < cutoff) delete state.stations[id];
    else if (station.active && station.lastSeen < Date.now() - 3 * 60_000) station.active = false;
  }
}
setInterval(reapStations, 60_000).unref();

// --------------------------------------------------------------------------- //
//  Leaderboards
// --------------------------------------------------------------------------- //
/* One row per player per game, keeping their personal best — a visitor who
 * plays Phish Hunter five times occupies one line, not five. */
function boardFor(game) {
  const best = new Map();
  for (const entry of state.scores[game] ?? []) {
    if (!entry || typeof entry.s !== 'number' || typeof entry.n !== 'string') continue;
    const key = entry.n.toUpperCase();
    const current = best.get(key);
    if (!current || entry.s > current.s) best.set(key, entry);
  }
  return [...best.values()].sort((left, right) =>
    right.s - left.s ||
    ((left.meta?.seconds ?? Infinity) - (right.meta?.seconds ?? Infinity)) ||
    left.t - right.t
    ).slice(0, MAX_BOARD);
}

/* The overall board is the crowd-puller: it is not a raw points total, because
 * Red Team maxes at 100 and Breach Point can pass 2,000 — summing them would
 * make the arcade the only game that matters. Each game is normalised to 1,000
 * points at that game's current top score, so being best-in-class counts the
 * same everywhere, and playing more games beats grinding one. */
function overallBoard() {
  const normalised = new Map();
  for (const game of GAME_KEYS) {
    const board = boardFor(game);
    const top = board[0]?.s || 1;
    board.forEach((entry) => {
      const key = entry.n.toUpperCase();
      const row = normalised.get(key) ?? { n: entry.n, s: 0, games: [], t: entry.t };
      row.s += Math.round((entry.s / top) * 1_000);
      row.games.push(game);
      row.t = Math.min(row.t, entry.t);
      normalised.set(key, row);
    });
  }
  return [...normalised.values()]
    .sort((left, right) => right.s - left.s || right.games.length - left.games.length)
    .slice(0, MAX_BOARD);
}

function leaderboardPayload() {
  const boards = Object.fromEntries(GAME_KEYS.map((game) => [game, boardFor(game)]));
  boards.overall = overallBoard();
  return {
    boards,
    games: GAMES,
    totals: {
      ...state.totals,
      players: new Set(GAME_KEYS.flatMap((game) => (state.scores[game] ?? []).filter((entry) => entry && typeof entry.n === 'string').map((entry) => entry.n.toUpperCase()))).size,
    },
    updatedAt: Date.now(),
  };
}

// --------------------------------------------------------------------------- //
//  SSE plumbing
// --------------------------------------------------------------------------- //
function openStream(response) {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  });
  response.write(': gisec arena hub\n\n');
}

function send(response, event, data) {
  /* Backpressure. response.write() returning false means Node is buffering,
   * and the return value used to be discarded — so one reader that stopped
   * reading (a laptop with its lid shut, a wifi client with a zero window)
   * buffered without limit. Measured: 51 MB to 200 MB of RSS and still
   * climbing, while /api/health cheerfully reported the client as connected.
   * A megabyte behind is not coming back; drop it and let the close handler
   * evict it. */
  try {
    if (response.writableEnded || response.destroyed) return false;
    if (response.writableLength > 1_000_000) { response.destroy(); return false; }
    return response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch { return false; }
}

function broadcastWall(event, data) {
  for (const client of wallClients) send(client, event, data);
}

function broadcastStation(stationId, event, data) {
  const clients = stationClients.get(stationId);
  if (!clients) return 0;
  for (const client of clients) send(client, event, data);
  return clients.size;
}

// Keep-alive: proxies and browsers drop an idle SSE socket after ~60s.
setInterval(() => {
  for (const client of wallClients) { try { client.write(': ping\n\n'); } catch {} }
  for (const clients of stationClients.values()) {
    for (const client of clients) { try { client.write(': ping\n\n'); } catch {} }
  }
}, 20_000).unref();

// --------------------------------------------------------------------------- //
//  Core actions
// --------------------------------------------------------------------------- //
function ingestEvent(input) {
  const alert = normaliseEvent(input);
  const station = touchStation(alert);
  state.totals.events += 1;
  state.feed.unshift(alert);
  if (state.feed.length > MAX_FEED) state.feed.length = MAX_FEED;
  /* The totals this function mutates — events, runs, wins, busts — only ever
   * reached disk as a side effect of an unrelated score post. A red team run
   * that ended without an arcade score contributed nothing to the persisted
   * numbers; a hub started fresh and given a full run wrote no state file at
   * all.
   *
   * This call used to sit AFTER the return below, so it never ran once — the
   * comment described a fix that was not in effect. */
  persist();

  broadcastWall('alert', alert);
  if (station) broadcastWall('station', station);
  return alert;
}

function ingestScore(input) {
  const game = Object.hasOwn(GAMES, input.game) ? input.game : null;
  if (!game) return null;
  const entry = {
    n: cleanName(input.player ?? input.name),
    s: clamp(Math.round(Number(input.points ?? input.score) || 0), 0, 100_000),
    t: Date.now(),
    station: cleanStation(input.station),
    meta: {
      flags: Number(input.meta?.flags) || 0,
      seconds: Number(input.meta?.seconds) || 0,
      finished: Boolean(input.meta?.finished),
      accuracy: Number.isFinite(Number(input.meta?.accuracy)) ? Number(input.meta.accuracy) : null,
    },
  };
  state.scores[game].unshift(entry);
  /* Evict the WEAKEST row, not the oldest.
   *
   * This used to be `length = MAX_RAW`, i.e. keep the newest 400 and drop the
   * tail. boardFor() derives the whole leaderboard from this window, so a
   * record set on day one was silently deleted once 400 later plays arrived —
   * measured: CHAMPION on 9,999 gone after 400 submissions, and because
   * overallBoard() normalises every game to its own top score, losing the
   * record retroactively rescored every player in the cross-game board too.
   * 400 plays of one arcade game across a four-day show is a Tuesday. */
  if (state.scores[game].length > MAX_RAW) {
    const keep = new Map();       // best row per player, always survives
    for (const row of state.scores[game]) {
      if (!row || typeof row.s !== 'number' || typeof row.n !== 'string') continue;
      const key = row.n.toUpperCase();
      const current = keep.get(key);
      if (!current || row.s > current.s) keep.set(key, row);
    }
    const champions = new Set(keep.values());
    const survivors = state.scores[game].filter((row) => champions.has(row));
    for (const row of state.scores[game]) {
      if (survivors.length >= MAX_RAW) break;
      if (!champions.has(row)) survivors.push(row);
    }
    state.scores[game] = survivors.slice(0, MAX_RAW);
  }
  persist();
  // `scores` / `persistent` are the arcade's expected reply shape; the wall reads
  // `leaderboard`. Both in one response so either client can post here.
  const payload = { game, entry, scores: boardFor(game), persistent: true,
                    leaderboard: leaderboardPayload() };
  broadcastWall('score', payload);
  return payload;
}

/* A containment order travelling the other way: SOC → game.
 *
 * The red team laptop holds a station stream open; when this fires, its
 * hubwatch.js takes the screen over. The wall shows the same command at the
 * same moment, so the crowd sees the SOC act and the player get hit by it. */
function issueCommand(input) {
  const station = cleanStation(input.station);
  const action = ['monitor', 'throttle', 'contain', 'release'].includes(input.action) ? input.action : 'monitor';
  const command = {
    id: nextId('cmd'),
    ts: Date.now(),
    station,
    action,
    seconds: clamp(Number(input.seconds) || (action === 'throttle' ? 12 : 0), 0, 120),
    title: escapeText(input.title) || defaultCommandTitle(action),
    reason: escapeText(input.reason, 240) || defaultCommandReason(action),
    heat: clamp(Number(input.heat) || 0, 0, 100),
  };
  /* The game that raised the alarm has usually already told its own player, in
   * the HTTP reply that triggered the response — that is the path that survives
   * the hub being down, so it stays authoritative. Pushing the same order down
   * the station's stream as well would fire the takeover twice, so a caller has
   * to ask for it. A booth operator containing a station by hand from the wall
   * does ask for it; the Flask app does not. */
  // Opt-in, matching what the comment above says: a client sending "false",
  // 0 or null used to get the takeover fired anyway, on top of its own.
  const notify = input.notifyStation === true;
  const delivered = notify ? broadcastStation(station, 'command', command) : 0;
  broadcastWall('command', { ...command, delivered });
  if (state.stations[station]) {
    state.stations[station].posture =
      action === 'contain' ? 'CONTAINED' : action === 'throttle' ? 'THROTTLED' : action === 'monitor' ? 'WATCHED' : 'CLEAR';
    broadcastWall('station', state.stations[station]);
  }
  log(`command ${action} → ${station} (${delivered} listener${delivered === 1 ? '' : 's'})`);
  return { ...command, delivered };
}

const defaultCommandTitle = (action) => ({
  monitor: 'SOC ADVISORY — SESSION UNDER INSPECTION',
  throttle: 'SOC RESPONSE — ADAPTIVE THROTTLE ENGAGED',
  contain: 'SOC RESPONSE — SESSION CONTAINED',
  release: 'INSPECTION COMPLETE — SESSION RELEASED',
}[action]);

const defaultCommandReason = (action) => ({
  monitor: 'Correlated detections raised the risk score on this session. Activity is now being recorded in full.',
  throttle: 'Traffic from this session is being held for deep packet inspection. Your operation is paused.',
  contain: 'Malicious activity confirmed. The session has been terminated and the source address blocked.',
  release: 'Inspection finished. The session has been returned to normal routing.',
}[action]);

// --------------------------------------------------------------------------- //
//  HTTP
// --------------------------------------------------------------------------- //
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};

/* A browser cannot lie about Origin. Requests with no Origin at all (curl, the
 * Flask app's own emitter, a native client) are allowed through — this closes
 * the drive-by web page, which is the realistic threat on a show floor, and
 * ADMIN_TOKEN closes the rest when it is set. */
function sameOriginRequest(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const host = request.headers.host;
    return !!host && new URL(origin).host === host;
  } catch { return false; }
}

function json(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS });
  response.end(payload);
}

function readBody(request, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(new Error('payload too large')); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        /* A body of literal `null`, `3` or `"x"` is valid JSON, so it used to
         * resolve and then throw on the first property read — turning a
         * malformed request into a 400 with an internal error message in it,
         * and on /api/admin/reset into a 400 instead of a 401. Hand every
         * route an object or nothing. */
        resolve(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {});
      } catch { reject(new Error('invalid json')); }
    });
    request.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.map': 'application/json',
};

/* Security headers for everything the hub serves.
 *
 * The hub hands out the SOC wall and the arcade to every device on the show
 * wifi, and it was doing so with no headers at all. The CSP is written around
 * what these two pages actually are: the wall is a Vite build (external module
 * scripts only, so no 'unsafe-inline' for script) that carries a handful of
 * inline style attributes and pulls its typefaces from Google Fonts; the arcade
 * is one self-contained document with an inline <script>, which is what makes it
 * work off a USB stick with no network.
 *
 * connect-src stays open to http:/https: because the wall may be pointed at a
 * hub on another booth machine whose address is not known until show morning.
 */
const WALL_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "connect-src 'self' http: https:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ');

// The arcade document is one file with its own inline script and styles.
const ARCADE_CSP = WALL_CSP.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'");

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'SAMEORIGIN',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

async function serveStatic(response, root, relative, csp = WALL_CSP, head = false) {
  if (!root) return false;
  // Resolve then confirm containment — blocks ../ traversal.
  const base = path.resolve(root);
  const target = path.resolve(base, `.${path.posix.normalize(`/${decodeURIComponent(relative)}`)}`);
  /* startsWith(base) alone is not containment: with base "C:\\srv\\wall", the path
   * "C:\\srv\\wall-secrets\\x" passes the prefix test. Compare against base plus a
   * separator, and allow base itself. Same class of hole on both platforms;
   * path.sep keeps it correct on Windows, where the separator is a backslash. */
  if (target !== base && !target.startsWith(base + path.sep)) return false;
  /* Windows resolves "index.html::$DATA", "index.html." and "index.html " to
   * index.html, so all three stat and read fine — but path.extname() sees
   * ".html::$DATA" and the MIME table and the .html cache rule both miss. The
   * wall's index page then goes out as application/octet-stream with a 5-minute
   * cache: a download prompt instead of a page, and a stale one on show morning.
   * These are not names any real request uses. */
  const leaf = path.basename(target);
  if (leaf.includes(':') || /[. ]$/.test(leaf)) return false;
  try {
    const stats = await fsp.stat(target);
    const file = stats.isDirectory() ? path.join(target, 'index.html') : target;
    const data = await fsp.readFile(file);
    response.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': path.extname(file) === '.html' ? 'no-cache, no-store, must-revalidate' : 'public, max-age=300',
      'Content-Security-Policy': csp,
      ...SECURITY_HEADERS,
      ...CORS,
    });
    // On HEAD, the headers above are the whole answer — Node drops the body
    // anyway, but writing it is pointless work on a 1.3 MB globe bundle.
    response.end(head ? undefined : data);
    return true;
  } catch {
    return false;
  }
}

const server = http.createServer(async (request, response) => {
  /* WHATWG URL, not url.parse().
   *
   * Node 22.13+ prints a DEP0169 deprecation warning for url.parse() saying its
   * behaviour "is not standardized and prone to errors that have security
   * implications. CVEs are not issued for url.parse() vulnerabilities." That is
   * not a line anyone wants scrolling up the console at a security company's
   * trade-show stand, and the advice is correct: url.parse is lenient about
   * malformed input in ways the WHATWG parser is not.
   *
   * The base is a placeholder — request.url on a server is always a path, and
   * the URL constructor needs an origin to resolve it against. `query` keeps the
   * plain-object shape the three call sites below expect. */
  let parsed;
  try {
    parsed = new URL(request.url, 'http://localhost');
  } catch {
    return json(response, 400, { ok: false, error: 'bad request line' });
  }
  const pathname = parsed.pathname;
  const query = Object.fromEntries(parsed.searchParams);

  if (request.method === 'OPTIONS') { response.writeHead(204, CORS); response.end(); return; }

  try {
    // ---- health -----------------------------------------------------------
    if (pathname === '/api/health') {
      return json(response, 200, {
        ok: true, service: 'gisec-arena-hub', event: 'GISEC 2026',
        uptimeSeconds: Math.round((Date.now() - state.startedAt) / 1000),
        wallClients: wallClients.size,
        stations: Object.fromEntries([...stationClients].map(([id, set]) => [id, set.size])),
        totals: state.totals,
      });
    }

    // ---- snapshot for a late joiner ---------------------------------------
    if (pathname === '/api/state') {
      return json(response, 200, {
        feed: state.feed.slice(0, 24),
        stations: Object.values(state.stations),
        ...leaderboardPayload(),
      });
    }

    if (pathname === '/api/leaderboard') {
      const game = query.game;
      if (game && Object.hasOwn(GAMES, game)) return json(response, 200, { game, board: boardFor(game) });
      if (game === 'overall') return json(response, 200, { game, board: overallBoard() });
      return json(response, 200, leaderboardPayload());
    }

    /* Arcade compatibility.
     *
     * game.html already knows how to talk to `GET /api/scores?game=phish` — that is
     * how it reaches its Next.js host. Answering in the same shape here means that
     * when the arcade is served off the hub (`/arcade`), its own on-screen board is
     * backed by the shared arena board instead of falling back to the tablet's
     * localStorage. No change to the arcade for that to work. */
    if (pathname === '/api/scores' && request.method === 'GET') {
      const game = query.game;
      if (!Object.hasOwn(GAMES, game)) return json(response, 400, { error: 'unknown game' });
      return json(response, 200, { game, scores: boardFor(game), persistent: true });
    }

    // ---- wall stream -------------------------------------------------------
    if (pathname === '/api/stream' && request.method === 'GET') {
      openStream(response);
      wallClients.add(response);
      /* Cleanup is registered BEFORE the hello payload is built, not after.
       * leaderboardPayload() runs outside send()'s try, so anything it throws
       * used to skip this line entirely: the wall got an open connection that
       * never sent data and never errored — so EventSource never retried and
       * the big screen stayed blank — while the hub kept a dead response in
       * wallClients forever and wrote every future broadcast into it. */
      request.on('close', () => { wallClients.delete(response); log(`wall disconnected (${wallClients.size} left)`); });
      log(`wall connected (${wallClients.size} total)`);
      try {
        send(response, 'hello', {
          feed: state.feed.slice(0, 24),
          stations: Object.values(state.stations),
          ...leaderboardPayload(),
        });
      } catch (error) {
        log(`hello payload failed: ${error.message}`);
        response.destroy();
      }
      return;
    }

    // ---- station command stream (red team laptops) -------------------------
    if (pathname === '/api/command/stream' && request.method === 'GET') {
      const station = cleanStation(query.station);
      openStream(response);
      if (!stationClients.has(station)) stationClients.set(station, new Set());
      stationClients.get(station).add(response);
      request.on('close', () => {
        const clients = stationClients.get(station);
        if (!clients) return;
        clients.delete(response);
        if (!clients.size) stationClients.delete(station);
      });
      log(`station ${station} connected (${stationClients.get(station).size} listener(s))`);
      send(response, 'hello', { station, ts: Date.now() });
      return;
    }

    // ---- ingest ------------------------------------------------------------
    if (pathname === '/api/events' && request.method === 'POST') {
      const body = await readBody(request);
      const batch = Array.isArray(body.events) ? body.events : [body];
      const accepted = batch.slice(0, 20).map((item) => ingestEvent(item));
      return json(response, 200, { ok: true, accepted: accepted.length, alerts: accepted });
    }

    if (pathname === '/api/scores' && request.method === 'POST') {
      const body = await readBody(request);
      const result = ingestScore(body);
      if (!result) return json(response, 400, { ok: false, error: `unknown game — expected one of ${GAME_KEYS.join(', ')}` });
      log(`score ${result.entry.n} ${result.game} ${result.entry.s}`);
      return json(response, 200, { ok: true, ...result });
    }

    if (pathname === '/api/command' && request.method === 'POST') {
      /* This endpoint takes over a red team laptop mid-run and posts a
       * containment to the wall. It was completely ungated, and a cross-origin
       * POST with Content-Type: text/plain is a CORS *simple* request — no
       * preflight — so any web page opened on any phone joined to the booth
       * wifi could end a visitor's run and fake a containment on the big
       * screen. The admin reset next to it was already token-gated; this was
       * not, and it is the one that ruins a live demo.
       *
       * Two gates, in order of how much they cost the crew:
       *   - a browser always sends Origin on a cross-origin POST, so rejecting
       *     a foreign Origin closes the drive-by case with no configuration;
       *   - if ADMIN_TOKEN is set, require it, which closes the curl case too. */
      if (!sameOriginRequest(request)) {
        return json(response, 403, { ok: false, error: 'cross-origin command refused' });
      }
      const body = await readBody(request);
      if (ADMIN_TOKEN && String(body.token || '') !== ADMIN_TOKEN) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        return json(response, 401, { ok: false, error: 'bad token' });
      }
      return json(response, 200, { ok: true, command: issueCommand(body) });
    }

    // ---- admin -------------------------------------------------------------
    if (pathname === '/api/admin/reset' && request.method === 'POST') {
      const body = await readBody(request);
      /* Hashed compare. `a !== b` on strings short-circuits on the first
       * differing byte and on a length mismatch, which is a timing oracle on a
       * credential that wipes the show's leaderboard. Both sides become 32
       * bytes first, so every comparison costs the same. */
      const digest = (value) => crypto.createHash('sha256').update(String(value ?? '')).digest();
      const same = (a, b) => crypto.timingSafeEqual(digest(a), digest(b));

      const byToken = Boolean(ADMIN_TOKEN) && Object.hasOwn(body, 'token');
      const byLogin = Boolean(ADMIN_USER && ADMIN_PASSWORD) && Object.hasOwn(body, 'user');

      if (!byToken && !byLogin) {
        return json(response, 503, {
          ok: false,
          error: (ADMIN_TOKEN || (ADMIN_USER && ADMIN_PASSWORD))
            ? 'Send either {token} or {user, pass}.'
            : 'Reset is disabled: set ADMIN_TOKEN, or ADMIN_USER and ADMIN_PASSWORD, on the hub.',
        });
      }
      const authorised = byToken
        ? same(body.token, ADMIN_TOKEN)
        : same(body.user, ADMIN_USER) && same(body.pass, ADMIN_PASSWORD);
      if (!authorised) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));   // slow a guesser down
        return json(response, 401, {
          ok: false,
          error: byToken ? 'bad token' : 'Wrong username or password.',
        });
      }
      for (const game of GAME_KEYS) state.scores[game] = [];
      state.feed = [];
      state.stations = {};
      state.totals = { events: 0, runs: 0, busts: 0, wins: 0 };
      persist();
      broadcastWall('score', { game: null, entry: null, leaderboard: leaderboardPayload() });
      log('ALL BOARDS CLEARED by admin');

      /* One button, every board. The arcade's own copy is cleared by the page
       * itself; the hub's is cleared above; the red team keeps a separate
       * SQLite board on the laptops and has to be asked. Best effort and
       * REPORTED — "all cleared" when one surface was unreachable is the worst
       * thing this can say, because the crew walks away and the wall is still
       * showing yesterday. */
      const surfaces = [{ name: 'hub', ok: true, detail: 'arena cleared' }];
      if (!REDTEAM_URL) {
        surfaces.push({ name: 'red team', ok: false, detail: 'REDTEAM_URL is not set on the hub' });
      } else if (!ADMIN_TOKEN) {
        surfaces.push({ name: 'red team', ok: false, detail: 'ADMIN_TOKEN is not set on the hub' });
      } else {
        try {
          const reply = await fetch(`${REDTEAM_URL}/admin/reset`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Admin-Token': ADMIN_TOKEN },
            body: '{}',
            signal: AbortSignal.timeout(6_000),
          });
          const payload = await reply.json().catch(() => ({}));
          surfaces.push(reply.ok && payload.ok !== false
            ? { name: 'red team', ok: true, detail: `cleared ${payload.rows ?? 0} run(s)` }
            : { name: 'red team', ok: false, detail: payload.error || `HTTP ${reply.status}` });
        } catch (error) {
          const raw = String(error?.message || error);
          surfaces.push({
            name: 'red team',
            ok: false,
            detail: /timeout|abort/i.test(raw)
              ? 'no answer within 6s — is it running?'
              : `unreachable at ${REDTEAM_URL} — is it running, and on this network?`,
          });
        }
      }
      const failed = surfaces.filter((s) => !s.ok);
      return json(response, 200, {
        ok: true,
        surfaces,
        message: failed.length
          ? `Arena cleared. Could not clear: ${failed.map((s) => s.name).join(', ')}.`
          : `Cleared ${surfaces.map((s) => s.name).join(', ')}.`,
      });
    }

    // Removes ONE handle from ONE game's board on the hub's own cache — the
    // arena board the wall reads. Started as red-team-only (the pairing to its
    // "one shot per name" rule in app.py, name_taken()); now covers all four
    // games, since the arcade needs the exact same "remove one player" action
    // for Phish Hunter / Alert Rush / Breach Point. Same auth as
    // /api/admin/reset; clears far less.
    //
    // Red team keeps a second, authoritative copy on its own SQLite file (see
    // save_score() in app.py) — this forwards to it too, or the wall would show
    // a name the challenge itself already dropped. The arcade's three games
    // have no such second hop from here: their source of truth is the arcade's
    // own store (lib/store.js), which the ARCADE's /api/admin/clear-name route
    // clears directly before it ever calls this one — this endpoint only ever
    // owns the hub's cached copy for them.
    if (pathname === '/api/admin/clear-name' && request.method === 'POST') {
      const body = await readBody(request);
      const digest = (value) => crypto.createHash('sha256').update(String(value ?? '')).digest();
      const same = (a, b) => crypto.timingSafeEqual(digest(a), digest(b));

      const byToken = Boolean(ADMIN_TOKEN) && Object.hasOwn(body, 'token');
      const byLogin = Boolean(ADMIN_USER && ADMIN_PASSWORD) && Object.hasOwn(body, 'user');

      if (!byToken && !byLogin) {
        return json(response, 503, {
          ok: false,
          error: (ADMIN_TOKEN || (ADMIN_USER && ADMIN_PASSWORD))
            ? 'Send either {token} or {user, pass}.'
            : 'Reset is disabled: set ADMIN_TOKEN, or ADMIN_USER and ADMIN_PASSWORD, on the hub.',
        });
      }
      const authorised = byToken
        ? same(body.token, ADMIN_TOKEN)
        : same(body.user, ADMIN_USER) && same(body.pass, ADMIN_PASSWORD);
      if (!authorised) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        return json(response, 401, {
          ok: false,
          error: byToken ? 'bad token' : 'Wrong username or password.',
        });
      }

      const player = typeof body.player === 'string' ? body.player.trim() : '';
      if (!player) return json(response, 400, { ok: false, error: 'no player name given' });
      // Defaults to 'redteam' for existing callers that pre-date the `game`
      // field (the red team challenge itself never sends one). An unknown
      // value falls back the same way rather than 400ing a booth action.
      const game = GAME_KEYS.includes(body.game) ? body.game : 'redteam';
      const key = player.toUpperCase();

      const before = state.scores[game]?.length ?? 0;
      state.scores[game] = (state.scores[game] ?? []).filter(
        (entry) => !(entry && typeof entry.n === 'string' && entry.n.toUpperCase() === key)
      );
      const removedHere = before - state.scores[game].length;
      if (removedHere) {
        persist();
        broadcastWall('score', { game, entry: null, leaderboard: leaderboardPayload() });
      }
      log(`cleared handle ${JSON.stringify(player)} from the ${game} arena board (${removedHere} row(s))`);

      const surfaces = [{ name: 'hub', ok: true, detail: `removed ${removedHere} row(s)` }];
      if (game === 'redteam') {
        if (!REDTEAM_URL) {
          surfaces.push({ name: 'red team', ok: false, detail: 'REDTEAM_URL is not set on the hub' });
        } else if (!ADMIN_TOKEN) {
          surfaces.push({ name: 'red team', ok: false, detail: 'ADMIN_TOKEN is not set on the hub' });
        } else {
          try {
            const reply = await fetch(`${REDTEAM_URL}/admin/clear-name`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-Admin-Token': ADMIN_TOKEN },
              body: JSON.stringify({ player }),
              signal: AbortSignal.timeout(6_000),
            });
            const payload = await reply.json().catch(() => ({}));
            surfaces.push(reply.ok && payload.ok !== false
              ? { name: 'red team', ok: true, detail: `removed ${payload.rows ?? 0} row(s)` }
              : { name: 'red team', ok: false, detail: payload.error || `HTTP ${reply.status}` });
          } catch (error) {
            const raw = String(error?.message || error);
            surfaces.push({
              name: 'red team',
              ok: false,
              detail: /timeout|abort/i.test(raw)
                ? 'no answer within 6s — is it running?'
                : `unreachable at ${REDTEAM_URL} — is it running, and on this network?`,
            });
          }
        }
      }
      const failed = surfaces.filter((s) => !s.ok);
      return json(response, 200, {
        ok: true,
        player,
        game,
        surfaces,
        message: failed.length
          ? `Could not fully clear "${player}": ${failed.map((s) => s.name).join(', ')}.`
          : `"${player}" removed from ${surfaces.map((s) => s.name).join(', ')}.`,
      });
    }

    // ---- static (optional convenience) -------------------------------------
    // HEAD too, not only GET. Uptime checks, load balancers and `curl -I` all
    // use HEAD; the wall answered 200 to GET / and 404 to HEAD /, which looks
    // exactly like "the wall is down" to anything watching it that way.
    if (request.method === 'GET' || request.method === 'HEAD') {
      if (pathname === '/arcade' || pathname.startsWith('/arcade/')) {
        const relative = pathname.replace(/^\/arcade\/?/, '') || 'game.html';
        if (await serveStatic(response, ARCADE_DIR, relative, ARCADE_CSP, request.method === 'HEAD')) return;
      }
      if (await serveStatic(response, WALL_DIR, pathname === '/' ? 'index.html' : pathname,
                            WALL_CSP, request.method === 'HEAD')) return;
    }

    json(response, 404, { ok: false, error: 'not found' });
  } catch (error) {
    /* Two changes. Headers may already be sent (an SSE route that threw), and
     * writeHead() then throws again from inside the catch — an unhandled
     * rejection that used to take the request down silently. And the internal
     * message is logged rather than returned: it was leaking absolute paths and
     * internal structure to anyone on the LAN. */
    log(`request failed (${request.method} ${request.url}): ${error && error.message}`);
    if (response.headersSent) { response.destroy(); return; }
    json(response, 400, { ok: false, error: 'bad request' });
  }
});

// A dropped kiosk connection must never take the hub with it.
server.on('clientError', (error, socket) => { try { socket.destroy(); } catch {} });
process.on('uncaughtException', (error) => log(`uncaught: ${error.stack || error}`));
process.on('unhandledRejection', (error) => log(`unhandled rejection: ${error}`));

loadState();
server.listen(PORT, HOST, () => {
  log(`GISEC Arena Hub listening on http://${HOST}:${PORT}`);
  log(`  wall stream    GET  /api/stream`);
  log(`  station stream GET  /api/command/stream?station=LAPTOP-01`);
  log(`  ingest         POST /api/events   POST /api/scores`);
  log(`  boards         GET  /api/leaderboard`);
});

module.exports = { server, ingestEvent, ingestScore, issueCommand, leaderboardPayload };
