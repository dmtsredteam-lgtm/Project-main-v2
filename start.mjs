#!/usr/bin/env node
/* ===========================================================================
 * GISEC Arena — one launcher, every operating system.
 *
 * The booth used to be brought up by run-local.sh, which meant the show could
 * only be rehearsed on Linux or macOS. This does the same job in Node, which is
 * already a hard requirement for the hub, so there is nothing extra to install
 * and nothing that behaves differently on Windows.
 *
 *   node start.mjs                 hub + wall, prints the LAN addresses
 *   node start.mjs --build         rebuild the wall first
 *   node start.mjs --redteam       also bring up the red team challenge (Docker)
 *   node start.mjs --port 8080     serve on a different port
 *   node start.mjs --no-open       do not open a browser
 *
 * Windows notes, all handled below rather than left to the reader:
 *   - npm is npm.cmd, and spawning it without that fails with ENOENT
 *   - there is no SIGTERM for a child process, so shutdown uses taskkill /T
 *   - ANSI colour is only safe on a real terminal
 * ========================================================================= */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { networkInterfaces, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const ROOT = dirname(fileURLToPath(import.meta.url));
const WINDOWS = platform() === "win32";

/* Load gisec-hub/.env before anything reads process.env.
 *
 * The hub is plain Node with no dependencies — no dotenv — so `npm start` used
 * to ignore the .env file entirely and the operator had to remember
 * `set -a; . ./gisec-hub/.env; set +a` first. Setting a value, restarting, and
 * watching nothing change is the worst kind of papercut: it looks like the
 * feature is broken rather than unloaded.
 *
 * A real environment variable always wins, so `ADMIN_TOKEN=x npm start` still
 * overrides the file. Deliberately minimal: KEY=VALUE, # comments, optional
 * surrounding quotes. No expansion, no multi-line — if a value needs more than
 * that, export it yourself.
 */
function loadEnvFile(file) {
  if (!existsSync(file)) return 0;
  let loaded = 0;
  try {
    for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 1) continue;
      const key = line.slice(0, eq).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
      if (Object.hasOwn(process.env, key)) continue;      // the real environment wins
      let value = line.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
          (value.startsWith("'") && value.endsWith("'") && value.length > 1)) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
      loaded += 1;
    }
  } catch { /* unreadable .env is not a reason to refuse to start */ }
  return loaded;
}
const ENV_FILE = join(ROOT, "gisec-hub", ".env");
const ENV_LOADED = loadEnvFile(ENV_FILE);

// ---- terminal ---------------------------------------------------------------
const COLOUR = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, text) => (COLOUR ? `[${code}m${text}[0m` : text);
const bold = (t) => c("1", t);
const cyan = (t) => c("36", t);
const dim = (t) => c("2", t);
const red = (t) => c("31", t);
const green = (t) => c("32", t);

const say = (text) => console.log(text);
const step = (text) => say(`\n${cyan("==")} ${bold(text)}`);
const info = (text) => say(`   ${dim(text)}`);
const fail = (text) => { say(`\n${red("x")} ${text}`); process.exit(1); };

// ---- arguments --------------------------------------------------------------
const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const value = (flag, fallback) => {
  const index = argv.indexOf(flag);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

if (has("--help") || has("-h")) {
  say(`
${bold("GISEC Arena")} — local launcher

  node start.mjs                 hub + wall on this machine
  node start.mjs --build         rebuild the SOC wall before starting
  node start.mjs --redteam       also start the red team challenge (needs Docker)
  node start.mjs --port 8080     use a different port (default 7788)
  node start.mjs --no-open       do not open a browser window

Works the same on Windows, Linux and macOS.
`);
  process.exit(0);
}

// `Number("8080x")` is NaN, and `server.listen(NaN)` does not fail — it binds a
// random free port. The launcher then prints http://localhost:NaN/ and every
// address it advertises to the iPad is wrong, with no error anywhere.
const portArgument = value("--port", process.env.PORT || 7788);
const PORT = Number(portArgument);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  fail(`--port must be a whole number between 1 and 65535 (got "${portArgument}").`);
}

// ---- preflight --------------------------------------------------------------
const [major] = process.versions.node.split(".").map(Number);
if (major < 18) fail(`Node 18 or newer is required. This is ${process.versions.node}.`);

const HUB = join(ROOT, "gisec-hub", "server.js");
const WALL_DIST = join(ROOT, "soc-wall-main", "dist");
const WALL_SRC = join(ROOT, "soc-wall-main");
if (!existsSync(HUB)) fail(`Cannot find ${HUB}. Run this from the project root.`);

/** Is something already listening? Better than a confusing EADDRINUSE later. */
function portFree(port) {
  return new Promise((resolve) => {
    const probe = createServer()
      .once("error", () => resolve(false))
      .once("listening", () => probe.close(() => resolve(true)))
      .listen(port, "0.0.0.0");
  });
}

