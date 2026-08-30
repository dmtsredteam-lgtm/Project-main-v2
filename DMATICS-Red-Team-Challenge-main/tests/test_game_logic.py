#!/usr/bin/env python3
"""
Game-logic regression suite for the DMATICS Red Team Challenge.

Every check here is a bug that was actually found and fixed, written as the
behaviour a visitor at the booth should see. Run it before a show:

    python3 tests/test_game_logic.py

No pytest, no fixtures, no network — it drives the app through Flask's test
client against a throwaway SQLite file, and manipulates the session clock so a
ten-minute round can be exercised in a second.

ONE THING TO UNDERSTAND BEFORE EDITING: pace() exists because the SOC is real.
A test that fires nine actions in under a second WILL be throttled, correctly —
that is the mechanic working, not a failure. Any test of normal play has to put
human-sized pauses between actions, which is what pace() simulates.
"""
import os, sys, time, tempfile, sqlite3

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = tempfile.mktemp(suffix=".db")
os.environ.update(SECRET_KEY="x" * 64, DB_PATH=DB, ADMIN_TOKEN="t" * 32)
sys.path.insert(0, ROOT)
import app as A                                                   # noqa: E402

A.init_db()
F = A.FLAGS
PASSED = FAILED = 0


def check(name, condition, detail=""):
    global PASSED, FAILED
    if condition:
        PASSED += 1
        print(f"  \033[32mPASS\033[0m  {name}")
    else:
        FAILED += 1
        print(f"  \033[31mFAIL\033[0m  {name}   {detail}")


def section(title):
    print(f"\n\033[1m{title}\033[0m")


def cl():
    return A.app.test_client()


def sub(c, flag):
    try:
        return c.post("/submit", data={"flag": flag}).get_json() or {}
    except Exception:
        return {}


def pace(c, seconds):
    """A human pause: the hold expires and heat decays, exactly as in real time."""
    with c.session_transaction() as s:
        p = s["p"]
        p["throttled_until"] = 0
        if p.get("heat_at"):
            p["heat_at"] = p["heat_at"] - seconds
        if p.get("throttled_at"):
            p["throttled_at"] = p["throttled_at"] - seconds
        s.modified = True


def age(c, seconds):
    """Move the run's start backwards — i.e. burn clock."""
    with c.session_transaction() as s:
        s["p"]["started_at"] = time.time() - seconds
        s.modified = True


def rows(player=None):
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    q = "SELECT player,points,flags,seconds,finished FROM scores"
    out = [dict(r) for r in (con.execute(q + " WHERE player=?", (player,)) if player
                             else con.execute(q))]
    con.close()
    return out


def play_to_shell(c, name, gap=25):
    """Register and play honestly as far as a shell on the host, at human pace."""
    c.post("/", data={"player": name})
    steps = [
        lambda: c.get("/portal"),
        lambda: c.get("/portal/directory"),
        lambda: sub(c, F["FLAG-1"]),
        lambda: c.post("/portal/login", data={"username": A.VALID_USER, "password": A.VALID_PASS}),
        lambda: sub(c, F["FLAG-2"]),
        lambda: c.get("/dashboard/share"),
        lambda: c.get("/files/passwords.txt"),
        lambda: sub(c, F["FLAG-3"]),
        lambda: c.post("/console/auth", data={"username": A.SVC_USER, "password": A.SVC_PASS}),
        lambda: c.post("/console/exec", json={"cmd": "cat flag.txt"}),
        lambda: sub(c, F["FLAG-4"]),
    ]
    for step in steps:
        step()
        pace(c, gap)
    return c


# ===========================================================================
section("A perfect run scores 100 and is never interrupted")
# ===========================================================================
c = play_to_shell(cl(), "PERFECT")
c.post("/console/exec", json={"cmd": "find / -name '*secret*'"}); pace(c, 25)
vault = c.post("/console/exec", json={"cmd": "cat /home/svc_backup/.secret_vault/final_flag.txt"}).get_json()
pace(c, 5)
final = sub(c, F["FLAG-5"])
check("the vault read returns the flag", F["FLAG-5"] in str(vault.get("out")), vault)
check("the run scores exactly 100", final.get("points") == 100, final)
check("a clean run is never held", c.get("/soc/state").get_json()["throttles"] == 0)
check("the win is banked once", len(rows("PERFECT")) == 1 and rows("PERFECT")[0]["points"] == 100,
      rows("PERFECT"))
check("the row says full clear", rows("PERFECT")[0]["flags"] == 5 and rows("PERFECT")[0]["finished"] == 1)

