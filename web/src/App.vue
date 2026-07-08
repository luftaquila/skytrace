<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";
import L from "leaflet";
import { CircleDot, LocateFixed, RadioTower, RefreshCw, Search, X } from "@lucide/vue";

const mapEl = ref(null);
const aircraft = ref([]);
const receivers = ref([]);
const selectedHex = ref(null);
const selectedTrack = ref([]);
const search = ref("");
const status = ref("loading");
const lastUpdated = ref(null);
const trackHours = ref(24);

let map;
let trackLayer;
let receiverLayer;
let refreshTimer;
let eventSource;
const markers = new Map();

const filteredAircraft = computed(() => {
  const q = search.value.trim().toLowerCase();
  const rows = q
    ? aircraft.value.filter((item) => {
        return item.hex.includes(q) || String(item.flight || "").toLowerCase().includes(q);
      })
    : aircraft.value;
  return rows.slice(0, 500);
});

const selectedAircraft = computed(() => {
  return aircraft.value.find((item) => item.hex === selectedHex.value) || null;
});

function formatFlight(item) {
  return item.flight || item.hex.toUpperCase();
}

function formatAltitude(item) {
  if (item.onGround) return "ground";
  const alt = item.altBaro ?? item.altGeom;
  return alt == null ? "unknown" : `${Math.round(alt).toLocaleString()} ft`;
}

function formatSpeed(item) {
  return item.gs == null ? "-" : `${Math.round(item.gs)} kt`;
}

