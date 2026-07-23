<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import {
  ChevronDown,
  CircleDot,
  Download,
  Filter,
  Layers,
  LocateFixed,
  Pause,
  Play,
  RadioTower,
  Search,
  Settings,
  SlidersHorizontal,
  TowerControl,
  X,
} from "@lucide/vue";
import { AIRFIELDS, isMinorAirfield } from "./airfields.js";
import { currentTrackRun, mergeTrackPoints } from "./track-runs.js";

const SETTINGS_KEY = "skytrace.settings.v3";
const DEFAULT_SETTINGS = {
  units: "aero",
  coverage: true,
  airfields: true,
  airfieldsMinor: false,
  showGround: true,
  showNonIcao: true,
  source: "all",
  altMin: "",
  altMax: "",
  flightLevels: false,
  coastDrop: true,
  proximity: true,
  terrainExaggeration: 2,
  terrainSatellite: true,
  allAircraftTracks: false,
};

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    const settings = { ...DEFAULT_SETTINGS };
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (Object.hasOwn(saved, key)) settings[key] = saved[key];
    }
    return settings;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

const map3dEl = ref(null);
const aircraft = ref([]);
const receivers = ref([]);
const coverage = ref({ areas: [], points: [] });
const selectedHex = ref(null);
const trackingActive = ref(false);
const hoveredHex = ref(null);
const selectedTrackRaw = ref([]);
const historicTrackHexes = ref(new Set());
const selectedTrack = computed(() => {
  const points = selectedTrackRaw.value;
  return selectedHex.value && historicTrackHexes.value.has(selectedHex.value)
    ? points
    : currentTrackRun(points);
});
const selectedHistoric = computed({
  get: () => Boolean(selectedHex.value && historicTrackHexes.value.has(selectedHex.value)),
  set: (enabled) => {
    const hex = selectedHex.value;
    if (!hex) return;
    const next = new Set(historicTrackHexes.value);
    if (enabled) next.add(hex);
    else next.delete(hex);
    historicTrackHexes.value = next;
    playbackSpeed.value = 0;
    playbackIndex.value = Math.max(0, selectedTrack.value.length - 1);
    renderTrackView();
  },
});
// Pinned aircraft: their popover label AND their track stay shown regardless of hover /
// selection. pinnedTracks caches each pinned hex's track points.
const pinned = ref(new Set());
const pinnedTracks = ref(new Map());
const allTrackCache = ref(new Map());
const search = ref("");
const sortKey = ref("callsign");
const tracklogOpen = ref(false);
const status = ref("loading");
const lastUpdated = ref(null);
const now = ref(Date.now());
const trackHours = ref(24);
const settings = ref(loadSettings());
const controlsOpen = ref(false);
const playbackSpeed = ref(0);
const playbackIndex = ref(0);
const chartEl = ref(null);
const selectedHistoryMetrics = ref(["altBaro", "gs"]);

// Resizable panel: sidebar width (desktop) / panel height in vh (mobile), persisted.
const LAYOUT_KEY = "skytrace.layout.v1";
function clampWidth(value) { return Math.min(760, Math.max(320, Number(value) || 440)); }
function clampPanelVh(value) { return Math.min(85, Math.max(30, Number(value) || 55)); }
const savedLayout = (() => { try { return JSON.parse(localStorage.getItem(LAYOUT_KEY) || "{}"); } catch { return {}; } })();
const sidebarWidth = ref(clampWidth(savedLayout.sidebarWidth));
const panelHeight = ref(clampPanelVh(savedLayout.panelHeight));
const shellStyle = computed(() => ({
  "--sidebar-width": `${sidebarWidth.value}px`,
  "--panel-height": `${panelHeight.value}vh`,
}));

function startPanelResize(event) {
  event.preventDefault();
  const mobile = window.matchMedia("(max-width: 900px)").matches;
  let raf = 0;
  const onMove = (ev) => {
    if (mobile) {
      panelHeight.value = clampPanelVh(((window.innerHeight - ev.clientY) / window.innerHeight) * 100);
    } else {
      sidebarWidth.value = clampWidth(window.innerWidth - ev.clientX);
    }
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; tac3d?.resize(); });
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    document.body.style.userSelect = "";
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ sidebarWidth: sidebarWidth.value, panelHeight: panelHeight.value }));
    tac3d?.resize();
  };
  document.body.style.userSelect = "none";
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

let historyChart;
let chartResizeObserver;
let refreshTimer;
let coverageTimer;
let clockTimer;
let eventSource;
let sseRetryTimer;
let playbackTimer;
let tac3d;
let tac3dPromise;
let allTrackCursors = new Map();
let allTrackRequestVersion = 0;
let selectedTrackRequestVersion = 0;

watch(settings, (value) => {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(value));
  tac3d?.applySettings();
  queueHistoryChartRender();
}, { deep: true });

watch(playbackSpeed, () => {
  startPlaybackTimer();
});

const stats = computed(() => {
  const rows = aircraft.value;
  const sources = {};
  let withPosition = 0;
  let onGround = 0;
  let nonIcao = 0;
  for (const item of rows) {
    const key = item.sourceKind || "unknown";
    sources[key] = (sources[key] || 0) + 1;
    if (item.lat != null && item.lon != null) withPosition += 1;
    if (item.onGround) onGround += 1;
    if (item.nonIcao) nonIcao += 1;
  }
  return { live: rows.length, withPosition, onGround, nonIcao, sources };
});

const sourceOptions = computed(() => {
  const keys = Object.keys(stats.value.sources).sort();
  return ["all", ...keys];
});

const sourceChips = computed(() =>
  Object.entries(stats.value.sources)
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => ({ key, label: sourceLabel({ sourceKind: key }), count })),
);

function setHover(hex) {
  hoveredHex.value = hex;
}

function clearHover(hex) {
  if (hoveredHex.value === hex) hoveredHex.value = null;
}

const airfieldSummary = computed(() => {
  const coded = AIRFIELDS.filter((field) => !isMinorAirfield(field)).length;
  return { coded, minor: AIRFIELDS.length - coded, total: AIRFIELDS.length };
});

const coverageSummary = computed(() => {
  const areas = coverage.value.areas || [];
  return {
    areas: areas.filter((area) => area.polygon).length,
    positions: coverage.value.count ?? (coverage.value.points || []).length,
    receivers: coverage.value.receiverCount ?? areas.length,
    triangles: areas.reduce((sum, area) => sum + (area.volumeMesh?.triangleCount || 0), 0),
  };
});

const searchQuery = computed(() => search.value.trim().toLowerCase());

const altFilter = computed(() => {
  const minAlt = Number.parseFloat(settings.value.altMin);
  const maxAlt = Number.parseFloat(settings.value.altMax);
  return {
    minAlt,
    maxAlt,
    hasMin: Number.isFinite(minAlt),
    hasMax: Number.isFinite(maxAlt),
  };
});

// Shared predicate for the sidebar list and the 3D aircraft layer. The search haystack is
// only built when there is actually a query.
function passesFilters(item) {
  const q = searchQuery.value;
  if (q) {
    const haystack = [
      item.hex,
      item.flight,
      item.squawk,
      item.category,
      item.sourceType,
      item.sourceKind,
    ].filter(Boolean).join(" ").toLowerCase();
    if (!haystack.includes(q)) return false;
  }
  if (!settings.value.showGround && item.onGround) return false;
  if (!settings.value.showNonIcao && item.nonIcao) return false;
  if (settings.value.source !== "all" && item.sourceKind !== settings.value.source) return false;
  const { hasMin, minAlt, hasMax, maxAlt } = altFilter.value;
  if (hasMin || hasMax) {
    const alt = item.altBaro ?? item.altGeom;
    if (hasMin && (alt == null || alt < minAlt)) return false;
    if (hasMax && (alt == null || alt > maxAlt)) return false;
  }
  return true;
}

