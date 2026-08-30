/**
 * Response theatre — the part of the wall that reacts to the booth laptops.
 *
 * Four surfaces:
 *
 *   1. the hero's ACTIVE CAMPAIGN card becomes the live operation card while a
 *      station is running, showing the operator, their stage, and a heat bar
 *      that fills as the SOC's confidence in the intrusion grows;
 *   2. the DMATICS AI panel speaks the actual detection instead of its scripted
 *      assessment, then hands back to the loop;
 *   3. a detection band drops under the hero title reading
 *      "SOC HAS DETECTED — …", and
 *   4. the whole wall goes into a red emergency state behind it.
 *
 * The heat bar is the piece that earns its place. A visitor at a laptop cannot
 * see how close they are to being caught — the crowd at the big screen can, and
 * they tell them. That gap is the whole show: detection is visible before
 * containment lands, so the interruption reads as consequence rather than as a
 * random pop-up.
 */

import { finite } from "./escape.js";

const POSTURE = {
  CLEAR:       { label: "NOMINAL",    tone: "" },
  WATCHED:     { label: "INSPECTING", tone: "warning" },
  THROTTLED:   { label: "THROTTLED",  tone: "hot" },
  CONTAINED:   { label: "CONTAINED",  tone: "hot" },
  COMPROMISED: { label: "BREACHED",   tone: "warning" },
};

/* The card's resting state. This is only the first frame — main.js replaces it
 * from the live alert stream on every batch through setIdleCampaign(), so what
 * is written here is what the wall shows for the second and a half before the
 * first alerts land, and nothing more. */
let IDLE_CARD = {
  eyebrow: "ACTIVE CAMPAIGN",
  title: "DESERT VIPER",
  line: "Credential access / cloud identity",
  signals: "— signals / — targets / risk —",
  foot: "CORRELATING LIVE TELEMETRY",
  heat: 12,
  tone: "",
};

/* An alarm that fires on every passing event is wallpaper. Only booth activity
 * at real severity, or an actual SOC response, takes the screen — the ambient
 * telemetry underneath never does. */
const ALARM_LEVEL = 12;
const ALARM_HOLD_MS = 7_000;
const BAND_DEBOUNCE_MS = 3_500;

