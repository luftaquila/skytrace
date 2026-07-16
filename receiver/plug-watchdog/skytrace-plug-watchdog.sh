#!/bin/bash
# Skytrace EXTERNAL plug watchdog.
#
# Runs on an always-on machine that shares the board's LAN (NOT on the board).
# It power-cycles the Orange Pi i96 through its Tasmota smart plug when the board
# has been unreachable long enough that the board-INTERNAL watchdog's warm
# reboots have clearly failed to recover it.
#
# WHY THIS EXISTS
#   The i96 WiFi chip (RDA5991 over SDIO) periodically wedges at the firmware
#   level. A warm reboot -- all the board can do to itself -- does NOT cut power
#   to the WiFi chip, so a true firmware wedge SURVIVES the reboot. Measured
#   2026-07-16: warm `reboot -f` = no recovery in 7+ min (the board's own
#   watchdog rebooted -f again and still failed); a cold power-cycle = back in
#   ~58s. So the board-internal watchdog cannot recover a bad spell on its own;
#   only removing power resets the WiFi chip. This external watchdog is that
#   backstop, triggered from a vantage point the wedge cannot take down.
#
# DETECTION (conservative on purpose -- a power-cycle is an unclean SD shutdown)
#   * GATE: the plug must be reachable. If it is not, either the whole LAN is
#     down or the plug is off the network -- our view is untrustworthy and we
#     could not power-cycle anyway, so we skip (never power-cycle blind).
#   * The board is considered UP if ANY of these succeed:
#       - ICMP to its tailscale IP (stable across the board's LAN-IP flip-flops)
#       - ICMP to its last-known LAN IP
#       - the server reports the receiver online with a fresh lastSeenAt
#     Requiring ALL of them to fail before acting makes a false-positive
#     power-cycle very unlikely, while a real WiFi wedge fails all three.
#   * Sustained unreachable for DOWN_SECS -> cold power-cycle via the plug.
#
# SAFETY
#   * COOLDOWN after each cycle lets the cold boot (~58s) finish before we judge
#     "down" again.
#   * CYCLE_CAP consecutive cycles with no recovery in between -> long BACKOFF +
#     a CRITICAL log line. If power-cycling N times did not help, it is not a
#     WiFi wedge (dead board / PSU / plug) and hammering only wears the SD card;
#     a human is needed.
#
# CONFIG comes from the environment -- no addresses are committed here.
#   Required: PLUG_URL, and at least one of BOARD_TS / BOARD_LAN.
#   Optional: SERVER_URL + RECEIVER_NAME (adds the server-online UP signal).
set -u

PLUG_URL="${PLUG_URL:-}"            # Tasmota base URL, e.g. http://a.b.c.d
BOARD_TS="${BOARD_TS:-}"            # board tailscale IP (stable identity)
BOARD_LAN="${BOARD_LAN:-}"          # board LAN IP (may flip-flop across reboots)
SERVER_URL="${SERVER_URL:-}"        # skytrace server base URL (optional UP signal)
RECEIVER_NAME="${RECEIVER_NAME:-}"  # this receiver's name on the server (optional)
POLL="${POLL:-30}"                  # seconds between checks
DOWN_SECS="${DOWN_SECS:-180}"       # sustained unreachable before power-cycling
OFF_SECS="${OFF_SECS:-10}"          # how long to hold power off
COOLDOWN="${COOLDOWN:-180}"         # wait after a cycle before judging down again
STALE="${STALE:-90}"                # server lastSeenAt older than this = not fresh
CYCLE_CAP="${CYCLE_CAP:-4}"         # consecutive futile cycles before backing off
BACKOFF="${BACKOFF:-900}"           # slow-loop interval after CYCLE_CAP (SD/plug guard)
PING_WAIT="${PING_WAIT:-3}"         # per-ping overall timeout (macOS ping -t, seconds)
PYTHON="${PYTHON:-python3}"
LOG="${LOG:-$HOME/Library/Logs/skytrace-plug-watchdog.log}"
DRY_RUN="${DRY_RUN:-0}"             # 1 = detect and log intent, never touch the plug

log(){ echo "$(date '+%F %T') $*" >> "$LOG"; }
die(){ log "FATAL: $*"; echo "FATAL: $*" >&2; exit 1; }

[ -n "$PLUG_URL" ] || die "PLUG_URL unset"
[ -n "$BOARD_TS$BOARD_LAN" ] || die "need BOARD_TS and/or BOARD_LAN"

