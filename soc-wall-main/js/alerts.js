import { buildTimelineEntries } from "./timeline.js";
import { registerDetail } from "./details.js";
import { fullStamp } from "./clock.js";
import { escapeHtml, finite, text } from "./escape.js";

const severityFor = (level) => level >= 13 ? "critical" : level >= 10 ? "high" : "medium";

/* Everything the wall counts is counted over a window, not since page load.
 *
 * The original store incremented for the lifetime of the tab. On a desk that is
 * invisible; on a stand that runs from nine to six it means CRITICAL ALERTS
 * reads four figures by lunchtime and the number stops meaning anything. A SOC
 * quotes a window, so this one does too. */
const WINDOW_MS = 15 * 60_000;
export const CRITICAL_BASELINE = 14;   // the standing queue this booth is "carrying"
const EVENT_BASELINE = 238;

export function createAlertStore({ max = 10, onChange, onAttack }) {
  const alerts = [];
  const seen = new Set();
  const origins = new Map();
  const criticalTimes = [];
  const eventTimes = [];

  /* Everything that arrives from the hub goes through here first.
   *
   * This is the single most load-bearing guard on the wall. Without it one
   * alert with a non-numeric `ts` permanently stalls the three prune loops
   * below — they walk from the head and stop at the first entry that does not
   * compare, so a NaN parks there forever and every later event accumulates.
   * Left alone for four days that is ~350,000 retained records and a counter
   * reading "EVENTS / 15 MIN 357,738".
   *
   * A missing srcLat is worse and faster: `undefined.toFixed(4)` throws inside
   * renderAlertCards, which aborts the rest of renderAlertState AND stops
   * theatre.showAlert() from ever running — so the booth event that just
   * happened gets no detection band, no red screen and no klaxon. The show
   * silently stops working while the globe keeps spinning.
   *
   * Coercing here means every downstream module can trust its inputs. */
  function normalise(alert) {
    const level = Math.round(finite(alert.level, 8));
    return {
      ...alert,
      id: alert.id === undefined || alert.id === null ? undefined : String(alert.id),
      ts: finite(alert.ts, Date.now()),
      level: Math.min(15, Math.max(1, level)),
      risk: Math.round(finite(alert.risk, 50)),
      confidence: Math.round(finite(alert.confidence, 80)),
      srcLat: finite(alert.srcLat, 0),
      srcLon: finite(alert.srcLon, 0),
      rule: text(alert.rule, "Unclassified detection"),
      agent: text(alert.agent, "UNASSIGNED", 60),
      tclass: text(alert.tclass, "UNKNOWN", 24),
      status: text(alert.status, "Investigating", 32),
      srcCity: text(alert.srcCity, "Unknown", 60),
      srcCountry: text(alert.srcCountry, "??", 8),
      srcCountryName: text(alert.srcCountryName, text(alert.srcCountry, "Unknown", 8), 60),
    };
  }

  function add(batch) {
    for (const raw of batch) {
      const alert = normalise(raw);
      if (alert.id && seen.has(alert.id)) continue;
      if (alert.id) seen.add(alert.id);
      eventTimes.push(alert.ts);
      alerts.unshift({ ...alert, severity: severityFor(alert.level) });
      if (alert.level >= 13) criticalTimes.push(alert.ts);
      const origin = origins.get(alert.srcCountry) ?? { code: alert.srcCountry, name: alert.srcCountryName, count: 0, criticalCount: 0, lastSeen: alert.ts };
      origin.count += 1;
      if (alert.level >= 13) origin.criticalCount += 1;
      origin.lastSeen = Math.max(finite(origin.lastSeen, 0), alert.ts);
      origin.name = alert.srcCountryName;
      origins.set(alert.srcCountry, origin);
      onAttack?.(alert);
    }
    alerts.length = Math.min(alerts.length, max);
    /* FIFO, not clear(). A full wipe every ~8 minutes let a reconnect snapshot
     * replay alerts that had already been counted — double-counting origins and
     * re-firing hour-old arcs across the globe. */
    if (seen.size > 500) {
      const excess = seen.size - 400;
      let dropped = 0;
      for (const key of seen) { seen.delete(key); if (++dropped >= excess) break; }
    }
    prune();
    onChange?.({
      alerts: [...alerts], origins: sortedOrigins(), originCount: origins.size,
      totalEvents: EVENT_BASELINE + eventTimes.length,
      criticalCount: CRITICAL_BASELINE + criticalTimes.length,
    });
  }

  /* Drop anything older than the window, and age origins out with it so the
     TOP ORIGINS list reflects the last quarter hour rather than the whole day. */
  function prune() {
    const cutoff = Date.now() - WINDOW_MS;
    while (criticalTimes.length && criticalTimes[0] < cutoff) criticalTimes.shift();
    while (eventTimes.length && eventTimes[0] < cutoff) eventTimes.shift();
    for (const [code, origin] of origins) if (origin.lastSeen < cutoff) origins.delete(code);
  }

  function sortedOrigins() {
    return [...origins.values()].sort((left, right) => right.count - left.count).slice(0, 5);
  }

  setInterval(prune, 30_000);

  return { add, getCriticalCount: () => CRITICAL_BASELINE + criticalTimes.length, getAlerts: () => [...alerts], getOrigins: sortedOrigins };
}

