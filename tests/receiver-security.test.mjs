import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const install = fs.readFileSync(new URL("../receiver/readsb/install.sh", import.meta.url), "utf8");
const service = fs.readFileSync(new URL("../receiver/skytrace-agent.service", import.meta.url), "utf8");
const readsbService = fs.readFileSync(new URL("../receiver/readsb/readsb.service", import.meta.url), "utf8");

test("readsb build is commit-pinned, race-safe and unprivileged", () => {
  assert.match(install, /READSB_COMMIT=.*[0-9a-f]{40}/);
  assert.match(install, /READSB_COMMIT.*\^\[0-9a-f\]\{40\}/);
  assert.match(install, /mktemp -d \/var\/tmp\/readsb-build\.XXXXXX/);
  assert.match(install, /runuser -u readsb-build[\s\S]*make -C/);
  assert.match(install, /pkill -KILL -u readsb-build/);
  assert.match(
    install,
    /if \[ ! -f "\$SOURCE_DIR\/readsb" \] \|\| \[ -L "\$SOURCE_DIR\/readsb" \]; then/,
  );
  assert.match(install, /runuser -u readsb-build -- \/usr\/local\/bin\/readsb --version/);
  assert.doesNotMatch(install, /^\s*\/usr\/local\/bin\/readsb --version/m);
  assert.doesNotMatch(install, /rm -rf \/tmp\/readsb-src/);
  assert.doesNotMatch(install, /git clone --depth 1 (?!.*commit)/);
});

test("receiver secrets and the agent service fail closed", () => {
  assert.match(install, /install -o root -g root -m 0600 .*readsb\.default/);
  assert.match(install, /chmod 0600 \/etc\/default\/readsb/);
  assert.match(service, /EnvironmentFile=\/etc\/skytrace-agent\.env/);
  assert.match(service, /NoNewPrivileges=yes/);
  assert.match(service, /ProtectSystem=strict/);
  assert.match(service, /UMask=0077/);
  assert.match(service, /^ReadOnlyPaths=-\/run\/readsb$/m);
  assert.doesNotMatch(service, /^ReadWritePaths=/m);
});

test("readsb is confined without blocking USB access or shared JSON output", () => {
  for (const setting of [
    "NoNewPrivileges=yes",
    "ProtectSystem=strict",
    "ReadWritePaths=/run/readsb",
    "ProtectHome=yes",
    "PrivateTmp=yes",
    "ProtectKernelTunables=yes",
    "ProtectKernelModules=yes",
    "ProtectControlGroups=yes",
    "RestrictSUIDSGID=yes",
    "LockPersonality=yes",
  ]) {
    assert.match(readsbService, new RegExp(`^${setting}$`, "m"));
  }
  assert.doesNotMatch(readsbService, /^PrivateDevices=/m);
  assert.doesNotMatch(readsbService, /^UMask=/m);
  assert.doesNotMatch(readsbService, /^SystemCallFilter=/m);
  assert.doesNotMatch(readsbService, /^RestrictAddressFamilies=/m);
});
