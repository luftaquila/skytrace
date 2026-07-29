#!/usr/bin/env node
import fs from "node:fs/promises";
import net from "node:net";
import { pathToFileURL } from "node:url";
import { readResponseJson } from "../src/stream-limit.mjs";
import { sanitizeReceiverId } from "../src/normalize-readsb.mjs";

const MAX_AIRCRAFT_BYTES = 8 * 1024 * 1024;
const MAX_INGEST_RESPONSE_BYTES = 1024 * 1024;
const AIRCRAFT_TIMEOUT_MS = 10000;
const INGEST_TIMEOUT_MS = 15000;

function requiredEnv(env, key) {
  if (!env[key]) throw new Error(`${key} is required`);
  return env[key];
}

function optionalCoordinate(value, min, max, key) {
  if (value == null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new Error(`${key} is invalid`);
  }
  return number;
}

function strictInterval(value) {
  const raw = value == null || value === "" ? "3000" : String(value);
  if (!/^\d+$/.test(raw)) throw new Error("SKYTRACE_INTERVAL_MS must be an integer");
  const interval = Number(raw);
  if (!Number.isSafeInteger(interval) || interval < 1000 || interval > 60000) {
    throw new Error("SKYTRACE_INTERVAL_MS must be from 1000 to 60000");
  }
  return interval;
}

function loopback(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "::1") return true;
  return net.isIP(host) === 4 && host.split(".")[0] === "127";
}

function parseServerUrl(env) {
  let url;
  try {
    url = new URL(requiredEnv(env, "SKYTRACE_SERVER_URL"));
  } catch {
    throw new Error("SKYTRACE_SERVER_URL is invalid");
  }
  if (url.username || url.password) throw new Error("SKYTRACE_SERVER_URL must not contain credentials");
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("SKYTRACE_SERVER_URL must use HTTP or HTTPS");
  }
  if (env.SKYTRACE_ALLOW_INSECURE_SERVER && env.SKYTRACE_ALLOW_INSECURE_SERVER !== "1") {
    throw new Error("SKYTRACE_ALLOW_INSECURE_SERVER must be 1 when set");
  }
  if (url.protocol === "http:" && !loopback(url.hostname) && env.SKYTRACE_ALLOW_INSECURE_SERVER !== "1") {
    throw new Error("SKYTRACE_SERVER_URL must use HTTPS");
  }
  if (url.protocol === "http:" && !loopback(url.hostname)) {
    console.warn("Skytrace agent is using explicitly allowed insecure HTTP transport");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/api/ingest/readsb`;
  url.search = "";
  url.hash = "";
  return url;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout(timeoutMs, operation) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await operation(controller);
  } finally {
    clearTimeout(timer);
  }
}

export async function readAircraftJson(config) {
  if (config.aircraftUrl) {
    return withTimeout(config.aircraftTimeoutMs ?? AIRCRAFT_TIMEOUT_MS, async (controller) => {
      const response = await config.fetchImpl(config.aircraftUrl, {
        cache: "no-store",
        redirect: "manual",
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) throw new Error("aircraft source redirected");
      if (!response.ok) throw new Error(`aircraft source HTTP ${response.status}`);
      return readResponseJson(response, MAX_AIRCRAFT_BYTES, { abort: () => controller.abort() });
    });
  }

  const stat = await fs.stat(config.aircraftFile);
  if (!stat.isFile() || stat.size > MAX_AIRCRAFT_BYTES) throw new Error("aircraft file is invalid or too large");
  const bytes = await fs.readFile(config.aircraftFile);
  if (bytes.byteLength > MAX_AIRCRAFT_BYTES) throw new Error("aircraft file is too large");
  return JSON.parse(bytes.toString("utf8"));
}

export async function postBatch(config, aircraftPayload) {
  const body = JSON.stringify({
    receiver: config.receiver,
    payload: aircraftPayload,
  });
  if (Buffer.byteLength(body) > MAX_AIRCRAFT_BYTES) throw new Error("ingest batch is too large");
  return withTimeout(config.ingestTimeoutMs ?? INGEST_TIMEOUT_MS, async (controller) => {
    const response = await config.fetchImpl(config.ingestUrl, {
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.token}`,
        "x-skytrace-receiver": config.receiver.id,
      },
      body,
    });
    if (response.status >= 300 && response.status < 400) throw new Error("ingest redirect refused");
    if (!response.ok) throw new Error(`ingest HTTP ${response.status}`);
    return readResponseJson(response, MAX_INGEST_RESPONSE_BYTES, { abort: () => controller.abort() });
  });
}

export function loadAgentConfig(env = process.env, fetchImpl = fetch) {
  if (env.SKYTRACE_RECEIVER_PUBLIC_POSITION != null && env.SKYTRACE_RECEIVER_PUBLIC_POSITION !== "") {
    throw new Error("SKYTRACE_RECEIVER_PUBLIC_POSITION was removed");
  }
  const receiverId = sanitizeReceiverId(requiredEnv(env, "SKYTRACE_RECEIVER_ID"));
  if (!receiverId) throw new Error("SKYTRACE_RECEIVER_ID is invalid");
  const token = requiredEnv(env, "SKYTRACE_TOKEN");
  if (token.length < 32) throw new Error("SKYTRACE_TOKEN must be at least 32 characters");
  const aircraftUrl = env.SKYTRACE_AIRCRAFT_URL || "";
  const aircraftFile = env.SKYTRACE_AIRCRAFT_FILE || "";
  if (Boolean(aircraftUrl) === Boolean(aircraftFile)) {
    throw new Error("set exactly one of SKYTRACE_AIRCRAFT_URL or SKYTRACE_AIRCRAFT_FILE");
  }
  return {
    ingestUrl: parseServerUrl(env).toString(),
    token,
    intervalMs: strictInterval(env.SKYTRACE_INTERVAL_MS),
    aircraftUrl,
    aircraftFile,
    fetchImpl,
    receiver: {
      id: receiverId,
      name: env.SKYTRACE_RECEIVER_NAME || receiverId,
      publicName: env.SKYTRACE_RECEIVER_PUBLIC_NAME || env.SKYTRACE_RECEIVER_NAME || receiverId,
      lat: optionalCoordinate(env.SKYTRACE_RECEIVER_LAT, -90, 90, "SKYTRACE_RECEIVER_LAT"),
      lon: optionalCoordinate(env.SKYTRACE_RECEIVER_LON, -180, 180, "SKYTRACE_RECEIVER_LON"),
    },
  };
}

export async function runOnce(config) {
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

function errorClass(error) {
  if (error?.name === "AbortError") return "timeout";
  if (/HTTP \d+/.test(error?.message || "")) return error.message.match(/HTTP \d+/)[0];
  if (/too large/.test(error?.message || "")) return "body-too-large";
  return "request-failed";
}

async function main() {
  const once = process.argv.includes("--once");
  const config = loadAgentConfig();
  let failures = 0;
  do {
    try {
      await runOnce(config);
      failures = 0;
    } catch (error) {
      failures += 1;
      console.error(`[${new Date().toISOString()}] ${errorClass(error)}`);
      if (once) process.exitCode = 1;
    }
    if (!once) {
      const backoff = Math.min(300000, config.intervalMs * 2 ** Math.min(failures, 6));
      const jitter = Math.floor(backoff * 0.2 * Math.random());
      await sleep(backoff + jitter);
    }
  } while (!once);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`skytrace-agent: startup failed: ${error?.message || "unknown error"}`);
    process.exit(1);
  });
}
