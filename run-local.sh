#!/usr/bin/env bash
# ===========================================================================
#  GISEC 2026 — DMATICS Arena · local test rig
# ---------------------------------------------------------------------------
#  Brings the whole booth up on ONE machine so you can see the three screens
#  talk to each other before any of it goes near the show floor.
#
#      ./run-local.sh              start everything
#      ./run-local.sh --open       start, then open the browser tabs
#      ./run-local.sh --reset      wipe local scores first
#      ./run-local.sh --stop       stop anything left running
#
#  Two processes, no Docker, no npm build:
#
#      Arena Hub   :7788   also serves the SOC Wall and the arcade
#      Red Team    :8000   Flask, run straight (no container)
#
#  Ctrl-C stops both. Logs land in ./logs/.
#
#  DMATICS IT Solutions LLC · Dubai
# ===========================================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

HUB_PORT="${HUB_PORT:-7788}"
RT_PORT="${RT_PORT:-8000}"

# The address other devices reach this machine on.
#
# Both services bind 0.0.0.0, so the iPad, the laptops and the big screen can
# all be separate boxes — but the address baked into the pages has to be the LAN
# one. Handing a laptop "127.0.0.1" points its browser at itself, the SOC stream
# never connects, and nothing that laptop does reaches the wall.
#
# Picking that address is where this usually goes wrong, so rather than guessing
# once, every candidate is collected and the banner prints all of them. Docker,
# libvirt, VPN and loopback interfaces are excluded — they are reachable from
# this machine and nowhere else, and handing one to an iPad looks exactly like
# "the IP does not work".
#
# Override with LAN_IP=... to pin one.
lan_candidates() {
  local out=""
  if command -v ip >/dev/null 2>&1; then
    out="$(ip -o -4 addr show scope global 2>/dev/null \
      | awk '{print $2" "$4}' | sed 's#/[0-9]*##' \
      | grep -vE '^(lo|docker|br-|virbr|veth|tun|tap|zt|wg)')"
  fi
  if [ -z "$out" ] && command -v ifconfig >/dev/null 2>&1; then
    out="$(ifconfig 2>/dev/null | awk '/^[a-z]/{i=$1; sub(":","",i)} /inet /{print i" "$2}' \
      | grep -vE '^(lo|docker|br-|virbr|veth|tun|tap)')"
  fi
  if [ -z "$out" ]; then
    out="$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.' \
      | grep -vE '^(127\.|169\.254\.|172\.1[7-9]\.|172\.2[0-9]\.|172\.3[0-1]\.)' \
      | awk 'NF{print "net "$1}')"
  fi
  printf '%s\n' "$out" | awk 'NF'
}


# The interface carrying the default route is the one the rest of the network
# is on, so it wins when there is a choice.
preferred_lan_ip() {
  local ip
  ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") {print $(i+1); exit}}')"
  if [ -n "$ip" ] && lan_candidates | awk '{print $2}' | grep -qx "$ip"; then
    printf '%s' "$ip"; return
  fi
  ip="$(lan_candidates | awk 'NR==1{print $2}')"
  [ -z "$ip" ] && ip="127.0.0.1"
  printf '%s' "$ip"
}
LAN_IP="${LAN_IP:-$(preferred_lan_ip)}"

LOCAL_HUB="http://127.0.0.1:${HUB_PORT}"     # health checks, always available
HUB_URL="http://${LAN_IP}:${HUB_PORT}"       # what browsers on the network use

LOGS="$ROOT/logs"
VENV="$ROOT/.venv"
WALL_DIST="$ROOT/soc-wall-main/dist"
ARCADE_DIR="$ROOT/dmatics-cyber-arcade-main/public"
RT_DIR="$ROOT/DMATICS-Red-Team-Challenge-main"

# --- pretty ---------------------------------------------------------------
if [ -t 1 ]; then
  B=$'\033[1m'; DIM=$'\033[2m'; R=$'\033[0m'
  OK=$'\033[32m'; WARN=$'\033[33m'; ERR=$'\033[31m'; CY=$'\033[36m'
else
  B=""; DIM=""; R=""; OK=""; WARN=""; ERR=""; CY=""
