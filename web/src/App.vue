<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import L from "leaflet";
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
  Rotate3d,
  Ruler,
  Search,
  Settings,
  SlidersHorizontal,
  TowerControl,
  X,
} from "@lucide/vue";
import { AIRFIELDS, isMinorAirfield } from "./airfields.js";
import { RUNWAYS } from "./runways.js";

const SETTINGS_KEY = "skytrace.settings.v3";
const DEFAULT_SETTINGS = {
  units: "aero",
  baseLayer: "satellite",
  iconScale: 1,
  labels: false,
  coverage: true,
  coverageBands: false,
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
  view3d: true,
  terrainExaggeration: 2,
  terrainSatellite: true,
};

const baseLayers = {
  satellite: {
    label: "Satellite",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    options: {
      maxZoom: 19,
      attribution: "Tiles &copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community",
    },
  },
  osm: {
    label: "OSM",
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    options: {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors",
    },
  },
  dark: {
    label: "Dark",
    url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    options: {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
    },
  },
};

function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

const mapEl = ref(null);
const map3dEl = ref(null);
// True only once the 3D scene is ready and shown; the containers swap on this, not on
// settings.view3d, so the UI never flips to a blank canvas while the chunk/DEM loads.
const view3dActive = ref(false);
const aircraft = ref([]);
const receivers = ref([]);
const coverage = ref({ areas: [], points: [] });
const selectedHex = ref(null);
const hoveredHex = ref(null);
const selectedTrack = ref([]);
// Pinned aircraft: their popover label AND their track stay shown regardless of hover /
// selection. pinnedTracks caches each pinned hex's track points.
const pinned = ref(new Set());
const pinnedTracks = ref(new Map());
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
// Range/bearing measure tool: click two map points to read distance + bearing.
const measureMode = ref(false);
const measurePoints = ref([]);
const measureCursor = ref(null);

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
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; map?.invalidateSize(); });
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    document.body.style.userSelect = "";
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ sidebarWidth: sidebarWidth.value, panelHeight: panelHeight.value }));
    map?.invalidateSize();
  };
  document.body.style.userSelect = "none";
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

let map;
let tileLayer;
let trackLayer;
let playbackMarker;
let coverageLayer;
let airfieldLayer;
let conflictLayer;
let measureLayer;
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
const markers = new Map();

