import { diagnose } from '../../../lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/health — answers "why aren't scores saving?" in one request.
// Reports which database env vars are PRESENT (names only, never values), whether
// a client connected, and whether a real write/read round-trip succeeded.
export async function GET() {
  const d = await diagnose();
  const ok = d.roundTrip === true;
  return Response.json(
    {
      ok,
      verdict: ok
        ? 'Scores are saved to a shared database and persist across devices and redeploys.'
        : 'Scores are NOT being saved — the board is in serverless memory and resets.',
      ...d,
    },
    { status: 200, headers: { 'Cache-Control': 'no-store' } }
  );
}
