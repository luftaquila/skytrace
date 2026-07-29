// On-demand area traffic, proxied from a community aggregator (adsb.lol / adsb.fi /
// airplanes.live style "v2" APIs). This is NOT a receiver: nothing is ingested or stored — the
// browser asks for whatever region its camera is looking at, and the server answers from a
// short-lived per-area cache so any number of viewers costs the upstream at most one call per
// area per TTL, spaced by a global minimum gap (community APIs ask for ~1 req/s).
//
// The upstream URL is an operator-provided template, e.g.
//   SKYTRACE_AREA_FEED_URL=https://api.adsb.lol/v2/point/{lat}/{lon}/{radius}
// Leaving it unset disables the feature (the route answers 404 and the client backs off).

import net from "node:net";
import { normalizeAircraft } from "./normalize-readsb.mjs";
import { readResponseJson } from "./stream-limit.mjs";

const RADIUS_STEPS_NM = [50, 100, 150, 200, 250];
// Centre rounding buys cache hits across small pans; the bucket slack covers the shift it adds.
const CENTRE_GRID_DEG = 0.25;
const CENTRE_SLACK_NM = 20;
const STALE_GRACE_MS = 60000;
const MAX_CACHED_AREAS = 64;
const UPSTREAM_TIMEOUT_MS = 10000;
const MAX_UPSTREAM_WAIT_MS = 3000;
const MAX_UPSTREAM_BODY_BYTES = 8 * 1024 * 1024;
const MAX_AREA_AIRCRAFT = 2000;
const MAX_AREA_CACHE_ENTRY_BYTES = 4 * 1024 * 1024;
const MAX_AREA_CACHE_BYTES = 64 * 1024 * 1024;

function typedError(status, message, retryAfter = null) {
  return Object.assign(new Error(message), { status, retryAfter });
}

const TEMPLATE_SLOTS = ["{lat}", "{lon}", "{radius}"];

function areaFeedConfigError(detail) {
  return new Error(`invalid SKYTRACE_AREA_FEED_URL: ${detail}`);
}

function replaceSlots(template, [lat, lon, radius]) {
  return template
    .replaceAll("{lat}", lat)
    .replaceAll("{lon}", lon)
    .replaceAll("{radius}", radius);
}

function isLoopback(hostname) {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (normalized === "localhost" || normalized === "localhost.") return true;
  if (net.isIP(normalized) === 4) return normalized.startsWith("127.");
  return net.isIP(normalized) === 6 && normalized === "::1";
}

function validateTemplate(raw) {
  if (raw == null || raw === "") return null;
  const template = String(raw).trim();
  if (!template) throw areaFeedConfigError("must not be blank");

  for (const slot of TEMPLATE_SLOTS) {
    if (template.split(slot).length !== 2) {
      throw areaFeedConfigError(`must contain ${slot} exactly once`);
    }
  }
  const remaining = TEMPLATE_SLOTS.reduce((value, slot) => value.replace(slot, ""), template);
  if (/[{}]/.test(remaining)) throw areaFeedConfigError("contains an unsupported placeholder");

  try {
    const parsed = new URL(template);
    if (parsed.username || parsed.password) throw areaFeedConfigError("credentials are not allowed");
    if (parsed.hash) throw areaFeedConfigError("fragments are not allowed");
    const authorityStart = template.indexOf("://") + 3;
    const resourceStart = ["/", "?", "#"]
      .map((delimiter) => template.indexOf(delimiter, authorityStart))
      .filter((index) => index >= 0)
      .reduce((lowest, index) => Math.min(lowest, index), template.length);
    const pathAndQuery = template.slice(resourceStart);
    if (authorityStart < 3 || TEMPLATE_SLOTS.some((slot) => !pathAndQuery.includes(slot))) {
      throw areaFeedConfigError("placeholders are allowed only in the path or query");
    }
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback(parsed.hostname))) {
      throw areaFeedConfigError("HTTPS is required except for loopback HTTP");
    }

    const first = new URL(replaceSlots(template, ["-12.345", "67.890", "123"]));
    const second = new URL(replaceSlots(template, ["45.678", "-89.012", "250"]));
    if (
      first.origin !== parsed.origin
      || second.origin !== parsed.origin
      || first.username || first.password
      || second.username || second.password
    ) {
      throw areaFeedConfigError("placeholder substitution must not change the upstream origin");
    }
    return { template, origin: parsed.origin, host: parsed.host };
  } catch (error) {
    if (error?.message?.startsWith("invalid SKYTRACE_AREA_FEED_URL:")) throw error;
    throw areaFeedConfigError("expected an absolute URL");
  }
}