// Cap only the sidebar list; the 3D layer continues to render every aircraft that passes filters.
const LIST_LIMIT = 600;
const filteredAircraft = computed(() =>
  sortAircraft(aircraft.value.filter(passesFilters), sortKey.value).slice(0, LIST_LIMIT),
);

// Unlike the capped sidebar list, this is the exact filtered aircraft set rendered by the 3D map.
// It is also the request set for the bulk trail API, so hidden targets never consume bandwidth.
const trailAircraftHexes = computed(() => aircraft.value
  .filter((item) => item.lat != null && item.lon != null && passesFilters(item) && !isDropped(item))
  .map((item) => item.hex)
  .sort());
const trailFilterKey = computed(() => [
  searchQuery.value,
  settings.value.showGround,
  settings.value.showNonIcao,
  settings.value.source,
  settings.value.altMin,
  settings.value.altMax,
  settings.value.coastDrop,
].join("|"));

watch(() => settings.value.allAircraftTracks, (enabled) => {
  if (enabled) refreshAllAircraftTracks({ reset: true });
  else clearAllTrackCache();
});
watch(trailFilterKey, () => refreshAllAircraftTracks());
watch(trackHours, () => refreshTrackRange());

function sortAircraft(rows, key) {
  const arr = [...rows];
  if (key === "altitude") {
    arr.sort((a, b) => ((b.altBaro ?? b.altGeom) ?? -Infinity) - ((a.altBaro ?? a.altGeom) ?? -Infinity));
  } else if (key === "speed") {
    arr.sort((a, b) => (b.gs ?? -Infinity) - (a.gs ?? -Infinity));
  } else if (key === "recent") {
    arr.sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt));
  } else {
    arr.sort((a, b) => String(a.flight || a.hex).localeCompare(String(b.flight || b.hex)));
  }
  return arr;
}

const selectedAircraft = computed(() => {
  return aircraft.value.find((item) => item.hex === selectedHex.value) || null;
});
const trackingButtonText = computed(() => {
  if (!selectedAircraft.value) return "Locate";
  return trackingActive.value ? "Tracking" : "Track";
});

const kmlHref = computed(() => {
  if (!selectedHex.value) return "#";
  const to = new Date();
  const from = new Date(to.getTime() - trackHours.value * 60 * 60 * 1000);
  const params = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
  return `/api/aircraft/${selectedHex.value}/track.kml?${params}`;
});

const selectedHistoryPoint = computed(() => {
  if (!selectedTrack.value.length) return null;
  return selectedTrack.value[Math.min(playbackIndex.value, selectedTrack.value.length - 1)] || null;
});

const selectedAlert = computed(() => aircraftAlert(selectedAircraft.value));

const TRACKLOG_LIMIT = 500;
const tracklogRows = computed(() => {
  const pts = selectedTrack.value;
  const rows = [];
  for (let i = pts.length - 1; i >= 0 && rows.length < TRACKLOG_LIMIT; i -= 1) {
    if (pts[i].lat == null || pts[i].lon == null) continue;
    rows.push({ index: i, point: pts[i] });
  }
  return rows;
});
const tracklogHidden = computed(() => {
  const positioned = selectedTrack.value.filter((point) => point.lat != null && point.lon != null).length;
  return Math.max(0, positioned - TRACKLOG_LIMIT);
});

function formatFlight(item) {
  return item.flight || item.hex.toUpperCase();
}

function altitudeValue(feet) {
  if (feet == null) return null;
  if (settings.value.units === "metric") return { value: feet * 0.3048, unit: "m" };
  return { value: feet, unit: "ft" };
}

function speedValue(knots) {
  if (knots == null) return null;
  if (settings.value.units === "metric") return { value: knots * 1.852, unit: "km/h" };
  if (settings.value.units === "imperial") return { value: knots * 1.15078, unit: "mph" };
  return { value: knots, unit: "kt" };
}

// Cache one Intl.NumberFormat per fraction-digit count. Number.prototype.toLocaleString
// with an options object rebuilds a formatter on nearly every call (~13µs) and this runs
// twice per list row (altitude + speed), so at hundreds of rows it was ~99% of a full
// re-render's cost. A cached formatter's .format() is ~40x cheaper for identical output.
const numberFormatters = new Map();
function numberFormatter(digits) {
  let fmt = numberFormatters.get(digits);
  if (!fmt) {
    fmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: digits });
    numberFormatters.set(digits, fmt);
  }
  return fmt;
}
function formatNumberUnit(entry, digits = 0) {
  if (!entry) return "-";
  return `${numberFormatter(digits).format(entry.value)} ${entry.unit}`;
}

// ATC flight-level notation: hundreds of feet, zero-padded (35000 ft -> FL350). FL is a
// feet-based standard, so it overrides the metric/imperial altitude display when enabled.
function formatFlightLevel(feet) {
  return `FL${String(Math.max(0, Math.round(feet / 100))).padStart(3, "0")}`;
}

// Single altitude renderer honouring both the FL toggle and the unit setting, reused by the
// detail panel, tooltip, list and track log so the display stays consistent everywhere.
function altText(feet) {
  if (feet == null) return "-";
  if (settings.value.flightLevels) return formatFlightLevel(feet);
  return formatNumberUnit(altitudeValue(feet));
}

function formatAltitude(item, field = "best") {
  if (item.onGround && field === "best") return "ground";
  const feet = field === "geom" ? item.altGeom : field === "baro" ? item.altBaro : item.altBaro ?? item.altGeom;
  return altText(feet);
}

function formatSpeed(item, field = "ground") {
  const knots = field === "tas" ? item.tas : field === "ias" ? item.ias : item.gs;
  return formatNumberUnit(speedValue(knots));
}

function formatRate(fpm) {
  if (fpm == null) return "-";
  if (settings.value.units === "metric") return `${Math.round(fpm * 0.00508)} m/s`;
  return `${Math.round(fpm).toLocaleString()} ft/min`;
}

