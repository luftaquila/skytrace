# readsb for the skytrace receiver

[readsb](https://github.com/wiedehopf/readsb) is the ADS-B decoder: it emits
the modern `aircraft.json` format natively (`alt_baro`/`gs`/`type`) and decodes
far more than dump1090 variants (IAS/TAS/Mach, nav/selected altitude, headings,
wind/OAT via Mode-S EHS/MRAR).

readsb isn't packaged for Debian, and the ODROID-C2 (4 cores, 2GB RAM) builds
it on-device in a couple of minutes — no cross-build needed.

## Install (on the board, as root)

```sh
bash install.sh                    # wiedehopf/readsb default branch
READSB_REF=v3.14.16 bash install.sh
```

`install.sh` installs build/runtime deps, blacklists the `dvb_usb_rtl28xxu`
kernel module, builds readsb from source, creates the unprivileged `readsb`
user (group `plugdev`, plus a udev rule for the dongle), installs
`readsb.service` + `/etc/default/readsb`, and enables the service. An existing
`/etc/default/readsb` is left untouched, so board-local options (feed
connectors) survive reinstalls.

## Configuration

Range is unlimited by design (no receiver location / no `--max-range`) — see
the rationale in `readsb.default`. `--net` serves beast output on
`localhost:30005` for a piaware relay; aggregator feeds are extra
`--net-connector` entries added on the board only.
