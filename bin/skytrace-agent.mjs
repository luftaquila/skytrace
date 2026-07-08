#!/usr/bin/env node
import fs from "node:fs/promises";

function requiredEnv(env, key) {
  if (!env[key]) throw new Error(`${key} is required`);
  return env[key];
}

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function boolEnv(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readAircraftJson(config) {
  if (config.aircraftUrl) {
    const response = await fetch(config.aircraftUrl, { cache: "no-store" });
    if (!response.ok) throw new Error(`aircraft url returned ${response.status}`);
    return response.json();
  }

  const text = await fs.readFile(config.aircraftFile, "utf8");
  return JSON.parse(text);
}

async function postBatch(config, aircraftPayload) {
  const response = await fetch(config.ingestUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.token}`,
      "x-skytrace-receiver": config.receiver.id,
    },
    body: JSON.stringify({
      receiver: config.receiver,
      payload: aircraftPayload,
    }),
  });

  const body = await response.text();
  if (!response.ok) throw new Error(`ingest returned ${response.status}: ${body}`);
  return JSON.parse(body);
}

function loadAgentConfig(env = process.env) {
  const serverUrl = requiredEnv(env, "SKYTRACE_SERVER_URL").replace(/\/+$/, "");
  const receiverId = requiredEnv(env, "SKYTRACE_RECEIVER_ID");
  const aircraftUrl = env.SKYTRACE_AIRCRAFT_URL || "";
  const aircraftFile = env.SKYTRACE_AIRCRAFT_FILE || "";
  if (!aircraftUrl && !aircraftFile) {
    throw new Error("SKYTRACE_AIRCRAFT_URL or SKYTRACE_AIRCRAFT_FILE is required");
  }

  return {
    ingestUrl: `${serverUrl}/api/ingest/readsb`,
    token: requiredEnv(env, "SKYTRACE_TOKEN"),
    intervalMs: Number.parseInt(env.SKYTRACE_INTERVAL_MS || "5000", 10),
    aircraftUrl,
    aircraftFile,
    receiver: {
      id: receiverId,
      name: env.SKYTRACE_RECEIVER_NAME || receiverId,
      publicName: env.SKYTRACE_RECEIVER_PUBLIC_NAME || env.SKYTRACE_RECEIVER_NAME || receiverId,
      lat: numberOrNull(env.SKYTRACE_RECEIVER_LAT),
      lon: numberOrNull(env.SKYTRACE_RECEIVER_LON),
      publicPosition: boolEnv(env.SKYTRACE_RECEIVER_PUBLIC_POSITION),
    },
  };
}

async function runOnce(config) {
  const aircraftPayload = await readAircraftJson(config);
  const result = await postBatch(config, aircraftPayload);
  console.log(JSON.stringify({
    ok: true,
    receiverId: result.receiverId,
    acceptedCount: result.acceptedCount,
    trackPoints: result.trackPoints,
    receivedAt: result.receivedAt,
  }));
}

async function main() {
  const once = process.argv.includes("--once");
  const config = loadAgentConfig();

  do {
    try {
      await runOnce(config);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] ${err.message}`);
      if (once) process.exitCode = 1;
    }
    if (!once) await sleep(config.intervalMs);
  } while (!once);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
