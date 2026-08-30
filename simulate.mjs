#!/usr/bin/env node
/* ===========================================================================
 * Rehearse a booth run without a visitor.
 *
 * The bash version needed curl, python3, mktemp and a cookie jar on disk, so it
 * only ran on Linux and macOS. This is the same script in Node — same stages,
 * same pacing, same output — and it runs on Windows too, which is the point.
 *
 *   node simulate.mjs              a noisy operator: held a few times, finishes
 *   node simulate.mjs --clean      a careful operator at human pace: never held
 *   node simulate.mjs --bust       fails four passwords and gets contained
 *   node simulate.mjs --arcade     just drop arcade scores on the board
 *
 * Point it elsewhere with environment variables:
 *   RT=http://192.168.1.50:8000  HUB=http://192.168.1.50:7788  node simulate.mjs
 * ========================================================================= */

const RT = process.env.RT || "http://127.0.0.1:8000";
const HUB = process.env.HUB || "http://127.0.0.1:7788";
const STATION = process.env.STATION || "LAPTOP-02";

const FLAGS = [
  "DMATICS{r3c0n_c0mpl3t3}",
  "DMATICS{w3ak_p@ssw0rd_pwn3d}",
  "DMATICS{cr3ds_1n_th3_sh@re}",
  "DMATICS{sh3ll_@cc3ss_g@in3d}",
  "DMATICS{cr0wn_jewel_5ecur3d}",
];

// ---- terminal ---------------------------------------------------------------
const COLOUR = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, text) => (COLOUR ? `\x1b[${code}m${text}\x1b[0m` : text);
const bold = (t) => c("1", t), dim = (t) => c("2", t), cyan = (t) => c("36", t);
const amber = (t) => c("33", t), red = (t) => c("31", t), green = (t) => c("32", t);

const step = (t) => console.log(`\n${bold("▸ " + t)}`);
const info = (t) => console.log(`   ${dim(t)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- arguments --------------------------------------------------------------
const arg = process.argv[2] ?? "";
if (arg === "-h" || arg === "--help") {
  console.log(`
${bold("Rehearse a booth run")}

  node simulate.mjs              noisy operator: held a few times, finishes
  node simulate.mjs --clean      careful operator: the SOC leaves them alone
  node simulate.mjs --bust       fails four passwords and gets contained
  node simulate.mjs --arcade     drop arcade scores on the leaderboard

  RT= HUB= STATION=   point it at another machine
`);
  process.exit(0);
}
const MODE = { "--clean": "clean", "--bust": "bust", "--arcade": "arcade", "": "noisy" }[arg];
if (!MODE) { console.error(`unknown option: ${arg}`); process.exit(1); }

/* ---- a cookie jar in memory -------------------------------------------------
 * The challenge tracks a run in a Flask session, so every request in a run has
 * to carry the same cookie. fetch() does not keep cookies between calls, so the
 * jar is kept here rather than in a temp file — which also removes the mktemp
 * dependency that made the old script Unix-only. */
const jar = new Map();

function cookieHeader() {
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}
function absorb(response) {
  // getSetCookie() only exists from Node 19.7 / recent 18.x. On an older Node
  // the `?? []` swallowed every cookie, the jar stayed empty, and the whole
  // rehearsal ran unauthenticated — each request 302'd back to the front page
  // and the script printed a green tick for all five flags anyway.
  const raw = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    // A single header is the common case here (Flask sets one session cookie);
    // splitting on commas would break Expires=Wed, 01 Jan …, so do not.
    : [response.headers.get("set-cookie")].filter(Boolean);
  if (!raw.length && !jar.size && !absorb.warned) {
    absorb.warned = true;
    console.error(`   ${amber("!")} no session cookie seen — the rehearsal will not be able to play`);
  }
  for (const line of raw) {
    const [pair] = line.split(";");
    const index = pair.indexOf("=");
    if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }
}

async function call(path, { method = "GET", form, json } = {}) {
  const headers = {};
  const cookies = cookieHeader();
  if (cookies) headers.cookie = cookies;
  let body;
  if (form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(form).toString();
  } else if (json) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(json);
  }
  /* Retry a dropped socket once.
   *
   * gunicorn recycles idle keep-alive connections, and Node's fetch surfaces
   * that as UND_ERR_SOCKET on the next request down the same connection. It is
   * not a failure of anything — but it arrived as an unhandled rejection and the
   * whole rehearsal died with a Node stack trace, which is a terrible thing to
   * put in front of someone at 09:40 on day one. One retry on a transport-level
   * error only; an HTTP error is a real answer and is passed straight through.
   */
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${RT}${path}`, { method, headers, body, redirect: "manual" });
      absorb(response);
      return response;
    } catch (error) {
      if (attempt >= 1) throw error;
      await sleep(250);
    }
  }
}