# ===========================================================================
section("Flags cannot be pasted without playing")
# ===========================================================================
c = cl(); c.post("/", data={"player": "PASTEBOT"})
pasted = [sub(c, F[f"FLAG-{i}"]) for i in range(1, 6)]
check("no paste scores", all(not r.get("newly") for r in pasted), [r.get("points") for r in pasted])
check("the refusal points at the stage", "directory" in pasted[0].get("msg", ""), pasted[0])
check("nothing reaches the board", not rows("PASTEBOT"))
# ...and each gate opens only for the thing that proves you were there
c = cl(); c.post("/", data={"player": "PARTIAL"})
c.get("/portal")                                       # portal, but NOT the directory
check("the portal alone is not enough for FLAG-1", not sub(c, F["FLAG-1"]).get("newly"))
c.get("/portal/directory")
check("the directory is", sub(c, F["FLAG-1"]).get("newly") is True)

# ===========================================================================
section("The clock ends the run wherever the player is")
# ===========================================================================
c = cl(); c.post("/", data={"player": "GHOST"})
c.get("/portal"); c.get("/portal/directory"); sub(c, F["FLAG-1"])
age(c, 900)
c.get("/portal")                                       # any authenticated route
g = rows("GHOST")
check("a walked-away run is banked", len(g) == 1 and g[0]["points"] == 10, g)
check("banked time is inside the round", g and 0 <= g[0]["seconds"] <= A.GAME_SECONDS, g)
expired = sub(c, F["FLAG-2"])
check("an expired submit answers JSON, not a redirect", expired.get("ended") is True, expired)
shell_after = c.post("/console/exec", json={"cmd": "cat flag.txt"})
check("the shell is closed after time", (shell_after.get_json() or {}).get("ended") is True)

# ===========================================================================
section("Nobody's run is silently discarded")
# ===========================================================================
c = cl(); c.post("/", data={"player": "TWICE-A"})
c.get("/portal"); c.get("/portal/directory"); sub(c, F["FLAG-1"])
c.post("/", data={"player": "TWICE-B"})                # next visitor types their handle
check("the previous run is kept", len(rows("TWICE-A")) == 1 and rows("TWICE-A")[0]["points"] == 10,
      rows("TWICE-A"))

c = cl(); c.post("/", data={"player": "STRAY"})
c.get("/portal"); c.get("/portal/directory"); sub(c, F["FLAG-1"])
c.get("/finish")                                       # browser Back, or a stray nav
check("a stray /finish does not end a live run", c.get("/brief").status_code == 200)
pace(c, 25)
c.post("/portal/login", data={"username": A.VALID_USER, "password": A.VALID_PASS}); pace(c, 5)
check("play continues afterwards", sub(c, F["FLAG-2"]).get("newly") is True)
check("nothing was banked early", not rows("STRAY"))

# ===========================================================================
section("A skewed clock cannot take rank 1")
# ===========================================================================
c = cl(); c.post("/", data={"player": "SKEW"})
with c.session_transaction() as s:
    s["p"]["started_at"] = time.time() + 3600          # NTP jump on the booth laptop
    s.modified = True
check("elapsed can never be negative", c.get("/status").get_json()["elapsed"] >= 0)
c.get("/portal"); c.get("/portal/directory"); sub(c, F["FLAG-1"])
age(c, 900); c.get("/brief")
sk = rows("SKEW")
check("banked seconds stay inside the round", sk and 0 <= sk[0]["seconds"] <= A.GAME_SECONDS, sk)

# ===========================================================================
section("The escalation escalates")
# ===========================================================================
c = play_to_shell(cl(), "STUBBORN", gap=1)             # hammering, no pauses
acts, contained = [], False
for _ in range(80):
    with c.session_transaction() as s:                 # they close the overlay and carry on
        s["p"]["throttled_until"] = 0
        s.modified = True
    j = c.post("/console/exec", json={"cmd": "ls -la"}).get_json() or {}
    action = (j.get("response") or {}).get("action")
    if action:
        acts.append(action)
    if action == "contain" or j.get("busted"):
        contained = True
        break
check("a player who never adapts is contained", contained, acts[-6:])
check("after at most three holds", acts.count("throttle") <= A.THROTTLE_LIMIT, acts)
check("posture is CONTAINED", c.get("/soc/state").get_json()["posture"] == "CONTAINED")

c = cl(); c.post("/", data={"player": "FUMBLER"})      # noisy start, then behaves
c.get("/portal"); c.get("/portal/directory"); sub(c, F["FLAG-1"])
for i in range(3):
    pace(c, 2)
    c.post("/portal/login", data={"username": A.VALID_USER, "password": f"wrong{i}"})