fi
say()  { printf '%s\n' "$*"; }
good() { printf '  %s✓%s %s\n' "$OK" "$R" "$*"; }
warn() { printf '  %s!%s %s\n' "$WARN" "$R" "$*"; }
bad()  { printf '  %s✗%s %s\n' "$ERR" "$R" "$*"; }
head2(){ printf '\n%s%s%s\n' "$B" "$*" "$R"; }

# A QR code beats typing an address into an iPad, and at a stand it is how you
# hand the wall to someone in two seconds. qrencode is a one-line install and
# the URL is printed either way, so its absence costs nothing.
show_qr() {
  local url="$1"
  if command -v qrencode >/dev/null 2>&1; then
    printf '\n'
    qrencode -t ANSIUTF8 -m 2 "$url" 2>/dev/null | sed 's/^/  /'
    printf '  %sScan this with the phone or iPad%s\n' "$DIM" "$R"
  else
    printf '\n  %sTip: sudo apt install -y qrencode  — then this prints a QR code\n  you can scan instead of typing the address.%s\n' "$DIM" "$R"
  fi
}


# --- stop -----------------------------------------------------------------
stop_all() {
  local killed=0
  for f in "$LOGS/hub.pid" "$LOGS/redteam.pid"; do
    [ -f "$f" ] || continue
    local pid; pid="$(cat "$f" 2>/dev/null || true)"
    if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null && killed=1
      # give it a moment, then insist
      for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || break; sleep .2; done
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$f"
  done
  [ "$killed" = 1 ] && good "stopped" || true
}

if [ "${1:-}" = "--stop" ]; then
  head2 "Stopping the arena"
  stop_all
  say ""
  exit 0
fi

OPEN_BROWSER=0
RESET=0
for arg in "$@"; do
  case "$arg" in
    --open)  OPEN_BROWSER=1 ;;
    --reset) RESET=1 ;;
    --stop)  ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) bad "unknown option: $arg"; exit 1 ;;
  esac
done

printf '\n%s╔══════════════════════════════════════════════════════╗%s\n' "$CY" "$R"
printf '%s║   GISEC 2026 · DMATICS ARENA — local test rig        ║%s\n' "$CY" "$R"
printf '%s╚══════════════════════════════════════════════════════╝%s\n' "$CY" "$R"

# --- preflight ------------------------------------------------------------
head2 "Preflight"
FAIL=0

if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$NODE_MAJOR" -ge 18 ] 2>/dev/null; then
    good "node $(node --version)"
  else
    bad "node $(node --version) — the hub needs 18 or newer"
    say "    ${DIM}sudo apt install -y nodejs${R}"
    FAIL=1
  fi
else
  bad "node not installed"
  say "    ${DIM}sudo apt update && sudo apt install -y nodejs${R}"
  FAIL=1
fi

if command -v python3 >/dev/null 2>&1; then
  good "python3 $(python3 --version 2>&1 | cut -d' ' -f2)"
else
  bad "python3 not installed  →  ${DIM}sudo apt install -y python3 python3-venv${R}"
  FAIL=1
fi

[ -f "$WALL_DIST/index.html" ] \
  && good "SOC Wall build present" \
  || { bad "soc-wall-main/dist is missing — see 'Rebuilding the wall' at the bottom of this script"; FAIL=1; }

[ -f "$ARCADE_DIR/game.html" ] && good "arcade game.html present" || { bad "arcade game.html missing"; FAIL=1; }
[ -f "$RT_DIR/app.py" ]       && good "red team app.py present"   || { bad "red team app.py missing"; FAIL=1; }

for p in "$HUB_PORT" "$RT_PORT"; do
  if (command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -q ":$p ") \
  || (command -v lsof >/dev/null 2>&1 && lsof -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1); then
    warn "port $p is already in use — run ./run-local.sh --stop, or free it"
  fi
done

[ "$FAIL" = 1 ] && { say ""; bad "fix the above and run again"; say ""; exit 1; }

# --- python env -----------------------------------------------------------
head2 "Python environment"
if [ ! -x "$VENV/bin/python" ]; then
  say "  creating .venv ${DIM}(one time)${R}"
  python3 -m venv "$VENV" 2>/dev/null || {
    bad "could not create a virtualenv"
    say "    ${DIM}sudo apt install -y python3-venv${R}"
    exit 1
  }
