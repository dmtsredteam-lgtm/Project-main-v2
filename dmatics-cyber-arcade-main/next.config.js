/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // The arcade lives in /public/game.html and is mounted in an iframe.
  // Browsers cache iframe documents aggressively — a normal refresh often will
  // NOT re-fetch them, so a fresh deploy can keep showing the old game.
  // Force a revalidation on every load. The file is ~190KB and gzips well, so
  // the cost is negligible next to a booth screen showing stale content.
  async headers() {
    // Applied to everything. A cyber-security company's booth game served with
    // no security headers at all is the kind of thing a visitor checks.
    //
    // The CSP is deliberately shaped around what game.html actually is: one
    // self-contained document with inline <style> and <script>, no build step,
    // no external assets. 'unsafe-inline' is unavoidable for that and is the
    // honest cost of "works from a USB stick with no internet"; everything else
    // is closed. connect-src stays open to http: and https: because the tablet
    // has to reach a hub on the booth LAN whose address is not known until the
    // morning of the show.
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self' http: https:",
      "media-src 'self' data: blob:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      // The page frames /game.html itself, so same-origin framing must be allowed.
      "frame-ancestors 'self'",
      "frame-src 'self'",
    ].join('; ');

    const security = [
      { key: 'Content-Security-Policy', value: csp },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'no-referrer' },
      { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()' },
      { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
    ];

    return [
      { source: '/:path*', headers: security },
      {
        source: '/game.html',
        headers: [
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Pragma', value: 'no-cache' },
        ],
      },
      // The API is never cached and never embedded.
      {
        source: '/api/:path*',
        headers: [
          { key: 'Cache-Control', value: 'no-store' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};
module.exports = nextConfig;
