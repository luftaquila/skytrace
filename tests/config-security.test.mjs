import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { loadConfig } from "../src/config.mjs";
import { migrate, syncReceiverTokens } from "../src/db.mjs";
import { authenticateIngest } from "../src/ingest.mjs";

const TOKEN_A = "a".repeat(64);
const TOKEN_B = "b".repeat(64);

test("security and retention settings use strict first-release defaults", () => {
  const config = loadConfig({});
  assert.equal(config.trackRetentionDays, 90);
  assert.equal(config.batchRetentionDays, 7);
  assert.equal(config.currentRetentionHours, 24);
  assert.equal(config.trustProxy, 0);
  assert.equal(config.liveMaxAircraft, 5000);
  assert.equal(config.liveMaxBytes, 8 * 1024 * 1024);
  assert.deepEqual(config.receiverTokens, []);
  assert.equal(config.trackMinIntervalSeconds, 3);
  assert.equal(config.coverageRefreshSeconds, 180);
  assert.equal(config.coverageWindowHours, 24 * 30);

  const derivedCells = loadConfig({
    SKYTRACE_COVERAGE_HORIZONTAL_STEP_NM: "10",
    SKYTRACE_COVERAGE_VERTICAL_STEP_FT: "1000",
  });
  assert.equal(derivedCells.coverageCellHorizontalStepNm, 5);
  assert.equal(derivedCells.coverageCellVerticalStepFt, 500);

  assert.throws(
    () => loadConfig({ SKYTRACE_TRACK_RETENTION_DAYS: "30" }),
    /must be at least 31/,
  );
  for (const value of ["0", "366", "90.5", "abc"]) {
    assert.throws(
      () => loadConfig({ SKYTRACE_TRACK_RETENTION_DAYS: value }),
      /invalid SKYTRACE_TRACK_RETENTION_DAYS/,
    );
  }
  assert.equal(loadConfig({
    SKYTRACE_COVERAGE_WINDOW_HOURS: "24",
    SKYTRACE_TRACK_RETENTION_DAYS: "2",
  }).trackRetentionDays, 2);
});

test("removed settings and proxy shortcuts fail closed", () => {
  for (const key of [
    "SKYTRACE_INGEST_TOKEN",
    "SKYTRACE_INGEST_TOKENS",
    "SKYTRACE_MAX_TRACK_QUERY_POINTS",
    "SKYTRACE_REQUIRE_HTTPS",
  ]) {
    assert.throws(() => loadConfig({ [key]: "old" }), new RegExp(`invalid ${key}`));
  }
  for (const value of ["true", "false", "1", "17", "not-an-address"]) {
    assert.throws(
      () => loadConfig({ SKYTRACE_TRUST_PROXY: value }),
      /invalid SKYTRACE_TRUST_PROXY/,
    );
  }
  assert.equal(loadConfig({ SKYTRACE_TRUST_PROXY: "0" }).trustProxy, 0);
  assert.deepEqual(
    loadConfig({ SKYTRACE_TRUST_PROXY: "10.0.0.0/8,2001:db8::/32" }).trustProxy,
    ["10.0.0.0/8", "2001:db8::/32"],
  );
});

test("receiver token configuration accepts one JSON-object form only", () => {
  const parsed = loadConfig({
    SKYTRACE_RECEIVER_TOKENS: JSON.stringify({ "rx-1": TOKEN_A, "rx-2": TOKEN_B }),
  }).receiverTokens;
  assert.deepEqual(parsed, [
    { receiverId: "rx-1", token: TOKEN_A },
    { receiverId: "rx-2", token: TOKEN_B },
  ]);
  for (const value of [
    `rx-1:${TOKEN_A}`,
    "[]",
    JSON.stringify({ "bad id": TOKEN_A }),
    JSON.stringify({ "rx-1": "short" }),
    JSON.stringify({ "rx-1": TOKEN_A, "rx-2": TOKEN_A }),
  ]) {
    assert.throws(
      () => loadConfig({ SKYTRACE_RECEIVER_TOKENS: value }),
      /invalid SKYTRACE_RECEIVER_TOKENS/,
    );
  }
});

test("the configured token map is authoritative for rotation and deletion", () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  try {
    syncReceiverTokens(db, [{ receiverId: "rx-1", token: TOKEN_A }]);
    assert.equal(authenticateIngest(db, TOKEN_A, "rx-1").ok, true);

    syncReceiverTokens(db, [{ receiverId: "rx-1", token: TOKEN_B }]);
    assert.equal(authenticateIngest(db, TOKEN_A, "rx-1").ok, false);
    assert.equal(authenticateIngest(db, TOKEN_B, "rx-1").ok, true);

    syncReceiverTokens(db, []);
    assert.equal(authenticateIngest(db, TOKEN_B, "rx-1").ok, false);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM receiver_tokens").get().count, 0);
  } finally {
    db.close();
  }
});
