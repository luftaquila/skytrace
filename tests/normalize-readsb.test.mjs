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
        type: "adsb_icao",
        ias: 120,
        tas: 130,
        mach: 0.21,
        true_heading: 182,
        wd: 270,
        ws: 15,
        nac_p: 10,
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
  assert.equal(result.aircraft[0].sourceKind, "adsb");
  assert.equal(result.aircraft[0].ias, 120);
  assert.equal(result.aircraft[0].windDirection, 270);
  assert.equal(result.aircraft[0].nacP, 10);
  assert.equal(result.aircraft[0].positionAt, "2025-10-09T08:53:17.000Z");
});

test("normalizes legacy dump1090-mutability field names", () => {
  const result = normalizeReadsbPayload({
    now: 1760000000,
    aircraft: [
      {
        hex: "71c511",
        flight: "AAR116",
        lat: 37.62,
        lon: 128.24,
        altitude: 35000,
        speed: 452,
        vert_rate: -640,
        track: 79,
        squawk: "7156",
        category: "A3",
        mlat: [],
        tisb: [],
        messages: 4188,
        seen: 0.6,
        seen_pos: 0.6,
        rssi: -22.3,
      },
      {
        hex: "71c533",
        altitude: "ground",
        mlat: [],
        tisb: [],
        seen: 1,
      },
    ],
  });

  assert.equal(result.aircraft.length, 2);
  const [a, b] = result.aircraft;
  assert.equal(a.altBaro, 35000);
  assert.equal(a.gs, 452);
  assert.equal(a.baroRate, -640);
  assert.equal(a.track, 79);
  assert.equal(a.onGround, false);
  assert.equal(b.altBaro, 0);
  assert.equal(b.onGround, true);
});

test("prefers modern readsb fields over legacy aliases", () => {
  const result = normalizeReadsbPayload({
    now: 1760000000,
    aircraft: [
      { hex: "abc123", alt_baro: 12000, altitude: 999, gs: 300, speed: 1, baro_rate: -100, vert_rate: 1, seen: 0 },
    ],
  });

  assert.equal(result.aircraft[0].altBaro, 12000);
  assert.equal(result.aircraft[0].gs, 300);
  assert.equal(result.aircraft[0].baroRate, -100);
});

test("accepts non-ICAO target ids", () => {
  const result = normalizeReadsbPayload({
    now: 1760000000,
    aircraft: [
      { hex: "~ab1234", type: "tisb_trackfile", lat: 37, lon: 127, seen: 0, seen_pos: 0 },
    ],
  });

  assert.equal(result.aircraft.length, 1);
  assert.equal(result.aircraft[0].hex, "~ab1234");
  assert.equal(result.aircraft[0].nonIcao, true);
  assert.equal(result.aircraft[0].sourceKind, "tisb");
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
