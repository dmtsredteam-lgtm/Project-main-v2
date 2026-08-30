#!/usr/bin/env python3
# -*- coding: utf-8 -*-
#
# DMATICS Red Team Challenge  ·  GISEC 2026 Booth Edition
# --------------------------------------------------------
# A little 10-minute "breach the target" game we run at the booth. Five stages,
# 100 points, a big-screen leaderboard, and a fake shell that only knows a handful
# of commands so nobody can actually break out onto the host. Everything here is
# simulated on purpose - it's meant to be safe to leave running on a public
# show-floor network all day.
#
# The target org is a made-up company, "Aegis Vault Systems". DMATICS is the
# red team running the op (that's the branding you see in the nav / leaderboard).
#
# Built by the DMATICS Offensive Security team, Dubai.  info@dmaticsonline.com
#
# Changelog:
#   v1.6  - polish pass:
#             * grabbing all 5 flags now auto-ends the run with a victory screen
#               (score recorded automatically) - no more manual "record" button
#             * clearer /submit result: newly vs already-captured vs time-expired
#               (fixes the "FLAG-5 already captured" false message)
#             * dropped the extra submit box in the SSH console - submit only on
#               Mission Control now
#             * removed the dead Staff-Login card from the recon portal
#   v1.5  - proper CTF flow: stages unlock in order (FLAG-1 -> ... -> FLAG-5)
#   v1.4  - SOC bites back: brute-force lock-outs + priv-esc trap, manual capture
#   v1.3  - audio, DMATICS logos, renamed target to "Aegis Vault Systems"
#   v1.2  - hacker theme + digital-rain background
#   v1.1  - fixed the flag-submit parser, added /health
#   v1.0  - first cut for GISEC

import os
import re
import sys
from contextlib import closing
import time
import sqlite3
import secrets
import hmac
import hashlib
from functools import wraps
from datetime import datetime
from flask import (
    Flask, render_template, request, redirect, url_for,
    session, jsonify, send_from_directory, flash, has_request_context, abort
)

from werkzeug.security import safe_join

import hub   # GISEC Arena Hub emitter - no-ops entirely when HUB_URL is unset

# --------------------------------------------------------------------------- #
#  Config - the handful of things you'd actually want to tweak per event
# --------------------------------------------------------------------------- #
APP_TITLE   = "DMATICS Red Team Challenge"
EVENT_NAME  = "GISEC 2026"
TARGET_ORG  = "Aegis Vault Systems"
TARGET_HOST = "aegis-web01"
TARGET_FS   = r"\\aegis-fs01\Shared"
# "/app/data" is the CONTAINER path, set by the Dockerfile and compose. serve.py
# exists to run this without Docker, and on Windows a leading "/" means "root of
# the current drive" — so the leaderboard landed in C:\\app\\data\\, or D:\\app\\data\\
# if the checkout was on another drive, i.e. a different database depending on
# where you launched from. Default to a path beside this file; the Docker env
# var still overrides it, so the container is unchanged.
DB_PATH     = os.environ.get("DB_PATH") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "data", "leaderboard.db")
FILES_DIR   = os.path.join(os.path.dirname(__file__), "challenge_files")

# How many bad passwords before the SOC "catches" the player and ends the run.
LOGIN_MAX = 4     # staff portal login
SSH_MAX   = 3     # SSH web console

# The five flags. Update challenge_files/passwords.txt if you change FLAG-3/SVC_PASS.
FLAGS = {
    "FLAG-1": "DMATICS{r3c0n_c0mpl3t3}",       # Stage 1 - recon / view-source
    "FLAG-2": "DMATICS{w3ak_p@ssw0rd_pwn3d}",  # Stage 2 - weak password
    "FLAG-3": "DMATICS{cr3ds_1n_th3_sh@re}",   # Stage 3 - creds on the share
    "FLAG-4": "DMATICS{sh3ll_@cc3ss_g@in3d}",  # Stage 4 - foothold shell
    "FLAG-5": "DMATICS{cr0wn_jewel_5ecur3d}",  # Stage 5 - exfil the vault
}
POINTS = {"FLAG-1": 10, "FLAG-2": 20, "FLAG-3": 20, "FLAG-4": 25, "FLAG-5": 25}  # = 100

# --- the CTF chain: which flag you must have SUBMITTED to enter each stage ----
STAGE_REQUIRES = {1: None, 2: "FLAG-1", 3: "FLAG-2", 4: "FLAG-3", 5: "FLAG-4"}

# Kill-chain phase each flag belongs to. Shown on the SOC Wall's operation card
# so the crowd can follow how far into the target the operator has reached.
STAGE_NAMES = {
    "FLAG-1": "Reconnaissance",
    "FLAG-2": "Credential Access",
    "FLAG-3": "Lateral Movement",
    "FLAG-4": "Foothold",
    "FLAG-5": "Exfiltration",
}

# Weak "onboarding" creds the player has to figure out (Stage 2)
VALID_USER = "john.smith"
VALID_PASS = "Summer2026"

# Service account hidden on the share, used to reach the box (Stage 3 -> 4)
SVC_USER = "svc_backup"
SVC_PASS = "Backup@2026!"

GAME_SECONDS = int(os.environ.get("GAME_SECONDS", 600))  # 10 minutes

# --------------------------------------------------------------------------- #
#  The SOC defence - "blue team bites back"
# --------------------------------------------------------------------------- #
# Every noisy action raises a heat score on the player's session. Heat decays
# while they are careful and climbs while they are not, and three thresholds sit
# on the way up:
#
#     WATCH     the SOC has noticed. A banner, nothing more.
#     THROTTLE  the SOC holds their traffic for inspection. The game is
#               interrupted for a few seconds and the clock keeps running.
#     CONTAIN   the SOC ends the run.
#
# This sits ALONGSIDE the original hard rules (4 bad portal logins, 3 bad SSH
# logins, any sudo escalation still end a run instantly). What it adds is the
# middle tier - the part a visitor can feel building, and the part the crowd at
# the big screen can watch building before it lands.
#
# It is computed here, in the game, on purpose. The hub mirrors it to the wall,
# but if the hub is unplugged the defence still works: the mechanic must never
# depend on a second service being up.
# Decay is the dial that matters. At 0.9/s a careful player who takes a minute
# per stage sheds more heat than the stage costs and never trips a throttle; a
# player who fumbles passwords or hammers the shell trips one every couple of
# minutes. Raise it to make the SOC more forgiving when the queue is long.
HEAT_DECAY_PER_SEC = float(os.environ.get("HEAT_DECAY", 0.9))
HEAT_WATCH         = float(os.environ.get("HEAT_WATCH", 34))
HEAT_THROTTLE      = float(os.environ.get("HEAT_THROTTLE", 62))
HEAT_CONTAIN       = float(os.environ.get("HEAT_CONTAIN", 96))
THROTTLE_SECONDS   = int(os.environ.get("THROTTLE_SECONDS", 12))
# How many holds a session survives before the SOC stops holding and contains.
THROTTLE_LIMIT     = int(os.environ.get("THROTTLE_LIMIT", 3))
# Play this long without being held and the SOC forgives one strike.
THROTTLE_FORGIVE_SECONDS = int(os.environ.get("THROTTLE_FORGIVE", 90))

