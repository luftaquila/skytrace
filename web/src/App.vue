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
  X,
} from "@lucide/vue";

const SETTINGS_KEY = "skytrace.settings.v2";
const DEFAULT_SETTINGS = {
  units: "aero",
  baseLayer: "satellite",
  iconScale: 1,
  labels: true,
  coverage: true,
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
const selectedTrack = ref([]);
const search = ref("");
const status = ref("loading");
const lastUpdated = ref(null);
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
let historyChart;
let refreshTimer;
let eventSource;
let playbackTimer;
const markers = new Map();

watch(settings, (value) => {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(value));
  applyBaseLayer();
  upsertMarkers();
  drawCoverage();
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
  return rows.slice(0, 600);
});

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
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
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

function altitudeColor(item) {
  if (item.onGround) return "#9ca3af";
  const alt = item.altBaro ?? item.altGeom;
  if (alt == null) return "#e5e7eb";
  if (alt < 5000) return "#f97316";
  if (alt < 18000) return "#facc15";
  if (alt < 32000) return "#38bdf8";
  return "#c084fc";
}

function markerHtml(item) {
  const rotation = item.onGround ? 0 : Number.isFinite(item.track) ? item.track : 0;
  const color = altitudeColor(item);
  const scale = Math.max(0.75, Math.min(1.6, Number(settings.value.iconScale) || 1));
  const label = settings.value.labels ? `<span class="aircraft-label">${escapeHtml(formatFlight(item))}</span>` : "";
  const classes = [
    item.emergency && item.emergency !== "none" ? "is-emergency" : "",
  ].filter(Boolean).join(" ");
  const glyph = item.onGround
    ? `<svg class="aircraft-svg ground-svg" viewBox="0 0 36 36" aria-hidden="true">
        <rect class="aircraft-body" x="8" y="12" width="20" height="12" rx="3"></rect>
        <path class="aircraft-detail" d="M11 16h14M13 24v4M23 24v4"></path>
        <circle class="aircraft-wheel" cx="13" cy="28" r="2"></circle>
        <circle class="aircraft-wheel" cx="23" cy="28" r="2"></circle>
      </svg>`
    : `<svg class="aircraft-svg plane-svg" viewBox="0 0 36 36" aria-hidden="true" style="transform: rotate(${rotation}deg)">
        <path class="aircraft-body" d="M18 2.5c1.4 0 2.4 1.2 2.4 2.8v9.4l12.1 7.2v3.4l-12.1-3.2v6.8l4 3v2.4L18 32.5l-6.4 1.8v-2.4l4-3v-6.8L3.5 25.3v-3.4l12.1-7.2V5.3c0-1.6 1-2.8 2.4-2.8Z"></path>
        <path class="aircraft-highlight" d="M18 5.4v23.8"></path>
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

function upsertMarkers() {
  if (!map) return;
  const visible = new Set();
  for (const item of filteredAircraft.value) {
    if (item.lat == null || item.lon == null) continue;
    visible.add(item.hex);
    const latLng = [item.lat, item.lon];
    const title = `${formatFlight(item)} ${formatAltitude(item)} ${formatSpeed(item)} ${sourceLabel(item)}`;
    const existing = markers.get(item.hex);
    if (existing) {
      existing.setLatLng(latLng);
      existing.setIcon(markerIcon(item));
      existing.setTooltipContent(title);
    } else {
      const marker = L.marker(latLng, { icon: markerIcon(item), title });
      marker.bindTooltip(title, { direction: "top", offset: [0, -12] });
      marker.on("click", () => selectAircraft(item.hex, true));
      marker.addTo(map);
      markers.set(item.hex, marker);
    }
  }

  for (const [hex, marker] of markers) {
    if (!visible.has(hex)) {
      marker.remove();
      markers.delete(hex);
    }
  }
}

function catmullRomPoint(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return [
    0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
    0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
  ];
}

function smoothClosedCoverageLine(ring) {
  const source = (ring || []).map(([lon, lat]) => [lat, lon]);
  if (source.length > 1) {
    const first = source[0];
    const last = source[source.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) source.pop();
  }
  const points = [...new Map(source.map((point) => [point.join(","), point])).values()];
  if (points.length < 3) return points;

  const smooth = [];
  const steps = Math.max(6, Math.ceil(72 / points.length));
  for (let i = 0; i < points.length; i += 1) {
    const p0 = points[(i - 1 + points.length) % points.length];
    const p1 = points[i];
    const p2 = points[(i + 1) % points.length];
    const p3 = points[(i + 2) % points.length];
    for (let step = 0; step < steps; step += 1) {
      smooth.push(catmullRomPoint(p0, p1, p2, p3, step / steps));
    }
  }
  smooth.push(smooth[0]);
  return smooth;
}

function drawCoverage() {
  if (!map) return;
  if (coverageLayer) coverageLayer.remove();
  coverageLayer = L.layerGroup();
  if (!settings.value.coverage) return;
  const areas = coverage.value.areas || [];

  for (const area of areas) {
    const ring = area.polygon?.coordinates?.[0];
    if (!ring?.length) continue;
    const latLngs = smoothClosedCoverageLine(ring);
    if (latLngs.length < 2) continue;
    L.polyline(latLngs, {
      color: "#071012",
      weight: 7,
      opacity: 0.72,
      interactive: false,
      lineCap: "round",
      lineJoin: "round",
    }).addTo(coverageLayer);
    L.polyline(latLngs, {
      color: "#48e0d1",
      weight: 3,
      opacity: 0.92,
      interactive: true,
      lineCap: "round",
      lineJoin: "round",
    })
      .bindTooltip(`${area.receiverName || "Receiver"} · ${area.count} positions · max ${formatNumberUnit(altitudeValue(area.maxAltitude))}`)
      .addTo(coverageLayer);
  }
  coverageLayer.addTo(map);
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

function drawTrack() {
  if (!map) return;
  if (trackLayer) trackLayer.remove();
  trackLayer = L.layerGroup();
  const points = selectedTrack.value
    .filter((point) => point.lat != null && point.lon != null)
    .map((point) => [point.lat, point.lon]);
  if (points.length >= 2) {
    L.polyline(points, { color: "#fbbf24", opacity: 0.9, weight: 3 }).addTo(trackLayer);
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
    lastUpdated.value = current.now;
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
  selectedTrack.value = result.points || [];
  if (resetPlayback) {
    playbackSpeed.value = 0;
    playbackIndex.value = selectedTrack.value.length ? selectedTrack.value.length - 1 : 0;
  } else {
    playbackIndex.value = Math.min(playbackIndex.value, Math.max(0, selectedTrack.value.length - 1));
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
watch(selectedHistoryMetrics, () => queueHistoryChartRender(), { deep: true });
watch(selectedTrack, () => queueHistoryChartRender());
watch(playbackIndex, () => {
  drawTrack();
  setHistoryChartCursor();
});

onMounted(async () => {
  map = L.map(mapEl.value, { zoomControl: false, preferCanvas: true }).setView([36.2, 127.8], 7);
  L.control.zoom({ position: "bottomright" }).addTo(map);
  applyBaseLayer();
  await refreshAll();
  refreshTimer = setInterval(refreshAll, 10000);
  eventSource = new EventSource("/api/events");
  eventSource.addEventListener("ingest", () => refreshAll());
  eventSource.onerror = () => { status.value = "reconnecting"; };
});

onUnmounted(() => {
  clearInterval(refreshTimer);
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
    </section>

    <aside class="panel">
      <div class="panel-main">
        <div class="search-wrap">
          <Search :size="18" />
          <input v-model="search" type="search" placeholder="Search hex, callsign, squawk, source" />
        </div>

        <div class="metric-grid">
          <div><span>{{ stats.live }}</span><small>Live aircraft</small></div>
          <div><span>{{ stats.withPosition }}</span><small>With position</small></div>
          <div><span>{{ lastUpdated ? formatAge(lastUpdated) : "-" }}</span><small>Updated</small></div>
        </div>

        <section v-if="selectedAircraft" class="detail">
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
          </div>
        </section>

        <section class="list">
          <header><CircleDot :size="17" /><span>Aircraft</span></header>
          <button v-for="item in filteredAircraft" :key="item.hex" :class="['aircraft-row', { active: selectedHex === item.hex }]" @click="selectAircraft(item.hex, true)">
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
              <label><input v-model="settings.labels" type="checkbox" /> Labels</label>
            </div>
          </section>
        </div>
      </section>
    </aside>
  </main>
</template>
