#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
GISEC Arena Hub client for the Red Team Challenge.

Every meaningful thing a player does at a laptop station - a failed password, a
looted share, a sudo attempt, a captured flag - is mirrored to the Arena Hub so
the big-screen SOC Wall can plot it on the globe, correlate it, and show the SOC
responding to it in front of the crowd.

Three rules govern this module, and they exist because it runs on a show floor:

  1. IT NEVER BLOCKS.      Posts go onto a queue and a daemon thread drains it.
                           A request handler never waits on the network.
  2. IT NEVER RAISES.      Every failure is swallowed and counted. If the hub is
                           down, unreachable, or was never configured, the game
                           plays exactly as it does today.
  3. IT NEVER BACKS UP.    The queue is bounded and drops the oldest event when
                           full, so an unreachable hub cannot grow memory for
                           eight hours.

Standard library only - no new entries in requirements.txt.

Configure with environment variables:

    HUB_URL     http://192.168.1.50:7788    (unset = disabled, game unaffected)
    STATION_ID  LAPTOP-01                   (default station for this instance)

DMATICS IT Solutions LLC - Dubai
"""

import atexit
import json
import os
import queue
import threading
import urllib.error
import urllib.request

HUB_URL = (os.environ.get("HUB_URL") or "").rstrip("/")

# Shared secret for /api/command, which is the endpoint that can end a visitor's
# run. The hub gates that endpoint whenever ITS OWN ADMIN_TOKEN is set, so this
# has to match or the SOC's containment silently stops reaching the wall. Both
# unset is the booth default and still works — the hub falls back to refusing
# cross-origin browser requests, which is the drive-by case that actually
# matters on a show floor.
HUB_TOKEN = os.environ.get("HUB_TOKEN", "").strip()
DEFAULT_STATION = (os.environ.get("STATION_ID") or "LAPTOP-01").upper()
TIMEOUT = float(os.environ.get("HUB_TIMEOUT", "2.0"))
QUEUE_MAX = 500

_queue: "queue.Queue[tuple]" = queue.Queue(maxsize=QUEUE_MAX)
_worker = None
_lock = threading.Lock()

stats = {"sent": 0, "failed": 0, "dropped": 0}


def enabled() -> bool:
    """True when a hub address is configured. Everything else no-ops without it."""
    return bool(HUB_URL)


def _post(path: str, payload: dict) -> None:
    request = urllib.request.Request(
        HUB_URL + path,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
        response.read(1)


def _drain() -> None:
    while True:
        path, payload = _queue.get()
        try:
            _post(path, payload)
            stats["sent"] += 1
        except (urllib.error.URLError, OSError, ValueError):
            # A booth network drops packets. Losing a telemetry event costs the
            # wall one arc; retrying would cost the player a stalled request.
            stats["failed"] += 1
        finally:
            _queue.task_done()


def _ensure_worker() -> None:
    global _worker
    if _worker is not None:
        return
    with _lock:
        if _worker is not None:
            return
        _worker = threading.Thread(target=_drain, name="hub-emitter", daemon=True)
        _worker.start()


def _submit(path: str, payload: dict) -> None:
    if not enabled():
        return
    _ensure_worker()
    try:
        _queue.put_nowait((path, payload))
    except queue.Full:
        # Shed the oldest rather than the newest: on a wall, the most recent
        # event is the one the crowd is looking for.
        try:
            _queue.get_nowait()
            _queue.task_done()
            _queue.put_nowait((path, payload))
            stats["dropped"] += 1
        # Full as well as Empty. The inner put_nowait can itself fail when two
        # request threads race the shed-oldest path, and that exception used to
        # propagate out through raise_heat into the view — a 500 mid-game, from
        # the one module whose stated rule is "IT NEVER RAISES".
        except Exception:
            stats["dropped"] += 1


# --------------------------------------------------------------------------- #
#  Public API
# --------------------------------------------------------------------------- #
def emit(kind, player=None, station=None, title=None, detail=None,
         heat=0, posture=None, stage=None, points=None, contained=False):
    """Send one booth event to the hub. Returns immediately."""
    _submit("/api/events", {
        "source": "redteam",
        "kind": kind,
        "station": (station or DEFAULT_STATION),
        "player": player or "OPERATOR",
        "title": title,
        "detail": detail,
        "heat": round(float(heat or 0), 1),
        "posture": posture,
        "stage": stage,
        "points": points,
        "contained": bool(contained),
    })


def score(player, points, flags, seconds, finished, station=None):
    """Publish a finished run to the unified arena leaderboard."""
    _submit("/api/scores", {
        "game": "redteam",
        "player": player or "OPERATOR",
        "points": int(points or 0),
        "station": (station or DEFAULT_STATION),
        "meta": {
            "flags": int(flags or 0),
            "seconds": int(seconds or 0),
            "finished": bool(finished),
        },
    })


def command(station, action, title=None, reason=None, seconds=0, heat=0,
            notify_station=False):
    """
    Tell the wall that the SOC has acted on a station.

    `notify_station` stays False by default and that is deliberate. The station's
    own browser already learns about the response in the HTTP reply that
    triggered it, which is the path that keeps working when the hub is down.
    Pushing it down the station's SSE channel as well would fire the takeover
    twice. Set it True only when issuing a response from outside the game - for
    example a booth operator manually containing a station from the wall.
    """
    _submit("/api/command", {
        "token": HUB_TOKEN,
        "station": (station or DEFAULT_STATION),
        "action": action,
        "title": title,
        "reason": reason,
        "seconds": int(seconds or 0),
        "heat": round(float(heat or 0), 1),
        "notifyStation": bool(notify_station),
    })


def _flush_on_exit() -> None:
    if not enabled():
        return
    # Bounded. Each queued POST costs up to HUB_TIMEOUT against a blackholed
    # host, so a full 500-item queue meant _queue.join() blocking for ~1000
    # seconds — under Ctrl-C the process simply hung until someone killed it.
    try:
        waiter = threading.Thread(target=_queue.join, daemon=True)
        waiter.start()
        waiter.join(3.0)
    except Exception:
        pass


atexit.register(_flush_on_exit)
