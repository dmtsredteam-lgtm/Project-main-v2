import { registerDetail } from "./details.js";
import { escapeHtml } from "./escape.js";

export function renderHealth(element, services) {
  // The lower deck's second slot holds the GISEC arena board at the booth, so
  // this list is not always on the page. The availability poll still runs — it
  // feeds adapter health — it just has nowhere to draw.
  if (!element) return;
  element.innerHTML = services.slice(0, 6).map((service, index) => {
    const warnings = service.beads.filter((state) => state === 1).length;
    const outages = service.beads.filter((state) => state === 2).length;
    const detailId = `health-${index}`;
    registerDetail(detailId, {
      eyebrow: "INFRASTRUCTURE SERVICE", title: service.name, subtitle: "Network availability and service-state history", status: outages ? "OUTAGE" : warnings ? "DEGRADED" : "NOMINAL", statusTone: outages ? "hot" : warnings ? "warning" : "good",
      metrics: [{ label: "Availability", value: `${service.pct.toFixed(2)}%`, tone: service.pct < 99 ? "warning" : "good" }, { label: "Warnings", value: warnings }, { label: "Outages", value: outages, tone: outages ? "hot" : "good" }, { label: "Samples", value: service.beads.length }],
      sections: [{ title: "Service state", items: [{ label: "Device / service", value: service.name }, { label: "Current state", value: outages ? "Down event observed" : warnings ? "Warning event observed" : "Available" }, { label: "Availability", value: `${service.pct.toFixed(2)}%` }] }, { title: "Observation history", items: [{ label: "Healthy samples", value: service.beads.filter((state) => state === 0).length }, { label: "Warning samples", value: warnings }, { label: "Down samples", value: outages }] }],
      source: "DMATICS NETWORK MONITOR", recommendation: outages ? "Open the device view, validate reachability, and begin the infrastructure incident workflow." : warnings ? "Review latency, packet loss, and resource utilization before the service degrades further." : "No immediate action required; continue availability monitoring.",
    });
    const stateLabel = outages ? "DOWN EVENT" : warnings ? "DEGRADED" : "NOMINAL";
    return `<div class="health-row" data-detail-id="${escapeHtml(detailId)}" role="button" tabindex="0" aria-haspopup="dialog"><span><strong>${escapeHtml(service.name)}</strong><small>${escapeHtml(stateLabel)} / W${warnings} / D${outages}</small></span><div class="health-beads">${service.beads.slice(-24).map((state) => `<i class="${state === 2 ? "down" : state === 1 ? "warn" : ""}"></i>`).join("")}</div><b class="${service.pct < 99 ? "warning" : ""}">${service.pct.toFixed(2)}</b></div>`;
  }).join("");
}