# What each action costs. Tuned so a clean run never trips a throttle and a
# noisy one trips it about twice before the hard rules would have caught them.
HEAT_COST = {
    "recon":      6,
    "auth_fail":  20,
    "auth_ok":    10,
    "share_loot": 14,
    "ssh_fail":   28,
    "ssh_ok":     16,
    "shell_cmd":  7,
    "flag":       12,
    "exfil":      40,
    "privesc":    70,
}

# Which laptop this browser is sitting at. One Flask instance can serve both
# stations - the id is per-session, seeded from ?station= on the landing page -
# so the booth can run one container or two, whichever is easier on the day.
# Shared with the hub. No fallback: an unset token disables /admin/reset rather
# than shipping one the repository already knows.
ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "")

DEFAULT_STATION = (os.environ.get("STATION_ID") or "LAPTOP-01").upper()
KNOWN_STATIONS  = [s.strip().upper() for s in
                   os.environ.get("STATIONS", "LAPTOP-01,LAPTOP-02").split(",") if s.strip()]

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", secrets.token_hex(32))

# Nothing this game accepts is large. Without a cap the request body is
# unbounded, and anything that echoes part of it into the session cookie can
# push that cookie past the browser's 4 KB limit — silently destroying the run.
app.config["MAX_CONTENT_LENGTH"] = 64 * 1024

if not os.environ.get("SECRET_KEY"):
    # gunicorn does not preload by default, so each worker invents its own key
    # and rejects the other's cookies: runs reset at random with no error
    # anywhere. Loud, because the failure mode is otherwise invisible.
    print("[WARN] SECRET_KEY is not set. Sessions will not survive a restart, "
          "and with more than one worker they break outright. "
          "Copy .env.example to .env and set it.", file=sys.stderr)

@app.context_processor
def inject_globals():
    # `socstate` is the SOC's current read on this session (heat, posture, any
    # active throttle). Every page gets it, so the heat meter in the nav and the
    # takeover overlay never need it threaded through a render_template call.
    # Only computed once a run is under way - a passer-by opening the leaderboard
    # should not mint a game session.
    live = session.get("p", {}).get("player") if has_request_context() else None
    return dict(target_org=TARGET_ORG, target_host=TARGET_HOST,
                target_fs=TARGET_FS, event=EVENT_NAME,
                login_max=LOGIN_MAX, ssh_max=SSH_MAX,
                station=station_id(), hub_url=hub.HUB_URL,
                socstate=(soc_state() if live else None))


# --------------------------------------------------------------------------- #
#  Leaderboard storage (tiny SQLite db, one row per finished OR busted run)
# --------------------------------------------------------------------------- #
def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    con = sqlite3.connect(DB_PATH)
    con.execute("""
        CREATE TABLE IF NOT EXISTS scores (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            player     TEXT    NOT NULL,
            points     INTEGER NOT NULL DEFAULT 0,
            flags      INTEGER NOT NULL DEFAULT 0,
            seconds    INTEGER NOT NULL DEFAULT 0,
            finished   INTEGER NOT NULL DEFAULT 0,
            created_at TEXT    NOT NULL
        )
    """)
    con.commit()
    con.close()


def db():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    return con


def save_score(player, points, flags, seconds, finished):
    # closing(): without it a "database is locked" on the bind-mounted volume
    # (realistic with two workers and four threads) skipped con.close(), leaked
    # the handle, left p["saved"] False, and let the exception escape through
    # record_score into bust() — so the containment theatre ended in a 500 page
    # in front of the crowd instead of a red screen.
    with closing(db()) as con:
        con.execute(
            "INSERT INTO scores (player, points, flags, seconds, finished, created_at)"
            " VALUES (?,?,?,?,?,?)",
            (player, points, flags, seconds, int(finished), datetime.utcnow().isoformat()),
        )
        con.commit()


# --------------------------------------------------------------------------- #
#  Per-player progress (all in the signed session cookie)
# --------------------------------------------------------------------------- #
def fresh_progress():
    return {
        "player": None,
        "started_at": None,
        "captured": [],                # flag ids the player has SUBMITTED
        "points": 0,
        "logged_in": False,            # portal login done? (Stage 2 mechanic)
        "shell": False,                # web shell unlocked? (Stage 4 mechanic)
        "login_attempts": LOGIN_MAX,
        "ssh_attempts": SSH_MAX,
        "busted": False,
        "bust_reason": None,
        "saved": False,
        "ended": False,                # run finished; score banked, no more play
        # --- SOC defence state ---------------------------------------------
        "heat": 0.0,                   # detection confidence, 0-100
        "heat_at": None,               # when heat was last recomputed (decay)
        "throttled_until": 0.0,        # server-side hold; not just a UI overlay
        "throttles": 0,                # strikes, decayed by THROTTLE_FORGIVE
        "throttled_at": None,          # when the last hold started
        "warned": False,               # the one-time "you've been noticed" advisory
        "seen": [],                    # stages already reported, so a page
                                       # refresh is not a second detection
    }


def progress():
    if "p" not in session:
        session["p"] = fresh_progress()
    p = session["p"]
    # Sessions minted by an older build are missing the SOC-defence keys. Fill
    # them in rather than resetting, so an upgrade mid-show cannot wipe a run
    # that is already in progress.
    for key, value in fresh_progress().items():
        p.setdefault(key, value)
    return p


def station_id():
    """
    The laptop this browser is sitting at.

    Set once with ?station=LAPTOP-02 on the landing page and remembered in the
    session, so both laptops can share one Flask instance and still appear as
    two separate stations on the SOC Wall.
    """
    if not has_request_context():
        return DEFAULT_STATION
    requested = (request.args.get("station") or "").strip().upper()
    if requested:
        session["station"] = re.sub(r"[^A-Z0-9-]", "", requested)[:16] or DEFAULT_STATION
        session.modified = True
    return session.get("station") or DEFAULT_STATION


# --------------------------------------------------------------------------- #
#  Heat / escalation
# --------------------------------------------------------------------------- #
def current_heat(p=None):
    """Heat with elapsed decay applied. Read-only - does not mutate the session."""
    p = p or progress()
    heat = float(p.get("heat") or 0.0)
    since = p.get("heat_at")
    if since:
        heat -= HEAT_DECAY_PER_SEC * max(0.0, time.time() - float(since))
    return max(0.0, min(100.0, heat))


