#!/usr/bin/env bash
#
# Create the three .env files, once, with secrets that agree with each other.
#
# This exists because the one genuinely error-prone step in setting the booth up
# is that ADMIN_TOKEN has to be the SAME string in three separate files. Get it
# wrong and everything looks fine until someone presses CLEAR EVERY LEADERBOARD
# at the end of day one and only part of the show resets.
#
#   ./setup-env.sh                  create anything missing, leave the rest alone
#   ./setup-env.sh --show           print what is currently set (secrets masked)
#   ./setup-env.sh --force          regenerate everything (invalidates live sessions)
#
# Nothing here is committed: .gitignore keeps all three out of git, and
# push-to-github.sh refuses to push if one of them is not ignored.
#
# DMATICS IT Solutions LLC · GISEC 2026
set -uo pipefail
cd "$(dirname "$0")"

if [ -t 1 ]; then
  B=$'\033[1m'; DIM=$'\033[2m'; R=$'\033[0m'
  OK=$'\033[32m'; WARN=$'\033[33m'; ERR=$'\033[31m'; CY=$'\033[36m'
else B=""; DIM=""; R=""; OK=""; WARN=""; ERR=""; CY=""; fi
good() { printf '  %s✓%s %s\n' "$OK" "$R" "$*"; }
warn() { printf '  %s!%s %s\n' "$WARN" "$R" "$*"; }
bad()  { printf '  %s✗%s %s\n' "$ERR" "$R" "$*"; }
head2(){ printf '\n%s%s%s\n' "$B" "$*" "$R"; }

HUB_ENV="gisec-hub/.env"
RT_ENV="DMATICS-Red-Team-Challenge-main/.env"
ARCADE_ENV="dmatics-cyber-arcade-main/.env.local"

MODE="create"
case "${1:-}" in
  --show)  MODE="show" ;;
  --force) MODE="force" ;;
  -h|--help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  "") ;;
  *) echo "unknown option: $1  (--show, --force)"; exit 1 ;;
esac

# --- what address will the other machines use? -------------------------------
# The hub, the challenge and the arcade all talk to each other. On one machine
# 127.0.0.1 is right. Across two laptops and an iPad they need this machine's
# LAN address, which is what the tablets will also type into a browser.
lan_ip() {
  local ip=""
  if command -v ip >/dev/null 2>&1; then
    ip="$(ip -o -4 addr show scope global 2>/dev/null \
      | awk '{print $2" "$4}' | sed 's#/[0-9]*##' \
      | grep -vE '^(lo|docker|br-|virbr|veth|tun|tap|zt|wg)' \
      | sort -k1 | awk 'NR==1{print $2}')"
  fi
  [ -z "$ip" ] && ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  printf '%s' "${ip:-127.0.0.1}"
}

secret() {
  # 1: how many bytes. python3 first, openssl second, /dev/urandom last —
  # at least one of the three is on any machine this will run on.
  python3 -c "import secrets;print(secrets.token_hex($1))" 2>/dev/null \
    || openssl rand -hex "$1" 2>/dev/null \
    || head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'
}

read_var() {   # read_var FILE NAME  -> prints the value, or nothing
  [ -f "$1" ] || return 0
  grep -E "^$2=" "$1" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"'"'"' \r'
}

mask() {
  local v="$1"
  [ -z "$v" ] && { printf '%s(not set)%s' "$DIM" "$R"; return; }
  [ "${#v}" -le 8 ] && { printf '%s' "********"; return; }
  printf '%s…%s %s(%d chars)%s' "${v:0:6}" "${v: -4}" "$DIM" "${#v}" "$R"
}

