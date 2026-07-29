// Settings are the operator's deployment surface: everything here survives a refresh and a
// reconnect, and the whole set can be exported to a file and imported into another browser.
export const SETTINGS_KEY = "skytrace.settings";
export const MAX_SETTINGS_IMPORT_BYTES = 64 * 1024;

export const ALTITUDE_UNITS = {
  ft: { label: "ft", fromFeet: (feet) => feet, toFeet: (value) => value },
  m: { label: "m", fromFeet: (feet) => feet * 0.3048, toFeet: (value) => value / 0.3048 },
};
export const SPEED_UNITS = {
  kt: { label: "kts", fromKnots: (kt) => kt, toKnots: (value) => value },
  kmh: { label: "km/h", fromKnots: (kt) => kt * 1.852, toKnots: (value) => value / 1.852 },
  mph: { label: "mph", fromKnots: (kt) => kt * 1.15078, toKnots: (value) => value / 1.15078 },
};
export const DISTANCE_UNITS = {
  nm: { label: "NM", fromNm: (nm) => nm, toNm: (value) => value },
  km: { label: "km", fromNm: (nm) => nm * 1.852, toNm: (value) => value / 1.852 },
  mi: { label: "mi", fromNm: (nm) => nm * 1.15078, toNm: (value) => value / 1.15078 },
};
// A vertical rate is read in whatever the altitude unit is: feet give ft/min, metres give m/s.
export const RATE_UNITS = {
  ft: { label: "ft/min", fromFpm: (fpm) => fpm },
  m: { label: "m/s", fromFpm: (fpm) => fpm * 0.00508 },
};
export const TEMP_UNITS = {
  c: { label: "°C", fromC: (c) => c },
  f: { label: "°F", fromC: (c) => (c * 9) / 5 + 32 },
};
export const UNIT_PRESETS = {
  aero: { unitAltitude: "ft", unitSpeed: "kt", unitDistance: "nm", unitTemperature: "c" },
  metric: { unitAltitude: "m", unitSpeed: "kmh", unitDistance: "km", unitTemperature: "c" },
  imperial: { unitAltitude: "ft", unitSpeed: "mph", unitDistance: "mi", unitTemperature: "f" },
};

export const DEFAULT_SETTINGS = {
  unitAltitude: "ft",
  unitSpeed: "kt",
  unitDistance: "nm",
  unitTemperature: "c",
  flightLevels: false,
  coverageHidden: [],
  trafficHidden: [],
  mapReferenceLabels: true,
  airfields: true,
  airfieldsMinor: false,
  ringsHidden: [],
  ringSpacing: 100,
  ringCount: 3,
  ringUnit: "nm",
  ringCompass: true,
  showGround: true,
  showNonIcao: true,
  areaFeed: true,
  source: "all",
  altMin: "",
  altMax: "",
  speedMin: "",
  speedMax: "",
  maxRange: "",
  aircraftScale: 1,
  imageryBrightness: 0.9,
  coverageOpacity: 0.3,
  terrainExaggeration: 2,
  altitudeExaggeration: 5,
  aircraftPitchExaggeration: 3,
  aircraftRollExaggeration: 2,
  coastDrop: true,
  coastSeconds: 20,
  dropSeconds: 60,
  proximity: true,
  proximityNm: 3,
  proximityFt: 1000,
};

// Every numeric setting's bound, in one table, so load, reset and import all clamp identically.
export const SETTING_BOUNDS = {
  ringSpacing: [5, 1000, 100],
  ringCount: [1, 8, 3, true],
  aircraftScale: [0.5, 2.5, 1],
  imageryBrightness: [0.4, 1.2, 0.9],
  coverageOpacity: [0, 0.8, 0.3],
  terrainExaggeration: [1, 5, 2],
  altitudeExaggeration: [1, 10, 5],
  aircraftPitchExaggeration: [1, 5, 3],
  aircraftRollExaggeration: [1, 5, 2],
  coastSeconds: [5, 600, 20],
  dropSeconds: [10, 1800, 60],
  proximityNm: [0.5, 20, 3],
  proximityFt: [100, 5000, 1000],
};

