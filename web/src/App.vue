<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from "vue";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import {
  Activity,
  ChevronDown,
  Download,
  Eye,
  FileCog,
  Filter,
  Gauge,
  Info,
  Layers,
  LocateFixed,
  Pin,
  Crosshair,
  Radar,
  RadioTower,
  Search,
  Settings,
  SlidersHorizontal,
  Target,
  X,
} from "@lucide/vue";
import { planeMeshKind, planeSizeScale } from "./aircraft-kind.js";
import { mergeAircraftSources, sortAircraft } from "./aircraft-view.js";
import { mapCredits } from "./credits.js";
import { domeCentre } from "./coverage-centre.js";
import { createEventStream } from "./event-stream.js";
import {
  ALTITUDE_UNITS,
  DEFAULT_SETTINGS,
  DISTANCE_UNITS,
  MAX_SETTINGS_IMPORT_BYTES,
  RATE_UNITS,
  SETTINGS_KEY,
  SETTING_BOUNDS,
  SPEED_UNITS,
  TEMP_UNITS,
  UNIT_PRESETS,
  clampSetting,
  convertSettingsUnit,
  loadSettings,
  normalizeSettings,
  saveSettings,
} from "./settings.js";
import { deriveSite } from "./site.js";
import { spatialConflictPairs } from "./proximity.js";
import { currentTrackRun, mergeTrackPoints, reconcilePlaybackIndex } from "./track-runs.js";

// A numeric field bound with v-model.number holds "" while the operator retypes it. Consumers of
// these settings never read them raw: this returns the bounded number, falling back to the default
// for the duration of an invalid edit, so clearing a field can never blank the display, spin a
// zero-delay poll loop or silently disable an alert.
function boundedSetting(key) {
  const [min, max, fallback] = SETTING_BOUNDS[key];
  return clampSetting(settings.value[key], min, max, fallback);
}

const map3dEl = ref(null);
// Two traffic sources, one list: our receivers' aircraft, plus display-only aggregator traffic
// for whatever region the camera is looking at. Own receivers always win a shared hex — they
// are fresher and authoritative; the area feed only fills the gaps.
const receiverAircraft = shallowRef([]);
const areaAircraft = shallowRef([]);
const AREA_FEED_ROW_ID = "@network";
const areaFeedConfigured = ref(false);
const areaFeedHost = ref(null);
const areaFeedOnline = ref(false);
const areaFeedLastAt = ref(null);
const aircraft = computed(() => {
  return mergeAircraftSources(
    receiverAircraft.value,
    areaAircraft.value,
    settings.value.trafficHidden,
  );
});
const receivers = ref([]);
const coverage = shallowRef({ areas: [], points: [] });
const selectedHex = ref(null);
// The archive-search result behind the current selection ({hex, flight, lastSeenAt, ...}), or
// null when the selection is a live target. Keeps a past flight selectable: without it the
// selectedAircraft watcher would clear any hex missing from the live picture.
const archiveSelection = ref(null);
const selectedAirfield = ref(null);
const trackingActive = ref(false);
// Live camera attitude, fed from the render loop: the compass rose points true north and its
// disc leans with the view pitch, like a little gyro ball of the ground plane.
const mapBearing = ref(0);
const mapPitch = ref(0);
// One rigid ball: rings, needle and ticks share a single transform — it leans with the pitch and
// the WHOLE cage spins with the bearing, exactly like a trackball of the ground plane. The pitch
// is uncapped on purpose: past 90° the camera is under the ground looking up, and the ball flips
// with it.
const compassBallStyle = computed(() => ({
  transform: `rotateX(${mapPitch.value}deg) rotateZ(${-mapBearing.value}deg)`,
}));
const hoveredHex = ref(null);
const selectedTrackRaw = shallowRef([]);
const archivePages = shallowRef(new Map());
const selectedHistoric = ref(false);
const historyLoading = ref(false);
const MAX_LIVE_TRACK_POINTS = 10000;
const MAX_ARCHIVE_PAGES = 3;
const MAX_PINNED_TRACKS = 16;
const trackCursors = new Map();
const archiveTrack = computed(() => {
  const points = [];
  const seen = new Set();
  for (const page of archivePages.value.values()) {
    for (const point of page.points) {
      const key = point.id ?? `${point.positionAt}:${point.lat}:${point.lon}`;
      if (!seen.has(key)) {
        seen.add(key);
        points.push(point);
      }
    }
  }
  return points.sort((a, b) => Date.parse(a.positionAt) - Date.parse(b.positionAt) || a.id - b.id);
});
const oldestArchivePage = computed(() => [...archivePages.value.values()].at(-1) || null);
const hasLatestArchivePage = computed(() => archivePages.value.has("latest"));
const selectedTrack = computed(() => {
  return selectedHistoric.value ? archiveTrack.value : currentTrackRun(selectedTrackRaw.value);
});
// One control for the track scope: the current flight, or everything the server has recorded.
const trackScope = computed({
  get: () => (selectedHistoric.value ? "full" : "current"),
  set: (scope) => {
    selectedHistoric.value = scope === "full";
    playbackIndex.value = Math.max(0, selectedTrack.value.length - 1);
    renderTrackView();
  },
});
// Pinned aircraft: their popover label AND their track stay shown regardless of hover /
// selection. pinnedTracks caches each pinned hex's track points.
const pinned = ref(new Set());
const pinnedTracks = shallowRef(new Map());
const pinRequestVersions = new Map();
const pinRequestControllers = new Map();
const pinnedTrackList = computed(() => [...pinnedTracks.value].map(([hex, points]) => ({
  hex,
  points,
  historic: false,
})));
const search = ref("");
const sortKey = ref("callsign");
const tracklogOpen = ref(false);
const status = ref("loading");
const lastUpdated = ref(null);
let wallNow = Date.now();
const transitionEpoch = ref(0);
const settings = ref(loadSettings());
const playbackIndex = ref(0);
const chartEl = ref(null);
const selectedHistoryMetrics = ref(["altBaro", "gs"]);
// Cursor readout for the history chart: series values ride a tooltip on the plot itself and the
// strip under it carries only the centred timestamp (a value table there was unreadable).
const chartCursor = ref({ show: false, x: 0, side: "right", time: "—", rows: [] });

// --- Stations ---------------------------------------------------------------------------------
// The shell is a full-bleed map under a fixed command bar. Every other surface is a "station":
// an independent console floating over the scene (TARGET / TRAFFIC / SYSTEMS), toggled from the
// bar. No station reserves layout space from the map, so dismissing or opening one never
// reflows or resizes the scene. Desktop keeps the open set across reloads; a phone treats
// stations as ephemeral bottom sheets where only one can be up at a time, so the map is never
// buried under stacked panels and there is no sheet-height micro-management.
const STATIONS_KEY = "skytrace.stations";
const MOBILE_QUERY = "(max-width: 900px)";
function isMobileLayout() { return window.matchMedia(MOBILE_QUERY).matches; }
const viewportMobile = ref(isMobileLayout());
function onViewportChange() { viewportMobile.value = isMobileLayout(); }

const savedStations = (() => { try { return JSON.parse(localStorage.getItem(STATIONS_KEY) || "{}"); } catch { return {}; } })();
const stations = ref({
  target: savedStations.target !== false,
  traffic: savedStations.traffic !== false,
});
// The settings console is session state, never persisted: nobody wants it pre-opened on reload.
const systemsOpen = ref(false);
const mobileStation = ref(null);

// Each settings card folds from its header — a long receiver list must not bury the cards below
// it. The folded set persists like the stations do. A fresh browser starts with everything but
// Status folded: the console opens as a compact index, not a wall.
const CARDS_KEY = "skytrace.consoleCards";
const CARDS_FOLDED_FRESH = ["receivers", "filters", "units", "display", "config"];
const collapsedCards = ref((() => {
  try {
    const stored = localStorage.getItem(CARDS_KEY);
    if (stored == null) return new Set(CARDS_FOLDED_FRESH);
    const parsed = JSON.parse(stored);
    return new Set(Array.isArray(parsed) ? parsed.filter((name) => typeof name === "string") : []);
  } catch { return new Set(CARDS_FOLDED_FRESH); }
})());

function cardCollapsed(name) {
  return collapsedCards.value.has(name);
}

function toggleCard(name) {
  const next = new Set(collapsedCards.value);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  collapsedCards.value = next;
  try { localStorage.setItem(CARDS_KEY, JSON.stringify([...next])); } catch { /* storage full/blocked: the fold still works for this session */ }
}

function saveStations() {
  try { localStorage.setItem(STATIONS_KEY, JSON.stringify(stations.value)); } catch { /* storage denied */ }
}

// Provider credits, deliberately NOT persisted: this is a thing an operator opens once to read, not
// a panel they want restored on every load.
const creditsOpen = ref(false);
const credits = computed(() => mapCredits({ areaFeedHost: areaFeedHost.value }));

// MIT/BSD/ISC all make retaining the copyright notice a condition of redistribution, and the
// minifier strips every legal comment out of the bundle — so the notices ship as a separate file
// that scripts/notices.mjs generates from the dependency trees. It is fetched the first time the
// section is expanded and never bundled: it is mostly repeated licence text nobody reads by default.
const licensesOpen = ref(false);
const notices = ref([]);
const noticesError = ref(null);

async function toggleLicenses() {
  licensesOpen.value = !licensesOpen.value;
  if (!licensesOpen.value || notices.value.length || noticesError.value) return;
  try {
    const response = await fetch("/third-party-notices.json");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    notices.value = Array.isArray(payload?.packages) ? payload.packages : [];
    if (!notices.value.length) noticesError.value = "No licence data was shipped with this build.";
  } catch (error) {
    noticesError.value = `Licences unavailable: ${error?.message || error}`;
  }
}

const stationOpen = computed(() => (viewportMobile.value
  ? {
      target: mobileStation.value === "target",
      traffic: mobileStation.value === "traffic",
      systems: mobileStation.value === "systems",
    }
  : {
      target: stations.value.target,
      traffic: stations.value.traffic,
      systems: systemsOpen.value,
    }));

function toggleStation(name) {
  if (viewportMobile.value) {
    mobileStation.value = mobileStation.value === name ? null : name;
    return;
  }
  if (name === "systems") {
    systemsOpen.value = !systemsOpen.value;
    return;
  }
  stations.value[name] = !stations.value[name];
  saveStations();
}


let historyChart;
let historyChartMetricsKey = "";
let chartResizeObserver;
let refreshTimer;
let coverageTimer;
let clockTimer;
let transitionTimer;
let eventStream;
let tac3d;
let tac3dPromise;
let selectedTrackRequestVersion = 0;
let historyRetryTimer;

watch(settings, (value) => {
  saveSettings(value);
  scheduleNextTargetTransition();
  tac3d?.applySettings();
  queueHistoryChartRender();
}, { deep: true });

// Coast and drop are the two ends of one staleness window: a target has to render as stale before
// it is removed, or it would vanish while still looking live. normalizeSettings enforces this for
// stored and imported values; these keep it true for a live edit, with the edited end winning.
// A field emptied mid-edit ("" from v-model.number) is not an edit yet: coercing it would stomp
// both values (""-5 → NaN → floor) the moment the operator clears the box to retype it.
watch(() => settings.value.coastSeconds, (coast) => {
  const value = Number(coast);
  const drop = Number(settings.value.dropSeconds);
  if (!Number.isFinite(value) || coast === "" || !Number.isFinite(drop)) return;
  if (drop < value + 5) {
    settings.value.dropSeconds = clampSetting(value + 5, 10, 1800, 60);
  }
});
watch(() => settings.value.dropSeconds, (drop) => {
  const value = Number(drop);
  const coast = Number(settings.value.coastSeconds);
  if (!Number.isFinite(value) || drop === "" || !Number.isFinite(coast)) return;
  if (value < coast + 5) {
    settings.value.coastSeconds = clampSetting(value - 5, 5, 600, 20);
  }
});

// Per-source target counts. The traffic totals live in the map HUD, so this only has to feed the
// source filter's options and the console's feed-source chips.
const sourceCounts = computed(() => {
  const sources = {};
  for (const item of aircraft.value) {
    const key = item.sourceKind || "unknown";
    sources[key] = (sources[key] || 0) + 1;
  }
  return sources;
});

const sourceOptions = computed(() => ["all", ...Object.keys(sourceCounts.value).sort()]);

const sourceChips = computed(() =>
  Object.entries(sourceCounts.value)
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => ({ key, label: sourceLabel({ sourceKind: key }), count })),
);

function setHover(hex) {
  hoveredHex.value = hex;
}

function clearHover(hex) {
  if (hoveredHex.value === hex) hoveredHex.value = null;
}

// --- Coverage visibility -------------------------------------------------------------------
// /api/coverage publishes no receiver id — each area carries only the public receiver name and a
// mesh anchored on the server-chosen origin (the receiver's registered position when it reports
// one, else its reception centroid) — so the per-receiver dome toggles are keyed on that name.
// Derived from live coverage, so a community deployment centres on its own receivers.
const siteRef = computed(() => deriveSite(coverage.value.areas));

// Every per-receiver ground anchor the display can measure from: the dome-estimated centres the
// rings and the focus button use. Range readouts and the max-range filter take the NEAREST one.
const receiverCentres = computed(() => (coverage.value.areas || [])
  .map((area) => domeCentre(area.volumeMesh))
  .filter(Boolean));

