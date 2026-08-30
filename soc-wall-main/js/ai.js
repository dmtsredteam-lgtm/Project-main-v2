/* The panel's first sentence, and its only hard-coded one.
 *
 * It is on screen for about a second and a half — until the first batch of
 * alerts lands and setAssessment() starts feeding sentences composed from the
 * live picture (see campaign.js). It used to be a rotation of three fixed
 * strings on an eleven-second timer, which is why the panel said the same three
 * things all day regardless of what the globe was doing. */
let assessments = ["Correlating live telemetry across the sensor grid."];

/** The DMATICS AI panel's fact grid, when a live detection overrides the script. */
const FACT_IDS = {
  campaign: "ai-campaign",
  technique: "ai-technique",
  affected: "ai-affected",
  confidence: "ai-confidence",
  signals: "ai-signals",
};

/** Confidence also drives the ring in the panel header, arc and number both. */
function paintConfidence(value) {
  const score = Math.max(0, Math.min(100, Math.round(value)));
  const ring = document.getElementById("ai-ring");
  const number = document.getElementById("ai-score");
  if (ring) ring.style.setProperty("--score", String(score));
  if (number) number.textContent = String(score);
}

export function initAiAssistant(element) {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let assessmentIndex = 0;
  let characterIndex = 0;
  let timer;
  let liveUntil = 0;          // while set, the derived loop stays quiet
  let pending = null;         // a newer sentence, waiting for the current one to finish
  let speakTimer;             // the live-detection typing chain, so it can be stopped

  function type() {
    if (Date.now() < liveUntil) {
      timer = setTimeout(type, 1_000);
      return;
    }
    if (pending && characterIndex === 0) { assessments = [pending]; assessmentIndex = 0; pending = null; }
    const message = assessments[assessmentIndex];
    /* How long a finished sentence stays up before the panel starts again.
     * Short when something newer is already waiting — the wall should not sit
     * on a stale assessment for eleven seconds while the picture behind it has
     * already moved — and long when there is nothing new to say. */
    const hold = () => (pending ? 2_600 : 11_000);

    if (reduced) {
      element.textContent = message;
      timer = setTimeout(() => { characterIndex = 0; type(); }, hold());
      return;
    }
    characterIndex += 1;
    element.textContent = message.slice(0, characterIndex);
    if (characterIndex < message.length) {
      timer = setTimeout(type, 18 + Math.random() * 18);
    } else {
      timer = setTimeout(() => {
        characterIndex = 0;
        element.textContent = "";
        type();
      }, hold());
    }
  }

  const restore = new Map();

  /**
   * Interrupt the scripted assessment with a real detection.
   *
   * Booth activity arrives in bursts — three failed passwords in four seconds —
   * so this deliberately replaces rather than queues: the newest detection is
   * the interesting one, and a queue would leave the panel narrating events the
   * crowd watched thirty seconds ago. The loop resumes on its own once the
   * detection has had its fifteen seconds.
   */
  function speak(message, facts = {}) {
    if (!message) return;
    clearTimeout(timer);
    liveUntil = Date.now() + 15_000;
    characterIndex = 0;

    for (const [key, id] of Object.entries(FACT_IDS)) {
      const target = document.getElementById(id);
      if (!target || facts[key] === undefined) continue;
      if (!restore.has(id)) restore.set(id, target.textContent);
      target.textContent = key === "confidence" ? `LIVE · ${facts[key]}%` : String(facts[key]);
      target.classList.add("is-live");
      if (key === "confidence") paintConfidence(facts[key]);
    }

    if (reduced) {
      element.textContent = message;
    } else {
      /* This chain used to be untracked, so clearTimeout(timer) above could not
       * stop it — and speak() also pushes liveUntil forward, which kept the old
       * chain's own guard false. Three detections in four seconds (the burst
       * the header describes) meant three chains writing to the same element
       * character by character, and the panel flickered between three
       * sentences at the exact moment the wall is meant to be convincing. */
      clearTimeout(speakTimer);
      let index = 0;
      const tick = () => {
        if (Date.now() > liveUntil) return;
        index += 1;
        element.textContent = message.slice(0, index);
        if (index < message.length) speakTimer = setTimeout(tick, 14);
      };
      tick();
    }

    timer = setTimeout(() => {
      clearTimeout(speakTimer);
      for (const [id, original] of restore) {
        const target = document.getElementById(id);
        if (!target) continue;
        target.textContent = original;
        target.classList.remove("is-live");
      }
      restore.clear();
      liveUntil = 0;
      characterIndex = 0;
      element.textContent = "";
      type();
    }, 15_200);
  }

  /**
   * Replace the standing assessment with one composed from the live picture.
   *
   * Called on every alert batch, but only acts when the *sentence* actually
   * changed — campaign.js only produces a new one when the shape of the traffic
   * changes, so the panel finishes its sentences instead of restarting the
   * typing animation several times a minute.
   *
   * A real booth detection speaking through speak() always wins: this defers
   * until that has had its fifteen seconds.
   */
  function setAssessment(text, facts = {}) {
    if (Number.isFinite(facts.confidence)) {
      paintConfidence(facts.confidence);
      const readout = document.getElementById("ai-confidence");
      if (readout && Date.now() >= liveUntil) {
        const band = facts.confidence >= 85 ? "HIGH" : facts.confidence >= 65 ? "MODERATE" : "LOW";
        readout.textContent = `${band} · ${facts.confidence}%`;
        readout.className = facts.confidence >= 85 ? "good" : facts.confidence >= 65 ? "warning" : "";
      }
    }

    if (Date.now() < liveUntil) return;   // a live detection is on screen

    for (const [key, id] of Object.entries(FACT_IDS)) {
      if (key === "confidence" || facts[key] === undefined) continue;
      const target = document.getElementById(id);
      if (target) target.textContent = String(facts[key]);
    }

    if (!text || text === assessments[0] || text === pending) return;
    if (characterIndex === 0) {
      clearTimeout(timer);
      assessments = [text];
      assessmentIndex = 0;
      element.textContent = "";
      type();
    } else {
      pending = text;         // let the sentence on screen finish first
    }
  }

  type();
  return { speak, setAssessment, stop: () => clearTimeout(timer) };
}
