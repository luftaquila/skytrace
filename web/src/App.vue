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
  RefreshCw,
  Search,
  Settings,
  SlidersHorizontal,
  TowerControl,
  X,
} from "@lucide/vue";
import { AIRFIELDS, isMinorAirfield } from "./airfields.js";

const SETTINGS_KEY = "skytrace.settings.v2";
const DEFAULT_SETTINGS = {
  units: "aero",
  baseLayer: "satellite",
  iconScale: 1,
  labels: false,
  coverage: true,
  coverageBands: true,
  airfields: true,
  airfieldsMinor: false,
  showGround: true,
  showNonIcao: true,
  source: "all",
  altMin: "",
  altMax: "",
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
const aircraft = ref([]);
const receivers = ref([]);
const coverage = ref({ areas: [], points: [] });
const selectedHex = ref(null);
const hoveredHex = ref(null);
const selectedTrack = ref([]);
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

let map;
let tileLayer;
let trackLayer;
let playbackMarker;
let coverageLayer;
let airfieldLayer;
let historyChart;
let refreshTimer;
let clockTimer;
let eventSource;
let playbackTimer;
const markers = new Map();

watch(settings, (value) => {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(value));
  applyBaseLayer();
  upsertMarkers();
  drawCoverage();
  drawAirfields();
  queueHistoryChartRender();
}, { deep: true });

watch(playbackSpeed, () => {
  startPlaybackTimer();
});

