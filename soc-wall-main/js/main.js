import "../css/reset.css";
import "../css/theme.css";
import "../css/layout.css";
import "../css/animations.css";
/* Upgrade to the webfonts once the page exists.
 *
 * The <link> in index.html carries media="print" so it cannot block first paint
 * on a booth network that accepts the connection and then never answers. This
 * flips it on. If the request never lands, nothing happens and the wall keeps
 * the local stacks from theme.css — which is the state it is designed to look
 * right in. Not an inline onload="", because the CSP the hub serves has no
 * 'unsafe-inline' for script and would refuse it.
 */
for (const link of document.querySelectorAll("link[data-font-link]")) link.media = "all";

import { CONFIG, fetchAlerts, fetchTickets, fetchIntel, fetchHealth } from "./api.js";
import { initParticleField } from "./particles.js";
import { createAlertStore, renderOrigins, renderAlertCards, CRITICAL_BASELINE } from "./alerts.js";
import { pushSparkValue, animateNumber } from "./charts.js";
import { initAiAssistant } from "./ai.js";
import { renderHealth } from "./health.js";
import { renderIntel, renderTicker } from "./ticker.js";
import { initDetailSystem, makeDetailTrigger, openDetail } from "./details.js";
import { clockTime, stamp, wallDate } from "./clock.js";
import { connectHub, fetchArena, resolveHubUrl } from "./hub.js";
import { createArenaPanel } from "./arena.js";
import { createResponseTheatre, mountResponseBanner } from "./response.js";
import { initViewportFit } from "./fit.js";
import { createSocAudio } from "./audio.js";
import { createIntel, deriveCampaign, composeAssessment, storySignature } from "./campaign.js";

/* Scale the fixed 1920x1080 surface to this screen before anything measures
 * itself — the globe sizes off its container, so it has to be told the truth
 * on the first frame rather than corrected on the second. */
initViewportFit();

const byId = (id) => document.getElementById(id);
const elements = {
  clock: byId("utc-clock"), date: byId("utc-date"), threatLevel: byId("threat-level"), threatOrb: byId("threat-orb"),
  critical: byId("metric-critical"), eps: byId("metric-eps"), tickets: byId("metric-tickets"), agents: byId("metric-agents"),
  criticalL15: byId("critical-l15"), criticalL14: byId("critical-l14"), criticalL13: byId("critical-l13"), criticalInvestigating: byId("critical-investigating"), criticalContained: byId("critical-contained"),
  epsAverage: byId("eps-average"), epsPeak: byId("eps-peak"), ticketBreached: byId("ticket-breached"), ticketRisk: byId("ticket-risk"), agentOnline: byId("agent-online"),
  ticketP1: byId("ticket-p1"), ticketP2: byId("ticket-p2"), ticketP3: byId("ticket-p3"),
  sparkCritical: byId("spark-critical"), sparkEps: byId("spark-eps"), criticalUpdated: byId("critical-updated"),
  origins: byId("origin-list"), intel: byId("intel-feed"), timeline: byId("threat-timeline"), timelineCount: byId("timeline-count"),
  health: byId("health-list"), availability: byId("availability"), ticker: byId("ticker-track"),
  latency: byId("feed-latency"), activeVectors: byId("active-vectors"), observedCountries: byId("observed-countries"), windowEvents: byId("window-events"), aiLastEvent: byId("ai-last-event"), aiSignals: byId("ai-signals"), intelObjects: byId("intel-objects"), motionStatus: byId("motion-status"),
};

initDetailSystem();
initParticleField(byId("ambient-canvas"));
const [{ gsap }, { initGlobe }] = await Promise.all([import("gsap"), import("./globe.js")]);
const globe = initGlobe(byId("globe-stage"), { onInspect: openDetail });
const ai = initAiAssistant(byId("ai-typing"));

// ---- GISEC arena surfaces ------------------------------------------------ //
// Everything below is additive: if the Arena Hub is not running, these panels
// simply show their idle state and the wall behaves exactly as it did before.
const arena = createArenaPanel({
  board: byId("arena-board"), players: byId("arena-players"),
  runs: byId("arena-runs"), stations: byId("arena-stations"),
});