watch(settings, (value) => {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(value));
  if (view3dActive.value) {
    tac3d?.applySettings();
    queueHistoryChartRender();
    return;
  }
  applyBaseLayer();
  upsertMarkers();
  drawCoverage();
  drawAirfields();
  drawConflicts();
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

// Shared predicate for the sidebar list and the map markers, so upsertMarkers() can
// reuse it without materialising a second filtered array. The search haystack is only
// built when there is actually a query.
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

// Caps the sidebar list only. Map markers are limited separately (MARKER_LIMIT + viewport
// culling), so the map can show aircraft that fall past this list cap — the two limits
// intentionally serve different surfaces.
const LIST_LIMIT = 600;
const filteredAircraft = computed(() =>
  sortAircraft(aircraft.value.filter(passesFilters), sortKey.value).slice(0, LIST_LIMIT),
);

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

// --- Great-circle helpers (nautical miles + true bearing) for the measure tool and the
// proximity check. Points are {lat, lng} to match Leaflet's LatLng. ---
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
function bearingDeg(a, b) {
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const dLon = toRadians(b.lng - a.lng);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
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
const conflictHexes = computed(() => {
  const set = new Set();
  for (const pair of conflicts.value) { set.add(pair.a.hex); set.add(pair.b.hex); }
  return set;
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

function aircraftKind(item) {
  if (item.onGround) return "ground";
  const cat = String(item.category || "").toUpperCase();
  if (cat === "A7") return "helicopter";
  if (cat.startsWith("C")) return "ground";
  return "plane";
}

function planeSizeScale(category) {
  const cat = String(category || "").toUpperCase();
  if (cat === "A1" || cat === "A2" || cat === "B1") return 0.85;
  if (cat === "A4" || cat === "A5") return 1.18;
  return 1;
}

function glyphInner(kind) {
  if (kind === "ground") {
    return `<rect class="aircraft-body" x="8" y="12" width="20" height="12" rx="3"></rect>
      <path class="aircraft-detail" d="M11 16h14M13 24v4M23 24v4"></path>
      <circle class="aircraft-wheel" cx="13" cy="28" r="2"></circle>
      <circle class="aircraft-wheel" cx="23" cy="28" r="2"></circle>`;
  }
  if (kind === "helicopter") {
    return `<path class="aircraft-body" d="M16.4 7h3.2v18l3.4 3.4v2.2h-13.2v-2.2l3.4-3.4z"></path>
      <path class="aircraft-detail" d="M3 10.5 33 25.5M3 25.5 33 10.5"></path>`;
  }
  return `<path class="aircraft-body" d="M18 2.5c1.4 0 2.4 1.2 2.4 2.8v9.4l12.1 7.2v3.4l-12.1-3.2v6.8l4 3v2.4L18 32.5l-6.4 1.8v-2.4l4-3v-6.8L3.5 25.3v-3.4l12.1-7.2V5.3c0-1.6 1-2.8 2.4-2.8Z"></path>
    <path class="aircraft-highlight" d="M18 5.4v23.8"></path>`;
}

function markerRotation(item) {
  if (item.onGround) return 0;
  return Number.isFinite(item.track) ? Math.round(item.track) : 0;
}

function markerHtml(item) {
  const rotation = markerRotation(item);
  const color = altitudeColor(item);
  const scale = Math.max(0.75, Math.min(1.6, Number(settings.value.iconScale) || 1));
  // Persistent labels clutter the map and hide neighbouring aircraft, so only the
  // selected aircraft is always labelled; the "Labels" setting opts into all of them.
  // Every aircraft still shows its callsign in the hover tooltip.
  const showLabel = settings.value.labels || selectedHex.value === item.hex;
  const label = showLabel ? `<span class="aircraft-label">${escapeHtml(formatFlight(item))}</span>` : "";
  const classes = [
    item.emergency && item.emergency !== "none" ? "is-emergency" : "",
    item.spi ? "is-ident" : "",
    conflictHexes.value.has(item.hex) ? "is-conflict" : "",
    isCoasting(item) ? "is-coasting" : "",
  ].filter(Boolean).join(" ");
  const kind = aircraftKind(item);
  const sizeScale = kind === "plane" ? planeSizeScale(item.category) : 1;
  const glyph = `<svg class="aircraft-svg ${kind}-svg" viewBox="0 0 36 36" aria-hidden="true" style="transform: rotate(${rotation}deg) scale(${sizeScale})">
      ${glyphInner(kind)}
    </svg>`;
  return `<span class="aircraft-wrap ${classes}" style="--aircraft-color:${color};--aircraft-scale:${scale}">
    <span class="aircraft-symbol">${glyph}</span>${label}
  </span>`;
}

function markerIcon(item) {
  const selected = selectedHex.value === item.hex;
  return L.divIcon({
    className: `aircraft-icon ${selected ? "selected" : ""}`,
    html: markerHtml(item),
    iconSize: [112, 46],
    iconAnchor: [18, 18],
  });
}

function markerVisualScale() {
  return Math.max(0.75, Math.min(1.6, Number(settings.value.iconScale) || 1));
}

function markerSizeScale(item) {
  return aircraftKind(item) === "plane" ? planeSizeScale(item.category) : 1;
}

// Everything that changes the rendered icon HTML *except* position and rotation.
// When unchanged, upsertMarkers() skips the costly setIcon() innerHTML rebuild and
// only moves the marker (and, if needed, rotates its glyph) in place.
function markerSignature(item) {
  const selected = selectedHex.value === item.hex ? 1 : 0;
  const showLabel = settings.value.labels || selected;
  const label = showLabel ? formatFlight(item) : "";
  const emergency = item.emergency && item.emergency !== "none" ? 1 : 0;
  const ident = item.spi ? 1 : 0;
  const conflict = conflictHexes.value.has(item.hex) ? 1 : 0;
  const coasting = isCoasting(item) ? 1 : 0;
  return `${aircraftKind(item)}|${altitudeColor(item)}|${markerVisualScale()}|${markerSizeScale(item)}|${selected}|${emergency}|${ident}|${conflict}|${coasting}|${label}`;
}

function applyMarkerRotation(marker, rot, item) {
  const svg = marker.getElement()?.querySelector(".aircraft-svg");
  if (!svg) return false;
  svg.style.transform = `rotate(${rot}deg) scale(${markerSizeScale(item)})`;
  return true;
}

function verticalArrowSymbol(item) {
  if (item.onGround) return "";
  const rate = item.baroRate ?? item.geomRate;
  if (rate == null) return "";
  if (rate > 100) return "↑";
  if (rate < -100) return "↓";
  return "→";
}

function tooltipHtml(item) {
  // Same tactical data-block styling and layout as the 3D view: callsign + pin over the
  // shared status line (trend+altitude · speed · age). The .tt-age span is patched every
  // second by patchTooltipAge() so the age stays live while the pointer rests on a marker.
  return `<span class="tt-l1"><b>${escapeHtml(formatFlight(item))}</b>${pinIcon(item.hex)}</span>`
    + `<span class="tt-l2">${targetLine(item, false)}</span>`;
}

// Second line shared by the 3D data block and the 2D hover popover: the vertical-trend
// arrow immediately before the altitude (green climb / red descent), then speed, then the
// update age (#s), each field separated by a middle dot. Altitude is quantised to 100 ft so
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
  parts.push(`<span class="tt-age">${escapeHtml(formatAge(item.observedAt))}</span>`);
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
  return `<span class="t3d-datablock"><span class="db-top"><b>${escapeHtml(formatFlight(item))}</b>${pinIcon(item.hex)}</span>`
    + `<span>${targetLine(item, true)}</span></span>`;
}

// Plain-text label for the 3D view's deck.gl TextLayer (no HTML): callsign over
// "trend+altitude · speed · age".
function labelText(item) {
  const altFt = item.altBaro ?? item.altGeom;
  const alt = item.onGround ? "GND" : altFt == null ? "-" : altText(Math.round(altFt / 100) * 100);
  const parts = [`${verticalArrowSymbol(item)}${alt}`];
  if (item.gs != null) parts.push(formatSpeed(item));
  parts.push(formatAge(item.observedAt));
  return `${formatFlight(item)}\n${parts.join(" · ")}`;
}

function applyMarkerHover(marker, hex) {
  marker.getElement()?.classList.toggle("hovered", hoveredHex.value === hex);
}

// Interactive so the pin icon is clickable and the tooltip stays while the pointer is on
// it; permanent for pinned aircraft so their label stays up without hovering.
function bindMarkerTooltip(marker, tip, isPinned) {
  marker.unbindTooltip();
  marker.bindTooltip(tip, {
    direction: "top", offset: [0, -14], className: "aircraft-tt", interactive: true, permanent: isPinned,
  });
  marker._pinned = isPinned;
}

// The tooltip HTML is built once per upsert, so its baked-in age would freeze while the
// pointer rests on a marker. Patch just the age node of the open tooltip in place so it
// ticks every second (driven by the clock timer) without rebuilding the whole tooltip.
function patchTooltipAge(marker, hex) {
  const ageEl = marker?.getTooltip()?.getElement()?.querySelector(".tt-age");
  if (!ageEl) return;
  const item = aircraft.value.find((row) => row.hex === hex);
  if (item) ageEl.textContent = formatAge(item.observedAt);
}

// Slightly beyond the visible bounds so markers don't pop in right at the edge on a pan.
const MARKER_BOUNDS_PAD = 0.25;
// Safety cap on simultaneous DOM markers, independent of the sidebar's LIST_LIMIT. It only
// bites on an extreme zoom-out with very heavy traffic (viewport culling keeps the normal
// count far below it); when it does, the kept markers follow aircraft.value order, which is
// arbitrary — acceptable for that edge case.
const MARKER_LIMIT = 1000;

function upsertMarkers() {
  if (!map) return;
  const bounds = map.getBounds().pad(MARKER_BOUNDS_PAD);
  const visible = new Set();
  let count = 0;
  for (const item of aircraft.value) {
    if (item.lat == null || item.lon == null) continue;
    if (!passesFilters(item)) continue;
    if (isDropped(item)) continue;
    const selected = selectedHex.value === item.hex;
    // Cull anything off-screen, but always keep the selected and pinned aircraft so their
    // highlight, permanent label and track survive a pan away. Real position updates still
    // land the instant the marker is in view — this only trims what the user cannot see.
    const keep = selected || pinned.value.has(item.hex);
    if (!keep && !bounds.contains([item.lat, item.lon])) continue;
    if (!keep && count >= MARKER_LIMIT) continue;
    count += 1;
    visible.add(item.hex);

    const rot = markerRotation(item);
    const sig = markerSignature(item);
    const tip = tooltipHtml(item);
    const existing = markers.get(item.hex);
    if (existing) {
      if (existing._lat !== item.lat || existing._lon !== item.lon) {
        existing.setLatLng([item.lat, item.lon]);
        existing._lat = item.lat;
        existing._lon = item.lon;
      }
      if (existing._sig !== sig) {
        // Appearance changed (colour band, selection, label, …): rebuild the icon,
        // which also bakes in the current rotation.
        existing.setIcon(markerIcon(item));
        existing._sig = sig;
        existing._rot = rot;
      } else if (existing._rot !== rot) {
        // Only the heading changed: nudge the glyph transform instead of rebuilding.
        if (!applyMarkerRotation(existing, rot, item)) existing.setIcon(markerIcon(item));
        existing._rot = rot;
      }
      const isPinned = pinned.value.has(item.hex);
      if (existing._pinned !== isPinned) {
        // Pin state changed: rebind so the tooltip becomes permanent (pinned) or hover-only.
        bindMarkerTooltip(existing, tip, isPinned);
      } else if (existing._tip !== tip) {
        existing.setTooltipContent(tip);
      }
      existing._tip = tip;
      applyMarkerHover(existing, item.hex);
    } else {
      const marker = L.marker([item.lat, item.lon], { icon: markerIcon(item) });
      marker._lat = item.lat;
      marker._lon = item.lon;
      marker._sig = sig;
      marker._rot = rot;
      marker._tip = tip;
      bindMarkerTooltip(marker, tip, pinned.value.has(item.hex));
      marker.on("tooltipopen", () => patchTooltipAge(marker, item.hex));
      marker.on("click", () => toggleAircraft(item.hex));
      marker.on("mouseover", () => { hoveredHex.value = item.hex; });
      marker.on("mouseout", () => { if (hoveredHex.value === item.hex) hoveredHex.value = null; });
      marker.addTo(map);
      markers.set(item.hex, marker);
      applyMarkerHover(marker, item.hex);
    }
  }

  for (const [hex, marker] of markers) {
    if (!visible.has(hex)) {
      marker.remove();
      markers.delete(hex);
    }
  }
}

function bandMidFeet(band) {
  const max = band.maxAltitude ?? band.minAltitude + 10000;
  return (band.minAltitude + max) / 2;
}

// Backend ring is [lon, lat]; Leaflet wants [lat, lon]. Straight segments (no spline) so
// the real per-bearing reach — airway spikes and no-coverage notches — is shown as-is.
function ringToLatLngs(ring) {
  return (ring || []).map(([lon, lat]) => [lat, lon]);
}

function drawCoverage() {
  if (!map) return;
  if (coverageLayer) coverageLayer.remove();
  coverageLayer = L.layerGroup();
  if (!settings.value.coverage) return;

  for (const area of coverage.value.areas || []) {
    const bands = area.bands || [];
    const banded = settings.value.coverageBands && bands.length > 0;

    // Overall extent as a single translucent area with its true jagged edge (always drawn:
    // altitude bands drop the ~1/5 of far receptions with no altitude, so this is the
    // honest boundary). Dark casing underneath keeps the edge readable over satellite.
    const overallRing = area.polygon?.coordinates?.[0];
    if (overallRing?.length) {
      const latlngs = ringToLatLngs(overallRing);
      // Non-interactive: no hover tooltip, and clicks pass through to the map/markers.
      L.polygon(latlngs, {
        color: "#071012", weight: (banded ? 1 : 2) + 2, opacity: 0.4, fill: false, interactive: false, lineJoin: "round",
      }).addTo(coverageLayer);
      L.polygon(latlngs, {
        color: "#5eead4",
        weight: banded ? 1 : 2,
        opacity: banded ? 0.6 : 0.95,
        fillColor: "#2dd4bf",
        fillOpacity: banded ? 0.04 : 0.1,
        interactive: false,
        lineJoin: "round",
      }).addTo(coverageLayer);
    }

    // Altitude bands: thin coloured outlines inside the boundary (highest first).
    if (banded) {
      for (const band of [...bands].sort((a, b) => bandMidFeet(b) - bandMidFeet(a))) {
        const ring = band.polygon?.coordinates?.[0];
        if (!ring?.length) continue;
        L.polyline(ringToLatLngs(ring), {
          color: altitudeColorFeet(bandMidFeet(band)),
          weight: 2,
          opacity: 0.9,
          interactive: false,
          lineCap: "round",
          lineJoin: "round",
        }).addTo(coverageLayer);
      }
    }
  }
  coverageLayer.addTo(map);
}

// Runways grouped by owning airport ICAO, for the airport popover.
const runwaysByIcao = (() => {
  const m = new Map();
  for (const r of RUNWAYS) {
    if (!m.has(r.icao)) m.set(r.icao, []);
    m.get(r.icao).push(r);
  }
  return m;
})();

function airfieldTooltip(field) {
  const codes = [field.icao, field.iata].filter(Boolean).join(" · ");
  const meta = [codes, field.city].filter(Boolean).join(" — ");
  const rwys = field.icao ? runwaysByIcao.get(field.icao) || [] : [];
  const rwHtml = rwys.length
    ? `<span class="af-tt-rwys">${rwys
        .map((r) => `<span class="af-tt-rw"><b>${escapeHtml(r.ident)}</b><span>${r.len.toLocaleString()} ft</span></span>`)
        .join("")}</span>`
    : "";
  return `<span class="af-tt-name">${escapeHtml(field.name)}</span>`
    + (meta ? `<span class="af-tt-meta">${escapeHtml(meta)}</span>` : "")
    + rwHtml;
}

function airfieldIcon(field, minor) {
  const label = minor ? "" : `<span class="airfield-code">${escapeHtml(field.code)}</span>`;
  return L.divIcon({
    className: `airfield-icon kind-${field.kind}${minor ? " minor" : ""}`,
    html: `<span class="airfield-wrap"><span class="airfield-dot"></span>${label}</span>`,
    iconSize: [1, 1],
    iconAnchor: [0, 0],
  });
}

// Four [lat, lon] corners of a runway rectangle from its threshold coords + width, using a
// local metres-per-degree approximation (fine at runway scale).
function runwayCorners(rwy) {
  const midLat = (rwy.le[1] + rwy.he[1]) / 2;
  const mPerLat = 111320;
  const mPerLon = 111320 * Math.cos((midLat * Math.PI) / 180);
  let ex = (rwy.he[0] - rwy.le[0]) * mPerLon;
  let ez = (rwy.he[1] - rwy.le[1]) * mPerLat;
  const len = Math.hypot(ex, ez) || 1;
  ex /= len; ez /= len;
  const hw = (rwy.width * 0.3048) / 2;
  const dLon = (-ez * hw) / mPerLon;
  const dLat = (ex * hw) / mPerLat;
  return [
    [rwy.le[1] + dLat, rwy.le[0] + dLon],
    [rwy.le[1] - dLat, rwy.le[0] - dLon],
    [rwy.he[1] - dLat, rwy.he[0] - dLon],
    [rwy.he[1] + dLat, rwy.he[0] + dLon],
  ];
}

function drawAirfields() {
  if (!map) return;
  if (airfieldLayer) airfieldLayer.remove();
  airfieldLayer = L.layerGroup();
  if (settings.value.airfields) {
    // Real runways to scale (position/length/heading/width) — visible when zoomed in.
    for (const rwy of RUNWAYS) {
      // Asphalt pavement with a crisp white edge — reads as a real runway (no centreline).
      L.polygon(runwayCorners(rwy), {
        color: "#e8edf2", weight: 1, opacity: 0.85, fillColor: "#262b31", fillOpacity: 0.92,
        interactive: false, lineJoin: "miter",
      }).addTo(airfieldLayer);
    }
    for (const field of AIRFIELDS) {
      const minor = isMinorAirfield(field);
      // Uncoded minor strips (military helipads, emergency runways) are hidden
      // unless explicitly enabled, to keep the coded airfields legible.
      if (minor && !settings.value.airfieldsMinor) continue;
      L.marker([field.lat, field.lon], {
        icon: airfieldIcon(field, minor),
        pane: "airfields",
        keyboard: false,
        zIndexOffset: -1000,
      }).bindTooltip(airfieldTooltip(field), { direction: "top", offset: [0, -6], className: "airfield-tt" })
        .addTo(airfieldLayer);
    }
  }
  airfieldLayer.addTo(map);
}

// Proximity links: a dashed red line between each close pair, labelled with the lateral and
// vertical separation. The markers themselves are reddened by the is-conflict class.
function drawConflicts() {
  if (!map) return;
  if (conflictLayer) conflictLayer.remove();
  conflictLayer = L.layerGroup();
  if (settings.value.proximity) {
    for (const pair of conflicts.value) {
      const a = [pair.a.lat, pair.a.lon];
      const b = [pair.b.lat, pair.b.lon];
      L.polyline([a, b], {
        color: "#fb7185", weight: 2, opacity: 0.9, dashArray: "5 4", interactive: false, lineCap: "round",
      }).addTo(conflictLayer);
      const mid = [(pair.a.lat + pair.b.lat) / 2, (pair.a.lon + pair.b.lon) / 2];
      L.marker(mid, {
        icon: L.divIcon({
          className: "conflict-label",
          html: `${pair.distNm.toFixed(1)} NM · ${Math.round(pair.vertFt)} ft`,
          iconSize: [1, 1],
        }),
        interactive: false,
        keyboard: false,
        zIndexOffset: 1000,
      }).addTo(conflictLayer);
    }
  }
  conflictLayer.addTo(map);
}

// Range/bearing measure tool. Two clicks fix the endpoints (a live segment follows the
// cursor between them); a further click starts a fresh measurement.
function drawMeasure() {
  if (!map) return;
  if (measureLayer) measureLayer.remove();
  measureLayer = L.layerGroup();
  const pts = measurePoints.value;
  const endpoints = pts.length === 1 && measureCursor.value ? [pts[0], measureCursor.value] : pts.slice(0, 2);
  for (const p of pts) {
    L.circleMarker([p.lat, p.lng], {
      radius: 4, color: "#48e0d1", weight: 2, fillColor: "#0d1011", fillOpacity: 1, interactive: false,
    }).addTo(measureLayer);
  }
  if (endpoints.length === 2) {
    const [p0, p1] = endpoints;
    L.polyline([[p0.lat, p0.lng], [p1.lat, p1.lng]], {
      color: "#48e0d1", weight: 2, opacity: 0.95, dashArray: "6 5", interactive: false, lineCap: "round",
    }).addTo(measureLayer);
    const dist = distanceNm(p0, p1);
    const brg = bearingDeg(p0, p1);
    const km = dist * 1.852;
    L.marker([p1.lat, p1.lng], {
      icon: L.divIcon({
        className: "measure-label",
        html: `${dist.toFixed(1)} NM (${km.toFixed(1)} km) · ${Math.round(brg)}°`,
        iconSize: [1, 1],
      }),
      interactive: false,
      keyboard: false,
      zIndexOffset: 1100,
    }).addTo(measureLayer);
  }
  measureLayer.addTo(map);
}

function toggleMeasure() {
  measureMode.value = !measureMode.value;
  measurePoints.value = [];
  measureCursor.value = null;
  map?.getContainer().classList.toggle("measuring", measureMode.value);
  drawMeasure();
}

function onMeasureClick(latlng) {
  const point = { lat: latlng.lat, lng: latlng.lng };
  // 0 or 2 existing points => start over with a single new point; 1 => complete the pair.
  measurePoints.value = measurePoints.value.length === 1
    ? [measurePoints.value[0], point]
    : [point];
  measureCursor.value = null;
  drawMeasure();
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

// A single hex can cover several flights over the track window; split the trace across
// long tracking gaps (landed / out of range) so we don't draw a straight line bridging
// hours of missing data.
const TRACK_GAP_MS = 10 * 60 * 1000;

// Draw one aircraft's track into the current trackLayer: dark casing, then altitude-colored
// runs on top, split across long tracking gaps. Weights are chunky so the trail reads.
function drawTrackInto(rawPts) {
  const pts = rawPts.filter((point) => point.lat != null && point.lon != null);
  const segments = [];
  let segment = [];
  let prevTime = null;
  for (const point of pts) {
    const time = Date.parse(point.positionAt);
    if (segment.length && Number.isFinite(time) && Number.isFinite(prevTime) && time - prevTime > TRACK_GAP_MS) {
      segments.push(segment);
      segment = [];
    }
    segment.push(point);
    prevTime = time;
  }
  if (segment.length) segments.push(segment);

  for (const segPts of segments) {
    if (segPts.length < 2) continue;
    L.polyline(segPts.map((point) => [point.lat, point.lon]), {
      color: "#071012", opacity: 0.55, weight: 5, interactive: false, lineCap: "round", lineJoin: "round",
    }).addTo(trackLayer);

    let run = [[segPts[0].lat, segPts[0].lon]];
    let runColor = trackSegmentColor(segPts[0]);
    const flush = () => {
      if (run.length >= 2) {
        L.polyline(run, {
          color: runColor, opacity: 0.95, weight: 3, interactive: false, lineCap: "round", lineJoin: "round",
        }).addTo(trackLayer);
      }
    };
    for (let i = 1; i < segPts.length; i += 1) {
      const color = trackSegmentColor(segPts[i]);
      run.push([segPts[i].lat, segPts[i].lon]);
      if (color !== runColor) {
        flush();
        run = [[segPts[i].lat, segPts[i].lon]];
        runColor = color;
      }
    }
    flush();
  }
}

function drawTrack() {
  if (!map) return;
  if (trackLayer) trackLayer.remove();
  trackLayer = L.layerGroup();
  const seen = new Set();
  if (selectedHex.value) { drawTrackInto(selectedTrack.value); seen.add(selectedHex.value); }
  // Pinned aircraft keep their tracks shown too.
  for (const [hex, points] of pinnedTracks.value) {
    if (!seen.has(hex)) drawTrackInto(points);
  }
  drawPlaybackMarker();
  trackLayer.addTo(map);
}

function drawPlaybackMarker() {
  if (!trackLayer || !selectedTrack.value.length) return;
  if (playbackMarker) playbackMarker.remove();
  const latestIndex = selectedTrack.value.length - 1;
  if (!playbackSpeed.value && playbackIndex.value >= latestIndex) return;
  const point = selectedTrack.value[Math.min(playbackIndex.value, selectedTrack.value.length - 1)];
  if (!point || point.lat == null || point.lon == null) return;
  const item = {
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
  playbackMarker = L.marker([point.lat, point.lon], {
    icon: markerIcon(item),
    title: point.positionAt,
    keyboard: false,
    interactive: false,
    zIndexOffset: 900,
  }).bindTooltip(point.positionAt);
  playbackMarker.addTo(trackLayer);
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

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
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
    if (selectedHex.value) await refreshTrack(false);
    await refreshPinnedTracks();
  } catch (err) {
    status.value = "offline";
    console.error(err);
  }
}

// Coverage is a heavy query (a 30-day, up-to-50k-row envelope) whose outline barely moves
// per position, so it refetches only when a batch actually recorded new track points (see
// the ingest handler) — event-driven, not on a blind timer that both lags real changes and
// spins while idle.
async function refreshCoverage() {
  try {
    coverage.value = (await fetchJson("/api/coverage")) || { areas: [], points: [] };
    if (view3dActive.value) tac3d?.drawCoverage();
    else drawCoverage();
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
  if (!selectedHex.value) return;
  const to = new Date();
  const from = new Date(to.getTime() - trackHours.value * 60 * 60 * 1000);
  const params = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
  const result = await fetchJson(`/api/aircraft/${selectedHex.value}/track?${params}`);
  // Was the user watching the live edge (vs. scrubbing to a past point) before new
  // points arrived? If so, follow the new live edge so a stale playback marker does not
  // spawn behind the moving aircraft; only a deliberate scrub keeps its past position.
  const wasAtLiveEdge = playbackIndex.value >= selectedTrack.value.length - 1;
  selectedTrack.value = result.points || [];
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
  if (view3dActive.value) tac3d?.dataPass();
  else drawTrack();
}

async function togglePin(hex) {
  const next = new Set(pinned.value);
  if (next.has(hex)) next.delete(hex);
  else next.add(hex);
  pinned.value = next;
  await refreshPinnedTracks();
  // Refresh labels (pin state) and the permanent-tooltip / trail rendering.
  if (view3dActive.value) tac3d?.dataPass();
  else { upsertMarkers(); drawTrack(); }
}

async function selectAircraft(hex, pan = false) {
  selectedHex.value = hex;
  // Move the camera immediately (before the track fetch) so selecting feels instant.
  const item = selectedAircraft.value;
  if (pan && item?.lat != null && item?.lon != null) {
    if (view3dActive.value) tac3d?.panTo(item.lon, item.lat, item.altBaro ?? item.altGeom);
    else map.setView([item.lat, item.lon], Math.max(map.getZoom(), 8), { animate: true });
  }
  if (view3dActive.value) tac3d?.dataPass();
  else upsertMarkers();
  await refreshTrack();
  await nextTick();
}

function clearSelection() {
  selectedHex.value = null;
  selectedTrack.value = [];
  playbackSpeed.value = 0;
  playbackIndex.value = 0;
  if (playbackMarker) {
    playbackMarker.remove();
    playbackMarker = null;
  }
  if (view3dActive.value) tac3d?.dataPass();
  else { upsertMarkers(); drawTrack(); } // drawTrack rebuilds the layer, keeping pinned trails
}

// Clicking a marker toggles selection; clicking a different one switches to it.
function toggleAircraft(hex) {
  if (selectedHex.value === hex) clearSelection();
  else selectAircraft(hex, true);
}

function onGlobalKeydown(event) {
  if (event.key !== "Escape") return;
  if (measureMode.value) { toggleMeasure(); return; }
  if (selectedHex.value) clearSelection();
}

// Toolbar recenter: smoothly fly to the selected aircraft, or home to the Yuseong IC center
// when nothing is selected. (Both views.)
const HOME = { lat: 36.36599, lon: 127.33113 };
function recenterView() {
  const sel = selectedAircraft.value;
  const hasSel = sel && sel.lat != null && sel.lon != null;
  if (view3dActive.value) {
    if (hasSel) tac3d?.flyToView(sel.lon, sel.lat, 9, sel.altBaro ?? sel.altGeom);
    else tac3d?.flyToView(HOME.lon, HOME.lat, 6);
  } else if (hasSel) {
    map.setView([sel.lat, sel.lon], Math.max(map.getZoom(), 9), { animate: true });
  } else {
    map.setView([HOME.lat, HOME.lon], 7, { animate: true });
  }
}

function applyBaseLayer() {
  if (!map) return;
  const next = baseLayers[settings.value.baseLayer] || baseLayers.satellite;
  if (tileLayer) tileLayer.remove();
  tileLayer = L.tileLayer(next.url, next.options).addTo(map);
  tileLayer.bringToBack();
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

// The selected track renders on whichever engine is visible.
function renderTrackView() {
  if (view3dActive.value) tac3d?.dataPass();
  else drawTrack();
}

// The 3D module (and three.js with it) loads on first use only, keeping the 2D bundle
// unchanged. All app state flows in through these getters/callbacks; the visual identity
// (altitude colors, data-block text, filters) stays defined here and is reused verbatim.
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
        getPinnedTracks: () => [...pinnedTracks.value].map(([hex, points]) => ({ hex, points })),
        togglePin,
        datablockHtml,
        airfieldTooltip,
        passesFilters,
        isDropped,
        isCoasting,
        altitudeColor,
        altitudeColorFeet,
        trackSegmentColor,
        onSelect: toggleAircraft,
        onHover: (hex) => { hoveredHex.value = hex; },
        onMapClick: () => { if (selectedHex.value) clearSelection(); },
      },
    });
    return tac3d;
  });
  return tac3dPromise;
}

