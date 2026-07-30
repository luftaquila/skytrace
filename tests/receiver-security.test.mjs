import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

function parseUnit(relative) {
  const values = new Map();
  let section = "";
  for (const raw of fs.readFileSync(new URL(relative, import.meta.url), "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      section = line.slice(1, -1);
      continue;
    }
    const separator = line.indexOf("=");
    if (separator < 1) throw new Error(`invalid unit directive: ${line}`);
    const key = `${section}.${line.slice(0, separator)}`;
    const entry = values.get(key) || [];
    entry.push(line.slice(separator + 1));
    values.set(key, entry);
  }
  return {
    one(key) {
      const entry = values.get(key) || [];
      assert.equal(entry.length, 1, `${key} must occur once`);
      return entry[0];
    },
    has(key) {
      return values.has(key);
    },
  };
}

test("the agent service confines code and secrets to read-only paths", () => {
  const unit = parseUnit("../receiver/skytrace-agent.service");
  assert.equal(unit.one("Service.EnvironmentFile"), "/etc/skytrace-agent.env");
  assert.equal(unit.one("Service.DynamicUser"), "yes");
  assert.equal(unit.one("Service.NoNewPrivileges"), "yes");
  assert.equal(unit.one("Service.ProtectSystem"), "strict");
  assert.equal(unit.one("Service.ProtectHome"), "yes");
  assert.equal(unit.one("Service.PrivateTmp"), "yes");
  assert.equal(unit.one("Service.UMask"), "0077");
  assert.equal(unit.one("Service.ReadOnlyPaths"), "-/run/readsb");
  assert.equal(unit.has("Service.ReadWritePaths"), false);
});

test("the decoder service exposes only its runtime output directory", () => {
  const unit = parseUnit("../receiver/readsb/readsb.service");
  assert.equal(unit.one("Service.User"), "readsb");
  assert.equal(unit.one("Service.NoNewPrivileges"), "yes");
  assert.equal(unit.one("Service.ProtectSystem"), "strict");
  assert.equal(unit.one("Service.ProtectHome"), "yes");
  assert.equal(unit.one("Service.PrivateTmp"), "yes");
  assert.equal(unit.one("Service.ProtectKernelTunables"), "yes");
  assert.equal(unit.one("Service.ProtectKernelModules"), "yes");
  assert.equal(unit.one("Service.ProtectControlGroups"), "yes");
  assert.equal(unit.one("Service.RestrictSUIDSGID"), "yes");
  assert.equal(unit.one("Service.LockPersonality"), "yes");
  assert.equal(unit.one("Service.ReadWritePaths"), "/run/readsb");
  assert.equal(unit.has("Service.PrivateDevices"), false);
});