# --------------------------------------------------------------------------- #
#  --show
# --------------------------------------------------------------------------- #
if [ "$MODE" = "show" ]; then
  head2 "Current configuration"
  for pair in "$HUB_ENV|hub" "$RT_ENV|red team" "$ARCADE_ENV|arcade"; do
    f="${pair%%|*}"; label="${pair##*|}"
    if [ -f "$f" ]; then good "$label   $f"; else bad "$label   $f  — not created"; fi
  done

  head2 "Secrets"
  printf '  %-16s %s\n' "SECRET_KEY"     "$(mask "$(read_var "$RT_ENV" SECRET_KEY)")"
  printf '  %-16s %s\n' "ADMIN_PASSWORD" "$(mask "$(read_var "$ARCADE_ENV" ADMIN_PASSWORD)")"

  head2 "ADMIN_TOKEN — must be identical in all three"
  h="$(read_var "$HUB_ENV" ADMIN_TOKEN)"
  r="$(read_var "$RT_ENV" ADMIN_TOKEN)"
  a="$(read_var "$ARCADE_ENV" ADMIN_TOKEN)"
  printf '  %-12s %s\n' "hub"      "$(mask "$h")"
  printf '  %-12s %s\n' "red team" "$(mask "$r")"
  printf '  %-12s %s\n' "arcade"   "$(mask "$a")"
  if [ -n "$h" ] && [ "$h" = "$r" ] && [ "$h" = "$a" ]; then
    good "all three agree"
  else
    bad "they do NOT all agree — the CLEAR EVERY LEADERBOARD button will only clear part of the show"
    printf '     %sRun ./setup-env.sh --force to regenerate them together.%s\n' "$DIM" "$R"
  fi

  head2 "Addresses"
  printf '  %-12s %s\n' "hub"      "$(read_var "$ARCADE_ENV" GISEC_HUB)"
  printf '  %-12s %s\n' "red team" "$(read_var "$ARCADE_ENV" REDTEAM_URL)"
  printf '\n'
  exit 0
fi

# --------------------------------------------------------------------------- #
#  create / force
# --------------------------------------------------------------------------- #
IP="$(lan_ip)"
head2 "DMATICS Cyber Arena — one-time setup"
printf '  This machine looks like %s%s%s on the network.\n' "$CY" "$IP" "$R"
printf '  %sThe iPad and the second laptop will use that address.%s\n' "$DIM" "$R"

EXISTING=""
for f in "$HUB_ENV" "$RT_ENV" "$ARCADE_ENV"; do [ -f "$f" ] && EXISTING="$EXISTING $f"; done

if [ -n "$EXISTING" ] && [ "$MODE" != "force" ]; then
  head2 "Already set up"
  for f in $EXISTING; do good "$f exists — leaving it alone"; done
  printf '\n  %sTo see what is in them:      ./setup-env.sh --show%s\n' "$DIM" "$R"
  printf '  %sTo start over from scratch:  ./setup-env.sh --force%s\n\n' "$DIM" "$R"
  exit 0
fi

if [ "$MODE" = "force" ] && [ -n "$EXISTING" ]; then
  head2 "Regenerating"
  warn "New secrets invalidate any run in progress and log every player out."
  printf '  Continue? [y/N] '
  read -r reply
  case "$reply" in y|Y|yes|YES) ;; *) printf '\n  Nothing changed.\n\n'; exit 0 ;; esac
  STAMP="$(date +%Y%m%d-%H%M%S)"
  for f in $EXISTING; do cp "$f" "$f.$STAMP.bak" && good "backed up $f"; done
fi

SECRET_KEY="$(secret 32)"
ADMIN_TOKEN="$(secret 24)"
ADMIN_PASSWORD="$(secret 9)"

head2 "Writing"

mkdir -p gisec-hub DMATICS-Red-Team-Challenge-main dmatics-cyber-arcade-main

cat > "$HUB_ENV" <<EOF
# GISEC Arena Hub — generated by setup-env.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)
# Not committed. Do not paste this file anywhere.

PORT=7788

# Wipes the arena board. No default: unset, /api/admin/reset refuses.
# MUST match ADMIN_TOKEN in the other two files.
ADMIN_TOKEN=$ADMIN_TOKEN

