/* ---------------------------------------------------------------------------
 * matrix-bg.js  -  the animated "video" background for the arena.
 * Full-screen <canvas> red digital-rain (Matrix style) with a glitch sweep and
 * flicker. Canvas not .mp4 on purpose: booth is offline, this scales crisp to
 * the 55" screen and runs on a cheap mini-PC. Honours prefers-reduced-motion.
 *  -  V.M., DMATICS
 * ------------------------------------------------------------------------- */
(function () {
  "use strict";
  var canvas = document.getElementById("dm-matrix");
  if (!canvas) return;
  var ctx = canvas.getContext("2d");
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var GLYPHS = "アカサタナハマヤラワ0123456789ABCDEF#$%<>/\\|=+*".split("");
  var FONT_SIZE = 14, columns, drops;
  function sizeCanvas() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(window.innerWidth * dpr);
    canvas.height = Math.floor(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + "px";
    canvas.style.height = window.innerHeight + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    columns = Math.floor(window.innerWidth / FONT_SIZE);
    drops = new Array(columns);
    for (var i = 0; i < columns; i++) drops[i] = Math.random() * -100;
  }
  var glitch = { active: false, y: 0, life: 0 };
  function maybeGlitch() {
    if (!glitch.active && Math.random() < 0.008) {
      glitch.active = true; glitch.y = Math.random() * window.innerHeight;
      glitch.life = 6 + Math.floor(Math.random() * 8);
    }
  }
  /* One head glyph per column and an 0.08 fade left a background you could not
     see — a few isolated red specks on black. Each column now draws a short
     trail behind its head and the fade is slower, so the rain reads as rain
     from across a booth. The cards above were made more opaque at the same
     time, so the busier background costs the text nothing. */
  var TRAIL = 8;
  function draw() {
    ctx.fillStyle = "rgba(6, 0, 0, 0.055)";
    ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
    ctx.font = FONT_SIZE + "px 'Share Tech Mono', monospace";
    for (var i = 0; i < columns; i++) {
      var x = i * FONT_SIZE, y = drops[i] * FONT_SIZE;
      // trail: dimmer the further behind the head
      for (var t = TRAIL; t >= 1; t--) {
        var ty = y - t * FONT_SIZE;
        if (ty < 0) continue;
        ctx.fillStyle = "rgba(255,26,51," + (0.55 * (1 - t / (TRAIL + 1))).toFixed(3) + ")";
        ctx.fillText(GLYPHS[Math.floor(Math.random() * GLYPHS.length)], x, ty);
      }
      // head: bright, occasionally white-hot
      var ch = GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
      if (Math.random() > 0.94) { ctx.fillStyle = "#ffd0d6"; ctx.shadowColor = "#ff2440"; ctx.shadowBlur = 10; }
      else { ctx.fillStyle = "#ff3550"; ctx.shadowBlur = 0; }
      ctx.fillText(ch, x, y); ctx.shadowBlur = 0;
      if (y > window.innerHeight && Math.random() > 0.975) drops[i] = 0;
      drops[i]++;
    }
    maybeGlitch();
    if (glitch.active) {
      var h = 3 + Math.random() * 5;
      ctx.fillStyle = "rgba(255, 30, 60, 0.20)"; ctx.fillRect(0, glitch.y, window.innerWidth, h);
      ctx.fillStyle = "rgba(0, 200, 255, 0.10)"; ctx.fillRect(0, glitch.y + h, window.innerWidth, h * 0.6);
      glitch.y += 2; if (--glitch.life <= 0) glitch.active = false;
    }
  }
  var last = 0;
  function loop(ts) { if (ts - last > 42) { draw(); last = ts; } requestAnimationFrame(loop); }
  sizeCanvas();
  window.addEventListener("resize", sizeCanvas);
  /* Reduced motion still gets a background, just a still one.
   *
   * This used to paint the canvas black and call draw() once — which puts a
   * single row of glyphs along the very top and nothing else, i.e. a black
   * rectangle. Anyone with "reduce motion" on (and some kiosk browsers default
   * to it) saw the arena with no background at all. A static field reads as a
   * deliberate backdrop and costs one frame. */
  function still() {
    ctx.fillStyle = "#060000";
    ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
    ctx.font = FONT_SIZE + "px 'Share Tech Mono', monospace";
    var rows = Math.ceil(window.innerHeight / FONT_SIZE);
    for (var i = 0; i < columns; i++) {
      var head = Math.random() * rows;                  // where this column's trail ends
      for (var r = 0; r < rows; r++) {
        if (Math.random() > 0.55) continue;             // sparse, like a frame of the real thing
        var fade = Math.max(0, 1 - Math.abs(head - r) / 14);
        if (fade <= 0.02) continue;
        ctx.fillStyle = "rgba(255,26,51," + (0.10 + fade * 0.75).toFixed(3) + ")";
        ctx.fillText(GLYPHS[Math.floor(Math.random() * GLYPHS.length)], i * FONT_SIZE, r * FONT_SIZE);
      }
    }
  }
  if (reduce) { still(); window.addEventListener("resize", function () { sizeCanvas(); still(); }); }
  else { requestAnimationFrame(loop); }
})();