const stats = computed(() => {
  const rows = aircraft.value;
  const sources = rows.reduce((acc, item) => {
    const key = item.sourceKind || "unknown";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  return {
    live: rows.length,
    withPosition: rows.filter((item) => item.lat != null && item.lon != null).length,
    onGround: rows.filter((item) => item.onGround).length,
    nonIcao: rows.filter((item) => item.nonIcao).length,
    sources,
  };
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

const filteredAircraft = computed(() => {
  const q = search.value.trim().toLowerCase();
  const minAlt = Number.parseFloat(settings.value.altMin);
  const maxAlt = Number.parseFloat(settings.value.altMax);
  const hasMin = Number.isFinite(minAlt);
  const hasMax = Number.isFinite(maxAlt);
  const rows = aircraft.value.filter((item) => {
    const haystack = [
      item.hex,
      item.flight,
      item.squawk,
      item.category,
      item.sourceType,
      item.sourceKind,
    ].filter(Boolean).join(" ").toLowerCase();
    if (q && !haystack.includes(q)) return false;
    if (!settings.value.showGround && item.onGround) return false;
    if (!settings.value.showNonIcao && item.nonIcao) return false;
    if (settings.value.source !== "all" && item.sourceKind !== settings.value.source) return false;
    const alt = item.altBaro ?? item.altGeom;
    if (hasMin && (alt == null || alt < minAlt)) return false;
    if (hasMax && (alt == null || alt > maxAlt)) return false;
    return true;
  });
  return sortAircraft(rows, sortKey.value).slice(0, 600);
});

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

function formatNumberUnit(entry, digits = 0) {
  if (!entry) return "-";
  return `${entry.value.toLocaleString(undefined, { maximumFractionDigits: digits })} ${entry.unit}`;
}

function formatAltitude(item, field = "best") {
  if (item.onGround && field === "best") return "ground";
  const feet = field === "geom" ? item.altGeom : field === "baro" ? item.altBaro : item.altBaro ?? item.altGeom;
  return formatNumberUnit(altitudeValue(feet));
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
  return formatNumberUnit(altitudeValue(point.altBaro ?? point.altGeom));
}

function pointSpeed(point) {
  return formatNumberUnit(speedValue(point.gs));
}

function focusTrackPoint(index) {
  playbackSpeed.value = 0;
  playbackIndex.value = index;
}

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

function metricUnit(kind) {
  if (kind === "alt") return settings.value.units === "metric" ? "m" : "ft";
  if (kind === "speed") {
    if (settings.value.units === "metric") return "km/h";
    if (settings.value.units === "imperial") return "mph";
    return "kt";
  }
  if (kind === "rate") return settings.value.units === "metric" ? "m/s" : "ft/min";
  if (kind === "degrees") return "deg";
  if (kind === "temp") return "C";
  if (kind === "rssi") return "dBFS";
  return "";
}

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
  return altitudeColorFeet(item.altBaro ?? item.altGeom);
}

const altitudeLegend = computed(() => {
  const steps = 8;
  const stops = [];
  for (let i = 0; i <= steps; i += 1) {
    const pct = Math.round((i / steps) * 100);
    stops.push(`${altitudeColorFeet((i / steps) * ALT_COLOR_MAX_FT)} ${pct}%`);
  }
  const metric = settings.value.units === "metric";
  const ticks = [1, 0.75, 0.5, 0.25, 0].map((frac) => {
    const value = frac * ALT_COLOR_MAX_FT * (metric ? 0.3048 : 1);
    return { label: value >= 1000 ? `${Math.round(value / 1000)}k` : `${Math.round(value)}` };
  });
  return {
    gradient: `linear-gradient(to top, ${stops.join(", ")})`,
    ticks,
    unit: metric ? "m" : "ft",
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

function markerHtml(item) {
  const rotation = item.onGround ? 0 : Number.isFinite(item.track) ? item.track : 0;
  const color = altitudeColor(item);
  const scale = Math.max(0.75, Math.min(1.6, Number(settings.value.iconScale) || 1));
  // Persistent labels clutter the map and hide neighbouring aircraft, so only the
  // selected aircraft is always labelled; the "Labels" setting opts into all of them.
  // Every aircraft still shows its callsign in the hover tooltip.
  const showLabel = settings.value.labels || selectedHex.value === item.hex;
  const label = showLabel ? `<span class="aircraft-label">${escapeHtml(formatFlight(item))}</span>` : "";
  const classes = [
    item.emergency && item.emergency !== "none" ? "is-emergency" : "",
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

function verticalArrowSymbol(item) {
  if (item.onGround) return "";
  const rate = item.baroRate ?? item.geomRate;
  if (rate == null) return "";
  if (rate > 100) return "↑";
  if (rate < -100) return "↓";
  return "→";
}

function tooltipHtml(item) {
  // Type slot (e.g. B744) needs a hex→type DB; route/ETA need external route data.
  // Both are unavailable from raw ADS-B, so only callsign + live state are shown for now.
  const arrow = verticalArrowSymbol(item);
  const alt = item.onGround ? "GND" : escapeHtml(formatAltitude(item));
  const spd = escapeHtml(formatSpeed(item));
  return `<span class="tt-l1">${escapeHtml(formatFlight(item))}</span>`
    + `<span class="tt-l2">${arrow ? `<b class="tt-arrow">${arrow}</b>` : ""}${alt} · ${spd}</span>`;
}

function applyMarkerHover(marker, hex) {
  marker.getElement()?.classList.toggle("hovered", hoveredHex.value === hex);
}

function upsertMarkers() {
  if (!map) return;
  const visible = new Set();
  for (const item of filteredAircraft.value) {
    if (item.lat == null || item.lon == null) continue;
    visible.add(item.hex);
    const latLng = [item.lat, item.lon];
    const tip = tooltipHtml(item);
    const existing = markers.get(item.hex);
    if (existing) {
      existing.setLatLng(latLng);
      existing.setIcon(markerIcon(item));
      existing.setTooltipContent(tip);
      applyMarkerHover(existing, item.hex);
    } else {
      const marker = L.marker(latLng, { icon: markerIcon(item) });
      marker.bindTooltip(tip, { direction: "top", offset: [0, -14], className: "aircraft-tt" });
      marker.on("click", () => selectAircraft(item.hex, true));
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

// Backend ring is [lon, lat]; Leaflet wants [lat, lon]. Straight segments (no spline) keep
// the angular, data-hugging outline instead of rounding it into a blob.
function ringToLatLngs(ring) {
  return (ring || []).map(([lon, lat]) => [lat, lon]);
}

function bandMidFeet(band) {
  const max = band.maxAltitude ?? band.minAltitude + 10000;
  return (band.minAltitude + max) / 2;
}

function drawCoverageOutline(latLngs, color, weight, tooltip) {
  if (latLngs.length < 2) return;
  L.polyline(latLngs, {
    color: "#071012", weight: weight + 3, opacity: 0.45, interactive: false, lineCap: "round", lineJoin: "round",
  }).addTo(coverageLayer);
  L.polyline(latLngs, {
    color, weight, opacity: 0.95, interactive: true, lineCap: "round", lineJoin: "round",
  }).bindTooltip(tooltip).addTo(coverageLayer);
}

function drawCoverage() {
  if (!map) return;
  if (coverageLayer) coverageLayer.remove();
  coverageLayer = L.layerGroup();
  if (!settings.value.coverage) return;

  for (const area of coverage.value.areas || []) {
    const bands = area.bands || [];
    if (settings.value.coverageBands && bands.length) {
      // Draw the highest band first (largest, underneath) so lower bands stay visible.
      for (const band of [...bands].sort((a, b) => bandMidFeet(b) - bandMidFeet(a))) {
        const ring = band.polygon?.coordinates?.[0];
        if (!ring?.length) continue;
        drawCoverageOutline(
          ringToLatLngs(ring),
          altitudeColorFeet(bandMidFeet(band)),
          2.5,
          `${area.receiverName || "Receiver"} · ${band.label} · ${band.count} pos`,
        );
      }
    } else {
      const ring = area.polygon?.coordinates?.[0];
      if (!ring?.length) continue;
      drawCoverageOutline(
        ringToLatLngs(ring),
        "#48e0d1",
        3,
        `${area.receiverName || "Receiver"} · ${area.count} positions · max ${formatNumberUnit(altitudeValue(area.maxAltitude))}`,
      );
    }
  }
  coverageLayer.addTo(map);
}

function airfieldTooltip(field) {
  const codes = [field.icao, field.iata].filter(Boolean).join(" · ");
  const meta = [codes, field.city].filter(Boolean).join(" — ");
  return `<span class="af-tt-name">${escapeHtml(field.name)}</span>`
    + (meta ? `<span class="af-tt-meta">${escapeHtml(meta)}</span>` : "");
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

function drawAirfields() {
  if (!map) return;
  if (airfieldLayer) airfieldLayer.remove();
  airfieldLayer = L.layerGroup();
  if (settings.value.airfields) {
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

function selectedTrackSeconds() {
  return selectedTrack.value
    .map((point) => Date.parse(point.positionAt) / 1000)
    .filter((value) => Number.isFinite(value));
}

function destroyHistoryChart() {
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
  const axes = [
    {
      stroke: "#96a3a4",
      grid: { stroke: "rgb(238 245 244 / 0.08)" },
    },
    ...availableMetrics.map((metric, index) => ({
      scale: metric.key,
      side: index % 2 ? 1 : 3,
      stroke: metric.color,
      label: `${metric.label}${metricUnit(metric.kind) ? ` (${metricUnit(metric.kind)})` : ""}`,
      labelSize: 18,
      size: 46,
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

function drawTrack() {
  if (!map) return;
  if (trackLayer) trackLayer.remove();
  trackLayer = L.layerGroup();
  const pts = selectedTrack.value.filter((point) => point.lat != null && point.lon != null);
  if (pts.length >= 2) {
    // Dark casing underneath for contrast, then altitude-colored segments on top.
    L.polyline(pts.map((point) => [point.lat, point.lon]), {
      color: "#071012", opacity: 0.55, weight: 5, interactive: false, lineCap: "round", lineJoin: "round",
    }).addTo(trackLayer);

    let run = [[pts[0].lat, pts[0].lon]];
    let runColor = trackSegmentColor(pts[0]);
    const flush = () => {
      if (run.length >= 2) {
        L.polyline(run, {
          color: runColor, opacity: 0.95, weight: 3, interactive: false, lineCap: "round", lineJoin: "round",
        }).addTo(trackLayer);
      }
    };
    for (let i = 1; i < pts.length; i += 1) {
      const color = trackSegmentColor(pts[i]);
      run.push([pts[i].lat, pts[i].lon]);
      if (color !== runColor) {
        flush();
        run = [[pts[i].lat, pts[i].lon]];
        runColor = color;
      }
    }
    flush();
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
    drawTrack();
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
  drawTrack();
  setHistoryChartCursor();
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

async function refreshAll() {
  try {
    const [current, receiverResult, coverageResult] = await Promise.all([
      fetchJson("/api/aircraft/current"),
      fetchJson("/api/receivers/public"),
      fetchJson("/api/coverage"),
    ]);
    aircraft.value = current.aircraft || [];
    receivers.value = receiverResult.receivers || [];
    coverage.value = coverageResult || { areas: [], points: [] };
    // "Updated" reflects when a receiver actually last sent data, not our poll time —
    // otherwise it resets to 0 every poll even while the feed is stalled.
    const lastSeen = receivers.value.reduce((max, receiver) => {
      const t = Date.parse(receiver.lastSeenAt);
      return Number.isFinite(t) && t > max ? t : max;
    }, 0);
    lastUpdated.value = lastSeen ? new Date(lastSeen).toISOString() : null;
    status.value = "online";
    upsertMarkers();
    drawCoverage();
    if (selectedHex.value) await refreshTrack(false);
  } catch (err) {
    status.value = "offline";
    console.error(err);
  }
}

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
  drawTrack();
}

async function selectAircraft(hex, pan = false) {
  selectedHex.value = hex;
  upsertMarkers();
  await refreshTrack();
  await nextTick();
  const item = selectedAircraft.value;
  if (pan && item?.lat != null && item?.lon != null) {
    map.setView([item.lat, item.lon], Math.max(map.getZoom(), 8), { animate: true });
  }
}

function clearSelection() {
  selectedHex.value = null;
  selectedTrack.value = [];
  playbackSpeed.value = 0;
  playbackIndex.value = 0;
  if (trackLayer) {
    trackLayer.remove();
    trackLayer = null;
  }
  if (playbackMarker) {
    playbackMarker.remove();
    playbackMarker = null;
  }
  upsertMarkers();
}

function fitVisibleAircraft() {
  const points = filteredAircraft.value
    .filter((item) => item.lat != null && item.lon != null)
    .map((item) => [item.lat, item.lon]);
  if (!points.length) return;
  map.fitBounds(points, { padding: [48, 48], maxZoom: 10 });
}

function applyBaseLayer() {
  if (!map) return;
  const next = baseLayers[settings.value.baseLayer] || baseLayers.satellite;
  if (tileLayer) tileLayer.remove();
  tileLayer = L.tileLayer(next.url, next.options).addTo(map);
  tileLayer.bringToBack();
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

watch(filteredAircraft, () => upsertMarkers());
watch(hoveredHex, (next, prev) => {
  if (prev && markers.has(prev)) applyMarkerHover(markers.get(prev), prev);
  if (next && markers.has(next)) applyMarkerHover(markers.get(next), next);
});
watch(selectedHistoryMetrics, () => queueHistoryChartRender(), { deep: true });
watch(selectedTrack, () => queueHistoryChartRender());
watch(playbackIndex, () => {
  drawTrack();
  setHistoryChartCursor();
});

onMounted(async () => {
  map = L.map(mapEl.value, { zoomControl: false, attributionControl: false, preferCanvas: true }).setView([36.2, 127.8], 7);
  // Airfield reference markers sit above coverage but below live aircraft.
  map.createPane("airfields").style.zIndex = 450;
  L.control.zoom({ position: "bottomright" }).addTo(map);
  applyBaseLayer();
  drawAirfields();
  await refreshAll();
  refreshTimer = setInterval(refreshAll, 10000);
  clockTimer = setInterval(() => { now.value = Date.now(); }, 1000);
  eventSource = new EventSource("/api/events");
  eventSource.addEventListener("ingest", () => refreshAll());
  eventSource.onerror = () => { status.value = "reconnecting"; };
});

onUnmounted(() => {
  clearInterval(refreshTimer);
  clearInterval(clockTimer);
  clearInterval(playbackTimer);
  destroyHistoryChart();
  eventSource?.close();
  map?.remove();
});
</script>

<template>
  <main class="shell">
    <section class="map-stage">
      <div ref="mapEl" class="map"></div>
      <div class="topbar">
        <div>
          <div class="brand">Skytrace</div>
          <div class="subline">
            <span :class="['status-dot', status]"></span>
            {{ status }} · {{ filteredAircraft.length }}/{{ aircraft.length }} aircraft · {{ receivers.length }} receivers
          </div>
        </div>
        <div class="toolbar">
          <button class="icon-button" title="Fit aircraft" @click="fitVisibleAircraft"><LocateFixed :size="18" /></button>
          <button class="icon-button" title="Refresh" @click="refreshAll"><RefreshCw :size="18" /></button>
        </div>
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

    <aside class="panel">
      <div class="panel-main">
        <div class="search-wrap">
          <Search :size="18" />
          <input v-model="search" type="search" placeholder="Search hex, callsign, squawk, source" />
        </div>

        <div class="metric-grid">
          <div><span>{{ stats.live }}</span><small>Live aircraft</small></div>
          <div><span>{{ stats.onGround }}</span><small>On ground</small></div>
          <div><span>{{ stats.nonIcao }}</span><small>Non-ICAO</small></div>
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
              <h2>{{ formatFlight(selectedAircraft) }}</h2>
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
            <div class="detail-metric" :class="detailMetricClass('windSpeed')" @click="toggleHistoryMetrics('windSpeed')"><dt>Wind</dt><dd>{{ selectedAircraft.windSpeed == null ? "-" : `${formatSpeed({ gs: selectedAircraft.windSpeed })} from ${formatDegrees(selectedAircraft.windDirection)}` }}</dd></div>
            <div class="detail-metric" :class="detailMetricClass(['oat', 'tat'])" @click="toggleHistoryMetrics(['oat', 'tat'])"><dt>Temp</dt><dd>{{ formatTemp(selectedAircraft.oat) }} / {{ formatTemp(selectedAircraft.tat) }}</dd></div>
            <div><dt>Selected Alt</dt><dd>{{ formatNumberUnit(altitudeValue(selectedAircraft.navAltitudeMcp ?? selectedAircraft.navAltitudeFms)) }}</dd></div>
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

        <section class="list">
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
            :class="['aircraft-row', { active: selectedHex === item.hex, hovered: hoveredHex === item.hex, 'is-alert': !!aircraftAlert(item) }]"
            @click="selectAircraft(item.hex, true)"
            @mouseenter="setHover(item.hex)"
            @mouseleave="clearHover(item.hex)"
          >
            <span class="alt-dot" :style="{ background: altitudeColor(item) }"></span>
            <span><strong>{{ formatFlight(item) }}</strong><small>{{ item.hex.toUpperCase() }} · {{ sourceLabel(item) }}</small></span>
            <span><strong>{{ formatAltitude(item) }}</strong><small>{{ formatSpeed(item) }} · {{ formatAge(item.observedAt) }}</small></span>
          </button>
        </section>

        <section class="receiver-list">
          <header><RadioTower :size="17" /><span>Receivers</span></header>
          <div v-for="receiver in receivers" :key="receiver.id" class="receiver-row">
            <span :class="['receiver-light', { on: receiver.online }]"></span>
            <span>{{ receiver.name }}</span>
            <small>{{ receiver.currentAircraft }} aircraft</small>
          </div>
        </section>

        <section class="coverage-card">
          <header><Layers :size="17" /><span>Coverage</span></header>
          <div class="coverage-note">{{ coverageSummary.areas }} outline areas · {{ coverageSummary.positions }} history positions · {{ coverageSummary.receivers }} receivers</div>
        </section>

        <section class="coverage-card">
          <header><TowerControl :size="17" /><span>Airfields</span></header>
          <div class="coverage-note">
            {{ settings.airfields ? (settings.airfieldsMinor ? airfieldSummary.total : airfieldSummary.coded) : 0 }} shown ·
            {{ airfieldSummary.coded }} coded · {{ airfieldSummary.minor }} minor fields
          </div>
        </section>
      </div>

      <section :class="['settings-dock', { open: controlsOpen }]">
        <button type="button" class="settings-toggle" @click="controlsOpen = !controlsOpen">
          <span class="settings-toggle-title"><SlidersHorizontal :size="17" /> Filters & display</span>
          <small>{{ settings.source === "all" ? "all sources" : settings.source }} · {{ settings.units }} · {{ baseLayers[settings.baseLayer]?.label }}</small>
          <ChevronDown :class="['chevron', { open: controlsOpen }]" :size="18" />
        </button>
        <div v-show="controlsOpen" class="settings-body">
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
            </div>
          </section>

          <section class="controls">
            <header><Settings :size="17" /><span>Display</span></header>
            <div class="control-grid">
              <label><span>Units</span><select v-model="settings.units"><option value="aero">Aeronautical</option><option value="metric">Metric</option><option value="imperial">Imperial</option></select></label>
              <label><span>Map</span><select v-model="settings.baseLayer"><option v-for="layer in Object.keys(baseLayers)" :key="layer" :value="layer">{{ baseLayers[layer].label }}</option></select></label>
              <label><span>Icon scale</span><input v-model.number="settings.iconScale" type="range" min="0.75" max="1.6" step="0.05" /></label>
            </div>
            <div class="toggle-row">
              <label><input v-model="settings.labels" type="checkbox" /> All labels</label>
            </div>
          </section>
        </div>
      </section>
    </aside>
  </main>
</template>
