/**
 * Backend adapter boundary.
 *
 * Presentation modules only ever consume the four normalised functions exported
 * here, so the wall does not care what is behind them. The four feeds are named
 * for what they DO — alerts, tickets, intel, network — rather than for whichever
 * product happens to be supplying them at a given site. Point them at whatever
 * the customer runs; the data contract below is the only thing the wall knows.
 *
 * Threat classification uses DMATICS kill-chain codes (see CLASS) rather than
 * any third-party framework's identifiers, so nothing on the booth screen
 * carries another vendor's naming.
 */

const runtimeConfig = globalThis.SOC_CONFIG ?? {};

export const CONFIG = Object.freeze({
  demo: runtimeConfig.demo ?? true,
  refreshMs: runtimeConfig.refreshMs ?? 30_000,

  /** Detection feed — a search endpoint returning security events. */
  alerts: {
    url: runtimeConfig.alerts?.url ?? "https://indexer.local:9200",
    index: runtimeConfig.alerts?.index ?? "security-alerts-*",
    user: runtimeConfig.alerts?.user ?? "wall_ro",
    pass: runtimeConfig.alerts?.pass ?? "",
  },
  /** Service desk — the open incident queue. */
  tickets: {
    url: runtimeConfig.tickets?.url ?? "https://servicedesk.local/api/v1",
    token: runtimeConfig.tickets?.token ?? "",
  },
  /** Threat intelligence — indicators and campaigns. */
  intel: {
    url: runtimeConfig.intel?.url ?? "https://intel.local/graphql",
    token: runtimeConfig.intel?.token ?? "",
  },
  /** Infrastructure availability. */
  network: {
    url: runtimeConfig.network?.url ?? "https://netmon.local/api/json",
    key: runtimeConfig.network?.key ?? "",
  },
});

/**
 * DMATICS threat classification.
 *
 * Short code for the wall (readable across a hall), full label for the
 * investigation dialog. These are kill-chain phases in plain English — no
 * external framework identifiers, and far easier to read at ten metres than a
 * four-digit technique number.
 */
export const CLASS = {
  RECON:   "Reconnaissance",
  INITIAL: "Initial Access",
  EXEC:    "Command Execution",
  PERSIST: "Persistence",
  PRIVESC: "Privilege Escalation",
  EVADE:   "Defence Evasion",
  CRED:    "Credential Access",
  ACCESS:  "Valid Account Use",
  DISCOVER:"Discovery",
  LATERAL: "Lateral Movement",
  COLLECT: "Data Collection",
  EXFIL:   "Exfiltration",
  C2:      "Command & Control",
  IMPACT:  "Service Impact",
  CONTAIN: "Containment Action",
  TRAINING:"Training Simulation",
};

export const classLabel = (code) => CLASS[code] ?? "Unclassified";

const countries = [
  ["CN", "China", 39.9042, 116.4074, "Beijing"], ["RU", "Russia", 55.7558, 37.6173, "Moscow"], ["US", "United States", 39.0438, -77.4874, "Ashburn"],
  ["BR", "Brazil", -23.5505, -46.6333, "São Paulo"], ["IN", "India", 19.0760, 72.8777, "Mumbai"], ["VN", "Vietnam", 21.0278, 105.8342, "Hanoi"],
  ["IR", "Iran", 35.6892, 51.3890, "Tehran"], ["KP", "North Korea", 39.0392, 125.7625, "Pyongyang"], ["NL", "Netherlands", 52.3676, 4.9041, "Amsterdam"],
  ["RO", "Romania", 44.4268, 26.1025, "Bucharest"], ["DE", "Germany", 50.1109, 8.6821, "Frankfurt"], ["SG", "Singapore", 1.3521, 103.8198, "Singapore"],
];

// [level, description, affected asset, DMATICS class code]
const rules = [
  [15, "Exploitation sequence against a public web service", "WEB-DMZ-01", "INITIAL"],
  [14, "Known command infrastructure contacted", "FW-EDGE-02", "C2"],
  [13, "Authentication failures followed by success", "DC-CORE-01", "CRED"],
  [13, "Endpoint protection service disabled", "FIN-WS-112", "EVADE"],
  [12, "Impossible travel identity sequence", "IDP-CLOUD", "ACCESS"],
  [12, "Encoded script with outbound callout", "HR-WS-034", "EXEC"],
  [11, "Credential dumping memory pattern", "APP-SRV-03", "CRED"],
  [10, "Privileged account created off-window", "DC-CORE-02", "PERSIST"],
  [9,  "Credential spray threshold exceeded", "BASTION-01", "CRED"],
  [8,  "Registry persistence path modified", "ENG-WS-201", "PERSIST"],
];

