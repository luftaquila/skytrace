import test from "node:test";
import assert from "node:assert/strict";
import { createCoverageCache } from "../src/coverage-cache.mjs";

test("coverage cache swaps completed async snapshots and defaults to three minutes", async () => {
  let buildCount = 0;
  let nowMs = Date.parse("2026-07-23T00:00:00Z");
  const cache = createCoverageCache({
    startImmediately: false,
    now: () => nowMs,
    build: async (now) => ({ type: "observed-occupancy", now, build: ++buildCount }),
  });
  try {
    assert.equal(cache.get(), null);
    const first = await cache.ready();
    assert.strictEqual(cache.get(), first);
    assert.equal(buildCount, 1);
    assert.equal(first.refreshIntervalSeconds, 180);
    assert.equal(first.nextRefreshAt, "2026-07-23T00:03:00.000Z");

    nowMs += 180000;
    const refreshed = await cache.refresh();
    assert.notStrictEqual(refreshed, first);
    assert.equal(refreshed.build, 2);
    assert.equal(refreshed.generatedAt, "2026-07-23T00:03:00.000Z");
  } finally {
    await cache.close();
  }
});

test("coverage cache serializes refreshes and retains the previous snapshot on failure", async () => {
  let buildCount = 0;
  let concurrent = 0;
  let maxConcurrent = 0;
  let fail = false;
  const cache = createCoverageCache({
    startImmediately: false,
    build: async () => {
      buildCount += 1;
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 5));
      concurrent -= 1;
      if (fail) throw new Error("synthetic coverage failure");
      return { type: "observed-occupancy", build: buildCount };
    },
    logger: { error() {} },
  });
  try {
    const first = await cache.refresh();
    const [second, third] = await Promise.all([cache.refresh(), cache.refresh()]);
    assert.equal(maxConcurrent, 1);
    assert.strictEqual(second, third);
    assert.equal(second.build, 3);

    fail = true;
    const retained = await cache.refresh();
    assert.strictEqual(retained, second);
    assert.equal(cache.state().lastError, "synthetic coverage failure");
    assert.strictEqual(cache.get(), first === second ? first : second);
  } finally {
    await cache.close();
  }
});