/* Alert audio. Synthesised, no files, silent for ambient telemetry — only real
 * booth activity is audible. See js/audio.js for the sound design. */
const audio = createSocAudio();

const operationCard = byId("operation-card");
const theatre = createResponseTheatre({
  card: operationCard && {
    root: operationCard, eyebrow: byId("op-eyebrow"), title: byId("op-title"),
    line: byId("op-line"), signals: byId("op-signals"), foot: byId("op-foot"), heat: byId("op-heat"),
  },
  banner: mountResponseBanner(document.querySelector(".hero")),
  alarm: byId("alarm-layer"),
  orb: byId("threat-orb"),
  ai,
  audio,
});

const EPS_BASE = 1_284;
let epsBaseline = EPS_BASE;
const epsSamples = [];
let agentCount = 418;
let errorStreak = 0;

function registerOperationalDetails() {
  const cards = [...document.querySelectorAll(".metric-card")];
  makeDetailTrigger(cards[0], "metric-critical", () => ({
    eyebrow: "CRITICAL ALERT QUEUE", title: `${elements.critical.textContent} critical alerts`, subtitle: "Highest-priority detections requiring analyst attention", status: "ESCALATED", statusTone: "hot",
    metrics: [{ label: "Critical", value: elements.critical.textContent, tone: "hot" }, { label: "Updated", value: elements.criticalUpdated.textContent }, { label: "Window", value: "LIVE" }, { label: "Source", value: "SENSOR GRID" }],
    sections: [{ title: "Queue posture", items: [{ label: "Priority", value: "Critical and high-severity detections" }, { label: "Ordering", value: "Newest evidence first" }, { label: "Correlation", value: "Geography, class, host, intelligence" }] }, { title: "Analyst workflow", items: [{ label: "First step", value: "Validate alert fidelity" }, { label: "Next step", value: "Correlate affected asset" }, { label: "Escalate when", value: "Active compromise is confirmed" }] }],
    source: "DMATICS SENSOR GRID", recommendation: "Open the newest high-risk incident, validate the affected asset, and begin containment when malicious activity is confirmed.",
  }));
  makeDetailTrigger(cards[1], "metric-eps", () => ({
    eyebrow: "INGEST TELEMETRY", title: `${elements.eps.textContent} events per second`, subtitle: "Real-time security event throughput across the detection cluster", status: "NOMINAL", statusTone: "good",
    metrics: [{ label: "Current EPS", value: elements.eps.textContent }, { label: "Managers", value: "02" }, { label: "Pipeline", value: "ACTIVE", tone: "good" }, { label: "Latency", value: elements.latency.textContent }],
    sections: [{ title: "Ingest context", items: [{ label: "Cluster", value: "Detection cluster" }, { label: "Index", value: "security-alerts-*" }, { label: "Refresh", value: `${CONFIG.refreshMs / 1000}s supporting data` }] }, { title: "Capacity indicators", items: [{ label: "State", value: "Within operating baseline" }, { label: "Watch for", value: "Sustained spikes or sudden silence" }] }],
    source: "DMATICS INGEST MONITOR", recommendation: "Investigate sustained deviations from the normal event-rate baseline and verify manager and indexer health.",
  }));
  makeDetailTrigger(cards[2], "metric-tickets", () => ({
    eyebrow: "INCIDENT SERVICE QUEUE", title: `${elements.tickets.textContent} open tickets`, subtitle: "Incident workload and current priority distribution", status: "ACTIVE",
    metrics: [{ label: "Open", value: elements.tickets.textContent }, { label: "P1", value: elements.ticketP1.textContent, tone: "hot" }, { label: "P2", value: elements.ticketP2.textContent, tone: "warning" }, { label: "P3", value: elements.ticketP3.textContent }],
    sections: [{ title: "Priority distribution", items: [{ label: "Priority 1", value: elements.ticketP1.textContent }, { label: "Priority 2", value: elements.ticketP2.textContent }, { label: "Priority 3", value: elements.ticketP3.textContent }] }, { title: "Operations focus", items: [{ label: "Queue", value: "Open security requests" }, { label: "SLA", value: "Track breached and due incidents" }] }],
    source: "DMATICS SERVICE DESK", recommendation: "Prioritize P1 cases, confirm ownership, and escalate tickets approaching their SLA threshold.",
  }));
  makeDetailTrigger(cards[3], "metric-agents", () => ({
    eyebrow: "ENDPOINT COVERAGE", title: `${elements.agents.textContent} reporting agents`, subtitle: "Endpoint sensor visibility and current coverage state", status: "NOMINAL", statusTone: "good",
    metrics: [{ label: "Online", value: elements.agents.textContent, tone: "good" }, { label: "Offline", value: "02", tone: "warning" }, { label: "Coverage", value: "99.5%" }, { label: "Last check", value: "4 SEC" }],
    sections: [{ title: "Coverage posture", items: [{ label: "Reporting", value: elements.agents.textContent }, { label: "Disconnected", value: "2 agents" }, { label: "Health", value: "All groups reporting" }] }, { title: "Visibility risk", items: [{ label: "Review", value: "Disconnected and stale agents" }, { label: "Priority", value: "Critical servers and identity systems" }] }],
    source: "DMATICS SENSOR INVENTORY", recommendation: "Restore disconnected agents and confirm that critical asset groups maintain continuous telemetry coverage.",
  }));

  makeDetailTrigger(document.querySelector(".ai-panel"), "ai-assessment", () => ({
    eyebrow: "DMATICS AI ASSESSMENT", title: "Current campaign analysis", subtitle: byId("ai-typing").textContent, status: "HIGH CONFIDENCE", statusTone: "warning",
    metrics: [{ label: "Confidence", value: "92%" }, { label: "Campaign", value: "DESERT VIPER" }, { label: "Class", value: "CREDENTIAL ACCESS" }, { label: "Tenant", value: "FINANCE-IDP" }],
    sections: [{ title: "Analyst conclusion", items: [{ label: "Threat level", value: elements.threatLevel.textContent }, { label: "Attack type", value: "Credential access" }, { label: "Affected scope", value: "Finance identity systems" }] }, { title: "Supporting signals", items: [{ label: "Technique", value: "Credential access and valid-account use" }, { label: "Correlation", value: "Identity, endpoint, source infrastructure" }, { label: "Lateral movement", value: "Not observed" }] }],
    source: "DMATICS AI CORRELATION", recommendation: "Enforce step-up authentication and isolate the anomalous session on FIN-WS-112.",
  }));
  makeDetailTrigger(document.querySelector(".operation-card"), "campaign-desert-viper", {
    eyebrow: "ACTIVE CAMPAIGN", title: "DESERT VIPER", subtitle: "Correlated credential-access activity targeting cloud identity", status: "TRACKING",
    metrics: [{ label: "Signals", value: "14" }, { label: "Class", value: "CREDENTIAL ACCESS" }, { label: "Target", value: "FINANCE" }, { label: "Confidence", value: "92%" }],
    sections: [{ title: "Campaign profile", items: [{ label: "Objective", value: "Cloud identity access" }, { label: "Observed behavior", value: "Credential spray and valid accounts" }, { label: "Affected tenant", value: "FINANCE-IDP" }] }, { title: "Current posture", items: [{ label: "Containment", value: "Preventive controls active" }, { label: "Open issue", value: "One anomalous session" }] }],
    source: "DMATICS THREAT CORRELATION", recommendation: "Review associated identities, revoke suspicious sessions, and enforce phishing-resistant authentication.",
  });
  makeDetailTrigger(document.querySelector(".topbar-center"), "global-threat-state", () => ({
    eyebrow: "GLOBAL THREAT CONDITION", title: elements.threatLevel.textContent, subtitle: "Composite risk state derived from alert volume, severity, campaign confidence, and infrastructure health", status: elements.threatLevel.textContent, statusTone: elements.threatLevel.textContent === "SEVERE" ? "hot" : "warning",
    metrics: [{ label: "Condition", value: elements.threatLevel.textContent }, { label: "Critical", value: elements.critical.textContent, tone: "hot" }, { label: "Vectors", value: elements.activeVectors.textContent }, { label: "Coverage", value: "99.5%", tone: "good" }],
    sections: [{ title: "Condition inputs", items: [{ label: "Alert severity", value: "Detection severity levels" }, { label: "Threat intelligence", value: "Intelligence confidence" }, { label: "Infrastructure", value: "Network availability" }] }, { title: "Operating guidance", items: [{ label: "Current posture", value: "Heightened monitoring" }, { label: "Escalation", value: "Confirmed active compromise" }] }],
    source: "DMATICS COMMAND STATE", recommendation: "Maintain heightened monitoring and prioritize high-confidence activity affecting identity and critical infrastructure.",
  }));
  const sourceDetails = [
    ["SENSORS", "Endpoint and network detection telemetry", "0.4s", "security-alerts-*"],
    ["TICKETS", "Incident service-desk queue", "9s", "Open security requests"],
    ["INTEL", "Threat intelligence and indicator graph", "12s", "Indicators and campaigns"],
    ["NETWORK", "Infrastructure availability monitoring", "18s", "Devices and services"],
  ];
  [...document.querySelectorAll(".source-statuses span")].forEach((sourceElement, index) => {
    const [name, description, freshness, scope] = sourceDetails[index];
    makeDetailTrigger(sourceElement, `source-${name.toLowerCase()}`, {
      eyebrow: "DATA SOURCE STATUS", title: name, subtitle: description, status: "CONNECTED", statusTone: "good",
      metrics: [{ label: "Freshness", value: freshness, tone: "good" }, { label: "State", value: "LINKED" }, { label: "Mode", value: CONFIG.demo ? "DEMO" : "LIVE" }, { label: "Scope", value: scope }],
      sections: [{ title: "Connection posture", items: [{ label: "Source", value: name }, { label: "Function", value: description }, { label: "Latest data", value: freshness }] }, { title: "Adapter boundary", items: [{ label: "Access", value: "Read-only" }, { label: "Normalization", value: "SOC Wall data contract" }, { label: "Failure behavior", value: "Retain last valid telemetry" }] }],
      source: "DMATICS ADAPTER HEALTH", recommendation: "No action is required while freshness remains within the expected collection interval.",
    });
  });
}

