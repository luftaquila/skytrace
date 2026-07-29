export class TokenBucketPool {
  constructor({
    refillPerMinute,
    burst,
    maxKeys = 10000,
    idleMs = 15 * 60 * 1000,
    sweepMs = 5 * 60 * 1000,
    now = () => Date.now(),
  }) {
    if (!(refillPerMinute > 0) || !(burst > 0)) throw new TypeError("invalid token bucket limits");
    this.refillPerMs = refillPerMinute / 60000;
    this.burst = burst;
    this.maxKeys = maxKeys;
    this.idleMs = idleMs;
    this.now = now;
    this.buckets = new Map();
    this.timer = sweepMs > 0 ? setInterval(() => this.sweep(), sweepMs) : null;
    this.timer?.unref?.();
  }

  consume(key, cost = 1) {
    const at = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      this.makeRoom();
      bucket = { tokens: this.burst, at, usedAt: at };
      this.buckets.set(key, bucket);
    } else {
      // Map preserves insertion order. Reinsert on every access so eviction remains exact O(1)
      // even when several buckets share the same millisecond timestamp.
      this.buckets.delete(key);
      this.buckets.set(key, bucket);
    }
    bucket.tokens = Math.min(this.burst, bucket.tokens + (at - bucket.at) * this.refillPerMs);
    bucket.at = at;
    bucket.usedAt = at;
    if (cost <= bucket.tokens) {
      bucket.tokens -= cost;
      return { ok: true, retryAfter: 0 };
    }
    return {
      ok: false,
      retryAfter: Math.max(1, Math.ceil((cost - bucket.tokens) / this.refillPerMs / 1000)),
    };
  }

  makeRoom() {
    if (this.buckets.size < this.maxKeys) return;
    const oldest = this.buckets.keys().next();
    if (!oldest.done) this.buckets.delete(oldest.value);
  }

  sweep() {
    const cutoff = this.now() - this.idleMs;
    for (const [key, bucket] of this.buckets) {
      if (bucket.usedAt < cutoff) this.buckets.delete(key);
    }
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.buckets.clear();
  }
}

const ROUTES = {
  bulk: { ip: [120, 20], global: [480, 80], inFlight: 8 },
  history: { ip: [30, 10], global: [240, 40], inFlight: 16 },
  area: { ip: [30, 10], global: [60, 10] },
  coverage: { ip: [30, 5], global: [120, 20] },
  live: {
    ip: [120, 20],
    global: [600, 60],
    inFlight: 32,
    inFlightPerIp: 4,
    responseTimeoutMs: 10000,
  },
};

export function createRequestLimits({
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const entries = new Map();
  for (const [name, limits] of Object.entries(ROUTES)) {
    entries.set(name, {
      ip: new TokenBucketPool({ refillPerMinute: limits.ip[0], burst: limits.ip[1] }),
      global: new TokenBucketPool({
        refillPerMinute: limits.global[0],
        burst: limits.global[1],
        maxKeys: 1,
        sweepMs: 0,
      }),
      inFlightLimit: limits.inFlight || Number.POSITIVE_INFINITY,
      inFlightPerIpLimit: limits.inFlightPerIp || Number.POSITIVE_INFINITY,
      responseTimeoutMs: limits.responseTimeoutMs || 0,
      inFlightByIp: new Map(),
      metrics: {
        accepted: 0,
        rateLimited: 0,
        globalRejected: 0,
        inFlightRejected: 0,
        inFlight: 0,
        maxInFlight: 0,
        timedOut: 0,
      },
    });
  }

  function reject(res, status, retryAfter) {
    res.set("retry-after", String(retryAfter));
    res.set("cache-control", "no-store");
    res.status(status).json({ ok: false, error: status === 429 ? "rate limit exceeded" : "service busy" });
  }

  function middleware(name) {
    const entry = entries.get(name);
    if (!entry) throw new TypeError(`unknown route class ${name}`);
    return (req, res, next) => {
      const ip = req.ip || "unknown";
      const ipResult = entry.ip.consume(ip);
      if (!ipResult.ok) {
        entry.metrics.rateLimited += 1;
        reject(res, 429, ipResult.retryAfter);
        return;
      }
      const globalResult = entry.global.consume("global");
      if (!globalResult.ok) {
        entry.metrics.globalRejected += 1;
        reject(res, 503, globalResult.retryAfter);
        return;
      }
      const ipInFlight = entry.inFlightByIp.get(ip) || 0;
      if (
        entry.metrics.inFlight >= entry.inFlightLimit
        || ipInFlight >= entry.inFlightPerIpLimit
      ) {
        entry.metrics.inFlightRejected += 1;
        reject(res, 503, 1);
        return;
      }
      entry.metrics.accepted += 1;
      entry.metrics.inFlight += 1;
      entry.inFlightByIp.set(ip, ipInFlight + 1);
      entry.metrics.maxInFlight = Math.max(entry.metrics.maxInFlight, entry.metrics.inFlight);
      let released = false;
      let deadline = null;
      const release = () => {
        if (released) return;
        released = true;
        if (deadline) clearTimer(deadline);
        deadline = null;
        entry.metrics.inFlight = Math.max(0, entry.metrics.inFlight - 1);
        const remainingForIp = (entry.inFlightByIp.get(ip) || 1) - 1;
        if (remainingForIp > 0) entry.inFlightByIp.set(ip, remainingForIp);
        else entry.inFlightByIp.delete(ip);
      };
      res.once("finish", release);
      res.once("close", release);
      if (entry.responseTimeoutMs > 0) {
        deadline = setTimer(() => {
          if (released) return;
          entry.metrics.timedOut += 1;
          release();
          res.destroy();
        }, entry.responseTimeoutMs);
        deadline.unref?.();
      }
      next();
    };
  }

  return {
    middleware,
    stats() {
      return Object.fromEntries([...entries].map(([name, entry]) => [name, { ...entry.metrics }]));
    },
    close() {
      for (const entry of entries.values()) {
        entry.ip.close();
        entry.global.close();
        entry.inFlightByIp.clear();
      }
    },
  };
}