export function createResponseTheatre({ card, banner, alarm, orb, ai, audio }) {
  let live = null;              // the station currently driving the card
  let idleTimer = null;
  let bannerTimer = null;
  let alarmTimer = null;
  let lastBandAt = 0;
  let lastBandSeverity = 0;

  // ---- hero operation card ------------------------------------------------
  function paintCard(model) {
    if (!card?.title) return;
    card.eyebrow.textContent = model.eyebrow;
    card.title.textContent = model.title;
    card.line.textContent = model.line;
    card.signals.textContent = model.signals;
    card.foot.textContent = model.foot;
    card.root.classList.toggle("is-live", model.eyebrow !== IDLE_CARD.eyebrow);
    card.root.dataset.tone = model.tone ?? "";
    if (card.heat) {
      card.heat.style.setProperty("--heat", `${Math.max(4, Math.min(100, model.heat))}%`);
      card.heat.dataset.tone = model.tone ?? "";
    }
  }

  function goIdle() {
    live = null;
    paintCard(IDLE_CARD);
  }

  /* Stations stop emitting the moment a visitor walks off. Rather than leaving a
     stale operator on the hero, drop back to the standing campaign after a
     minute of silence. */
  function armIdleTimer() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(goIdle, 60_000);
  }

  function showStation(station) {
    if (!station) return;
    /* Whichever station is hottest owns the hero card.
     *
     * This used to also require `station.lastSeen < live.lastSeen`, which an
     * incoming event can essentially never satisfy — it is by construction the
     * most recent. So the guard never fired and the newest event always seized
     * the card: laptop A mid-intrusion at heat 88 would lose the hero to
     * laptop B idling at heat 5, then take it back on its next event. With two
     * stations emitting once a second the card simply thrashed. */
    if (live && live.id !== station.id && finite(station.heat) < finite(live.heat)) return;
    if (!station.active && station.posture === "CLEAR") { if (live?.id === station.id) goIdle(); return; }

    live = station;
    const posture = POSTURE[station.posture] ?? POSTURE.CLEAR;
    /* Every number here is coerced. A station payload missing startedAt or
     * heat used to render "undefined signals / undefined/5 objectives / heat
     * NaN" in the largest type on the screen, and set `--heat: NaN%`, which is
     * an invalid CSS value the bar silently ignores. */
    const started = finite(station.startedAt, Date.now());
    const elapsed = Math.max(0, Math.round((Date.now() - started) / 1000));
    paintCard({
      eyebrow: "LIVE INTRUSION · RED TEAM ARENA",
      title: station.player ?? "UNIDENTIFIED OPERATOR",
      line: `${station.id ?? "STATION"} / ${station.stage ?? "Reconnaissance"}`,
      signals: `${finite(station.events)} signals / ${finite(station.flags)}/5 objectives / heat ${Math.round(finite(station.heat))}`,
      foot: `${posture.label} / ${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")} ELAPSED`,
      heat: finite(station.heat),
      tone: posture.tone,
    });
    armIdleTimer();
  }

  // ---- emergency state ----------------------------------------------------
  /**
   * Red-alert the whole wall.
   *
   * `tone` drives how hard: "warning" for a detection, "hot" for containment.
   * Re-arming an active alarm just extends it rather than restarting the
   * animation, so a burst of detections reads as one sustained emergency
   * instead of a strobe.
   */
  function raiseAlarm(tone) {
    if (!alarm) return;
    alarm.dataset.tone = tone;
    alarm.classList.add("is-live");
    document.body.classList.add("is-alarm");
    if (orb) orb.dataset.alarm = "1";
    clearTimeout(alarmTimer);
    alarmTimer = setTimeout(() => {
      alarm.classList.remove("is-live");
      document.body.classList.remove("is-alarm");
      if (orb) delete orb.dataset.alarm;
    }, ALARM_HOLD_MS);
  }

  function showBand({ eyebrow, title, detail, target, tone, holdMs }) {
    if (!banner?.root) return;
    banner.eyebrow.textContent = eyebrow;
    banner.title.textContent = title;
    banner.detail.textContent = detail ?? "";
    banner.target.textContent = target ?? "—";
    banner.root.dataset.tone = tone;
    banner.root.classList.add("is-open");
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => banner.root.classList.remove("is-open"), holdMs);
  }

  // ---- a live booth detection --------------------------------------------
  /** A hub alert that came from a booth game, not from the ambient feed. */
  function showAlert(alert) {
    const meta = alert.gisec;
    if (!meta || meta.source !== "redteam") return;

    ai?.speak?.(
      `${alert.rule} — ${meta.station}, operator ${meta.player}. ${meta.detail || alert.category}.`,
      { technique: alert.category ?? alert.tclass, campaign: meta.player, affected: meta.station,
        confidence: alert.confidence, signals: `L${alert.level} / RED TEAM ARENA` }
    );

    if (alert.level < ALARM_LEVEL) {
      audio?.detect?.(alert.level);
      return;
    }

    // Detections arrive in bursts. Hold the band on the first one and let a more
    // severe event override it, rather than flickering through every line.
    const now = Date.now();
    if (now - lastBandAt < BAND_DEBOUNCE_MS && alert.level <= lastBandSeverity) return;
    lastBandAt = now;
    lastBandSeverity = alert.level;

    /* "SOC HAS DETECTED" belongs on the eyebrow, not glued to the front of the
     * title. It is the same eighteen characters every single time, and at the
     * title's size they were pushing the part that actually differs — the rule
     * — onto a third and fourth line, where the two-line clamp cut it off. On
     * the eyebrow it still reads as one sentence down the band, and the rule
     * gets the full width at full size. */
    showBand({
      eyebrow: `SOC HAS DETECTED · SEVERITY ${alert.level} · LIVE`,
      title: String(alert.rule).toUpperCase(),
      detail: `${meta.station} · operator ${meta.player}${meta.stage ? ` · ${meta.stage}` : ""}. ${meta.detail || alert.category}`,
      target: meta.station,
      tone: alert.level >= 14 ? "hot" : "warning",
      holdMs: 7_000,
    });
    raiseAlarm(alert.level >= 14 ? "hot" : "warning");
    audio?.detect?.(alert.level);
  }

  // ---- the SOC acting -----------------------------------------------------
  function showCommand(command) {
    const severe = command.action === "contain";
    const releasing = command.action === "release";

    showBand({
      eyebrow: releasing ? "DMATICS SOC · CLEARED" : "DMATICS SOC · AUTOMATED RESPONSE",
      title: command.title,
      detail: command.reason,
      target: command.station,
      tone: severe ? "hot" : releasing ? "good" : "warning",
      holdMs: severe ? 9_000 : 6_500,
    });
    lastBandAt = Date.now();
    lastBandSeverity = severe ? 15 : 14;

    if (!releasing) raiseAlarm(severe ? "hot" : "warning");

    /* Containment gets the klaxon, a release gets the falling triad, and the
     * middle actions get the critical pulse. The cue fires here rather than on
     * the detection that caused it, which is the whole point of the 1.9-second
     * beat: the room hears the SOC decide, a moment after it heard it notice. */
    if (severe) audio?.containment?.();
    else if (releasing) audio?.cleared?.();
    else audio?.critical?.();

    ai?.speak?.(
      `${String(command.title ?? "SOC response").replace(/^SOC RESPONSE — /, "")} on ${command.station ?? "the station"}. ${command.reason ?? ""}`,
      { technique: "CONTAINMENT ACTION", campaign: "AUTOMATED RESPONSE", affected: command.station,
        confidence: severe ? 99 : 94, signals: `PLAYBOOK / ${String(command.action ?? "response").toUpperCase()}` }
    );
  }

  paintCard(IDLE_CARD);

  /**
   * Update the standing campaign from the live threat picture.
   *
   * Repaints only when no booth station is driving the card — a visitor at a
   * laptop always outranks the ambient world, and having the two fight over the
   * same panel was the thing that would look broken.
   */
  function setIdleCampaign(model) {
    IDLE_CARD = { ...IDLE_CARD, ...model };
    if (!live) paintCard(IDLE_CARD);
  }

  return { showStation, showAlert, showCommand, goIdle, setIdleCampaign };
}

/**
 * Builds the detection band inside the hero, using the wall's own glass-inset
 * treatment. Kept here rather than in index.html so the element and the code
 * that drives it stay together.
 */
export function mountResponseBanner(hero) {
  if (!hero) return null;
  const root = document.createElement("div");
  root.className = "soc-response glass-inset";
  root.id = "soc-response";
  root.setAttribute("aria-live", "assertive");
  root.innerHTML = `
    <i class="soc-response-pulse" aria-hidden="true"></i>
    <div class="soc-response-copy">
      <span id="soc-response-eyebrow">DMATICS SOC · AUTOMATED RESPONSE</span>
      <strong id="soc-response-title">Containment executed</strong>
      <p id="soc-response-detail"></p>
    </div>
    <div class="soc-response-target"><small>SOURCE</small><b id="soc-response-station">—</b></div>`;
  hero.append(root);
  return {
    root,
    eyebrow: root.querySelector("#soc-response-eyebrow"),
    title: root.querySelector("#soc-response-title"),
    detail: root.querySelector("#soc-response-detail"),
    target: root.querySelector("#soc-response-station"),
  };
}
