#!/bin/bash
# skytrace receiver watchdog for the Orange Pi i96. Two independent, unattended
# self-heals (board-internal, no human):
#
# A) WiFi blackout (RDA5991/rdawfmac SDIO firmware wedge — dmesg
#    "wland_sdio_bus_rxctl: resumed on timeout"): board alive but can't pass data.
#      1. detect a REAL blackout: WAN unreachable, sustained (gateway flaps are
#         noise and are deliberately ignored),
#      2. reload the WiFi module first (re-inits firmware, no reboot),
#      3. reboot only as a backstop if that doesn't bring WAN back (rate-limited).
#
# B) readsb SDR stream stall (RTL-SDR USB sample stream dies — dmesg
#    "Lost N packets on USB" degrading to a full stop): readsb stays "active" and
#    the board stays online, but it reads 0 samples -> 0 messages -> 0 aircraft.
#    WAN is fine so (A) never fires. Detected directly via readsb's
#    samples_processed (traffic-independent, unlike message count); recovered by
#    restarting readsb, which re-opens the dongle (no reboot).
#
# Every action is logged to $LOG.
set -u

WAN="${WAN:-1.1.1.1}"          # external target; if this is unreachable for a
INTERVAL="${INTERVAL:-10}"      # sustained window it's the WiFi, not the gateway.
BLACKOUT="${BLACKOUT:-4}"       # consecutive WAN failures to declare blackout (~40s)
GRACE="${GRACE:-3}"             # extra failures after a reload before rebooting (~30s)
MODULE="${MODULE:-rdawfmac}"
LOG="${LOG:-/var/log/skytrace-wifi-watchdog.log}"
STAMPS="${STAMPS:-/var/lib/skytrace-wifi-watchdog.reboots}"
MAX_REBOOTS_PER_HR="${MAX_REBOOTS_PER_HR:-4}"
STATS="${STATS:-/run/readsb/stats.json}"
SDR_FAILS="${SDR_FAILS:-4}"     # consecutive checks with 0 samples before restarting readsb (~40s)
SDR_COOLDOWN="${SDR_COOLDOWN:-90}"  # skip SDR check for this long after a watchdog readsb restart (warmup)

log(){ echo "$(date '+%F %T') $*" >> "$LOG"; }
wan_ok(){ ping -c1 -W3 "$WAN" >/dev/null 2>&1; }
# samples_processed over the last minute; -1 if stats unreadable (skip, don't penalize)
sdr_samples(){ python3 -c "import json;print(json.load(open('$STATS')).get('last1min',{}).get('local',{}).get('samples_processed',-1))" 2>/dev/null || echo -1; }

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
sdr_fails=0
sdr_ok_after=0
log "watchdog started (WAN=$WAN interval=${INTERVAL}s blackout=$BLACKOUT grace=$GRACE sdr_fails=$SDR_FAILS)"
while true; do
  # --- (A) WiFi blackout: WAN reachability ---
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

  # --- (B) readsb SDR stream stall: samples must keep flowing while readsb runs ---
  if [ "$(date +%s)" -ge "$sdr_ok_after" ] && systemctl is-active --quiet readsb; then
    sp=$(sdr_samples)
    case "$sp" in
      ''|-1|*[!0-9]*) : ;;                       # unreadable/non-numeric -> skip, don't penalize
      0)
        sdr_fails=$((sdr_fails+1))
        [ $((sdr_fails % 2)) -eq 0 ] && log "readsb SDR: 0 samples x$sdr_fails (~$((sdr_fails*INTERVAL))s)"
        if [ "$sdr_fails" -ge "$SDR_FAILS" ]; then
          log "SDR STREAM STALLED (~$((sdr_fails*INTERVAL))s 0 samples, readsb active) -> restart readsb"
          systemctl restart readsb
          sdr_fails=0
          sdr_ok_after=$(( $(date +%s) + SDR_COOLDOWN ))
        fi
        ;;
      *) sdr_fails=0 ;;                           # samples flowing
    esac
  fi

  sleep "$INTERVAL"
done