# What the crew types into the arcade's CLEAR EVERY LEADERBOARD panel. Needed
# here because at the booth the iPad opens http://$IP:7788/arcade, which the hub
# serves as a static file — so the button's request arrives at the hub, not at a
# Next.js API.
ADMIN_USER=booth
ADMIN_PASSWORD=$ADMIN_PASSWORD

# So the hub can clear the red team's board as well as its own.
REDTEAM_URL=http://$IP:8000
EOF
good "$HUB_ENV"

cat > "$RT_ENV" <<EOF
# DMATICS Red Team Challenge — generated by setup-env.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)
# Not committed. Do not paste this file anywhere.

# Signs the session cookie that holds a player's whole run. Two workers with
# different keys reject each other's cookies and a run resets mid-attempt.
SECRET_KEY=$SECRET_KEY

PORT=8000
STATION_ID=LAPTOP-01
STATIONS=LAPTOP-01,LAPTOP-02

# Where the SOC wall gets its live telemetry. Blank = the challenge runs exactly
# as it always has, with nothing appearing on the big screen.
HUB_URL=http://$IP:7788

# Enables POST /admin/reset. MUST match ADMIN_TOKEN in the other two files.
ADMIN_TOKEN=$ADMIN_TOKEN

# --- round length and SOC tuning (safe to change on the day) ----------------
GAME_SECONDS=600       # length of a run
HEAT_DECAY=0.9         # heat shed per second while the player is careful
HEAT_WATCH=34          # "the SOC has noticed you"
HEAT_THROTTLE=62       # session held for inspection
HEAT_CONTAIN=96        # run over
THROTTLE_SECONDS=12    # length of a hold
THROTTLE_LIMIT=3       # holds before the SOC stops holding and contains
THROTTLE_FORGIVE=90    # seconds of clean play that take one strike back
EOF
good "$RT_ENV"

cat > "$ARCADE_ENV" <<EOF
# DMATICS Cyber Arcade — generated by setup-env.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)
# Not committed. Do not paste this file anywhere.
#
# Only read when the arcade runs on its OWN Next.js server (npm start, or
# Vercel). When the hub serves the arcade at http://$IP:7788/arcade the button
# talks to the hub instead, using the matching values in gisec-hub/.env.

ADMIN_USER=booth
ADMIN_PASSWORD=$ADMIN_PASSWORD

# MUST match ADMIN_TOKEN in the other two files.
ADMIN_TOKEN=$ADMIN_TOKEN

GISEC_HUB=http://$IP:7788
REDTEAM_URL=http://$IP:8000

# Bakes the hub address into a build so tablets do not need ?hub= on the URL.
NEXT_PUBLIC_GISEC_HUB=http://$IP:7788
EOF
good "$ARCADE_ENV"

# --- prove they agree, rather than asserting it ------------------------------
head2 "Checking"
h="$(read_var "$HUB_ENV" ADMIN_TOKEN)"
r="$(read_var "$RT_ENV" ADMIN_TOKEN)"
a="$(read_var "$ARCADE_ENV" ADMIN_TOKEN)"
if [ -n "$h" ] && [ "$h" = "$r" ] && [ "$h" = "$a" ]; then
  good "ADMIN_TOKEN is identical in all three files"
else
  bad "ADMIN_TOKEN does not match across the three files — this is a bug in this script"
  exit 1
fi
if [ -d .git ]; then
  for f in "$HUB_ENV" "$RT_ENV" "$ARCADE_ENV"; do
    git check-ignore -q "$f" || warn "$f is NOT in .gitignore — do not push until it is"
  done
  good "all three are ignored by git"
fi

cat <<EOF

${B}The one credential you have to remember${R}

  Admin username   ${CY}booth${R}
  Admin password   ${CY}$ADMIN_PASSWORD${R}

  That is what you type into the arcade's CLEAR EVERY LEADERBOARD panel at the
  end of a show day. Write it on something. It is in $ARCADE_ENV
  and in $HUB_ENV if you lose it.

${B}Next${R}

  npm start                    ${DIM}# hub + wall + arcade, prints every address${R}
  ./setup-env.sh --show        ${DIM}# check the configuration any time${R}

EOF
