import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createRequestLimits, TokenBucketPool } from "../server/rate-limit.mjs";

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.headers = new Map();
    this.statusCode = 200;
    this.body = null;
    this.destroyed = false;
  }

  set(name, value) {
    this.headers.set(name, value);
    return this;
  }

  status(value) {
    this.statusCode = value;
    return this;
  }

  json(value) {
    this.body = value;
    this.emit("finish");
    return this;
  }

  destroy() {
    this.destroyed = true;
    this.emit("close");
  }
}

test("token buckets evict the exact least-recently-used key", () => {
  const pool = new TokenBucketPool({
    refillPerMinute: 60,
    burst: 10,
    maxKeys: 3,
    sweepMs: 0,
    now: () => 1000,
  });
  try {
    pool.consume("a");
    pool.consume("b");
    pool.consume("c");
    pool.consume("a");
    pool.consume("d");
    assert.deepEqual([...pool.buckets.keys()], ["c", "a", "d"]);
    assert.equal(pool.buckets.has("b"), false);
  } finally {
    pool.close();
  }
});

test("slow live clients are isolated per IP and timed out without exhausting the global pool", () => {
  const deadlines = [];
  const limits = createRequestLimits({
    setTimer(handler, ms) {
      const deadline = { handler, ms, cleared: false, unref() {} };
      deadlines.push(deadline);
      return deadline;
    },
    clearTimer(deadline) {
      deadline.cleared = true;
    },
  });
  const middleware = limits.middleware("live");
  const accepted = [];

  const request = (ip) => {
    const response = new FakeResponse();
    let continued = false;
    middleware({ ip }, response, () => {
      continued = true;
      accepted.push(response);
    });
    return { response, continued };
  };

  try {
    for (let index = 0; index < 4; index += 1) {
      const result = request("198.51.100.1");
      assert.equal(result.continued, true);
    }
    assert.deepEqual(deadlines.map((deadline) => deadline.ms), [10000, 10000, 10000, 10000]);

    const sameIp = request("198.51.100.1");
    assert.equal(sameIp.continued, false);
    assert.equal(sameIp.response.statusCode, 503);

    const anotherIp = request("198.51.100.2");
    assert.equal(anotherIp.continued, true);
    assert.equal(limits.stats().live.inFlight, 5);

    deadlines[0].handler();
    assert.equal(accepted[0].destroyed, true);
    assert.equal(limits.stats().live.inFlight, 4);
    assert.equal(limits.stats().live.timedOut, 1);

    const recovered = request("198.51.100.1");
    assert.equal(recovered.continued, true);

    const completed = request("198.51.100.3");
    const completedDeadline = deadlines.at(-1);
    completed.response.emit("finish");
    completedDeadline.handler();
    assert.equal(completed.response.destroyed, false);
    assert.equal(limits.stats().live.timedOut, 1);
  } finally {
    for (const response of accepted) {
      if (!response.destroyed) response.emit("finish");
    }
    limits.close();
  }
});

test("live responses allow 32 concurrent clients globally and reject the 33rd", () => {
  const limits = createRequestLimits();
  const middleware = limits.middleware("live");
  const responses = [];

  try {
    for (let index = 0; index < 32; index += 1) {
      const response = new FakeResponse();
      let continued = false;
      middleware({ ip: `198.51.100.${index + 1}` }, response, () => {
        continued = true;
        responses.push(response);
      });
      assert.equal(continued, true);
    }
    assert.equal(limits.stats().live.inFlight, 32);

    const rejected = new FakeResponse();
    let continued = false;
    middleware({ ip: "203.0.113.1" }, rejected, () => {
      continued = true;
    });
    assert.equal(continued, false);
    assert.equal(rejected.statusCode, 503);
    assert.equal(limits.stats().live.inFlightRejected, 1);
  } finally {
    for (const response of responses) response.emit("finish");
    limits.close();
  }
});
