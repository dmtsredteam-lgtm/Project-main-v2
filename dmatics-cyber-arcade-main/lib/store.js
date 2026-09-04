// Leaderboard storage.
//
//  • A Redis-compatible database is used when one is attached, giving a single
//    shared board that survives redeploys and is identical on every device.
//  • Otherwise the board lives in serverless memory: it works, but each instance
//    has its own copy and everything is lost on redeploy. The client is told
//    which of the two is in play (`persistent`) so the UI can say so honestly.
//
// Detection deliberately does a real round-trip rather than trusting environment
// variables. Env vars can be present while the client still fails to connect —
// which looks exactly like "the database is attached but nothing saves".

const GAMES = ['phish', 'soc', 'breach'];
const MAX = 10;
const KEEP = 200;          // raw entries retained per game before trimming
const LIST = 'scores:';    // append-only list key prefix

/* The board is a sorted set, not the tail of the raw list.
 *
 * The list is trimmed to the newest KEEP entries. Over a four-day show that is
 * a few hours of play, so the highest score of day one was deleted on day two
 * and the board silently became "best of this afternoon". Verified: one 9,999
 * followed by 250 ordinary plays, and the 9,999 was gone.
 *
 * ZADD ... GT keeps one member per player at their highest score, forever, in
 * a single atomic command — no read-modify-write for two kiosks to race on.
 * The list stays as the append-only record of every attempt. */
const BEST = 'best:';      // sorted set: member = player, score = best points
const WHEN = 'bestat:';    // hash: player -> timestamp of that best

// ---- in-memory fallback (module scope) ----
const mem = { phish: [], soc: [], breach: [] };

// One row per player, keeping their personal best. The raw append-only list keeps
// every attempt (useful afterwards); the board the arcade shows is collapsed, so a
// visitor who plays five times occupies one line, not five.
function sortTrim(list) {
  const best = new Map();
  list
    .filter((e) => e && typeof e.s === 'number' && typeof e.n === 'string')
    .forEach((e) => {
      const k = e.n.toUpperCase();
      const cur = best.get(k);
      if (!cur || e.s > cur.s) best.set(k, e);
    });
    return [...best.values()].sort((a, b) => (b.s - a.s) || ((a.t ?? Infinity) - (b.t ?? Infinity))).slice(0, MAX);
}

// Every env-var shape a Vercel / Upstash / Redis integration might inject.
//
// Upstash's Vercel integration PREFIXES every variable with the store name, e.g.
// `dmatics_arcade_KV_REST_API_URL`. Matching exact names therefore finds nothing
// and the app silently falls back to memory — so we match on the SUFFIX and pair
// variables by their shared prefix. The read-only token is never used for writes.
function findBySuffix(suffix) {
  const hit = Object.keys(process.env).find(
    (k) => k.toUpperCase().endsWith(suffix) && !k.toUpperCase().includes('READ_ONLY') && process.env[k]
  );
  return hit ? { key: hit, prefix: hit.slice(0, hit.length - suffix.length), value: process.env[hit] } : null;
}

// Returns every usable credential set, best transport first. Returning a LIST
// (not one winner) matters: if REST credentials exist but the endpoint refuses,
// we can still fall back to the TCP URL instead of silently dropping to memory.
function candidates() {
  const out = [];
  for (const [urlSuffix, tokenSuffix, kind] of [
    ['KV_REST_API_URL', 'KV_REST_API_TOKEN', 'vercel-kv'],
    ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'upstash-rest'],
  ]) {
    const url = findBySuffix(urlSuffix);
    if (!url) continue;
    const exact = process.env[url.prefix + tokenSuffix];
    const token = exact || (findBySuffix(tokenSuffix) || {}).value;
    if (token) out.push({ kind, url: url.value, token, via: url.key });
  }
  const tcp = findBySuffix('REDIS_URL') || findBySuffix('KV_URL');
  if (tcp) out.push({ kind: 'redis-tcp', url: tcp.value, via: tcp.key });
  return out;
}

function credentials() {
  return candidates()[0] || null;
}

let clientPromise = null;   // cached across invocations on a warm instance

