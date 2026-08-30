/* ===========================================================================
 * SOC Wall — alert audio.
 *
 * Every sound on this wall is synthesised in the browser. There is not a single
 * audio file: no download, no decode, nothing to lose off a USB stick, nothing
 * that stops working when the booth has no internet. The whole layer is about
 * six kilobytes of oscillator scheduling.
 *
 * The sound design is control room, not arcade. The arcade on the iPad has its
 * own chiptune voice and should — it is a game. This screen is the thing the
 * stand is judged on, so its cues follow the conventions people already know
 * from real alerting systems:
 *
 *   ATTENTION   a rising perfect fourth. The universal "look up" interval —
 *               lifts, hospital call systems, station announcements. It reads
 *               as information, not as danger, which is what a severity-10
 *               detection actually is.
 *   ELEVATED    three notes that do not resolve. Unfinished on purpose: the
 *               ear waits for a fourth note that never comes, and that is what
 *               makes it feel unresolved rather than merely loud.
 *   CRITICAL    three hard double-stops. Two tones a tritone apart, the
 *               interval every emergency system in the world reaches for.
 *   KLAXON      the containment alarm — an alternating two-tone through a low
 *               pass with a sub swell underneath. This is the sound that lands
 *               with the full-red screen when a laptop gets cut off.
 *   CLEARED     a falling triad. Resolution, so the room can relax.
 *
 * Two rules keep it from becoming noise, which is the failure mode that gets
 * booth audio switched off by lunchtime on day one:
 *
 *   1. The ambient telemetry is silent. Only real booth activity — the red team
 *      laptops and the arcade — makes a sound. The wall invents background
 *      traffic constantly and none of it is audible.
 *   2. Everything is rate limited. A burst of eight detections is one sound,
 *      not eight. Critical cues can interrupt, ordinary ones cannot.
 *
 * Autoplay: browsers will not let a page make noise before someone interacts
 * with it, and nobody interacts with a wall display. Two answers, both wired
 * up — launch Chrome with --autoplay-policy=no-user-gesture-required (the run
 * book has the full command), or click the screen once. Until one of those
 * happens a small prompt sits in the corner, and it removes itself the moment
 * audio is live.
 * ========================================================================= */

/* Cue floors. A cue below its floor is dropped rather than queued — a stale
 * beep arriving four seconds late is worse than no beep. */
const MIN_GAP_MS = 700;      // between ordinary cues
const URGENT_COOLDOWN = 5_000;  // between critical / klaxon cues
const BUCKET_LIMIT = 10;     // ordinary cues ...
const BUCKET_WINDOW = 30_000;   // ... per this window

