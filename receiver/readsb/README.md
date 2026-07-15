# readsb for the skytrace receiver

The Orange Pi i96 receiver originally ran **dump1090-mutability**, which emits a
legacy `aircraft.json` (`altitude`/`speed`/`vert_rate`, no `type`). The skytrace
server normalizer tolerates those names, but **readsb** is the real upgrade: it
emits the modern format natively (`alt_baro`/`gs`/`type`) and decodes far more
(IAS/TAS/Mach, nav/selected altitude, headings, wind/OAT via Mode-S EHS/MRAR).

readsb isn't packaged for Debian 11 bullseye armhf, and the board (227MB RAM,
no swap) can't build it on-device — so it's **cross-built in CI** and the board
just pulls the binary.

## Build (CI)

`.github/workflows/readsb.yml` cross-builds `Dockerfile` for `linux/arm/v7` on a
`debian:bullseye` base (glibc 2.31, matching the board) and publishes the binary
as a workflow artifact **and** a rolling prerelease `readsb-armhf`. Trigger it
via *Actions → Build readsb → Run workflow*, or by pushing changes here.

Download URL for the board:
`https://github.com/luftaquila/skytrace/releases/download/readsb-armhf/readsb`

The produced binary is `ELF ARM EABI5 (armhf)`, glibc ≤ 2.29, runtime deps
`librtlsdr0 libusb-1.0-0 libzstd1 libncurses6 libtinfo6 zlib1g`.

## Deploy (on the board, as root)

`deploy.sh` installs runtime deps, drops the binary + `readsb.service` +
`/etc/default/readsb`, switches the decoder from dump1090-mutability to readsb,
verifies readsb is producing fresh JSON with RAM headroom (**auto-reverts to
mutability if not**), and points the skytrace agent at `/run/readsb/aircraft.json`.

```sh
# default: download the release asset
sudo bash deploy.sh >/tmp/readsb-deploy.log 2>&1 &
# or with a scp'd binary
sudo READSB_BIN=/tmp/readsb bash deploy.sh >/tmp/readsb-deploy.log 2>&1 &
```

Range is unlimited by design (no receiver location / no `--max-range`) — see
`readsb.default`. The board WiFi is unstable, so run detached and poll the log.