def effective_strikes(p=None):
    """
    How many holds still count against this session, with expiry applied.

    Read-side, deliberately. Decaying the counter only at the moment a new hold
    fires meant the number never moved anywhere a player could see it — the nav
    meter and /soc/state kept reporting the raw stored value, so a session that
    had genuinely served its time still displayed two strikes and anything
    waiting on that number waited forever. Strikes are a function of the clock,
    like heat and posture, so they are computed like one.
    """
    p = p or progress()
    strikes = int(p.get("throttles", 0))
    last = float(p.get("throttled_at") or 0)
    if not strikes or not last:
        return strikes
    return max(0, strikes - int((time.time() - last) // THROTTLE_FORGIVE_SECONDS))


def throttle_left(p=None):
    """Seconds remaining on an active SOC throttle, 0 when free to act."""
    p = p or progress()
    return max(0, int(round(float(p.get("throttled_until") or 0) - time.time())))


def posture_for(p=None):
    """
    The session's posture, DERIVED rather than stored.

    An earlier version wrote posture into the session when it escalated, which
    meant a player stayed flagged THROTTLED for the rest of their run long after
    the hold expired - the wall showed a red station and the nav pill said HELD
    with nothing actually holding them. Posture is a function of the current heat
    and the clock, so it is computed as one. Only containment sticks, because
    containment really is permanent.
    """
    p = p or progress()
    if p.get("busted"):
        return "CONTAINED"
    if throttle_left(p) > 0:
        return "THROTTLED"
    if current_heat(p) >= HEAT_WATCH:
        return "WATCHED"
    return "CLEAR"


def soc_state(p=None):
    """The blob every SOC-aware response carries, so the UI is never guessing."""
    p = p or progress()
    heat = current_heat(p)
    return {
        "heat": round(heat, 1),
        "posture": posture_for(p),
        "throttles": effective_strikes(p),
        "throttleLeft": throttle_left(p),
        "watch": HEAT_WATCH,
        "throttle": HEAT_THROTTLE,
        "contain": HEAT_CONTAIN,
        # The countdown on Mission Control is seeded once and then free-runs in
        # a setInterval, so a backgrounded or slept tab always shows MORE time
        # than the server has — the player watches 01:40 while /submit answers
        # "time's up". This is polled every few seconds; the client resyncs off it.
        "left": time_left(),
        "total": GAME_SECONDS,
        "station": station_id(),
    }


def raise_heat(kind, detail=None, stage=None, amount=None, title=None):
    """
    Register a noisy action, escalate if a threshold is crossed, and mirror the
    whole thing to the SOC Wall.

    Returns a `soc` dict the caller hands back to the browser:

        {"action": "throttle", "seconds": 12, "title": ..., "reason": ...}

    `action` is None when nothing escalated - the common case, and the one the
    templates check first.
    """
    p = progress()
    heat = current_heat(p) + float(HEAT_COST.get(kind, 0) if amount is None else amount)
    heat = max(0.0, min(100.0, heat))
    p["heat"] = heat
    p["heat_at"] = time.time()
    session.modified = True

    station = station_id()
    player = p.get("player") or "OPERATOR"
    posture = posture_for(p)
    response = {"action": None, "heat": round(heat, 1), "posture": posture}

    # The detection goes out FIRST, always - before any escalation it triggers.
    # The wall renders these in arrival order, and a containment banner that
    # lands before the alert that caused it destroys the one thing this whole
    # integration exists to show: cause, then effect, in that order.
    hub.emit(kind, player=player, station=station, title=title, detail=detail,
             heat=heat, posture=posture, stage=stage, points=p.get("points"))

    # ---- containment ------------------------------------------------------
    if heat >= HEAT_CONTAIN and not p.get("busted"):
        reason = ("Correlated detections across this session exceeded the "
                  "automated containment threshold. The SOC ended the run.")
        bust("Automated containment — sustained malicious activity from this session.")
        response.update(action="contain", posture="CONTAINED",
                        title="SOC RESPONSE — SESSION CONTAINED", reason=reason, seconds=0)
        # bust() already emitted the soc_contain detection; this is the response
        # order that lights up the wall's SOC RESPONSE band.
        hub.command(station, "contain", response["title"], reason, heat=heat)
        session.modified = True
        return response

    # ---- throttle ---------------------------------------------------------
    # A hold the player cannot outlive is a forfeit, not a setback: held at
    # T-8s with a 12-second hold, they watch the clock die and lose the 25
    # points they had already earned. In the last few seconds the SOC watches
    # and does not hold.
    if (heat >= HEAT_THROTTLE and throttle_left(p) <= 0 and not p.get("busted")
            and time_left() > THROTTLE_SECONDS):
        now = time.time()

        # --- how many strikes does this session really have? -----------------
        #
        # Strikes expire. A run-long counter meant one fumble in the first
        # minute, followed by five clean minutes, still counted against the
        # player at the finale — the opposite of what an escalation is supposed
        # to teach, and unfair in a way a visitor feels without being able to
        # name it. Every THROTTLE_FORGIVE_SECONDS of play without a hold takes
        # one strike back. Computed BEFORE this hold is counted, from the
        # PREVIOUS hold's timestamp: doing it after meant `since` was always
        # zero and nothing was ever forgiven.
        strikes = effective_strikes(p)

        # --- the third hold is not a hold ------------------------------------
        #
        # The escalation has to actually escalate. The heat floor below
        # saturates at 0.85 x 62 = 52.7, and 52.7 plus the loudest single action
        # (exfil, 40) is 92.7 — under the 96 containment line. Measured: thirty
        # consecutive vault reads produced twenty-nine throttles and no
        # containment at all. The comment that used to sit here promised "a
        # player who never adapts walks into containment instead of being held
        # forever", and the code delivered precisely the slideshow it named.
        #
        # Count the holds instead of hoping the arithmetic gets there. Three is
        # the number the copy already promises and the right number for a booth:
        # two warnings you can come back from, then the finale.
        if strikes + 1 >= THROTTLE_LIMIT:
            reason = (f"{strikes + 1} separate holds on this session. The SOC "
                      "stopped inspecting and started blocking.")
            p["throttles"] = strikes + 1
            bust("Automated containment — repeated detections after "
                 f"{strikes} hold(s).")
            response.update(action="contain", posture="CONTAINED", seconds=0,
                            title="SOC RESPONSE — SESSION CONTAINED", reason=reason)
            hub.command(station, "contain", response["title"], reason, heat=100.0)
            session.modified = True
            return response

        p["throttles"] = strikes + 1
        p["throttled_at"] = now
        p["throttled_until"] = now + THROTTLE_SECONDS

        # Heat RESETS to a floor rather than bleeding a fixed amount, and the
        # floor rises with each hold: subtracting a flat 26 left a loud player
        # hovering just under the line and re-tripping on every single stage,
        # and a run that is nothing but lockouts teaches nothing.
        floor = HEAT_THROTTLE * min(0.85, 0.40 + 0.18 * (p["throttles"] - 1))
        p["heat"] = min(heat, floor)
        p["heat_at"] = time.time()

        reason = ("Traffic from this session is being held for deep packet "
                  "inspection. Your operation is paused — the clock is not.")
        response.update(action="throttle", posture="THROTTLED", seconds=THROTTLE_SECONDS,
                        title="SOC RESPONSE — ADAPTIVE THROTTLE ENGAGED", reason=reason,
                        heat=round(p["heat"], 1))
        hub.command(station, "throttle", response["title"], reason,
                    seconds=THROTTLE_SECONDS, heat=heat)
        hub.emit("soc_throttle", player=player, station=station, detail=reason,
                 heat=heat, posture="THROTTLED", stage=stage)
        session.modified = True
        return response

    # ---- first warning ----------------------------------------------------
    # Once per run. Heat crossing 34 again after cooling off is not news, and a
    # banner every few actions is noise the player learns to ignore.
    if heat >= HEAT_WATCH and not p.get("warned"):
        p["warned"] = True
        reason = ("Correlated detections raised the risk score on this session. "
                  "Activity is now being recorded in full.")
        response.update(action="monitor", posture="WATCHED",
                        title="SOC ADVISORY — SESSION UNDER INSPECTION", reason=reason, seconds=0)
        hub.command(station, "monitor", response["title"], reason, heat=heat)
        hub.emit("soc_monitor", player=player, station=station, detail=reason,
                 heat=heat, posture="WATCHED", stage=stage)
        session.modified = True

    return response


def expire_if_over():
    """
    End a run whose clock has run out, wherever the player happens to be.

    record_score() was only ever reached through /finish, and the only thing
    that sent a live player there was a JS countdown on Mission Control. So the
    two most ordinary things at a booth — running out of time while heads-down
    in the SSH console, and walking away — recorded nothing at all. A visitor
    who scored 75 points saw no row with their name on it, and the board
    under-reported the queue all day.

    Called from require_player, so every authenticated route enforces it. Returns
    True when the run has just been (or already was) closed.
    """
    p = progress()
    if not p.get("player") or not p.get("started_at"):
        return False
    if p.get("ended") or p.get("busted"):
        return True
    if time.time() - float(p["started_at"]) < GAME_SECONDS:
        return False
    p["ended"] = True
    session.modified = True
    record_score(finished=len(p["captured"]) == len(FLAGS))
    hub.emit("run_end", player=p.get("player"), station=station_id(),
             title="Adversary session closed — clock expired",
             detail=f"{len(p['captured'])} of {len(FLAGS)} objectives captured "
                    f"before the window closed.",
             heat=current_heat(p), posture=posture_for(p), points=p.get("points", 0))
    return True


def note_stage(tag):
    """True the first time a stage is entered - stops refreshes double-firing."""
    p = progress()
    if tag in p.get("seen", []):
        return False
    p.setdefault("seen", []).append(tag)
    session.modified = True
    return True


def held():
    """
    Server-side enforcement of a throttle.

    The takeover overlay is theatre; this is the part that means it. Without it a
    player could close the overlay, or reload, and carry on - and the crowd that
    just watched the SOC contain them would see nothing happen.
    """
    left = throttle_left()
    if left <= 0:
        return None
    return {
        "ok": False, "throttled": True, "seconds": left,
        "title": "SOC RESPONSE — ADAPTIVE THROTTLE ENGAGED",
        "msg": ("Traffic from this session is still held for deep packet "
                f"inspection — {left}s remaining. Nothing you send reaches "
                "the target until the SOC releases it."),
        "soc": soc_state(),
    }


def held_page():
    """
    The page-shaped half of held().

    held() guarded the four routes the player POSTs to, but not the four GETs
    that RAISE heat — /portal, /portal/directory, /dashboard/share and /files/.
    So a throttled player kept enumerating during the hold, kept accruing heat,
    and could collect FLAG-1 out of the directory while the overlay in front of
    them said "nothing you send reaches the target until the SOC releases it".
    It did.

    Returns a rendered hold page, or None when the session is free to act.
    """
    hold = held()
    if not hold:
        return None
    flash(hold["msg"])
    return redirect(url_for("brief"))


def has(flag_id):
    return flag_id in progress()["captured"]


def stage_unlocked(stage):
    req = STAGE_REQUIRES.get(stage)
    return req is None or req in progress()["captured"]


def record_score(finished):
    p = progress()
    if p.get("saved"):
        return
    save_score(p["player"], p["points"], len(p["captured"]), elapsed(), finished)
    p["saved"] = True
    session.modified = True
    # The local SQLite board stays the source of truth for /leaderboard; this
    # copy is what puts the operator on the big screen next to the arcade games.
    hub.score(p["player"], p["points"], len(p["captured"]), elapsed(), finished,
              station=station_id())


def bust(reason):
    p = progress()
    if not p.get("busted"):
        p["busted"] = True          # posture_for() derives CONTAINED from this
        p["bust_reason"] = reason
        # Pin the meter. The wall is told heat=100 on every containment, but the
        # player's own nav meter reads current_heat() — so a quiet player who
        # trips a hard rule (sudo is signposted in the console banner, so this is
        # common) saw an EMPTY bar labelled CONTAINED on the laptop while the big
        # screen behind them showed a maxed one. Two screens, one event, two
        # different stories.
        p["heat"] = 100.0
        p["heat_at"] = time.time()
        record_score(finished=False)
        session.modified = True
        hub.emit("soc_contain", player=p.get("player"), station=station_id(),
                 title="Containment executed — adversary session terminated",
                 detail=reason, heat=100, posture="CONTAINED", contained=True,
                 points=p.get("points"))


# What must be TRUE about this session for each flag to be scoreable, and what
# to say when it is not. Deliberately phrased as a nudge towards the stage
# rather than an accusation — a visitor who legitimately found a flag early
# should be pointed at the door they skipped, not told off.
PLAY_EVIDENCE = {
    "FLAG-1": (lambda p: "directory" in p.get("seen", []),
               "Locked — open the staff directory on the portal first."),
    "FLAG-2": (lambda p: bool(p.get("logged_in")),
               "Locked — sign in to the staff portal first."),
    "FLAG-3": (lambda p: any(t.startswith("file:") for t in p.get("seen", [])),
               "Locked — read the credential file on the internal share first."),
    "FLAG-4": (lambda p: bool(p.get("shell")),
               "Locked — get a shell on the host first."),
    "FLAG-5": (lambda p: "exfil" in p.get("seen", []),
               "Locked — find and read the vault file in the shell first."),
}


def capture(flag_id):
    """Add a flag to the captured set + points. Caller checks the guards first."""
    p = progress()
    p["captured"].append(flag_id)
    p["points"] += POINTS[flag_id]
    session.modified = True


ALLOW_WHEN_BUSTED = {"index", "finish", "leaderboard", "leaderboard_data",
                     "status", "soc_status", "health", "static", "admin_reset"}

# Routes the page calls with fetch() and then parses as JSON. A redirect to an
# HTML page is not an answer these can read.
JSON_ENDPOINTS = {"submit", "console_exec", "console_auth", "soc_status", "status"}


def require_player(f):
    @wraps(f)
    def wrapper(*a, **kw):
        p = progress()
        if not p.get("player"):
            return redirect(url_for("index"))
        # "ended" is set by finish() and behaves like "busted" for routing: the
        # run is over and the score is banked, so continuing to play would keep
        # scoring against a row that can never be updated again.
        # The clock is authoritative here, not in the browser.
        expire_if_over()
        if (p.get("busted") or p.get("ended")) and request.endpoint not in ALLOW_WHEN_BUSTED:
            # A fetch() caller cannot read a 302 — the browser follows it, the
            # response is HTML, and `await r.json()` throws an unhandled
            # rejection. The player pastes a correct flag and the page does
            # nothing at all. Answer JSON callers in JSON.
            if request.endpoint in JSON_ENDPOINTS:
                return jsonify(ok=False, ended=True, busted=bool(p.get("busted")),
                               msg=("Run terminated by the SOC." if p.get("busted")
                                    else "This run has ended — the clock ran out."),
                               soc=soc_state(p)), 200
            return redirect(url_for("finish"))
        return f(*a, **kw)
    return wrapper


def require_stage(stage):
    def deco(f):
        @wraps(f)
        @require_player
        def wrapper(*a, **kw):
            if not stage_unlocked(stage):
                req = STAGE_REQUIRES.get(stage)
                flash(f"🔒 Locked — submit {req} on Mission Control to unlock "
                      f"Stage {stage}.")
                return redirect(url_for("brief"))
            return f(*a, **kw)
        return wrapper
    return deco


def elapsed():
    """
    Seconds of run time, clamped to the round.

    Two things used to escape through here onto the big screen. A booth laptop
    correcting its clock over show-floor wifi could make started_at land in the
    future, producing a NEGATIVE elapsed — the leaderboard formatter clamped the
    DISPLAY to 00:00, but `ORDER BY seconds ASC` still saw -3599 and put that run
    at rank 1 ahead of every honest 100-pointer. And a tab left open for an hour
    banked seconds=3000, so a ten-minute game rendered "50:00" on a 55-inch
    screen. Clamp once, here, and every reader is correct.
    """
    p = progress()
    if not p.get("started_at"):
        return 0
    return max(0, min(GAME_SECONDS, int(time.time() - p["started_at"])))


def time_left():
    return max(0, GAME_SECONDS - elapsed())


# --------------------------------------------------------------------------- #
#  The stage map that drives Mission Control's hub of direct links
# --------------------------------------------------------------------------- #
def stage_list():
    caps = progress()["captured"]

    def st(n, name, endpoint, awards, desc):
        req = STAGE_REQUIRES.get(n)
        return dict(n=n, name=name, url=url_for(endpoint), awards=awards,
                    requires=req, desc=desc,
                    done=(awards in caps),
                    unlocked=(req is None or req in caps))

    return [
        st(1, "Reconnaissance", "portal", "FLAG-1",
           "Enumerate the public portal & staff directory. View source to find FLAG-1."),
        st(2, "Credential Access", "login", "FLAG-2",
           "Brute the weak password for the account you found. Login reveals FLAG-2."),
        st(3, "Lateral Movement", "dashboard", "FLAG-3",
           "Loot the internal share for leaked service-account creds & FLAG-3."),
        st(4, "Foothold", "console", "FLAG-4",
           "Pop a shell on " + TARGET_HOST + " and cat the shell flag (FLAG-4)."),
        st(5, "Exfiltration — Crown Jewel", "console", "FLAG-5",
           "Hunt the hidden vault file in the shell and exfil the final flag."),
    ]


# --------------------------------------------------------------------------- #
#  Registration / home / Mission Control
# --------------------------------------------------------------------------- #
@app.route("/", methods=["GET", "POST"])
def index():
    if request.method == "POST":
        # Strip markup at the door as well as escaping at the exit. This value
        # is stored, replayed to the big screen every five seconds, and shown on
        # every visitor's phone; one escaper being forgotten downstream should
        # not be enough to put script on the hall's largest display.
        name = re.sub(r"[<>&\"'`]", "", (request.form.get("player") or "")).strip()[:24]
        if name:
            # Bank whatever the previous occupant of this browser earned before
            # wiping it. A visitor who hits Back and types a new handle used to
            # delete an unsaved run outright — the commonest way a real score
            # never reached the board.
            previous = session.get("p") or {}
            if previous.get("player") and previous.get("started_at") and not previous.get("saved"):
                try:
                    record_score(finished=len(previous.get("captured", [])) == len(FLAGS))
                except Exception:                    # never block a new player
                    app.logger.exception("[run] could not bank the previous run")
            keep_station = session.get("station")
            session["p"] = fresh_progress()
            session["p"]["player"] = name
            session["p"]["started_at"] = time.time()
            if keep_station:
                session["station"] = keep_station
            session.modified = True
            hub.emit("run_start", player=name, station=station_id(),
                     title=f"New adversary session opened against {TARGET_ORG}",
                     detail="Operator registered at a booth station and started the kill chain.",
                     stage="Reconnaissance", heat=0, posture="CLEAR", points=0)
            return redirect(url_for("brief"))
        flash("Enter your handle to begin.")
    return render_template("index.html", title=APP_TITLE,
                           minutes=max(1, round(GAME_SECONDS / 60)),
                           total_points=sum(POINTS.values()),
                           stage_count=len(FLAGS))


@app.route("/brief")
@require_player
def brief():
    return render_template("brief.html", title=APP_TITLE,
                           p=progress(), elapsed=elapsed(), left=time_left(),
                           total_seconds=GAME_SECONDS, stages=stage_list())


# --------------------------------------------------------------------------- #
#  Stage 1 - Reconnaissance
# --------------------------------------------------------------------------- #
@app.route("/portal")
@require_stage(1)
def portal():
    stop = held_page()
    if stop:
        return stop
    if note_stage("portal"):
        raise_heat("recon", "Public portal enumerated from an unrecognised source.",
                   stage="Reconnaissance")
    return render_template("portal.html", title=APP_TITLE, p=progress())


@app.route("/portal/directory")
@require_stage(1)
def directory():
    stop = held_page()
    if stop:
        return stop
    if note_stage("directory"):
        raise_heat("recon", "Staff directory scraped - employee names and handles harvested.",
                   stage="Reconnaissance")
    return render_template("directory.html", title=APP_TITLE, p=progress(),
                           flag1=FLAGS["FLAG-1"], valid_user=VALID_USER)


# --------------------------------------------------------------------------- #
#  Stage 2 - Credential Access  (needs FLAG-1)  -  locks out after LOGIN_MAX
# --------------------------------------------------------------------------- #
@app.route("/portal/login", methods=["GET", "POST"])
@require_stage(2)
def login():
    p = progress()
    error = None
    soc = None
    response = None
    if request.method == "POST" and not p.get("logged_in"):
        hold = held()
        if hold:
            # Throttled: the attempt is refused outright and does not burn one of
            # their four tries. The SOC took the time instead.
            error = hold["msg"]
            response = {"action": "throttle", "seconds": hold["seconds"],
                        "title": hold["title"], "reason": hold["msg"]}
        else:
            u = (request.form.get("username") or "").strip()
            pw = (request.form.get("password") or "").strip()
            if u == VALID_USER and pw == VALID_PASS:
                p["logged_in"] = True
                session.modified = True
                response = raise_heat(
                    "auth_ok",
                    f"Interactive logon as {VALID_USER} from an unrecognised source address.",
                    stage="Credential Access")
            else:
                p["login_attempts"] = max(0, p.get("login_attempts", LOGIN_MAX) - 1)
                session.modified = True
                if p["login_attempts"] <= 0:
                    soc = {"title": "SOC ALERT — BRUTE FORCE DETECTED",
                           "msg": ("Multiple failed logins on the staff portal tripped "
                                   "the detection rule. Account locked, source flagged, "
                                   "session killed.")}
                    hub.emit("auth_fail", player=p.get("player"), station=station_id(),
                             detail=f"Final failed logon against the {TARGET_ORG} staff "
                                    f"portal — lockout threshold of {LOGIN_MAX} reached.",
                             heat=100.0, posture="CONTAINED", stage="Credential Access")
                    bust("Brute-force authentication attack detected against the "
                         f"{TARGET_ORG} staff portal.")
                    hub.command(station_id(), "contain",
                                "SOC RESPONSE — SESSION CONTAINED", soc["msg"], heat=100)
                else:
                    error = (f"Invalid credentials. Access denied. "
                             f"{p['login_attempts']} attempt(s) remaining before lockout.")
                    response = raise_heat(
                        "auth_fail",
                        f"Failed logon attempt {LOGIN_MAX - p['login_attempts']} of {LOGIN_MAX} "
                        f"on the {TARGET_ORG} staff portal.",
                        stage="Credential Access")
    return render_template("login.html", title=APP_TITLE, p=p,
                           error=error, hint_user=VALID_USER,
                           attempts_left=p.get("login_attempts", LOGIN_MAX),
                           soc=soc, response=response,
                           flag2=(FLAGS["FLAG-2"] if p.get("logged_in") else None))


# --------------------------------------------------------------------------- #
#  Stage 3 - Lateral Movement  (needs FLAG-2)
# --------------------------------------------------------------------------- #
@app.route("/dashboard")
@require_stage(3)
def dashboard():
    return render_template("dashboard.html", title=APP_TITLE, p=progress())


@app.route("/dashboard/share")
@require_stage(3)
def share():
    stop = held_page()
    if stop:
        return stop
    if note_stage("share"):
        raise_heat("share_loot",
                   f"Internal file share {TARGET_FS} browsed by a standard user account.",
                   stage="Lateral Movement")
    return render_template("share.html", title=APP_TITLE, p=progress())


@app.route("/files/<path:fname>")
@require_stage(3)
def files(fname):
    stop = held_page()
    if stop:
        return stop
    # Opening the credential file is the loud moment on this stage, not browsing
    # the folder - so it is scored per file, once each.
    # Only score a file that actually exists.
    #
    # raise_heat fired BEFORE send_from_directory decided whether the file was
    # real, and note_stage de-duplicates on the exact string — so every distinct
    # 404 was a fresh "sensitive file read" worth 14 heat. Nine misses and the
    # run was over. The thing that ended it was fuzzing the file route for
    # traversal, which is precisely what a red-team visitor is invited to try at
    # a hacking booth. Nothing was read; nothing existed.
    #
    # And the check has to be the SAME check that serves the file. os.path.join
    # + os.path.isfile treats "\\" as a separator on Windows, while
    # send_from_directory goes through werkzeug's safe_join, which rejects any
    # component containing a backslash on that platform. So on Windows
    # `GET /files/..%5Capp.py` passed this guard (the file really is there),
    # charged 14 heat, and only then got refused by safe_join — the exact
    # traversal-fuzzing containment described above, back again on one OS.
    # Nothing is ever disclosed; safe_join holds. But nine backslash probes and
    # the run is over.
    target = safe_join(FILES_DIR, fname)
    if target is None or not os.path.isfile(target):
        abort(404)
    if note_stage("file:" + fname):
        raise_heat("share_loot",
                   f"Sensitive file '{fname}' read from {TARGET_FS} by a non-privileged account.",
                   stage="Lateral Movement")
    return send_from_directory(FILES_DIR, fname, as_attachment=False)


# --------------------------------------------------------------------------- #
#  Stage 4 / 5 - Foothold + Exfil  (console needs FLAG-3; vault needs FLAG-4)
# --------------------------------------------------------------------------- #
@app.route("/console", methods=["GET"])
@require_stage(4)
def console():
    p = progress()
    return render_template("console.html", title=APP_TITLE, p=p,
                           svc_user=SVC_USER,
                           attempts_left=p.get("ssh_attempts", SSH_MAX),
                           authed=p.get("shell", False))


@app.route("/console/auth", methods=["POST"])
@require_player
def console_auth():
    p = progress()
    if not stage_unlocked(4):
        return jsonify(ok=False, msg="ssh: stage locked. Submit FLAG-3 first.")
    hold = held()
    if hold:
        # A throttled session cannot even reach the SSH daemon, and the attempt
        # does not count against their three tries.
        return jsonify(ok=False, throttled=True, seconds=hold["seconds"],
                       soc=hold["soc"], title=hold["title"],
                       msg=f"ssh: connect to host {TARGET_HOST} port 22: "
                           f"connection held by security policy ({hold['seconds']}s)")
    u = (request.form.get("username") or "").strip()
    pw = (request.form.get("password") or "").strip()
    if u == SVC_USER and pw == SVC_PASS:
        p["shell"] = True
        session.modified = True
        response = raise_heat("ssh_ok",
                              f"Service account {SVC_USER} opened an interactive SSH session "
                              f"on {TARGET_HOST} outside its maintenance window.",
                              stage="Foothold")
        return jsonify(ok=True, msg=f"Authenticated as {SVC_USER}@{TARGET_HOST}",
                       soc=soc_state(), response=response)
    p["ssh_attempts"] = max(0, p.get("ssh_attempts", SSH_MAX) - 1)
    session.modified = True
    if p["ssh_attempts"] <= 0:
        reason = ("Repeated failed SSH logins on " + TARGET_HOST +
                  " tripped the detection rule. Session terminated.")
        hub.emit("ssh_fail", player=p.get("player"), station=station_id(),
                 detail=f"Final SSH authentication failure against {TARGET_HOST} "
                        f"— lockout threshold of {SSH_MAX} reached.",
                 heat=100.0, posture="CONTAINED", stage="Foothold")
        bust(f"SSH brute-force login detected against {TARGET_HOST}.")
        hub.command(station_id(), "contain", "SOC RESPONSE — SESSION CONTAINED", reason, heat=100)
        return jsonify(ok=False, busted=True,
                       title="SOC ALERT — SSH BRUTE FORCE",
                       reason=reason,
                       msg="ssh: too many authentication failures")
    response = raise_heat("ssh_fail",
                          f"SSH authentication failure {SSH_MAX - p['ssh_attempts']} of {SSH_MAX} "
                          f"against {TARGET_HOST}.",
                          stage="Foothold")
    return jsonify(ok=False, attempts=p["ssh_attempts"],
                   soc=soc_state(), response=response,
                   msg=(f"ssh: access denied "
                        f"({p['ssh_attempts']} attempt(s) left before lockout)"))


# --- privilege-escalation detector for the fake shell -------------------------
PRIVESC_TOKENS = ("-exec", "sudo su", "sudo -i", "sudo -s", "sudo bash",
                  "sudo sh", "sudo /bin/sh", "sudo /bin/bash", "sudo vi",
                  "sudo vim", "sudo nano", "sudo less", "sudo more", "sudo awk",
                  "sudo perl", "sudo python", "sudo env", "sudo nmap")

def is_privesc(key):
    """
    Any sudo is escalation, except the one harmless enumeration.

    This used to require a match in PRIVESC_TOKENS, so the most obvious things a
    visitor types — `sudo cat /etc/shadow`, `sudo -u root /bin/bash`,
    `sudo chmod u+s /bin/bash` — fell through to "command not found" at zero
    heat. The console banner promises "sudo escalation trips the EDR and ends
    your run", so the player got an anticlimax instead of the finale. An
    allowlist of one is the right shape here, not a denylist of eighteen.
    """
    if "-exec" in key:                       # find -exec is escalation too
        return True
    if not key.startswith("sudo"):
        return False
    return key.strip() not in ("sudo -l", "sudo --list", "sudo")


FAKE_FS = {
    "whoami":   lambda: SVC_USER,
    "id":       lambda: f"uid=1001({SVC_USER}) gid=1001({SVC_USER}) groups=1001({SVC_USER}),27(sudo)",
    "hostname": lambda: TARGET_HOST,
    "pwd":      lambda: f"/home/{SVC_USER}",
    "ls":       lambda: "notes.txt   backup.sh   .secret_vault",
    "cat flag.txt":  lambda: FLAGS["FLAG-4"],
    "cat notes.txt": lambda: "TODO: rotate svc_backup password. Vault path hidden in /home. Look for *secret*.",
    "ls -la": lambda: (
        "drwxr-xr-x 3 svc_backup svc_backup 4096 .\n"
        "drwxr-xr-x 4 root       root       4096 ..\n"
        "-rw-r--r-- 1 svc_backup svc_backup   45 flag.txt\n"
        "-rw-r--r-- 1 svc_backup svc_backup  128 notes.txt\n"
        "-rwxr-xr-x 1 svc_backup svc_backup  320 backup.sh\n"
        "drwx------ 2 svc_backup svc_backup 4096 .secret_vault"
    ),
    "sudo -l": lambda: ("User svc_backup may run the following commands on " + TARGET_HOST + ":\n"
                        "    (ALL) NOPASSWD: /usr/bin/find"),
    "help": lambda: "try: whoami, id, ls, ls -la, cat flag.txt, cat notes.txt, sudo -l, find / -name '*secret*'",
}

VAULT_LOCKED = "[locked] Objective not yet active — submit FLAG-4 on Mission Control to unlock the vault."


@app.route("/console/exec", methods=["POST"])
@require_player
def console_exec():
    p = progress()
    if not p.get("shell"):
        return jsonify(ok=False, out=f"ssh: not authenticated. Login to {TARGET_HOST} first.")

    hold = held()
    if hold:
        return jsonify(ok=False, throttled=True, seconds=hold["seconds"],
                       soc=hold["soc"], title=hold["title"],
                       out=f"[!] connection held for inspection by the SOC "
                           f"({hold['seconds']}s remaining) — command not delivered.")

    payload = request.get_json(silent=True) or {}
    cmd = (payload.get("cmd") or "").strip()
    key = re.sub(r"\s+", " ", cmd)

    if is_privesc(key):
        reason = ("A sudo privilege-escalation attempt on " + TARGET_HOST +
                  " tripped the EDR rule. Session terminated.")
        # Detection, then containment, then the response order - the sequence the
        # crowd needs to read on the wall.
        hub.emit("privesc", player=p.get("player"), station=station_id(),
                 detail=f"sudo abuse via '{cmd[:60]}' on {TARGET_HOST}",
                 heat=100.0, posture="CONTAINED", stage="Privilege Escalation")
        # cmd[:60], matching the hub.emit above. Unbounded, this string went
        # into p["bust_reason"] — which lives in the session COOKIE. 12 KB of
        # incompressible input produced a 12,586-byte Set-Cookie, the browser
        # dropped it, and the player's whole run vanished while the leaderboard
        # had already banked a partial score.
        bust(f"Privilege-escalation attempt detected on {TARGET_HOST} "
             f"(sudo abuse via '{cmd[:60]}').")
        hub.command(station_id(), "contain", "SOC RESPONSE — SESSION CONTAINED", reason, heat=100)
        return jsonify(ok=False, busted=True,
                       title="SOC ALERT — PRIVILEGE ESCALATION",
                       reason=reason,
                       out="[!] sudo: escalation blocked by policy — SOC has been notified.")

    is_vault_find = key in ("find / -name *secret*", "find / -name '*secret*'")
    is_vault_cat  = key.startswith("cat") and "final_flag.txt" in key
    if is_vault_find or is_vault_cat:
        if not has("FLAG-4"):
            return jsonify(ok=True, out=VAULT_LOCKED, soc=soc_state())
        out = ("/home/svc_backup/.secret_vault/final_flag.txt" if is_vault_find
               else FLAGS["FLAG-5"])

        # Charge the SEARCH as a search and the READ as an exfiltration.
        #
        # Both used to cost 40, and neither was de-duplicated, so the two
        # commands a player types seconds apart put 80 heat on a 62 threshold.
        # Measured from a completely cooled session — no wrong passwords, no
        # fumbling — a flawless run was throttled at the climax every single
        # time, at every human pace tested. The tuning comment on HEAT_COST
        # claims a clean run never trips a throttle; this is where that stopped
        # being true. Locating a file discloses nothing; reading it is the act.
        if is_vault_find:
            response = raise_heat(
                "shell_cmd",
                "Filesystem search for hidden vault paths on " + TARGET_HOST + ".",
                stage="Exfiltration")
        elif note_stage("exfil"):
            response = raise_heat(
                "exfil",
                "Crown-jewel vault accessed on " + TARGET_HOST + " — data staged for exfiltration.",
                stage="Exfiltration")
        else:
            response = None          # re-reading the same file is not a second theft

        # If that reading contained the session, this is NOT a successful
        # command. It used to return ok:true with the crown jewel in `out`, so
        # console.html played the flag-captured sound and printed the flag two
        # seconds before the containment overlay arrived — the player could not
        # submit it, but they could read it off the screen and hand it to the
        # next visitor.
        if response and response.get("action") == "contain":
            return jsonify(ok=False, busted=True,
                           title="SOC ALERT — EXFILTRATION BLOCKED",
                           reason=response.get("reason", ""),
                           out="[!] transfer blocked — session contained by the SOC.",
                           soc=soc_state(), response=response)
        return jsonify(ok=True, out=out, soc=soc_state(), response=response)

    out = None
    if key in FAKE_FS:
        out = FAKE_FS[key]()
    elif key.startswith("cat flag"):
        out = FLAGS["FLAG-4"]

    if out is None:
        # A typo is not an intrusion. Unrecognised commands cost nothing, so the
        # heat meter measures what the player did, not how well they type.
        return jsonify(ok=True, out=f"bash: {cmd[:80]}: command not found (type 'help')",
                       soc=soc_state())

    response = raise_heat("shell_cmd",
                          f"Interactive command '{cmd[:60]}' run by {SVC_USER} on {TARGET_HOST}.",
                          stage="Foothold")

    # Shell only PRINTS flags - player copies them to Mission Control to score.
    return jsonify(ok=True, out=out, soc=soc_state(), response=response)


# --------------------------------------------------------------------------- #
#  Flag submission (the ONLY way to score) + status + finish
# --------------------------------------------------------------------------- #
@app.route("/submit", methods=["POST"])
@require_player
def submit():
    if request.is_json:
        # silent=True suppresses parse errors, not type errors: a body of `"x"`,
        # `[1,2]` or `3` parses fine, is truthy, and then throws on .get().
        body = request.get_json(silent=True)
        val = (body if isinstance(body, dict) else {}).get("flag", "")
    else:
        val = request.form.get("flag", "")
    val = (val or "").strip()

    p = progress()

    # F4 — the throttle is enforced here too.
    #
    # held() guarded login, console_auth and console_exec but not /submit, which
    # is the one action the whole game is about. A player under an adaptive
    # throttle — with the wall showing their station red and the overlay up —
    # could keep scoring at full speed from curl, or just by closing the
    # overlay. "The takeover overlay is theatre; this is the part that means it"
    # was only two thirds true.
    hold = held()
    if hold:
        return jsonify(**hold)

    for fid, fval in FLAGS.items():
        if val == fval:
            # F5 — stages unlock in order for POINTS, not only for page access.
            #
            # require_stage guarded the pages; submit() never consulted
            # STAGE_REQUIRES. Anyone who had seen the source, or watched another
            # player's screen, could paste all five flags in two seconds and top
            # the board without visiting a single stage.
            need = STAGE_REQUIRES.get(int(fid.split("-")[1]))
            if need and need not in p["captured"]:
                return jsonify(ok=False, locked=True, flag=fid,
                               msg=f"Locked — capture {need} first.")

            # Evidence of play.
            #
            # The five flag values are constants in this file and never change
            # between players or runs, and the chain check above is satisfied by
            # simply pasting them in order. Measured: five POSTs, 100 points,
            # rank 1, "full clear", 0.02 seconds, without loading a single stage
            # page — and with heat at 0, so the SOC wall showed a full compromise
            # with a blank kill-chain. One visitor reading another's screen was
            # enough to ruin the day's headline artefact.
            #
            # Each flag now requires the thing you must actually have DONE to
            # have found it. The state is already tracked; it was just never
            # consulted at the till.
            gate = PLAY_EVIDENCE.get(fid)
            if gate and not gate[0](p):
                return jsonify(ok=False, locked=True, flag=fid, msg=gate[1])
            # already captured earlier?
            if fid in p["captured"]:
                return jsonify(ok=True, newly=False, already=True, flag=fid,
                               points=p["points"], captured=p["captured"])
            # clock expired?
            if time_left() <= 0:
                return jsonify(ok=False, expired=True,
                               msg="⏱ Time's up — the run has ended.")
            # good capture
            capture(fid)
            done = len(p["captured"]) == len(FLAGS)
            if done:
                # Full compromise -> end the run and bank the score right away.
                p["ended"] = True
                record_score(finished=True)
                hub.emit("run_win", player=p["player"], station=station_id(),
                         title=f"Full compromise of {TARGET_ORG} — crown jewel exfiltrated",
                         detail=f"All five objectives captured in {elapsed()}s. "
                                f"The operator stayed under the detection threshold.",
                         heat=current_heat(), posture="COMPROMISED",
                         stage="Exfiltration", points=p["points"])
                response = None
            else:
                stage_name = STAGE_NAMES.get(fid, "Reconnaissance")
                response = raise_heat(
                    "flag",
                    detail=f"{p['player']} reached objective {fid} of {len(FLAGS)} "
                           f"on {TARGET_ORG}. Kill-chain phase: {stage_name}.",
                    title=f"{stage_name} objective reached on {TARGET_ORG} "
                          f"({len(p['captured'])}/{len(FLAGS)})",
                    stage=stage_name)
            return jsonify(ok=True, newly=True, flag=fid,
                           points=p["points"], captured=p["captured"],
                           done=done, elapsed=elapsed(),
                           soc=soc_state(), response=response)
    return jsonify(ok=False, msg="Not a valid flag.")


@app.route("/status")
@require_player
def status():
    p = progress()
    return jsonify(player=p["player"], points=p["points"],
                   captured=p["captured"], total=len(FLAGS),
                   elapsed=elapsed(), left=time_left(),
                   busted=p.get("busted", False),
                   soc=soc_state())


@app.route("/soc/state")
@require_player
def soc_status():
    """
    Lightweight poll for the heat meter in the nav.

    The takeover overlay is driven by the response to the action that caused it,
    not by this - so a dropped poll costs a slightly stale meter and nothing
    more. It also lets the browser notice a throttle expiring without the player
    having to click something.
    """
    return jsonify(soc_state())


@app.route("/finish")
@require_player
def finish():
    p = progress()
    done = len(p["captured"]) == len(FLAGS)
    already = p.get("saved")
    # Records once (bust / win already recorded on their own; this covers timeout).
    # Mark the run over. finish() banked the score but left the player able to
    # keep going, and record_score is one-shot on p["saved"] — so capturing one
    # flag, visiting /finish, then capturing the other four left the board
    # showing 10 points forever. brief.html auto-navigates here at 00:00, so any
    # player who left a tab open and came back hit exactly this.
    p = progress()
    # Only END the run when it is actually over. finish() used to set ended=True
    # and bank on EVERY visit, so one stray navigation — browser Back from the
    # debrief, the soc.js failsafe, a hub operator command — permanently killed a
    # live run at whatever score it happened to be on, and every later submit
    # silently did nothing.
    over = (time_left() <= 0) or p.get("busted") or done or p.get("ended")
    if over:
        p["ended"] = True
        session.modified = True
        record_score(finished=done)
    if not already and not done and not p.get("busted"):
        hub.emit("run_end", player=p["player"], station=station_id(),
                 title="Adversary session closed — clock expired",
                 detail=f"{len(p['captured'])} of {len(FLAGS)} objectives captured "
                        f"before the ten-minute window closed.",
                 heat=current_heat(), posture="CLEAR", points=p["points"])
    return render_template("finish.html", title=APP_TITLE,
                           p=p, elapsed=elapsed(), done=done, total=len(FLAGS),
                           busted=p.get("busted", False),
                           bust_reason=p.get("bust_reason"))


# --------------------------------------------------------------------------- #
#  Big-screen leaderboard
# --------------------------------------------------------------------------- #
@app.route("/leaderboard")
def leaderboard():
    return render_template("leaderboard.html", title=APP_TITLE)


@app.route("/leaderboard/data")
def leaderboard_data():
    with closing(db()) as con:
        rows = con.execute(
            "SELECT player, points, flags, seconds, finished FROM scores "
            "ORDER BY points DESC, seconds ASC, created_at ASC"
        ).fetchall()

    def fmt(s):
        # max(0, ...): a backwards clock step produced a negative `seconds`,
        # which formatted as "-60:01" on the big screen and sorted ahead of
        # every honest run under ORDER BY seconds ASC.
        s = max(0, int(s or 0))
        return f"{s // 60:02d}:{s % 60:02d}"

    data = [dict(rank=i + 1, player=r["player"], points=r["points"],
                 flags=r["flags"], time=fmt(r["seconds"]),
                 finished=bool(r["finished"])) for i, r in enumerate(rows)]
    return jsonify(data)


@app.route("/admin/reset", methods=["POST"])
def admin_reset():
    """
    Wipe this station's leaderboard.

    Called by the arcade's one CLEAR LEADERBOARDS button so the booth crew can
    reset every board in the show from one place, rather than remembering three.
    Gated by ADMIN_TOKEN with no fallback — unset, it refuses and says so, which
    is the correct behaviour for an endpoint that destroys the day's record.

    It does NOT end anyone's run in progress: a player mid-attempt keeps their
    session and will be written to the fresh board when they finish. Clearing the
    board between visitors is the normal case; killing a live run because someone
    pressed reset on the iPad would not be.
    """
    if not ADMIN_TOKEN:
        return jsonify(ok=False,
                       error="ADMIN_TOKEN is not set on the challenge; reset is disabled."), 503

    supplied = request.headers.get("X-Admin-Token") or ""
    if not supplied and request.is_json:
        body = request.get_json(silent=True)
        supplied = (body if isinstance(body, dict) else {}).get("token") or ""
    # Hash both sides so the comparison takes the same time whatever was sent —
    # no length or prefix oracle on a token that wipes the board.
    if not hmac.compare_digest(
            hashlib.sha256(str(supplied).encode()).digest(),
            hashlib.sha256(ADMIN_TOKEN.encode()).digest()):
        time.sleep(1.0)
        return jsonify(ok=False, error="bad token"), 401

    with closing(db()) as con:
        removed = con.execute("SELECT COUNT(*) AS n FROM scores").fetchone()["n"]
        con.execute("DELETE FROM scores")
        con.commit()
    app.logger.warning("[admin] leaderboard cleared — %s rows removed", removed)
    return jsonify(ok=True, cleared="redteam", rows=removed)


@app.route("/health")
def health():
    return jsonify(status="ok", event=EVENT_NAME,
                   station=DEFAULT_STATION,
                   hub=dict(configured=hub.enabled(), url=hub.HUB_URL, **hub.stats))


init_db()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8000)), debug=False)