async function setView3d(on) {
  settings.value.view3d = on;
  if (on) {
    if (measureMode.value) toggleMeasure(); // measure is 2D-only
    view3dActive.value = true; // hide the 2D map immediately so there's no 2D→3D flash
    await ensureTactical3d();
    if (settings.value.view3d !== true) return; // toggled back off while loading
    await nextTick();
    tac3d.setActive(true);
    tac3d.setCameraFromMap(map.getCenter(), map.getZoom());
    tac3d.applySettings();
  } else {
    view3dActive.value = false;
    if (tac3d) {
      const cam = tac3d.getCameraForMap();
      tac3d.setActive(false);
      await nextTick();
      map.invalidateSize();
      map.setView(cam.center, cam.zoom, { animate: false });
    }
    // Leaflet layers were frozen while hidden — bring everything back in sync.
    upsertMarkers();
    drawConflicts();
    drawTrack();
    drawCoverage();
    drawAirfields();
  }
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
  if (view3dActive.value) { tac3d?.dataPass(); return; }
  upsertMarkers();
  drawConflicts();
});
watch(searchQuery, () => {
  if (view3dActive.value) { tac3d?.dataPass(); return; }
  upsertMarkers();
});
watch(hoveredHex, (next, prev) => {
  if (view3dActive.value) { tac3d?.setHoverClass(prev, next); return; }
  if (prev && markers.has(prev)) applyMarkerHover(markers.get(prev), prev);
  if (next && markers.has(next)) applyMarkerHover(markers.get(next), next);
});
watch(selectedHistoryMetrics, () => queueHistoryChartRender(), { deep: true });
watch(selectedTrack, () => queueHistoryChartRender());
watch(playbackIndex, () => {
  renderTrackView();
  setHistoryChartCursor();
});

