#!/usr/bin/env bash
#
# Is the booth actually working?
#
# Answers one question in about five seconds, without touching anything: are the
# four surfaces up, do they agree with each other, and is the reset button going
# to work at the end of the day.
#
#   ./check.sh                  check this machine
#   ./check.sh --host 192.168.1.50   check a booth from another laptop
#
# Exit code 0 = everything a visitor needs is working.
# Exit code 1 = something is wrong; every line says what and how to fix it.
#
# DMATICS IT Solutions LLC · GISEC 2026
set -uo pipefail
cd "$(dirname "$0")"

HOST="127.0.0.1"
HUB_PORT="${HUB_PORT:-7788}"
RT_PORT="${RT_PORT:-8000}"
while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="$2"; shift ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1"; exit 1 ;;
  esac
  shift
done
case "$HOST" in *[!a-zA-Z0-9.:-]*) echo "bad --host"; exit 1 ;; esac

if [ -t 1 ]; then
  B=$'\033[1m'; DIM=$'\033[2m'; R=$'\033[0m'
  OK=$'\033[32m'; WARN=$'\033[33m'; ERR=$'\033[31m'; CY=$'\033[36m'
else B=""; DIM=""; R=""; OK=""; WARN=""; ERR=""; CY=""; fi

FAILS=0
pass() { printf '  %s✓%s %s\n' "$OK" "$R" "$*"; }
warn() { printf '  %s!%s %s\n' "$WARN" "$R" "$*"; }
fail() { printf '  %s✗%s %s\n' "$ERR" "$R" "$*"; FAILS=$((FAILS+1)); }
head2(){ printf '\n%s%s%s\n' "$B" "$*" "$R"; }
hint() { printf '     %s%s%s\n' "$DIM" "$*" "$R"; }

command -v curl >/dev/null 2>&1 || { echo "curl is not installed; every check here needs it."; exit 1; }

HUB="http://$HOST:$HUB_PORT"
RT="http://$HOST:$RT_PORT"
code() { curl -s -o /dev/null -m 4 -w '%{http_code}' "$1" 2>/dev/null; }
body() { curl -s -m 4 "$1" 2>/dev/null; }
jget() { python3 -c "
import sys,json
try: d=json.load(sys.stdin)
except Exception: print(''); raise SystemExit
for k in '$1'.split('.'):
    d = d.get(k) if isinstance(d,dict) else None
    if d is None: print(''); raise SystemExit
print(d)" 2>/dev/null; }

printf '\n%s╔══════════════════════════════════════════════════════╗%s\n' "$CY" "$R"
printf '%s║   DMATICS CYBER ARENA — is the booth working?        ║%s\n' "$CY" "$R"
printf '%s╚══════════════════════════════════════════════════════╝%s\n' "$CY" "$R"
printf '  %schecking %s%s\n' "$DIM" "$HUB" "$R"

# --------------------------------------------------------------------------- #
head2 "1. The four surfaces"
# --------------------------------------------------------------------------- #
if [ "$(code "$HUB/api/health")" = "200" ]; then
  pass "Arena Hub      $HUB"
else
  fail "Arena Hub      $HUB — not answering"
  hint "start it with:  npm start"
  printf '\n  %sNothing else can be checked until the hub is up.%s\n\n' "$DIM" "$R"
  exit 1
fi

if [ "$(code "$HUB/")" = "200" ]; then
  pass "SOC Wall       $HUB/"
else
  fail "SOC Wall       $HUB/ — the hub is up but the wall is not built"
  hint "build it with:  npm start -- --build"
fi

if [ "$(code "$HUB/arcade")" = "200" ]; then
  pass "Cyber Arcade   $HUB/arcade"
else
  fail "Cyber Arcade   $HUB/arcade — not served"
  hint "check dmatics-cyber-arcade-main/public/game.html exists"
fi

RT_UP=0
if [ "$(code "$RT/health")" = "200" ]; then
  pass "Red Team       $RT"
  RT_UP=1
else
  fail "Red Team       $RT — not answering"
  hint "start it with:  ./run-redteam.sh"
fi

# --------------------------------------------------------------------------- #
head2 "2. Do they know about each other?"
# --------------------------------------------------------------------------- #
if [ "$RT_UP" = "1" ]; then
  CONFIGURED="$(body "$RT/health" | jget hub.configured)"
  HUBURL="$(body "$RT/health" | jget hub.url)"
  FAILED="$(body "$RT/health" | jget hub.failed)"
  if [ "$CONFIGURED" = "True" ] || [ "$CONFIGURED" = "true" ]; then
    pass "the red team is pointed at the hub  ${DIM}($HUBURL)${R}"
    if [ -n "$FAILED" ] && [ "$FAILED" != "0" ]; then
      warn "$FAILED event(s) failed to reach the hub — check the address above is reachable from the laptop"
    fi
  else
    fail "the red team has no HUB_URL — nothing it does will appear on the wall"
    hint "set HUB_URL in DMATICS-Red-Team-Challenge-main/.env, then restart it"
  fi
fi

WALLS="$(body "$HUB/api/health" | jget wallClients)"
if [ "${WALLS:-0}" -gt 0 ] 2>/dev/null; then
  pass "$WALLS wall(s) connected and listening"
else
  warn "no wall is connected yet ${DIM}— open $HUB/ on the big screen${R}"
fi

# --------------------------------------------------------------------------- #
head2 "3. Will the reset button work?"
# --------------------------------------------------------------------------- #
# Asked WITHOUT credentials on purpose: the answer tells us how it is configured
# without clearing anything or guessing a password.
PROBE="$(curl -s -m 4 -X POST "$HUB/api/admin/reset" \
         -H 'Content-Type: application/json' -d '{}' 2>/dev/null)"
case "$PROBE" in
  *"Send either"*)
    pass "the hub is configured to accept the arcade's CLEAR EVERY LEADERBOARD button" ;;
  *"Reset is disabled"*)
    fail "reset is disabled — the hub has no ADMIN_TOKEN or ADMIN_USER/ADMIN_PASSWORD"
    hint "run ./setup-env.sh, then restart the hub so it picks the values up" ;;
  *)
    warn "unexpected answer from the reset endpoint: ${PROBE:0:70}" ;;
