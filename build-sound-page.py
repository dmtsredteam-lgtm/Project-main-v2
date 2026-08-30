#!/usr/bin/env python3
"""
Builds the sound-design review page.

The page inlines soc-wall-main/js/audio.js verbatim rather than reimplementing
the cues, so what Jeff hears here is the code that runs on the wall. Re-run this
after any change to the sound design and republish.
"""
import pathlib, html

ROOT = pathlib.Path(__file__).parent
SOURCE = (ROOT / "soc-wall-main/js/audio.js").read_text()
OUT = ROOT / "soc-sound-check.html"

# Strip the ES-module export keyword: the page runs it as a classic script so
# there is no import graph to satisfy inside a single published file.
MODULE = SOURCE.replace("export function createSocAudio", "function createSocAudio")

CUES = [
    ("attention", "detect", "10", "ATTENTION", "warning-off",
     "Severity 8 to 11 — reconnaissance, a shell command, an ordinary login.",
     "A rising perfect fourth, 659 to 880 Hz. The interval lifts and station announcements use to mean <em>look up</em>. It is information, not danger, and that is what a severity-10 detection actually is.",
     "659 → 880 Hz · triangle · 260 ms · peak −13.8 dBFS"),
    ("elevated", "detect", "12", "ELEVATED", "warning",
     "Severity 12 to 13 — password spraying, a remote shell brute force, a credential file opened.",
     "Three notes that refuse to resolve: up a fourth, then back down a whole step. The ear waits for a fourth note that never arrives. That is what makes it unsettling rather than merely loud.",
     "740 → 988 → 831 Hz · triangle · 400 ms · peak −11.6 dBFS"),
    ("critical", "detect", "15", "CRITICAL", "critical",
     "Severity 14 and above — privilege escalation, data staged for exfiltration.",
     "Three hard double-stops, 932 against 1318 Hz. A tritone: the interval every emergency system in the world reaches for, because it is the one the ear refuses to file as music.",
     "932 + 1318 Hz ×3 · triangle + sine · 440 ms · peak −6.1 dBFS"),
    ("containment", "containment", "", "CONTAINMENT", "critical",
     "The SOC cutting a laptop off. Fires with the full-red screen, 1.9 seconds after the detection that caused it.",
     "An alternating two-tone through a low pass — the industrial alarm idiom — with a 68 Hz swell underneath that falls to 52 Hz across the cue. The sub is felt more than heard, and it is the reason this reads as weight rather than as a smoke detector.",
     "523 ⇄ 392 Hz ×5 · sawtooth @ 1.4 kHz LPF + 68 Hz sub · 1.05 s · peak −8.3 dBFS"),
    ("cleared", "cleared", "", "ALL CLEAR", "good",
     "A station released. The alarm is over.",
     "A falling triad, 880 to 659 to 523. Every other cue on the wall is unresolved on purpose; this is the only one that lands on its root, so the room knows it can relax.",
     "880 → 659 → 523 Hz · triangle · 480 ms · peak −14.1 dBFS"),
    ("score", "score", "", "SCORE LANDED", "accent",
     "A visitor's arcade score arriving on the leaderboard.",
     "One sine tick at 1319 Hz, twenty decibels under everything else. Loud enough to notice from the tablet, quiet enough that a busy morning does not turn the stand into a slot machine.",
     "1319 Hz · sine · 70 ms · peak −29.6 dBFS"),
]

TONE_VAR = {"warning-off": "--cy", "warning": "--am", "critical": "--rd",
            "good": "--em", "accent": "--cy"}


def cue_card(index, cue):
    key, method, arg, name, tone, trigger, why, spec = cue
    call = f"{method}({arg})" if arg else f"{method}()"
    return f"""
      <article class="cue" data-tone="{tone}">
        <div class="cue-head">
          <div>
            <span class="cue-tag">CUE {index:02d}</span>
            <h3>{name}</h3>
          </div>
          <button class="play" type="button" data-call="{call}" aria-label="Play the {name.lower()} cue">
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l12-7.5z"/></svg>
            <span>PLAY</span>
          </button>
        </div>
        <p class="cue-trigger">{trigger}</p>
        <p class="cue-why">{why}</p>
        <p class="cue-spec">{spec}</p>
      </article>"""