registerOperationalDetails();

function updateClock() {
  const now = new Date();
  elements.clock.textContent = clockTime(now);
  elements.date.textContent = wallDate(now);
}

/* The posture badge, driven by the LIVE criticals — not the displayed total.
 *
 * criticalCount is CRITICAL_BASELINE (14) plus whatever has happened in the
 * window, so it can never be below 14 and the thresholds 8 / 30 meant the wall
 * was pinned to ELEVATED from boot and GUARDED was a branch that could not
 * execute. The badge said the same thing whether the stand was empty or a red
 * team was three flags deep.
 *
 * The number on screen stays the total — that is the standing queue the booth is
 * carrying, and it should look busy. The STATE is judged on the part that
 * actually moves, so the wall reads GUARDED at rest, ELEVATED once a visitor is
 * working, and SEVERE when they are pushing hard. */
function updateThreatState(criticalCount) {
  const live = Math.max(0, criticalCount - CRITICAL_BASELINE);
  const state = live >= 12 ? ["SEVERE", "is-critical"] : live >= 4 ? ["ELEVATED", "is-warning"] : ["GUARDED", "is-safe"];
  elements.threatLevel.textContent = state[0];
  elements.threatLevel.className = state[1] === "is-critical" ? "hot" : state[1] === "is-safe" ? "good" : "warning";
  elements.threatOrb.className = `status-orb ${state[1]}`;
}