/** Run a command to completion, inheriting the terminal. */
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    // Windows resolves npm/npx to .cmd shims, which spawn() will not find
    // unless it is told to go through the shell. Only those two — docker on
    // Windows is docker.exe, and asking for "docker.cmd" is an ENOENT that
    // reads as "Docker is not available" when Docker is running perfectly well.
    const isShim = WINDOWS && ["npm", "npx", "yarn", "pnpm"].includes(command);
    const child = spawn(isShim ? `${command}.cmd` : command, args, {
      stdio: "inherit", shell: WINDOWS, ...options,
    });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))));
  });
}

/** Every address this machine can be reached on, so the iPad has one to use. */
function lanAddresses() {
  const found = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.family !== "IPv4" && entry.family !== 4) continue;
      if (entry.internal) continue;
      found.push({ name, address: entry.address });
    }
  }
  // Wireless first: at a stand the tablets are on wifi, and that is the address
  // most people actually need.
  const rank = (n) => (/^(wl|wi|Wi-?Fi|wlan)/i.test(n) ? 0 : /^(en|eth|Ethernet)/i.test(n) ? 1 : 2);
  return found.sort((a, b) => rank(a.name) - rank(b.name));
}

// ---- children ---------------------------------------------------------------
const children = [];
let shuttingDown = false;
let composeDir = null;   // set when --redteam actually brought Docker up
/* Assigned after the build, further down. Created before it, the reader resumes
 * stdin and puts the console into terminal mode while `npm install` and
 * `npx vite build` are inheriting that same console — and npx's "Ok to proceed?
 * (y)" prompt on a first run then loses the keystroke to this reader, leaving
 * the build hung with no output. */
let consoleReader = null;

function stopAll() {
  if (shuttingDown) return;
  shuttingDown = true;
  say(`\n${dim("stopping…")}`);
  // `docker compose up -d` detaches: Ctrl-C here kills the launcher and leaves
  // the challenge running on :8000, holding the port and the database. The next
  // `npm start -- --redteam` then looks like it worked while actually talking to
  // yesterday's container.
  if (composeDir) {
    say(`   ${dim("docker compose down…")}`);
    try {
      spawn("docker", ["compose", "down"],
            { cwd: composeDir, stdio: "ignore", shell: WINDOWS }).on("error", () => {});
    } catch { /* Docker gone; nothing to take down */ }
  }
  if (consoleReader) { try { consoleReader.close(); } catch { /* already gone */ } }

  const alive = () => children.filter((child) => child.exitCode === null && !child.signalCode);

  if (!WINDOWS) {
    for (const child of alive()) child.kill("SIGTERM");
    setTimeout(() => process.exit(0), 400);
    return;
  }

  /* Windows: give the hub a moment to flush before forcing it.
   *
   * Ctrl-C raises CTRL_C_EVENT for every process on the console, so the hub —
   * spawned with stdio:"inherit" — has already started its own shutdown flush.
   * Firing `taskkill /F` at the same instant is TerminateProcess: no unwinding,
   * no flush, and the write it interrupts is the leaderboard. So wait for the
   * children to leave on their own, and only force whatever is still standing.
   * taskkill /T takes the whole tree, which matters because npm spawns node
   * underneath itself. */
  const deadline = Date.now() + 2500;
  const finish = () => {
    for (const child of alive()) {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", shell: true });
    }
    setTimeout(() => process.exit(0), 400);
  };
  const poll = () => {
    if (!alive().length) { process.exit(0); return; }
    if (Date.now() >= deadline) { finish(); return; }
    setTimeout(poll, 100);
  };
  poll();
}

/* SIGHUP is what closing the console window sends on Windows and SIGBREAK is
 * Ctrl+Break. Neither was handled, so the two ways of ending a show day that are
 * not Ctrl-C both skipped stopAll — leaving the --redteam containers up on :8000
 * for the next morning. Registering them is harmless on Linux. */
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
  try { process.on(signal, stopAll); } catch { /* not on this platform */ }
}



// ---- go ---------------------------------------------------------------------
say(bold("\nGISEC 2026 — DMATICS Cyber Arena"));
info(`${platform()} · node ${process.versions.node}`);
if (ENV_LOADED) info(`loaded ${ENV_LOADED} setting(s) from gisec-hub/.env`);
else if (!process.env.ADMIN_TOKEN) {
  info("no gisec-hub/.env — run ./setup-env.sh if the reset button should work");
}

if (has("--build") || !existsSync(join(WALL_DIST, "index.html"))) {
  if (!existsSync(join(WALL_SRC, "node_modules"))) {
    step("Installing the wall's dependencies (first run only)");
    await run("npm", ["install"], { cwd: WALL_SRC }).catch((error) =>
      fail(`npm install failed: ${error.message}`));
  }
  step("Building the SOC wall");
  await run("npx", ["vite", "build", "--sourcemap", "false"], { cwd: WALL_SRC })
    .catch((error) => fail(`Wall build failed: ${error.message}`));
}