esac

if [ "$RT_UP" = "1" ]; then
  RTPROBE="$(curl -s -m 4 -X POST "$RT/admin/reset" -H 'X-Admin-Token: probe' 2>/dev/null)"
  case "$RTPROBE" in
    *"bad token"*)      pass "the red team will accept a reset from the hub" ;;
    *"not set"*)        fail "the red team has no ADMIN_TOKEN — the button will not clear its board"
                        hint "add ADMIN_TOKEN to DMATICS-Red-Team-Challenge-main/.env and restart it" ;;
    *)                  warn "unexpected answer from the red team: ${RTPROBE:0:60}" ;;
  esac
fi

# The three files have to agree. Only checkable on the machine itself.
if [ "$HOST" = "127.0.0.1" ] || [ "$HOST" = "localhost" ]; then
  tok() { [ -f "$1" ] && grep -E '^ADMIN_TOKEN=' "$1" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"'"'"' \r'; }
  H="$(tok gisec-hub/.env)"; T="$(tok DMATICS-Red-Team-Challenge-main/.env)"
  A="$(tok dmatics-cyber-arcade-main/.env.local)"
  if [ -z "$H$T$A" ]; then
    fail "no .env files yet"
    hint "run ./setup-env.sh"
  elif [ -n "$H" ] && [ "$H" = "$T" ] && [ "$H" = "$A" ]; then
    pass "ADMIN_TOKEN is identical in all three .env files"
  else
    fail "ADMIN_TOKEN differs between the three .env files"
    hint "the button would clear only part of the show — run ./setup-env.sh --force"
  fi
fi

# --------------------------------------------------------------------------- #
head2 "4. What is on the boards right now"
# --------------------------------------------------------------------------- #
body "$HUB/api/leaderboard" | python3 -c "
import sys, json
try: d = json.load(sys.stdin)
except Exception:
    print('  could not read the arena board'); raise SystemExit
rows = sum(len(v) for v in d.get('boards', {}).values())
t = d.get('totals', {})
if rows:
    for game, entries in d.get('boards', {}).items():
        if entries:
            top = entries[0]
            print(f\"  {game:>8}  {len(entries)} player(s), top {top['n']} on {top['s']}\")
else:
    print('  the arena board is empty — a clean start')
print(f\"  {'':>8}  {t.get('runs',0)} run(s), {t.get('wins',0)} full clear(s), {t.get('busts',0)} contained\")
" 2>/dev/null

if [ "$RT_UP" = "1" ]; then
  N="$(body "$RT/leaderboard/data" | python3 -c "import sys,json;print(len(json.load(sys.stdin)))" 2>/dev/null)"
  printf '  %8s  %s row(s) on the red team station board\n' "redteam" "${N:-?}"
fi

# --------------------------------------------------------------------------- #
head2 "5. Addresses for the other devices"
# --------------------------------------------------------------------------- #
# Two sources, because a stripped-down box may not have iproute2. `hostname -I`
# knows addresses but not interface names, which is why the label can be blank.
lan_lines() {
  if command -v ip >/dev/null 2>&1; then
    ip -o -4 addr show scope global 2>/dev/null | awk '{print $2" "$4}' | sed 's#/[0-9]*##' \
      | grep -vE '^(lo|docker|br-|virbr|veth|tun|tap|zt|wg)'
  else
    hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.' \
      | grep -vE '^(127\.|169\.254\.)' | awk 'NF{print "net "$1}'
  fi
}
if { [ "$HOST" = "127.0.0.1" ] || [ "$HOST" = "localhost" ]; } && [ -n "$(lan_lines)" ]; then
  lan_lines \
    | while read -r iface addr; do
        c="$(curl -s -o /dev/null -m 3 -w '%{http_code}' "http://$addr:$HUB_PORT/api/health" 2>/dev/null)"
        if [ "$c" = "200" ]; then
          printf '  %s✓%s  %shttp://%s:%s/%s   %s(%s)%s\n' "$OK" "$R" "$CY" "$addr" "$HUB_PORT" "$R" "$DIM" "$iface" "$R"
        else
          printf '  %s✗%s  http://%s:%s/   %s(%s — a firewall is probably blocking it)%s\n' "$ERR" "$R" "$addr" "$HUB_PORT" "$DIM" "$iface" "$R"
          FAILS=$((FAILS+1))
        fi
      done
  printf '     %sthe iPad opens the second line + /arcade%s\n' "$DIM" "$R"
  printf '     %sif one is blocked:  ./network-check.sh --fix%s\n' "$DIM" "$R"
else
  printf '  %s(run this on the hub machine to list the LAN addresses)%s\n' "$DIM" "$R"
fi

# --------------------------------------------------------------------------- #
printf '\n'
if [ "$FAILS" -eq 0 ]; then
  printf '%s  Everything a visitor needs is working.%s\n' "$OK" "$R"
  printf '  %sRehearse a full run:  npm run simulate%s\n\n' "$DIM" "$R"
  exit 0
fi
printf '%s  %d thing(s) need attention — see the ✗ lines above.%s\n\n' "$ERR" "$FAILS" "$R"
exit 1
