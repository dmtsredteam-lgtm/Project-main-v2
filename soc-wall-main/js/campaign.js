/* ===========================================================================
 * Live campaign intelligence.
 *
 * The ACTIVE CAMPAIGN card and the DMATICS AI assessment used to be furniture:
 * a hard-coded "DESERT VIPER / 14 signals / 3 targets / risk 92" and three
 * canned sentences on an eleven-second rotation. Both sat perfectly still while
 * the globe behind them threw attacks around the world, which is the one thing
 * a wall like this must never do — a panel that never moves reads as a
 * screenshot, and a visitor works that out in about fifteen seconds.
 *
 * Everything either panel says is now derived from the same alert stream the
 * globe and the timeline draw from. When the traffic shifts from credential
 * attacks to exfiltration, the campaign changes name, the class changes, the
 * affected asset changes, the confidence moves, and the analyst says something
 * different — because the picture underneath changed, not because a timer went
 * off.
 *
 * The hard part is not deriving it. It is deriving it SLOWLY ENOUGH.
 *
 * The alert window holds eight items, so "which class is dominant" flips on a
 * difference of one signal. Wired naively, the card renamed itself four times
 * in seventy seconds — which looks more broken than the frozen version did,
 * because random movement is worse than no movement. Two dampers fix it:
 *
 *   A campaign has to EARN the switch. A challenger must lead the incumbent by
 *   two signals, or lead at all for a sustained stretch, before the card
 *   renames. Real intel teams do not rename a cluster because one more alert
 *   arrived, and neither does this.
 *
 *   The assessment is keyed to the campaign, not to the raw numbers. It is
 *   re-typed when the story changes, not when a count ticks — otherwise the
 *   panel restarts its typing animation faster than it can finish a sentence,
 *   and every sentence on screen is already out of date.
 * ========================================================================= */

import { classLabel } from "./api.js";

/* One name per class. Chosen to sound like the label an intel team assigned two
 * quarters ago — not colours, not adjective-plus-animal, nothing that reads as
 * generated on the spot. */
const CAMPAIGN_NAMES = {
  INITIAL:  "SANDGLASS DRIFT",
  EXEC:     "HOLLOW MERIDIAN",
  PERSIST:  "LOW TIDE",
  PRIVESC:  "BRASS HALO",
  EVADE:    "NULL COMPASS",
  CRED:     "DESERT VIPER",
  ACCESS:   "SILENT FERRY",
  DISCOVER: "PALE LANTERN",
  LATERAL:  "SHORT CIRCUIT",
  COLLECT:  "GLASS HARVEST",
  EXFIL:    "AMBER CURRENT",
  C2:       "IRON THISTLE",
  IMPACT:   "BROKEN TALLY",
  CONTAIN:  "STANDING ORDER",
  TRAINING: "OPEN HOUSE",
};

/* What each class is actually going after. The card's second line used to say
 * "cloud identity" whatever was happening on the globe. */
const CLASS_SURFACE = {
  INITIAL:  "internet-facing services",
  EXEC:     "endpoint execution",
  PERSIST:  "account persistence",
  PRIVESC:  "domain privilege",
  EVADE:    "endpoint protection",
  CRED:     "cloud identity",
  ACCESS:   "valid account sessions",
  DISCOVER: "internal reconnaissance",
  LATERAL:  "east-west movement",
  COLLECT:  "file shares and mailboxes",
  EXFIL:    "outbound data paths",
  C2:       "command infrastructure",
  IMPACT:   "service availability",
  CONTAIN:  "contained sessions",
  TRAINING: "the visitor tablets",
};

/* A campaign is a cluster an intel team has been tracking for months, so the
 * name has to behave like one.
 *
 * The first attempt read the dominant class off the eight alerts the timeline
 * happens to be showing, and renamed the card three times a minute. The reason
 * was not the margin — it was the memory. Eight items is small enough that the
 * class currently on the card regularly drops to zero occurrences, and an
 * incumbent on zero loses every contest instantly.
 *
 * So the campaign reasons over its own ten-minute history of everything that
 * has come past, not over the handful on screen. That is also the honest number
 * to print: "14 signals" should mean the campaign has produced fourteen
 * signals, not that fourteen of them fit in the panel.
 *
 * The liveness Jeff asked for comes from the numbers underneath, which move
 * every few seconds — signals, targets, risk, contained, origin country — while
 * the name stays still long enough to be believed. */
