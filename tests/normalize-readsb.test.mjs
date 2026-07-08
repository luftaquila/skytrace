import test from "node:test";
import assert from "node:assert/strict";
import { isFreshObservation, normalizeReadsbPayload, sanitizeReceiverId } from "../src/normalize-readsb.mjs";

test("normalizes readsb aircraft fields", () => {
  const result = normalizeReadsbPayload({
    now: 1760000000,
    aircraft: [
      {
        hex: "ABC123",
        flight: "  TEST42 ",
        lat: 37.5,
        lon: 127.1,
        alt_baro: "ground",
        gs: 42.4,
        track: 181,
        seen: 2,
        seen_pos: 3,
        messages: "120",
      },
    ],
  });

  assert.equal(result.aircraft.length, 1);
  assert.equal(result.aircraft[0].hex, "abc123");
  assert.equal(result.aircraft[0].flight, "TEST42");
  assert.equal(result.aircraft[0].onGround, true);
  assert.equal(result.aircraft[0].altBaro, 0);
  assert.equal(result.aircraft[0].messages, 120);
  assert.equal(result.aircraft[0].positionAt, "2025-10-09T08:53:17.000Z");
});

test("drops invalid aircraft hex and invalid coordinates", () => {
  const result = normalizeReadsbPayload({
    now: 1760000000,
    aircraft: [
      { hex: "not-icao", lat: 37, lon: 127 },
      { hex: "abc124", lat: 137, lon: 127, seen: 0 },
    ],
  });

  assert.equal(result.aircraft.length, 1);
  assert.equal(result.aircraft[0].lat, null);
  assert.equal(result.aircraft[0].lon, null);
});

test("checks freshness from receive time", () => {
  const fresh = {
    observedAt: "2025-10-09T08:53:18.000Z",
  };
  const stale = {
    observedAt: "2025-10-09T08:40:00.000Z",
  };

  assert.equal(isFreshObservation(fresh, "2025-10-09T08:53:20.000Z", 120), true);
  assert.equal(isFreshObservation(stale, "2025-10-09T08:53:20.000Z", 120), false);
});

test("sanitizes receiver ids", () => {
  assert.equal(sanitizeReceiverId("roof-01"), "roof-01");
  assert.equal(sanitizeReceiverId("bad id"), null);
  assert.equal(sanitizeReceiverId("../bad"), null);
});