PAGE = """<title>SOC Alert Sound Check</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap">

<style>
/* ---------------------------------------------------------------------------
   A control-room instrument, not a document. Single theme on purpose: this is
   a piece of equipment for a dark stand, and a light variant of it would be a
   different object. Every colour is painted explicitly so the page holds its
   own ground whichever theme the viewer is in.
   ------------------------------------------------------------------------- */
:root {
  --ink:       #070c12;   /* blue-biased near-black, one step up from the wall */
  --panel:     #0d1620;
  --panel-2:   #111e2b;
  --rule:      rgba(122, 190, 216, .15);
  --rule-hot:  rgba(122, 190, 216, .34);
  --text:      #e9f4fa;
  --soft:      #b3c8d5;
  --muted:     #728c9c;
  --cy:        #54e7ff;
  --am:        #ffbd59;
  --rd:        #ff496c;
  --em:        #3ee6a1;

  --display: "Chakra Petch", "Arial Narrow", sans-serif;
  --body: "IBM Plex Sans", system-ui, sans-serif;
  --mono: "JetBrains Mono", ui-monospace, Menlo, monospace;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background:
    radial-gradient(1100px 620px at 78% -8%, rgba(84,231,255,.07), transparent 62%),
    radial-gradient(760px 520px at 6% 108%, rgba(255,73,108,.05), transparent 60%),
    var(--ink);
  color: var(--text);
  font-family: var(--body);
  font-size: 16px;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}

.wrap { max-width: 1200px; margin: 0 auto; padding: 0 clamp(20px, 4vw, 56px) 100px; }

/* ---- masthead ----------------------------------------------------------- */
.top { padding: clamp(44px, 7vw, 84px) 0 clamp(26px, 4vw, 40px); border-bottom: 1px solid var(--rule); }
.eyebrow {
  display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center;
  font-family: var(--mono); font-size: 11px; letter-spacing: .16em;
  text-transform: uppercase; color: var(--muted);
}
.eyebrow b { color: var(--cy); font-weight: 500; }
h1 {
  margin: 18px 0 0;
  font-family: var(--display); font-weight: 700;
  font-size: clamp(34px, 5.6vw, 62px); line-height: 1.02; letter-spacing: -.015em;
  text-wrap: balance;
}
h1 em { font-style: normal; color: var(--cy); }
.standfirst { max-width: 62ch; margin: 16px 0 0; color: var(--soft); font-size: clamp(16px, 1.4vw, 18px); }

/* ---- console ------------------------------------------------------------ */
.console { display: grid; grid-template-columns: minmax(0, 1.55fr) minmax(300px, 1fr); gap: clamp(20px, 3vw, 40px); align-items: start; padding-top: clamp(28px, 4vw, 44px); }
@media (max-width: 900px) { .console { grid-template-columns: 1fr; } }

.cues { display: grid; gap: 14px; }

.cue {
  position: relative; overflow: hidden;
  padding: 20px 22px 18px 26px;
  border: 1px solid var(--rule); border-radius: 12px;
  background: linear-gradient(180deg, var(--panel-2), var(--panel));
}
.cue::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: var(--tone); }
.cue[data-tone="warning-off"] { --tone: var(--cy); }
.cue[data-tone="warning"]     { --tone: var(--am); }
.cue[data-tone="critical"]    { --tone: var(--rd); }
.cue[data-tone="good"]        { --tone: var(--em); }
.cue[data-tone="accent"]      { --tone: var(--cy); }

.cue-head { display: flex; gap: 18px; align-items: flex-start; justify-content: space-between; }
.cue-tag { font-family: var(--mono); font-size: 10px; letter-spacing: .18em; color: var(--muted); }
.cue h3 { margin: 5px 0 0; font-family: var(--display); font-weight: 700; font-size: 22px; letter-spacing: .04em; color: var(--tone); }

.play {
  display: inline-flex; gap: 9px; align-items: center;
  min-height: 44px; flex: none; padding: 0 18px;
  border: 1px solid var(--rule-hot); border-radius: 999px;
  color: var(--text); background: rgba(255,255,255,.04);
  font-family: var(--display); font-weight: 600; font-size: 12px; letter-spacing: .17em;
  cursor: pointer;
  transition: background .18s ease, border-color .18s ease, color .18s ease, transform .18s ease;
}
.play svg { width: 13px; height: 13px; }
.play:hover { background: rgba(84,231,255,.12); border-color: var(--cy); color: #fff; }
.play:active { transform: scale(.97); }
.play:focus-visible { outline: 2px solid var(--cy); outline-offset: 3px; }
.play.is-firing { background: var(--tone); border-color: var(--tone); color: #04090f; }

.cue-trigger { margin: 14px 0 0; color: var(--text); font-size: 15px; }
.cue-why { margin: 8px 0 0; max-width: 62ch; color: var(--soft); font-size: 15px; }
.cue-why em { color: var(--text); font-style: italic; }
.cue-spec { margin: 12px 0 0; padding-top: 11px; border-top: 1px solid var(--rule); font-family: var(--mono); font-size: 11.5px; letter-spacing: .02em; color: var(--muted); font-variant-numeric: tabular-nums; }

/* ---- scope -------------------------------------------------------------- */
.rail { position: sticky; top: 22px; display: grid; gap: 14px; }
.scope { padding: 18px 20px 20px; border: 1px solid var(--rule); border-radius: 12px; background: linear-gradient(180deg, var(--panel-2), var(--panel)); }
.scope h2, .rail h2 { margin: 0; font-family: var(--display); font-weight: 600; font-size: 12px; letter-spacing: .2em; color: var(--muted); text-transform: uppercase; }
#scope { display: block; width: 100%; height: 132px; margin-top: 13px; border: 1px solid var(--rule); border-radius: 7px; background: #05090e; }
.scope-meta { display: flex; justify-content: space-between; margin-top: 10px; font-family: var(--mono); font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
.scope-meta b { color: var(--cy); font-weight: 500; }

.sequence { padding: 18px 20px 20px; border: 1px solid var(--rule-hot); border-radius: 12px; background: linear-gradient(180deg, rgba(255,73,108,.07), var(--panel)); }
.sequence p { margin: 10px 0 14px; color: var(--soft); font-size: 14px; }
.run {
  display: flex; gap: 10px; align-items: center; justify-content: center;
  width: 100%; min-height: 48px;
  border: 1px solid var(--rd); border-radius: 9px;
  color: var(--rd); background: rgba(255,73,108,.08);
  font-family: var(--display); font-weight: 700; font-size: 13px; letter-spacing: .16em;
  cursor: pointer; transition: background .2s ease, color .2s ease;
}
.run:hover { background: var(--rd); color: #0a0409; }
.run:focus-visible { outline: 2px solid var(--rd); outline-offset: 3px; }
.run[disabled] { opacity: .55; cursor: default; }

#steps { margin: 14px 0 0; padding: 0; list-style: none; display: grid; gap: 7px; }
#steps li { display: grid; grid-template-columns: 62px 1fr; gap: 12px; align-items: baseline; font-family: var(--mono); font-size: 11.5px; color: var(--muted); font-variant-numeric: tabular-nums; transition: color .25s ease; }
#steps li.is-now { color: var(--text); }
#steps li.is-now span:first-child { color: var(--rd); }
#steps li.is-done { color: var(--soft); }

/* ---- rules -------------------------------------------------------------- */
.rules { margin-top: clamp(34px, 5vw, 56px); padding-top: clamp(26px, 4vw, 38px); border-top: 1px solid var(--rule); }
.rules h2 { margin: 0 0 6px; font-family: var(--display); font-weight: 700; font-size: clamp(21px, 2.4vw, 28px); letter-spacing: -.008em; color: var(--text); text-transform: none; }
.rule-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(258px, 1fr)); gap: 1px; margin-top: 22px; background: var(--rule); border: 1px solid var(--rule); border-radius: 10px; overflow: hidden; }
.rule { padding: 20px 22px; background: var(--panel); }
.rule strong { display: block; font-family: var(--display); font-weight: 600; font-size: 13px; letter-spacing: .13em; color: var(--cy); text-transform: uppercase; }
.rule p { margin: 9px 0 0; color: var(--soft); font-size: 14.5px; }
.rule code { font-family: var(--mono); font-size: .86em; padding: .1em .36em; border-radius: 3px; color: var(--text); background: rgba(255,255,255,.06); }

.foot { margin-top: 30px; color: var(--muted); font-size: 13.5px; max-width: 70ch; }
.foot code { font-family: var(--mono); font-size: .88em; color: var(--soft); }

/* The wall's own arming prompt, styled to match this page. If it appears here,
   it is behaving exactly as it will on the booth screen. */
.audio-arm {
  position: fixed; right: 18px; bottom: 18px; z-index: 40;
  display: inline-flex; gap: 10px; align-items: center;
  min-height: 44px; padding: 0 18px;
  border: 1px solid var(--rule-hot); border-radius: 999px;
  color: #bdf1ff; background: rgba(6,14,22,.94);
  font-family: var(--display); font-weight: 500; font-size: 12px; letter-spacing: .15em;
  cursor: pointer;
}
.audio-arm i { width: 9px; height: 9px; border-radius: 50%; background: var(--am); box-shadow: 0 0 12px rgba(255,189,89,.8); }

@media (prefers-reduced-motion: reduce) { * { transition-duration: .01ms !important; } }
</style>

<div class="wrap">
  <header class="top">
    <div class="eyebrow"><span>DMATICS IT SOLUTIONS</span><span>GISEC 2026</span><b>SOC WALL · AUDIO</b></div>
    <h1>Every alert the wall makes, <em>before the doors open</em></h1>
    <p class="standfirst">
      Six cues, synthesised in the browser — no audio files, nothing to lose off a USB stick,
      nothing that breaks when the stand has no internet. Play them here, and if any of them
      is wrong, say which and it changes.
    </p>
  </header>

  <div class="console">
    <section class="cues" aria-label="Alert cues">
__CUES__
    </section>

    <aside class="rail">
      <div class="scope">
        <h2>Master bus</h2>
        <canvas id="scope" width="640" height="264" aria-label="Live waveform of the master audio bus"></canvas>
        <div class="scope-meta"><span>PEAK <b id="peak">−∞ dB</b></span><span id="ctxstate">CONTEXT IDLE</span></div>
      </div>

      <div class="sequence">
        <h2>Full sequence</h2>
        <p>The whole show, at the timing the booth actually runs — including the 1.9-second beat between the SOC noticing and the SOC acting.</p>
        <button class="run" id="run" type="button">RUN THE SEQUENCE</button>
        <ol id="steps">
          <li data-at="0"><span>00.0s</span><span>Recon detected — attention</span></li>
          <li data-at="2200"><span>02.2s</span><span>Credential attack — elevated</span></li>
          <li data-at="4600"><span>04.6s</span><span>Privilege escalation — critical</span></li>
          <li data-at="6500"><span>06.5s</span><span>Containment executed — klaxon</span></li>
          <li data-at="11000"><span>11.0s</span><span>Station released — all clear</span></li>
        </ol>
      </div>
    </aside>
  </div>

  <section class="rules">
    <h2>Why it does not become noise by lunchtime</h2>
    <div class="rule-grid">
      <div class="rule">
        <strong>The background is silent</strong>
        <p>The wall invents ambient threat traffic constantly to keep the globe alive between visitors. None of it makes a sound. Only the red team laptops and the arcade are audible, so every noise the stand makes was caused by someone standing in it.</p>
      </div>
      <div class="rule">
        <strong>A burst is one sound</strong>
        <p>Ordinary cues are held to one every <code>700 ms</code> and ten in any thirty seconds. Eight detections arriving together produce one chime, not eight. Critical cues can interrupt that; they have their own five-second floor.</p>
      </div>
      <div class="rule">
        <strong>Loud where it matters</strong>
        <p>There are twenty-three decibels between the quietest cue and the loudest. A score landing is nearly subliminal; a containment is the loudest thing the stand does. The dynamic range is the message.</p>
      </div>
      <div class="rule">
        <strong>Turning it down, or off</strong>
        <p>Add <code>?volume=0.4</code> to the wall's address for a quiet hall, or <code>?sound=off</code> to silence one screen. The defaults live in <code>soc-config.js</code> and take a refresh, not a rebuild.</p>
      </div>
    </div>
    <p class="foot">
      Browsers refuse to make a sound until a page has been interacted with, and nobody
      interacts with a wall display. Launch the booth machine with
      <code>chromium --autoplay-policy=no-user-gesture-required --kiosk http://&lt;hub&gt;:7788/</code>
      and the wall is audible from boot. Otherwise the screen is clicked once and the prompt
      in the corner goes away for good — the same prompt you will see on this page if your
      browser blocks it here.
    </p>
  </section>
</div>

<script>
__MODULE__

// ---- page wiring ----------------------------------------------------------
const canvas = document.getElementById("scope");
const paint = canvas.getContext("2d");
const peakOut = document.getElementById("peak");
const stateOut = document.getElementById("ctxstate");

let analyser = null;
let buffer = null;
let peakHold = 0;
let peakDecay = 0;

const audio = createSocAudio({
  onGraph(context, master) {
    analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    buffer = new Float32Array(analyser.fftSize);
    master.connect(analyser);          // a tap, not a break in the chain
    stateOut.textContent = "CONTEXT LIVE";
  },
});

/* The trace. Not decoration: the containment cue's 68 Hz swell is visible here
   as a slow rolling shape under the two-tone, which is the part that is hard to
   judge by ear on laptop speakers. */
function draw() {
  requestAnimationFrame(draw);
  const width = canvas.width, height = canvas.height, middle = height / 2;

  paint.fillStyle = "#05090e";
  paint.fillRect(0, 0, width, height);
  paint.strokeStyle = "rgba(122,190,216,.10)";
  paint.lineWidth = 1;
  for (let y = 1; y < 4; y += 1) {
    paint.beginPath();
    paint.moveTo(0, (height / 4) * y);
    paint.lineTo(width, (height / 4) * y);
    paint.stroke();
  }

  if (!analyser) return;
  analyser.getFloatTimeDomainData(buffer);

  let loudest = 0;
  paint.beginPath();
  for (let index = 0; index < buffer.length; index += 1) {
    const value = buffer[index];
    if (Math.abs(value) > loudest) loudest = Math.abs(value);
    const x = (index / buffer.length) * width;
    const y = middle - value * (height * 0.46);
    index ? paint.lineTo(x, y) : paint.moveTo(x, y);
  }
  paint.strokeStyle = loudest > 0.3 ? "#ff496c" : loudest > 0.08 ? "#ffbd59" : "#54e7ff";
  paint.lineWidth = 2;
  paint.shadowBlur = 12;
  paint.shadowColor = paint.strokeStyle;
  paint.stroke();
  paint.shadowBlur = 0;

  if (loudest > peakHold) { peakHold = loudest; peakDecay = 0; }
  else if (++peakDecay > 90) { peakHold = Math.max(0, peakHold - 0.006); }
  peakOut.textContent = peakHold < 0.0005
    ? "\\u2212\\u221E dB"
    : "\\u2212" + Math.abs(20 * Math.log10(peakHold)).toFixed(1) + " dB";
}
draw();

for (const button of document.querySelectorAll(".play")) {
  button.addEventListener("click", () => {
    audio.arm();
    const [method, argument] = button.dataset.call.replace(")", "").split("(");
    argument ? audio[method](Number(argument)) : audio[method]();
    button.classList.add("is-firing");
    setTimeout(() => button.classList.remove("is-firing"), 420);
  });
}

// ---- the full sequence ----------------------------------------------------
const runButton = document.getElementById("run");
const steps = [...document.querySelectorAll("#steps li")];
const SCRIPT = [
  [0,     () => audio.detect(10)],
  [2200,  () => audio.detect(12)],
  [4600,  () => audio.detect(15)],
  [6500,  () => audio.containment()],
  [11000, () => audio.cleared()],
];

runButton.addEventListener("click", () => {
  audio.arm();
  runButton.disabled = true;
  runButton.textContent = "RUNNING…";
  for (const step of steps) step.classList.remove("is-now", "is-done");

  SCRIPT.forEach(([delay, fire], index) => {
    setTimeout(() => {
      fire();
      steps.forEach((step, position) => {
        step.classList.toggle("is-now", position === index);
        step.classList.toggle("is-done", position < index);
      });
    }, delay);
  });

  setTimeout(() => {
    for (const step of steps) step.classList.remove("is-now");
    runButton.disabled = false;
    runButton.textContent = "RUN THE SEQUENCE";
  }, 13000);
});
</script>
"""

body = "\n".join(cue_card(index + 1, cue) for index, cue in enumerate(CUES))
OUT.write_text(PAGE.replace("__CUES__", body).replace("__MODULE__", MODULE))
print(f"wrote {OUT} ({OUT.stat().st_size:,} bytes)")
