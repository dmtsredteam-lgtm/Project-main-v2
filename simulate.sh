#!/usr/bin/env bash
# ===========================================================================
#  GISEC 2026 — scripted booth run
# ---------------------------------------------------------------------------
#  Plays a whole red team run against the REAL Flask app — same routes, same
#  session, same heat engine a visitor hits — so you can watch the SOC Wall
#  react without clicking through five stages yourself.
#
#  Put the wall on screen first, then:
#
#      ./simulate.sh              a noisy run: gets caught, then finishes
#      ./simulate.sh --clean      a careful run at human pace: SOC stays quiet
#      ./simulate.sh --bust       fails four passwords and gets contained
#      ./simulate.sh --arcade     just drop some arcade scores on the board
#
#  Runs as LAPTOP-02 by default so it does not collide with a laptop you are
#  driving by hand on LAPTOP-01.
#
#  DMATICS IT Solutions LLC · Dubai
# ===========================================================================
set -uo pipefail

RT="${RT:-http://127.0.0.1:8000}"
HUB="${HUB:-http://127.0.0.1:7788}"
STATION="${STATION:-LAPTOP-02}"
JAR="$(mktemp -t gisec-sim-XXXXXX.cookies)"
trap 'rm -f "$JAR"' EXIT

if [ -t 1 ]; then B=$'\033[1m'; D=$'\033[2m'; R=$'\033[0m'; C=$'\033[36m'; Y=$'\033[33m'; RD=$'\033[31m'; G=$'\033[32m'
else B=""; D=""; R=""; C=""; Y=""; RD=""; G=""; fi

FLAG1='DMATICS{r3c0n_c0mpl3t3}'
FLAG2='DMATICS{w3ak_p@ssw0rd_pwn3d}'
FLAG3='DMATICS{cr3ds_1n_th3_sh@re}'
FLAG4='DMATICS{sh3ll_@cc3ss_g@in3d}'
FLAG5='DMATICS{cr0wn_jewel_5ecur3d}'

MODE="noisy"
case "${1:-}" in
  --clean)  MODE="clean" ;;
  --bust)   MODE="bust" ;;
  --arcade) MODE="arcade" ;;
  -h|--help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  "") ;;
  *) echo "unknown option: $1"; exit 1 ;;
esac

# --- helpers ---------------------------------------------------------------
get()  { curl -sS -b "$JAR" -c "$JAR" "$RT$1"; }
post() { curl -sS -b "$JAR" -c "$JAR" -X POST --data-urlencode "$2" "$RT$1"; }
# Read one top-level key out of a JSON body on stdin. The first version of this
# built a Python expression by string concatenation and ran it through eval() —
# in a repository about not doing that. A key lookup is all it ever needed.
pjson(){ python3 -c 'import sys,json
try: print(json.load(sys.stdin).get(sys.argv[1], "?"))
except Exception: print("?")' "$1" 2>/dev/null || echo "?"; }

FAILURES=0

step() { printf '\n%s▸ %s%s\n' "$B" "$*" "$R"; }
info() { printf '   %s%s%s\n' "$D" "$*" "$R"; }

# Prints the SOC's current read on the session, coloured by posture.
soc() {
  local s heat posture left
  s="$(get /soc/state)"
  heat="$(printf '%s' "$s" | pjson heat)"
  posture="$(printf '%s' "$s" | pjson posture)"
  left="$(printf '%s' "$s" | pjson throttleLeft)"
  local col="$G"
  case "$posture" in WATCHED) col="$Y" ;; THROTTLED|CONTAINED) col="$RD" ;; esac
  printf '   heat %s%5s%s   %s%-10s%s' "$col" "$heat" "$R" "$col" "$posture" "$R"
  [ "$left" != "0" ] && printf '  held %ss' "$left"
  printf '\n'
}

wait_out_hold() {
  local left
  left="$(get /soc/state | pjson throttleLeft)"
  [ "$left" = "0" ] || [ "$left" = "?" ] && return 0
  info "SOC is holding the session — waiting ${left}s"
  sleep "$((left + 1))"
}

