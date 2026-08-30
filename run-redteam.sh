#!/usr/bin/env bash
#
# Start the Red Team Challenge. One command, no Python setup to think about.
#
# Kali (and Debian 12+, and Ubuntu 23.04+) ship PEP 668: pip refuses to install
# into the system Python and tells you to make a virtual environment. That is
# correct advice and this script just does it — creates .venv on the first run,
# installs into it, and starts the challenge from it. Every run after the first
# skips straight to starting.
#
#   ./run-redteam.sh              start it
#   ./run-redteam.sh --port 8010  a different port
#   ./run-redteam.sh --reinstall  rebuild the virtual environment from scratch
#
# DMATICS IT Solutions LLC · GISEC 2026
set -uo pipefail
cd "$(dirname "$0")/DMATICS-Red-Team-Challenge-main" 2>/dev/null || {
  echo "Run this from the project root — DMATICS-Red-Team-Challenge-main is not next to it."
  exit 1
}

if [ -t 1 ]; then
  B=$'\033[1m'; DIM=$'\033[2m'; R=$'\033[0m'
  OK=$'\033[32m'; WARN=$'\033[33m'; ERR=$'\033[31m'; CY=$'\033[36m'
else B=""; DIM=""; R=""; OK=""; WARN=""; ERR=""; CY=""; fi
good() { printf '  %s✓%s %s\n' "$OK" "$R" "$*"; }
warn() { printf '  %s!%s %s\n' "$WARN" "$R" "$*"; }
bad()  { printf '  %s✗%s %s\n' "$ERR" "$R" "$*"; }
head2(){ printf '\n%s%s%s\n' "$B" "$*" "$R"; }

REINSTALL=0
PASS_THROUGH=()
while [ $# -gt 0 ]; do
  case "$1" in
    --reinstall) REINSTALL=1 ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) PASS_THROUGH+=("$1") ;;
  esac
  shift
done

VENV=".venv"
PY="$VENV/bin/python"

command -v python3 >/dev/null 2>&1 || { bad "python3 is not installed."; exit 1; }

if [ "$REINSTALL" = 1 ] && [ -d "$VENV" ]; then
  head2 "Rebuilding the virtual environment"
  rm -rf "$VENV" && good "removed the old $VENV"
fi

if [ ! -x "$PY" ]; then
  head2 "First run — setting up Python"
  printf '  %sKali refuses system-wide pip installs (PEP 668), so this goes in a%s\n' "$DIM" "$R"
  printf '  %svirtual environment next to the app. It is gitignored and disposable.%s\n\n' "$DIM" "$R"

  if ! python3 -m venv "$VENV" 2>/tmp/venv-err.txt; then
    bad "could not create the virtual environment"
    sed 's/^/     /' /tmp/venv-err.txt | head -5
    printf '\n  %sOn Kali or Debian the package that provides it is python3-venv:%s\n' "$DIM" "$R"
    printf '     sudo apt install -y python3-venv python3-full\n\n'
    exit 1
  fi
  good "created $VENV"

  printf '  installing Flask and the server…\n'
  if ! "$PY" -m pip install --quiet --upgrade pip 2>/dev/null; then
    warn "could not upgrade pip inside the venv — continuing anyway"
  fi
  if ! "$PY" -m pip install --quiet -r requirements.txt; then
    bad "pip install failed"
    printf '\n  %sTry it verbosely to see why:%s\n' "$DIM" "$R"
    printf '     %s -m pip install -r requirements.txt\n\n' "$PY"
    exit 1
  fi
  good "installed $("$PY" -m pip list --format=freeze 2>/dev/null | wc -l) package(s)"
fi

# Prove it before starting, rather than failing three lines into serve.py.
if ! "$PY" -c "import flask" 2>/dev/null; then
  bad "Flask is missing from $VENV — run ./run-redteam.sh --reinstall"
  exit 1
fi

head2 "Starting"
printf '  %s%s%s\n' "$DIM" "$("$PY" --version 2>&1) · $("$PY" -c 'import flask;print("flask "+flask.__version__)' 2>/dev/null)" "$R"
exec "$PY" serve.py "${PASS_THROUGH[@]+"${PASS_THROUGH[@]}"}"