fi
if ! "$VENV/bin/python" -c "import flask" 2>/dev/null; then
  say "  installing Flask ${DIM}(one time — needs internet)${R}"
  "$VENV/bin/pip" install --quiet --disable-pip-version-check flask || {
    bad "Flask install failed. Offline? Try: ${DIM}sudo apt install -y python3-flask${R}"
    say "    ${DIM}then re-run with:  VENV_PYTHON=/usr/bin/python3 ./run-local.sh${R}"
    exit 1
  }
fi
PY="${VENV_PYTHON:-$VENV/bin/python}"
good "flask $("$PY" -c 'import flask,sys; sys.stdout.write(flask.__version__ if hasattr(flask,"__version__") else "ok")' 2>/dev/null || echo ok)"

# --- start ----------------------------------------------------------------
mkdir -p "$LOGS" "$RT_DIR/data" "$ROOT/gisec-hub/data"
stop_all

if [ "$RESET" = 1 ]; then
  rm -f "$ROOT/gisec-hub/data/arena.json" "$RT_DIR/data/leaderboard.db"
  good "local scores cleared"
fi

# The session key. There used to be a literal here — "local-test-only-not-for-
# the-show" — which is exactly the kind of string that survives a copy onto the
# booth laptop and signs the cookies at a security trade show. Order of
# preference: the operator's .env, then the environment, then a fresh random key
# for this launch. A per-launch key means restarting the script logs players out,
# which is the correct trade for never having a guessable one.
if [ -f "$RT_DIR/.env" ]; then
  # shellcheck disable=SC2046
  RT_SECRET=$(grep -E '^SECRET_KEY=' "$RT_DIR/.env" | tail -1 | cut -d= -f2- | tr -d '"'"'"' \r')
fi
RT_SECRET="${RT_SECRET:-${SECRET_KEY:-}}"
if [ -z "$RT_SECRET" ]; then
  RT_SECRET=$("$PY" -c 'import secrets;print(secrets.token_hex(32))' 2>/dev/null) \
    || RT_SECRET=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
  warn "no SECRET_KEY in $RT_DIR/.env — generated one for this launch only"
fi

head2 "Starting services"

[ -f "$ROOT/gisec-hub/.env" ] && { set -a; . "$ROOT/gisec-hub/.env"; set +a; }
WALL_DIR="$WALL_DIST" ARCADE_DIR="$ARCADE_DIR" PORT="$HUB_PORT" \
  node "$ROOT/gisec-hub/server.js" > "$LOGS/hub.log" 2>&1 &
echo $! > "$LOGS/hub.pid"

# Wait for the hub to actually answer rather than sleeping and hoping.
for i in $(seq 1 40); do
  if curl -fsS -m 1 "$LOCAL_HUB/api/health" >/dev/null 2>&1; then break; fi
  sleep .25
done
if curl -fsS -m 2 "$LOCAL_HUB/api/health" >/dev/null 2>&1; then
  good "Arena Hub    $HUB_URL"
else
  bad "hub did not start — see logs/hub.log"; tail -5 "$LOGS/hub.log"; stop_all; exit 1
fi

cd "$RT_DIR"
HUB_URL="$HUB_URL" \
STATION_ID="LAPTOP-01" \
DB_PATH="$RT_DIR/data/leaderboard.db" \
SECRET_KEY="$RT_SECRET" \
PORT="$RT_PORT" \
GAME_SECONDS="${GAME_SECONDS:-600}" \
HEAT_DECAY="${HEAT_DECAY:-0.9}" \
HEAT_WATCH="${HEAT_WATCH:-34}" \
HEAT_THROTTLE="${HEAT_THROTTLE:-62}" \
HEAT_CONTAIN="${HEAT_CONTAIN:-96}" \
THROTTLE_SECONDS="${THROTTLE_SECONDS:-12}" \
  "$PY" app.py > "$LOGS/redteam.log" 2>&1 &
echo $! > "$LOGS/redteam.pid"
cd "$ROOT"

for i in $(seq 1 40); do
  if curl -fsS -m 1 "http://127.0.0.1:$RT_PORT/health" >/dev/null 2>&1; then break; fi
  sleep .25
done
if curl -fsS -m 2 "http://127.0.0.1:$RT_PORT/health" >/dev/null 2>&1; then
  good "Red Team     http://127.0.0.1:$RT_PORT"