function nearestReceiverNm(item) {
  let best = null;
  for (const centre of receiverCentres.value) {
    const d = distanceNm({ lat: centre.lat, lng: centre.lon }, { lat: item.lat, lng: item.lon });
    if (best == null || d < best) best = d;
  }
  return best;
}

const coverageHidden = computed(() => new Set(settings.value.coverageHidden));

function coverageVisible(receiverName) {
  return !coverageHidden.value.has(receiverName);
}

function toggleCoverageReceiver(receiverName) {
  const hidden = new Set(settings.value.coverageHidden);
  if (hidden.has(receiverName)) hidden.delete(receiverName);
  else hidden.add(receiverName);
  settings.value.coverageHidden = [...hidden];
}

// Range rings follow the same per-receiver pattern as the domes: visible unless switched off.
const ringsHidden = computed(() => new Set(settings.value.ringsHidden));

function ringsVisible(receiverName) {
  return !ringsHidden.value.has(receiverName);
}

function toggleRingsReceiver(receiverName) {
  const hidden = new Set(settings.value.ringsHidden);
  if (hidden.has(receiverName)) hidden.delete(receiverName);
  else hidden.add(receiverName);
  settings.value.ringsHidden = [...hidden];
}

// Per-receiver traffic visibility. Hiding a receiver hides the targets ONLY it sees — a target
// any other visible receiver still carries stays on the display. The virtual network-feed row
// binds settings.areaFeed instead: its toggle gates the fetch itself, not just the display.
const trafficHidden = computed(() => new Set(settings.value.trafficHidden));

function receiverTrafficVisible(id) {
  return !trafficHidden.value.has(id);
}

function toggleReceiverTraffic(id) {
  const hidden = new Set(settings.value.trafficHidden);
  if (hidden.has(id)) hidden.delete(id);
  else hidden.add(id);
  settings.value.trafficHidden = [...hidden];
}

// One row per receiver carrying everything about it: link state, traffic, coverage size, whether its
// dome is drawn, and where its reception centres. Coverage used to be a second list in another block,
// which meant hunting between two places to answer one question about one receiver.
const receiverRows = computed(() => {
  const areas = new Map((coverage.value.areas || []).map((area) => [area.receiverName, area]));
  const rows = receivers.value.map((receiver) => {
    const area = areas.get(receiver.name);
    areas.delete(receiver.name);
    return receiverRow(receiver, area);
  });
  // A receiver with coverage but no current row (renamed, or reporting only historically) must not
  // silently vanish from the only place its dome can be switched off.
  for (const [name, area] of areas) {
    rows.push(receiverRow({ id: `coverage:${name}`, name, online: false, currentAircraft: 0, lastSeenAt: area.lastSeenAt }, area));
  }
  // The on-demand network feed is listed only when the server confirms that its upstream is
  // configured. It is still a traffic SOURCE, not a receiver: no coverage, rings or focus.
  if (areaFeedConfigured.value) {
    rows.push({
      id: AREA_FEED_ROW_ID,
      virtual: true,
      name: "Network feed",
      online: settings.value.areaFeed && areaFeedOnline.value,
      aircraft: areaAircraft.value.length,
      lastSeenAt: areaFeedLastAt.value,
      hasCoverage: false,
      center: null,
    });
  }
  return rows;
});

function receiverRow(receiver, area) {
  return {
    id: receiver.id,
    name: receiver.name,
    online: Boolean(receiver.online),
    aircraft: receiver.currentAircraft ?? 0,
    lastSeenAt: receiver.lastSeenAt,
    hasCoverage: Boolean(area?.volumeMesh),
    // Estimated from the dome, never the published origin — see coverage-centre.js.
    center: domeCentre(area?.volumeMesh),
  };
}

function focusReceiver(row) {
  if (!row.center) return;
  trackingActive.value = false;
  tac3d?.focusReceiver(row.center.lon, row.center.lat);
}

// The ring scale (and every distance filter) follows the active distance unit rather than a
// second, separate unit setting.
const altitudeUnit = computed(() => ALTITUDE_UNITS[settings.value.unitAltitude] || ALTITUDE_UNITS.ft);
const speedUnit = computed(() => SPEED_UNITS[settings.value.unitSpeed] || SPEED_UNITS.kt);
const distanceUnitSpec = computed(() => DISTANCE_UNITS[settings.value.unitDistance] || DISTANCE_UNITS.nm);
const rateUnit = computed(() => RATE_UNITS[settings.value.unitAltitude] || RATE_UNITS.ft);
const tempUnit = computed(() => TEMP_UNITS[settings.value.unitTemperature] || TEMP_UNITS.c);
const distanceUnit = computed(() => distanceUnitSpec.value.label);

// Filters and the ring spacing are stored in the unit the panel displays, so changing a unit is a
// re-labelling of stored numbers, not a new intention: a 10,000 ft ceiling must become 3,048 m,
// not silently relax to 10,000 m. These setters are the only unit-change path (the selects and the
// presets both go through them); an import never passes through here, so a file whose values
// already arrive in its own units is never double-converted.
function setAltitudeUnit(next) {
  settings.value = convertSettingsUnit(settings.value, "altitude", next);
}

function setSpeedUnit(next) {
  settings.value = convertSettingsUnit(settings.value, "speed", next);
}

function setDistanceUnit(next) {
  settings.value = convertSettingsUnit(settings.value, "distance", next);
  // The ring spacing deliberately does NOT convert: rings are a round mental scale, so switching
  // to km should read "3 × 100 km", not "3 × 185 km".
}

// Flight levels ride the altitude select as a third option over a feet base: FL is a feet-defined
// standard, and filters keep reading in feet while it is active.
const unitAltitudeModel = computed({
  get: () => (settings.value.flightLevels ? "fl" : settings.value.unitAltitude),
  set: (next) => {
    if (next === "fl") {
      setAltitudeUnit("ft");
      settings.value.flightLevels = true;
      return;
    }
    settings.value.flightLevels = false;
    setAltitudeUnit(next);
  },
});
const unitSpeedModel = computed({ get: () => settings.value.unitSpeed, set: setSpeedUnit });
const unitDistanceModel = computed({ get: () => settings.value.unitDistance, set: setDistanceUnit });

// The rings carry their own unit, picked in the Range rings card — independent of the numeric
// readout unit.
const ringUnitLabel = computed(() => (DISTANCE_UNITS[settings.value.ringUnit] || DISTANCE_UNITS.nm).label);

const searchQuery = computed(() => search.value.trim().toLowerCase());

// Filter inputs are typed in the units the panel displays, so they are converted into the
// internal feet / knots / nautical miles here rather than making the operator do it.
function parseLimit(raw, convert) {
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? convert(value) : null;
}

const trafficLimits = computed(() => ({
  altMin: parseLimit(settings.value.altMin, altitudeUnit.value.toFeet),
  altMax: parseLimit(settings.value.altMax, altitudeUnit.value.toFeet),
  speedMin: parseLimit(settings.value.speedMin, speedUnit.value.toKnots),
  speedMax: parseLimit(settings.value.speedMax, speedUnit.value.toKnots),
  maxRangeNm: parseLimit(settings.value.maxRange, distanceUnitSpec.value.toNm),
}));

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
  if (!item.areaFeed && Array.isArray(item.receivers) && item.receivers.length
    && item.receivers.every((id) => !receiverTrafficVisible(id))) return false;
  if (settings.value.source !== "all" && item.sourceKind !== settings.value.source) return false;
  const limits = trafficLimits.value;
  if (limits.altMin != null || limits.altMax != null) {
    const alt = item.altBaro ?? item.altGeom;
    if (limits.altMin != null && (alt == null || alt < limits.altMin)) return false;
    if (limits.altMax != null && (alt == null || alt > limits.altMax)) return false;
  }
  if (limits.speedMin != null || limits.speedMax != null) {
    if (limits.speedMin != null && (item.gs == null || item.gs < limits.speedMin)) return false;
    if (limits.speedMax != null && (item.gs == null || item.gs > limits.speedMax)) return false;
  }
  // Range is measured from the NEAREST receiver — the same dome-estimated centres the rings
  // anchor on, so "within 100 NM" means within 100 NM of ANY receiver, not of the mean point
  // between them. With no receiver coverage there is no origin to measure from: no-op.
  if (limits.maxRangeNm != null && receiverCentres.value.length) {
    if (item.lat == null || item.lon == null) return false;
    const nearest = nearestReceiverNm(item);
    if (nearest != null && nearest > limits.maxRangeNm) return false;
  }
  return true;
}

// Cap only the traffic list; the 3D layer continues to render every aircraft that passes filters.
// Dropped targets are excluded with the same predicate the map and the TRK count use, so the list
// never shows rows for targets the display no longer carries.
const LIST_LIMIT = 600;
const filteredAircraft = computed(() =>
  sortAircraft(aircraft.value.filter((item) => passesFilters(item) && !isDropped(item)), sortKey.value).slice(0, LIST_LIMIT),
);

const selectedAircraft = computed(() => {
  const item = aircraft.value.find((candidate) => candidate.hex === selectedHex.value) || null;
  // The display's drop boundary is earlier than /api/live's current-window expiry. Treat a
  // display-dropped target as absent here too, so the aircraft model, tracking orbit, Target
  // console and selected trail all end on the same transition instead of leaving a dead panel and
  // an orphaned trail until the server eventually removes the row.
  if (item && !isDropped(item)) return item;
  // An archive selection has no live row by definition. Synthesize the identity card so the
  // TARGET console — and with it the history chart, scrubber and KML export — serves a past
  // flight; every live-only metric renders as its normal "-" placeholder.
  const archived = archiveSelection.value;
  if (archived && archived.hex === selectedHex.value) {
    return {
      hex: archived.hex,
      flight: archived.flight || null,
      observedAt: archived.lastSeenAt,
      archived: true,
    };
  }
  return null;
});
watch(selectedAircraft, (item) => {
  // Selection, camera tracking and the selected trail are one lifecycle. This fires both at the
  // display drop boundary above and when /api/live removes the target outright.
  if (!item && selectedHex.value) clearSelection();
});

// Open consoles cover part of the scene, so the camera takes matching padding and a tracked
// target re-centres in the middle of the VISIBLE map: on a phone the strip above the sheet, on a
// desktop the span between the TARGET and TRAFFIC consoles. The corner chrome (legend + locate)
// deliberately stays uncounted. Sizes mirror the CSS: sheet 52vh + 54px tabs; consoles 430/340px
// wide with 12px margins each side.
const SHEET_VH = 0.52;
const TABS_PX = 54;
const viewInsets = computed(() => {
  if (viewportMobile.value) {
    const sheetOpen = mobileStation.value === "target" || mobileStation.value === "traffic";
    return { left: 0, right: 0, bottom: sheetOpen ? Math.round(window.innerHeight * SHEET_VH) + TABS_PX : 0 };
  }
  return {
    left: stationOpen.value.target && selectedAircraft.value ? 454 : 0,
    right: stationOpen.value.traffic ? 364 : 0,
    bottom: 0,
  };
});
watch(viewInsets, (insets) => tac3d?.setViewPadding(insets));

const kmlHref = computed(() => {
  if (!selectedHex.value) return "#";
  const page = [...archivePages.value.values()].at(-1);
  const params = new URLSearchParams();
  if (page?.requestCursor) params.set("olderCursor", page.requestCursor);
  const query = params.size ? `?${params}` : "";
  return `/api/aircraft/${selectedHex.value}/history.kml${query}`;
});

const selectedHistoryPoint = computed(() => {
  if (!selectedTrack.value.length) return null;
  return selectedTrack.value[Math.min(playbackIndex.value, selectedTrack.value.length - 1)] || null;
});

const selectedAlert = computed(() => aircraftAlert(selectedAircraft.value));

// Slant-free ground range from the NEAREST receiver — the same measurement the max-range filter
// and the range rings use, so a target's readout and the display's scale agree.
const selectedRange = computed(() => {
  const item = selectedAircraft.value;
  if (!item || item.lat == null || item.lon == null) return "-";
  const nearest = nearestReceiverNm(item);
  return nearest == null ? "-" : formatNumberUnit(distanceValue(nearest), 1);
});

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
  const unit = altitudeUnit.value;
  return { value: unit.fromFeet(feet), unit: unit.label };
}

function speedValue(knots) {
  if (knots == null) return null;
  const unit = speedUnit.value;
  return { value: unit.fromKnots(knots), unit: unit.label };
}

function distanceValue(nm) {
  if (nm == null) return null;
  const unit = distanceUnitSpec.value;
  return { value: unit.fromNm(nm), unit: unit.label };
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
  const unit = rateUnit.value;
  return `${numberFormatter(unit.label === "m/s" ? 1 : 0).format(unit.fromFpm(fpm))} ${unit.label}`;
}