function renderAlertState({ alerts, origins, originCount, totalEvents, criticalCount }) {
  renderOrigins(elements.origins, origins);
  renderAlertCards(elements.timeline, alerts);
  elements.timelineCount.textContent = String(alerts.length).padStart(2, "0");
  animateNumber(elements.critical, criticalCount);
  pushSparkValue(elements.sparkCritical, criticalCount, "#ff496c");
  elements.criticalUpdated.textContent = stamp();
  elements.activeVectors.textContent = String(Math.max(globe.activeCount(), alerts.length * 3)).padStart(2, "0");
  elements.observedCountries.textContent = String(originCount).padStart(2, "0");
  elements.windowEvents.textContent = totalEvents.toLocaleString();
  elements.criticalL15.textContent = String(alerts.filter((alert) => alert.level >= 15).length).padStart(2, "0");
  elements.criticalL14.textContent = String(alerts.filter((alert) => alert.level === 14).length).padStart(2, "0");
  elements.criticalL13.textContent = String(alerts.filter((alert) => alert.level === 13).length).padStart(2, "0");
  /* Count contained explicitly and derive investigating from it, rather than the
   * other way round. "Anything not Investigating is contained" was true only
   * because exactly two statuses exist today; a third one arriving from the hub
   * would have been silently reported to the hall as contained. This way the two
   * numbers still add up to the total and neither can overstate the good news. */
  const contained = alerts.filter((alert) => alert.status === "Contained").length;
  const investigating = Math.max(0, alerts.length - contained);
  elements.criticalInvestigating.textContent = `${String(investigating).padStart(2, "0")} investigating`;
  elements.criticalContained.textContent = `${String(contained).padStart(2, "0")} contained`;
  elements.aiLastEvent.textContent = stamp();
  updateThreatState(criticalCount);

  /* The ACTIVE CAMPAIGN card and the AI assessment are derived from this same
   * batch, so the three panels are always describing one picture rather than
   * three unrelated ones. */
  const picture = intel.read({ alerts, origins, originCount, totalEvents, criticalCount });
  theatre.setIdleCampaign(deriveCampaign(picture));
  elements.aiSignals.textContent = `${picture.windowSignals} / ${String(picture.countries).padStart(2, "0")} SOURCES`;

  const { text, facts } = composeAssessment(picture);
  const story = storySignature(picture);
  if (story !== lastStory) {
    lastStory = story;
    ai.setAssessment(text, facts);      // a new story: re-type it
  } else {
    ai.setAssessment(null, facts);      // same story: just keep the facts current
  }
}