ping1(){ ping -c1 -t"$PING_WAIT" "$1" >/dev/null 2>&1; }        # macOS: -t = overall timeout(s)
plug(){ curl -s -m 8 "$PLUG_URL/cm?cmnd=Power${1:+%20$1}" 2>/dev/null; }   # ""=query, "Off"/"On"=set

# server_fresh: exit 0 iff the server reports RECEIVER_NAME online with
# lastSeenAt younger than STALE. Best-effort; any failure = "not fresh" (1).
server_fresh(){
  [ -n "$SERVER_URL" ] && [ -n "$RECEIVER_NAME" ] || return 1
  local age
  age=$(curl -s -m 8 "$SERVER_URL/api/receivers/public" 2>/dev/null | \
    RN="$RECEIVER_NAME" "$PYTHON" -c '
import sys, os, json, datetime
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(1)
rs = d if isinstance(d, list) else d.get("receivers", d.get("data", []))
now = datetime.datetime.now(datetime.timezone.utc)
for r in rs:
    if r.get("name") == os.environ["RN"]:
        if not r.get("online"):
            sys.exit(1)
        ls = r.get("lastSeenAt")
        if not ls:
            sys.exit(1)
        t = datetime.datetime.fromisoformat(ls.replace("Z", "+00:00"))
        print(int((now - t).total_seconds()))
        sys.exit(0)
sys.exit(1)
' 2>/dev/null) || return 1
  [ -n "$age" ] && [ "$age" -ge 0 ] && [ "$age" -lt "$STALE" ]
}

board_up(){
  { [ -n "$BOARD_TS" ]  && ping1 "$BOARD_TS"; }  && return 0
  { [ -n "$BOARD_LAN" ] && ping1 "$BOARD_LAN"; } && return 0
  server_fresh
}

power_cycle(){
  if [ "$DRY_RUN" = "1" ]; then
    log "[DRY_RUN] would power-cycle now (Off ${OFF_SECS}s -> On)"
    return 0
  fi
  log "POWER-CYCLE: Off -> $(plug Off)"
  sleep "$OFF_SECS"
  log "POWER-CYCLE: On  -> $(plug On)"
}

DOWN_FAILS=$(( DOWN_SECS / POLL )); [ "$DOWN_FAILS" -lt 1 ] && DOWN_FAILS=1
fails=0        # consecutive polls the board looked down
cycles=0       # consecutive power-cycles with no recovery seen in between
gatemiss=0     # consecutive polls the plug/LAN was unreachable

log "plug-watchdog started (plug=$PLUG_URL ts=${BOARD_TS:-none} lan=${BOARD_LAN:-none} server=${RECEIVER_NAME:-none} down=${DOWN_SECS}s poll=${POLL}s cap=$CYCLE_CAP dry=$DRY_RUN)"
st=$(plug); [ -n "$st" ] && log "plug reachable at start, state=$st" || log "WARNING: plug not reachable at start ($PLUG_URL)"

while true; do
  # --- GATE: plug reachable? (proves our LAN vantage works & we can act) ---
  if [ -z "$(plug)" ]; then
    gatemiss=$((gatemiss+1))
    [ $((gatemiss % 10)) -eq 1 ] && log "plug unreachable ($PLUG_URL) -> skip (LAN/plug down; not judging the board)"
    fails=0
    sleep "$POLL"; continue
  fi
  gatemiss=0

  if board_up; then
    [ "$fails" -ge "$DOWN_FAILS" ] && log "board reachable again"
    [ "$cycles" -gt 0 ] && log "board recovered after $cycles power-cycle(s)"
    fails=0; cycles=0
    sleep "$POLL"; continue
  fi

  # board looked down this poll
  fails=$((fails+1))
  [ $((fails % 2)) -eq 0 ] && log "board unreachable x$fails (~$((fails*POLL))s)"
  if [ "$fails" -ge "$DOWN_FAILS" ]; then
    if [ "$cycles" -ge "$CYCLE_CAP" ]; then
      log "CRITICAL: board still down after $cycles power-cycles -> backing off ${BACKOFF}s. Likely NOT a WiFi wedge (dead board/PSU/plug) -- needs a human."
      sleep "$BACKOFF"; fails=0; cycles=0; continue
    fi
    log "BOARD DOWN ~$((fails*POLL))s (internal warm-reboot watchdog did not recover it) -> COLD POWER-CYCLE"
    power_cycle
    cycles=$((cycles+1)); fails=0
    log "cooldown ${COOLDOWN}s for cold boot before re-checking..."
    sleep "$COOLDOWN"; continue
  fi
  sleep "$POLL"
done
