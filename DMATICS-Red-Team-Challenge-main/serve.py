#!/usr/bin/env python3
"""
Run the challenge without Docker, on any operating system.

    python serve.py                 http://0.0.0.0:8000
    python serve.py --port 8080

The Dockerfile uses gunicorn, which is Linux-only: it imports fcntl, which does
not exist on Windows. This picks the right server for the machine it is on —
waitress on Windows, gunicorn everywhere else — so the same command works for
everyone.

Run state lives in the Flask session cookie, not in process memory, so workers
do not need to share anything but SECRET_KEY. That is exactly why SECRET_KEY
matters: with two workers holding different keys, each rejects the other's
cookies and a player's run resets at random.
"""
import os
import sys
import argparse

# --------------------------------------------------------------------------- #
#  Load .env before anything reads the environment
#
#  app.py has no dotenv dependency, so `python serve.py` used to ignore the .env
#  file completely and the operator had to remember
#  `set -a; . ./.env; set +a` first. Setting SECRET_KEY, restarting, and watching
#  sessions still reset looks like a broken feature rather than an unloaded one.
#
#  A real environment variable always wins, so `SECRET_KEY=x python serve.py`
#  still overrides the file. Deliberately minimal: KEY=VALUE, # comments,
#  optional surrounding quotes, and a trailing "  # note" is stripped from an
#  unquoted value. No expansion, no multi-line.
# --------------------------------------------------------------------------- #
def load_env_file(path):
    if not os.path.isfile(path):
        return 0
    loaded = 0
    try:
        with open(path, encoding="utf-8") as handle:
            for raw in handle:
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                key = key.strip()
                if not key.replace("_", "").isalnum() or key[0].isdigit():
                    continue
                if key in os.environ:                    # the real environment wins
                    continue
                value = value.strip()
                if len(value) > 1 and value[0] == value[-1] and value[0] in "\"'":
                    value = value[1:-1]
                else:
                    value = value.split("  #")[0].split("\t#")[0].strip()
                os.environ[key] = value
                loaded += 1
    except OSError:
        return loaded                                    # unreadable .env is not fatal
    return loaded


ENV_LOADED = load_env_file(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))

parser = argparse.ArgumentParser(description="Run the DMATICS Red Team Challenge.")
parser.add_argument("--host", default="0.0.0.0")
parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8000)))
parser.add_argument("--threads", type=int, default=8)
args = parser.parse_args()

if ENV_LOADED:
    print(f"  loaded {ENV_LOADED} setting(s) from .env")

HAVE_KEY = bool(os.environ.get("SECRET_KEY"))
if not HAVE_KEY:
    print(
        "\n  SECRET_KEY is not set.\n"
        "  app.py falls back to a random per-process key, so sessions will not\n"
        "  survive a restart. Dropping to a single worker for this run — with two,\n"
        "  each would sign cookies the other rejects and players would be logged\n"
        "  out at random. Copy .env.example to .env and set it:\n\n"
        "      python -c \"import secrets; print(secrets.token_hex(32))\"\n",
        file=sys.stderr,
    )

from app import app  # noqa: E402  (imported after the warning, on purpose)

# ASCII only. U+2192 is not in cp1252, and on Windows Python only uses
# WriteConsoleW for a real console — the moment stdout is a pipe or a file
# (`python serve.py > log.txt`, or any service wrapper such as NSSM or Task
# Scheduler, which is how you would run this unattended at a booth) it falls
# back to the ANSI code page and raises UnicodeEncodeError before the server
# ever binds.
print(f"\n  DMATICS Red Team Challenge  ->  http://{args.host}:{args.port}")
print("  station URLs: ?station=LAPTOP-01  /  ?station=LAPTOP-02\n")

if sys.platform == "win32":
    from waitress import serve
    serve(app, host=args.host, port=args.port, threads=args.threads)
else:
    from gunicorn.app.base import BaseApplication

    class Server(BaseApplication):
        def load_config(self):
            self.cfg.set("bind", f"{args.host}:{args.port}")
            # Two workers only when they can agree on a signing key.
            self.cfg.set("workers", 2 if HAVE_KEY else 1)
            self.cfg.set("preload_app", True)
            self.cfg.set("threads", args.threads)

        def load(self):
            return app

    Server().run()