/* Holds the campaign the card is showing, so it resists being renamed by one
 * extra alert. See campaign.js — the hysteresis is the whole point. */
const intel = createIntel();
let lastStory = "";

const alertStore = createAlertStore({ max: 8, onChange: renderAlertState, onAttack: globe.spawnAttack });

let hubLinked = false;

/* Repaint the pill from whatever the current state already is.
 *
 * Split out from setConnectionState so the hub's own connect/disconnect can
 * update the wording — the arena link is the one the crew needs to see at a
 * glance — without also clearing the failure counter for the four data
 * adapters, which are entirely unrelated to it. */
function refreshConnectionPill() {
  const pill = document.querySelector(".connection-pill");
  if (!pill) return;
  const label = pill.querySelector("span");
  if (errorStreak >= 2) {
    pill.classList.add("is-degraded");
    if (label) label.textContent = "ADAPTER RETRY ACTIVE";
    return;
  }
  pill.classList.remove("is-degraded");
  if (label) {
    label.textContent = hubLinked
      ? "ARENA LINKED · 4 GAMES"
      : CONFIG.demo ? "DEMO TELEMETRY LINKED" : "ALL SYSTEMS LINKED";
  }
}

function setConnectionState(healthy) {
  errorStreak = healthy ? 0 : errorStreak + 1;
  refreshConnectionPill();
}

async function pollAlerts() {
  try {
    const batch = await fetchAlerts();
    alertStore.add(batch.slice(0, CONFIG.demo ? 4 : 12));
    setConnectionState(true);
  } catch (error) {
    console.warn("Alert adapter unavailable; retaining last telemetry.", error);
    setConnectionState(false);
  } finally {
    // A booth globe with an arc every four seconds looks asleep. The ambient
    // feed runs roughly twice a second so there is always something in flight,
    // and the arc pool recycles rather than growing.
    setTimeout(pollAlerts, CONFIG.demo ? 900 + Math.random() * 1_100 : 8_000);
  }
}