else
  bad "red team app did not start — see logs/redteam.log"; tail -8 "$LOGS/redteam.log"; stop_all; exit 1
fi

# --- where to look --------------------------------------------------------
cat <<EOF

${B}Open these — from any device on the same network${R}

  ${CY}SOC WALL${R}      $HUB_URL/
                ${DIM}the big screen — press F11 for fullscreen${R}

  ${CY}LAPTOP 01${R}     http://${LAN_IP}:$RT_PORT/?station=LAPTOP-01
  ${CY}LAPTOP 02${R}     http://${LAN_IP}:$RT_PORT/?station=LAPTOP-02
                ${DIM}two separate machines, or two browsers on one — they need
                separate cookies to appear as two operators${R}

  ${CY}ARCADE${R}        $HUB_URL/arcade
                ${DIM}the iPad — add to Home Screen for fullscreen${R}

  ${DIM}This machine's addresses — if the one above does not work from another
  device, try the others:${R}
$(lan_candidates | awk -v c="$CY" -v r="$R" -v d="$DIM" '{printf "    %s%-16s%s %s%s%s\n", c, $2, r, d, $1, r}')
    ${CY}127.0.0.1${R}        ${DIM}this machine only${R}

  ${DIM}Cannot reach it from another device? Run ${R}${CY}./network-check.sh${R}${DIM} — it
  checks the bind addresses, the firewall and whether this box is behind
  VM NAT, and tells you which one is the problem.${R}

${B}What to try${R}

  1. Put the SOC WALL on one side of the screen and LAPTOP 02 on the other.
  2. Register a handle, open Stage 1, view source, submit FLAG-1.
     ${DIM}Watch an arc land on the globe and the AI panel narrate it.${R}
  3. Go to Stage 2 and get the password wrong two or three times.
     ${DIM}Heat meter climbs in the nav. At 62 the wall flashes SOC RESPONSE,
     and ~2s later the laptop is held for 12 seconds.${R}
  4. Play a round of the arcade and save a score.
     ${DIM}It lands on the wall's arena board — wait for the rotation, or
     click the tab.${R}

${B}Handy${R}

  ./simulate.sh              drive a scripted run, no clicking
  ./run-local.sh --reset     start again with empty boards
  ./run-local.sh --stop      stop everything
  LAN_IP=10.0.0.5 ./run-local.sh   pin the address on a multi-homed box
  tail -f logs/hub.log       watch the hub
  curl -s $LOCAL_HUB/api/health | python3 -m json.tool

EOF

show_qr "$HUB_URL/"

if [ "$OPEN_BROWSER" = 1 ] && command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$HUB_URL/" >/dev/null 2>&1 &
  sleep 1
  xdg-open "http://${LAN_IP}:$RT_PORT/?station=LAPTOP-02" >/dev/null 2>&1 &
fi

printf '%s' "${DIM}Running. Ctrl-C to stop both.${R}"
say ""

trap 'say ""; head2 "Shutting down"; stop_all; say ""; exit 0' INT TERM

# Sit here so Ctrl-C reaches the trap, and notice if a child dies on its own.
while true; do
  sleep 2
  for name in hub redteam; do
    pid="$(cat "$LOGS/$name.pid" 2>/dev/null || true)"
    if [ -n "${pid:-}" ] && ! kill -0 "$pid" 2>/dev/null; then
      say ""
      bad "$name stopped unexpectedly — last lines of logs/$name.log:"
      tail -12 "$LOGS/$name.log" | sed 's/^/    /'
      stop_all
      exit 1
    fi
  done
done

# ===========================================================================
#  Rebuilding the wall
#
#  soc-wall-main/dist is committed pre-built so this rig needs no toolchain.
#  If you change anything under soc-wall-main/{js,css,index.html} you need to
#  rebuild it — that step needs Node 22.13+ and internet:
#
#      cd soc-wall-main
#      npm install
#      npx vite build --sourcemap false
#
#  Kali's packaged node is often too old for Vite 8. If `npm run build`
#  complains about the Node version:
#
#      curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
#      exec $SHELL
#      nvm install 22
#
#  The hub itself only needs Node 18, so the rig runs fine on stock Kali —
#  it is only the wall BUILD that wants something newer.
# ===========================================================================