// [type, value, description, confidence, feed]
const intelligence = [
  ["IP",      "185.220.101.41",       "Anonymised exit node · credential stuffing wave", 88, "DMATICS INTEL"],
  ["HASH",    "e3b0c442…b855",        "Ransomware dropper family active in region",      94, "DMATICS LABS"],
  ["DOMAIN",  "sso-verify-portal[.]com", "Cloud identity phishing kit",                  91, "PARTNER FEED"],
  ["ADVISORY","DM-2026-014",          "Mail gateway RCE · exploitation observed",        97, "DMATICS LABS"],
  ["ACTOR",   "DESERT VIPER",         "Finance-sector access campaign",                  86, "DMATICS INTEL"],
];

const healthNames = ["CORE-SW-A", "CORE-SW-B", "WAN-PRIMARY", "FIREWALL-HA", "MAIL-GATEWAY", "ERP-CLUSTER"];
let demoSequence = 0;

const randomItem = (items) => items[Math.floor(Math.random() * items.length)];
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function demoAlerts() {
  const count = 1 + Math.floor(Math.random() * 2);
  return Array.from({ length: count }, (_, index) => {
    const rule = randomItem(rules);
    const country = randomItem(countries);
    const variance = Math.random() > .55 ? 1 : 0;
    return {
      id: `demo-${Date.now()}-${index}`,
      ts: Date.now() - index * 1_700,
      level: clamp(rule[0] + variance, 5, 15),
      rule: rule[1],
      agent: rule[2],
      srcCountry: country[0],
      srcCountryName: country[1],
      srcCity: country[4],
      srcLat: country[2] + Math.random() * .08 - .04,
      srcLon: country[3] + Math.random() * .08 - .04,
      tclass: rule[3],
      category: classLabel(rule[3]),
      confidence: 78 + Math.floor(Math.random() * 21),
      risk: 68 + Math.floor(Math.random() * 31),
      status: Math.random() > .28 ? "Contained" : "Investigating",
    };
  });
}

function demoTickets() {
  const shift = demoSequence % 4;
  return { open: 39 + shift, breached: 1, byPriority: { p1: 3, p2: 12 + shift, p3: 24 } };
}

function demoIntel() {
  demoSequence += 1;
  return intelligence.map(([type, value, label, confidence, source], index) => ({
    id: `${type}-${index}`,
    type, value: index === 0 ? value.replace(/\d+$/, String(31 + (demoSequence % 61))) : value,
    label, confidence, source, hot: confidence >= 95, warn: confidence >= 90,
  }));
}

function demoHealth() {
  return healthNames.map((name, serviceIndex) => {
    const beads = Array.from({ length: 24 }, (_, index) => {
      if (serviceIndex === 2 && index === 19) return 1;
      if (serviceIndex === 4 && index === 15) return 1;
      return Math.random() > .992 ? 1 : 0;
    });
    const warnings = beads.filter(Boolean).length;
    return { name, pct: Number((99.99 - warnings * .07).toFixed(2)), beads };
  });
}

async function requestJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`Request failed (${response.status})`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Live detections are mapped onto the DMATICS classification by kill-chain
 * phase. Most detection platforms expose a tactic or category string; this maps
 * the common wordings onto our codes and falls back to Discovery.
 */
const PHASE_HINTS = [
  [/recon|scan|enumerat/i, "RECON"],
  [/initial|exploit|public.facing/i, "INITIAL"],
  [/execut|command.line|script|powershell|interpreter/i, "EXEC"],
  [/persist|autostart|scheduled|account creat/i, "PERSIST"],
  [/escalat|privilege/i, "PRIVESC"],
  [/evasion|impair|disable|tamper/i, "EVADE"],
  [/credential|brute|password|dump/i, "CRED"],
  [/valid account|impossible travel|logon|sign.?in/i, "ACCESS"],
  [/lateral|remote service|pass.the/i, "LATERAL"],
  [/collect|staging|archive/i, "COLLECT"],
  [/exfil|transfer out/i, "EXFIL"],
  [/command and control|c2|beacon/i, "C2"],
  [/impact|ransom|destruct|wipe/i, "IMPACT"],
];

function classify(...hints) {
  const text = hints.filter(Boolean).join(" ");
  for (const [pattern, code] of PHASE_HINTS) if (pattern.test(text)) return code;
  return "DISCOVER";
}