struck = c.get("/soc/state").get_json()["throttles"]
pace(c, 400)                                           # six careful minutes
c.post("/portal/login", data={"username": A.VALID_USER, "password": A.VALID_PASS})
check("the fumble registers", struck >= 1, struck)
check("but careful play is forgiven", c.get("/soc/state").get_json()["posture"] != "CONTAINED")

# ===========================================================================
section("The vault: finding is not stealing, and stealing once is once")
# ===========================================================================
c = play_to_shell(cl(), "VAULT")
before = c.get("/soc/state").get_json()["heat"]
found = c.post("/console/exec", json={"cmd": "find / -name '*secret*'"}).get_json()
after_find = c.get("/soc/state").get_json()["heat"]
pace(c, 5)
read = c.post("/console/exec", json={"cmd": "cat /home/svc_backup/.secret_vault/final_flag.txt"}).get_json()
after_read = c.get("/soc/state").get_json()["heat"]
pace(c, 5)
again = c.post("/console/exec", json={"cmd": "cat /home/svc_backup/.secret_vault/final_flag.txt"}).get_json()
check("the search is not treated as exfiltration", after_find - before < 20, (before, after_find))
check("the read is", after_read - after_find > 20, (after_find, after_read))
check("re-reading costs nothing", again.get("response") is None, again.get("response"))

# ===========================================================================
section("Containment blocks, it does not hand over the prize")
# ===========================================================================
c = play_to_shell(cl(), "GREEDY")
with c.session_transaction() as s:                     # park them on the line
    s["p"]["heat"] = A.HEAT_CONTAIN - 5
    s["p"]["heat_at"] = time.time()
    s["p"]["throttles"] = A.THROTTLE_LIMIT + 5
    s["p"]["throttled_until"] = 0
    s.modified = True
blocked = c.post("/console/exec", json={"cmd": "cat /home/svc_backup/.secret_vault/final_flag.txt"}).get_json() or {}
check("the response is a bust", blocked.get("ok") is False and blocked.get("busted") is True, blocked)
check("no flag in the output", F["FLAG-5"] not in str(blocked.get("out")), blocked.get("out"))

# ===========================================================================
section("A held session is really held")
# ===========================================================================
c = cl(); c.post("/", data={"player": "HELD"})
c.get("/portal")
with c.session_transaction() as s:
    s["p"]["throttled_until"] = time.time() + 30
    s.modified = True
refused = c.get("/portal/directory")
check("enumeration is refused during a hold", refused.status_code == 302, refused.status_code)
check("no flag leaks during a hold", F["FLAG-1"] not in refused.get_data(as_text=True))

# ===========================================================================
section("Both screens show the same SOC")
# ===========================================================================
c = play_to_shell(cl(), "SUDOER"); pace(c, 5)
busted = c.post("/console/exec", json={"cmd": "sudo su"}).get_json() or {}
state = c.get("/soc/state").get_json()
check("sudo ends the run", busted.get("busted") is True, busted)
check("the meter agrees with the wall", state["heat"] == 100.0 and state["posture"] == "CONTAINED", state)
check("the poll carries the clock", isinstance(state.get("left"), int) and state.get("total") == A.GAME_SECONDS)

# ===========================================================================
section("Every escalation form is caught")
# ===========================================================================
forms = {}
for command in ["sudo cat /etc/shadow", "sudo -u root /bin/bash", "sudo chmod u+s /bin/bash",
                "sudo su", "sudo -i", r"find / -exec /bin/sh \;"]:
    c2 = play_to_shell(cl(), "ESC" + str(len(forms))); pace(c2, 5)
    forms[command] = bool((c2.post("/console/exec", json={"cmd": command}).get_json() or {}).get("busted"))
check("all of them bust", all(forms.values()), {k: v for k, v in forms.items() if not v})
c3 = play_to_shell(cl(), "LISTER"); pace(c3, 5)
check("sudo -l stays harmless", not (c3.post("/console/exec", json={"cmd": "sudo -l"}).get_json() or {}).get("busted"))

# ===========================================================================
section("Stages still unlock in order")
# ===========================================================================
c = cl(); c.post("/", data={"player": "SKIPPER"})
check("the login page is locked with no flags", c.get("/portal/login").status_code == 302)
check("the console is locked with no flags", c.get("/console").status_code == 302)
check("the share is locked with no flags", c.get("/dashboard/share").status_code == 302)

print(f"\n{'=' * 52}")
print(f"\033[1m{PASSED} passed, {FAILED} failed\033[0m")
sys.exit(1 if FAILED else 0)