async function connect(cred) {
  if (!cred) return null;

  if (cred.kind === 'redis-tcp') {
    const { createClient } = await import('redis');
    const c = createClient({ url: cred.url });
    c.on('error', () => {});
    if (!c.isOpen) await c.connect();
    return {
      kind: cred.kind,
      lpush: (k, v) => c.lPush(k, v),
      ltrim: (k, a, b) => c.lTrim(k, a, b),
      lrange: (k, a, b) => c.lRange(k, a, b),
      get: async (k) => { const v = await c.get(k); return v ? JSON.parse(v) : null; },
      del: (k) => c.del(k),
      ping: () => c.ping(),
      zadd: (k, score, member) => c.zAdd(k, [{ score, value: member }], { GT: true, CH: true }),
      // Returns [{ value, score }, …], highest first.
      ztop: async (k, count) => {
        const rows = await c.zRangeWithScores(k, 0, Math.max(0, count - 1), { REV: true });
        return rows.map((r) => ({ member: r.value, score: Number(r.score) }));
      },
      zrem: (k, member) => c.zRem(k, member),
      hset: (k, field, value) => c.hSet(k, field, String(value)),
      hgetall: (k) => c.hGetAll(k),
      hdel: (k, field) => c.hDel(k, field),
      incrEx: async (k, seconds) => {
        const n = await c.incr(k);
        if (n === 1) await c.expire(k, seconds);
        return n;
      },
    };
  }

  const { createClient } = await import('@vercel/kv');
  const kv = createClient({ url: cred.url, token: cred.token });
  return {
    kind: cred.kind,
    lpush: (k, v) => kv.lpush(k, v),
    ltrim: (k, a, b) => kv.ltrim(k, a, b),
    lrange: (k, a, b) => kv.lrange(k, a, b),
    get: (k) => kv.get(k),
    del: (k) => kv.del(k),
    ping: () => kv.ping(),
    zadd: (k, score, member) => kv.zadd(k, { gt: true, ch: true }, { score, member }),
    ztop: async (k, count) => {
      // Upstash returns a flat [member, score, member, score, …].
      const flat = await kv.zrange(k, 0, Math.max(0, count - 1), { rev: true, withScores: true });
      const out = [];
      if (Array.isArray(flat)) {
        for (let i = 0; i < flat.length; i += 2) {
          out.push({ member: String(flat[i]), score: Number(flat[i + 1]) });
        }
      }
      return out;
    },
    zrem: (k, member) => kv.zrem(k, member),
    hset: (k, field, value) => kv.hset(k, { [field]: String(value) }),
    hgetall: (k) => kv.hgetall(k),
    hdel: (k, field) => kv.hdel(k, field),
    incrEx: async (k, seconds) => {
      const n = await kv.incr(k);
      if (n === 1) await kv.expire(k, seconds);
      return n;
    },
  };
}

async function openFirstWorking() {
  for (const cred of candidates()) {
    try {
      const c = await connect(cred);
      if (!c) continue;
      await c.ping();                    // must actually answer, not just construct
      return c;
    } catch (e) { /* try the next transport */ }
  }
  return null;
}

async function db() {
  if (!candidates().length) return null;
  if (!clientPromise) clientPromise = openFirstWorking().catch(() => null);
  const c = await clientPromise;
  if (!c) clientPromise = null;          // allow a retry on the next request
  return c;
}

/* True only when a real client exists AND answered. This is what the badge shows.
 *
 * Cached for a few seconds. Every /api/scores GET and POST called this, and it
 * PINGed the store each time — on top of the ping db() already does — so the
 * arcade paid two extra round trips per request purely to render a badge that
 * changes about once a show. Short enough that pulling the database out is still
 * reflected on the next poll. */
let persistentCache = { at: 0, value: false };
const PERSISTENT_TTL_MS = 5000;

async function isPersistent() {
  const now = Date.now();
  if (now - persistentCache.at < PERSISTENT_TTL_MS) return persistentCache.value;
  let value = false;
  const c = await db();
  if (c) {
    try {
      await c.ping();
      value = true;
    } catch (e) { value = false; }
  }
  persistentCache = { at: now, value };
  return value;
}

function safeParse(v) {
  if (v == null) return null;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch (e) { return null; }
}

// Reads the append-only list plus any board left by the older blob format, so an
// upgrade never loses scores that are already stored.
async function readAll(c, game) {
  const [list, legacy] = await Promise.all([
    c.lrange(LIST + game, 0, KEEP - 1).catch(() => []),
    c.get('board:' + game).catch(() => null),
  ]);
  return []
    .concat(Array.isArray(list) ? list.map(safeParse) : [])
    .concat(Array.isArray(legacy) ? legacy : []);
}

