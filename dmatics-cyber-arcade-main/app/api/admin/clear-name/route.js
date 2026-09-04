import { GAMES, removeScore } from '../../../../lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Free up ONE handle on ONE leaderboard without wiping the whole booth.
// Companion to /api/admin/reset: same credentials, same "no fallback
// password" stance (see that file), but the blast radius is a single row.
//
// Covers all four games. For Phish Hunter / Alert Rush / Breach Point THIS
// server is the source of truth (lib/store.js), so removeScore() runs right
// here; the hub is only told afterwards, to keep its cached copy (what the
// SOC wall's arena panel reads) from showing a name this arcade already
// dropped. Red Team is the opposite shape: its source of truth is the SQLite
// file on the challenge laptop, so that request is the one that matters and
// the hub call is the belt-and-braces one. Pairs with app.py's "one shot per
// name" rule (name_taken()) for Red Team; for the arcade's own three games
// it's just "remove this row" — there's no one-shot rule on those to free up.
const USER = process.env.ADMIN_USER;
const PASS = process.env.ADMIN_PASSWORD;
const ADMIN_GAMES = [...GAMES, 'redteam'];   // ['phish','soc','breach','redteam']

import { createHash, timingSafeEqual } from 'node:crypto';

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
    console.error('[admin] ADMIN_USER / ADMIN_PASSWORD are not set — clear-name endpoint disabled.');
    return Response.json({
      ok: false,
      error: 'Admin actions are not configured on this deployment. Set ADMIN_USER and ADMIN_PASSWORD.',
    }, { status: 503 });
  }
  if (!same(body.user, USER) || !same(body.pass, PASS)) {
    await new Promise((r) => setTimeout(r, 1000));
    return Response.json({ ok: false, error: 'Wrong username or password.' }, { status: 401 });
  }
  const player = typeof body.player === 'string' ? body.player.trim() : '';
  if (!player) {
    return Response.json({ ok: false, error: 'No player name given.' }, { status: 400 });
  }
  const game = ADMIN_GAMES.includes(body.game) ? body.game : 'redteam';

  const surfaces = game === 'redteam'
    ? await clearRedTeam(player)
    : await clearArcadeGame(game, player);

  const failed = surfaces.filter((s) => !s.ok);
  return Response.json(
    {
      ok: true,
      player,
      game,
      surfaces,
      message: failed.length
        ? `Could not fully clear "${player}": ${failed.map((s) => s.name).join(', ')}.`
        : `"${player}" removed from ${surfaces.map((s) => s.name).join(', ')}.`,
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

/* Phish Hunter / Alert Rush / Breach Point: this server owns the board, so the
 * removal itself is a direct call, not a fetch — no network hop, no token to
 * check. The hub is best-effort afterwards, purely to keep the wall's cached
 * copy from showing a row this arcade just deleted. */
async function clearArcadeGame(game, player) {
  const res = await removeScore(game, player);
  const surfaces = [{ name: 'arcade', ok: true, detail: `removed ${res.removed} row(s)` }];
  surfaces.push(...(await clearNameOnHub(player, game)));
  return surfaces;
}

/* Red Team: the SQLite file on the challenge laptop is the source of truth
 * (see save_score() in app.py), so that request is the one that matters here.
 * The hub call is belt-and-braces for a deploy where this arcade can reach
 * red team directly with no hub in between — on a hub-served deploy the hub's
 * own /api/admin/clear-name already forwards to red team itself, so hitting
 * both is redundant, not wrong: deleting the same row twice is harmless. */
async function clearRedTeam(player) {
  const token = process.env.ADMIN_TOKEN || '';
  const redteam = (process.env.REDTEAM_URL || '').replace(/\/$/, '');

  const surfaces = [...(await clearNameOnHub(player, 'redteam'))];
  if (!redteam) {
    surfaces.push({ name: 'red team', ok: false, detail: 'REDTEAM_URL is not set' });
  } else if (!token) {
    surfaces.push({ name: 'red team', ok: false, detail: 'ADMIN_TOKEN is not set on the arcade' });
  } else {
    surfaces.push(await hit('red team', `${redteam}/admin/clear-name`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Token': token },
      body: JSON.stringify({ player }),
    }));
  }
  return surfaces;
}

async function clearNameOnHub(player, game) {
  const token = process.env.ADMIN_TOKEN || '';
  const hub = (process.env.GISEC_HUB || process.env.NEXT_PUBLIC_GISEC_HUB || '').replace(/\/$/, '');
  if (!hub) return [{ name: 'hub', ok: false, detail: 'GISEC_HUB is not set' }];
  if (!token) return [{ name: 'hub', ok: false, detail: 'ADMIN_TOKEN is not set on the arcade' }];
  return [await hit('hub', `${hub}/api/admin/clear-name`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, player, game }),
  })];
}

async function hit(name, url, init) {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(6000) });
    const body = await response.json().catch(() => ({}));
    return response.ok && body.ok !== false
      ? { name, ok: true, detail: body.message || `removed ${body.rows ?? 0} row(s)` }
      : { name, ok: false, detail: body.error || `HTTP ${response.status}` };
  } catch (error) {
    const raw = String(error?.message || error);
    const detail = /timeout|abort/i.test(raw) ? 'no answer within 6s — is it running?'
      : /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network/i.test(raw)
        ? `unreachable at ${new URL(url).origin} — is it running, and on this network?`
        : raw.slice(0, 90);
    return { name, ok: false, detail };
  }
}