async function refreshSupportingData() {
  const startedAt = performance.now();
  const [ticketResult, intelResult, healthResult] = await Promise.allSettled([fetchTickets(), fetchIntel(), fetchHealth()]);
  if (ticketResult.status === "fulfilled") {
    const tickets = ticketResult.value;
    animateNumber(elements.tickets, tickets.open);
    elements.ticketP1.textContent = String(tickets.byPriority.p1).padStart(2, "0");
    elements.ticketP2.textContent = String(tickets.byPriority.p2).padStart(2, "0");
    elements.ticketP3.textContent = String(tickets.byPriority.p3).padStart(2, "0");
    elements.ticketBreached.textContent = String(tickets.breached).padStart(2, "0");
    elements.ticketRisk.textContent = String(Math.max(tickets.breached, Math.round(tickets.open * .14))).padStart(2, "0");
  }
  // The intelligence panel gave its half of the wall to the arena boards; the
  // same feed still runs across the ticker, so the poll stays as it was and the
  // panel render is skipped when the element is absent.
  if (intelResult.status === "fulfilled") {
    renderIntel(elements.intel, intelResult.value);
    renderTicker(elements.ticker, intelResult.value);
    if (elements.intelObjects) elements.intelObjects.textContent = String(intelResult.value.length).padStart(2, "0");
  }
  // Infrastructure health is still polled — it is one of the four sources the
  // connection pill and the source-freshness row report on. Its panel now holds
  // the arena board, so the render is a no-op when the list element is absent.
  if (healthResult.status === "fulfilled") {
    const services = healthResult.value;
    renderHealth(elements.health, services);
    if (elements.availability) {
      const average = services.reduce((sum, service) => sum + service.pct, 0) / Math.max(1, services.length);
      elements.availability.textContent = `${average.toFixed(2)}%`;
      elements.availability.className = average < 99 ? "warning" : "good";
    }
  }
  const healthy = [ticketResult, intelResult, healthResult].every((result) => result.status === "fulfilled");
  setConnectionState(healthy);
  elements.latency.textContent = `${Math.max(.1, (performance.now() - startedAt) / 1000).toFixed(1)}s`;
}

function updateLiveMetrics() {
  /* Mean-reverting, not a random walk.
   *
   * The old line was `Math.max(900, epsBaseline + random)`, which is a walk off
   * a reflecting floor — the floor biases it upward and nothing bounds the top.
   * Over a four-day show that is sigma ~2,500 on a number that starts at 1,284,
   * so by day three EVENTS / SECOND reads several thousand while the "1,246
   * AVG / 1,552 PEAK" printed beside it stays put. Pulling 2% toward the
   * baseline each tick keeps it lively and keeps it honest. */
  epsBaseline = Math.round(epsBaseline + (EPS_BASE - epsBaseline) * 0.02 + (Math.random() * 22 - 11));
  epsBaseline = Math.min(EPS_BASE + 320, Math.max(EPS_BASE - 320, epsBaseline));
  const eps = epsBaseline + Math.round(Math.random() * 96 - 48);
  epsSamples.push(eps);
  if (epsSamples.length > 60) epsSamples.shift();
  animateNumber(elements.eps, eps);
  elements.epsAverage.textContent = Math.round(epsSamples.reduce((sum, sample) => sum + sample, 0) / epsSamples.length).toLocaleString();
  elements.epsPeak.textContent = Math.max(...epsSamples).toLocaleString();
  pushSparkValue(elements.sparkEps, eps, "#54e7ff");
  /* Same problem, smaller numbers: unclamped this drifts +/-97 over 96 hours,
   * so SENSOR COVERAGE would read anywhere from 220 to 620 by day four while
   * the "99.5% / 02 DOWN / 12/12 GROUPS" next to it is fixed markup. */
  if (Math.random() > .94) {
    agentCount = Math.min(424, Math.max(408, agentCount + (Math.random() > .5 ? 1 : -1)));
  }
  animateNumber(elements.agents, agentCount);
  elements.agentOnline.textContent = agentCount.toLocaleString();
}

// --------------------------------------------------------------------------- //
//  GISEC Arena Hub
//
//  Booth activity enters through the SAME alert store as every other detection,
//  so the globe, the origin list, the origins panel and the threat timeline pick
//  it up with no special handling. The arena-specific surfaces — the board, the
//  hero operation card, the AI panel, the response band — read the `gisec` block
//  the hub attaches to each alert.
// --------------------------------------------------------------------------- //
const stationIndex = new Map();