function formatAge(iso) {
  if (!iso) return "-";
  const seconds = Math.max(0, Math.round((now.value - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

function formatDegrees(value) {
  return value == null ? "-" : `${Math.round(value)} deg`;
}

function formatTemp(value) {
  return value == null ? "-" : `${Math.round(value)} C`;
}

function formatClock(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "-" : d.toLocaleTimeString(undefined, { hour12: false });
}

const SPECIAL_SQUAWKS = { "7500": "HIJACK", "7600": "RADIO FAILURE", "7700": "EMERGENCY" };

function aircraftAlert(item) {
  if (!item) return null;
  const squawk = String(item.squawk || "").trim();
  if (SPECIAL_SQUAWKS[squawk]) return { level: "danger", label: SPECIAL_SQUAWKS[squawk], code: squawk };
  const emergency = item.emergency && item.emergency !== "none" ? String(item.emergency) : null;
  if (emergency) {
    return { level: "danger", label: `EMERGENCY: ${emergency.replace(/_/g, " ").toUpperCase()}`, code: squawk || null };
  }
  if (item.spi) return { level: "warning", label: "IDENT (SPI)", code: null };
  if (item.alert) return { level: "warning", label: "ALERT", code: null };
  return null;
}

function pointAltitude(point) {
  if (point.onGround) return "GND";
  return altText(point.altBaro ?? point.altGeom);
}

function pointSpeed(point) {
  return formatNumberUnit(speedValue(point.gs));
}

function focusTrackPoint(index) {
  playbackSpeed.value = 0;
  playbackIndex.value = index;
}

// Great-circle distance for the proximity check. Points use {lat, lng}.
const EARTH_RADIUS_NM = 3440.065;
function toRadians(deg) { return (deg * Math.PI) / 180; }
function distanceNm(a, b) {
  const dLat = toRadians(b.lat - a.lat);
  const dLon = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.min(1, Math.sqrt(h)));
}
// Coast/drop: a target stops updating (out of range, landed, feed hiccup). Grey it as
// "coasting" past COAST_AGE, then stop drawing it past DROP_AGE. DROP_AGE sits just above
// the server's 90 s current-window, so it is only a safety net for a stalled feed.
const COAST_AGE_SEC = 30;
const DROP_AGE_SEC = 100;
function targetAgeSec(item) {
  const t = Date.parse(item.observedAt);
  return Number.isFinite(t) ? (now.value - t) / 1000 : 0;
}
function isCoasting(item) {
  return settings.value.coastDrop && targetAgeSec(item) >= COAST_AGE_SEC;
}
function isDropped(item) {
  return settings.value.coastDrop && targetAgeSec(item) >= DROP_AGE_SEC;
}

// Proximity (STCA-style): airborne pairs closer than PROXIMITY_NM laterally AND within
// PROXIMITY_FT vertically. Recomputed only when the aircraft set changes (not per second),
// so the O(n^2) scan runs at the refresh cadence, not every clock tick.
// Tighter than the 5 NM en-route minimum so it flags genuinely close pairs rather than
// normal minimum separation.
const PROXIMITY_NM = 3;
const PROXIMITY_FT = 1000;
const conflicts = computed(() => {
  if (!settings.value.proximity) return [];
  const rows = [];
  for (const item of aircraft.value) {
    if (item.lat == null || item.lon == null || item.onGround) continue;
    // Skip stale "ghost" targets: their frozen last position produces phantom conflicts
    // against live traffic passing nearby. A conflict must be between two fresh tracks.
    // (Independent of the coast/drop display toggle.)
    if (targetAgeSec(item) >= COAST_AGE_SEC) continue;
    const alt = item.altBaro ?? item.altGeom;
    if (alt == null) continue;
    rows.push({ item, alt, pos: { lat: item.lat, lng: item.lon } });
  }
  const pairs = [];
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      const vertFt = Math.abs(rows[i].alt - rows[j].alt);
      if (vertFt > PROXIMITY_FT) continue;
      const distNm = distanceNm(rows[i].pos, rows[j].pos);
      if (distNm > PROXIMITY_NM) continue;
      pairs.push({ a: rows[i].item, b: rows[j].item, distNm, vertFt });
    }
  }
  return pairs;
});
const HISTORY_METRICS = [
  { key: "altBaro", label: "Baro Alt", color: "#48e0d1", kind: "alt", get: (point) => point.altBaro },
  { key: "altGeom", label: "Geom Alt", color: "#7dd3fc", kind: "alt", get: (point) => point.altGeom },
  { key: "gs", label: "Ground Speed", color: "#f8d36c", kind: "speed", get: (point) => point.gs },
  { key: "ias", label: "IAS", color: "#fb923c", kind: "speed", get: (point) => point.ias },
  { key: "tas", label: "TAS", color: "#facc15", kind: "speed", get: (point) => point.tas },
  { key: "mach", label: "Mach", color: "#c084fc", kind: "mach", get: (point) => point.mach },
  { key: "verticalRate", label: "Vert Rate", color: "#34d399", kind: "rate", get: (point) => point.baroRate ?? point.geomRate },
  { key: "track", label: "Track", color: "#60a5fa", kind: "degrees", get: (point) => point.track },
  { key: "heading", label: "Heading", color: "#818cf8", kind: "degrees", get: (point) => point.trueHeading ?? point.magHeading },
  { key: "messages", label: "Messages", color: "#f472b6", kind: "count", get: (point) => point.messages },
  { key: "rssi", label: "RSSI", color: "#a3e635", kind: "rssi", get: (point) => point.rssi },
  { key: "windSpeed", label: "Wind", color: "#2dd4bf", kind: "speed", get: (point) => point.windSpeed },
  { key: "oat", label: "OAT", color: "#fb7185", kind: "temp", get: (point) => point.oat },
  { key: "tat", label: "TAT", color: "#f97316", kind: "temp", get: (point) => point.tat },
];

const metricLookup = new Map(HISTORY_METRICS.map((metric) => [metric.key, metric]));

function metricChartValue(metric, point) {
  const value = metric.get(point);
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (metric.kind === "alt" && settings.value.units === "metric") return n * 0.3048;
  if (metric.kind === "speed" && settings.value.units === "metric") return n * 1.852;
  if (metric.kind === "speed" && settings.value.units === "imperial") return n * 1.15078;
  if (metric.kind === "rate" && settings.value.units === "metric") return n * 0.00508;
  return n;
}

function activeHistoryMetrics() {
  return selectedHistoryMetrics.value
    .map((key) => metricLookup.get(key))
    .filter(Boolean);
}

function hasHistoryMetric(keys) {
  const list = Array.isArray(keys) ? keys : [keys];
  return list.some((key) => selectedHistoryMetrics.value.includes(key));
}

function toggleHistoryMetrics(keys) {
  const list = Array.isArray(keys) ? keys : [keys];
  const current = selectedHistoryMetrics.value.filter((key) => metricLookup.has(key));
  const allActive = list.every((key) => current.includes(key));
  const next = allActive
    ? current.filter((key) => !list.includes(key))
    : [...current.filter((key) => !list.includes(key)), ...list].slice(-4);
  selectedHistoryMetrics.value = next;
}

function detailMetricClass(keys) {
  return { "metric-active": hasHistoryMetric(keys) };
}

function sourceLabel(item) {
  const raw = String(item.sourceType || item.sourceKind || "unknown").toLowerCase();
  if (raw.includes("adsb")) return "ADS-B";
  if (raw.includes("mlat")) return "MLAT";
  if (raw.includes("tisb")) return "TIS-B";
  if (raw.includes("uat")) return "UAT";
  if (raw === "mode_s" || raw.includes("mode")) return "Mode S";
  if (raw === "adsc") return "ADS-C";
  if (raw === "unknown") return "Unknown";
  return raw
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || "Unknown";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const ALT_COLOR_MAX_FT = 40000;
const ALT_COLOR_GROUND = "#9ca3af";
const ALT_COLOR_NONE = "#e5e7eb";

function altitudeColorFeet(feet) {
  if (feet == null || !Number.isFinite(Number(feet))) return ALT_COLOR_NONE;
  const clamped = Math.max(0, Math.min(ALT_COLOR_MAX_FT, Number(feet)));
  const hue = 20 + (clamped / ALT_COLOR_MAX_FT) * 260;
  return `hsl(${hue.toFixed(1)} 85% 55%)`;
}

function altitudeColor(item) {
  if (item.onGround) return ALT_COLOR_GROUND;
  const feet = item.altBaro ?? item.altGeom;
  // Quantise to 500 ft bands (same as the track colouring) so a climbing or descending
  // aircraft does not force a marker-icon rebuild on every altitude tick.
  if (feet == null || !Number.isFinite(Number(feet))) return ALT_COLOR_NONE;
  return altitudeColorFeet(Math.round(Number(feet) / 500) * 500);
}

const altitudeLegend = computed(() => {
  const steps = 8;
  const stops = [];
  for (let i = 0; i <= steps; i += 1) {
    const pct = Math.round((i / steps) * 100);
    stops.push(`${altitudeColorFeet((i / steps) * ALT_COLOR_MAX_FT)} ${pct}%`);
  }
  const fl = settings.value.flightLevels;
  const metric = settings.value.units === "metric" && !fl;
  const ticks = [1, 0.75, 0.5, 0.25, 0].map((frac) => {
    if (fl) return { label: `${Math.round((frac * ALT_COLOR_MAX_FT) / 100)}` };
    const value = frac * ALT_COLOR_MAX_FT * (metric ? 0.3048 : 1);
    return { label: value >= 1000 ? `${Math.round(value / 1000)}k` : `${Math.round(value)}` };
  });
  return {
    gradient: `linear-gradient(to top, ${stops.join(", ")})`,
    ticks,
    unit: fl ? "FL" : metric ? "m" : "ft",
    groundColor: ALT_COLOR_GROUND,
  };
});

function planeSizeScale(category) {
  const cat = String(category || "").toUpperCase();
  if (cat === "A1" || cat === "A2" || cat === "B1") return 0.85;
  if (cat === "A4" || cat === "A5") return 1.18;
  return 1;
}

function verticalArrowSymbol(item) {
  if (item.onGround) return "";
  const rate = item.baroRate ?? item.geomRate;
  if (rate == null) return "";
  if (rate > 100) return "↑";
  if (rate < -100) return "↓";
  return "→";
}

// Second line in the 3D data block: the vertical-trend arrow immediately before the altitude
// (green climb / red descent), then speed. Altitude is quantised to 100 ft so
// the label text (and the DOM rebuild it triggers) stays stable while an aircraft drifts.
function targetLine(item, altRound) {
  const altFt = item.altBaro ?? item.altGeom;
  const feet = altRound && altFt != null ? Math.round(altFt / 100) * 100 : altFt;
  const alt = item.onGround ? "GND" : feet == null ? "-" : altText(feet);
  const arrow = verticalArrowSymbol(item);
  const trend = arrow === "↑" ? "up" : arrow === "↓" ? "down" : "level";
  const arrowHtml = arrow ? `<span class="tt-trend ${trend}">${arrow}</span>` : "";
  const parts = [`<span class="tt-alt">${arrowHtml}${escapeHtml(alt)}</span>`];
  if (item.gs != null) parts.push(escapeHtml(formatSpeed(item)));
  return parts.join(" · ");
}

// Small pin toggle rendered like text in the top-right of a popover; clicking it keeps the
// aircraft's label (and track) shown always. Handled by delegated click listeners.
function pinIcon(hex) {
  const on = pinned.value.has(hex) ? " on" : "";
  return `<span class="tt-pin${on}" data-hex="${hex}" title="Pin label & track">`
    + `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">`
    + `<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg></span>`;
}

// Tactical data block beside each 3D target: callsign + pin over the shared status line.
function datablockHtml(item) {
  return `<span class="t3d-datablock"><span class="db-top"><b>${escapeHtml(formatFlight(item))}</b><span class="tt-top-actions"><span class="tt-age">${escapeHtml(formatAge(item.observedAt))}</span>${pinIcon(item.hex)}</span></span>`
    + `<span>${targetLine(item, true)}</span></span>`;
}

function airfieldTooltip(field) {
  const codes = [field.icao, field.iata].filter(Boolean).join(" · ");
  const meta = [codes, field.city].filter(Boolean).join(" — ");
  const runwayRows = field.runways.length
    ? field.runways.map((runway) => {
        const ends = runway.ends || "Direction unknown";
        const length = runway.lengthM == null ? "Length unknown" : `${numberFormatter(0).format(runway.lengthM)} m`;
        return `<span class="af-tt-runway"><span>${escapeHtml(ends)}</span><span>${escapeHtml(length)}</span></span>`;
      }).join("")
    : '<span class="af-tt-runway-empty">Data unavailable</span>';
  return `<span class="af-tt-name">${escapeHtml(field.name)}</span>`
    + (meta ? `<span class="af-tt-meta">${escapeHtml(meta)}</span>` : "")
    + `<span class="af-tt-runways"><span class="af-tt-runway-title">Runways</span>${runwayRows}</span>`;
}

function selectedTrackSeconds() {
  return selectedTrack.value
    .map((point) => Date.parse(point.positionAt) / 1000)
    .filter((value) => Number.isFinite(value));
}

function destroyHistoryChart() {
  if (chartResizeObserver) {
    chartResizeObserver.disconnect();
    chartResizeObserver = null;
  }
  if (historyChart) {
    historyChart.destroy();
    historyChart = null;
  }
}

function setHistoryChartCursor() {
  if (!historyChart || !selectedTrack.value.length) return;
  const point = selectedTrack.value[Math.min(playbackIndex.value, selectedTrack.value.length - 1)];
  const x = Date.parse(point?.positionAt) / 1000;
  if (!Number.isFinite(x)) return;
  historyChart.setCursor({ left: historyChart.valToPos(x, "x"), top: 0 });
}

function renderHistoryChart() {
  if (!chartEl.value) return;
  destroyHistoryChart();
  const xValues = selectedTrackSeconds();
  const metrics = activeHistoryMetrics();
  if (!metrics.length || xValues.length < 2) return;

  const points = selectedTrack.value.filter((point) => Number.isFinite(Date.parse(point.positionAt)));
  const availableMetrics = metrics.filter((metric) => points.some((point) => metricChartValue(metric, point) != null));
  if (!availableMetrics.length) return;
  const data = [
    points.map((point) => Date.parse(point.positionAt) / 1000),
    ...availableMetrics.map((metric) => points.map((point) => metricChartValue(metric, point))),
  ];

  const width = Math.max(280, chartEl.value.clientWidth || 360);
  const scales = Object.fromEntries(availableMetrics.map((metric) => [metric.key, { auto: true }]));
  // Compact tick labels (25,000 -> 25k) + small font + narrow axes; the coloured series
  // buttons above already name each metric, so the rotated axis labels are dropped.
  const compactTick = (value) => {
    if (value == null) return "";
    if (Math.abs(value) >= 1000) {
      const k = value / 1000;
      return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
    }
    return `${value}`;
  };
  const axisFont = "10px system-ui, -apple-system, sans-serif";
  const axes = [
    {
      stroke: "#96a3a4",
      font: axisFont,
      grid: { stroke: "rgb(238 245 244 / 0.08)" },
    },
    ...availableMetrics.map((metric, index) => ({
      scale: metric.key,
      side: index % 2 ? 1 : 3,
      stroke: metric.color,
      font: axisFont,
      gap: 3,
      // No fixed size: let uPlot auto-size the gutter to the (now compact) ticks so the
      // numbers aren't clipped.
      values: (self, splits) => splits.map(compactTick),
      grid: { stroke: index === 0 ? "rgb(238 245 244 / 0.08)" : "transparent" },
    })),
  ];

  historyChart = new uPlot({
    width,
    height: 220,
    tzDate: (ts) => new Date(ts * 1000),
    cursor: {
      show: true,
      x: true,
      y: false,
      drag: { x: false, y: false },
    },
    scales: {
      x: { time: true },
      ...scales,
    },
    axes,
    series: [
      {},
      ...availableMetrics.map((metric) => ({
        label: metric.label,
        scale: metric.key,
        stroke: metric.color,
        width: 2,
        points: { show: false },
      })),
    ],
    legend: { show: true },
  }, data, chartEl.value);
  setHistoryChartCursor();

  // Keep the chart filling its container as the panel/sidebar is resized.
  chartResizeObserver = new ResizeObserver(() => {
    if (!historyChart || !chartEl.value) return;
    const next = Math.max(260, Math.floor(chartEl.value.clientWidth));
    if (next !== historyChart.width) historyChart.setSize({ width: next, height: 220 });
  });
  chartResizeObserver.observe(chartEl.value);
}

function queueHistoryChartRender() {
  nextTick(() => renderHistoryChart());
}

function trackSegmentColor(point) {
  if (point.onGround) return ALT_COLOR_GROUND;
  const alt = point.altBaro ?? point.altGeom;
  if (alt == null) return ALT_COLOR_NONE;
  return altitudeColorFeet(Math.round(alt / 500) * 500);
}

function startPlaybackTimer() {
  clearInterval(playbackTimer);
  playbackTimer = null;
  if (!playbackSpeed.value || selectedTrack.value.length < 2) return;
  playbackTimer = setInterval(() => {
    if (playbackIndex.value >= selectedTrack.value.length - 1) {
      playbackSpeed.value = 0;
      return;
    }
    playbackIndex.value += 1;
    renderTrackView();
  }, Math.max(80, 1000 / playbackSpeed.value));
}

function setPlaybackSpeed(speed) {
  if (!speed) {
    playbackSpeed.value = 0;
    return;
  }
  if (!selectedTrack.value.length) return;
  if (playbackIndex.value >= selectedTrack.value.length - 1) playbackIndex.value = 0;
  playbackSpeed.value = speed;
  renderTrackView();
  setHistoryChartCursor();
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, { cache: "no-store", ...init });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

function clearAllTrackCache() {
  allTrackRequestVersion += 1;
  allTrackCursors = new Map();
  if (allTrackCache.value.size) allTrackCache.value = new Map();
  tac3d?.dataPass();
}

async function refreshAllAircraftTracks({ reset = false } = {}) {
  if (!settings.value.allAircraftTracks) {
    if (allTrackCache.value.size || allTrackCursors.size) clearAllTrackCache();
    return;
  }

  const hexes = trailAircraftHexes.value;
  if (!hexes.length) {
    clearAllTrackCache();
    return;
  }

  const requestVersion = ++allTrackRequestVersion;
  const previousTracks = reset ? new Map() : allTrackCache.value;
  const previousCursors = reset ? new Map() : allTrackCursors;
  const to = new Date();
  const from = new Date(to.getTime() - trackHours.value * 60 * 60 * 1000);

  try {
    const chunks = [];
    for (let index = 0; index < hexes.length; index += 250) chunks.push(hexes.slice(index, index + 250));
    const results = await Promise.all(chunks.map((chunk) => fetchJson("/api/aircraft/tracks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        aircraft: chunk.map((hex) => ({ hex, afterId: previousCursors.get(hex) ?? null })),
        from: from.toISOString(),
        to: to.toISOString(),
        historic: false,
      }),
    })));
    if (requestVersion !== allTrackRequestVersion || !settings.value.allAircraftTracks) return;

    const returned = new Map(results.flatMap((result) => result.tracks || []).map((track) => [track.hex, track]));
    const nextTracks = new Map();
    const nextCursors = new Map();
    for (const hex of hexes) {
      const track = returned.get(hex);
      const current = reset ? [] : (previousTracks.get(hex) || []);
      nextTracks.set(hex, mergeTrackPoints(current, track?.points || []));
      const cursor = track?.cursorId ?? previousCursors.get(hex);
      if (cursor != null) nextCursors.set(hex, cursor);
    }
    allTrackCache.value = nextTracks;
    allTrackCursors = nextCursors;
    tac3d?.dataPass();
  } catch (error) {
    if (requestVersion === allTrackRequestVersion) console.error(error);
  }
}