function formatAge(iso) {
  if (!iso) return "-";
  const seconds = Math.max(0, Math.round((wallNow - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

// Age labels are the only DOM text that needs a one-second clock. Updating these nodes directly
// keeps the application-wide aircraft filters, sort, proximity scan and map data immutable
// between their scheduled coast/drop transitions.
const ageNodes = new Map();
const vAge = {
  mounted(element, binding) {
    ageNodes.set(element, binding.value);
    element.textContent = binding.value ? formatAge(binding.value) : "--";
  },
  updated(element, binding) {
    ageNodes.set(element, binding.value);
    element.textContent = binding.value ? formatAge(binding.value) : "--";
  },
  unmounted(element) {
    ageNodes.delete(element);
  },
};
function refreshAgeNodes() {
  for (const [element, value] of ageNodes) {
    element.textContent = value ? formatAge(value) : "--";
  }
}

function formatDegrees(value) {
  return value == null ? "-" : `${Math.round(value)}°`;
}

function formatTemp(value) {
  return value == null ? "-" : `${Math.round(tempUnit.value.fromC(value))}${tempUnit.value.label}`;
}

function formatClock(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "-" : d.toLocaleTimeString(undefined, { hour12: false });
}

// Timestamps render as YYYY-MM-DD HH:MM:SS, 24h, everywhere.
function formatStamp(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
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

// Sidebar row accent: danger alerts (emergency/special squawks) stay red; warning alerts
// (IDENT/ALERT) use the amber warning colour, matching the detail-panel alert styling.
function aircraftAlertClass(item) {
  const alert = aircraftAlert(item);
  if (!alert) return null;
  return alert.level === "warning" ? "is-alert is-alert-warning" : "is-alert";
}

function pointAltitude(point) {
  if (point.onGround) return "GND";
  return altText(point.altBaro ?? point.altGeom);
}

function pointSpeed(point) {
  return formatNumberUnit(speedValue(point.gs));
}

function focusTrackPoint(index) {
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
// "coasting" past COAST_AGE, then stop drawing it past DROP_AGE. The display drop may be earlier
// than the server's 90 s current window; selectedAircraft uses this same predicate so every visual
// and interaction surface still ends together.
// normalizeSettings() guarantees drop > coast for stored values, and the bounded read plus the
// max() below keep it true even while one of the fields sits empty mid-edit.
const coastAgeSec = computed(() => boundedSetting("coastSeconds"));
const dropAgeSec = computed(() => Math.max(boundedSetting("dropSeconds"), coastAgeSec.value + 5));
function targetAgeSec(item) {
  void transitionEpoch.value;
  const t = Date.parse(item.positionAt || item.observedAt);
  return Number.isFinite(t) ? (wallNow - t) / 1000 : 0;
}
function isCoasting(item) {
  return settings.value.coastDrop && targetAgeSec(item) >= coastAgeSec.value;
}
function isDropped(item) {
  return settings.value.coastDrop && targetAgeSec(item) >= dropAgeSec.value;
}
function coastOpacity(item) {
  if (!isCoasting(item)) return 1;
  // A target becomes visibly ghosted as soon as it is stale, then keeps fading until it drops.
  // Keep a small floor so it remains discoverable and selectable before the drop age removes it.
  const progress = Math.min(1, Math.max(0, (targetAgeSec(item) - coastAgeSec.value) / (dropAgeSec.value - coastAgeSec.value)));
  return 0.46 - progress * 0.24;
}

function scheduleNextTargetTransition() {
  clearTimeout(transitionTimer);
  wallNow = Date.now();
  if (!settings.value.coastDrop) return;
  let nextAt = Number.POSITIVE_INFINITY;
  for (const item of aircraft.value) {
    const observed = Date.parse(item.positionAt || item.observedAt);
    if (!Number.isFinite(observed)) continue;
    for (const age of [coastAgeSec.value, dropAgeSec.value]) {
      const at = observed + age * 1000;
      if (at > wallNow && at < nextAt) nextAt = at;
    }
  }
  if (!Number.isFinite(nextAt)) return;
  transitionTimer = setTimeout(() => {
    wallNow = Date.now();
    transitionEpoch.value += 1;
    scheduleNextTargetTransition();
  }, Math.max(0, nextAt - wallNow + 5));
}

// Proximity (STCA-style): airborne pairs closer than the configured lateral separation AND within
// the configured vertical separation. Recomputed only when the aircraft set changes or a target
// crosses a coast boundary; the spatial hash avoids an all-pairs scan. The 3 NM / 1000 ft
// default is tighter than the 5 NM en-route minimum so it flags genuinely close pairs rather than
// normal minimum separation; an operator watching a different airspace can widen it.
const conflicts = computed(() => {
  if (!settings.value.proximity) return [];
  const rows = [];
  for (const item of aircraft.value) {
    if (item.lat == null || item.lon == null || item.onGround) continue;
    // Skip stale "ghost" targets: their frozen last position produces phantom conflicts
    // against live traffic passing nearby. A conflict must be between two fresh tracks.
    // (Independent of the coast/drop display toggle.)
    if (targetAgeSec(item) >= coastAgeSec.value) continue;
    const alt = item.altBaro ?? item.altGeom;
    if (alt == null) continue;
    rows.push({ item, alt, pos: { lat: item.lat, lng: item.lon } });
  }
  // Bounded reads: an emptied threshold field must not silently disable the conflict scan.
  const maxVertFt = boundedSetting("proximityFt");
  const maxDistNm = boundedSetting("proximityNm");
  return spatialConflictPairs(rows, maxDistNm, maxVertFt);
});
// --- Tactical HUD (map top-left) -----------------------------------------------------------
// The HUD reports what the display is actually showing, so its counts come from the same
// filter + coast/drop predicates the 3D layer uses — not from the capped sidebar list.
const LINK_STATES = {
  online: { label: "LINK ONLINE", level: "ok" },
  loading: { label: "LINK SYNC", level: "wait" },
  reconnecting: { label: "LINK RETRY", level: "wait" },
  offline: { label: "LINK LOST", level: "fail" },
};
const linkState = computed(() => LINK_STATES[status.value] || LINK_STATES.offline);

const hudCounts = computed(() => {
  let tracked = 0;
  let airborne = 0;
  let ground = 0;
  let emergency = 0;
  let advisory = 0;
  for (const item of aircraft.value) {
    // Emergencies are counted across the whole feed: a filter hiding one must not hide the fact.
    const alert = aircraftAlert(item);
    if (alert?.level === "danger") emergency += 1;
    else if (alert) advisory += 1;
    if (!passesFilters(item) || isDropped(item)) continue;
    tracked += 1;
    if (item.onGround) ground += 1;
    else if ((item.altBaro ?? item.altGeom) != null) airborne += 1;
  }
  return { tracked, airborne, ground, emergency, advisory, total: aircraft.value.length };
});

const receiverStatus = computed(() => ({
  online: receivers.value.filter((receiver) => receiver.online).length,
  total: receivers.value.length,
}));

const hudAlerts = computed(() => {
  const rows = [];
  const { emergency, advisory } = hudCounts.value;
  if (emergency) rows.push({ level: "danger", label: "EMERGENCY", count: emergency });
  if (conflicts.value.length) rows.push({ level: "danger", label: "PROXIMITY", count: conflicts.value.length });
  if (advisory) rows.push({ level: "warning", label: "ADVISORY", count: advisory });
  return rows;
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
  if (metric.kind === "alt") return altitudeUnit.value.fromFeet(n);
  if (metric.kind === "speed") return speedUnit.value.fromKnots(n);
  if (metric.kind === "rate") return rateUnit.value.fromFpm(n);
  if (metric.kind === "temp") return tempUnit.value.fromC(n);
  return n;
}

// Unit suffix for the chart tooltip, matching whatever metricChartValue converted into.
function metricUnitLabel(metric) {
  if (metric.kind === "alt") return altitudeUnit.value.label;
  if (metric.kind === "speed") return speedUnit.value.label;
  if (metric.kind === "rate") return rateUnit.value.label;
  if (metric.kind === "degrees") return "°";
  if (metric.kind === "temp") return tempUnit.value.label;
  if (metric.kind === "rssi") return "dBFS";
  return "";
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
  // Aggregated area traffic wears a NET tag so it never masquerades as our own reception.
  const net = item.areaFeed ? " · NET" : "";
  if (raw.includes("adsb")) return `ADS-B${net}`;
  if (raw.includes("mlat")) return `MLAT${net}`;
  if (raw.includes("tisb")) return `TIS-B${net}`;
  if (raw.includes("uat")) return `UAT${net}`;
  if (raw === "mode_s" || raw.includes("mode")) return `Mode S${net}`;
  if (raw === "adsc") return `ADS-C${net}`;
  if (raw === "unknown") return `Unknown${net}`;
  return (raw
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || "Unknown") + net;
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
  const unit = fl ? "FL" : altitudeUnit.value.label;
  const ticks = [1, 0.75, 0.5, 0.25, 0].map((frac) => {
    const value = fl
      ? Math.round((frac * ALT_COLOR_MAX_FT) / 100)
      : altitudeUnit.value.fromFeet(frac * ALT_COLOR_MAX_FT);
    const label = !fl && value >= 1000 ? `${Math.round(value / 1000)}k` : `${Math.round(value)}`;
    return { label: frac === 0 ? `${label} (${unit})` : label };
  });
  return {
    gradient: `linear-gradient(to top, ${stops.join(", ")})`,
    ticks,
    groundColor: ALT_COLOR_GROUND,
  };
});

function verticalArrowSymbol(item) {
  if (item.onGround) return "";
  const rate = item.baroRate ?? item.geomRate;
  if (rate == null) return "";
  if (rate > 100) return "↑";
  if (rate < -100) return "↓";
  return "→";
}

// Trend colour class shared by the 3D data block and the traffic-list rows.
function verticalTrendClass(item) {
  const arrow = verticalArrowSymbol(item);
  return arrow === "↑" ? "up" : arrow === "↓" ? "down" : "level";
}

// Second line in the 3D data block: the vertical-trend arrow immediately before the altitude
// (green climb / red descent), then speed. Altitude is quantised to 100 ft so the label text (and
// the DOM rebuild it triggers) stays stable while an aircraft drifts.
function targetLine(item, altRound) {
  const parts = [];
  const altFt = item.altBaro ?? item.altGeom;
  const feet = altRound && altFt != null ? Math.round(altFt / 100) * 100 : altFt;
  const alt = item.onGround ? "GND" : feet == null ? "-" : altText(feet);
  const arrow = verticalArrowSymbol(item);
  const arrowHtml = arrow ? `<span class="tt-trend ${verticalTrendClass(item)}">${arrow}</span>` : "";
  parts.push(`<span class="tt-alt">${arrowHtml}${escapeHtml(alt)}</span>`);
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

// Popover close, right of the pin: dismisses just this label (selecting the target again brings
// it back). Handled by the same delegated click listeners.
function closeIcon(hex) {
  return `<span class="tt-close" data-hex="${hex}" title="Close this label">`
    + `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">`
    + `<path d="M6 6l12 12M18 6L6 18"/></svg></span>`;
}

// Tactical data block beside each 3D target: callsign + update age + pin over altitude and speed.
function datablockHtml(item) {
  const age = `<span class="tt-age">${escapeHtml(formatAge(item.observedAt))}</span>`;
  const line = targetLine(item, true);
  return `<span class="t3d-datablock"><span class="db-top"><b>${escapeHtml(formatFlight(item))}</b><span class="tt-top-actions">${age}${pinIcon(item.hex)}${closeIcon(item.hex)}</span></span>`
    + (line ? `<span>${line}</span>` : "") + "</span>";
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

const CHART_HEIGHT = 232;

function destroyHistoryChart(disconnectObserver = false) {
  if (disconnectObserver && chartResizeObserver) {
    chartResizeObserver.disconnect();
    chartResizeObserver = null;
  }
  if (historyChart) {
    historyChart.destroy();
    historyChart = null;
    historyChartMetricsKey = "";
  }
  if (chartCursor.value.show) chartCursor.value = { show: false, x: 0, side: "right", time: "—", rows: [] };
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
  const xValues = selectedTrackSeconds();
  const metrics = activeHistoryMetrics();
  if (!metrics.length || xValues.length < 2) {
    destroyHistoryChart();
    return;
  }

  const points = selectedTrack.value.filter((point) => Number.isFinite(Date.parse(point.positionAt)));
  const availableMetrics = metrics.filter((metric) => points.some((point) => metricChartValue(metric, point) != null));
  if (!availableMetrics.length) {
    destroyHistoryChart();
    return;
  }
  const data = [
    points.map((point) => Date.parse(point.positionAt) / 1000),
    ...availableMetrics.map((metric) => points.map((point) => metricChartValue(metric, point))),
  ];
  const metricsKey = availableMetrics.map((metric) => metric.key).join(",");
  if (historyChart && historyChartMetricsKey === metricsKey) {
    historyChart.setData(data);
    setHistoryChartCursor();
    return;
  }
  destroyHistoryChart();

  const width = Math.max(280, chartEl.value.clientWidth || 360);
  // Padded auto-range: a tiny jitter (±25 ft on a 43,000 ft cruise) must not stretch to the full
  // plot height. The pad never drops below ~2% of the value's magnitude, so a flat series draws
  // as a flat line instead of full-height noise.
  const scales = Object.fromEntries(availableMetrics.map((metric) => [metric.key, {
    auto: true,
    range: (_self, min, max) => {
      if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
      const magnitude = Math.max(Math.abs(min), Math.abs(max), 1e-6);
      const pad = Math.max((max - min) * 0.1, magnitude * 0.02);
      return [min - pad, max + pad];
    },
  }]));
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
  // Tactical instrument styling: the axes use the same mono ramp as every other readout (so the UI
  // scale moves them too), the grid is a dashed accent hairline rather than a grey web, and each
  // series gets a fading fill under the trace so a plot reads as an instrument, not a spreadsheet.
  const rootStyle = getComputedStyle(document.documentElement);
  const mono = rootStyle.getPropertyValue("--mono").trim() || "ui-monospace, monospace";
  const axisFont = `600 12px ${mono}`;
  const gridStroke = "rgb(72 224 209 / 0.13)";
  // 24h ticks, with the day prefixed once the window is longer than a day so a 7 day plot is not a
  // wall of ambiguous HH:MM. uPlot's default formatter renders am/pm, which has no place here.
  const spanHours = (xValues.at(-1) - xValues[0]) / 3600;
  const tickTime = new Intl.DateTimeFormat(undefined, spanHours > 24
    ? { day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }
    : { hour: "2-digit", minute: "2-digit", hour12: false });
  const axes = [
    {
      stroke: "#8fb2ae",
      font: axisFont,
      values: (_self, splits) => splits.map((seconds) => tickTime.format(new Date(seconds * 1000)).replace(",", "")),
      // uPlot sizes tick density from the width its own date rules would need; a custom formatter
      // leaves it guessing and it thins the axis down to a single label. State the width we need.
      space: spanHours > 24 ? 78 : 58,
      ticks: { stroke: "rgb(72 224 209 / 0.32)", size: 4, width: 1 },
      grid: { stroke: gridStroke, width: 1, dash: [2, 4] },
    },
    ...availableMetrics.map((metric, index) => ({
      scale: metric.key,
      side: index % 2 ? 1 : 3,
      stroke: metric.color,
      font: axisFont,
      gap: 4,
      // No fixed size: let uPlot auto-size the gutter to the (now compact) ticks so the
      // numbers aren't clipped.
      values: (_self, splits) => splits.map(compactTick),
      ticks: { stroke: `${metric.color}55`, size: 4, width: 1 },
      grid: { stroke: index === 0 ? gridStroke : "transparent", width: 1, dash: [2, 4] },
    })),
  ];
  // A vertical gradient from the series colour to transparent, drawn under the trace. uPlot can ask
  // for the fill before it has a plotting box (first sizing pass), where a gradient built from a
  // non-finite bbox throws — fall back to a flat wash until the box exists.
  const seriesFill = (color) => (self) => {
    const top = self.bbox?.top;
    const height = self.bbox?.height;
    if (!Number.isFinite(top) || !Number.isFinite(height) || height <= 0) return `${color}1f`;
    const gradient = self.ctx.createLinearGradient(0, top, 0, top + height);
    gradient.addColorStop(0, `${color}2e`);
    gradient.addColorStop(1, `${color}00`);
    return gradient;
  };

  historyChart = new uPlot({
    width,
    height: CHART_HEIGHT,
    tzDate: (ts) => new Date(ts * 1000),
    padding: [10, 4, 0, 4],
    cursor: {
      show: true,
      x: true,
      y: false,
      drag: { x: false, y: false },
      points: { show: false },
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
        fill: seriesFill(metric.color),
        width: 2,
        points: { show: false },
      })),
    ],
    // No uPlot legend: series values ride the cursor tooltip, the strip below keeps only the time.
    legend: { show: false },
    hooks: {
      setCursor: [
        (u) => {
          const idx = u.cursor.idx;
          if (idx == null) {
            if (chartCursor.value.show) chartCursor.value = { ...chartCursor.value, show: false };
            return;
          }
          const rows = availableMetrics.map((metric, i) => {
            const value = u.data[i + 1][idx];
            const unit = metricUnitLabel(metric);
            return {
              key: metric.key,
              label: metric.label,
              color: metric.color,
              value: value == null ? "-" : `${numberFormatter(1).format(value)}${unit ? ` ${unit}` : ""}`,
            };
          });
          // cursor.left is relative to uPlot's PLOTTING AREA; the tooltip is positioned in the
          // wrap. Without the axis-gutter offset the right-side tip covered the cursor line and
          // the left-side tip floated far from it.
          const wrapRect = chartEl.value?.getBoundingClientRect();
          const overRect = u.over?.getBoundingClientRect();
          const gutter = wrapRect && overRect ? overRect.left - wrapRect.left : 0;
          const plotW = u.over?.clientWidth || width;
          const left = Math.max(0, Math.min(u.cursor.left ?? 0, plotW));
          chartCursor.value = {
            // A tooltip belongs to a pointer. Programmatic cursor moves (a live point landing,
            // playback sync) update the time strip but must not pop the tooltip out of nowhere.
            show: Boolean(u.cursor.event),
            x: gutter + left,
            // The tip extends AWAY from the nearer edge, so it can never clip off either side.
            side: left < plotW / 2 ? "right" : "left",
            time: formatStamp(new Date(u.data[0][idx] * 1000)),
            rows,
          };
        },
      ],
    },
  }, data, chartEl.value);
  historyChartMetricsKey = metricsKey;
  setHistoryChartCursor();

  // Keep the chart filling its container as the panel/sidebar is resized.
  chartResizeObserver ??= new ResizeObserver(() => {
    if (!historyChart || !chartEl.value) return;
    const next = Math.max(260, Math.floor(chartEl.value.clientWidth));
    if (next !== historyChart.width) historyChart.setSize({ width: next, height: CHART_HEIGHT });
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

async function fetchJson(url, init = {}) {
  const response = await fetch(url, init);
  if (!response.ok) {
    const error = new Error(`${url} returned ${response.status}`);
    error.status = response.status;
    const retry = Number(response.headers.get("retry-after"));
    error.retryAfterMs = Number.isFinite(retry) ? Math.max(1000, retry * 1000) : null;
    throw error;
  }
  return response.json();
}

// --- On-demand area traffic --------------------------------------------------------------
// The camera's settled viewport is the query; the server proxies a community aggregator and
// caches per area. Display-only data: nothing is stored server-side, so these targets carry no
// history or trails. The upstream area APIs answer a point+radius capped at 250 NM, so a view wider
// than one request still fetches the largest possible circle around its centre.
const AREA_FEED_RADIUS_CAP_NM = 250;
let lastViewArea = null;
let areaFeedBlockedUntil = 0;
let areaFetchSeq = 0;

async function refreshAreaTraffic(area = null) {
  if (area) lastViewArea = area;
  if (!areaFeedConfigured.value || !settings.value.areaFeed) return;
  if (!lastViewArea) {
    if (areaAircraft.value.length) areaAircraft.value = [];
    return;
  }
  if (performance.now() < areaFeedBlockedUntil) return;
  const seq = ++areaFetchSeq;
  try {
    const radius = Math.ceil(Math.min(AREA_FEED_RADIUS_CAP_NM, lastViewArea.radiusNm));
    const query = `lat=${lastViewArea.lat.toFixed(3)}&lon=${lastViewArea.lon.toFixed(3)}&radius=${radius}`;
    const response = await fetch(`/api/area-traffic?${query}`);
    if (response.status === 404) {
      // No aggregator configured server-side: ask again in a while, not on every pass.
      areaFeedBlockedUntil = performance.now() + 5 * 60 * 1000;
      areaFeedOnline.value = false;
      return;
    }
    if (!response.ok) return; // transient upstream failure: keep what we have
    const body = await response.json();
    if (seq !== areaFetchSeq) return; // a newer viewport superseded this answer
    areaAircraft.value = body.aircraft || [];
    areaFeedOnline.value = true;
    areaFeedLastAt.value = body.now || new Date().toISOString();
  } catch { /* transient network failure: keep what we have */ }
}

watch(() => settings.value.areaFeed, (on) => {
  if (!on) {
    // Invalidate any in-flight request too, or its late response would repopulate the list
    // right after the operator switched the feed off.
    areaFetchSeq += 1;
    areaAircraft.value = [];
  } else {
    void refreshAreaTraffic();
  }
});

async function refreshLive() {
  try {
    const live = await fetchJson("/api/live", { cache: "no-store" });
    const configured = live.features?.areaFeed === true;
    if (!configured && areaFeedConfigured.value) {
      areaFetchSeq += 1;
      areaAircraft.value = [];
      areaFeedOnline.value = false;
      areaFeedLastAt.value = null;
    }
    areaFeedConfigured.value = configured;
    // Whoever the operator pointed the feed at is who the credits name.
    areaFeedHost.value = typeof live.features?.areaFeedHost === "string" ? live.features.areaFeedHost : null;
    receiverAircraft.value = live.aircraft || [];
    receivers.value = live.receivers || [];
    void refreshAreaTraffic();
    // "Updated" reflects when a receiver actually last sent data, not our poll time —
    // otherwise it resets to 0 every poll even while the feed is stalled.
    const lastSeen = receivers.value.reduce((max, receiver) => {
      const t = Date.parse(receiver.lastSeenAt);
      return Number.isFinite(t) && t > max ? t : max;
    }, 0);
    lastUpdated.value = lastSeen ? new Date(lastSeen).toISOString() : null;
    status.value = "online";
    trackRefresher.schedule(0);
  } catch (err) {
    status.value = "offline";
    if (err.retryAfterMs) liveRefresher.defer(err.retryAfterMs);
  }
}

// The server worker publishes one complete occupancy snapshot every three minutes. The browser only
// downloads completed immutable snapshots; live ingest events never generate meshes inline.
async function refreshCoverage() {
  try {
    const response = await fetch("/api/coverage", {
      headers: coverageEtag ? { "if-none-match": coverageEtag } : {},
      cache: "no-cache",
    });
    if (response.status === 304) return;
    if (!response.ok) {
      const retry = Number(response.headers.get("retry-after"));
      throw Object.assign(new Error("coverage unavailable"), {
        retryAfterMs: Number.isFinite(retry) ? retry * 1000 : 5000,
      });
    }
    coverageEtag = response.headers.get("etag");
    coverage.value = (await response.json()) || { areas: [], points: [] };
    coverageRetryMs = 5000;
    tac3d?.drawCoverage();
  } catch (err) {
    const delay = Math.min(30000, Math.max(err.retryAfterMs || 5000, coverageRetryMs));
    coverageRetryMs = Math.min(30000, delay * 2);
    clearTimeout(coverageRetryTimer);
    coverageRetryTimer = setTimeout(() => coverageRefresher.schedule(0), delay);
  }
}

// Coalesce bursts of refreshes into a single fetch and never let two run concurrently.
// A short window keeps the live path near-instant; a longer one collapses multi-receiver
// ingests before hitting the expensive coverage query.
function makeCoalescer(fn) {
  let timer = null;
  let inFlight = false;
  let blockedUntil = 0;
  function run() {
    timer = null;
    if (inFlight) {
      schedule(50);
      return;
    }
    inFlight = true;
    Promise.resolve(fn()).catch(() => {}).finally(() => { inFlight = false; });
  }
  function schedule(delay = 250) {
    if (timer != null) return;
    const blockedFor = Math.max(0, blockedUntil - performance.now());
    timer = setTimeout(run, Math.max(delay, blockedFor));
  }
  return {
    schedule,
    defer(delay) {
      blockedUntil = Math.max(blockedUntil, performance.now() + Math.max(0, delay));
      if (timer != null) {
        clearTimeout(timer);
        timer = null;
      }
      schedule(0);
    },
    cancel() {
      if (timer != null) clearTimeout(timer);
      timer = null;
    },
  };
}
const liveRefresher = makeCoalescer(refreshLive);
const coverageRefresher = makeCoalescer(refreshCoverage);
const trackRefresher = makeCoalescer(refreshTracksIncremental);

let historyController;
let bulkController;
let coverageEtag = null;
let coverageRetryMs = 5000;
let coverageRetryTimer;
const pinLimitMessage = ref("");

function rememberArchivePage(key, page) {
  const next = new Map(archivePages.value);
  next.delete(key);
  next.set(key, page);
  while (next.size > MAX_ARCHIVE_PAGES) next.delete(next.keys().next().value);
  archivePages.value = next;
}

function clearHistoryRetry() {
  clearTimeout(historyRetryTimer);
  historyRetryTimer = null;
}

function scheduleHistoryRetry(hex, requestVersion, delay) {
  clearHistoryRetry();
  historyRetryTimer = setTimeout(() => {
    historyRetryTimer = null;
    if (selectedHex.value !== hex || selectedTrackRequestVersion !== requestVersion) return;
    void refreshTrack(false).catch(() => {});
  }, Math.min(30000, Math.max(1000, delay || 2000)));
}

async function fetchHistoryPage(hex, {
  olderCursor = null,
  replace = false,
  requestVersion = selectedTrackRequestVersion,
} = {}) {
  const params = new URLSearchParams({ limit: "5000" });
  if (olderCursor) params.set("olderCursor", olderCursor);
  let result;
  try {
    result = await fetchJson(`/api/aircraft/${hex}/history?${params}`, {
      signal: historyController?.signal,
      cache: "no-store",
    });
  } catch (error) {
    if (error?.name === "AbortError") return null;
    // A busy/restarting server is a normal transient state. Keep the live target usable and retry
    // only the latest page; archive/date actions remain explicit and never form a retry loop.
    if (
      !olderCursor
      && selectedHex.value === hex
      && selectedTrackRequestVersion === requestVersion
      && (error?.status == null || error.status === 429 || error.status === 503)
    ) {
      scheduleHistoryRetry(hex, requestVersion, error.retryAfterMs);
    }
    return null;
  }
  if (requestVersion !== selectedTrackRequestVersion || selectedHex.value !== hex) return null;
  clearHistoryRetry();
  const key = olderCursor || "latest";
  if (replace) archivePages.value = new Map();
  rememberArchivePage(key, { ...result, requestCursor: olderCursor });
  return result;
}

async function refreshTrack(resetPlayback = true) {
  const hex = selectedHex.value;
  if (!hex) return false;
  clearHistoryRetry();
  const requestVersion = ++selectedTrackRequestVersion;
  historyController?.abort();
  historyController = new AbortController();
  historyLoading.value = true;
  try {
    const result = await fetchHistoryPage(hex, { replace: true, requestVersion });
    if (!result) return false;
    if (requestVersion !== selectedTrackRequestVersion || selectedHex.value !== hex) return false;
    selectedTrackRaw.value = (result.points || []).slice(-MAX_LIVE_TRACK_POINTS);
    if (result.liveCursorId == null) trackCursors.delete(hex);
    else trackCursors.set(hex, result.liveCursorId);
    if (resetPlayback) playbackIndex.value = Math.max(0, selectedTrack.value.length - 1);
    renderTrackView();
    return true;
  } finally {
    if (requestVersion === selectedTrackRequestVersion) historyLoading.value = false;
  }
}

async function initializePinnedTrack(hex) {
  const requestVersion = (pinRequestVersions.get(hex) || 0) + 1;
  pinRequestVersions.set(hex, requestVersion);
  pinRequestControllers.get(hex)?.abort();
  const controller = new AbortController();
  pinRequestControllers.set(hex, controller);
  try {
    const result = await fetchJson(`/api/aircraft/${hex}/history?limit=2000`, {
      signal: controller.signal,
      cache: "no-store",
    });
    if (pinRequestVersions.get(hex) !== requestVersion || !pinned.value.has(hex)) return null;
    const next = new Map(pinnedTracks.value);
    next.set(hex, (result.points || []).slice(-MAX_LIVE_TRACK_POINTS));
    pinnedTracks.value = next;
    if (result.liveCursorId == null) trackCursors.delete(hex);
    else trackCursors.set(hex, result.liveCursorId);
    return result;
  } finally {
    if (pinRequestControllers.get(hex) === controller) pinRequestControllers.delete(hex);
  }
}

async function refreshTracksIncremental() {
  const requestVersion = selectedTrackRequestVersion;
  for (const hex of pinned.value) {
    if (!trackCursors.has(hex) && !pinRequestControllers.has(hex)) {
      void initializePinnedTrack(hex).catch(() => {});
    }
  }
  const targets = [...new Set([selectedHex.value, ...pinned.value].filter(Boolean))]
    .filter((hex) => trackCursors.has(hex))
    .map((hex) => ({ hex, afterId: trackCursors.get(hex) }));
  if (!targets.length) return;
  bulkController?.abort();
  bulkController = new AbortController();
  let pending = targets;
  for (let page = 0; page < 3 && pending.length; page += 1) {
    let result;
    try {
      result = await fetchJson("/api/aircraft/tracks", {
        method: "POST",
        signal: bulkController.signal,
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          aircraft: pending,
          detail: pending.some((item) => item.hex === selectedHex.value) ? selectedHex.value : null,
        }),
      });
    } catch (error) {
      if (error.name !== "AbortError") {
        trackRefresher.defer(error.retryAfterMs || 1000);
      }
      return;
    }
    if (requestVersion !== selectedTrackRequestVersion) return;
    const nextPending = [];
    for (const track of result.tracks || []) {
      if (track.hex !== selectedHex.value && !pinned.value.has(track.hex)) continue;
      if (track.resetRequired) {
        if (track.hex === selectedHex.value) void refreshTrack(false).catch(() => {});
        else if (pinned.value.has(track.hex)) void initializePinnedTrack(track.hex).catch(() => {});
        continue;
      }
      trackCursors.set(track.hex, track.cursorId);
      if (track.hex === selectedHex.value) {
        const previousTrack = selectedTrack.value;
        const previousPlaybackIndex = playbackIndex.value;
        selectedTrackRaw.value = mergeTrackPoints(selectedTrackRaw.value, track.points, true)
          .slice(-MAX_LIVE_TRACK_POINTS);
        playbackIndex.value = reconcilePlaybackIndex(
          previousTrack,
          selectedTrack.value,
          previousPlaybackIndex,
        );
      } else {
        const next = new Map(pinnedTracks.value);
        next.set(track.hex, mergeTrackPoints(next.get(track.hex), track.points, true).slice(-MAX_LIVE_TRACK_POINTS));
        pinnedTracks.value = next;
      }
      if (track.hasMore) nextPending.push({ hex: track.hex, afterId: track.cursorId });
    }
    pending = nextPending;
  }
  for (const target of pending) {
    if (target.hex === selectedHex.value) void refreshTrack(false).catch(() => {});
    else void initializePinnedTrack(target.hex).catch(() => {});
  }
  tac3d?.dataPass();
}

async function loadOlderHistory() {
  const page = [...archivePages.value.values()].at(-1);
  if (!selectedHex.value || !page?.hasOlder || !page.olderCursor) return;
  historyLoading.value = true;
  try {
    const result = await fetchHistoryPage(selectedHex.value, {
      olderCursor: page.olderCursor,
      requestVersion: selectedTrackRequestVersion,
    });
    if (!result) return;
    selectedHistoric.value = true;
    playbackIndex.value = 0;
  } finally {
    historyLoading.value = false;
  }
}

async function loadLatestHistory() {
  if (!await refreshTrack(false)) return;
  selectedHistoric.value = true;
  playbackIndex.value = Math.max(0, selectedTrack.value.length - 1);
  renderTrackView();
}

async function togglePin(hex) {
  const next = new Set(pinned.value);
  if (next.has(hex)) {
    next.delete(hex);
    pinRequestVersions.set(hex, (pinRequestVersions.get(hex) || 0) + 1);
    pinRequestControllers.get(hex)?.abort();
    pinRequestControllers.delete(hex);
    const tracks = new Map(pinnedTracks.value);
    tracks.delete(hex);
    pinnedTracks.value = tracks;
    if (hex !== selectedHex.value) trackCursors.delete(hex);
  } else {
    if (next.size >= MAX_PINNED_TRACKS) {
      pinLimitMessage.value = `Up to ${MAX_PINNED_TRACKS} pinned tracks can stay live.`;
      setTimeout(() => { pinLimitMessage.value = ""; }, 4000);
      return;
    }
    next.add(hex);
  }
  pinned.value = next;
  tac3d?.dataPass();
  if (next.has(hex)) {
    try {
      await initializePinnedTrack(hex);
    } catch (error) {
      if (error.name !== "AbortError") {
        pinLimitMessage.value = "Pinned track will retry when live data refreshes.";
        setTimeout(() => { pinLimitMessage.value = ""; }, 4000);
      }
    }
  }
}

function beginAircraftSelection(hex, archived = null) {
  if (!hex || selectedHex.value === hex) return;
  if (selectedAirfield.value) {
    selectedAirfield.value = null;
    tac3d?.clearAirfieldSelection();
  }
  // Invalidate the previous request and erase its points before changing the selected hex. This
  // prevents one render frame from treating aircraft A's final trail point as aircraft B's anchor.
  selectedTrackRequestVersion += 1;
  clearHistoryRetry();
  historyController?.abort();
  bulkController?.abort();
  selectedTrackRaw.value = [];
  archivePages.value = new Map();
  selectedHistoric.value = false;
  playbackIndex.value = 0;
  const hadSelection = Boolean(selectedHex.value);
  // Set before the hex so selectedAircraft never observes an archive hex without its card,
  // which would read as a vanished live target and self-clear the selection.
  archiveSelection.value = archived;
  selectedHex.value = hex;
  // A FIRST selection is an explicit request to read the target, so a dismissed TARGET console
  // comes back. But switching targets while the console was deliberately hidden respects that
  // choice — only the bar's Target toggle reopens it. Phones stay on the map either way: there
  // the lit TGT tab is the affordance, not a sheet sliding over the scene mid-interaction.
  if (!viewportMobile.value && !stations.value.target && !hadSelection) {
    stations.value.target = true;
    saveStations();
  }
  return true;
}

// A phone's TARGET sheet cannot outlive its target: with no selection it has nothing to render,
// so the sheet closes rather than leaving a dead black panel up.
watch(selectedHex, (hex) => {
  if (!hex && mobileStation.value === "target") mobileStation.value = null;
});

// --- Archive search: flights the live picture no longer shows ----------------------------
// The Traffic search box filters live rows as-you-type; the archive lookup behind the same
// text stays an explicit button press, so the history API is only hit deliberately.
const archiveResults = ref([]);
const archiveSearching = ref(false);
const archiveSearched = ref(false);
const archiveQuery = computed(() => {
  const query = search.value.trim();
  return query.length >= 2 && query.length <= 16 ? query : "";
});
watch(search, () => {
  archiveResults.value = [];
  archiveSearched.value = false;
});

async function runArchiveSearch() {
  const query = archiveQuery.value;
  if (!query || archiveSearching.value) return;
  archiveSearching.value = true;
  try {
    const result = await fetchJson(`/api/aircraft/search?q=${encodeURIComponent(query)}`, { cache: "no-store" });
    if (archiveQuery.value !== query) return; // the operator kept typing; results are stale
    // A row without track points has nothing to draw, so it is not offered.
    archiveResults.value = (result.results || []).filter((row) => row.hasTrack);
    archiveSearched.value = true;
  } catch {
    archiveSearched.value = true;
  } finally {
    archiveSearching.value = false;
  }
}

async function selectArchivedAircraft(row) {
  if (!beginAircraftSelection(row.hex, row)) return;
  tac3d?.dataPass();
  // A past flight has no current run; open straight onto the full archived track with the
  // scrubber parked on its final point.
  if (await refreshTrack(false)) {
    selectedHistoric.value = true;
    playbackIndex.value = Math.max(0, selectedTrack.value.length - 1);
    renderTrackView();
  }
}

async function selectAircraft(hex) {
  if (!beginAircraftSelection(hex)) return;
  // Selection alone keeps the camera untouched. If Track is already active, dataPass transfers
  // the existing tracked orbit smoothly to the newly selected aircraft.
  tac3d?.dataPass();
  await refreshTrack();
  await nextTick();
}

function clearSelection() {
  selectedTrackRequestVersion += 1;
  clearHistoryRetry();
  historyController?.abort();
  bulkController?.abort();
  selectedTrackRaw.value = [];
  archivePages.value = new Map();
  selectedHistoric.value = false;
  archiveSelection.value = null;
  if (selectedHex.value && !pinned.value.has(selectedHex.value)) trackCursors.delete(selectedHex.value);
  selectedHex.value = null;
  playbackIndex.value = 0;
  tac3d?.dataPass();
}

// Clicking a target toggles selection; clicking a different one switches to it.
function toggleAircraft(hex) {
  if (selectedHex.value === hex) clearSelection();
  else selectAircraft(hex);
}

// A map or traffic-list double-click is the Track control applied to the target. Selection is made
// first so an existing tracking orbit transfers directly to this aircraft instead of being released.
function trackAircraftFromMap(hex) {
  const item = aircraft.value.find((candidate) => candidate.hex === hex);
  if (!item || item.lat == null || item.lon == null) return;
  const selectionChanged = beginAircraftSelection(hex);
  trackingActive.value = tac3d?.toggleTracking(item.lon, item.lat, item.altBaro ?? item.altGeom) === true;
  tac3d?.dataPass();
  if (selectionChanged) void refreshTrack().catch(() => {});
}

function selectAirfieldFromMap(field) {
  selectedAirfield.value = field || null;
  // Airport selection itself has no camera effect. Clearing an aircraft selection only makes the
  // shared Track icon unambiguously address the airport that was just selected.
  if (field && selectedHex.value) clearSelection();
}

// The settings console dismisses on a true outside CLICK. A camera drag (rotate/pan) that merely
// starts outside must not close it, so the pointer has to come back up within a few pixels of
// where it went down; the console itself and its own toggles are exempt.
let systemsDismissDown = null;
function onGlobalPointerDown(event) {
  // The credits popover is a read-once overlay: any press outside it closes it immediately, with no
  // drag threshold, because nothing inside it is draggable.
  if (creditsOpen.value && !event.target?.closest?.(".map-credits")) creditsOpen.value = false;
  systemsDismissDown = null;
  if (!stationOpen.value.systems) return;
  if (event.target?.closest?.(".station-systems, .cbar-stations, .station-tabs")) return;
  systemsDismissDown = { x: event.clientX, y: event.clientY };
}
// While a click is being consumed to dismiss the settings console, the same click must not ALSO
// reach the map as "empty click" and clear the selection — one click, one action.
let suppressMapDeselectUntil = 0;
function onGlobalPointerUp(event) {
  if (!systemsDismissDown) return;
  const moved = Math.hypot(event.clientX - systemsDismissDown.x, event.clientY - systemsDismissDown.y) > 6;
  systemsDismissDown = null;
  if (!moved && stationOpen.value.systems) {
    toggleStation("systems");
    suppressMapDeselectUntil = performance.now() + 300;
  }
}

// Escape unwinds the deepest layer first: the credits popover, then the settings console, then the
// selection.
function onGlobalKeydown(event) {
  if (event.key !== "Escape") return;
  if (creditsOpen.value) {
    creditsOpen.value = false;
    return;
  }
  if (stationOpen.value.systems) {
    toggleStation("systems");
    return;
  }
  if (selectedHex.value) clearSelection();
}

function browserLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error("Browser geolocation is unavailable")); return; }
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => resolve({
        lat: coords.latitude,
        lon: coords.longitude,
        // GNSS height when the device provides one (phones with a fix; null on WiFi/IP
        // location). A fix whose own vertical accuracy is worse than 100 m says nothing
        // useful about height, so it degrades to a ground-level fix.
        altitudeM: Number.isFinite(coords.altitude)
          && (coords.altitudeAccuracy == null || coords.altitudeAccuracy <= 100)
          ? coords.altitude
          : null,
      }),
      reject,
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 },
    );
  });
}