export function renderOrigins(element, origins) {
  const maximum = Math.max(1, ...origins.map(({ count }) => count));
  element.innerHTML = origins.map(({ code, name, count, criticalCount, lastSeen }) => {
    const detailId = `origin-${code}`;
    registerDetail(detailId, {
      eyebrow: "GEOSPATIAL ORIGIN", title: name, subtitle: `${count} correlated events from ${code} during the current observation window`, status: "OBSERVED",
      metrics: [{ label: "Country code", value: code }, { label: "Events", value: count, tone: count > 8 ? "hot" : "warning" }, { label: "Critical", value: criticalCount, tone: criticalCount ? "hot" : "good" }, { label: "Share", value: `${Math.round((count / maximum) * 100)}%` }],
      sections: [{ title: "Origin context", items: [{ label: "Country", value: name }, { label: "ISO code", value: code }, { label: "Last seen", value: fullStamp(new Date(lastSeen)) }, { label: "Telemetry", value: "DMATICS sensor grid" }] }, { title: "Analyst interpretation", items: [{ label: "Pattern", value: "Multi-signal source activity" }, { label: "Disposition", value: "Requires correlation with IOC reputation" }] }],
      source: "DMATICS GEOSPATIAL CORRELATION", recommendation: "Review the associated source addresses and validate whether the activity is automated scanning or targeted access.",
    });
    const share = Math.round((count / maximum) * 100);
    return `<div class="origin-row" data-detail-id="${escapeHtml(detailId)}" role="button" tabindex="0" aria-haspopup="dialog" title="Open details for ${escapeHtml(name)}"><span>${escapeHtml(code)}</span><em>${escapeHtml(name)}<small>${criticalCount} CRIT / ${share}%</small></em><i style="--value:${Math.max(12, share)}%"></i><b>${String(count).padStart(2, "0")}</b></div>`;
  }).join("");
}

export function renderAlertCards(element, alerts) {
  element.innerHTML = buildTimelineEntries(alerts.slice(0, 3)).map((alert, index) => {
    const flag = alert.srcCountry?.length === 2 ? String.fromCodePoint(...[...alert.srcCountry.toUpperCase()].map((letter) => 127397 + letter.charCodeAt())) : "◈";
    const detailId = `alert-${index}`;
    registerDetail(detailId, {
      eyebrow: `SECURITY INCIDENT · LEVEL ${alert.level}`, title: alert.rule, subtitle: `${alert.category} detected on ${alert.agent}`, status: alert.status, statusTone: alert.status === "Contained" ? "good" : "hot",
      metrics: [{ label: "Risk score", value: `${alert.risk}/100`, tone: alert.risk >= 85 ? "hot" : "warning" }, { label: "Confidence", value: `${alert.confidence}%` }, { label: "Class", value: alert.category ?? alert.tclass }, { label: "Severity", value: `L${alert.level}`, tone: alert.level >= 13 ? "hot" : "warning" }],
      sections: [{ title: "Incident evidence", items: [{ label: "Rule", value: alert.rule }, { label: "Agent", value: alert.agent }, { label: "Category", value: alert.category }, { label: "Timestamp", value: fullStamp(new Date(alert.ts)) }] }, { title: "Geospatial evidence", items: [{ label: "City", value: alert.srcCity }, { label: "Country", value: alert.srcCountryName }, { label: "Coordinates", value: `${alert.srcLat.toFixed(5)}, ${alert.srcLon.toFixed(5)}` }, { label: "Country code", value: alert.srcCountry }] }],
      source: "DMATICS DETECTION ENGINE", recommendation: alert.status === "Contained" ? "Validate containment and preserve supporting telemetry for post-incident review." : "Triage the affected host, correlate the source against intelligence, and isolate the session if activity persists.",
    });
    return `<article class="alert-card ${escapeHtml(alert.severity)}" data-detail-id="${escapeHtml(detailId)}" role="button" tabindex="0" aria-haspopup="dialog">
      <div class="alert-severity"><i></i><b>L${alert.level}</b></div>
      <div class="alert-copy"><strong>${escapeHtml(alert.rule)}</strong><span>${escapeHtml(flag)} ${escapeHtml(alert.agent)} / ${escapeHtml(alert.tclass)} / ${escapeHtml(alert.srcCity)}, ${escapeHtml(alert.srcCountryName)}</span></div>
      <div class="alert-score"><time>${escapeHtml(alert.timeLabel)}</time><b>${alert.risk}</b></div>
      <div class="alert-detail"><span>${alert.srcLat.toFixed(4)}, ${alert.srcLon.toFixed(4)}</span><span>CONF ${alert.confidence}%</span><span>${escapeHtml(alert.status)}</span></div>
    </article>`;
  }).join("");
}