async function refreshTrackRange() {
  await Promise.all([
    selectedHex.value ? refreshTrack() : null,
    refreshPinnedTracks(),
    refreshAllAircraftTracks({ reset: true }),
  ]);
}

async function refreshLive() {
  try {
    // Receivers ride the hot path with aircraft (it is a cheap endpoint) so "Updated"
    // stays fresh; the heavy /api/coverage query is deferred to refreshCoverage().
    const [current, receiverResult] = await Promise.all([
      fetchJson("/api/aircraft/current"),
      fetchJson("/api/receivers/public"),
    ]);
    aircraft.value = current.aircraft || [];
    receivers.value = receiverResult.receivers || [];
    // "Updated" reflects when a receiver actually last sent data, not our poll time —
    // otherwise it resets to 0 every poll even while the feed is stalled.
    const lastSeen = receivers.value.reduce((max, receiver) => {
      const t = Date.parse(receiver.lastSeenAt);
      return Number.isFinite(t) && t > max ? t : max;
    }, 0);
    lastUpdated.value = lastSeen ? new Date(lastSeen).toISOString() : null;
    status.value = "online";
    await Promise.all([
      selectedHex.value ? refreshTrack(false) : null,
      refreshPinnedTracks(),
      refreshAllAircraftTracks(),
    ]);
  } catch (err) {
    status.value = "offline";
    console.error(err);
  }
}

