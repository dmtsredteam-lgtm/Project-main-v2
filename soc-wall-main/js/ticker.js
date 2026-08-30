import { registerDetail } from "./details.js";
import { escapeHtml } from "./escape.js";

export function renderTicker(element, intelligence) {
  const items = intelligence.map((item) => `<span class="ticker-item"><b class="${item.hot ? "hot" : item.warn ? "warning" : ""}">${escapeHtml(item.type)}</b>${escapeHtml(item.value)} / ${escapeHtml(item.label)} / ${escapeHtml(item.source)} / CONF ${escapeHtml(item.confidence)}% / NOW</span>`).join("");
  element.innerHTML = items + items;
}

export function renderIntel(element, intelligence) {
  if (!element) return;   // panel removed at the booth; the ticker carries it
  element.innerHTML = intelligence.slice(0, 3).map((item, index) => {
    const detailId = `intel-${index}`;
    registerDetail(detailId, {
      eyebrow: "THREAT INTELLIGENCE OBJECT", title: item.value, subtitle: item.label, status: item.hot ? "CRITICAL IOC" : "TRACKED", statusTone: item.hot ? "hot" : "warning",
      metrics: [{ label: "Confidence", value: `${item.confidence}%`, tone: item.hot ? "hot" : "warning" }, { label: "Object type", value: item.type }, { label: "Source", value: item.source }, { label: "State", value: item.hot ? "ACTION" : "MONITOR" }],
      sections: [{ title: "Indicator context", items: [{ label: "Value", value: item.value }, { label: "Classification", value: item.label }, { label: "Source", value: item.source }] }, { title: "Correlation guidance", items: [{ label: "Search scope", value: "Endpoints, DNS, proxy, identity" }, { label: "Time window", value: "Last 30 days" }, { label: "Priority", value: item.confidence >= 90 ? "High" : "Standard" }] }],
      source: "DMATICS INTELLIGENCE PIPELINE", recommendation: "Search historical telemetry for this indicator and escalate any matching internal activity into an incident.",
    });
    const action = item.confidence >= 95 ? "BLOCK" : item.confidence >= 90 ? "SEARCH" : "MONITOR";
    return `<article class="intel-card" data-detail-id="${escapeHtml(detailId)}" role="button" tabindex="0" aria-haspopup="dialog"><span class="type ${item.hot ? "hot" : ""}">${escapeHtml(item.type)}</span><div><strong>${escapeHtml(item.value)}</strong><small>${escapeHtml(item.source)} / CONF ${item.confidence}% / ${escapeHtml(action)} / NOW</small></div><b class="score ${item.hot ? "hot" : ""}">${escapeHtml(action)}</b></article>`;
  }).join("");
}