const ENUM_SETTINGS = {
  unitAltitude: Object.keys(ALTITUDE_UNITS),
  unitSpeed: Object.keys(SPEED_UNITS),
  unitDistance: Object.keys(DISTANCE_UNITS),
  unitTemperature: Object.keys(TEMP_UNITS),
  ringUnit: Object.keys(DISTANCE_UNITS),
};

export function clampSetting(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function cloneDefaults() {
  return {
    ...DEFAULT_SETTINGS,
    coverageHidden: [],
    trafficHidden: [],
    ringsHidden: [],
  };
}

// Shared by load, reset and import: an out-of-range or unknown value can never reach the renderer,
// whether it came from an old build, a hand-edited localStorage blob or an imported file.
export function normalizeSettings(raw) {
  const settings = cloneDefaults();
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (Object.hasOwn(source, key)) settings[key] = source[key];
  }
  for (const [key, [min, max, fallback, integer]] of Object.entries(SETTING_BOUNDS)) {
    const value = clampSetting(settings[key], min, max, fallback);
    settings[key] = integer ? Math.round(value) : value;
  }
  for (const [key, allowed] of Object.entries(ENUM_SETTINGS)) {
    if (!allowed.includes(settings[key])) settings[key] = DEFAULT_SETTINGS[key];
  }
  for (const key of ["coverageHidden", "ringsHidden", "trafficHidden"]) {
    settings[key] = Array.isArray(settings[key])
      ? settings[key].filter((name) => typeof name === "string")
      : [];
  }
  // A target must render as stale before it disappears.
  settings.dropSeconds = Math.max(settings.dropSeconds, settings.coastSeconds + 5);
  return settings;
}

export function saveSettings(value, storage = globalThis.localStorage, logger = console) {
  try {
    storage.setItem(SETTINGS_KEY, JSON.stringify(value));
  } catch (error) {
    logger.warn("Unable to persist settings", error);
  }
}

export function loadSettings(storage = globalThis.localStorage) {
  try {
    const current = storage.getItem(SETTINGS_KEY);
    return current ? normalizeSettings(JSON.parse(current)) : normalizeSettings({});
  } catch {
    return normalizeSettings({});
  }
}

const UNIT_CONVERSIONS = {
  altitude: {
    setting: "unitAltitude",
    fields: ["altMin", "altMax"],
    units: ALTITUDE_UNITS,
    toBase: "toFeet",
    fromBase: "fromFeet",
  },
  speed: {
    setting: "unitSpeed",
    fields: ["speedMin", "speedMax"],
    units: SPEED_UNITS,
    toBase: "toKnots",
    fromBase: "fromKnots",
  },
  distance: {
    setting: "unitDistance",
    fields: ["maxRange"],
    units: DISTANCE_UNITS,
    toBase: "toNm",
    fromBase: "fromNm",
  },
};

function readableNumber(value) {
  return String(Math.abs(value) >= 10 ? Math.round(value) : Math.round(value * 10) / 10);
}

// Numeric filter values stay physically equivalent when their display unit changes.
export function convertSettingsUnit(current, kind, nextUnit) {
  const conversion = UNIT_CONVERSIONS[kind];
  if (!conversion) throw new TypeError(`unknown unit kind: ${kind}`);
  const previous = conversion.units[current[conversion.setting]];
  const next = conversion.units[nextUnit];
  if (!previous || !next || previous === next) return current;

  const converted = { ...current, [conversion.setting]: nextUnit };
  for (const key of conversion.fields) {
    const raw = Number.parseFloat(current[key]);
    if (!Number.isFinite(raw)) continue;
    const base = previous[conversion.toBase](raw);
    converted[key] = readableNumber(next[conversion.fromBase](base));
  }
  return converted;
}
