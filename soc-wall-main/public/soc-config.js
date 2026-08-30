/* ===========================================================================
 * SOC Wall — booth configuration.
 *
 * This file is served verbatim from /soc-config.js and is NOT bundled, so it
 * can be edited on the show floor with a text editor and picked up by a browser
 * refresh. No rebuild, no npm, no laptop with a toolchain on it.
 *
 * Everything here is optional; delete a key to fall back to the default.
 * ========================================================================= */

window.SOC_CONFIG = {
  /* Ambient telemetry.
   *   true  — the wall generates its own background threat activity (booth mode)
   *   false — the wall queries the live detection, service-desk, intelligence
   *           and network endpoints configured below
   *
   * Leave this true at GISEC. Live booth activity from the arcade and the red
   * team laptops arrives through the Arena Hub either way; `demo` only controls
   * the ambient traffic underneath it, which is what keeps the globe alive
   * between visitors. */
  demo: true,

  refreshMs: 30000,

  /* Venue clock. Every timestamp on the wall — the header clock, the incident
   * feed, the leaderboard "best of" lines — reads this zone, so the screen
   * agrees with the clock on the hall wall. Any IANA zone works:
   * Asia/Riyadh, Asia/Singapore, Europe/London. */
  timezone: "Asia/Dubai",
  timezoneLabel: "GST",

  /* Globe motion.
   *   true   the globe always sways slowly around Dubai (booth default)
   *   false  it holds still
   *   "auto" it follows the operating system's reduce-motion setting
   *
   * The default is `true` on purpose: a booth screen with the OS animation
   * setting turned down would otherwise show a dead globe, and nobody at the
   * stand would know why. */
  globeMotion: true,

  /* --- Display fit ---------------------------------------------------------
   * The wall is drawn once at a fixed size and then scaled to whatever screen
   * it is plugged into, so it fits any resolution without the text leaving its
   * boxes. Leave these alone unless the screen at the stand misbehaves.
   *
   *   designWidth / designHeight
   *     the surface the wall is composed on. 1920x1080 is what the layout was
   *     built and signed off at; changing it re-tunes nothing, it only changes
   *     what counts as "full size", so there is almost never a reason to.
   *
   *   overscan
   *     1.00 fills the screen edge to edge. Some televisions crop 2-5% of the
   *     picture ("overscan" in the TV's own menu). If the ticker or the top bar
   *     is cut off at the stand, drop this to 0.95 and the whole wall steps in
   *     from the bezel. 0.75 is the floor.
   *
   * A `?fit=0.95` parameter on the wall URL does the same thing for one screen
   * without editing this file — the fastest fix mid-show. */
  designWidth: 1920,
  designHeight: 1080,
  overscan: 1,

  /* --- Alert audio ---------------------------------------------------------
   * Every sound the wall makes is generated in the browser — there are no audio
   * files to lose, and it works with no internet. Ambient telemetry is always
   * silent; only real booth activity from the laptops and the arcade is
   * audible, and every cue is rate limited so a burst of detections is one
   * sound rather than eight.
   *
   *   enabled     false switches the wall silent
   *   volume      0 to 1. 0.7 carries across a stand without dominating it;
   *               a loud hall wants 0.9, a quiet one 0.45
   *   scoreBlips  the very quiet tick when a score lands on the leaderboard.
   *               Set false if the arcade is busy enough to make it constant
   *
   * `?sound=off` and `?volume=0.3` on the wall URL override these for one
   * screen without editing anything.
   *
   * Browsers block audio until the page is interacted with. Launch Chrome with
   * --autoplay-policy=no-user-gesture-required and the wall is audible from
   * boot; otherwise click the screen once and the prompt in the corner goes
   * away for good. */
  sound: {
    enabled: true,
    volume: 0.7,
    scoreBlips: true,
  },

  /* --- Arena Hub -----------------------------------------------------------
   * The service that ties the arcade, the red team laptops and this wall
   * together. Set `url` to the hub machine once and everything else follows.
   *
   *   url        explicit address, e.g. "http://192.168.1.50:7788"
   *   sameOrigin true when the hub is also serving this page
   *   port       used with the wall's own hostname when `url` is unset
   *
   * A `?hub=` parameter on the wall URL overrides all three, which is the
   * fastest way to repoint the screen mid-show without editing anything. */
  hub: {
    url: "",
    sameOrigin: false,
    port: 7788,
  },

  /* --- Live backends (only read when demo is false) ------------------------
   * Named for what they DO, not for whichever product supplies them at a given
   * site. Point each at the customer's own endpoint. */
  alerts:  { url: "https://indexer.local:9200", index: "security-alerts-*", user: "wall_ro", pass: "" },
  tickets: { url: "https://servicedesk.local/api/v1", token: "" },
  intel:   { url: "https://intel.local/graphql", token: "" },
  network: { url: "https://netmon.local/api/json", key: "" },
};