/* The built config must point at the hub that is serving it. This is the one
 * line the build cannot infer, and forgetting it is the classic "the wall loads
 * but the leaderboards never fill" symptom.
 *
 * Outside the build branch, deliberately. It used to run only when this script
 * did the build, so a dist/ produced any other way — a Vercel build, a colleague's
 * laptop, a copy off a USB stick — kept sameOrigin:false and the wall never found
 * the hub that was serving it. Idempotent, so running it every launch costs
 * nothing. */
{
  const { readFileSync, writeFileSync } = await import("node:fs");
  const configPath = join(WALL_DIST, "soc-config.js");
  if (existsSync(configPath)) {
    try {
      const text = readFileSync(configPath, "utf8");
      if (text.includes("sameOrigin: false")) {
        writeFileSync(configPath, text.replace("sameOrigin: false", "sameOrigin: true"));
        info("soc-config.js → sameOrigin: true (the hub serves the wall)");
      }
    } catch (error) {
      info(`could not update soc-config.js (${error.code || error.message}) — the wall will fall back to this host:${PORT}`);
    }
  }
}

if (WINDOWS && process.stdin.isTTY) {
  // Ctrl-C on Windows does not always reach a Node process as SIGINT unless
  // readline is watching the console. Kept as a handle so stopAll can close it.
  const readline = await import("node:readline");
  consoleReader = readline.createInterface({ input: process.stdin, output: process.stdout });
  consoleReader.on("SIGINT", stopAll);
}

if (!(await portFree(PORT))) {
  fail(`Port ${PORT} is already in use. Stop whatever is on it, or use --port.`);
}

step("Starting the Arena Hub");
const hub = spawn(process.execPath, [HUB], {
  cwd: join(ROOT, "gisec-hub"),
  stdio: "inherit",
  env: { ...process.env, PORT: String(PORT), WALL_DIR: WALL_DIST },
});
children.push(hub);
hub.on("exit", (code) => { if (!shuttingDown) fail(`The hub stopped (exit ${code}).`); });

if (has("--redteam")) {
  step("Starting the Red Team Challenge (Docker)");
  const compose = join(ROOT, "DMATICS-Red-Team-Challenge-main");
  if (!existsSync(join(compose, ".env"))) {
    say(red("   .env is missing."));
    info(`Copy ${join("DMATICS-Red-Team-Challenge-main", ".env.example")} to .env and set SECRET_KEY.`);
    info("Skipping the challenge; the hub and wall are still starting.");
  } else {
    run("docker", ["compose", "up", "-d", "--build"], { cwd: compose })
      .then(() => { composeDir = compose; info("challenge up on :8000 (stopped again on Ctrl-C)"); })
      .catch(() => info("Docker is not available — start the challenge yourself, or skip it."));
  }
}

// Give the hub a moment to bind before advertising addresses that do not answer.
await new Promise((resolve) => setTimeout(resolve, 900));

const addresses = lanAddresses();
say(`\n${bold("Open these:")}`);
say(`   ${bold("SOC wall")}    ${cyan(`http://127.0.0.1:${PORT}/`)}`);
say(`   ${bold("Arcade")}      ${cyan(`http://127.0.0.1:${PORT}/arcade`)}`);
if (addresses.length) {
  say(`\n${bold("From the iPad, phones and the other laptops:")}`);
  for (const { name, address } of addresses) {
    say(`   ${cyan(`http://${address}:${PORT}/`)}  ${dim(`(${name})`)}`);
  }
} else {
  say(`\n   ${dim("No LAN address found — this machine may be offline.")}`);
}
say(`\n   ${dim(`Wall in kiosk mode:  chromium --kiosk --autoplay-policy=no-user-gesture-required http://127.0.0.1:${PORT}/`)}`);
say(`   ${dim("Rehearse a run:      node simulate.mjs")}`);
say(`\n${green("ready")} ${dim("— Ctrl-C to stop")}\n`);

if (!has("--no-open")) {
  /* No shell on any platform. With shell:true Node joins argv with spaces and
   * quotes nothing, so `cmd /c start "" <url>` became `cmd /c start  <url>` —
   * the empty title placeholder, the one thing that stops `start` reading the
   * URL as a window title, was silently dropped. rundll32 takes the URL as a
   * single argument and needs no shell. */
  const target = `http://127.0.0.1:${PORT}/`;
  const open = WINDOWS ? ["rundll32", ["url.dll,FileProtocolHandler", target]]
    : platform() === "darwin" ? ["open", [target]]
    : ["xdg-open", [target]];
  spawn(open[0], open[1], { stdio: "ignore", detached: true }).on("error", () => {});
}