onMounted(async () => {
  // When 3D is the default view, hide the 2D map from the very first paint so the app never
  // flashes 2D before switching to 3D.
  if (settings.value.view3d) view3dActive.value = true;
  // Centered on Yuseong IC, Daejeon (same reference point as the 3D scene origin / rings).
  map = L.map(mapEl.value, { zoomControl: false, attributionControl: false, preferCanvas: true }).setView([36.36599, 127.33113], 7);
  // Airfield reference markers sit above coverage but below live aircraft.
  map.createPane("airfields").style.zIndex = 450;
  L.control.zoom({ position: "bottomright" }).addTo(map);
  // Re-cull markers to the viewport after a pan or zoom (moveend also fires on zoom).
  map.on("moveend", upsertMarkers);
  // Clicking empty map (coverage is non-interactive, markers stop propagation) deselects,
  // unless the measure tool is active — then clicks drop range/bearing endpoints.
  map.on("click", (event) => {
    if (measureMode.value) { onMeasureClick(event.latlng); return; }
    if (selectedHex.value) clearSelection();
  });
  map.on("mousemove", (event) => {
    if (measureMode.value && measurePoints.value.length === 1) {
      measureCursor.value = { lat: event.latlng.lat, lng: event.latlng.lng };
      drawMeasure();
    }
  });
  window.addEventListener("keydown", onGlobalKeydown);
  applyBaseLayer();
  drawAirfields();
  await refreshLive();
  await refreshCoverage();
  drawConflicts();
  // Fallback polls in case the SSE stream drops; otherwise live updates are driven by
  // ingest events, and coverage only when a batch actually recorded new track points.
  refreshTimer = setInterval(() => liveRefresher.schedule(0), 10000);
  coverageTimer = setInterval(() => coverageRefresher.schedule(0), 60000);
  clockTimer = setInterval(() => {
    now.value = Date.now();
    if (view3dActive.value) {
      // Coast/drop transitions and each data block's age (#s) are time-driven; a dataPass
      // is cheap (~100 targets) so run it every tick to keep the 3D labels fresh.
      tac3d?.dataPass();
      return;
    }
    if (hoveredHex.value) patchTooltipAge(markers.get(hoveredHex.value), hoveredHex.value);
    for (const hex of pinned.value) patchTooltipAge(markers.get(hex), hex); // permanent labels
  }, 1000);
  window.addEventListener("click", onPinClick);
  connectEvents();
  if (settings.value.view3d) setView3d(true);
});

