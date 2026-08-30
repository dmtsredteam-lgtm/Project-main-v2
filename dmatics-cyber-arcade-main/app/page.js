// The arcade UI (all three games, music, animated backgrounds, review) is a
// self-contained, offline-capable document in /public/game.html. We mount it
// full-bleed. Because it is served over http(s) and same-origin with the API
// routes, its leaderboard auto-syncs to the shared server board via /api/scores.
// Opened as a local file it falls back to on-device localStorage — so the exact
// same file works online AND offline at the booth.

// Cache-busting: iframes are cached hard by browsers, so a new deploy can keep
// showing the previous build. Stamping the commit SHA (or the build time as a
// fallback) into the URL guarantees every deploy serves a fresh document.
const BUILD_ID =
  process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 8) || Date.now().toString(36);

// GISEC Arena Hub — the booth service that feeds the big-screen SOC Wall.
// The game document resolves its own address (see HUB in game.html) but cannot
// see this page's query string from inside the iframe, so anything passed to
// the arcade URL is forwarded through. Set NEXT_PUBLIC_GISEC_HUB to bake the
// address into a deploy; use ?hub=... to point a device at a hub on the day,
// or ?hub=off to take one device off the wall.
const HUB_DEFAULT = process.env.NEXT_PUBLIC_GISEC_HUB || '';

export default function Page({ searchParams }) {
  const hub = typeof searchParams?.hub === 'string' ? searchParams.hub : HUB_DEFAULT;
  const query = `v=${BUILD_ID}${hub ? `&hub=${encodeURIComponent(hub)}` : ''}`;

  return (
    <iframe
      src={`/game.html?${query}`}
      title="DMATICS Cyber Arcade"
      allow="autoplay; fullscreen"
      style={{
        position: 'fixed',
        inset: 0,
        width: '100%',
        height: '100dvh',      // not 100% — mobile browsers measure that
        minHeight: '100%',    // with the address bar collapsed, hiding the bottom
        border: 'none',
        display: 'block',
        background: '#0a0713',
      }}
    />
  );
}