// The server rebuilds one complete occupancy snapshot every five minutes. The browser only
// downloads that finished snapshot on the same cadence; live ingest events never trigger mesh
// generation or repeated downloads.
async function refreshCoverage() {
  try {
    coverage.value = (await fetchJson("/api/coverage")) || { areas: [], points: [] };
    tac3d?.drawCoverage();
  } catch (err) {
    console.error(err);
  }
}

// Coalesce bursts of refreshes into a single fetch and never let two run concurrently.
// A short window keeps the live path near-instant; a longer one collapses multi-receiver
// ingests before hitting the expensive coverage query.
function makeCoalescer(fn) {
  let timer = null;
  let inFlight = false;
  function run() {
    timer = null;
    if (inFlight) {
      schedule(50);
      return;
    }
    inFlight = true;
    Promise.resolve(fn()).finally(() => { inFlight = false; });
  }
  function schedule(delay = 250) {
    if (timer != null) return;
    timer = setTimeout(run, delay);
  }
  return { schedule, cancel() { if (timer != null) clearTimeout(timer); } };
}
const liveRefresher = makeCoalescer(refreshLive);
const coverageRefresher = makeCoalescer(refreshCoverage);

async function refreshTrack(resetPlayback = true) {
  const hex = selectedHex.value;
  if (!hex) return;
  const requestVersion = ++selectedTrackRequestVersion;
  const to = new Date();
  const from = new Date(to.getTime() - trackHours.value * 60 * 60 * 1000);
  const params = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
  const result = await fetchJson(`/api/aircraft/${hex}/track?${params}`);
  if (requestVersion !== selectedTrackRequestVersion || selectedHex.value !== hex) return;
  // Was the user watching the live edge (vs. scrubbing to a past point) before new
  // points arrived? If so, follow the new live edge so a stale playback marker does not
  // spawn behind the moving aircraft; only a deliberate scrub keeps its past position.
  const wasAtLiveEdge = playbackIndex.value >= selectedTrack.value.length - 1;
  selectedTrackRaw.value = result.points || [];
  const lastIndex = Math.max(0, selectedTrack.value.length - 1);
  if (resetPlayback || (!playbackSpeed.value && wasAtLiveEdge)) {
    if (resetPlayback) playbackSpeed.value = 0;
    playbackIndex.value = lastIndex;
  } else {
    playbackIndex.value = Math.min(playbackIndex.value, lastIndex);
  }
  renderTrackView();
}

async function fetchTrackPoints(hex) {
  const to = new Date();
  const from = new Date(to.getTime() - trackHours.value * 60 * 60 * 1000);
  const params = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
  const result = await fetchJson(`/api/aircraft/${hex}/track?${params}`);
  return result.points || [];
}

// Re-fetch every pinned aircraft's track (their trails stay shown), then redraw.
async function refreshPinnedTracks() {
  if (!pinned.value.size) {
    if (pinnedTracks.value.size) pinnedTracks.value = new Map();
    return;
  }
  const next = new Map();
  await Promise.all([...pinned.value].map(async (hex) => {
    try { next.set(hex, await fetchTrackPoints(hex)); } catch (err) { console.error(err); }
  }));
  pinnedTracks.value = next;
  tac3d?.dataPass();
}

