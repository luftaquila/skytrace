#!/bin/bash
# skytrace receiver watchdog for the Orange Pi i96. Two independent, unattended
# self-heals (board-internal, no human):
#
# A) WiFi blackout (RDA5991/rdawfmac SDIO firmware wedge — dmesg
#    "wland_sdio_bus_rxctl: resumed on timeout"): board alive but can't pass data.
#    Detect a REAL blackout (WAN unreachable, sustained; gateway flaps are noise
#    and are ignored) then REBOOT, rate-limited. NOTE: an earlier version tried a
#    module reload first, but `rmmod rdawfmac` always hangs on the wedged driver
#    (killed after 25s, rc=137) — it only delayed recovery, so it's removed.
#    A soft reboot is the only thing observed to recover this wedge. A 3-min
#    startup grace after boot avoids rebooting before WiFi associates (boot-loop).
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
INTERVAL="${INTERVAL:-5}"       # sustained window it's the WiFi, not the gateway.
BLACKOUT="${BLACKOUT:-4}"       # consecutive WAN failures to declare blackout & reboot (~20s)
MODULE="${MODULE:-rdawfmac}"
LOG="${LOG:-/var/log/skytrace-wifi-watchdog.log}"
STAMPS="${STAMPS:-/var/lib/skytrace-wifi-watchdog.reboots}"
MAX_REBOOTS_PER_HR="${MAX_REBOOTS_PER_HR:-4}"
STARTUP_GRACE="${STARTUP_GRACE:-180}" # don't reboot until uptime>this (3 min) — WiFi needs time to associate after boot (else boot-loop)
STATS="${STATS:-/run/readsb/stats.json}"
SDR_FAILS="${SDR_FAILS:-4}"     # consecutive checks with 0 samples before restarting readsb (~20s)
SDR_COOLDOWN="${SDR_COOLDOWN:-90}"  # skip SDR check for this long after a watchdog readsb restart (warmup)

log(){ echo "$(date '+%F %T') $*" >> "$LOG"; }
wan_ok(){ ping -c1 -W3 "$WAN" >/dev/null 2>&1; }
# samples_processed over the last minute; -1 if stats unreadable (skip, don't penalize)
sdr_samples(){ python3 -c "import json;print(json.load(open('$STATS')).get('last1min',{}).get('local',{}).get('samples_processed',-1))" 2>/dev/null || echo -1; }

can_reboot(){
  now=$(date +%s)
  [ -f "$STAMPS" ] || : > "$STAMPS"
  awk -v n="$now" '$1 > n-3600' "$STAMPS" > "$STAMPS.tmp" 2>/dev/null && mv "$STAMPS.tmp" "$STAMPS"
  [ "$(wc -l < "$STAMPS")" -lt "$MAX_REBOOTS_PER_HR" ]
}

fails=0
sdr_fails=0
sdr_ok_after=0
log "watchdog started (WAN=$WAN interval=${INTERVAL}s blackout=$BLACKOUT sdr_fails=$SDR_FAILS)"
while true; do
  # --- (A) WiFi blackout: WAN reachable? sustained loss => reboot ---
  if wan_ok; then
    [ "$fails" -ge "$BLACKOUT" ] && log "RECOVERED (WAN back after ~$((fails*INTERVAL))s)"
    fails=0
  else
    fails=$((fails+1))
    [ $((fails % 2)) -eq 0 ] && log "WAN unreachable x$fails (~$((fails*INTERVAL))s)"
    if [ "$fails" -ge "$BLACKOUT" ]; then
      up=$(cut -d. -f1 /proc/uptime 2>/dev/null || echo 9999)
      if [ "$up" -lt "$STARTUP_GRACE" ]; then
        # fresh boot — WiFi hasn't associated yet; rebooting now would boot-loop
        [ $((fails % 4)) -eq 0 ] && log "blackout but uptime ${up}s < grace ${STARTUP_GRACE}s (WiFi still coming up) -> wait"
      elif can_reboot; then
        log "BLACKOUT (~$((fails*INTERVAL))s WAN down, gateway noise ignored) -> REBOOT"
        date +%s >> "$STAMPS"; sync; reboot
      else
        log "blackout + reboot rate-limited (>=$MAX_REBOOTS_PER_HR/hr) -> holding (hardware WiFi spell)"
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
