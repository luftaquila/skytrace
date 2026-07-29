import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  convertSettingsUnit,
  loadSettings,
  normalizeSettings,
  saveSettings,
} from "../web/src/settings.js";

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
