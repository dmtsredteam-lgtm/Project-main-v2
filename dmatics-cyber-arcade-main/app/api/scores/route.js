import { getScores, addScore, GAMES, isPersistent, allowWrite } from '../../../lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/* The highest score any of the three games can actually produce.
 *
 * Best case is 100 points × a ×5 streak multiplier × the final-30s doubler, on
 * every single answer, for a whole round — about 30,000 in theory and roughly
 * 4,000 in practice. The old ceiling was 100,000, so `{"score": 99999}` from
 * curl sat permanently at the top of the booth leaderboard and nothing about it
 * looked wrong. 20,000 is far above any real play and far below a troll. */
const CEILING = 20000;

/* Who is posting, for the write budget. Vercel sets x-forwarded-for; on the
 * booth LAN the hub does too. Falls back to one shared bucket, which still
 * limits total write volume when there is no address at all. */
function client(request) {
  const forwarded = request.headers.get('x-forwarded-for') || '';
  const first = forwarded.split(',')[0].trim();
  return first || request.headers.get('x-real-ip') || 'unknown';
}

// Leaderboard names: up to 12 characters. Uppercased for the arcade look, and
// restricted to letters/digits/space/._- so a name can never inject markup into
// the board. Mirrors cleanName() in public/game.html.
function clean(name) {
  const s = String(name || '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ._-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 12)
    .trim();
  return s || 'PLAYER';
}

// GET /api/scores?game=phish  ->  { game, scores:[{n,s,t}] }
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const game = searchParams.get('game');
  if (!GAMES.includes(game)) {
    return Response.json({ error: 'unknown game' }, { status: 400 });
  }
  const scores = await getScores(game);
  // `persistent` tells the client whether these scores actually survive a redeploy.
  // Without a KV database attached, the board is in-memory and will be lost — the
  // arcade says so on screen rather than quietly pretending the board is safe.
  return Response.json(
    { game, scores, persistent: await isPersistent() },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

// POST /api/scores  { game, name, score }  ->  { game, scores }
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return Response.json({ error: 'bad json' }, { status: 400 });
  }
  // `JSON.parse("null")`, `"3"` and `"[1,2]"` all succeed. The first two then
  // throw on `.game`, which is a 500 from a malformed request — an error the
  // caller cannot see the cause of and the logs fill up with.
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return Response.json({ error: 'expected a JSON object' }, { status: 400 });
  }
  const game = body.game;
  if (!GAMES.includes(game)) {
    return Response.json({ error: 'unknown game' }, { status: 400 });
  }

  const budget = await allowWrite(client(request));
  if (!budget.allowed) {
    return Response.json(
      { error: 'too many scores from this device — slow down' },
      { status: 429, headers: { 'Retry-After': '60', 'Cache-Control': 'no-store' } }
    );
  }

  const name = clean(body.name);
  let score = parseInt(body.score, 10);
  if (!Number.isFinite(score)) score = 0;
  score = Math.max(0, Math.min(CEILING, score));
  const scores = await addScore(game, name, score);
  return Response.json(
    { game, scores, persistent: await isPersistent() },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
