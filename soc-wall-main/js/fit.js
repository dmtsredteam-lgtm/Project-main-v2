/* ===========================================================================
 * Viewport fit.
 *
 * The wall is drawn at one fixed size — 1920 x 1080 — and this module scales
 * that whole surface to whatever screen it is plugged into.
 *
 * Why it works this way
 * ---------------------
 * The previous build laid the wall out against the live viewport: 100vw wide,
 * 100vh tall, with vw-driven type. That fits exactly the resolutions it was
 * tuned on. On any other screen the panels resize but the words inside them do
 * not resize with them, so text walks out of its box — which is what happened
 * the first time the wall was put on a television.
 *
 * Scaling the finished surface removes the whole class of problem. There is no
 * re-flow to get wrong: the layout that was signed off is the layout that
 * appears, at 1366x768, at 1920x1080, at 2560x1440, at 3840x2160, on a
 * projector, on a portrait panel. Only the number in front of it changes.
 *
 * What is deliberately NOT scaled
 * -------------------------------
 * The ambient canvas, the grid overlay and the red alarm layer are fixed
 * full-bleed elements outside the scaled surface, so they still cover the
 * entire screen including any letterbox band on a non-16:9 display. The band
 * therefore reads as part of the wall rather than as a black bar.
 *
 * Configuration (public/soc-config.js, editable on the show floor):
 *   designWidth  / designHeight  the surface the wall is drawn at
 *   overscan                     0.90-1.00, for televisions that crop the edge
 *
 * `?fit=0.9` on the URL overrides overscan for one screen without editing
 * anything — the fastest fix if a specific panel at the stand cuts the edges.
 * ========================================================================= */

const root = document.documentElement;

function readNumber(value, fallback) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function initViewportFit() {
  const config = globalThis.SOC_CONFIG ?? {};
  const designWidth = readNumber(config.designWidth, 1920);
  const designHeight = readNumber(config.designHeight, 1080);

  const urlOverscan = new URLSearchParams(location.search).get("fit");
  const overscan = Math.min(1, Math.max(0.75, readNumber(urlOverscan ?? config.overscan, 1)));

  root.style.setProperty("--design-w", `${designWidth}px`);
  root.style.setProperty("--design-h", `${designHeight}px`);

  let lastApplied = 0;

  function apply() {
    /* clientWidth/clientHeight rather than innerWidth/innerHeight: they exclude
     * a scrollbar if one ever appears, so the wall can never scale itself into
     * a loop of "too wide -> scrollbar -> narrower -> no scrollbar". */
    const width = root.clientWidth || globalThis.innerWidth || designWidth;
    const height = root.clientHeight || globalThis.innerHeight || designHeight;

    const fit = Math.min(width / designWidth, height / designHeight) * overscan;
    if (!Number.isFinite(fit) || fit <= 0) return;

    /* Sub-thousandth changes are not visible and only cost a re-composite;
     * a TV that reports its size twice during handshake fires this twice. */
    if (Math.abs(fit - lastApplied) < 0.0005) return;
    lastApplied = fit;

    root.style.setProperty("--fit", fit.toFixed(5));
    root.dataset.fit = fit.toFixed(3);
  }

  apply();

  addEventListener("resize", apply, { passive: true });
  addEventListener("orientationchange", apply, { passive: true });
  globalThis.visualViewport?.addEventListener("resize", apply, { passive: true });

  /* A television negotiating HDMI, or a browser going full screen, can settle
   * on its final size a beat after the resize event. Re-measure on the next
   * two frames and once more after a second rather than trusting the first
   * number the display reports. */
  requestAnimationFrame(() => requestAnimationFrame(apply));
  setTimeout(apply, 1_000);
  new ResizeObserver(apply).observe(root);

  /* Watchdog. The wall runs for four days without being touched, through HDMI
   * renegotiation, a display waking from standby and a television changing its
   * own output mode. A resize event that is dropped or coalesced during one of
   * those would leave the surface at the wrong scale until someone noticed, so
   * the viewport is also polled: two integer comparisons every two seconds,
   * and apply() only runs when the numbers actually moved. */
  let lastWidth = root.clientWidth;
  let lastHeight = root.clientHeight;
  setInterval(() => {
    if (root.clientWidth === lastWidth && root.clientHeight === lastHeight) return;
    lastWidth = root.clientWidth;
    lastHeight = root.clientHeight;
    apply();
  }, 2_000);

  /* Exposed so the run book's diagnostics — and anyone with a console open at
   * the stand — can read the scale the wall settled on. */
  globalThis.SOC_FIT = { apply, get value() { return lastApplied; }, designWidth, designHeight, overscan };

  return apply;
}