# One nested lookup: response.action, which is null unless the SOC reacted.
pjson_action(){ python3 -c 'import sys,json
try:
    d = json.load(sys.stdin)
    r = d.get("response") or {}
    print(r.get("action") or "None")
except Exception: print("?")' 2>/dev/null || echo "?"; }

flag() {
  wait_out_hold
  local out act ok
  out="$(post /submit "flag=$1")"
  ok="$(printf '%s' "$out" | pjson ok)"
  if [ "$ok" != "True" ]; then
    # Fire-and-forget printed a capture line whatever came back, so a rehearsal
    # against a broken build looked like a clean run all the way to the end.
    printf '   %sNOT captured%s %s — %s\n' "$RD" "$R" "$2" "$(printf '%s' "$out" | pjson msg)"
    FAILURES=$((FAILURES + 1))
    soc
    return 0
  fi
  act="$(printf '%s' "$out" | pjson_action)"
  printf '   captured %s%s%s   total %s pts' "$C" "$2" "$R" "$(printf '%s' "$out" | pjson points)"
  if [ "$act" != "None" ] && [ "$act" != "?" ]; then
    printf '   → SOC: %s%s%s' "$RD" "$act" "$R"
  fi
  printf '\n'
  soc
}

banner() {
  printf '\n%s╔══════════════════════════════════════════════════════╗%s\n' "$C" "$R"
  printf '%s║  SCRIPTED RUN · %-36s ║%s\n' "$C" "$1" "$R"
  printf '%s╚══════════════════════════════════════════════════════╝%s\n' "$C" "$R"
}

# --- preflight -------------------------------------------------------------
curl -fsS -m 2 "$HUB/api/health" >/dev/null 2>&1 || {
  echo "Arena Hub is not answering at $HUB — start it with ./run-local.sh"; exit 1; }
curl -fsS -m 2 "$RT/health" >/dev/null 2>&1 || {
  echo "Red Team app is not answering at $RT — start it with ./run-local.sh"; exit 1; }

# --- arcade only -----------------------------------------------------------
if [ "$MODE" = "arcade" ]; then
  banner "ARCADE SCORES"
  i=0
  # name:game:score — a believable morning at the tablet
  for row in "AMIRA:phish:2480" "RASHID:soc:2310" "LENA:breach:1970" \
             "OMAR:phish:1640" "JEFF:breach:2240" "PRIYA:soc:1880" \
             "KHALID:phish:990" "JEFF:soc:1520"; do
    IFS=: read -r who game pts <<< "$row"
    curl -sS -X POST "$HUB/api/scores" -H 'Content-Type: application/json' \
      -d "{\"game\":\"$game\",\"player\":\"$who\",\"points\":$pts,\"station\":\"ARCADE-IPAD\",\"meta\":{\"accuracy\":88,\"seconds\":60,\"finished\":true}}" >/dev/null
    curl -sS -X POST "$HUB/api/events" -H 'Content-Type: application/json' \
      -d "{\"source\":\"arcade\",\"kind\":\"arcade_score\",\"station\":\"ARCADE-IPAD\",\"player\":\"$who\",\"game\":\"$game\",\"points\":$pts,\"detail\":\"$who scored $pts at the visitor tablet.\"}" >/dev/null
    printf '   %-8s %-7s %5s\n' "$who" "$game" "$pts"
    i=$((i+1)); sleep 1.2
  done
  printf '\n%s✓%s %s scores on the board — check the arena panel.\n\n' "$G" "$R" "$i"
  exit 0
fi

# --- the run ---------------------------------------------------------------
PLAYER="SIM-$(date +%H%M%S)"
case "$MODE" in
  # A human spends 30-90s per stage reading, copying flags and typing. The
  # careful pace mimics that, which is the only way to show the SOC leaving a
  # tidy operator alone - at any faster pace heat outruns the decay and the
  # throttles fire, which is the mechanic working, not a bug.
  clean) banner "CAREFUL OPERATOR · ~3 min"; PACE=14 ;;
  bust)  banner "GETS CONTAINED";   PACE=1 ;;
  *)     banner "NOISY OPERATOR";   PACE=2 ;;
esac
info "operator $PLAYER at $STATION"

step "Registering"
curl -sS -b "$JAR" -c "$JAR" -X POST --data-urlencode "player=$PLAYER" \
  "$RT/?station=$STATION" -o /dev/null
soc

step "Stage 1 · Reconnaissance"
get "/portal" >/dev/null;            sleep "$PACE"
get "/portal/directory" >/dev/null;  sleep "$PACE"
soc
flag "$FLAG1" FLAG-1

