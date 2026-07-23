import test from "node:test";
import assert from "node:assert/strict";
import { createCoverageCache } from "../src/coverage-cache.mjs";

test("coverage cache serves one snapshot until the scheduled refresh replaces it", () => {
  let buildCount = 0;
  let nowMs = Date.parse("2026-07-23T00:00:00Z");
  const cache = createCoverageCache({
    refreshSeconds: 300,
    now: () => nowMs,
    build: (now) => ({ type: "observed-occupancy", now, build: ++buildCount }),
  });
  try {
    const first = cache.get();
    const again = cache.get();
    assert.strictEqual(again, first);
    assert.equal(buildCount, 1);
    assert.equal(first.refreshIntervalSeconds, 300);
    assert.equal(first.nextRefreshAt, "2026-07-23T00:05:00.000Z");

    nowMs += 300000;
    const refreshed = cache.refresh();
    assert.notStrictEqual(refreshed, first);
    assert.equal(refreshed.build, 2);
    assert.equal(refreshed.generatedAt, "2026-07-23T00:05:00.000Z");
  } finally {
    cache.close();
  }
});