function formatAge(iso) {
  if (!iso) return "-";
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.round(seconds / 60)}m`;
}

function markerHtml(item) {
  const rotation = Number.isFinite(item.track) ? item.track : 0;
  return `<span class="aircraft-glyph" style="transform: rotate(${rotation}deg)"></span>`;
}

function markerIcon(item) {
  const selected = selectedHex.value === item.hex;
  return L.divIcon({
    className: `aircraft-icon ${selected ? "selected" : ""}`,
    html: markerHtml(item),
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

function upsertMarkers() {
  if (!map) return;
  const visible = new Set();
  for (const item of aircraft.value) {
    if (item.lat == null || item.lon == null) continue;
    visible.add(item.hex);
    const latLng = [item.lat, item.lon];
    const title = `${formatFlight(item)} ${formatAltitude(item)} ${formatSpeed(item)}`;
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

function drawReceivers() {
  if (!map) return;
  if (receiverLayer) receiverLayer.remove();
  receiverLayer = L.layerGroup();
  for (const receiver of receivers.value) {
    if (receiver.lat == null || receiver.lon == null) continue;
    const color = receiver.online ? "#2dd4bf" : "#f59e0b";
    L.circleMarker([receiver.lat, receiver.lon], {
      radius: 6,
      color,
      fillColor: color,
      fillOpacity: 0.85,
      weight: 2,
    })
      .bindTooltip(`${receiver.name} (${receiver.currentAircraft})`)
      .addTo(receiverLayer);
  }
  receiverLayer.addTo(map);
}

function drawTrack() {
  if (!map) return;
  if (trackLayer) {
    trackLayer.remove();
    trackLayer = null;
  }
  const points = selectedTrack.value
    .filter((point) => point.lat != null && point.lon != null)
    .map((point) => [point.lat, point.lon]);
  if (points.length < 2) return;
  trackLayer = L.polyline(points, {
    color: "#fbbf24",
    opacity: 0.9,
    weight: 3,
  }).addTo(map);
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

async function refreshAll() {
  try {
    const [current, receiverResult] = await Promise.all([
      fetchJson("/api/aircraft/current"),
      fetchJson("/api/receivers/public"),
    ]);
    aircraft.value = current.aircraft || [];
    receivers.value = receiverResult.receivers || [];
    lastUpdated.value = current.now;
    status.value = "online";
    upsertMarkers();
    drawReceivers();
    if (selectedHex.value) await refreshTrack();
  } catch (err) {
    status.value = "offline";
    console.error(err);
  }
}

async function refreshTrack() {
  if (!selectedHex.value) return;
  const to = new Date();
  const from = new Date(to.getTime() - trackHours.value * 60 * 60 * 1000);
  const params = new URLSearchParams({
    from: from.toISOString(),
    to: to.toISOString(),
  });
  const result = await fetchJson(`/api/aircraft/${selectedHex.value}/track?${params}`);
  selectedTrack.value = result.points || [];
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
  if (trackLayer) {
    trackLayer.remove();
    trackLayer = null;
  }
  upsertMarkers();
}

function fitVisibleAircraft() {
  const points = aircraft.value
    .filter((item) => item.lat != null && item.lon != null)
    .map((item) => [item.lat, item.lon]);
  if (!points.length) return;
  map.fitBounds(points, { padding: [48, 48], maxZoom: 10 });
}

onMounted(async () => {
  map = L.map(mapEl.value, {
    zoomControl: false,
    preferCanvas: true,
  }).setView([36.2, 127.8], 7);

  L.control.zoom({ position: "bottomright" }).addTo(map);
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 19,
    attribution:
      "Tiles &copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community",
  }).addTo(map);

  await refreshAll();
  refreshTimer = setInterval(refreshAll, 10000);
  eventSource = new EventSource("/api/events");
  eventSource.addEventListener("ingest", () => refreshAll());
  eventSource.onerror = () => {
    status.value = "reconnecting";
  };
});

onUnmounted(() => {
  clearInterval(refreshTimer);
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
            {{ status }} · {{ aircraft.length }} aircraft · {{ receivers.length }} receivers
          </div>
        </div>
        <div class="toolbar">
          <button class="icon-button" title="Fit aircraft" @click="fitVisibleAircraft">
            <LocateFixed :size="18" />
          </button>
          <button class="icon-button" title="Refresh" @click="refreshAll">
            <RefreshCw :size="18" />
          </button>
        </div>
      </div>
    </section>

    <aside class="panel">
      <div class="search-wrap">
        <Search :size="18" />
        <input v-model="search" type="search" placeholder="Search hex or callsign" />
      </div>

      <div class="metric-grid">
        <div>
          <span>{{ aircraft.length }}</span>
          <small>Live aircraft</small>
        </div>
        <div>
          <span>{{ receivers.filter((r) => r.online).length }}/{{ receivers.length }}</span>
          <small>Receivers</small>
        </div>
        <div>
          <span>{{ lastUpdated ? formatAge(lastUpdated) : "-" }}</span>
          <small>Updated</small>
        </div>
      </div>

      <section v-if="selectedAircraft" class="detail">
        <div class="detail-head">
          <div>
            <h2>{{ formatFlight(selectedAircraft) }}</h2>
            <p>{{ selectedAircraft.hex.toUpperCase() }}</p>
          </div>
          <button class="icon-button small" title="Close" @click="clearSelection">
            <X :size="16" />
          </button>
        </div>
        <dl>
          <div><dt>Altitude</dt><dd>{{ formatAltitude(selectedAircraft) }}</dd></div>
          <div><dt>Speed</dt><dd>{{ formatSpeed(selectedAircraft) }}</dd></div>
          <div><dt>Track</dt><dd>{{ selectedAircraft.track == null ? "-" : `${Math.round(selectedAircraft.track)} deg` }}</dd></div>
          <div><dt>Seen</dt><dd>{{ formatAge(selectedAircraft.observedAt) }}</dd></div>
          <div><dt>Receivers</dt><dd>{{ selectedAircraft.receiverCount }}</dd></div>
          <div><dt>Track points</dt><dd>{{ selectedTrack.length }}</dd></div>
        </dl>
        <label class="select-row">
          <span>History</span>
          <select v-model.number="trackHours" @change="refreshTrack">
            <option :value="1">1h</option>
            <option :value="6">6h</option>
            <option :value="24">24h</option>
            <option :value="168">7d</option>
          </select>
        </label>
      </section>

      <section class="list">
        <header>
          <CircleDot :size="17" />
          <span>Aircraft</span>
        </header>
        <button
          v-for="item in filteredAircraft"
          :key="item.hex"
          :class="['aircraft-row', { active: selectedHex === item.hex }]"
          @click="selectAircraft(item.hex, true)"
        >
          <span>
            <strong>{{ formatFlight(item) }}</strong>
            <small>{{ item.hex.toUpperCase() }}</small>
          </span>
          <span>
            <strong>{{ formatAltitude(item) }}</strong>
            <small>{{ formatSpeed(item) }} · {{ formatAge(item.observedAt) }}</small>
          </span>
        </button>
      </section>

      <section class="receiver-list">
        <header>
          <RadioTower :size="17" />
          <span>Receivers</span>
        </header>
        <div v-for="receiver in receivers" :key="receiver.id" class="receiver-row">
          <span :class="['receiver-light', { on: receiver.online }]"></span>
          <span>{{ receiver.name }}</span>
          <small>{{ receiver.currentAircraft }} aircraft</small>
        </div>
      </section>
    </aside>
  </main>
</template>
