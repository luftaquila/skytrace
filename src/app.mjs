import fs from "node:fs";
import path from "node:path";
import express from "express";
import { createAreaFeed } from "./area-feed.mjs";
import { createCoverageCache } from "./coverage-cache.mjs";
import { createCoverageWorkerClient } from "./coverage-worker-client.mjs";
import {
  authenticateIngest,
  getCurrentAircraft,
  getPublicReceivers,
  ingestReadsb,
  trackToKml,
} from "./ingest.mjs";
import {
  DEFAULT_HISTORY_PAGE_POINTS,
  MAX_HISTORY_PAGE_POINTS,
  queryAircraftHistory,
} from "./history-query.mjs";
import {
  encodeJson,
  etagMatches,
  negotiateEncoding,
  sendEncoded,
  sendJson,
  strongEtag,
} from "./http-response.mjs";
import { sanitizeReceiverId } from "./normalize-readsb.mjs";
import { createRequestLimits, TokenBucketPool } from "./rate-limit.mjs";
import { normalizeBulkTrackRequest, queryAircraftTracks } from "./track-query.mjs";

function bearerToken(req) {
  const header = req.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function scalarQuery(value) {
  return Array.isArray(value) ? null : value;
}

function limitedJsonError(error, _req, res, next) {
  if (!error) return next();
  if (error.type === "entity.too.large") {
    res.status(413).json({ ok: false, error: "request body too large" });
    return;
  }
  if (error instanceof SyntaxError && error.status === 400 && "body" in error) {
    res.status(400).json({ ok: false, error: "invalid JSON body" });
    return;
  }
  next(error);
}

function rejectLimited(res, status, retryAfter) {
  res.set("retry-after", String(retryAfter));
  res.set("cache-control", "no-store");
  res.status(status).json({ ok: false, error: status === 429 ? "rate limit exceeded" : "service busy" });
}

export function createApp({ db, config, sseHub, coverageWorker = null, airfieldsStore = null }) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy);
  app.use((_req, res, next) => {
    const headers = {
      "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https://server.arcgisonline.com https://tiles.mapterhorn.com https://tiles.openfreemap.org; worker-src 'self' blob:; font-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; manifest-src 'self'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
      // Locate is an explicit first-party UI action, so geolocation remains available only to
      // this origin. Cross-origin frames and every unrelated device capability stay disabled.
      "permissions-policy": "camera=(), microphone=(), geolocation=(self), payment=(), usb=()",
    };
    res.set(headers);
    next();
  });

  const requestLimits = createRequestLimits();
  const ingestLimits = {
    authIp: new TokenBucketPool({ refillPerMinute: 120, burst: 20 }),
    authGlobal: new TokenBucketPool({ refillPerMinute: 600, burst: 60, maxKeys: 1, sweepMs: 0 }),
    request: new TokenBucketPool({ refillPerMinute: 60, burst: 10 }),
    observation: new TokenBucketPool({ refillPerMinute: 10000, burst: 2000 }),
    track: new TokenBucketPool({ refillPerMinute: 2000, burst: 1000 }),
    close() {
      this.authIp.close();
      this.authGlobal.close();
      this.request.close();
      this.observation.close();
      this.track.close();
    },
  };
  app.locals.requestLimits = requestLimits;
  app.locals.ingestLimits = ingestLimits;

  const coverageOptions = {
    coverageWindowHours: config.coverageWindowHours,
    coverageHorizontalStepNm: config.coverageHorizontalStepNm,
    coverageVerticalStepFt: config.coverageVerticalStepFt,
    coverageCellHorizontalStepNm: config.coverageCellHorizontalStepNm,
    coverageCellVerticalStepFt: config.coverageCellVerticalStepFt,
    coverageHorizontalSupportNm: config.coverageHorizontalSupportNm,
    coverageVerticalSupportFt: config.coverageVerticalSupportFt,
    coverageHorizontalInterpolationCells: config.coverageHorizontalInterpolationCells,
    coverageHorizontalSmoothingPasses: config.coverageHorizontalSmoothingPasses,
    coverageVerticalSmoothingPasses: config.coverageVerticalSmoothingPasses,
    coverageSmoothingIterations: config.coverageSmoothingIterations,
    coverageMaxCells: config.coverageMaxCells,
    coverageMaxTriangles: config.coverageMaxTriangles,
    coverageAggregationChunkSize: config.coverageAggregationChunkSize,
  };
  const workerClient = coverageWorker || createCoverageWorkerClient({
    dbPath: config.dbPath,
    options: coverageOptions,
  });
  const coverageCache = createCoverageCache({
    refreshSeconds: config.coverageRefreshSeconds,
    build: (now) => workerClient.build(now),
    closeBuild: () => workerClient.close(),
  });
  app.locals.coverageCache = coverageCache;

  // Construct the optional feed once; invalid configured templates fail startup.
  const areaFeed = createAreaFeed({
    url: config.areaFeedUrl,
    ttlMs: config.areaFeedTtlSeconds * 1000,
    minUpstreamGapMs: config.areaFeedMinUpstreamMs,
  });

  const readinessQuery = db.prepare("SELECT COUNT(*) >= 0 AS ok FROM receivers");
  app.get("/healthz", (_req, res) => {
    res.set("cache-control", "no-store");
    try {
      if (readinessQuery.get()?.ok !== 1) throw new Error("required database schema is unavailable");
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  app.get("/api/events", (req, res) => {
    sseHub.add(req, res);
  });

  const ingestJson = express.json({ limit: "8mb" });
  app.post("/api/ingest/readsb", (req, res, next) => {
    const ipLimit = ingestLimits.authIp.consume(req.ip || "unknown");
    const globalLimit = ingestLimits.authGlobal.consume("global");
    if (!ipLimit.ok || !globalLimit.ok) {
      rejectLimited(res, ipLimit.ok ? 503 : 429, ipLimit.ok ? globalLimit.retryAfter : ipLimit.retryAfter);
      return;
    }
    const headerReceiverId = sanitizeReceiverId(req.get("x-skytrace-receiver"));
    const auth = authenticateIngest(db, bearerToken(req), headerReceiverId);
    if (!auth.ok) {
      res.set("cache-control", "no-store");
      res.status(401).json({ ok: false, error: auth.reason });
      return;
    }
    req.ingestAuth = auth;
    const requestLimit = ingestLimits.request.consume(auth.receiverId);
    if (!requestLimit.ok) {
      rejectLimited(res, 429, requestLimit.retryAfter);
      return;
    }
    next();
  }, ingestJson, limitedJsonError, asyncRoute(async (req, res) => {
    const auth = req.ingestAuth;
    const bodyReceiverId = req.body?.receiver?.id == null
      ? null
      : sanitizeReceiverId(req.body.receiver.id);
    const headerReceiverId = req.get("x-skytrace-receiver") == null
      ? null
      : sanitizeReceiverId(req.get("x-skytrace-receiver"));
    if (
      req.body?.receiver?.id != null && !bodyReceiverId
      || req.get("x-skytrace-receiver") != null && !headerReceiverId
      || bodyReceiverId && bodyReceiverId !== auth.receiverId
      || headerReceiverId && headerReceiverId !== auth.receiverId
    ) {
      res.set("cache-control", "no-store");
      res.status(401).json({ ok: false, error: "invalid token" });
      return;
    }
    const rawAircraft = Array.isArray(req.body?.aircraft)
      ? req.body.aircraft
      : Array.isArray(req.body?.payload?.aircraft) ? req.body.payload.aircraft : [];
    const observationLimit = ingestLimits.observation.consume(auth.receiverId, rawAircraft.length);
    if (!observationLimit.ok) {
      rejectLimited(res, 429, observationLimit.retryAfter);
      return;
    }

    const result = ingestReadsb(db, req.body, {
      receiverId: auth.receiverId,
      tokenHash: auth.tokenHash,
      receivedAt: new Date().toISOString(),
      remoteAddr: req.ip,
      userAgent: req.get("user-agent") || null,
      maxObservationAgeSeconds: config.maxObservationAgeSeconds,
      trackMinIntervalSeconds: config.trackMinIntervalSeconds,
      positionFilterMaxMach: config.positionFilterMaxMach,
      consumeTrackBudget: (receiverId) => ingestLimits.track.consume(receiverId),
    });
    sseHub.broadcast("ingest", {
      receiverId: result.receiverId,
      receivedAt: result.receivedAt,
      acceptedCount: result.acceptedCount,
      trackPoints: result.trackPoints,
      changedHexes: result.changedHexes.slice(0, 200),
    });

    res.json({ ok: true, ...result, sseClients: sseHub.size() });
  }));

  const bulkJson = express.json({ limit: "64kb" });
  app.post("/api/aircraft/tracks", requestLimits.middleware("bulk"), bulkJson, limitedJsonError, asyncRoute(async (req, res) => {
    const request = normalizeBulkTrackRequest(req.body);
    if (!request) {
      res.status(400).json({ ok: false, error: "invalid bulk track request" });
      return;
    }
    await sendJson(req, res, queryAircraftTracks(db, request, { now: new Date().toISOString() }));
  }));

  let liveCache = null;

  function liveData(current, aircraft, receivers) {
    return {
      now: current.now,
      count: aircraft.length,
      summary: {
        withPosition: aircraft.filter((item) => item.lat != null && item.lon != null).length,
        onGround: aircraft.filter((item) => item.onGround).length,
        nonIcao: aircraft.filter((item) => item.nonIcao).length,
        sources: aircraft.reduce((acc, item) => {
          const key = item.sourceKind || "unknown";
          acc[key] = (acc[key] || 0) + 1;
          return acc;
        }, {}),
      },
      aircraft,
      receivers,
      features: {
        areaFeed: areaFeed.enabled,
        // Who to credit for the area traffic. The operator chose the upstream, so the browser
        // cannot name it otherwise — and ODbL feeds (adsb.lol is one) require the source
        // database to be identified, not described.
        areaFeedHost: areaFeed.host,
      },
      truncatedCount: Math.max(0, current.aircraft.length - aircraft.length),
    };
  }

  async function buildLiveRepresentation(nowMs) {
    const current = getCurrentAircraft(db, {
      currentWindowSeconds: config.currentWindowSeconds,
      now: new Date(nowMs).toISOString(),
    });
    const receivers = getPublicReceivers(db, {
      currentWindowSeconds: config.currentWindowSeconds,
      now: current.now,
    });
    let aircraft = current.aircraft.slice(0, config.liveMaxAircraft);
    for (;;) {
      try {
        return await encodeJson(liveData(current, aircraft, receivers), {
          maxIdentityBytes: config.liveMaxBytes,
        });
      } catch (error) {
        if (error.code !== "JSON_REPRESENTATION_TOO_LARGE" || aircraft.length === 0) {
          error.status = 503;
          throw error;
        }
        // A configured receiver set with unusually large aggregate metadata still cannot make the
        // public snapshot exceed its byte budget. Halving converges in logarithmic steps.
        aircraft = current.aircraft.slice(0, Math.floor(aircraft.length / 2));
      }
    }
  }

  function liveRepresentation(nowMs) {
    if (!liveCache || nowMs - liveCache.at >= 1000) {
      const entry = { at: nowMs, promise: null };
      entry.promise = buildLiveRepresentation(nowMs).catch((error) => {
        if (liveCache === entry) liveCache = null;
        throw error;
      });
      liveCache = entry;
    }
    return liveCache.promise;
  }

  app.get("/api/live", requestLimits.middleware("live"), asyncRoute(async (req, res) => {
    res.set("cache-control", "no-store");
    sendEncoded(req, res, await liveRepresentation(Date.now()));
  }));

  app.get("/api/coverage", requestLimits.middleware("coverage"), (req, res) => {
    if (Object.keys(req.query).length > 0) {
      res.status(400).json({ ok: false, error: "coverage query parameters are not supported" });
      return;
    }
    const representation = coverageCache.representation();
    if (!representation) {
      res.set("retry-after", "5");
      res.set("cache-control", "no-store");
      res.status(503).json({ ok: false, error: "coverage is not ready" });
      return;
    }
    res.set("cache-control", "public, max-age=0, must-revalidate");
    sendEncoded(req, res, representation);
  });

  function historyOptions(req) {
    const allowed = new Set(["limit", "olderCursor", "at"]);
    if (Object.keys(req.query).some((key) => !allowed.has(key))) {
      throw Object.assign(new Error("unsupported history query parameter"), { status: 400 });
    }
    const limitRaw = scalarQuery(req.query.limit);
    const cursor = scalarQuery(req.query.olderCursor);
    const at = scalarQuery(req.query.at);
    if (req.query.limit != null && (
      limitRaw == null
      || !/^\d+$/.test(String(limitRaw))
      || Number(limitRaw) < 1
      || Number(limitRaw) > MAX_HISTORY_PAGE_POINTS
    )) {
      throw Object.assign(new Error("limit must be from 1 to 5000"), { status: 400 });
    }
    if (req.query.olderCursor != null && (cursor == null || !cursor)) {
      throw Object.assign(new Error("invalid olderCursor"), { status: 400 });
    }
    if (req.query.at != null && (at == null || !Number.isFinite(Date.parse(at)))) {
      throw Object.assign(new Error("invalid at"), { status: 400 });
    }
    return {
      limit: limitRaw == null ? DEFAULT_HISTORY_PAGE_POINTS : Number(limitRaw),
      olderCursor: cursor || null,
      at: at || null,
      retentionDays: config.trackRetentionDays,
      now: new Date().toISOString(),
    };
  }

  app.get("/api/aircraft/:hex/history.kml", requestLimits.middleware("history"), (req, res, next) => {
    let history;
    try {
      history = queryAircraftHistory(db, req.params.hex, historyOptions(req));
    } catch (error) {
      next(error);
      return;
    }
    res.type("application/vnd.google-earth.kml+xml");
    res.set("cache-control", "no-store");
    res.set("content-disposition", `attachment; filename="${history.hex}.kml"`);
    res.send(trackToKml(history.hex, history.points));
  });

  app.get("/api/aircraft/:hex/history", requestLimits.middleware("history"), asyncRoute(async (req, res) => {
    res.set("cache-control", "no-store");
    await sendJson(req, res, queryAircraftHistory(db, req.params.hex, historyOptions(req)));
  }));

  // Camera-following area traffic: display-only aggregator data for whatever region the viewer
  // is looking at. Nothing is ingested or stored; the per-area cache inside the feed bounds the
  // upstream cost no matter how many viewers pan around.
  app.get("/api/area-traffic", requestLimits.middleware("area"), asyncRoute(async (req, res) => {
    if (!areaFeed.enabled) {
      res.status(404).json({ ok: false, error: "area feed not configured" });
      return;
    }
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    const radius = Number(req.query.radius);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90
      || !Number.isFinite(lon) || lon < -180 || lon > 180
      || !Number.isFinite(radius) || radius <= 0) {
      res.status(400).json({ ok: false, error: "lat, lon and radius (NM) are required" });
      return;
    }
    res.set("cache-control", "no-store");
    try {
      res.json(await areaFeed.query(lat, lon, radius));
    } catch (error) {
      const status = error.status === 503 ? 503 : 502;
      if (error.retryAfter) res.set("retry-after", String(error.retryAfter));
      res.status(status).json({ ok: false, error: status === 503 ? "area feed busy" : "upstream failed" });
    }
  }));

  if (airfieldsStore) {
    // The manifest names the current dataset version; it is the only mutable URL, so it must
    // revalidate. The versioned payloads are immutable by construction — a refresh mints new URLs.
    app.get("/api/airfields/manifest", (_req, res) => {
      const manifest = airfieldsStore.manifest();
      if (!manifest) {
        res.status(404).json({ ok: false, error: "airfield dataset not built yet" });
        return;
      }
      res.set("cache-control", "public, max-age=0, must-revalidate");
      res.json(manifest);
    });

    app.get("/api/airfields/:version/:file", asyncRoute(async (req, res) => {
      const version = String(req.params.version || "");
      const file = String(req.params.file || "");
      if (!/^[0-9]{8}-[0-9a-f]{10}$/.test(version) || !/^(index|cell-\d{1,2}-\d{1,2})\.json$/.test(file)) {
        res.status(404).json({ ok: false, error: "not found" });
        return;
      }
      const encoding = negotiateEncoding(req.get("accept-encoding"), true);
      if (!encoding) {
        res.status(406).json({ ok: false, error: "no acceptable content encoding" });
        return;
      }
      const bytes = await airfieldsStore.payload(version, file, encoding);
      if (!bytes) {
        res.status(404).json({ ok: false, error: "not found" });
        return;
      }
      res.type("application/json");
      res.set("cache-control", "public, max-age=2592000, immutable");
      res.set("vary", "Accept-Encoding");
      res.set("etag", strongEtag(bytes));
      if (encoding === "gzip") res.set("content-encoding", "gzip");
      if (String(req.get("if-none-match") || "").split(",").map((item) => item.trim()).includes(res.get("etag"))) {
        res.status(304).end();
        return;
      }
      res.set("content-length", String(bytes.byteLength));
      if (req.method === "HEAD") res.end();
      else res.end(bytes);
    }));
  }

  const staticDir = path.resolve(config.staticDir);
  if (fs.existsSync(path.join(staticDir, "index.html"))) {
    app.get("/assets/*asset", asyncRoute(async (req, res, next) => {
      const relative = Array.isArray(req.params.asset) ? req.params.asset.join("/") : req.params.asset;
      const asset = path.resolve(staticDir, "assets", relative);
      const assetsRoot = `${path.resolve(staticDir, "assets")}${path.sep}`;
      if (!asset.startsWith(assetsRoot)) return next();
      const encoding = negotiateEncoding(req.get("accept-encoding"), fs.existsSync(`${asset}.gz`));
      if (!encoding) {
        res.status(406).json({ ok: false, error: "no acceptable content encoding" });
        return;
      }
      res.set("vary", "Accept-Encoding");
      if (encoding === "identity") return next();
      try {
        const bytes = await fs.promises.readFile(`${asset}.gz`);
        const etag = strongEtag(bytes);
        res.type(path.extname(asset));
        res.set("content-encoding", "gzip");
        res.set("cache-control", "public, max-age=31536000, immutable");
        res.set("etag", etag);
        if (etagMatches(req.get("if-none-match"), etag)) {
          res.status(304).end();
          return;
        }
        res.set("content-length", String(bytes.byteLength));
        if (req.method === "HEAD") res.end();
        else res.end(bytes);
      } catch (error) {
        if (error.code === "ENOENT") return next();
        throw error;
      }
    }));
    // The licence notices are the one unhashed root asset large enough for the precompressed twin to
    // be worth serving: ~84 kB of largely repeated licence text against ~10 kB gzipped, and nothing
    // in front of this server compresses on the fly. It cannot live under /assets, which marks
    // everything immutable for a year — this filename is stable across builds, so it revalidates
    // against a strong ETag instead.
    app.get("/third-party-notices.json", asyncRoute(async (req, res, next) => {
      const file = path.join(staticDir, "third-party-notices.json");
      const encoding = negotiateEncoding(req.get("accept-encoding"), fs.existsSync(`${file}.gz`));
      if (!encoding) {
        res.status(406).json({ ok: false, error: "no acceptable content encoding" });
        return;
      }
      res.set("vary", "Accept-Encoding");
      if (encoding === "identity") return next();
      try {
        const bytes = await fs.promises.readFile(`${file}.gz`);
        const etag = strongEtag(bytes);
        res.type(".json");
        res.set("content-encoding", "gzip");
        res.set("cache-control", "public, max-age=0, must-revalidate");
        res.set("etag", etag);
        if (etagMatches(req.get("if-none-match"), etag)) {
          res.status(304).end();
          return;
        }
        res.set("content-length", String(bytes.byteLength));
        if (req.method === "HEAD") res.end();
        else res.end(bytes);
      } catch (error) {
        // No precompressed twin, or it vanished: fall through to the plain file below.
        if (error.code === "ENOENT") return next();
        throw error;
      }
    }));
    app.use(express.static(staticDir, {
      index: false,
      maxAge: "1h",
      setHeaders(res, filePath) {
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader("cache-control", "public, max-age=31536000, immutable");
        }
      },
    }));
    app.use((req, res, next) => {
      if (!["GET", "HEAD"].includes(req.method) || req.path.startsWith("/api/")) return next();
      res.set("cache-control", "public, max-age=0, must-revalidate");
      res.sendFile(path.join(staticDir, "index.html"));
    });
  } else {
    app.get("/", (_req, res) => {
      res.type("text/plain").send("Skytrace API is running. Build web/ to serve the UI.\n");
    });
  }

  app.use((_req, res) => {
    res.status(404).json({ ok: false, error: "not found" });
  });

  app.use((err, _req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.status || 500;
    res.status(status).json({
      ok: false,
      error: status >= 500 ? "internal server error" : err.message,
    });
  });

  return app;
}
