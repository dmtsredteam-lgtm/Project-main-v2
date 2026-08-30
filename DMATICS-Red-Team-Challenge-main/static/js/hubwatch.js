/* ---------------------------------------------------------------------------
 * hubwatch.js — the SOC, seen from the attacker's side of the glass.
 *
 * Three jobs:
 *
 *   1. THE HEAT METER. A live bar in the nav showing how much the blue team has
 *      worked out. It is the only warning a player gets, and it is what makes
 *      the interruption feel earned rather than random.
 *
 *   2. THE INTERRUPTION. When the SOC escalates, this takes the screen. There is
 *      a deliberate ~1.9s "SOC IS RESPONDING" beat before the lockout lands —
 *      long enough for the crowd at the big screen to see the detection appear
 *      there FIRST and turn to look at the laptop. Cause, then effect, in that
 *      order. Without the beat the two screens fire together and the connection
 *      between them is invisible.
 *
 *   3. THE OPERATOR CHANNEL. An optional stream from the Arena Hub, so a booth
 *      operator can contain a station by hand from the wall. The game's own
 *      responses never come down this pipe — they arrive in the HTTP reply that
 *      caused them, which is the path that still works with the hub unplugged.
 *
 * Everything here degrades to nothing: no hub, no meter element, no SSE — the
 * challenge plays exactly as it did before.
 *
 * Call from a page:  SOCDEF.apply(json.response)   ·  SOCDEF.sync(json.soc)
 *
 *  — DMATICS, Dubai
 * ------------------------------------------------------------------------- */
