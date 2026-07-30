import assert from "node:assert/strict";
import test from "node:test";
import {
  ALTITUDE_UNITS,
  DEFAULT_SETTINGS,
  DISTANCE_UNITS,
  RATE_UNITS,
  SETTINGS_KEY,
  SETTING_BOUNDS,
  SPEED_UNITS,
  TEMP_UNITS,
  UNIT_PRESETS,
  convertSettingsUnit,
  loadSettings,
  normalizeSettings,
  saveSettings,
} from "../web/src/settings.js";

test("operator defaults expose independent units and bounded display settings", () => {
  assert.equal(DEFAULT_SETTINGS.unitAltitude, "ft");
  assert.equal(DEFAULT_SETTINGS.unitSpeed, "kt");
  assert.equal(DEFAULT_SETTINGS.unitDistance, "nm");
  assert.deepEqual(UNIT_PRESETS.metric, {
    unitAltitude: "m",
    unitSpeed: "kmh",
    unitDistance: "km",
    unitTemperature: "c",
  });
  assert.equal(RATE_UNITS.ft.label, "ft/min");
  assert.equal(RATE_UNITS.m.label, "m/s");
  assert.equal(SETTINGS_KEY, "skytrace.settings");
  assert.equal(DEFAULT_SETTINGS.coastSeconds, 20);
  assert.equal(DEFAULT_SETTINGS.dropSeconds, 60);
  assert.equal(DEFAULT_SETTINGS.terrainExaggeration, 2);
  assert.equal(DEFAULT_SETTINGS.altitudeExaggeration, 5);
  assert.equal(DEFAULT_SETTINGS.aircraftPitchExaggeration, 3);
  assert.equal(DEFAULT_SETTINGS.aircraftRollExaggeration, 2);
  assert.deepEqual(SETTING_BOUNDS.aircraftRollExaggeration, [1, 5, 2]);
});

test("every published unit converter preserves its documented base quantity", () => {
  const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9);

  closeTo(ALTITUDE_UNITS.ft.toFeet(123), 123);
  closeTo(ALTITUDE_UNITS.ft.fromFeet(123), 123);
  closeTo(ALTITUDE_UNITS.m.toFeet(304.8), 1000);
  closeTo(ALTITUDE_UNITS.m.fromFeet(1000), 304.8);

  closeTo(SPEED_UNITS.kt.toKnots(123), 123);
  closeTo(SPEED_UNITS.kt.fromKnots(123), 123);
  closeTo(SPEED_UNITS.kmh.toKnots(185.2), 100);
  closeTo(SPEED_UNITS.kmh.fromKnots(100), 185.2);
  closeTo(SPEED_UNITS.mph.toKnots(115.078), 100);
  closeTo(SPEED_UNITS.mph.fromKnots(100), 115.078);

  closeTo(DISTANCE_UNITS.nm.toNm(123), 123);
  closeTo(DISTANCE_UNITS.nm.fromNm(123), 123);
  closeTo(DISTANCE_UNITS.km.toNm(185.2), 100);
  closeTo(DISTANCE_UNITS.km.fromNm(100), 185.2);
  closeTo(DISTANCE_UNITS.mi.toNm(115.078), 100);
  closeTo(DISTANCE_UNITS.mi.fromNm(100), 115.078);

  closeTo(RATE_UNITS.ft.fromFpm(1000), 1000);
  closeTo(RATE_UNITS.m.fromFpm(1000), 5.08);
  closeTo(TEMP_UNITS.c.fromC(20), 20);
  closeTo(TEMP_UNITS.f.fromC(20), 68);
});

test("normalization rejects unknown values and enforces dependent bounds", () => {
  const normalized = normalizeSettings({
    unitAltitude: "yards",
    ringCount: 99.4,
    coverageOpacity: -1,
    coastSeconds: 80,
    dropSeconds: 20,
    trafficHidden: ["rx-a", 123, null, "rx-b"],
    coverageHidden: "rx-a",
    unknownFutureSetting: true,
  });

  assert.equal(normalized.unitAltitude, DEFAULT_SETTINGS.unitAltitude);
  assert.equal(normalized.ringCount, 8);
  assert.equal(normalized.coverageOpacity, 0);
  assert.equal(normalized.coastSeconds, 80);
  assert.equal(normalized.dropSeconds, 85);
  assert.deepEqual(normalized.trafficHidden, ["rx-a", "rx-b"]);
  assert.deepEqual(normalized.coverageHidden, []);
  assert.equal(Object.hasOwn(normalized, "unknownFutureSetting"), false);
});

test("normalization returns independent mutable arrays for every settings instance", () => {
  const first = normalizeSettings(null);
  const second = normalizeSettings({});

  first.trafficHidden.push("rx-a");
  first.ringsHidden.push("rx-b");

  assert.deepEqual(second.trafficHidden, []);
  assert.deepEqual(second.ringsHidden, []);
  assert.deepEqual(DEFAULT_SETTINGS.trafficHidden, []);
});

test("settings storage round-trip normalizes data and recovers from corrupt storage", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };

  saveSettings({ ...DEFAULT_SETTINGS, ringCount: 6 }, storage);
  assert.equal(JSON.parse(values.get(SETTINGS_KEY)).ringCount, 6);
  assert.equal(loadSettings(storage).ringCount, 6);

  values.set(SETTINGS_KEY, "{broken json");
  assert.deepEqual(loadSettings(storage), normalizeSettings({}));
});

test("a storage write failure is non-fatal and reported once", () => {
  const warnings = [];
  const storage = {
    setItem() {
      throw new Error("quota exceeded");
    },
  };

  assert.doesNotThrow(() => saveSettings(DEFAULT_SETTINGS, storage, {
    warn: (...args) => warnings.push(args),
  }));
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][0], "Unable to persist settings");
  assert.match(warnings[0][1].message, /quota exceeded/);
});

test("unit conversion preserves filter meaning without mutating the current settings", () => {
  const current = normalizeSettings({
    altMin: "10000",
    altMax: "12.5",
    speedMin: "100",
    speedMax: "",
    maxRange: "100",
    ringSpacing: 100,
  });

  const metricAltitude = convertSettingsUnit(current, "altitude", "m");
  const metricSpeed = convertSettingsUnit(metricAltitude, "speed", "kmh");
  const metricDistance = convertSettingsUnit(metricSpeed, "distance", "km");

  assert.equal(current.unitAltitude, "ft");
  assert.equal(current.altMin, "10000");
  assert.equal(metricAltitude.unitAltitude, "m");
  assert.equal(metricAltitude.altMin, "3048");
  assert.equal(metricAltitude.altMax, "3.8");
  assert.equal(metricSpeed.speedMin, "185");
  assert.equal(metricSpeed.speedMax, "");
  assert.equal(metricDistance.maxRange, "185");
  assert.equal(metricDistance.ringSpacing, 100);
});

test("unit conversion ignores unavailable units and rejects unknown conversion kinds", () => {
  const current = normalizeSettings({ altMin: "10000" });
  assert.equal(convertSettingsUnit(current, "altitude", "yards"), current);
  assert.throws(() => convertSettingsUnit(current, "temperature", "f"), /unknown unit kind/);
});
