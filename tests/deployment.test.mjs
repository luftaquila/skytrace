import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const compose = read("compose.yml");
const serverEnv = read(".env.example");
const receiverEnv = read("receiver/skytrace-agent.env.example");
const viteConfig = read("web/vite.config.js");
const dockerfile = read("Dockerfile");

test("one Compose file is the entire Docker and Podman server contract", () => {
  assert.equal(fs.existsSync(path.join(root, "scripts/skytrace-container")), false);
  assert.match(compose, /image: \$\{SKYTRACE_IMAGE:\?set exact SKYTRACE_IMAGE in \.env\}/);
  assert.doesNotMatch(compose, /container_name:/);
  assert.match(compose, /target: 3000/);
  assert.match(compose, /published: "\$\{SKYTRACE_PORT:-3000\}"/);
  assert.match(compose, /host_ip: "\$\{SKYTRACE_BIND:-127\.0\.0\.1\}"/);
  assert.match(compose, /name: \$\{SKYTRACE_VOLUME:-skytrace-data\}/);
  assert.match(compose, /profiles: \[ops\][\s\S]*backup written to/);
  assert.match(compose, /restore volume is not empty; select a new SKYTRACE_VOLUME/);
  assert.match(compose, /backup path escapes SKYTRACE_BACKUP_DIR/);
  assert.match(compose, /restore path escapes SKYTRACE_BACKUP_DIR/);
  assert.match(compose, /restore archive contains an unsafe path/);
  assert.match(compose, /restore archive contains an unsafe entry type/);
  assert.match(compose, /read_only: true/);
  assert.equal((compose.match(/selinux: Z/g) || []).length, 2);
  assert.doesNotMatch(compose, /(?:^|:)80(?::|$)|(?:^|:)443(?::|$)/m);
  assert.equal(fs.existsSync(path.join(root, "Caddyfile")), false);
  assert.match(dockerfile, /org\.opencontainers\.image\.licenses=GPL-3\.0-only/);
  assert.match(dockerfile, /COPY LICENSE \.\//);
  assert.doesNotMatch(dockerfile, /COPY bin\/ bin\//);
});

test("server and receiver release configuration align", () => {
  const receiverTokens = JSON.parse(serverEnv.match(/^SKYTRACE_RECEIVER_TOKENS=(.+)$/m)?.[1]);
  const receiverId = Object.keys(receiverTokens)[0];
  assert.equal(receiverId, "roof-01");
  assert.match(receiverEnv, new RegExp(`^SKYTRACE_RECEIVER_ID=${receiverId}$`, "m"));
  assert.match(serverEnv, /^SKYTRACE_IMAGE=ghcr\.io\/luftaquila\/skytrace@sha256:/m);
  assert.match(serverEnv, /^SKYTRACE_VOLUME=skytrace-data$/m);
  assert.match(serverEnv, /^SKYTRACE_BACKUP_DIR=\.\/backups$/m);
  assert.doesNotMatch(serverEnv, /^SKYTRACE_(?:VERSION|RECEIVER_ID|TOKEN)=/m);
});

test("development defaults to the self-hosted backend instead of an operator instance", () => {
  assert.match(
    viteConfig,
    /process\.env\.SKYTRACE_DEV_API_TARGET \|\| "http:\/\/127\.0\.0\.1:3000"/,
  );
  assert.doesNotMatch(viteConfig, /sky\.luftaquila\.io|luftapfel|\.ts\.net|allowedHosts/);
});