/* The all-time board, from the sorted set.
 *
 * Merged with whatever the raw list still holds so an upgrade over a deployment
 * that predates the sorted set does not appear to wipe the leaderboard — the
 * recent entries carry it until the first write of each player backfills the
 * set. Returns null if the store does not support sorted sets, so the caller
 * can fall back to the old behaviour instead of showing an empty board. */
async function readBest(c, game) {
  if (typeof c.ztop !== 'function') return null;
  const [top, when, recent] = await Promise.all([
    c.ztop(BEST + game, MAX),
    c.hgetall(WHEN + game).catch(() => ({})),
    readAll(c, game).catch(() => []),
  ]);
  if (!Array.isArray(top)) return null;
  const stamps = when && typeof when === 'object' ? when : {};
  const rows = top
    .filter((r) => r && typeof r.member === 'string' && Number.isFinite(r.score))
    .map((r) => ({ n: r.member, s: r.score, t: Number(stamps[r.member]) || 0 }));
  return sortTrim(rows.concat(recent));
}

export async function getScores(game) {
  if (!GAMES.includes(game)) return [];
  const c = await db();
  if (c) {
    try {
      const best = await readBest(c, game);
      if (best) return best;
      return sortTrim(await readAll(c, game));
    } catch (e) { /* fall through */ }
  }
  return sortTrim(mem[game] || []);
}

export async function addScore(game, name, score) {
  if (!GAMES.includes(game)) return [];
  const entry = { n: name, s: score, t: Date.now() };
  const c = await db();
  if (c) {
    try {
      // LPUSH is atomic, so two kiosks saving at the same moment cannot overwrite
      // each other the way a read-modify-write of a whole board would.
      await c.lpush(LIST + game, JSON.stringify(entry));
      await c.ltrim(LIST + game, 0, KEEP - 1).catch(() => {});
      if (typeof c.zadd === 'function') {
        // GT: only moves a player's entry up. A later worse round cannot knock
        // their best off the board, and the entry never expires with the list.
        const changed = await c.zadd(BEST + game, score, name).catch(() => null);
        // Only stamp the time when the score actually improved (CH returns 1).
        if (changed && typeof c.hset === 'function') {
          await c.hset(WHEN + game, name, entry.t).catch(() => {});
        }
      }
      const best = await readBest(c, game);
      if (best) return best;
      return sortTrim(await readAll(c, game));
    } catch (e) { /* fall through */ }
  }
  mem[game] = sortTrim((mem[game] || []).concat(entry));
  return mem[game];
}

// Same normalisation clean() in the scores route applies before a name is ever
// stored (uppercase, trimmed) — matching on it here means "SAM", "sam" and
// " Sam " all find the row that a visitor actually saved under.
function normalizeName(name) {
  return String(name || '').toUpperCase().trim();
}

/* Removes ONE player's row from a game's board — every trace of them, not just
 * the ranked one.
 *
 * The sorted set (BEST) is what ranks the board, but readBest() ALWAYS folds
 * the raw append-only list back in (`rows.concat(recent)`) so an upgrade never
 * looks like it wiped history — which means a name still sitting in the raw
 * list resurrects itself onto the board via sortTrim() the instant this ran,
 * even after being dropped from BEST/WHEN. The list has to be rewritten too,
 * not just the set. There's no "delete matching" primitive for a Redis list,
 * so it's read whole, filtered, and rebuilt — cheap, since it's capped at KEEP
 * (200) entries.
 */
export async function removeScore(game, name) {
  if (!GAMES.includes(game)) return { removed: 0 };
  const key = normalizeName(name);
  if (!key) return { removed: 0 };

  const c = await db();
  if (c) {
    try {
      const raw = await c.lrange(LIST + game, 0, KEEP - 1).catch(() => []);
      const parsed = (Array.isArray(raw) ? raw : []).map(safeParse).filter(Boolean);
      const kept = parsed.filter((e) => !(e && typeof e.n === 'string' && e.n.toUpperCase() === key));
      const removed = parsed.length - kept.length;
      if (removed > 0) {
        await c.del(LIST + game).catch(() => {});
        // LPUSH prepends; pushing oldest-first leaves the newest entry back at
        // the head, the same relative order the list had before the rewrite.
        for (const entry of [...kept].reverse()) {
          await c.lpush(LIST + game, JSON.stringify(entry)).catch(() => {});
        }
      }
      if (typeof c.zrem === 'function') await c.zrem(BEST + game, key).catch(() => {});
      if (typeof c.hdel === 'function') await c.hdel(WHEN + game, key).catch(() => {});
      return { removed };
    } catch (e) { /* fall through to memory */ }
  }
  const before = (mem[game] || []).length;
  mem[game] = (mem[game] || []).filter((e) => !(e && typeof e.n === 'string' && e.n.toUpperCase() === key));
  return { removed: before - mem[game].length };
}