async function togglePin(hex) {
  const next = new Set(pinned.value);
  if (next.has(hex)) next.delete(hex);
  else next.add(hex);
  pinned.value = next;
  await refreshPinnedTracks();
  tac3d?.dataPass();
}

async function selectAircraft(hex) {
  if (!hex || selectedHex.value === hex) return;
  // Invalidate the previous request and erase its points before changing the selected hex. This
  // prevents one render frame from treating aircraft A's final trail point as aircraft B's anchor.
  selectedTrackRequestVersion += 1;
  selectedTrackRaw.value = [];
  playbackSpeed.value = 0;
  playbackIndex.value = 0;
  selectedHex.value = hex;
  // Selection alone keeps the camera untouched. If Track is already active, dataPass transfers
  // the existing tracked orbit smoothly to the newly selected aircraft.
  tac3d?.dataPass();
  await refreshTrack();
  await nextTick();
}

function clearSelection() {
  selectedTrackRequestVersion += 1;
  selectedTrackRaw.value = [];
  selectedHex.value = null;
  playbackSpeed.value = 0;
  playbackIndex.value = 0;
  tac3d?.dataPass();
}

// Clicking a target toggles selection; clicking a different one switches to it.
function toggleAircraft(hex) {
  if (selectedHex.value === hex) clearSelection();
  else selectAircraft(hex);
}

function onGlobalKeydown(event) {
  if (event.key !== "Escape") return;
  if (selectedHex.value) clearSelection();
}

function browserLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error("Browser geolocation is unavailable")); return; }
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => resolve({ lat: coords.latitude, lon: coords.longitude }),
      reject,
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 },
    );
  });
}

// With a selected aircraft this is the tracking toggle. Without one, locate the browser's
// current position after the normal browser permission prompt.
async function recenterView() {
  const sel = selectedAircraft.value;
  const hasSel = sel && sel.lat != null && sel.lon != null;
  if (hasSel) {
    trackingActive.value = tac3d?.toggleTracking(sel.lon, sel.lat, sel.altBaro ?? sel.altGeom) === true;
    return;
  }
  trackingActive.value = false;
  try {
    const here = await browserLocation();
    if (selectedHex.value) return; // selection changed while waiting for the permission/location fix
    tac3d?.locateBrowser(here.lon, here.lat);
  } catch (error) {
    console.warn("Unable to locate browser position", error);
  }
}

// Playback ghost for the 3D view — same rules as drawPlaybackMarker(): only shown while
// scrubbed off the live edge or actively playing back.
function getPlaybackGhost() {
  if (!selectedTrack.value.length) return null;
  const latestIndex = selectedTrack.value.length - 1;
  if (!playbackSpeed.value && playbackIndex.value >= latestIndex) return null;
  const point = selectedTrack.value[Math.min(playbackIndex.value, latestIndex)];
  if (!point || point.lat == null || point.lon == null) return null;
  return {
    ...(selectedAircraft.value || {}),
    hex: selectedHex.value || point.hex,
    lat: point.lat,
    lon: point.lon,
    altBaro: point.altBaro,
    altGeom: point.altGeom,
    gs: point.gs,
    track: point.track,
    onGround: point.onGround,
  };
}

function renderTrackView() {
  tac3d?.dataPass();
}

// All app state flows into the sole 3D map through these getters and callbacks.
async function ensureTactical3d() {
  tac3dPromise ??= import("./tactical3d.js").then(({ createTactical3d }) => {
    tac3d = createTactical3d({
      container: map3dEl.value,
      deps: {
        getAircraft: () => aircraft.value,
        getSelectedHex: () => selectedHex.value,
        getSelectedTrack: () => selectedTrack.value,
        getConflicts: () => conflicts.value,
        getCoverage: () => coverage.value,
        getPlaybackGhost,
        getSettings: () => settings.value,
        getPinned: () => pinned.value,
        getPinnedTracks: () => [...pinnedTracks.value].map(([hex, points]) => ({
          hex,
          points,
          historic: historicTrackHexes.value.has(hex),
        })),
        getAllAircraftTracks: () => [...allTrackCache.value].map(([hex, points]) => ({ hex, points })),
        togglePin,
        datablockHtml,
        airfieldTooltip,
        passesFilters,
        isDropped,
        isCoasting,
        altitudeColor,
        altitudeColorFeet,
        trackSegmentColor,
        planeSizeScale,
        onSelect: toggleAircraft,
        onHover: (hex) => { hoveredHex.value = hex; },
        onTrackingChange: (active) => { trackingActive.value = active; },
        onMapClick: () => { if (selectedHex.value) clearSelection(); },
      },
    });
    return tac3d;
  });
  return tac3dPromise;
}

function resetFilters() {
  Object.assign(settings.value, {
    showGround: true,
    showNonIcao: true,
    source: "all",
    altMin: "",
    altMax: "",
  });
}

watch(aircraft, () => {
  tac3d?.dataPass();
});
watch(searchQuery, () => {
  tac3d?.dataPass();
});
watch(hoveredHex, (next, prev) => {
  tac3d?.setHoverClass(prev, next);
});
watch(selectedHistoryMetrics, () => queueHistoryChartRender(), { deep: true });
watch(selectedTrack, () => queueHistoryChartRender());
watch(playbackIndex, () => {
  renderTrackView();
  setHistoryChartCursor();
});

onMounted(async () => {
  window.addEventListener("keydown", onGlobalKeydown);
  await ensureTactical3d();
  tac3d.applySettings();
  await refreshLive();
  await refreshCoverage();
  // Fallback polls in case the SSE stream drops. Coverage is an independent five-minute
  // snapshot, deliberately decoupled from the five-second aircraft updates.
  refreshTimer = setInterval(() => liveRefresher.schedule(0), 10000);
  coverageTimer = setInterval(() => coverageRefresher.schedule(0), 300000);
  clockTimer = setInterval(() => {
    now.value = Date.now();
    // Coast/drop transitions and each data block's age (#s) are time-driven; a dataPass
    // is cheap (~100 targets) so run it every tick to keep the labels fresh.
    tac3d?.dataPass();
  }, 1000);
  connectEvents();
});

function connectEvents() {
  eventSource?.close();
  eventSource = new EventSource("/api/events");
  // A (re)opened stream may have missed events while down — resync immediately.
  eventSource.onopen = () => liveRefresher.schedule(0);
  eventSource.addEventListener("ingest", () => {
    liveRefresher.schedule();
  });
  eventSource.onerror = () => {
    status.value = "reconnecting";
    // The browser only retries transient drops on its own; an HTTP error response
    // (e.g. a 502 while the server redeploys) fails the stream PERMANENTLY per the
    // EventSource spec, silently demoting the tab to the 10s fallback poll forever —
    // rebuild the stream ourselves.
    if (eventSource.readyState === EventSource.CLOSED) {
      clearTimeout(sseRetryTimer);
      sseRetryTimer = setTimeout(connectEvents, 5000);
    }
  };
}

onUnmounted(() => {
  clearInterval(refreshTimer);
  clearInterval(coverageTimer);
  clearInterval(clockTimer);
  clearInterval(playbackTimer);
  liveRefresher.cancel();
  coverageRefresher.cancel();
  destroyHistoryChart();
  window.removeEventListener("keydown", onGlobalKeydown);
  clearTimeout(sseRetryTimer);
  eventSource?.close();
  tac3d?.destroy();
  tac3d = null;
});
</script>