/** @returns {Promise<Array<{ts:number,level:number,rule:string,agent:string,srcCountry:string,srcLat:number,srcLon:number,tclass:string}>>} */
export async function fetchAlerts() {
  if (CONFIG.demo) return demoAlerts();
  const authorization = btoa(`${CONFIG.alerts.user}:${CONFIG.alerts.pass}`);
  const payload = await requestJson(`${CONFIG.alerts.url}/${CONFIG.alerts.index}/_search`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Basic ${authorization}` },
    body: JSON.stringify({ size: 40, sort: [{ timestamp: { order: "desc" } }], query: { range: { timestamp: { gte: "now-15m" } } } }),
  });
  return (payload.hits?.hits ?? []).map(({ _id, _source: source }) => {
    const code = classify(source.rule?.tactic?.[0], source.rule?.technique?.[0], source.rule?.description);
    return {
      id: _id,
      ts: Date.parse(source.timestamp) || Date.now(),
      level: Number(source.rule?.level ?? 0),
      rule: source.rule?.description ?? "Unclassified security event",
      agent: source.agent?.name ?? "UNASSIGNED",
      srcCountry: source.GeoLocation?.country_code ?? source.GeoLocation?.country_name?.slice(0, 2).toUpperCase() ?? "??",
      srcCountryName: source.GeoLocation?.country_name ?? "Unknown",
      srcCity: source.GeoLocation?.city_name ?? source.GeoLocation?.city ?? source.GeoLocation?.location?.city ?? "Unknown location",
      srcLat: Number(source.GeoLocation?.location?.lat),
      srcLon: Number(source.GeoLocation?.location?.lon),
      tclass: code,
      category: classLabel(code),
      confidence: clamp(Number(source.rule?.level ?? 5) * 6, 45, 99),
      risk: clamp(Number(source.rule?.level ?? 5) * 7, 40, 99),
      status: "Investigating",
    };
  });
}

/** @returns {Promise<{open:number,breached:number,byPriority:{p1:number,p2:number,p3:number}}>} */
export async function fetchTickets() {
  if (CONFIG.demo) return demoTickets();
  const payload = await requestJson(`${CONFIG.tickets.url}/requests?status=open`, {
    headers: { Authorization: `Bearer ${CONFIG.tickets.token}`, Accept: "application/json" },
  });
  const records = payload.requests ?? payload.data ?? payload.result ?? [];
  const count = (priority) => records.filter((item) => String(item.priority?.name ?? item.priority).toLowerCase().includes(priority)).length;
  return {
    open: Number(payload.total ?? payload.totalCount ?? records.length),
    breached: records.filter((item) => item.slaBreached === true || item.sla_status === "breached").length,
    byPriority: { p1: count("p1") || count("critical"), p2: count("p2") || count("high"), p3: count("p3") || count("medium") },
  };
}

/** @returns {Promise<Array<{type:string,value:string,label:string,confidence:number,source:string}>>} */
export async function fetchIntel() {
  if (CONFIG.demo) return demoIntel();
  const query = `query WallIndicators { indicators(first: 25, orderBy: created_at, orderMode: desc) { edges { node { id name pattern_type description score createdBy { name } } } } }`;
  const payload = await requestJson(CONFIG.intel.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${CONFIG.intel.token}` },
    body: JSON.stringify({ query }),
  });
  return (payload.data?.indicators?.edges ?? []).map(({ node }) => ({
    id: node.id, type: node.pattern_type ?? "IOC", value: node.name,
    label: node.description ?? "Observed threat indicator", confidence: Number(node.score ?? 50),
    source: node.createdBy?.name ?? "THREAT INTEL",
  }));
}

/** @returns {Promise<Array<{name:string,pct:number,beads:number[]}>>} */
export async function fetchHealth() {
  if (CONFIG.demo) return demoHealth();
  const payload = await requestJson(`${CONFIG.network.url}/device/listDevices?apiKey=${encodeURIComponent(CONFIG.network.key)}`);
  const devices = payload.rows ?? payload.devices ?? payload.data ?? [];
  return devices.slice(0, 8).map((device) => {
    const available = String(device.status ?? device.availability).toLowerCase().includes("up");
    const history = device.availabilityHistory ?? [];
    return {
      name: device.displayName ?? device.name ?? "UNNAMED SERVICE",
      pct: Number(device.availabilityPct ?? device.availability ?? (available ? 100 : 0)),
      beads: Array.from({ length: 24 }, (_, index) => Number(history[index]?.state ?? (available ? 0 : 2))),
    };
  });
}

Object.assign(globalThis, { fetchAlerts, fetchTickets, fetchIntel, fetchHealth });
