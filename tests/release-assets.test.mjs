import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const packageAgent = path.join(root, "scripts/package-agent.sh");
const version = `v${JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version}`;

test("the agent packager emits one self-contained archive", () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "skytrace-agent-release-"));
  try {
    const result = spawnSync(packageAgent, [version, output], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);

    const name = `skytrace-agent-${version}`;
    const archive = path.join(output, `${name}.tar.gz`);
    assert.deepEqual(fs.readdirSync(output), [`${name}.tar.gz`]);

    const listing = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" });
    assert.equal(listing.status, 0, listing.stderr);
    for (const relative of [
      "README.md",
      "LICENSE",
      "bin/skytrace-agent.mjs",
      "src/stream-limit.mjs",
      "src/normalize-readsb.mjs",
      "receiver/skytrace-agent.service",
      "receiver/skytrace-agent.env.example",
    ]) {
      assert.match(listing.stdout, new RegExp(`^${name}/${relative.replaceAll(".", "\\.")}$`, "m"));
    }
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
});

test("the agent packager rejects a version that does not match both packages", () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "skytrace-agent-release-version-"));
  try {
    const result = spawnSync(packageAgent, ["v999.0.0", output], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not match package version/);
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
});