// Diagnostics for /api/health — reports NAMES of env vars only, never values.
export async function diagnose() {
  const cred = credentials();
  const SUFFIXES = [
    'KV_REST_API_URL', 'KV_REST_API_TOKEN',
    'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN',
    'REDIS_URL', 'KV_URL',
  ];
  // Names only — never values.
  const present = Object.keys(process.env).filter((k) =>
    SUFFIXES.some((s) => k.toUpperCase().endsWith(s)) && process.env[k]
  );
  const out = {
    provider: cred ? cred.kind : null,
    usingVariable: cred ? cred.via : null,
    transportsAvailable: candidates().map((c) => c.kind),
    envVarsPresent: present,
    connected: false,
    roundTrip: false,
    error: null,
  };
  if (!cred) {
    out.error = present.length
      ? 'Database variables exist but none could be paired into a usable set.'
      : 'No database environment variables found — attach a store in Vercel, then redeploy.';
    return out;
  }
  try {
    const c = await db();
    if (!c) { out.error = 'Credentials present but the client could not be created.'; return out; }
    out.connected = true;
    out.provider = c.kind;               // the transport that actually answered
    await c.ping();
    // One fixed key, deleted afterwards. This used to mint `__health:<now>` on
    // every call and never remove it — the wall polls health, so the store
    // accumulated a new dead key every few seconds for the length of the show.
    const probe = '__health:probe';
    try {
      await c.del(probe).catch(() => {});
      await c.lpush(probe, JSON.stringify({ ok: 1 }));
      const back = await c.lrange(probe, 0, 0);
      out.roundTrip = Array.isArray(back) && back.length === 1;
    } finally {
      await c.del(probe).catch(() => {});
    }
  } catch (e) {
    out.error = String((e && e.message) || e).slice(0, 200);
  }
  return out;
}

// Wipes every board — the shared database when one is attached, and always the
// in-memory copy. Used by the admin reset so the booth can start a clean day.
export async function clearAll() {
  GAMES.forEach((g) => { mem[g] = []; });
  const c = await db();
  if (!c) return { cleared: 'memory' };
  await Promise.all(
    GAMES.flatMap((g) => [
      c.del(LIST + g).catch(() => {}),
      c.del('board:' + g).catch(() => {}),
      c.del(BEST + g).catch(() => {}),   // without this the reset does nothing
      c.del(WHEN + g).catch(() => {}),
    ])
  );
  return { cleared: 'database' };
}

/* A per-client write budget.
 *
 * /api/scores takes an unauthenticated POST, because the thing posting is an
 * iPad on a trade-show LAN and there is nowhere to keep a secret on it. That is
 * the right trade for a booth game — but it also means one person with curl can
 * push a thousand rows and bury every real visitor. This does not make the
 * endpoint authentic; it makes it un-spammable, which is the property that
 * actually matters here.
 *
 * Backed by the shared store when there is one, so the limit holds across
 * serverless instances; otherwise per-instance memory, which is still enough to
 * stop a loop from one laptop.
 */
const RATE = 'rate:';
const memRate = new Map();

export async function allowWrite(who, limit = 30, windowSeconds = 60) {
  const bucket = `${who}:${Math.floor(Date.now() / (windowSeconds * 1000))}`;
  const c = await db();
  if (c && typeof c.incrEx === 'function') {
    try {
      const n = await c.incrEx(RATE + bucket, windowSeconds);
      return { allowed: n <= limit, count: n };
    } catch (e) { /* fall through to memory */ }
  }
  // Memory: keep only the current window, so the map cannot grow all day.
  for (const key of memRate.keys()) if (!key.endsWith(bucket.split(':').pop())) memRate.delete(key);
  const n = (memRate.get(bucket) || 0) + 1;
  memRate.set(bucket, n);
  return { allowed: n <= limit, count: n };
}

export { GAMES, isPersistent };