const HISTORY_MS = 10 * 60_000;
const SWITCH_MARGIN = 4;             // signals ahead of the incumbent, or...
const SWITCH_PATIENCE_MS = 120_000;  // ...this long in front by any margin.

const pad = (value) => String(value).padStart(2, "0");
const sentenceCase = (text) => text.charAt(0).toUpperCase() + text.slice(1);

function tally(values) {
  const counts = new Map();
  for (const value of values) if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function leaderOf(counts) {
  let best = null;
  let bestCount = 0;
  for (const [value, count] of counts) if (count > bestCount) { best = value; bestCount = count; }
  return { value: best, count: bestCount };
}

/**
 * Holds the campaign currently on the card, so it can resist being renamed.
 */
export function createIntel() {
  let held = null;            // class code the card is currently showing
  let challenger = null;      // class code trying to take over
  let challengerSince = 0;

  /* Ten minutes of everything seen, deduplicated. The panel is handed the same
   * eight alerts on every batch, so without the id check this would count each
   * one dozens of times. */
  const history = [];
  const seen = new Set();

  function remember(alerts, now) {
    for (const alert of alerts) {
      const key = alert.id ?? `${alert.ts}:${alert.rule}`;
      if (seen.has(key)) continue;
      seen.add(key);
      history.push({
        key, ts: Number.isFinite(alert.ts) ? alert.ts : now, tclass: alert.tclass, agent: alert.agent,
        risk: alert.risk, level: alert.level, status: alert.status,
      });
    }
    const cutoff = now - HISTORY_MS;
    while (history.length && history[0].ts < cutoff) seen.delete(history.shift().key);
    if (seen.size > 4_000) { seen.clear(); for (const entry of history) seen.add(entry.key); }
  }

  /** Decide which class the card should be about, with hysteresis. */
  function settleClass(counts, now) {
    const leader = leaderOf(counts);
    if (!leader.value) return held ?? "CRED";
    if (!held) { held = leader.value; return held; }
    if (leader.value === held) { challenger = null; return held; }

    const heldCount = counts.get(held) ?? 0;

    // A clear lead takes the card immediately.
    if (leader.count - heldCount >= SWITCH_MARGIN) {
      held = leader.value;
      challenger = null;
      return held;
    }

    // A narrow lead has to hold it for a while.
    if (challenger !== leader.value) { challenger = leader.value; challengerSince = now; }
    else if (now - challengerSince >= SWITCH_PATIENCE_MS) { held = leader.value; challenger = null; }
    return held;
  }

  /**
   * Reduce the live alert window to the numbers both panels need.
   *
   * Everything describing the campaign is scoped to the campaign's own class,
   * across the ten-minute history. Mixing the campaign's class with the whole
   * window's assets was how the card ended up claiming three signals against
   * six targets, which is not a thing that can happen.
   */
  function read(state, now = Date.now()) {
    const alerts = state.alerts ?? [];
    const origins = state.origins ?? [];
    remember(alerts, now);

    const classCode = settleClass(tally(history.map((entry) => entry.tclass)), now);
    const scope = history.filter((entry) => entry.tclass === classCode);

    const risks = scope.map((entry) => entry.risk).filter(Number.isFinite);
    const levels = scope.map((entry) => entry.level).filter(Number.isFinite);
    const assets = tally(scope.map((entry) => entry.agent));
    // Same rule as the critical panel: count "Contained", do not assume that
    // anything which is not "Investigating" must therefore be handled.
    const contained = scope.filter((entry) => entry.status === "Contained").length;
    /* Peak severity and top asset come from the recent end of the campaign, not
     * from all ten minutes — an hour-old severity 15 is history, not news. */
    const recent = scope.filter((entry) => now - entry.ts < 120_000);
    const recentLevels = recent.map((entry) => entry.level).filter(Number.isFinite);

    return {
      classCode,
      classLabel: classLabel(classCode),
      surface: CLASS_SURFACE[classCode] ?? "the estate",
      campaign: CAMPAIGN_NAMES[classCode] ?? "IRON THISTLE",

      signals: scope.length,               // signals in THIS campaign
      targets: Math.max(1, assets.size),   // distinct assets in THIS campaign
      asset: leaderOf(assets).value ?? "—",
      contained,
      peakLevel: recentLevels.length ? Math.max(...recentLevels) : (levels.length ? Math.max(...levels) : 0),
      risk: risks.length ? Math.max(...risks) : 0,

      windowSignals: alerts.length,        // the whole window, for context
      countries: state.originCount ?? origins.length,
      events: state.totalEvents ?? 0,
      topOrigin: origins[0] ?? null,
    };
  }

  return { read };
}

/** The ACTIVE CAMPAIGN card, shaped exactly like the live-station model. */
export function deriveCampaign(picture) {
  const risk = picture.risk || 40;
  return {
    eyebrow: "ACTIVE CAMPAIGN",
    title: picture.campaign,
    line: `${picture.classLabel} / ${picture.surface}`,
    signals: `${picture.signals} signals / ${picture.targets} targets / risk ${risk}`,
    foot: picture.topOrigin
      ? `${picture.classCode} · ${pad(picture.contained)}/${pad(picture.signals)} CONTAINED · ${String(picture.topOrigin.name ?? "UNKNOWN").toUpperCase()}`
      : `${picture.classCode} · ${pad(picture.contained)}/${pad(picture.signals)} CONTAINED`,
    /* The bar under the card is the SOC's confidence in the cluster. Risk runs
     * 40–99, so it is remapped rather than used raw — a quiet booth should not
     * show a half-full bar. */
    heat: Math.round(Math.max(6, Math.min(96, (risk - 38) * 1.55))),
    tone: picture.peakLevel >= 14 ? "hot" : picture.peakLevel >= 12 ? "warning" : "",
  };
}

/**
 * What the analyst says about the current picture.
 *
 * Deliberately short. The panel types at roughly seventy characters a second,
 * so a two-hundred-character sentence is still being written when the traffic
 * behind it has already moved on. Three shapes, picked by what is actually
 * notable — escalation, concentration, or quiet.
 */
export function composeAssessment(picture) {
  const confidence = Math.max(48, Math.min(97, Math.round(picture.risk || 60)));
  const facts = {
    campaign: picture.campaign,
    technique: picture.classLabel.toUpperCase(),
    affected: picture.asset,
    confidence,
  };

  const origin = picture.topOrigin;
  const concentrated = origin && picture.windowSignals > 0
    && origin.count / picture.windowSignals >= 0.34;

  let text;
  if (picture.peakLevel >= 14) {
    text = `Severity ${picture.peakLevel} on ${picture.asset}. `
      + `${sentenceCase(picture.classLabel.toLowerCase())} against ${picture.surface}, `
      + `${picture.contained} of ${picture.signals} contained.`;
  } else if (concentrated) {
    text = `${origin.name} is behind ${origin.count} of the last ${picture.windowSignals} signals, `
      + `on ${picture.surface}. Peak severity ${picture.peakLevel}.`;
  } else if (picture.windowSignals <= 2) {
    text = `Baseline only — ${picture.events.toLocaleString()} events from ${pad(picture.countries)} countries, `
      + `nothing above severity ${picture.peakLevel || 8}.`;
  } else {
    text = `${picture.signals} ${picture.classLabel.toLowerCase()} signals across `
      + `${picture.targets} assets, ${pad(picture.countries)} source countries. Spread, not concentrated.`;
  }

  return { text, facts };
}

/**
 * When to re-type.
 *
 * Keyed to the campaign and the severity band rather than to raw counts, so the
 * panel speaks when the story changes and stays quiet while the numbers jitter
 * underneath it.
 */
export function storySignature(picture) {
  const band = picture.peakLevel >= 14 ? "critical" : picture.peakLevel >= 12 ? "elevated" : "base";
  return [picture.campaign, band, picture.topOrigin?.code ?? "-"].join("|");
}
