import { clearAll } from '../../../../lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Booth admin reset. The credentials live on the SERVER, so the real check can't
// be bypassed by editing the page in a browser.
//
// There is deliberately no fallback password. This file used to carry one, with
// a comment noting it was "visible to anyone who reads this repository" — which
// became literally true the moment the project was pushed to GitHub. A default
// credential in a repo is not a default, it is a published password.
//
// Set ADMIN_USER and ADMIN_PASSWORD in the environment (Vercel project settings,
// or .env.local when running it yourself — see .env.example). With them unset the
// endpoint refuses every request and says why, which is the correct behaviour for
// a destructive endpoint that nobody has configured.
const USER = process.env.ADMIN_USER;
const PASS = process.env.ADMIN_PASSWORD;

import { createHash, timingSafeEqual } from 'node:crypto';

/* Constant time for real.
 *
 * The previous version opened with `if (x.length !== y.length) return false`,
 * which is an early return on length — the one thing the comment above it said
 * it was avoiding. Hashing both sides first makes every comparison exactly 32
 * bytes whatever the inputs were, so neither the length nor a shared prefix is
 * observable in the response time. */
function same(a, b) {
  const digest = (v) => createHash('sha256').update(String(v ?? ''), 'utf8').digest();
  return timingSafeEqual(digest(a), digest(b));
}

export async function POST(request) {
  let body;
  try { body = await request.json(); } catch (e) {
    return Response.json({ ok: false, error: 'bad json' }, { status: 400 });
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return Response.json({ ok: false, error: 'expected a JSON object' }, { status: 400 });
  }
  if (!USER || !PASS) {
    console.error('[admin] ADMIN_USER / ADMIN_PASSWORD are not set — reset endpoint disabled.');
    return Response.json({
      ok: false,
      error: 'Admin reset is not configured on this deployment. Set ADMIN_USER and ADMIN_PASSWORD.',
    }, { status: 503 });
  }
  if (!same(body.user, USER) || !same(body.pass, PASS)) {
    // One deliberate second, so the password can't be brute-forced quickly.
    await new Promise((r) => setTimeout(r, 1000));
    return Response.json({ ok: false, error: 'Wrong username or password.' }, { status: 401 });
  }
  const res = await clearAll();
  const surfaces = [{ name: 'arcade', ok: true, detail: res.cleared }];
  surfaces.push(...(await clearTheRest()));

  const failed = surfaces.filter((s) => !s.ok);
  return Response.json(
    {
      ok: true,
      ...res,
      surfaces,
      // Honest, not cheerful. "All leaderboards cleared" when the hub was
      // unreachable is the worst possible thing for this button to say: the
      // crew walks away and the wall is still showing yesterday.
      message: failed.length
        ? `Arcade cleared. Could not clear: ${failed.map((s) => s.name).join(', ')}.`
        : `Cleared ${surfaces.map((s) => s.name).join(', ')}.`,
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

/* One button, every board.
 *
 * The booth has three separate leaderboards — this arcade's, the hub's combined
 * arena board that feeds the SOC wall, and the red team's SQLite. Clearing them
 * one at a time meant remembering three URLs and three credentials at the end of
 * a show day, and forgetting one meant a wall showing yesterday's winner.
 *
 * Best effort by design: a surface that is switched off or unreachable is
 * reported, not fatal. The arcade's own board is already cleared by the time
 * this runs, and refusing to clear it because the hub is down would be worse.
 *
 * Reachability caveat: this runs on the arcade's SERVER. Served from the hub on
 * the booth LAN (the GISEC setup) it can reach both. Deployed to Vercel it
 * cannot reach anything on your LAN, and both will simply report unreachable —
 * which is the truth, and is why the button says so.
 */
async function clearTheRest() {
  const token = process.env.ADMIN_TOKEN || '';
  const hub = (process.env.GISEC_HUB || process.env.NEXT_PUBLIC_GISEC_HUB || '').replace(/\/$/, '');
  const redteam = (process.env.REDTEAM_URL || '').replace(/\/$/, '');

  const targets = [
    hub ? {
      name: 'hub',
      url: `${hub}/api/admin/reset`,
      init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) },
    } : { name: 'hub', skipped: 'GISEC_HUB is not set' },
    redteam ? {
      name: 'red team',
      url: `${redteam}/admin/reset`,
      init: { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Token': token }, body: '{}' },
    } : { name: 'red team', skipped: 'REDTEAM_URL is not set' },
  ];

  return Promise.all(targets.map(async (target) => {
    if (target.skipped) return { name: target.name, ok: false, detail: target.skipped };
    if (!token) return { name: target.name, ok: false, detail: 'ADMIN_TOKEN is not set on the arcade' };
    try {
      // A booth service that has wedged must not hang the button for 30 seconds.
      const response = await fetch(target.url, { ...target.init, signal: AbortSignal.timeout(6000) });
      const body = await response.json().catch(() => ({}));
      return response.ok && body.ok !== false
        ? { name: target.name, ok: true, detail: body.message || body.cleared || 'cleared' }
        : { name: target.name, ok: false, detail: body.error || `HTTP ${response.status}` };
    } catch (error) {
      // "fetch failed" tells the booth crew nothing. Name the thing they can act on.
      const raw = String(error?.message || error);
      const detail = /timeout|abort/i.test(raw) ? 'no answer within 6s — is it running?'
        : /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network/i.test(raw)
          ? `unreachable at ${new URL(target.url).origin} — is it running, and on this network?`
          : raw.slice(0, 90);
      return { name: target.name, ok: false, detail };
    }
  }));
}