export function createAreaFeed({
  url,
  ttlMs = 5000,
  minUpstreamGapMs = 1100,
  fetchImpl = fetch,
} = {}) {
  const validated = validateTemplate(url);
  const enabled = validated != null;
  // The upstream is whatever the operator pointed us at, so the browser cannot know who to credit
  // unless we tell it. Only the host goes out: the path and query can carry a feed UUID.
  const host = validated?.host || null;
  const cache = new Map(); // key -> { at, data, promise }
  let nextUpstreamSlot = 0;
  let upstreamCalls = 0;
  let cachedBytes = 0;

  function removeEntry(key) {
    const entry = cache.get(key);
    if (!entry) return;
    cachedBytes -= entry.bytes || 0;
    cache.delete(key);
  }

  function oldestCompleted() {
    return [...cache.entries()]
      .filter(([, entry]) => !entry.promise)
      .sort((a, b) => a[1].at - b[1].at)[0];
  }

  function makeInsertionRoom() {
    while (cache.size >= MAX_CACHED_AREAS) {
      const oldest = oldestCompleted();
      if (!oldest) throw typedError(503, "area feed busy", 3);
      removeEntry(oldest[0]);
    }
  }

  function enforceCacheBounds() {
    while (cache.size > MAX_CACHED_AREAS || cachedBytes > MAX_AREA_CACHE_BYTES) {
      const oldest = oldestCompleted();
      if (!oldest) break;
      removeEntry(oldest[0]);
    }
  }

  function areaKey(lat, lon, radiusNm) {
    const gridLat = Math.round(lat / CENTRE_GRID_DEG) * CENTRE_GRID_DEG;
    const gridLon = Math.round(lon / CENTRE_GRID_DEG) * CENTRE_GRID_DEG;
    const bucket = RADIUS_STEPS_NM.find((step) => step >= radiusNm + CENTRE_SLACK_NM) ?? 250;
    return { key: `${gridLat.toFixed(2)}:${gridLon.toFixed(2)}:${bucket}`, gridLat, gridLon, bucket };
  }

  async function fetchUpstream(gridLat, gridLon, bucket) {
    // Reserve an upstream slot synchronously, so concurrent areas space themselves out.
    const wait = Math.max(0, nextUpstreamSlot - Date.now());
    if (wait > MAX_UPSTREAM_WAIT_MS) throw typedError(503, "area feed busy", 3);
    nextUpstreamSlot = Date.now() + wait + minUpstreamGapMs;
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    const target = new URL(replaceSlots(validated.template, [
      gridLat.toFixed(3),
      gridLon.toFixed(3),
      String(bucket),
    ]));
    if (target.origin !== validated.origin) {
      throw typedError(502, "upstream origin changed");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    try {
      const res = await fetchImpl(target, { signal: controller.signal, redirect: "manual" });
      if (res.status >= 300 && res.status < 400) throw typedError(502, "upstream redirect refused");
      if (!res.ok) throw typedError(502, "upstream failed");
      const body = await readResponseJson(res, MAX_UPSTREAM_BODY_BYTES, {
        abort: () => controller.abort(),
      });
      upstreamCalls += 1;
      const nowMs = Date.now();
      // The v2 clones answer {ac: [...]}; adsb.fi answers {aircraft: [...]} like raw readsb.
      const list = Array.isArray(body.ac) ? body.ac : Array.isArray(body.aircraft) ? body.aircraft : [];
      const bounded = list.slice(0, MAX_AREA_AIRCRAFT);
      const aircraft = bounded
        .map((raw) => normalizeAircraft(raw, nowMs, { maxObservationAgeSeconds: 120 }))
        .filter((item) => item && item.lat != null && item.lon != null)
        .map((item) => ({
          ...item,
          areaFeed: true,
          receiverCount: 0,
          bestReceiverId: null,
          receivers: [],
        }));
      return {
        now: new Date().toISOString(),
        centre: { lat: gridLat, lon: gridLon },
        radiusNm: bucket,
        count: aircraft.length,
        truncatedCount: Math.max(0, list.length - MAX_AREA_AIRCRAFT),
        aircraft,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function query(lat, lon, radiusNm) {
    if (!enabled) return null;
    const { key, gridLat, gridLon, bucket } = areaKey(lat, lon, Math.min(250, radiusNm));
    const now = Date.now();
    const entry = cache.get(key);
    if (entry?.data && now - entry.at < ttlMs) {
      entry.at = now;
      return entry.data;
    }
    if (entry?.promise) return entry.promise;
    makeInsertionRoom();
    const promise = fetchUpstream(gridLat, gridLon, bucket)
      .then((data) => {
        const bytes = Buffer.byteLength(JSON.stringify(data));
        if (bytes > MAX_AREA_CACHE_ENTRY_BYTES) {
          removeEntry(key);
          throw typedError(502, "upstream response too large");
        }
        removeEntry(key);
        cache.set(key, { at: Date.now(), data, bytes });
        cachedBytes += bytes;
        enforceCacheBounds();
        return data;
      })
      .catch((error) => {
        // A failed refresh serves the recently stale answer rather than blanking the area.
        removeEntry(key);
        if (entry?.data && now - entry.at < STALE_GRACE_MS) {
          cache.set(key, entry);
          cachedBytes += entry.bytes || 0;
          return entry.data;
        }
        throw error;
      });
    cache.set(key, { ...entry, at: now, promise, bytes: entry?.bytes || 0 });
    return promise;
  }

  return {
    enabled,
    host,
    query,
    stats: () => ({ upstreamCalls, cachedAreas: cache.size, cachedBytes }),
  };
}