const STATION_TTL_MS = 10 * 60_000;

function applyStations(list) {
  for (const station of list) if (station?.id) stationIndex.set(station.id, station);
  /* Age stations out. The booth has four fixed ids so this is normally a no-op,
   * but the map had no eviction at all: if the hub ever assigns an id per
   * session, this grows forever and setStations sorts the whole list on every
   * event. */
  const cutoff = Date.now() - STATION_TTL_MS;
  if (stationIndex.size > 8) {
    for (const [id, station] of stationIndex) {
      if (Number(station?.lastSeen ?? 0) < cutoff) stationIndex.delete(id);
    }
  }
  arena.setStations([...stationIndex.values()]);
}

const hub = connectHub({
  onStatus(connected, address) {
    hubLinked = connected;
    /* Only refresh the pill; do not reset errorStreak. This used to call
     * setConnectionState(true) unconditionally, so a hub reconnecting every few
     * seconds cleared the failure counter for the alert, ticket, intel and
     * network adapters — which meant the pill could never go degraded even with
     * all four of them down. */
    refreshConnectionPill();
    elements.motionStatus.textContent = connected
      ? "GISEC arena telemetry connected."
      : "GISEC arena telemetry offline; ambient telemetry continues.";
    console.info(`[arena] hub ${connected ? "connected" : "disconnected"} — ${address}`);
  },

  onSnapshot(payload) {
    arena.update(payload);
    applyStations(payload.stations ?? []);
    /* Replay recent booth alerts oldest-first so the timeline reads in order and
     * the globe fires their arcs in the sequence they actually happened.
     *
     * One add() for the whole feed, not one per alert. Each add() triggers a
     * full re-render — origins, timeline, eight detail registrations, the
     * campaign read, a sparkline redraw — so a 200-item feed was 200 of those
     * synchronously, freezing the globe for a few hundred milliseconds on every
     * reconnect, and spawning 200 competing number animations on one counter. */
    alertStore.add([...(payload.feed ?? [])].reverse());
  },

  onAlert(alert) {
    alertStore.add([alert]);
    theatre.showAlert(alert);
  },

  onScore({ game, entry, leaderboard }) {
    arena.update(leaderboard);
    if (game && entry) {
      arena.flash(game, entry);
      audio.score();
    }
  },

  onStation(station) {
    applyStations([station]);
    theatre.showStation(station);
  },

  onCommand(command) {
    theatre.showCommand(command);
  },
});

// Prime the board before the stream's first message, so a wall brought up after
// a busy morning shows the day's scores immediately rather than an empty panel.
if (resolveHubUrl()) {
  fetchArena().then((snapshot) => {
    if (!snapshot || hub.state.alerts) return;
    arena.update(snapshot);
    applyStations(snapshot.stations ?? []);
  });
}

async function seed() {
  if (CONFIG.demo) {
    const seedBatches = await Promise.all(Array.from({ length: 5 }, () => fetchAlerts()));
    // Flattened once. It was flattened twice, and the second call rebuilt the
    // array the first one had just mutated — harmless today, and exactly the
    // shape of thing that stops being harmless when someone edits the line above.
    const seeded = seedBatches.flat();
    seeded.forEach((alert, index) => { alert.ts -= index * 21_000; });
    alertStore.add(seeded);
  }
  await Promise.all([pollAlerts(), refreshSupportingData()]);
}

updateClock();
setInterval(updateClock, 1_000);
updateLiveMetrics();
setInterval(updateLiveMetrics, 2_200);
setInterval(refreshSupportingData, CONFIG.refreshMs);

if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
  gsap.from(".glass-panel", { duration: .9, y: 14, opacity: 0, stagger: .035, ease: "power3.out", clearProps: "transform,opacity" });
}

seed().catch((error) => {
  console.error("SOC Wall initialization failed.", error);
  elements.motionStatus.textContent = "Live telemetry initialization failed; the interface will retry automatically.";
});