// With a selected aircraft this is the tracking toggle. Without one, locate the browser's
// current position after the normal browser permission prompt.
async function recenterView() {
  const airfield = selectedAirfield.value;
  if (airfield) {
    trackingActive.value = tac3d?.toggleAirfieldTracking(airfield) === true;
    return;
  }
  const sel = selectedAircraft.value;
  const hasSel = sel && sel.lat != null && sel.lon != null;
  if (hasSel) {
    trackingActive.value = tac3d?.toggleTracking(sel.lon, sel.lat, sel.altBaro ?? sel.altGeom) === true;
    return;
  }
  trackingActive.value = false;
  try {
    const here = await browserLocation();
    tac3d?.setObserver(here); // pin the own-position marker even if a selection grabbed focus
    if (selectedHex.value) return; // selection changed while waiting for the permission/location fix
    tac3d?.locateBrowser(here.lon, here.lat);
  } catch (error) {
    console.warn("Unable to locate browser position", error);
  }
}

// Playback ghost for the 3D view — only shown while scrubbed off the live edge.
function getPlaybackGhost() {
  if (!selectedTrack.value.length) return null;
  const latestIndex = selectedTrack.value.length - 1;
  if (playbackIndex.value >= latestIndex) return null;
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
        getSite: () => siteRef.value,
        getPinned: () => pinned.value,
        getPinnedTracks: () => pinnedTrackList.value,
        togglePin,
        datablockHtml,
        airfieldTooltip,
        passesFilters,
        isDropped,
        isCoasting,
        coastOpacity,
        altitudeColor,
        trackSegmentColor,
        planeSizeScale,
        planeMeshKind,
        onSelect: toggleAircraft,
        onTrackAircraft: trackAircraftFromMap,
        onAirfieldSelection: selectAirfieldFromMap,
        onHover: (hex) => { hoveredHex.value = hex; },
        onTrackingChange: (active) => { trackingActive.value = active; },
        onCameraChange: (bearing, pitch) => { mapBearing.value = bearing; mapPitch.value = pitch; },
        onViewSettled: (area) => { void refreshAreaTraffic(area); },
        onMapClick: () => {
          if (performance.now() < suppressMapDeselectUntil) return; // this click closed the settings console
          if (selectedHex.value) clearSelection();
        },
      },
    });
    return tac3d;
  });
  return tac3dPromise;
}