export function createSocAudio(options = {}) {
  const config = globalThis.SOC_CONFIG?.sound ?? {};
  const params = new URLSearchParams(location.search);

  const urlSound = params.get("sound");
  const urlVolume = Number.parseFloat(params.get("volume"));

  const enabled = urlSound ? urlSound !== "off" && urlSound !== "0" : config.enabled !== false;
  const scoreBlips = config.scoreBlips !== false;
  const masterVolume = Math.min(1, Math.max(0,
    Number.isFinite(urlVolume) ? urlVolume : (Number.isFinite(config.volume) ? config.volume : 0.7)));

  let context = null;
  let master = null;
  let armed = false;
  let lastCueAt = 0;
  let lastUrgentAt = 0;
  const recent = [];

  /* ---- graph -------------------------------------------------------------
   * gain -> compressor -> speakers. The compressor is not decoration: a booth
   * television's speakers distort badly on a loud low tone, and the klaxon has
   * a 65 Hz swell in it. Ten dB of limiting keeps it a klaxon instead of a
   * rattle. */
  function build() {
    /* options.contextFactory exists so the cues can be rendered offline into a
     * file — the preview track Jeff can listen to is produced by running this
     * exact code through an OfflineAudioContext, not by a second copy of the
     * sound design that could quietly drift away from it. */
    const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!options.contextFactory && !Ctor) return null;
    context = options.contextFactory ? options.contextFactory() : new Ctor();
    if (!context) return null;
    master = context.createGain();
    master.gain.value = masterVolume;
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.knee.value = 12;
    limiter.ratio.value = 8;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.18;
    master.connect(limiter).connect(context.destination);
    /* A host can tap the graph here — the sound-design review page hangs an
     * analyser off the master bus so the cues can be watched as well as heard. */
    options.onGraph?.(context, master);
    return context;
  }

  function ready() {
    if (!enabled) return null;
    if (!context && !build()) return null;
    if (typeof context.startRendering === "function") return context;   // offline render
    if (context.state === "suspended") context.resume();
    return context.state === "running" ? context : null;
  }

  /* ---- one voice ---------------------------------------------------------
   * A raw oscillator switched on and off clicks, and a wall full of clicks
   * sounds broken rather than urgent. Every note gets a few milliseconds of
   * attack and an exponential tail, which is the difference between "a beep"
   * and "an instrument". */
  function voice(context, {
    frequency, duration, type = "triangle", gain = 0.2, at = 0,
    glide = 0, attack = 0.006, filter = 0, detune = 0,
  }) {
    if (!Number.isFinite(frequency) || frequency <= 0) return;
    const start = context.currentTime + at;
    const oscillator = context.createOscillator();
    const envelope = context.createGain();

    oscillator.type = type;
    oscillator.detune.value = detune;
    oscillator.frequency.setValueAtTime(frequency, start);
    if (glide) oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, glide), start + duration);

    envelope.gain.setValueAtTime(0.0001, start);
    envelope.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), start + attack);
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    let tail = envelope;
    if (filter) {
      const lowpass = context.createBiquadFilter();
      lowpass.type = "lowpass";
      lowpass.frequency.value = filter;
      lowpass.Q.value = 0.8;
      envelope.connect(lowpass);
      tail = lowpass;
    }

    oscillator.connect(envelope);
    tail.connect(master);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.06);
    /* Release the graph when the note ends. Chrome does collect a finished
     * source and its exclusively-downstream nodes, but this display runs for
     * four days without a reload and nothing else in it depends on the
     * collector's goodwill. Explicit is cheaper than finding out. */
    oscillator.onended = () => {
      try { oscillator.disconnect(); envelope.disconnect(); if (tail !== envelope) tail.disconnect(); } catch { /* already gone */ }
    };
  }

  /* ---- pacing ------------------------------------------------------------ */
  function allow(urgent) {
    const now = Date.now();
    if (urgent) {
      if (now - lastUrgentAt < URGENT_COOLDOWN) return false;
      lastUrgentAt = now;
      lastCueAt = now;
      return true;
    }
    if (now - lastCueAt < MIN_GAP_MS) return false;
    while (recent.length && now - recent[0] > BUCKET_WINDOW) recent.shift();
    if (recent.length >= BUCKET_LIMIT) return false;
    recent.push(now);
    lastCueAt = now;
    return true;
  }

  // ---- the cues -----------------------------------------------------------

  /** A booth detection reached the wall. Severity picks the voice. */
  function detect(level = 10) {
    const context = ready();
    if (!context) return false;

    if (level >= 14) return critical();

    if (!allow(false)) return false;

    if (level >= 12) {
      // Three notes that refuse to resolve — up, up, back down a step.
      voice(context, { frequency: 740, duration: 0.11, gain: 0.32, type: "triangle" });
      voice(context, { frequency: 988, duration: 0.11, gain: 0.32, type: "triangle", at: 0.10 });
      voice(context, { frequency: 831, duration: 0.20, gain: 0.28, type: "triangle", at: 0.20 });
      return true;
    }

    // Rising perfect fourth: attention, not alarm.
    voice(context, { frequency: 659, duration: 0.10, gain: 0.26, type: "triangle" });
    voice(context, { frequency: 880, duration: 0.17, gain: 0.26, type: "triangle", at: 0.09 });
    return true;
  }

  /** Severity 14+. Three double-stops a tritone apart. */
  function critical() {
    const context = ready();
    if (!context || !allow(true)) return false;
    for (let pulse = 0; pulse < 3; pulse += 1) {
      const at = pulse * 0.17;
      voice(context, { frequency: 932, duration: 0.10, gain: 0.34, type: "triangle", at });
      voice(context, { frequency: 1318, duration: 0.10, gain: 0.22, type: "sine", at, detune: 6 });
    }
    return true;
  }

  /** Containment. The sound that lands with the red screen. */
  function containment() {
    const context = ready();
    if (!context || !allow(true)) return false;

    // Alternating two-tone through a low pass — the industrial alarm idiom.
    // Sawtooth alone is harsh; rolled off at 1.4 kHz it has body instead.
    const pattern = [523, 392, 523, 392, 523];
    pattern.forEach((frequency, index) => {
      voice(context, {
        frequency, duration: 0.19, gain: 0.40, type: "sawtooth",
        at: index * 0.2, filter: 1_400, attack: 0.012,
      });
    });

    // A sub swell underneath the whole thing. Felt more than heard, and the
    // reason it reads as weight rather than as a smoke detector.
    voice(context, { frequency: 68, duration: 1.05, gain: 0.44, type: "sine", attack: 0.09, glide: 52 });
    return true;
  }

  /** Station released, alarm over. A falling triad, so the room can relax. */
  function cleared() {
    const context = ready();
    if (!context) return false;
    lastCueAt = Date.now();
    [880, 659, 523].forEach((frequency, index) => {
      voice(context, { frequency, duration: 0.22, gain: 0.22, type: "triangle", at: index * 0.13 });
    });
    return true;
  }

  /** A score landing on the leaderboard. Deliberately almost nothing. */
  function score() {
    if (!scoreBlips) return false;
    const context = ready();
    if (!context || !allow(false)) return false;
    voice(context, { frequency: 1_319, duration: 0.07, gain: 0.16, type: "sine" });
    return true;
  }

  // ---- arming -------------------------------------------------------------
  /* The prompt lives outside the scaled surface as its own fixed element, so it
   * cannot disturb the wall's geometry, and it deletes itself the instant audio
   * is running. On a booth machine launched with the autoplay flag, it never
   * appears at all. */
  function prompt() {
    if (document.getElementById("audio-arm")) return;
    const pill = document.createElement("button");
    pill.id = "audio-arm";
    pill.type = "button";
    pill.className = "audio-arm";
    pill.innerHTML = '<i aria-hidden="true"></i><span>ALERT AUDIO OFF · CLICK TO ENABLE</span>';
    pill.addEventListener("click", () => { if (arm()) cleared(); });
    document.body.append(pill);
  }

  function dismiss() {
    document.getElementById("audio-arm")?.remove();
  }

  function arm() {
    if (!enabled || armed) return armed;
    if (!ready()) return false;
    armed = true;
    dismiss();
    options.onArmed?.();
    return true;
  }

  if (enabled && !options.contextFactory) {
    /* Try immediately — this is the path that succeeds under the kiosk flag.
     * If it does not, any interaction anywhere arms it, and the prompt shows
     * after a moment so nobody has to guess. */
    if (!arm()) {
      /* once: true — these are the only listeners on the wall with no removal
       * path, and arm() is idempotent, so there is no reason to keep three
       * no-op handlers on every input event for the rest of the show. */
      for (const type of ["pointerdown", "keydown", "touchstart"]) {
        addEventListener(type, () => arm(), { passive: true, once: true });
      }
      setTimeout(() => { if (!arm()) prompt(); }, 2_500);
    }
  }

  return {
    detect, critical, containment, cleared, score, arm,
    get armed() { return armed; },
    get enabled() { return enabled; },
  };
}
