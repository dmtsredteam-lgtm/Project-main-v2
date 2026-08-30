#!/usr/bin/env bash
#
# Push this project to GitHub, once.
#
# Everything is already prepared — .gitignore, README, and three .env.example
# files, with every credential taken out of the tree. This script does the git
# part and refuses to push if it finds a secret, so a bad commit cannot become a
# published one.
#
#   ./push-to-github.sh                       # private repo, default name
#   ./push-to-github.sh --public              # public instead
#   ./push-to-github.sh --name my-repo-name
#
set -euo pipefail
cd "$(dirname "$0")"

REPO_NAME="gisec-2026-cyber-arena"
VISIBILITY="private"
DESC="DMATICS Cyber Arena — GISEC 2026. SOC wall, arena hub, red team challenge and iPad arcade, wired into one live show."

while [ $# -gt 0 ]; do
  case "$1" in
    --public)  VISIBILITY="public" ;;
    --private) VISIBILITY="private" ;;
    --name)    REPO_NAME="$2"; shift ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

say() { printf '\n\033[1;36m==\033[0m %s\n' "$*"; }
die() { printf '\n\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 1. Refuse to publish a secret.
#
# This runs before anything is pushed, every time — not as a one-off check I did
# once. The three strings below were genuinely in the tree before this repo was
# prepared; the point of the guard is that they cannot come back.
# ---------------------------------------------------------------------------
say "Checking for credentials"

# One pattern list, used against three different things: the working tree, the
# files git is actually about to commit, and every commit already in history.
# The first version of this scanned an --include list that happened to leave out
# .mjs, .cmd, .ts and .tsx — which is where the launcher and the whole arcade
# live. An allowlist of extensions is the wrong shape for "find me a secret";
# scan everything and exclude the few directories that are noise.
# A real credential is long. Requiring eight characters stops the scanner
# tripping over obvious test placeholders like SECRET_KEY="x" * 64, without
# loosening what it catches — the shortest thing here it must still find is an
# eighteen-character token.
VAL="['\"][A-Za-z0-9@#%^&*_.:+/-]{7,}"
PATTERNS="Dmatics@GISEC|change-me-before|ADMIN_PASSWORD *[:=] *$VAL|SECRET_KEY *[:=] *$VAL|ADMIN_TOKEN *[:=] *$VAL|HUB_TOKEN *[:=] *$VAL|-----BEGIN [A-Z ]*PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}"
# The script excludes itself by name — the pattern list below is, unavoidably,
# a file full of credential-shaped strings.
SELF=$(basename "$0")
# Anything git will not push is not this script's problem. Local backup and
# scratch folders are full copies of older trees, so they trip every pattern
# here while being incapable of reaching GitHub.
NOISE="node_modules|\.venv|/dist/|/\.next/|/\.git/|\.env\.example|${SELF//./\\.}|package-lock\.json|/_backup-|/_to_delete/"

scan_fail() {
  echo "$1"
  die "Found what looks like a credential ($2). Move it to a .env and try again."
}

# a. the working tree
LEAKS=$(grep -rniE "$PATTERNS" --binary-files=without-match . 2>/dev/null \
        | grep -vE "$NOISE" || true)
if [ -n "$LEAKS" ]; then scan_fail "$LEAKS" "working tree"; fi

# b. an .env that is not ignored would be committed by `git add -A` below.
#    The old version of this loop ran `git check-ignore` and threw the answer
#    away with `|| true`, so it could never have failed.
if [ -d .git ]; then
  for f in .env */.env */.env.local */.env.production; do
    [ -e "$f" ] || continue
    git check-ignore -q "$f" \
      || die "$f exists and is NOT ignored — it would be published. Add it to .gitignore."
  done
fi

# c. history. A secret removed in the working tree is still public if it is in
#    an earlier commit; the whole point of pushing is that history goes too.
if [ -d .git ] && git rev-parse --verify -q HEAD >/dev/null; then
  HIST=$(git grep -niE "$PATTERNS" $(git rev-list --all) -- 2>/dev/null \
         | grep -vE "$NOISE" | head -20 || true)
  if [ -n "$HIST" ]; then scan_fail "$HIST" "git history — rewrite it before pushing"; fi
fi
echo "   clean (tree, staged .env files, history)"

# ---------------------------------------------------------------------------
# 2. Repository
# ---------------------------------------------------------------------------
if [ ! -d .git ]; then
  say "Initialising the repository"
  git init -q
  git symbolic-ref HEAD refs/heads/main
fi

say "Staging"
git add -A
if git diff --cached --quiet; then
  echo "   nothing new to commit"
else
  git -c user.name="${GIT_AUTHOR_NAME:-DMATICS}" \
      -c user.email="${GIT_AUTHOR_EMAIL:-}" \
      commit -q -m "GISEC 2026 Cyber Arena — SOC wall, arena hub, red team challenge, arcade"
  echo "   committed $(git ls-files | wc -l | tr -d ' ') files"
fi

# ---------------------------------------------------------------------------
# 3. Create it on GitHub and push
# ---------------------------------------------------------------------------
if git remote get-url origin >/dev/null 2>&1; then
  say "Pushing to the remote already configured"
  git push -u origin HEAD
  echo
  echo "Done → $(git remote get-url origin | sed 's/\.git$//')"
  exit 0
fi

if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  say "Creating $REPO_NAME ($VISIBILITY) and pushing"
  gh repo create "$REPO_NAME" "--$VISIBILITY" --source=. --remote=origin \
     --description "$DESC" --push
  echo
  echo "Done → $(gh repo view --json url -q .url)"
  exit 0
fi

cat <<EOF

The GitHub CLI is not installed or not signed in, so the repository has to be
created in the browser. Everything else is finished — this is the last step.

  1. Install and sign in, then re-run this script:

       sudo apt install gh        # Kali / Debian
       gh auth login
       ./push-to-github.sh

  2. Or make an EMPTY repository at https://github.com/new
     (name: $REPO_NAME, $VISIBILITY, no README, no .gitignore, no licence)
     and then run:

       git remote add origin git@github.com:<your-username>/$REPO_NAME.git
       git push -u origin main

Do not let GitHub add a README or .gitignore when you create it — this project
already has both, and an initialised repo makes the first push conflict.
EOF