(function () {
  "use strict";

  var STATION = window.__STATION__ || "LAPTOP-01";
  var HUB = (window.__HUB__ || "").replace(/\/$/, "");
  var state = window.__SOC__ || null;

  var lastActionAt = 0;
  var releaseTimer = null;
  var pollTimer = null;

  /* ---------------------------------------------------------------- meter -- */
  function meter() { return document.getElementById("soc-heat"); }

  /* The clock on Mission Control free-runs; this is the only thing that tells
     it what the server actually thinks. Called from every place a fresh SOC
     state arrives, so a slept or backgrounded tab corrects itself on the next
     poll instead of counting down past a run that is already over. */
  function syncClock(s) {
    if (s && typeof s.left === "number" && typeof window.DM_SYNC_CLOCK === "function") {
      window.DM_SYNC_CLOCK(s.left);
    }
  }

  function paintMeter(s) {
    syncClock(s);
    var el = meter();
    if (!el || !s) return;
    var pct = Math.max(0, Math.min(100, s.heat || 0));
    var tone = s.posture === "CONTAINED" || s.posture === "THROTTLED" ? "hot"
             : pct >= (s.throttle || 62) ? "hot"
             : pct >= (s.watch || 34) ? "warn" : "";
    el.dataset.tone = tone;
    el.style.setProperty("--heat", pct.toFixed(1) + "%");
    var label = el.querySelector("b");
    if (label) {
      label.textContent =
        s.throttleLeft > 0 ? "HELD " + s.throttleLeft + "s"
        : s.posture === "CONTAINED" ? "CONTAINED"
        : pct >= (s.watch || 34) ? "TRACKED " + Math.round(pct) + "%"
        : "CLEAR";
    }
    el.title = "SOC detection confidence on your session: " + Math.round(pct) + "%"
      + (pct >= (s.watch || 34) ? " — you have been noticed." : " — still quiet.");
  }

  function sync(s) {
    if (!s) return;
    state = s;
    paintMeter(s);
    if (s.throttleLeft > 0) countdown(s.throttleLeft);
  }

  /* ------------------------------------------------------------- overlay -- */
  function overlay() { return document.getElementById("soc-hold"); }

  function build(title, reason, seconds) {
    var existing = overlay();
    if (existing) existing.remove();
    var el = document.createElement("div");
    el.id = "soc-hold";
    el.className = "soc-hold";
    el.innerHTML =
      '<div class="soc-hold-box">' +
        '<div class="soc-hold-scan"></div>' +
        '<div class="soc-hold-eyebrow">' + (window.__EVENT__ || "GISEC 2026") +
          " · AEGIS SOC · " + STATION + "</div>" +
        '<div class="soc-hold-phase" id="soc-hold-phase">SOC IS RESPONDING</div>' +
        '<div class="soc-hold-title" id="soc-hold-title">' + esc(title) + "</div>" +
        '<div class="soc-hold-msg" id="soc-hold-msg">' + esc(reason) + "</div>" +
        '<div class="soc-hold-ring" id="soc-hold-ring" style="--p:0%">' +
          '<span id="soc-hold-count">' + (seconds || "") + "</span>" +
        "</div>" +
        '<div class="soc-hold-foot" id="soc-hold-foot">Traffic held for inspection — the clock keeps running.</div>' +
      "</div>";
    document.body.appendChild(el);
    requestAnimationFrame(function () { el.classList.add("on"); });
    return el;
  }

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function dismiss() {
    var el = overlay();
    if (!el) return;
    el.classList.remove("on");
    setTimeout(function () { if (el.parentNode) el.remove(); }, 420);
  }

  /* The lockout itself: a ring that empties over the throttle window, then the
     page reloads so the server-side hold and the UI can never disagree. */
  function countdown(seconds) {
    var el = overlay() || build("SOC RESPONSE — ADAPTIVE THROTTLE ENGAGED",
      "Traffic from this session is being held for deep packet inspection.", seconds);
    var phase = document.getElementById("soc-hold-phase");
    var ring = document.getElementById("soc-hold-ring");
    var count = document.getElementById("soc-hold-count");
    if (phase) { phase.textContent = "SESSION HELD"; phase.classList.add("live"); }
    el.classList.add("held");

    var total = Math.max(1, seconds);
    var endsAt = Date.now() + total * 1000;
    clearInterval(releaseTimer);
    releaseTimer = setInterval(function () {
      var left = Math.max(0, (endsAt - Date.now()) / 1000);
      if (ring) ring.style.setProperty("--p", ((1 - left / total) * 100).toFixed(1) + "%");
      if (count) count.textContent = Math.ceil(left);
      if (left > 0) return;
      clearInterval(releaseTimer);
      if (phase) { phase.textContent = "RELEASED"; phase.classList.remove("live"); }
      if (count) count.textContent = "✓";
      setTimeout(function () {
        dismiss();
        // Reload rather than just hiding: the throttle expired server-side too,
        // and any page state that was refused during the hold is now stale.
        if (!/\/finish/.test(location.pathname)) location.reload();
      }, 700);
    }, 100);
  }

  /* --------------------------------------------------------------- apply -- */
  /**
   * Run the SOC's response to something the player just did.
   * `response` is the object Flask attaches to its JSON replies, or a command
   * pushed down the hub's operator channel. Safe to call with null.
   */
  function apply(response) {
    if (!response || !response.action) return;
    // Bursts of actions can each carry an escalation. Only the first one in a
    // two-second window gets the screen — the rest would just stack overlays.
    if (Date.now() - lastActionAt < 2000 && overlay()) return;
    lastActionAt = Date.now();

    if (typeof response.heat === "number") {
      state = state || {};
      state.heat = response.heat;
      state.posture = response.posture || state.posture;
      paintMeter(state);
    }

    if (response.action === "monitor") {
      flashAdvisory(response.title, response.reason);
      return;
    }

    if (response.action === "throttle") {
      var el = build(response.title || "SOC RESPONSE — ADAPTIVE THROTTLE ENGAGED",
        response.reason || "Traffic held for deep packet inspection.", response.seconds || 12);
      siren(2);
      // The 1.9s beat: the wall shows the detection, THEN the laptop is hit.
      setTimeout(function () { if (overlay() === el) countdown(response.seconds || 12); }, 1900);
      return;
    }

    if (response.action === "contain") {
      build(response.title || "SOC RESPONSE — SESSION CONTAINED",
        response.reason || "Malicious activity confirmed. Session terminated.", 0);
      siren(3);
      var box = overlay();
      if (box) box.classList.add("contained");
      setTimeout(function () {
        dismiss();
        if (window.showSOCAlert) {
          window.showSOCAlert(response.title || "SOC RESPONSE — SESSION CONTAINED",
            response.reason || "Session terminated by the SOC.", "/finish");
        } else {
          location.href = "/finish";
        }
      }, 2200);
    }
  }

  /** The first warning. A banner, not a lockout — the player can still act. */
  function flashAdvisory(title, reason) {
    var existing = document.getElementById("soc-advisory");
    if (existing) existing.remove();
    var el = document.createElement("div");
    el.id = "soc-advisory";
    el.className = "soc-advisory";
    el.innerHTML = "<i></i><div><b>" + esc(title || "SOC ADVISORY") + "</b><span>" +
      esc(reason || "") + "</span></div>";
    document.body.appendChild(el);
    if (window.DMFX) DMFX.sfx("error");
    requestAnimationFrame(function () { el.classList.add("on"); });
    setTimeout(function () {
      el.classList.remove("on");
      setTimeout(function () { if (el.parentNode) el.remove(); }, 400);
    }, 6500);
  }

  function siren(times) {
    if (!window.DMFX) return;
    for (var i = 0; i < times; i++) setTimeout(function () { DMFX.sfx("error"); }, i * 320);
  }

  /* ---------------------------------------------------- operator channel -- */
  function listen() {
    if (!HUB || typeof EventSource === "undefined") return;
    var source;
    try {
      source = new EventSource(HUB + "/api/command/stream?station=" + encodeURIComponent(STATION));
    } catch (error) { return; }

    source.addEventListener("command", function (message) {
      var command;
      try { command = JSON.parse(message.data); } catch (error) { return; }
      if (command.station !== STATION) return;
      if (command.action === "release") { clearInterval(releaseTimer); dismiss(); location.reload(); return; }
      apply(command);
    });

    // EventSource reconnects by itself; a booth Wi-Fi blip should not need a
    // human to notice it.
    source.addEventListener("error", function () { /* retried automatically */ });
  }

  /* -------------------------------------------------------------- polling -- */
  function poll() {
    if (!document.getElementById("soc-heat")) return;
    clearInterval(pollTimer);
    pollTimer = setInterval(function () {
      if (document.hidden) return;
      fetch("/soc/state", { cache: "no-store" })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (s) { if (s) { state = s; paintMeter(s); } })
        .catch(function () { /* the meter simply goes stale */ });
    }, 3500);
  }

  window.SOCDEF = { apply: apply, sync: sync, dismiss: dismiss, state: function () { return state; } };

  document.addEventListener("DOMContentLoaded", function () {
    paintMeter(state);
    if (state && state.throttleLeft > 0) countdown(state.throttleLeft);
    poll();
    listen();
  });
})();
