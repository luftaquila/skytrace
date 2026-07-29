import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  loadAgentConfig,
  postBatch,
  readAircraftJson,
} from "../bin/skytrace-agent.mjs";

const TOKEN = "0123456789abcdef".repeat(4);

function baseEnv(overrides = {}) {
  return {
    SKYTRACE_SERVER_URL: "https://sky.example.test",
    SKYTRACE_RECEIVER_ID: "rx-1",
    SKYTRACE_TOKEN: TOKEN,
    SKYTRACE_AIRCRAFT_URL: "http://127.0.0.1:8080/data/aircraft.json",
    ...overrides,
  };
}

test("agent configuration strictly bounds intervals, credentials and input sources", () => {
  assert.equal(loadAgentConfig(baseEnv()).intervalMs, 3000);
  for (const value of ["0", "999", "60001", "-1", "1.5", "nan"]) {
    assert.throws(
      () => loadAgentConfig(baseEnv({ SKYTRACE_INTERVAL_MS: value })),
      /SKYTRACE_INTERVAL_MS/,
    );
  }
  assert.throws(
    () => loadAgentConfig(baseEnv({ SKYTRACE_SERVER_URL: "http://192.0.2.1" })),
    /must use HTTPS/,
  );
  assert.throws(
    () => loadAgentConfig(baseEnv({ SKYTRACE_SERVER_URL: "https://user:pass@example.test" })),
    /must not contain credentials/,
  );
  assert.throws(
    () => loadAgentConfig(baseEnv({ SKYTRACE_SERVER_URL: "file:///tmp/server" })),
    /HTTP or HTTPS/,
  );
  assert.throws(
    () => loadAgentConfig(baseEnv({ SKYTRACE_ALLOW_INSECURE_SERVER: "true" })),
    /must be 1/,
  );
  assert.throws(
    () => loadAgentConfig(baseEnv({ SKYTRACE_AIRCRAFT_FILE: "/tmp/aircraft.json" })),
    /exactly one/,
  );
  assert.throws(
    () => loadAgentConfig(baseEnv({ SKYTRACE_AIRCRAFT_URL: "" })),
    /exactly one/,
  );
  assert.throws(
    () => loadAgentConfig(baseEnv({ SKYTRACE_RECEIVER_PUBLIC_POSITION: "1" })),
    /was removed/,
  );
  assert.throws(
    () => loadAgentConfig(baseEnv({ SKYTRACE_TOKEN: "short" })),
    /at least 32/,
  );
  assert.match(loadAgentConfig(baseEnv()).ingestUrl, /\/api\/ingest\/readsb$/);
  assert.match(
    loadAgentConfig(baseEnv({ SKYTRACE_SERVER_URL: "http://localhost:3000/base/" })).ingestUrl,
    /^http:\/\/localhost:3000\/base\/api\/ingest\/readsb$/,
  );
});

test("agent URL reads reject redirects, oversized bodies and time out", async () => {
  await assert.rejects(
    readAircraftJson({
      aircraftUrl: "http://127.0.0.1/aircraft.json",
      fetchImpl: async () => new Response(null, { status: 302, headers: { location: "https://evil.test" } }),
    }),
    /redirected/,
  );
  await assert.rejects(
    readAircraftJson({
      aircraftUrl: "http://127.0.0.1/aircraft.json",
      fetchImpl: async () => new Response("{}", {
        status: 200,
        headers: { "content-length": String(9 * 1024 * 1024) },
      }),
    }),
    /too large/,
  );
  await assert.rejects(
    readAircraftJson({
      aircraftUrl: "http://127.0.0.1/aircraft.json",
      aircraftTimeoutMs: 5,
      fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
    }),
    (error) => error.name === "AbortError",
  );
});

test("agent file and ingest responses have byte caps and redirects never receive a retry", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skytrace-agent-"));
  try {
    const oversized = path.join(dir, "aircraft.json");
    const handle = await fs.open(oversized, "w");
    await handle.truncate(9 * 1024 * 1024);
    await handle.close();
    await assert.rejects(
      readAircraftJson({ aircraftFile: oversized }),
      /too large/,
    );

    let requests = 0;
    const config = {
      ingestUrl: "https://sky.example.test/api/ingest/readsb",
      token: TOKEN,
      receiver: { id: "rx-1" },
      fetchImpl: async (_url, init) => {
        requests += 1;
        assert.equal(init.redirect, "manual");
        assert.equal(init.headers.authorization, `Bearer ${TOKEN}`);
        return new Response(null, { status: 307, headers: { location: "https://evil.test" } });
      },
    };
    await assert.rejects(postBatch(config, { aircraft: [] }), /redirect refused/);
    assert.equal(requests, 1);

    await assert.rejects(
      postBatch({
        ...config,
        fetchImpl: async () => new Response("{}", {
          status: 200,
          headers: { "content-length": String(2 * 1024 * 1024) },
        }),
      }, { aircraft: [] }),
      /too large/,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