step "Stage 2 · Credential Access"
if [ "$MODE" = "bust" ]; then
  # Each attempt has to actually LAND, so the hold is waited out first. A
  # throttled attempt is refused before it reaches the portal and does not count
  # against the four - which is the mechanic working: the SOC slowing an attacker
  # down is itself a defence, and it is worth watching happen.
  for n in 1 2 3 4; do
    wait_out_hold
    curl -sS -b "$JAR" -c "$JAR" -X POST \
      --data-urlencode "username=john.smith" --data-urlencode "password=wrong$n" \
      "$RT/portal/login" -o /dev/null
    printf '   %sbad password %s of 4%s\n' "$Y" "$n" "$R"
    soc
    [ "$(get /soc/state | pjson posture)" = "CONTAINED" ] && break
    sleep 1
  done
  if [ "$(get /soc/state | pjson posture)" = "CONTAINED" ]; then
    printf '\n%s✗%s Contained. Check the wall: containment band, station goes red.\n\n' "$RD" "$R"
  else
    printf '\n%s!%s Survived four attempts — the throttles ate two of them.\n\n' "$Y" "$R"
  fi
  curl -sS -b "$JAR" "$RT/finish" -o /dev/null
  exit 0
fi

if [ "$MODE" = "noisy" ]; then
  for n in 1 2; do
    wait_out_hold
    curl -sS -b "$JAR" -c "$JAR" -X POST \
      --data-urlencode "username=john.smith" --data-urlencode "password=wrong$n" \
      "$RT/portal/login" -o /dev/null
    printf '   %sbad password %s%s\n' "$Y" "$n" "$R"
    soc
    sleep 2
  done
fi

wait_out_hold
curl -sS -b "$JAR" -c "$JAR" -X POST \
  --data-urlencode "username=john.smith" --data-urlencode "password=Summer2026" \
  "$RT/portal/login" -o /dev/null
info "logged in as john.smith"
soc
flag "$FLAG2" FLAG-2

step "Stage 3 · Lateral Movement"
sleep "$PACE"
get "/dashboard/share" >/dev/null
info "browsing the internal share"
sleep "$PACE"
get "/files/passwords.txt" >/dev/null
info "looted passwords.txt"
soc
flag "$FLAG3" FLAG-3

step "Stage 4 · Foothold"
sleep "$PACE"
wait_out_hold
curl -sS -b "$JAR" -c "$JAR" -X POST \
  --data-urlencode "username=svc_backup" --data-urlencode "password=Backup@2026!" \
  "$RT/console/auth" -o /dev/null
info "shell on aegis-web01 as svc_backup"
for cmd in "whoami" "ls -la" "cat notes.txt" "cat flag.txt"; do
  wait_out_hold
  curl -sS -b "$JAR" -c "$JAR" -X POST -H 'Content-Type: application/json' \
    -d "{\"cmd\":\"$cmd\"}" "$RT/console/exec" -o /dev/null
  printf '   $ %s\n' "$cmd"
  sleep "$(( PACE / 3 + 1 ))"
done
soc
flag "$FLAG4" FLAG-4

step "Stage 5 · Exfiltration"
sleep "$PACE"
wait_out_hold
curl -sS -b "$JAR" -c "$JAR" -X POST -H 'Content-Type: application/json' \
  -d '{"cmd":"find / -name '"'"'*secret*'"'"'"}' "$RT/console/exec" -o /dev/null
info "located the vault file"
sleep 2
wait_out_hold
# Read it, not just find it — the game requires the act, not the knowledge.
curl -sS -b "$JAR" -c "$JAR" -X POST -H 'Content-Type: application/json' \
  -d '{"cmd":"cat /home/svc_backup/.secret_vault/final_flag.txt"}' "$RT/console/exec" -o /dev/null
info "read the crown jewel — this one is loud"
soc
flag "$FLAG5" FLAG-5

if [ "$FAILURES" -gt 0 ]; then
  printf '\n%s✗%s %s step(s) did not land — %s did NOT fully compromise.\n' "$RD" "$R" "$FAILURES" "$PLAYER"
  printf '   %sScroll up to the first red line; that is where the run broke.%s\n\n' "$D" "$R"
  exit 1
fi
printf '\n%s✓%s Full compromise. %s is on the RED OPS board.\n' "$G" "$R" "$PLAYER"
printf '   %sWall: check the arena panel and the operation card.%s\n\n' "$D" "$R"