const FILTER_KEYS = ["showGround", "showNonIcao", "source", "altMin", "altMax", "speedMin", "speedMax", "maxRange"];

function resetFilters() {
  for (const key of FILTER_KEYS) settings.value[key] = DEFAULT_SETTINGS[key];
}

// --- Settings management (operator deployment) -----------------------------------------------
// A configuration can be reset, written to a file, and read back on another browser, so a site's
// display setup is reproducible instead of living only in one machine's localStorage.
const unitPreset = computed(() => {
  const match = Object.entries(UNIT_PRESETS).find(([, preset]) => Object
    .entries(preset)
    .every(([key, value]) => settings.value[key] === value));
  return match ? match[0] : "custom";
});

function applyUnitPreset(name) {
  const preset = UNIT_PRESETS[name] || UNIT_PRESETS.aero;
  // A preset states the full altitude display, so it also leaves flight-level notation.
  settings.value.flightLevels = false;
  setAltitudeUnit(preset.unitAltitude);
  setSpeedUnit(preset.unitSpeed);
  setDistanceUnit(preset.unitDistance);
  settings.value.unitTemperature = preset.unitTemperature;
}

function resetSettings() {
  settings.value = normalizeSettings({});
}

const settingsFileEl = ref(null);
const importError = ref(null);
let importErrorTimer;