// Delegated pin-toggle for the 2D Leaflet tooltip pins (the 3D overlay handles its own).
function onPinClick(event) {
  const pin = event.target.closest?.(".tt-pin");
  if (pin?.dataset.hex && !view3dActive.value) togglePin(pin.dataset.hex);
}

function connectEvents() {
  eventSource?.close();
  eventSource = new EventSource("/api/events");
  // A (re)opened stream may have missed events while down — resync immediately.
  eventSource.onopen = () => liveRefresher.schedule(0);
  eventSource.addEventListener("ingest", (event) => {
    liveRefresher.schedule();
    // Only touch the heavy coverage query when this batch actually stored new track
    // points; otherwise the 30-day envelope cannot have changed.
    let trackPoints = 1;
    try { trackPoints = JSON.parse(event.data)?.trackPoints ?? 1; } catch { /* refetch on parse failure */ }
    if (trackPoints > 0) coverageRefresher.schedule(1000);
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
  window.removeEventListener("click", onPinClick);
  clearTimeout(sseRetryTimer);
  eventSource?.close();
  tac3d?.destroy();
  tac3d = null;
  map?.remove();
});
</script>

<template>
  <main class="shell" :style="shellStyle">
    <section class="map-stage">
      <div v-show="!view3dActive" ref="mapEl" class="map"></div>
      <div v-show="view3dActive" ref="map3dEl" class="map map-3d"></div>
      <div class="topbar">
        <div>
          <div class="brand">Skytrace</div>
          <div class="subline">
            <span :class="['status-dot', status]"></span>
            {{ status }} · {{ filteredAircraft.length }}/{{ aircraft.length }} aircraft · {{ receivers.length }} receivers
          </div>
        </div>
        <div class="toolbar">
          <button class="icon-button" :class="{ active: view3dActive }" title="3D tactical view" @click="setView3d(!settings.view3d)"><Rotate3d :size="18" /></button>
          <button v-if="!view3dActive" class="icon-button" :class="{ active: measureMode }" title="Measure range/bearing (Esc to exit)" @click="toggleMeasure"><Ruler :size="18" /></button>
          <button class="icon-button" :title="selectedAircraft ? 'Center on selected aircraft' : 'Recenter'" @click="recenterView"><LocateFixed :size="18" /></button>
        </div>
      </div>
      <div v-if="measureMode" class="measure-hint">
        <Ruler :size="15" />
        <span>Click two points for range &amp; bearing · Esc to exit</span>
      </div>
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
            <label class="select-row">
              <span>History</span>
              <select v-model.number="trackHours" @change="refreshTrack">
                <option :value="1">1h</option>
                <option :value="6">6h</option>
                <option :value="24">24h</option>
                <option :value="168">7d</option>
              </select>
            </label>

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
            @click="selectAircraft(item.hex, true)"
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
          <small>{{ settings.source === "all" ? "all sources" : settings.source }} · {{ settings.units }} · {{ baseLayers[settings.baseLayer]?.label }}</small>
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
              <div class="coverage-note">{{ coverageSummary.areas }} areas · {{ coverageSummary.positions }} positions</div>
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
              <label><input v-model="settings.coverageBands" type="checkbox" :disabled="!settings.coverage" /> By altitude</label>
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
              <label><span>Map</span><select v-model="settings.baseLayer"><option v-for="layer in Object.keys(baseLayers)" :key="layer" :value="layer">{{ baseLayers[layer].label }}</option></select></label>
              <label><span>Icon scale</span><input v-model.number="settings.iconScale" type="range" min="0.75" max="1.6" step="0.05" /></label>
              <label v-if="view3dActive"><span>Terrain ×{{ Number(settings.terrainExaggeration).toFixed(1) }}</span><input v-model.number="settings.terrainExaggeration" type="range" min="1" max="4" step="0.1" /></label>
            </div>
            <div class="toggle-row">
              <label><input v-model="settings.labels" type="checkbox" /> All labels</label>
              <label><input v-model="settings.flightLevels" type="checkbox" /> Flight levels</label>
              <label v-if="view3dActive"><input v-model="settings.terrainSatellite" type="checkbox" /> Satellite terrain</label>
            </div>
          </section>
        </div>
      </section>
    </aside>
  </main>
</template>
