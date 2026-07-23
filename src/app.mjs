import fs from "node:fs";
import path from "node:path";
import express from "express";
import { createCoverageCache } from "./coverage-cache.mjs";
import {
  authenticateIngest,
  getCoverage,
  getCurrentAircraft,
  getPublicReceivers,
  getTrack,
  ingestReadsb,
  trackToKml,
} from "./ingest.mjs";
import { sanitizeReceiverId } from "./normalize-readsb.mjs";
import { queryAircraftTracks } from "./track-query.mjs";

function bearerToken(req) {
  const header = req.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function parseDateQuery(value) {
  if (!value) return null;
  const d = new Date(String(value));
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

export function createApp({ db, config, sseHub }) {
  const app = express();
  app.disable("x-powered-by");
  if (config.trustProxy) app.set("trust proxy", true);

  app.use(express.json({ limit: "8mb" }));

  const coverageCache = createCoverageCache({
    refreshSeconds: config.coverageRefreshSeconds,
    build: (now) => getCoverage(db, {
      now,
      coverageWindowHours: config.coverageWindowHours,
      coverageBearingStepDegrees: config.coverageBearingStepDegrees,
      coverageMaxPoints: config.coverageMaxPoints,
      coverageHorizontalStepNm: config.coverageHorizontalStepNm,
      coverageVerticalStepFt: config.coverageVerticalStepFt,
      coverageHorizontalSupportNm: config.coverageHorizontalSupportNm,
      coverageVerticalSupportFt: config.coverageVerticalSupportFt,
      coverageMaxCells: config.coverageMaxCells,
      coverageMaxTriangles: config.coverageMaxTriangles,
    }),
  });
  app.locals.coverageCache = coverageCache;

  app.get("/healthz", (req, res) => {
    res.json({ ok: true, now: new Date().toISOString() });
  });

  app.get("/api/events", (req, res) => {
    sseHub.add(req, res);
  });

  app.post("/api/aircraft/tracks", (req, res) => {
    const requests = Array.isArray(req.body?.aircraft) ? req.body.aircraft : [];
    if (requests.length > 250) {
      res.status(400).json({ ok: false, error: "too many aircraft; maximum is 250" });
      return;
    }
    res.json(queryAircraftTracks(db, requests, {
      from: parseDateQuery(req.body?.from),
      to: parseDateQuery(req.body?.to),
      historic: req.body?.historic === true,
      limit: config.maxTrackQueryPoints,
      maxAircraft: 250,
      now: new Date().toISOString(),
    }));
  });

  app.post("/api/ingest/readsb", asyncRoute(async (req, res) => {
    const bodyReceiverId = sanitizeReceiverId(req.body?.receiver?.id);
    const headerReceiverId = sanitizeReceiverId(req.get("x-skytrace-receiver"));
    const receiverId = bodyReceiverId || headerReceiverId;
    const auth = authenticateIngest(db, config, bearerToken(req), receiverId);
    if (!auth.ok) {
      res.status(401).json({ ok: false, error: auth.reason });
      return;
    }

    const result = ingestReadsb(db, req.body, {
      receiverId: receiverId || auth.receiverId,
      receivedAt: new Date().toISOString(),
      remoteAddr: req.ip,
      userAgent: req.get("user-agent") || null,
      maxObservationAgeSeconds: config.maxObservationAgeSeconds,
      trackMinIntervalSeconds: config.trackMinIntervalSeconds,
      positionFilterMaxMach: config.positionFilterMaxMach,
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

  app.get("/api/aircraft/current", (req, res) => {
    res.json(getCurrentAircraft(db, {
      currentWindowSeconds: config.currentWindowSeconds,
    }));
  });

  app.get("/api/coverage", (req, res) => {
    // The browser's five-minute timer should always ask the server for its current snapshot;
    // only the server cache controls mesh freshness.
    res.set("cache-control", "public, max-age=0, must-revalidate");
    res.json(coverageCache.get());
  });

  app.get("/api/aircraft/:hex/track.kml", (req, res) => {
    const points = getTrack(db, req.params.hex, {
      from: parseDateQuery(req.query.from),
      to: parseDateQuery(req.query.to),
      limit: Number.parseInt(req.query.limit || config.maxTrackQueryPoints, 10),
      now: new Date().toISOString(),
    });
    res.type("application/vnd.google-earth.kml+xml");
    res.set("content-disposition", `attachment; filename="${String(req.params.hex || "track").toLowerCase()}.kml"`);
    res.send(trackToKml(req.params.hex, points));
  });

  app.get("/api/aircraft/:hex/track", (req, res) => {
    res.json({
      hex: String(req.params.hex || "").toLowerCase(),
      points: getTrack(db, req.params.hex, {
        from: parseDateQuery(req.query.from),
        to: parseDateQuery(req.query.to),
        limit: Number.parseInt(req.query.limit || config.maxTrackQueryPoints, 10),
        now: new Date().toISOString(),
      }),
    });
  });

  app.get("/api/receivers/public", (req, res) => {
    res.json({
      now: new Date().toISOString(),
      receivers: getPublicReceivers(db, {
        currentWindowSeconds: config.currentWindowSeconds,
      }),
    });
  });

  const staticDir = path.resolve(config.staticDir);
  if (fs.existsSync(path.join(staticDir, "index.html"))) {
    app.use(express.static(staticDir, {
      index: false,
      maxAge: "1h",
    }));
    app.use((req, res, next) => {
      if (!["GET", "HEAD"].includes(req.method) || req.path.startsWith("/api/")) return next();
      res.sendFile(path.join(staticDir, "index.html"));
    });
  } else {
    app.get("/", (req, res) => {
      res.type("text/plain").send("Skytrace API is running. Build web/ to serve the UI.\n");
    });
  }

  app.use((req, res) => {
    res.status(404).json({ ok: false, error: "not found" });
  });

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.status || 500;
    res.status(status).json({
      ok: false,
      error: status >= 500 ? "internal server error" : err.message,
    });
  });

  return app;
}
