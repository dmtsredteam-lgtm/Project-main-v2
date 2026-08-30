/**
 * GISEC Arena Hub client.
 *
 * The wall's own adapters (api.js) stay exactly as they were — whatever detection,
 * ticketing, intelligence and network feeds a site runs, or the demo generator.
 * This module is a *second*, additive feed: it opens a Server-Sent Events stream
 * to the Arena Hub and pushes real booth activity into the same alert pipeline.
 *
 * Because the hub emits alerts already shaped to the wall's contract, a failed
 * password on Laptop 02 arrives at the globe, the origin list and the threat
 * timeline as an ordinary detection. Nothing downstream needs to know the
 * difference.
 *
 * If the hub is unreachable the wall behaves precisely as it does today. The
 * stream reconnects on its own with backoff, so starting the hub after the wall
 * (or restarting it mid-show) recovers without touching the big screen.
 */

const RETRY_MIN = 2_000;
const RETRY_MAX = 20_000;

/**
 * Work out where the hub lives, cheapest guess first:
 *   1. an explicit `SOC_CONFIG.hub.url`
 *   2. `?hub=http://10.0.0.5:7788` on the wall URL (handy at the booth)
 *   3. same origin — the hub can serve the wall build itself
 *   4. the wall's own hostname on the hub's default port
 */
/* ?hub= is the fastest way to repoint the screen mid-show, and it was also an
 * open redirect for the wall's entire data feed: anything typed there became
 * the origin of every alert, every leaderboard row and every command the wall
 * would then render. Whoever controls that origin controls the big screen.
 *
 * A booth hub is always http(s) on the LAN, so that is all this accepts. */
const PRIVATE_HOST = /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|\[::1\]|[a-z0-9-]+\.local)$/i;

function safeHubUrl(candidate) {
  let parsed;
  try { parsed = new URL(String(candidate), location.href); } catch { return null; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.hostname !== location.hostname && !PRIVATE_HOST.test(parsed.hostname)) return null;
  return `${parsed.origin}${parsed.pathname}`.replace(/\/$/, "");
}

export function resolveHubUrl() {
  const configured = globalThis.SOC_CONFIG?.hub?.url;
  if (configured) return String(configured).replace(/\/$/, "");

  const fromQuery = new URLSearchParams(location.search).get("hub");
  if (fromQuery) {
    const checked = safeHubUrl(fromQuery);
    if (checked) return checked;
    console.warn("[arena] ignoring ?hub= — not an http(s) address on a private network");
  }

  if (location.protocol === "file:") return null;
  if (globalThis.SOC_CONFIG?.hub?.sameOrigin) return location.origin;

  /* Last resort: this machine's own hostname on the hub port. Only when that
   * hostname is a booth machine. On a wall served from Vercel it produced
   * https://something.vercel.app:7788 — a connection that can never succeed, so
   * the wall spent the whole show in a reconnect loop against a port that does
   * not exist. If the hub really is somewhere public, name it in
   * soc-config.js `hub.url`, which is trusted because only someone at the booth
   * machine can edit it. */
  if (location.hostname !== "localhost" && !PRIVATE_HOST.test(location.hostname)) {
    console.warn("[arena] no hub configured, and this is not a booth address — set hub.url in soc-config.js");
    return null;
  }
  const port = globalThis.SOC_CONFIG?.hub?.port ?? 7788;
  return `${location.protocol}//${location.hostname}:${port}`;
}

export function connectHub(handlers = {}) {
  const base = resolveHubUrl();
  const state = { connected: false, url: base, lastEventAt: 0, alerts: 0 };
  if (!base) return { state, close() {} };

  let source = null;
  let retry = RETRY_MIN;
  let closed = false;
  let retryTimer = null;

  const announce = (connected) => {
    if (state.connected === connected) return;
    state.connected = connected;
    handlers.onStatus?.(connected, base);
  };

  const on = (event, callback) => source.addEventListener(event, (message) => {
    state.lastEventAt = Date.now();
    let payload;
    try { payload = JSON.parse(message.data); } catch { return; }
    callback(payload);
  });

  function open() {
    if (closed) return;
    try {
      source = new EventSource(`${base}/api/stream`);
    } catch (error) {
      console.warn("Arena hub stream could not be opened.", error);
      schedule();
      return;
    }

    source.addEventListener("open", () => { retry = RETRY_MIN; announce(true); });

    // Snapshot for a wall that joined late or was restarted mid-show: recent
    // alerts, current station posture, and the boards, all in one message.
    on("hello", (payload) => {
      announce(true);
      handlers.onSnapshot?.(payload);
    });

    on("alert", (alert) => { state.alerts += 1; handlers.onAlert?.(alert); });
    on("score", (payload) => handlers.onScore?.(payload));
    on("station", (station) => handlers.onStation?.(station));
    on("command", (command) => handlers.onCommand?.(command));

    source.addEventListener("error", () => {
      // EventSource retries on its own, but only for network blips — it gives up
      // on some failures, and it never re-runs our `hello` handshake. Owning the
      // reconnect keeps the snapshot semantics intact.
      announce(false);
      try { source.close(); } catch {}
      schedule();
    });
  }

  function schedule() {
    if (closed || retryTimer) return;
    retryTimer = setTimeout(() => { retryTimer = null; open(); }, retry);
    retry = Math.min(RETRY_MAX, Math.round(retry * 1.6));
  }

  open();

  return {
    state,
    close() {
      closed = true;
      clearTimeout(retryTimer);
      try { source?.close(); } catch {}
    },
  };
}

/** One-shot board fetch, used to prime the arena panel before the stream lands. */
export async function fetchArena(base = resolveHubUrl()) {
  if (!base) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6_000);
  try {
    const response = await fetch(`${base}/api/state`, { signal: controller.signal, cache: "no-store" });
    if (!response.ok) throw new Error(`Hub responded ${response.status}`);
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