function exportSettings() {
  const payload = JSON.stringify({ app: "skytrace", settings: SETTINGS_KEY, values: settings.value }, null, 2);
  const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "skytrace-settings.json";
  link.click();
  URL.revokeObjectURL(url);
}

async function importSettings(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  try {
    if (file.size > MAX_SETTINGS_IMPORT_BYTES) throw new Error("settings file is too large");
    const parsed = JSON.parse(await file.text());
    if (
      !parsed
      || parsed.app !== "skytrace"
      || parsed.settings !== SETTINGS_KEY
      || !parsed.values
      || typeof parsed.values !== "object"
      || Array.isArray(parsed.values)
      || Object.keys(parsed).some((key) => !["app", "settings", "values"].includes(key))
    ) throw new Error("not a Skytrace settings file");
    const values = parsed.values;
    if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error("not a settings object");
    // An arbitrary JSON object would "import" as every default — a destructive no-op reported as
    // success. Recognising at least one known key is what separates a settings file from noise.
    if (!Object.keys(DEFAULT_SETTINGS).some((key) => Object.hasOwn(values, key))) {
      throw new Error("no recognised settings keys");
    }
    settings.value = normalizeSettings(values);
    importError.value = null;
  } catch (error) {
    console.error(error);
    // Failure needs to be SAID — but as an overlay toast, never as text that reshapes the card.
    importError.value = "Import failed — not a Skytrace settings file";
    clearTimeout(importErrorTimer);
    importErrorTimer = setTimeout(() => { importError.value = null; }, 5000);
  }
}

watch(aircraft, () => {
  scheduleNextTargetTransition();
  tac3d?.dataPass();
});
watch(transitionEpoch, () => {
  // Coast/drop boundaries are the only wall-clock changes that alter rendered target membership.
  // Rebuild once at those exact transitions; the one-second clock below only refreshes age text.
  tac3d?.dataPass();
});
watch(searchQuery, () => {
  tac3d?.dataPass();
});
watch(hoveredHex, (next) => {
  tac3d?.setHoverClass(next);
});
watch(selectedHistoryMetrics, () => queueHistoryChartRender(), { deep: true });
watch(selectedTrack, () => queueHistoryChartRender());
watch(playbackIndex, () => {
  renderTrackView();
  setHistoryChartCursor();
});

onMounted(async () => {
  window.addEventListener("keydown", onGlobalKeydown);
  window.addEventListener("resize", onViewportChange);
  window.addEventListener("pointerdown", onGlobalPointerDown, true);
  window.addEventListener("pointerup", onGlobalPointerUp, true);
  await ensureTactical3d();
  tac3d.applySettings();
  tac3d.setViewPadding(viewInsets.value);
  await refreshLive();
  await refreshCoverage();
  // Fallback polls in case the SSE stream drops. Coverage remains an independent
  // three-minute worker snapshot.
  startRefreshTimer();
  coverageTimer = setInterval(() => coverageRefresher.schedule(0), 180000);
  clockTimer = setInterval(() => {
    wallNow = Date.now();
    refreshAgeNodes();
    tac3d?.clockPass();
  }, 1000);
  connectEvents();
});

// Fallback poll when the SSE stream is down; the stream itself is the fast path.
const REFRESH_MS = 10000;
function startRefreshTimer() {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => liveRefresher.schedule(0), REFRESH_MS);
}

function connectEvents() {
  eventStream?.stop();
  // Fetch streaming gives us the same SSE semantics without native EventSource's unavoidable
  // browser-console network errors during a server restart. It also honours Retry-After on 503.
  eventStream = createEventStream({
    url: "/api/events",
    onOpen: () => liveRefresher.schedule(0),
    onEvent: ({ event }) => {
      if (event === "ingest") liveRefresher.schedule();
    },
    onDisconnect: () => { status.value = "reconnecting"; },
  });
  eventStream.start();
}

onUnmounted(() => {
  clearTimeout(importErrorTimer);
  clearInterval(refreshTimer);
  clearInterval(coverageTimer);
  clearInterval(clockTimer);
  clearTimeout(transitionTimer);
  clearTimeout(coverageRetryTimer);
  clearHistoryRetry();
  historyController?.abort();
  bulkController?.abort();
  for (const controller of pinRequestControllers.values()) controller.abort();
  pinRequestControllers.clear();
  liveRefresher.cancel();
  coverageRefresher.cancel();
  trackRefresher.cancel();
  destroyHistoryChart(true);
  window.removeEventListener("keydown", onGlobalKeydown);
  window.removeEventListener("resize", onViewportChange);
  window.removeEventListener("pointerdown", onGlobalPointerDown, true);
  window.removeEventListener("pointerup", onGlobalPointerUp, true);
  eventStream?.stop();
  tac3d?.destroy();
  tac3d = null;
});
</script>