<template>
  <main class="shell" :style="shellStyle">
    <section class="map-stage">
      <div ref="map3dEl" class="map map-3d"></div>
      <div class="topbar">
        <div>
          <div class="brand">Skytrace</div>
          <div class="subline">
            <span :class="['status-dot', status]"></span>
            {{ status }} · {{ filteredAircraft.length }}/{{ aircraft.length }} aircraft · {{ receivers.length }} receivers
          </div>
        </div>
      </div>
      <div class="map-corner-controls">
        <button
          class="icon-button map-track-button"
          :class="{ active: trackingActive }"
          :title="selectedAircraft ? (trackingActive ? 'Stop tracking' : 'Track selected aircraft') : 'Go to my location'"
          :aria-label="selectedAircraft ? (trackingActive ? 'Stop tracking' : 'Track selected aircraft') : 'Go to my location'"
          @click="recenterView"
        >
          <LocateFixed :size="17" />
          <span>{{ trackingButtonText }}</span>
        </button>
        <div class="map-legend" aria-hidden="true">
          <div class="legend-title">Altitude ({{ altitudeLegend.unit }})</div>
          <div class="legend-body">
            <div class="legend-bar" :style="{ background: altitudeLegend.gradient }"></div>
            <div class="legend-ticks">
              <span v-for="(tick, i) in altitudeLegend.ticks" :key="i">{{ tick.label }}</span>
            </div>
          </div>
          <div class="legend-ground">
            <span class="legend-ground-swatch" :style="{ background: altitudeLegend.groundColor }"></span>Ground
          </div>
        </div>
      </div>
    </section>

    <aside class="panel" :class="{ 'dock-open': controlsOpen }">
      <div class="panel-resize" title="Drag to resize" @pointerdown="startPanelResize"></div>
      <div class="panel-main">
        <div class="search-wrap">
          <Search :size="18" />
          <input v-model="search" type="search" placeholder="Search hex, callsign, squawk, source" />
        </div>

        <div class="metric-grid">
          <div><span>{{ stats.live }}</span><small>Live aircraft</small></div>
          <div><span>{{ lastUpdated ? formatAge(lastUpdated) : "-" }}</span><small>Updated</small></div>
          <div><span>{{ receivers.length }}</span><small>Receivers</small></div>
        </div>
        <div v-if="sourceChips.length" class="source-chips">
          <span v-for="chip in sourceChips" :key="chip.key" class="source-chip">{{ chip.label }} <b>{{ chip.count }}</b></span>
        </div>

        <section v-if="selectedAircraft" class="detail">
          <div v-if="selectedAlert" :class="['detail-alert', selectedAlert.level]">
            <span class="detail-alert-label">{{ selectedAlert.label }}</span>
            <span v-if="selectedAlert.code" class="detail-alert-code">{{ selectedAlert.code }}</span>
          </div>
          <div class="detail-head">
            <div>
              <div class="detail-title">
                <h2>{{ formatFlight(selectedAircraft) }}</h2>
                <span class="detail-age" title="Last update">{{ formatAge(selectedAircraft.observedAt) }}</span>
              </div>
              <p>{{ selectedAircraft.hex.toUpperCase() }} · {{ sourceLabel(selectedAircraft) }}</p>
            </div>
            <button class="icon-button small" title="Close" @click="clearSelection"><X :size="16" /></button>
          </div>

          <dl>
            <div class="detail-metric" :class="detailMetricClass('altBaro')" @click="toggleHistoryMetrics('altBaro')"><dt>Baro Alt</dt><dd>{{ formatAltitude(selectedAircraft, "baro") }}</dd></div>
            <div class="detail-metric" :class="detailMetricClass('altGeom')" @click="toggleHistoryMetrics('altGeom')"><dt>Geom Alt</dt><dd>{{ formatAltitude(selectedAircraft, "geom") }}</dd></div>
            <div class="detail-metric" :class="detailMetricClass('gs')" @click="toggleHistoryMetrics('gs')"><dt>Ground Speed</dt><dd>{{ formatSpeed(selectedAircraft) }}</dd></div>
            <div class="detail-metric" :class="detailMetricClass(['ias', 'tas'])" @click="toggleHistoryMetrics(['ias', 'tas'])"><dt>IAS / TAS</dt><dd>{{ formatSpeed(selectedAircraft, "ias") }} / {{ formatSpeed(selectedAircraft, "tas") }}</dd></div>
            <div class="detail-metric" :class="detailMetricClass('mach')" @click="toggleHistoryMetrics('mach')"><dt>Mach</dt><dd>{{ selectedAircraft.mach == null ? "-" : selectedAircraft.mach.toFixed(3) }}</dd></div>
            <div class="detail-metric" :class="detailMetricClass('verticalRate')" @click="toggleHistoryMetrics('verticalRate')"><dt>Vert Rate</dt><dd>{{ formatRate(selectedAircraft.baroRate ?? selectedAircraft.geomRate) }}</dd></div>
            <div class="detail-metric" :class="detailMetricClass('track')" @click="toggleHistoryMetrics('track')"><dt>Track</dt><dd>{{ formatDegrees(selectedAircraft.track) }}</dd></div>
            <div class="detail-metric" :class="detailMetricClass('heading')" @click="toggleHistoryMetrics('heading')"><dt>Heading</dt><dd>{{ formatDegrees(selectedAircraft.trueHeading ?? selectedAircraft.magHeading) }}</dd></div>
            <div><dt>Squawk</dt><dd>{{ selectedAircraft.squawk || "-" }}</dd></div>
            <div class="detail-metric" :class="detailMetricClass('rssi')" @click="toggleHistoryMetrics('rssi')"><dt>RSSI</dt><dd>{{ selectedAircraft.rssi == null ? "-" : `${selectedAircraft.rssi.toFixed(1)} dBFS` }}</dd></div>
            <div class="detail-metric" :class="detailMetricClass('messages')" @click="toggleHistoryMetrics('messages')"><dt>Messages</dt><dd>{{ selectedAircraft.messages ?? "-" }}</dd></div>
            <div><dt>Receivers</dt><dd>{{ selectedAircraft.receiverCount }}</dd></div>
            <div class="detail-metric" :class="detailMetricClass('windSpeed')" @click="toggleHistoryMetrics('windSpeed')"><dt>Wind</dt><dd>{{ selectedAircraft.windSpeed == null ? "-" : `${formatSpeed({ gs: selectedAircraft.windSpeed })} @ ${formatDegrees(selectedAircraft.windDirection)}` }}</dd></div>
            <div class="detail-metric" :class="detailMetricClass(['oat', 'tat'])" @click="toggleHistoryMetrics(['oat', 'tat'])"><dt>Temp</dt><dd>{{ formatTemp(selectedAircraft.oat) }} / {{ formatTemp(selectedAircraft.tat) }}</dd></div>
            <div><dt>Selected Alt</dt><dd>{{ altText(selectedAircraft.navAltitudeMcp ?? selectedAircraft.navAltitudeFms) }}</dd></div>
            <div><dt>Accuracy</dt><dd>NACp {{ selectedAircraft.nacP ?? "-" }} · SIL {{ selectedAircraft.sil ?? "-" }} · RC {{ selectedAircraft.rc ?? "-" }}</dd></div>
          </dl>

          <div class="history-panel">
            <div class="history-options">
              <label class="history-toggle">
                <input v-model="selectedHistoric" type="checkbox" />
                <span>Historic</span>
              </label>
              <label class="select-row">
                <span>History</span>
                <select v-model.number="trackHours">
                  <option :value="1">1h</option>
                  <option :value="6">6h</option>
                  <option :value="24">24h</option>
                  <option :value="168">7d</option>
                </select>
              </label>
            </div>

            <div class="history-chart-head">
              <span>Graph</span>
              <div class="history-series">
                <button
                  v-for="metric in activeHistoryMetrics()"
                  :key="metric.key"
                  type="button"
                  :style="{ '--series-color': metric.color }"
                  @click="toggleHistoryMetrics(metric.key)"
                >
                  {{ metric.label }}
                </button>
              </div>
            </div>
            <div class="history-chart-wrap">
              <div ref="chartEl" class="history-chart"></div>
              <div v-if="!selectedHistoryMetrics.length || selectedTrack.length < 2" class="history-empty">
                No graph series
              </div>
            </div>

            <div class="playback-controls">
              <button type="button" class="playback-stop" title="Pause" @click="setPlaybackSpeed(0)">
                <Pause :size="15" /> Pause
              </button>
              <button
                v-for="speed in [1, 5, 10, 20, 40]"
                :key="speed"
                type="button"
                :class="['playback-speed', { active: playbackSpeed === speed }]"
                @click="setPlaybackSpeed(speed)"
              >
                <Play :size="12" /> {{ speed }}x
              </button>
            </div>
            <input v-if="selectedTrack.length" v-model.number="playbackIndex" type="range" min="0" :max="Math.max(0, selectedTrack.length - 1)" step="1" />
            <div class="history-meta">
              <span>{{ selectedTrack.length }} points</span>
              <span>{{ selectedHistoryPoint?.positionAt || "-" }}</span>
              <a :href="kmlHref"><Download :size="14" /> KML</a>
            </div>

            <div class="tracklog">
              <button type="button" class="tracklog-toggle" @click="tracklogOpen = !tracklogOpen">
                <ChevronDown :class="['chevron', { open: tracklogOpen }]" :size="16" />
                Track log <small>{{ selectedTrack.length }} points</small>
              </button>
              <div v-if="tracklogOpen" class="tracklog-body">
                <table>
                  <thead>
                    <tr><th>Time</th><th>Alt</th><th>GS</th><th>Trk</th><th>V/S</th><th>Lat, Lon</th></tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="row in tracklogRows"
                      :key="row.index"
                      :class="{ active: playbackIndex === row.index }"
                      @click="focusTrackPoint(row.index)"
                    >
                      <td>{{ formatClock(row.point.positionAt) }}</td>
                      <td>{{ pointAltitude(row.point) }}</td>
                      <td>{{ pointSpeed(row.point) }}</td>
                      <td>{{ formatDegrees(row.point.track) }}</td>
                      <td>{{ formatRate(row.point.baroRate ?? row.point.geomRate) }}</td>
                      <td>{{ row.point.lat.toFixed(3) }}, {{ row.point.lon.toFixed(3) }}</td>
                    </tr>
                  </tbody>
                </table>
                <div v-if="!tracklogRows.length" class="tracklog-empty">No positioned track points</div>
                <div v-else-if="tracklogHidden" class="tracklog-more">+{{ tracklogHidden }} older points not shown</div>
              </div>
            </div>
          </div>
        </section>

        <section v-show="!selectedAircraft" class="list">
          <header>
            <CircleDot :size="17" /><span>Aircraft</span>
            <select v-model="sortKey" class="list-sort">
              <option value="callsign">Callsign</option>
              <option value="altitude">Altitude</option>
              <option value="speed">Speed</option>
              <option value="recent">Recent</option>
            </select>
          </header>
          <button
            v-for="item in filteredAircraft"
            :key="item.hex"
            :class="['aircraft-row', { active: selectedHex === item.hex, hovered: hoveredHex === item.hex, 'is-alert': !!aircraftAlert(item), coasting: isCoasting(item) }]"
            @click="selectAircraft(item.hex)"
            @mouseenter="setHover(item.hex)"
            @mouseleave="clearHover(item.hex)"
          >
            <span class="alt-dot" :style="{ background: altitudeColor(item) }"></span>
            <span><strong>{{ formatFlight(item) }}</strong><small>{{ item.hex.toUpperCase() }} · {{ sourceLabel(item) }}</small></span>
            <span><strong>{{ formatAltitude(item) }}</strong><small>{{ formatSpeed(item) }} · {{ formatAge(item.observedAt) }}</small></span>
          </button>
        </section>
      </div>

      <section :class="['settings-dock', { open: controlsOpen }]">
        <button type="button" class="settings-toggle" @click="controlsOpen = !controlsOpen">
          <span class="settings-toggle-title"><SlidersHorizontal :size="17" /> Filters & display</span>
          <small>{{ settings.source === "all" ? "all sources" : settings.source }} · {{ settings.units }} · 3D terrain</small>
          <ChevronDown :class="['chevron', { open: controlsOpen }]" :size="18" />
        </button>
        <div v-show="controlsOpen" class="settings-body">
          <section class="receiver-list">
            <header><RadioTower :size="17" /><span>Receivers</span></header>
            <div v-for="receiver in receivers" :key="receiver.id" class="receiver-row">
              <span :class="['receiver-light', { on: receiver.online }]"></span>
              <span>{{ receiver.name }}</span>
              <small>{{ receiver.currentAircraft }} aircraft</small>
            </div>
          </section>

          <div class="dock-stats">
            <section class="coverage-card">
              <header><Layers :size="17" /><span>Coverage</span></header>
              <div class="coverage-note">
                {{ coverageSummary.areas }} areas · {{ coverageSummary.positions }} positions
                <template v-if="coverageSummary.triangles"> · {{ numberFormatter(0).format(coverageSummary.triangles) }} triangles</template>
              </div>
            </section>
            <section class="coverage-card">
              <header><TowerControl :size="17" /><span>Airfields</span></header>
              <div class="coverage-note">
                {{ settings.airfields ? (settings.airfieldsMinor ? airfieldSummary.total : airfieldSummary.coded) : 0 }} shown · {{ airfieldSummary.minor }} minor
              </div>
            </section>
          </div>

          <section class="controls">
            <header><Filter :size="17" /><span>Filters</span><button type="button" @click="resetFilters">Reset</button></header>
            <div class="control-grid">
              <label><span>Min altitude</span><input v-model="settings.altMin" inputmode="numeric" placeholder="ft" /></label>
              <label><span>Max altitude</span><input v-model="settings.altMax" inputmode="numeric" placeholder="ft" /></label>
              <label><span>Source</span><select v-model="settings.source"><option v-for="source in sourceOptions" :key="source" :value="source">{{ source }}</option></select></label>
            </div>
            <div class="toggle-row">
              <label><input v-model="settings.showGround" type="checkbox" /> Ground</label>
              <label><input v-model="settings.showNonIcao" type="checkbox" /> Non-ICAO</label>
              <label><input v-model="settings.coverage" type="checkbox" /> Coverage</label>
              <label><input v-model="settings.airfields" type="checkbox" /> Airfields</label>
              <label><input v-model="settings.airfieldsMinor" type="checkbox" :disabled="!settings.airfields" /> Minor fields</label>
              <label><input v-model="settings.proximity" type="checkbox" /> Proximity alerts</label>
              <label><input v-model="settings.coastDrop" type="checkbox" /> Coast / drop</label>
            </div>
          </section>

          <section class="controls">
            <header><Settings :size="17" /><span>Display</span></header>
            <div class="control-grid">
              <label><span>Units</span><select v-model="settings.units"><option value="aero">Aeronautical</option><option value="metric">Metric</option><option value="imperial">Imperial</option></select></label>
              <label><span>Terrain ×{{ Number(settings.terrainExaggeration).toFixed(1) }}</span><input v-model.number="settings.terrainExaggeration" type="range" min="1" max="4" step="0.1" /></label>
            </div>
            <div class="toggle-row">
              <label><input v-model="settings.flightLevels" type="checkbox" /> Flight levels</label>
              <label><input v-model="settings.terrainSatellite" type="checkbox" /> Satellite terrain</label>
              <label><input v-model="settings.allAircraftTracks" type="checkbox" /> All aircraft trails</label>
            </div>
          </section>
        </div>
      </section>
    </aside>
  </main>
</template>
