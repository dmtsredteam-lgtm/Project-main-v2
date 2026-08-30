import { shortTime } from "./clock.js";

const states = ["critical", "correlated", "contained"];

/**
 * Enriches normalized alerts with timeline presentation state without coupling
 * the data adapter to DOM rendering.
 */
export function buildTimelineEntries(alerts) {
  return alerts.map((alert, index) => ({
    ...alert,
    timelineState: alert.level >= 13 ? states[0] : states[(index % 2) + 1],
    timeLabel: shortTime(new Date(alert.ts)),
  }));
}