<template>
  <main class="shell">
    <!-- Command bar: identity + link LED on the left; alert chips (only while something is wrong)
         and the console toggles on the right. Live counts live in the Settings console. -->
    <header :class="['cbar', { alarm: hudCounts.emergency || conflicts.length }]">
      <div class="cbar-ident">
        <span :class="['led', linkState.level]" :title="linkState.label"></span>
        <span class="cbar-mark">SKYTRACE</span>
        <!-- The one outbound link on the board. The mark is inlined because @lucide/vue v1 dropped
             its brand icons. -->
        <a
          class="cbar-repo"
          href="https://github.com/luftaquila/skytrace"
          target="_blank"
          rel="noopener noreferrer"
          title="Open the Skytrace repository on GitHub"
          aria-label="Open the Skytrace repository on GitHub"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
            <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
          </svg>
        </a>
      </div>
      <div class="cbar-spacer"></div>
      <div v-if="hudAlerts.length" class="cbar-alerts cbar-wide">
        <span v-for="alert in hudAlerts" :key="alert.label" :class="['alert-chip', alert.level]">
          {{ alert.label }} <b>×{{ alert.count }}</b>
        </span>
      </div>
      <nav class="cbar-stations cbar-wide" aria-label="Consoles">
        <button
          type="button"
          :class="{ open: stationOpen.target && selectedAircraft, avail: Boolean(selectedAircraft) }"
          :disabled="!selectedAircraft"
          :title="selectedAircraft ? 'Toggle the target console' : 'Select a target first'"
          @click="toggleStation('target')"
        ><Crosshair :size="15" /><span>Target</span></button>
        <button type="button" :class="{ open: stationOpen.traffic }" title="Toggle the traffic console" @click="toggleStation('traffic')">
          <Radar :size="15" /><span>Traffic</span>
        </button>
        <button type="button" :class="{ open: stationOpen.systems }" title="Toggle the settings console" @click="toggleStation('systems')">
          <SlidersHorizontal :size="15" /><span>Settings</span>
        </button>
      </nav>
    </header>

    <section class="map-stage">
      <div ref="map3dEl" class="map map-3d"></div>

      <!-- Phone condition strip: exists only while something is wrong, centred under the bar.
           A desktop shows the same chips on the command bar instead. -->
      <div v-if="hudAlerts.length" class="alert-strip" aria-live="polite">
        <span v-for="alert in hudAlerts" :key="alert.label" :class="['alert-chip', alert.level]">
          {{ alert.label }} <b>×{{ alert.count }}</b>
        </span>
      </div>

      <!-- TARGET station: everything about the selected aircraft. Closing it is deselecting;
           the TGT toggle just hides the console while keeping the selection. -->
      <aside v-if="selectedAircraft && stationOpen.target" class="station station-target">
        <header class="station-head">
          <span class="station-tag">Target</span>
          <span class="station-id">{{ formatFlight(selectedAircraft) }}</span>
          <span class="station-spacer"></span>
          <button
            type="button"
            :class="['station-act', { on: pinned.has(selectedAircraft.hex) }]"
            :title="pinned.has(selectedAircraft.hex) ? 'Unpin label & track' : 'Pin label & track'"
            @click="togglePin(selectedAircraft.hex)"
          >
            <Pin :size="14" />
          </button>
          <!-- X hides the console only (same as the bar's Target toggle): the selection and an
               active track survive. Deselecting stays on Escape / an empty-map click. -->
          <button type="button" class="station-act" title="Hide the target console" @click="toggleStation('target')"><X :size="15" /></button>
        </header>
        <!-- Full-width identity line: the head was ellipsising this next to the callsign. -->
        <div class="station-sub">T+<span v-age="selectedAircraft.observedAt"></span> · {{ selectedAircraft.hex.toUpperCase() }} · {{ sourceLabel(selectedAircraft) }}</div>

        <div class="station-body">
            <div v-if="selectedAlert" :class="['target-alert', selectedAlert.level]">
              <span>{{ selectedAlert.label }}</span>
              <span v-if="selectedAlert.code" class="target-alert-code">{{ selectedAlert.code }}</span>
            </div>

            <dl class="target-grid">
              <div class="target-metric" :class="detailMetricClass('altBaro')" @click="toggleHistoryMetrics('altBaro')"><dt>Baro Alt</dt><dd>{{ formatAltitude(selectedAircraft, "baro") }}</dd></div>
              <div class="target-metric" :class="detailMetricClass('altGeom')" @click="toggleHistoryMetrics('altGeom')"><dt>Geom Alt</dt><dd>{{ formatAltitude(selectedAircraft, "geom") }}</dd></div>
              <div class="target-metric" :class="detailMetricClass('gs')" @click="toggleHistoryMetrics('gs')"><dt>Ground Speed</dt><dd>{{ formatSpeed(selectedAircraft) }}</dd></div>
              <div class="target-metric" :class="detailMetricClass(['ias', 'tas'])" @click="toggleHistoryMetrics(['ias', 'tas'])"><dt>IAS / TAS</dt><dd>{{ formatSpeed(selectedAircraft, "ias") }} / {{ formatSpeed(selectedAircraft, "tas") }}</dd></div>
              <div class="target-metric" :class="detailMetricClass('mach')" @click="toggleHistoryMetrics('mach')"><dt>Mach</dt><dd>{{ selectedAircraft.mach == null ? "-" : selectedAircraft.mach.toFixed(3) }}</dd></div>
              <div class="target-metric" :class="detailMetricClass('verticalRate')" @click="toggleHistoryMetrics('verticalRate')"><dt>Vert Rate</dt><dd>{{ formatRate(selectedAircraft.baroRate ?? selectedAircraft.geomRate) }}</dd></div>
              <div class="target-metric" :class="detailMetricClass('track')" @click="toggleHistoryMetrics('track')"><dt>Track</dt><dd>{{ formatDegrees(selectedAircraft.track) }}</dd></div>
              <div class="target-metric" :class="detailMetricClass('heading')" @click="toggleHistoryMetrics('heading')"><dt>Heading</dt><dd>{{ formatDegrees(selectedAircraft.trueHeading ?? selectedAircraft.magHeading) }}</dd></div>
              <div><dt>Squawk</dt><dd>{{ selectedAircraft.squawk || "-" }}</dd></div>
              <div class="target-metric" :class="detailMetricClass('rssi')" @click="toggleHistoryMetrics('rssi')"><dt>RSSI</dt><dd>{{ selectedAircraft.rssi == null ? "-" : `${selectedAircraft.rssi.toFixed(1)} dBFS` }}</dd></div>
              <div class="target-metric" :class="detailMetricClass('messages')" @click="toggleHistoryMetrics('messages')"><dt>Messages</dt><dd>{{ selectedAircraft.messages ?? "-" }}</dd></div>
              <div><dt>Receivers</dt><dd>{{ selectedAircraft.receiverCount }}</dd></div>
              <div class="target-metric" :class="detailMetricClass('windSpeed')" @click="toggleHistoryMetrics('windSpeed')"><dt>Wind</dt><dd>{{ selectedAircraft.windSpeed == null ? "-" : `${formatSpeed({ gs: selectedAircraft.windSpeed })} @ ${formatDegrees(selectedAircraft.windDirection)}` }}</dd></div>
              <div class="target-metric" :class="detailMetricClass(['oat', 'tat'])" @click="toggleHistoryMetrics(['oat', 'tat'])"><dt>Temp</dt><dd>{{ formatTemp(selectedAircraft.oat) }} / {{ formatTemp(selectedAircraft.tat) }}</dd></div>
              <div><dt>Selected Alt</dt><dd>{{ altText(selectedAircraft.navAltitudeMcp ?? selectedAircraft.navAltitudeFms) }}</dd></div>
              <div><dt>Range</dt><dd>{{ selectedRange }}</dd></div>
              <div class="target-wide"><dt>Accuracy</dt><dd>NACp {{ selectedAircraft.nacP ?? "-" }} · SIL {{ selectedAircraft.sil ?? "-" }} · RC {{ selectedAircraft.rc ?? "-" }}</dd></div>
            </dl>

            <div class="history-panel">
              <div class="history-options">
                <label class="select-row">
                  <span>Track</span>
                  <select v-model="trackScope">
                    <option value="current">Current flight</option>
                    <option value="full">Full history</option>
                  </select>
                </label>
                <button
                  v-if="selectedHistoric && oldestArchivePage?.hasOlder"
                  type="button"
                  :disabled="historyLoading"
                  @click="loadOlderHistory"
                >
                  {{ historyLoading ? "Loading…" : "Older page" }}
                </button>
                <button
                  v-if="selectedHistoric && !hasLatestArchivePage"
                  type="button"
                  :disabled="historyLoading"
                  @click="loadLatestHistory"
                >
                  Latest page
                </button>
                <small v-if="pinLimitMessage">{{ pinLimitMessage }}</small>
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
                <div v-show="chartCursor.show && chartCursor.rows.length" :class="['chart-tip', `side-${chartCursor.side}`]" :style="{ left: `${chartCursor.x}px` }">
                  <div v-for="row in chartCursor.rows" :key="row.key" class="chart-tip-row">
                    <span><i :style="{ background: row.color }"></i>{{ row.label }}</span><b>{{ row.value }}</b>
                  </div>
                </div>
                <div v-if="!selectedHistoryMetrics.length || selectedTrack.length < 2" class="history-empty">
                  No graph series
                </div>
              </div>
              <div class="chart-time">{{ chartCursor.time }}</div>

              <input v-if="selectedTrack.length" v-model.number="playbackIndex" type="range" min="0" :max="Math.max(0, selectedTrack.length - 1)" step="1" />
              <div class="history-meta">
                <span>{{ selectedTrack.length }} points</span>
                <span>{{ selectedHistoryPoint ? formatStamp(selectedHistoryPoint.positionAt) : "-" }}</span>
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
                      <!-- Keyed on the point's own identity, never the array index: indices shift
                           every time a live point lands, which rebuilt all rows and threw away the
                           operator's scroll position. -->
                      <tr
                        v-for="row in tracklogRows"
                        :key="row.point.positionAt || row.index"
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
        </div>
      </aside>

      <!-- TRAFFIC station: the whole filtered picture — search, sort, and one row per target. -->
      <aside v-show="stationOpen.traffic" class="station station-traffic">
        <header class="station-head">
          <span class="station-tag">Traffic</span>
          <span class="station-count">{{ filteredAircraft.length }}<i v-if="hudCounts.tracked > filteredAircraft.length">/{{ hudCounts.tracked }}</i></span>
          <span class="station-meta">T+<span v-age="lastUpdated"></span></span>
          <select v-model="sortKey" class="station-select" title="Sort order">
            <option value="callsign">CALLSIGN</option>
            <option value="altitude">ALTITUDE</option>
            <option value="speed">SPEED</option>
            <option value="recent">RECENT</option>
          </select>
          <button type="button" class="station-act" title="Close the traffic console" @click="toggleStation('traffic')"><X :size="15" /></button>
        </header>
        <div class="station-search">
          <Search :size="15" />
          <input v-model="search" type="search" placeholder="HEX / CALLSIGN / SQUAWK / SOURCE" />
          <button v-if="search" type="button" class="station-search-clear" title="Clear search" aria-label="Clear search" @click="search = ''">
            <X :size="15" />
          </button>
        </div>
        <div class="station-body station-body-flush">
            <button
              v-for="item in filteredAircraft"
              :key="item.hex"
              :class="['target-row', aircraftAlertClass(item), { active: selectedHex === item.hex, hovered: hoveredHex === item.hex, coasting: isCoasting(item) }]"
              @click="selectAircraft(item.hex)"
              @dblclick.stop="trackAircraftFromMap(item.hex)"
              @mouseenter="setHover(item.hex)"
              @mouseleave="clearHover(item.hex)"
            >
              <span class="row-bar" :style="{ background: altitudeColor(item) }"></span>
              <span class="row-id">
                <strong>{{ formatFlight(item) }}</strong>
                <small>{{ item.hex.toUpperCase() }} · {{ sourceLabel(item) }}</small>
              </span>
              <span class="row-num">
                <strong>
                  <i v-if="verticalArrowSymbol(item)" :class="['row-trend', verticalTrendClass(item)]">{{ verticalArrowSymbol(item) }}</i>{{ formatAltitude(item) }}
                </strong>
                <small>{{ formatSpeed(item) }} · <span v-age="item.observedAt"></span></small>
              </span>
            </button>
            <div v-if="!filteredAircraft.length" class="block-empty">No targets match the active filters</div>

            <!-- Archive: the same query against flights that already left the live picture.
                 The entry point stays visible with an empty box — a hidden feature is no
                 feature — but the lookup itself is an explicit press, never as-you-type. -->
            <div class="archive-block">
              <button type="button" class="archive-run" :disabled="archiveSearching || !archiveQuery" @click="runArchiveSearch">
                <Search :size="13" />
                {{ archiveSearching ? "Searching the archive…"
                  : archiveQuery ? `Search past flights for “${archiveQuery}”`
                  : "Past flights: type 2+ characters to search the archive" }}
              </button>
              <button
                v-for="row in archiveResults"
                :key="`arch-${row.hex}`"
                :class="['target-row', 'archive-row', { active: selectedHex === row.hex }]"
                @click="selectArchivedAircraft(row)"
              >
                <span class="row-bar archive-bar"></span>
                <span class="row-id">
                  <strong>{{ row.flight || row.hex.toUpperCase() }}</strong>
                  <small>{{ row.hex.toUpperCase() }} · ARCHIVE</small>
                </span>
                <span class="row-num">
                  <strong>T-<span v-age="row.lastSeenAt"></span></strong>
                  <small v-if="row.firstSeenAt">since {{ formatStamp(row.firstSeenAt) }}</small>
                </span>
              </button>
              <div v-if="archiveSearched && !archiveResults.length" class="block-empty">No archived flights match</div>
            </div>
        </div>
      </aside>

      <!-- SETTINGS station: the operator's configuration console. -->
      <aside v-show="stationOpen.systems" class="station station-systems">
        <header class="station-head">
          <span class="station-tag">Settings</span>
          <span class="station-spacer"></span>
          <button type="button" class="station-act" title="Close the settings console" @click="toggleStation('systems')"><X :size="15" /></button>
        </header>
        <!-- The scroll container and the multicol element must be different boxes: a multicol with
             the scroller's fixed height pushes overflow into unreachable horizontal columns. -->
        <div class="station-body station-body-flush">
          <div class="console-columns">
          <section class="cblock" :class="{ collapsed: cardCollapsed('status') }">
            <header role="button" tabindex="0" :aria-expanded="!cardCollapsed('status')" @click="toggleCard('status')" @keydown.enter.prevent="toggleCard('status')" @keydown.space.prevent="toggleCard('status')"><Activity :size="15" /><span>Status</span><ChevronDown :size="14" class="cblock-caret" /></header>
            <dl class="target-grid status-grid">
              <div><dt>Tracked</dt><dd>{{ hudCounts.tracked }}</dd></div>
              <div><dt>Airborne</dt><dd>{{ hudCounts.airborne }}</dd></div>
              <div><dt>On ground</dt><dd>{{ hudCounts.ground }}</dd></div>
              <div><dt>Feed total</dt><dd>{{ hudCounts.total }}</dd></div>
              <div><dt>Receivers</dt><dd>{{ receiverStatus.online }}/{{ receiverStatus.total }}</dd></div>
              <div><dt>Updated</dt><dd><span v-age="lastUpdated"></span></dd></div>
            </dl>
            <div v-if="sourceChips.length" class="source-chips">
              <span v-for="chip in sourceChips" :key="chip.key" class="source-chip">{{ chip.label }} <b>{{ chip.count }}</b></span>
            </div>
          </section>

          <section class="cblock" :class="{ collapsed: cardCollapsed('receivers') }">
            <header role="button" tabindex="0" :aria-expanded="!cardCollapsed('receivers')" @click="toggleCard('receivers')" @keydown.enter.prevent="toggleCard('receivers')" @keydown.space.prevent="toggleCard('receivers')"><RadioTower :size="15" /><span>Receivers</span><small>{{ receiverStatus.online }}/{{ receiverStatus.total }} online</small><ChevronDown :size="14" class="cblock-caret" /></header>
            <div v-for="row in receiverRows" :key="row.id" :class="['rx-row', { off: !row.online }]">
              <span :class="['receiver-light', { on: row.online }]"></span>
              <div class="rx-id">
                <strong>{{ row.name }}</strong>
                <small>{{ row.aircraft }} aircraft · <span v-age="row.lastSeenAt"></span></small>
              </div>
              <button
                type="button"
                :class="['rx-act', { on: row.virtual ? settings.areaFeed : receiverTrafficVisible(row.id) }]"
                :title="(row.virtual ? settings.areaFeed : receiverTrafficVisible(row.id)) ? `Hide ${row.name} traffic` : `Show ${row.name} traffic`"
                :aria-label="`Toggle ${row.name} traffic`"
                @click="row.virtual ? (settings.areaFeed = !settings.areaFeed) : toggleReceiverTraffic(row.id)"
              >
                <Eye :size="15" />
              </button>
              <button
                type="button"
                class="rx-act"
                :disabled="!row.center"
                :title="row.center ? `Centre the view on ${row.name} reception` : 'No coverage snapshot for this receiver yet'"
                :aria-label="`Centre the view on ${row.name} reception`"
                @click="focusReceiver(row)"
              >
                <LocateFixed :size="15" />
              </button>
              <button
                type="button"
                :class="['rx-act', { on: row.center && ringsVisible(row.name) }]"
                :disabled="!row.center"
                :title="ringsVisible(row.name) ? `Hide ${row.name} range rings` : `Show ${row.name} range rings`"
                :aria-label="`Toggle ${row.name} range rings`"
                @click="toggleRingsReceiver(row.name)"
              >
                <Target :size="15" />
              </button>
              <button
                type="button"
                :class="['rx-act', { on: row.hasCoverage && coverageVisible(row.name) }]"
                :disabled="!row.hasCoverage"
                :title="coverageVisible(row.name) ? `Hide ${row.name} coverage dome` : `Show ${row.name} coverage dome`"
                :aria-label="`Toggle ${row.name} coverage dome`"
                @click="toggleCoverageReceiver(row.name)"
              >
                <Layers :size="15" />
              </button>
            </div>
            <div v-if="!receiverRows.length" class="block-empty">
              No receivers reporting yet — connect a feeder to this server to see traffic.
            </div>
          </section>

          <section class="cblock" :class="{ collapsed: cardCollapsed('filters') }">
            <header role="button" tabindex="0" :aria-expanded="!cardCollapsed('filters')" @click="toggleCard('filters')" @keydown.enter.prevent="toggleCard('filters')" @keydown.space.prevent="toggleCard('filters')"><Filter :size="15" /><span>Filters</span><button type="button" class="cblock-reset" @click.stop="resetFilters">Reset</button><ChevronDown :size="14" class="cblock-caret" /></header>
            <div class="control-grid">
              <label><span>Source</span><select v-model="settings.source"><option v-for="source in sourceOptions" :key="source" :value="source">{{ source === "all" ? "All" : sourceLabel({ sourceKind: source }) }}</option></select></label>
              <label><span>Min altitude</span><span class="unit-input"><input v-model="settings.altMin" inputmode="numeric" /><i>{{ altitudeUnit.label }}</i></span></label>
              <label><span>Max altitude</span><span class="unit-input"><input v-model="settings.altMax" inputmode="numeric" /><i>{{ altitudeUnit.label }}</i></span></label>
              <label><span>Min speed</span><span class="unit-input"><input v-model="settings.speedMin" inputmode="numeric" /><i>{{ speedUnit.label }}</i></span></label>
              <label><span>Max speed</span><span class="unit-input"><input v-model="settings.speedMax" inputmode="numeric" /><i>{{ speedUnit.label }}</i></span></label>
              <label><span>Max range</span><span class="unit-input"><input v-model="settings.maxRange" inputmode="numeric" /><i>{{ distanceUnit }}</i></span></label>
            </div>
            <div class="toggle-row">
              <label><input v-model="settings.showGround" type="checkbox" /> Ground</label>
              <label><input v-model="settings.showNonIcao" type="checkbox" /> Non-ICAO</label>
            </div>
          </section>

          <section class="cblock" :class="{ collapsed: cardCollapsed('units') }">
            <header role="button" tabindex="0" :aria-expanded="!cardCollapsed('units')" @click="toggleCard('units')" @keydown.enter.prevent="toggleCard('units')" @keydown.space.prevent="toggleCard('units')"><Gauge :size="15" /><span>Units</span><ChevronDown :size="14" class="cblock-caret" /></header>
            <div class="cov-actions">
              <button type="button" :class="{ active: unitPreset === 'aero' }" @click="applyUnitPreset('aero')">Aeronautical</button>
              <button type="button" :class="{ active: unitPreset === 'metric' }" @click="applyUnitPreset('metric')">Metric</button>
              <button type="button" :class="{ active: unitPreset === 'imperial' }" @click="applyUnitPreset('imperial')">Imperial</button>
            </div>
            <div class="control-grid control-grid-4">
              <label><span>Altitude</span><select v-model="unitAltitudeModel"><option value="ft">ft</option><option value="m">m</option><option value="fl">FL</option></select></label>
              <label><span>Speed</span><select v-model="unitSpeedModel"><option value="kt">kts</option><option value="kmh">km/h</option><option value="mph">mph</option></select></label>
              <label><span>Distance</span><select v-model="unitDistanceModel"><option value="nm">NM</option><option value="km">km</option><option value="mi">mi</option></select></label>
              <label><span>Temp</span><select v-model="settings.unitTemperature"><option value="c">°C</option><option value="f">°F</option></select></label>
            </div>
          </section>

          <section class="cblock" :class="{ collapsed: cardCollapsed('display') }">
            <header role="button" tabindex="0" :aria-expanded="!cardCollapsed('display')" @click="toggleCard('display')" @keydown.enter.prevent="toggleCard('display')" @keydown.space.prevent="toggleCard('display')"><Settings :size="15" /><span>Display</span><ChevronDown :size="14" class="cblock-caret" /></header>
            <div class="csub">Airplanes</div>
            <div class="slider-list">
              <label class="slider-row"><span>Icon size<b>×{{ Number(settings.aircraftScale).toFixed(1) }}</b></span><input v-model.number="settings.aircraftScale" type="range" min="0.5" max="2.5" step="0.1" /></label>
              <label class="slider-row"><span>Altitude scale<b>×{{ Number(settings.altitudeExaggeration).toFixed(1) }}</b></span><input v-model.number="settings.altitudeExaggeration" type="range" min="1" max="10" step="0.5" /></label>
              <label class="slider-row"><span>Climb pitch<b>×{{ Number(settings.aircraftPitchExaggeration).toFixed(1) }}</b></span><input v-model.number="settings.aircraftPitchExaggeration" type="range" min="1" max="5" step="0.5" /></label>
              <label class="slider-row"><span>Bank angle<b>×{{ Number(settings.aircraftRollExaggeration).toFixed(1) }}</b></span><input v-model.number="settings.aircraftRollExaggeration" type="range" min="1" max="5" step="0.5" /></label>
            </div>
            <div class="csub">Base map</div>
            <div class="slider-list">
              <label class="slider-row"><span>Terrain relief<b>×{{ Number(settings.terrainExaggeration).toFixed(1) }}</b></span><input v-model.number="settings.terrainExaggeration" type="range" min="1" max="5" step="0.5" /></label>
              <label class="slider-row"><span>Brightness<b>×{{ Number(settings.imageryBrightness).toFixed(1) }}</b></span><input v-model.number="settings.imageryBrightness" type="range" min="0.4" max="1.2" step="0.1" /></label>
              <label class="slider-row"><span>Coverage dome opacity<b>{{ Math.round(settings.coverageOpacity * 100) }}%</b></span><input v-model.number="settings.coverageOpacity" type="range" min="0" max="0.8" step="0.05" /></label>
            </div>
            <div class="toggle-row">
              <label class="toggle-full"><input v-model="settings.mapReferenceLabels" type="checkbox" /> Boundaries &amp; place labels</label>
              <label><input v-model="settings.airfields" type="checkbox" /> Airfields</label>
              <label><input v-model="settings.airfieldsMinor" type="checkbox" :disabled="!settings.airfields" /> Minor fields</label>
            </div>
            <!-- On/off lives with each receiver (Receivers card); only the ring geometry is here. -->
            <div class="csub">Range rings</div>
            <div class="toggle-row">
              <label><input v-model="settings.ringCompass" type="checkbox" /> Cardinal marks</label>
            </div>
            <div class="control-grid">
              <label><span>Spacing</span><span class="unit-input"><input v-model.number="settings.ringSpacing" type="number" min="5" max="1000" step="5" /><i>{{ ringUnitLabel }}</i></span></label>
              <label><span>Rings</span><input v-model.number="settings.ringCount" type="number" min="1" max="8" step="1" /></label>
              <label><span>Unit</span><select v-model="settings.ringUnit"><option value="nm">NM</option><option value="km">km</option><option value="mi">miles</option></select></label>
            </div>
            <div class="csub">Stale targets</div>
            <div class="toggle-row">
              <label><input v-model="settings.coastDrop" type="checkbox" /> Coast / drop stale targets</label>
            </div>
            <div class="control-grid control-grid-2">
              <label><span>Coast after</span><span class="unit-input"><input v-model.number="settings.coastSeconds" type="number" min="5" max="600" step="5" :disabled="!settings.coastDrop" /><i>s</i></span></label>
              <label><span>Drop after</span><span class="unit-input"><input v-model.number="settings.dropSeconds" type="number" min="10" max="1800" step="5" :disabled="!settings.coastDrop" /><i>s</i></span></label>
            </div>
            <div class="csub">Proximity alerts</div>
            <div class="toggle-row">
              <label><input v-model="settings.proximity" type="checkbox" /> Proximity alerts</label>
            </div>
            <div class="control-grid control-grid-2">
              <label><span>Alert lateral</span><span class="unit-input"><input v-model.number="settings.proximityNm" type="number" min="0.5" max="20" step="0.5" :disabled="!settings.proximity" /><i>NM</i></span></label>
              <label><span>Alert vertical</span><span class="unit-input"><input v-model.number="settings.proximityFt" type="number" min="100" max="5000" step="100" :disabled="!settings.proximity" /><i>ft</i></span></label>
            </div>
          </section>

          <section class="cblock" :class="{ collapsed: cardCollapsed('config') }">
            <header role="button" tabindex="0" :aria-expanded="!cardCollapsed('config')" @click="toggleCard('config')" @keydown.enter.prevent="toggleCard('config')" @keydown.space.prevent="toggleCard('config')"><FileCog :size="15" /><span>Configuration</span><ChevronDown :size="14" class="cblock-caret" /></header>
            <div class="cov-actions">
              <button type="button" @click="exportSettings">Export</button>
              <button type="button" @click="settingsFileEl?.click()">Import</button>
              <button type="button" @click="resetSettings">Reset all</button>
            </div>
            <input ref="settingsFileEl" type="file" accept="application/json,.json" hidden @change="importSettings" />
          </section>
          </div>
        </div>
        <div v-if="importError" class="import-toast" role="alert">{{ importError }}</div>
      </aside>

      <div class="map-chrome">
        <div class="map-chrome-buttons">
        <!-- A gimbal compass: a real 3D ring (stacked Z layers give it thickness) leaning with the
             view pitch, the rose spinning inside it. Click aligns north; click again when already
             north to level into a straight-down view. -->
        <button
          class="map-compass-button"
          title="Align north · click again to level the view"
          aria-label="Align the view north, or level it when already north"
          @click="tac3d?.resetNorth()"
        >
          <span class="compass-ball" :style="compassBallStyle">
            <span class="compass-ring"></span>
            <span class="compass-ring ring-meridian"></span>
            <span class="compass-ring ring-meridian-2"></span>
            <svg viewBox="0 0 24 24" width="34" height="34" aria-hidden="true">
              <path d="M12 0.6 V3.4 M12 20.6 V23.4 M0.6 12 H3.4 M20.6 12 H23.4" stroke="currentColor" stroke-opacity="0.65" stroke-width="1.3" />
              <polygon points="12,3.8 14.7,12 9.3,12" fill="#fb7185" />
              <polygon points="12,20.2 9.3,12 14.7,12" fill="#cfd8d7" />
              <circle cx="12" cy="12" r="1.4" fill="#eef5f4" />
            </svg>
          </span>
        </button>
        <button
          class="icon-button map-track-button"
          :class="{ active: trackingActive }"
          :title="selectedAirfield ? (trackingActive ? 'Stop tracking airport' : 'Track selected airport') : selectedAircraft ? (trackingActive ? 'Stop tracking' : 'Track selected aircraft') : 'Go to my location'"
          :aria-label="selectedAirfield ? (trackingActive ? 'Stop tracking airport' : 'Track selected airport') : selectedAircraft ? (trackingActive ? 'Stop tracking' : 'Track selected aircraft') : 'Go to my location'"
          @click="recenterView"
        >
          <LocateFixed :size="17" />
        </button>
        </div>
        <div class="map-legend" aria-hidden="true">
          <div class="legend-title">Altitude</div>
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

      <!-- Provider credits. MapLibre's own attribution control renders one collapsed line and could
           not host the licence list, so this is the whole thing: one ⓘ in the map's bottom-left
           corner, everything behind it. -->
      <div class="map-credits">
        <div v-if="creditsOpen" class="credits-popover" role="dialog" aria-label="Map data and licences">
          <div v-for="credit in credits" :key="credit.role" class="credits-row">
            <span class="credits-role">{{ credit.role }}</span>
            <span class="credits-text" v-html="credit.html"></span>
          </div>
          <!-- 116 packages of largely repeated licence text: fetched on expand, never in the bundle. -->
          <button type="button" class="credits-licenses-toggle" :aria-expanded="licensesOpen" @click="toggleLicenses">
            <ChevronDown :size="13" :class="{ turned: licensesOpen }" />
            <span>Open source licenses</span>
            <i v-if="notices.length">{{ notices.length }}</i>
          </button>
          <div v-if="licensesOpen" class="credits-licenses">
            <p v-if="noticesError" class="credits-note">{{ noticesError }}</p>
            <p v-else-if="!notices.length" class="credits-note">Loading…</p>
            <details v-for="pkg in notices" :key="pkg.name + pkg.version" class="credits-pkg">
              <summary>
                <span class="credits-pkg-name">{{ pkg.name }}</span>
                <span class="credits-pkg-meta">{{ pkg.version }} · {{ pkg.license || "see text" }}</span>
              </summary>
              <pre>{{ pkg.text || "No licence text shipped with this package." }}</pre>
            </details>
          </div>
        </div>
        <button
          type="button"
          class="map-credits-button"
          :class="{ active: creditsOpen }"
          :aria-expanded="creditsOpen"
          title="Map data and licences"
          aria-label="Map data and licences"
          @click="creditsOpen = !creditsOpen"
        >
          <Info :size="17" />
        </button>
      </div>

      <!-- Phone station tabs: one thumb row, one sheet at a time. -->
      <nav class="station-tabs" aria-label="Consoles">
        <button
          type="button"
          :class="{ open: stationOpen.target && selectedAircraft, avail: Boolean(selectedAircraft) }"
          :disabled="!selectedAircraft"
          @click="toggleStation('target')"
        >
          <Crosshair :size="17" /><span>Target</span>
        </button>
        <button type="button" :class="{ open: stationOpen.traffic }" @click="toggleStation('traffic')">
          <Radar :size="17" /><span>Traffic</span>
        </button>
        <button type="button" :class="{ open: stationOpen.systems }" @click="toggleStation('systems')">
          <SlidersHorizontal :size="17" /><span>Settings</span>
        </button>
      </nav>
    </section>
  </main>
</template>