async function hubPost(path, payload) {
  await fetch(`${HUB}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => {});
}

// ---- the SOC's current opinion of us ----------------------------------------
async function socState() {
  try {
    const response = await call("/soc/state");
    if (!response.headers.get("content-type")?.includes("json")) return null;
    return await response.json();
  } catch { return null; }
}

async function soc() {
  const state = await socState();
  if (!state) return null;
  const heat = Math.round(state.heat ?? 0);
  const posture = state.posture ?? "CLEAR";
  const tint = posture === "WATCHED" ? amber
    : posture === "THROTTLED" || posture === "CONTAINED" ? red : green;
  const bar = "█".repeat(Math.round(heat / 5)).padEnd(20, "·");
  console.log(`   ${dim("SOC")} ${tint(posture.padEnd(10))} ${dim(bar)} ${String(heat).padStart(3)}`);
  return state;
}

/** A held session is refused before it reaches the portal, so wait it out. */
async function waitOutHold() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const state = await socState();
    // The app sends `throttleLeft`. This read `throttle_left`, which is always
    // undefined, so the wait was a no-op: every held request was fired straight
    // into the throttle and refused, and the rehearsal never demonstrated the
    // one mechanic it exists to demonstrate.
    const left = Number(state?.throttleLeft ?? 0);
    if (!left) return;
    if (attempt === 0) info(`held for ${left}s — waiting, this is the SOC working`);
    await sleep(1000);
  }
}

/* Report what the server actually said.
 *
 * This used to fire and forget, so a rehearsal against a broken build printed
 * five green ticks and a "Full compromise" banner while scoring nothing. The
 * point of a rehearsal is to find that out before the doors open. */
let failures = 0;

async function flag(value, label) {
  await waitOutHold();
  const response = await call("/submit", { method: "POST", form: { flag: value } });
  let body = null;
  try { body = await response.json(); } catch { /* redirect or HTML */ }

  if (!body) {
    console.log(`   ${red("✗")} ${label} — no JSON back (HTTP ${response.status}${
      response.status === 302 ? ", session lost or the run has ended" : ""})`);
    failures += 1;
  } else if (body.ok && body.newly) {
    console.log(`   ${green("✓")} ${label} ${dim(value)} ${dim(`(${body.points} pts)`)}`);
  } else if (body.ok && body.already) {
    console.log(`   ${amber("=")} ${label} already captured`);
  } else if (body.held || body.throttled) {
    console.log(`   ${amber("⧗")} ${label} refused — still held by the SOC`);
    failures += 1;
  } else {
    console.log(`   ${red("✗")} ${label} — ${body.msg ?? JSON.stringify(body)}`);
    failures += 1;
  }
  return body;
}

/* Let the heat bleed off before the loud one.
 *
 * The exfil search costs 40 and the capture another 12; from heat 50 that is
 * 102, over the containment line, so the "noisy operator finishes" preset was
 * contained at the last step every single time and reported a failed rehearsal
 * on a perfectly healthy booth. A real visitor who has been held twice does
 * exactly this: reads the SOC banner and waits. Only the noisy preset needs it —
 * the clean preset is already below the line and the bust preset never gets here. */
async function coolTo(target) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const state = await socState();
    const heat = Number(state?.heat ?? 0);
    if (heat <= target) return heat;
    if (attempt === 0) info(`heat ${Math.round(heat)} — waiting for it to fall below ${target} before the loud one`);
    await sleep(1000);
  }
  return null;
}

function banner(title) {
  const line = "─".repeat(Math.max(28, title.length + 4));
  console.log(`\n${cyan(line)}\n${cyan("  " + bold(title))}\n${cyan(line)}`);
}

// ---- preflight --------------------------------------------------------------
async function reachable(url, path) {
  try {
    const response = await fetch(`${url}${path}`, { signal: AbortSignal.timeout(2500) });
    return response.ok;
  } catch { return false; }
}

if (!(await reachable(HUB, "/api/health"))) {
  console.error(red(`\nThe hub is not answering at ${HUB}.`));
  console.error(dim("Start it with:  node start.mjs\n"));
  process.exit(1);
}

// ---- arcade only -------------------------------------------------------------
if (MODE === "arcade") {
  banner("ARCADE SCORES");
  const rows = [
    ["AMIRA", "phish", 2480], ["RASHID", "soc", 2310], ["LENA", "breach", 1970],
    ["OMAR", "phish", 1640], ["JEFF", "breach", 2240], ["PRIYA", "soc", 1880],
    ["KHALID", "phish", 990], ["JEFF", "soc", 1520],
  ];
  for (const [who, game, points] of rows) {
    await hubPost("/api/scores", {
      game, player: who, points, station: "ARCADE-IPAD",
      meta: { accuracy: 88, seconds: 60, finished: true },
    });
    await hubPost("/api/events", {
      source: "arcade", kind: "arcade_score", station: "ARCADE-IPAD",
      player: who, game, points, detail: `${who} scored ${points} at the visitor tablet.`,
    });
    console.log(`   ${who.padEnd(8)} ${game.padEnd(7)} ${String(points).padStart(5)}`);
    await sleep(1200);
  }
  console.log(`\n${green("✓")} ${rows.length} scores on the board — check the arena panel.\n`);
  process.exit(0);
}

// ---- the run -----------------------------------------------------------------
if (!(await reachable(RT, "/health"))) {
  console.error(red(`\nThe Red Team Challenge is not answering at ${RT}.`));
  console.error(dim("Start it with:  ./run-redteam.sh\n"));
  process.exit(1);
}

const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, "");
const PLAYER = `SIM-${stamp}`;

/* A human spends 30–90s per stage reading, copying flags and typing. The clean
 * pace mimics that, which is the only way to show the SOC leaving a tidy
 * operator alone — at any faster pace the heat outruns the decay and the
 * throttles fire, which is the mechanic working, not a bug. */
const PACE = { clean: 14, bust: 1, noisy: 2 }[MODE];
banner({ clean: "CAREFUL OPERATOR · ~3 min", bust: "GETS CONTAINED", noisy: "NOISY OPERATOR" }[MODE]);
info(`operator ${PLAYER} at ${STATION}`);

step("Registering");
{
  const response = await call(`/?station=${STATION}`, { method: "POST", form: { player: PLAYER } });
  // A successful registration redirects to /brief. Anything else — a 200 with
  // the form again, a 500 — means the run never started, and every stage after
  // this would be a redirect the old script reported as a success.
  const location = response.headers.get("location") ?? "";
  if (!(response.status === 302 && location.includes("/brief"))) {
    console.error(red(`\nRegistration failed (HTTP ${response.status}). The run cannot start.`));
    process.exit(1);
  }
}
await soc();

step("Stage 1 · Reconnaissance");
await call("/portal"); await sleep(PACE * 1000);
await call("/portal/directory"); await sleep(PACE * 1000);
await soc();
await flag(FLAGS[0], "FLAG-1");

step("Stage 2 · Credential Access");
if (MODE === "bust") {
  /* Each attempt has to actually LAND, so the hold is waited out first. A
   * throttled attempt is refused before it reaches the portal and does not
   * count against the four — the SOC slowing an attacker down is itself a
   * defence, and it is worth watching happen. */
  for (let n = 1; n <= 4; n += 1) {
    await waitOutHold();
    await call("/portal/login", { method: "POST", form: { username: "john.smith", password: `wrong${n}` } });
    console.log(`   ${amber(`bad password ${n} of 4`)}`);
    const state = await soc();
    if (state?.posture === "CONTAINED") break;
    await sleep(1000);
  }
  const final = await socState();
  if (final?.posture === "CONTAINED") {
    console.log(`\n${red("✗")} Contained. Check the wall: containment band, station goes red.\n`);
  } else {
    console.log(`\n${amber("!")} Survived four attempts — the throttles ate two of them.\n`);
  }
  await call("/finish");
  process.exit(0);
}

if (MODE === "noisy") {
  for (let n = 1; n <= 2; n += 1) {
    await waitOutHold();
    await call("/portal/login", { method: "POST", form: { username: "john.smith", password: `wrong${n}` } });
    console.log(`   ${amber(`bad password ${n}`)}`);
    await soc();
    await sleep(2000);
  }
}

await waitOutHold();
await call("/portal/login", { method: "POST", form: { username: "john.smith", password: "Summer2026" } });
info("logged in as john.smith");
await soc();
await flag(FLAGS[1], "FLAG-2");

step("Stage 3 · Lateral Movement");
await sleep(PACE * 1000);
await call("/dashboard/share");
info("browsing the internal share");
await sleep(PACE * 1000);
await call("/files/passwords.txt");
info("looted passwords.txt");
await soc();
await flag(FLAGS[2], "FLAG-3");

step("Stage 4 · Foothold");
await sleep(PACE * 1000);
/* A noisy operator who has already been held twice does what a real visitor
 * does when the nav meter goes amber: stops, reads the banner, and waits. Three
 * holds now ends a run, so a preset that is meant to demonstrate "noisy but
 * recovers" has to actually recover — otherwise it is just the bust preset with
 * extra steps. */
/* Enter the shell with headroom. Three holds ends a run, and the shell stage
 * is the busiest — an SSH login plus four commands. A noisy operator who
 * arrives here already on two strikes has no room left, which is why this
 * preset used to die at stage 4 rather than demonstrating recovery. */
if (MODE === "noisy") { await coolStrikes(0); await coolTo(25); }
await waitOutHold();
await call("/console/auth", { method: "POST", form: { username: "svc_backup", password: "Backup@2026!" } });
info("shell on aegis-web01 as svc_backup");
for (const cmd of ["whoami", "ls -la", "cat notes.txt", "cat flag.txt"]) {
  // A visitor at a keyboard types a command, reads the output, then types the
  // next one. Firing four commands a second apart is not "noisy", it is a
  // script — and with three holds now ending a run it walked the noisy preset
  // into containment at stage 4 every time. Back off when the meter climbs,
  // which is exactly what the on-screen banner is telling the player to do.
  if (MODE === "noisy") await coolTo(30);
  await waitOutHold();
  await call("/console/exec", { method: "POST", json: { cmd } });
  console.log(`   $ ${cmd}`);
  await sleep((Math.floor(PACE / 3) + 2) * 1000);
}
await soc();
await flag(FLAGS[3], "FLAG-4");

/* Wait for a strike to expire, not just for the heat to fall.
 *
 * Three holds end a run, and the counter only forgives a strike after a stretch
 * of clean play. A noisy operator arriving at the finale on two strikes is one
 * throttle from containment however cool their meter is — so the preset that
 * exists to show "noisy, held, recovers, finishes" has to actually serve the
 * sentence. This is the moment the mechanic is worth watching. */
async function coolStrikes(target) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const state = await socState();
    // Nothing to wait for once the SOC has ended the run.
    if (state?.posture === "CONTAINED") return null;
    const strikes = Number(state?.throttles ?? 0);
    if (strikes <= target) return strikes;
    if (attempt === 0) info(`${strikes} SOC strikes on this session — sitting still until one expires`);
    await sleep(3000);
  }
  return null;
}

step("Stage 5 · Exfiltration");
await sleep(PACE * 1000);
if (MODE === "noisy") { await coolStrikes(1); await coolTo(40); }
await waitOutHold();
await call("/console/exec", { method: "POST", json: { cmd: "find / -name '*secret*'" } });
info("located the vault file");
await sleep(1500);
await waitOutHold();
/* Actually READ it. The rehearsal used to locate the file and then submit
 * FLAG-5 without opening it — which the game now refuses, correctly: a flag is
 * only scoreable if you did the thing that would have shown it to you. A
 * rehearsal that skips a step a real visitor cannot skip is not a rehearsal. */
await call("/console/exec", {
  method: "POST",
  json: { cmd: "cat /home/svc_backup/.secret_vault/final_flag.txt" },
});
info("read the crown jewel — this one is loud");
await soc();
await flag(FLAGS[4], "FLAG-5");

if (failures) {
  console.log(`\n${red("✗")} ${failures} step${failures === 1 ? "" : "s"} did not land — ${bold(PLAYER)} did NOT fully compromise.`);
  console.log(`   ${dim("Scroll up for the first red line; that is where the run broke.")}\n`);
  process.exit(1);
}
console.log(`\n${green("✓")} Full compromise. ${bold(PLAYER)} is on the RED OPS board.`);
console.log(`   ${dim("Wall: check the arena panel and the operation card.")}\n`);
