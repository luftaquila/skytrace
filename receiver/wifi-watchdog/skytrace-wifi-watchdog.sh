#!/bin/bash
# skytrace WiFi watchdog for the Orange Pi i96 (RDA5991 / rdawfmac over SDIO).
#
# The onboard WiFi periodically wedges at the firmware SDIO control channel
# (dmesg: "wland_sdio_bus_rxctl: resumed on timeout") — a total blackout where
# the board is alive locally but can't pass data. This recovers it unattended,
# board-internal, without a human:
#   1. detect a REAL blackout: WAN unreachable, sustained (gateway flaps are
#      noise and are deliberately ignored),
#   2. try a WiFi module reload first (re-inits the firmware, no full reboot),
#   3. reboot only as a backstop if the reload doesn't bring WAN back.
#
# Every action is logged to $LOG so we can tell (over a few days) whether the
# module reload alone is enough, or whether reboots are actually needed.
set -u

WAN="${WAN:-1.1.1.1}"          # external target; if this is unreachable for a
INTERVAL="${INTERVAL:-10}"      # sustained window it's the WiFi, not the gateway.
BLACKOUT="${BLACKOUT:-4}"       # consecutive WAN failures to declare blackout (~40s)
GRACE="${GRACE:-3}"             # extra failures after a reload before rebooting (~30s)
MODULE="${MODULE:-rdawfmac}"
LOG="${LOG:-/var/log/skytrace-wifi-watchdog.log}"
STAMPS="${STAMPS:-/var/lib/skytrace-wifi-watchdog.reboots}"
MAX_REBOOTS_PER_HR="${MAX_REBOOTS_PER_HR:-4}"

log(){ echo "$(date '+%F %T') $*" >> "$LOG"; }
wan_ok(){ ping -c1 -W3 "$WAN" >/dev/null 2>&1; }

reload_module(){
  # Runs backgrounded by the caller so a stuck rmmod can never block the loop
  # (the reboot backstop must still be reachable).
  log "ACTION reload $MODULE (rmmod/modprobe)"
  timeout -k 5 25 rmmod "$MODULE" 2>>"$LOG"; log "  rmmod rc=$?"
  sleep 2
  modprobe "$MODULE" 2>>"$LOG"; log "  modprobe rc=$?"
  sleep 6
  ip link set wlan0 up 2>/dev/null
  systemctl restart wpa_supplicant 2>/dev/null
  sleep 4
  ( dhclient -1 wlan0 || dhcpcd -n wlan0 || systemctl restart networking ) >/dev/null 2>&1 &
  log "  reload sequence issued"
}

can_reboot(){
  now=$(date +%s)
  [ -f "$STAMPS" ] || : > "$STAMPS"
  awk -v n="$now" '$1 > n-3600' "$STAMPS" > "$STAMPS.tmp" 2>/dev/null && mv "$STAMPS.tmp" "$STAMPS"
  [ "$(wc -l < "$STAMPS")" -lt "$MAX_REBOOTS_PER_HR" ]
}

fails=0
reloaded=0
log "watchdog started (WAN=$WAN interval=${INTERVAL}s blackout=$BLACKOUT grace=$GRACE)"
while true; do
  if wan_ok; then
    [ "$fails" -ge "$BLACKOUT" ] && log "RECOVERED (was down ~$((fails*INTERVAL))s, module-reload=$reloaded)"
    fails=0; reloaded=0
  else
    fails=$((fails+1))
    [ $((fails % 4)) -eq 0 ] && log "WAN unreachable x$fails (~$((fails*INTERVAL))s)"
    if [ "$fails" -eq "$BLACKOUT" ] && [ "$reloaded" -eq 0 ]; then
      log "BLACKOUT declared (~$((fails*INTERVAL))s WAN down, gateway noise ignored)"
      reload_module &
      reloaded=1
    elif [ "$reloaded" -eq 1 ] && [ "$fails" -ge $((BLACKOUT + GRACE)) ]; then
      if can_reboot; then
        log "module reload did NOT restore WAN after grace -> REBOOT"
        date +%s >> "$STAMPS"; sync; reboot
      else
        log "still down + reboot rate-limited (>=$MAX_REBOOTS_PER_HR/hr) -> holding (needs hardware/manual)"
        fails=$((BLACKOUT))   # keep re-evaluating without a tight reboot loop
      fi
    fi
  fi
  sleep "$INTERVAL"
done
