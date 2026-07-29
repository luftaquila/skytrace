import { REFERENCE_CREDIT } from "./credits.js";

// With no style-level glyph URL, MapLibre rasterises this browser/OS font stack locally through
// TinySDF. Every symbol layer shares it, but no font files become part of the Skytrace artifact.
export const MAP_FONT_STACK = ["sans-serif"];
export const MAP_REFERENCE_SOURCE_ID = "openfreemap-reference";
export const MAP_REFERENCE_SOURCE_URL = "https://tiles.openfreemap.org/planet";

export const MAP_REFERENCE_BOUNDARY_LAYER_IDS = [
  "admin-country-boundary",
  "admin-country-disputed",
  "admin-subdivision-boundary",
  "admin-local-boundary",
  "admin-district-boundary",
  "admin-neighborhood-boundary",
];

export const MAP_REFERENCE_PLACE_LAYER_IDS = [
  "place-country",
  "place-capital",
  "place-state",
  "place-city",
  "place-town",
  "place-borough",
  "place-village",
  "place-quarter",
];

export const MAP_REFERENCE_LAYER_IDS = [
  ...MAP_REFERENCE_BOUNDARY_LAYER_IDS,
  ...MAP_REFERENCE_PLACE_LAYER_IDS,
];

export function createMapReferenceSource() {
  return {
    type: "vector",
    url: MAP_REFERENCE_SOURCE_URL,
    attribution: REFERENCE_CREDIT.html,
  };
}

function mapLocaleField(language) {
  if (!language) return null;
  try {
    const locale = new Intl.Locale(String(language).replaceAll("_", "-"));
    const languageCode = locale.language.toLowerCase();
    if (!/^[a-z]{2,3}$/.test(languageCode)) return null;
    // Preserve an explicitly selected script (sr-Latn, az-Cyrl, etc.). Chinese browser locales
    // usually carry only a region, so maximise it to the matching Hans/Hant OpenMapTiles field.
    const script = locale.script || (languageCode === "zh" ? locale.maximize().script : "");
    return `name:${languageCode}${script ? `-${script}` : ""}`;
  } catch {
    return null;
  }
}

// One line only: the browser's preferred language, then a neutral romanisation, English, the old
// OpenMapTiles English compatibility field, and finally the feature's local/native name.
export function mapPlaceName(language) {
  const fields = [
    mapLocaleField(language),
    "name:latin",
    "name:en",
    "name_en",
    "name",
  ].filter(Boolean);
  const uniqueFields = fields.filter((field, index) => fields.indexOf(field) === index);
  return ["coalesce", ...uniqueFields.map((field) => ["get", field])];
}

// OpenMapTiles omits optional numeric properties on many features. Coerce them before comparisons
// so a missing `rank`, `capital`, `admin_level`, etc. evaluates to a normal non-match instead of
// MapLibre reporting "Expected value to be of type number, but found null instead."
const ADMIN_LEVEL = ["to-number", ["get", "admin_level"], -1];
const RANK = ["to-number", ["get", "rank"], 99];
const CAPITAL = ["to-number", ["get", "capital"], 0];
const MARITIME = ["to-number", ["get", "maritime"], 0];
const DISPUTED = ["to-number", ["get", "disputed"], 0];
const NON_MARITIME = ["!=", MARITIME, 1];
const NOT_DISPUTED = ["!=", DISPUTED, 1];
const NOT_CLAIMED_VIEW = ["!", ["has", "claimed_by"]];

function visibility(visible) {
  return visible ? "visible" : "none";
}

function placeLayout(visible, size, textField, extras = {}) {
  return {
    visibility: visibility(visible),
    "text-field": textField,
    "text-font": MAP_FONT_STACK,
    "text-size": size,
    "symbol-sort-key": RANK,
    "text-letter-spacing": 0.02,
    "text-max-width": 9,
    "text-rotation-alignment": "viewport",
    "text-pitch-alignment": "viewport",
    "text-keep-upright": true,
    ...extras,
  };
}

function placePaint(color, haloWidth = 1.4) {
  return {
    "text-color": color,
    "text-halo-color": "rgba(3, 10, 12, 0.94)",
    "text-halo-width": haloWidth,
    "text-halo-blur": 0.5,
  };
}

export function createMapReferenceLayers({ visible = true, language } = {}) {
  const lineLayout = { visibility: visibility(visible), "line-cap": "round", "line-join": "round" };
  const placeName = mapPlaceName(language);
  return [
    {
      id: "admin-country-boundary",
      type: "line",
      source: MAP_REFERENCE_SOURCE_ID,
      "source-layer": "boundary",
      filter: ["all", ["==", ADMIN_LEVEL, 2], NON_MARITIME, NOT_DISPUTED, NOT_CLAIMED_VIEW],
      layout: { ...lineLayout },
      paint: {
        "line-color": "#b8e8e3",
        "line-opacity": ["interpolate", ["linear"], ["zoom"], 0, 0.48, 4, 0.82, 8, 0.72],
        "line-width": ["interpolate", ["linear"], ["zoom"], 0, 0.7, 5, 1.25, 10, 1.8],
        "line-blur": 0.15,
      },
    },
    {
      id: "admin-country-disputed",
      type: "line",
      source: MAP_REFERENCE_SOURCE_ID,
      "source-layer": "boundary",
      filter: ["all", ["==", DISPUTED, 1], NON_MARITIME],
      layout: { ...lineLayout },
      paint: {
        "line-color": "#d4d8d7",
        "line-opacity": 0.75,
        "line-dasharray": [1.5, 2.5],
        "line-width": ["interpolate", ["linear"], ["zoom"], 0, 0.8, 6, 1.3, 10, 1.7],
      },
    },
    {
      id: "admin-subdivision-boundary",
      type: "line",
      source: MAP_REFERENCE_SOURCE_ID,
      "source-layer": "boundary",
      minzoom: 4,
      filter: ["all", [">=", ADMIN_LEVEL, 3], ["<=", ADMIN_LEVEL, 4], NON_MARITIME, NOT_DISPUTED, NOT_CLAIMED_VIEW],
      layout: { ...lineLayout },
      paint: {
        "line-color": "#91bbb8",
        "line-opacity": ["interpolate", ["linear"], ["zoom"], 4, 0.25, 7, 0.55, 10, 0.42],
        "line-dasharray": [3, 2],
        "line-width": ["interpolate", ["linear"], ["zoom"], 4, 0.55, 9, 1.05],
      },
    },
    {
      id: "admin-local-boundary",
      type: "line",
      source: MAP_REFERENCE_SOURCE_ID,
      "source-layer": "boundary",
      minzoom: 8,
      filter: ["all", [">=", ADMIN_LEVEL, 5], ["<=", ADMIN_LEVEL, 6], NON_MARITIME, NOT_DISPUTED, NOT_CLAIMED_VIEW],
      layout: { ...lineLayout },
      paint: {
        "line-color": "#789a98",
        "line-opacity": ["interpolate", ["linear"], ["zoom"], 8, 0.16, 10, 0.38, 13, 0.28],
        "line-dasharray": [1.5, 2],
        "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.45, 12, 0.85],
      },
    },
    {
      id: "admin-district-boundary",
      type: "line",
      source: MAP_REFERENCE_SOURCE_ID,
      "source-layer": "boundary",
      minzoom: 11,
      filter: ["all", ["==", ADMIN_LEVEL, 7], NON_MARITIME, NOT_DISPUTED, NOT_CLAIMED_VIEW],
      layout: { ...lineLayout },
      paint: {
        "line-color": "#6e8987",
        "line-opacity": ["interpolate", ["linear"], ["zoom"], 11, 0.12, 14, 0.24, 17, 0.28],
        "line-dasharray": [1.25, 2.25],
        "line-width": ["interpolate", ["linear"], ["zoom"], 11, 0.4, 15, 0.62, 18, 0.72],
      },
    },
    {
      id: "admin-neighborhood-boundary",
      type: "line",
      source: MAP_REFERENCE_SOURCE_ID,
      "source-layer": "boundary",
      minzoom: 13,
      filter: ["all", ["==", ADMIN_LEVEL, 8], NON_MARITIME, NOT_DISPUTED, NOT_CLAIMED_VIEW],
      layout: { ...lineLayout },
      paint: {
        "line-color": "#647d7b",
        "line-opacity": ["interpolate", ["linear"], ["zoom"], 13, 0.12, 16, 0.3, 18, 0.24],
        "line-dasharray": [1, 2.5],
        "line-width": ["interpolate", ["linear"], ["zoom"], 13, 0.4, 17, 0.7],
      },
    },
    {
      id: "place-country",
      type: "symbol",
      source: MAP_REFERENCE_SOURCE_ID,
      "source-layer": "place",
      minzoom: 0,
      maxzoom: 7,
      filter: ["all", ["==", ["get", "class"], "country"], ["<=", RANK, 6]],
      layout: placeLayout(visible, ["interpolate", ["linear"], ["zoom"], 0, 11, 3, 15, 6, 18], placeName, {
        "text-letter-spacing": 0.09,
        "text-transform": "uppercase",
      }),
      paint: placePaint("#d9f3ef", 1.8),
    },
    {
      id: "place-capital",
      type: "symbol",
      source: MAP_REFERENCE_SOURCE_ID,
      "source-layer": "place",
      minzoom: 3,
      filter: ["all", ["==", ["get", "class"], "city"], ["==", CAPITAL, 2]],
      layout: placeLayout(visible, ["interpolate", ["linear"], ["zoom"], 3, 11, 7, 15, 11, 18], placeName, {
        "text-letter-spacing": 0.05,
      }),
      paint: placePaint("#f2f7e9", 1.8),
    },
    {
      id: "place-state",
      type: "symbol",
      source: MAP_REFERENCE_SOURCE_ID,
      "source-layer": "place",
      minzoom: 4,
      maxzoom: 10,
      filter: ["match", ["get", "class"], ["state", "province"], true, false],
      layout: placeLayout(visible, ["interpolate", ["linear"], ["zoom"], 4, 10, 7, 13, 9, 15], placeName, {
        "text-letter-spacing": 0.06,
      }),
      paint: placePaint("#c5e5e1", 1.55),
    },
    {
      id: "place-city",
      type: "symbol",
      source: MAP_REFERENCE_SOURCE_ID,
      "source-layer": "place",
      minzoom: 5,
      filter: ["all", ["==", ["get", "class"], "city"], ["!=", CAPITAL, 2]],
      layout: placeLayout(visible, ["interpolate", ["linear"], ["zoom"], 5, 10, 8, 13, 12, 16], placeName),
      paint: placePaint("#e0efed", 1.5),
    },
    {
      id: "place-town",
      type: "symbol",
      source: MAP_REFERENCE_SOURCE_ID,
      "source-layer": "place",
      minzoom: 10,
      filter: ["==", ["get", "class"], "town"],
      layout: placeLayout(visible, ["interpolate", ["linear"], ["zoom"], 10, 10, 14, 14, 17, 15], placeName),
      paint: placePaint("#c6dcda", 1.35),
    },
    {
      id: "place-borough",
      type: "symbol",
      source: MAP_REFERENCE_SOURCE_ID,
      "source-layer": "place",
      minzoom: 11,
      filter: ["match", ["get", "class"], ["borough", "suburb"], true, false],
      layout: placeLayout(visible, ["interpolate", ["linear"], ["zoom"], 11, 9, 14, 12, 17, 14], placeName),
      paint: placePaint("#afc8c6", 1.2),
    },
    {
      id: "place-village",
      type: "symbol",
      source: MAP_REFERENCE_SOURCE_ID,
      "source-layer": "place",
      minzoom: 12,
      filter: ["==", ["get", "class"], "village"],
      layout: placeLayout(visible, ["interpolate", ["linear"], ["zoom"], 12, 9, 15, 12, 18, 14], placeName),
      paint: placePaint("#b8cdcb", 1.2),
    },
    {
      id: "place-quarter",
      type: "symbol",
      source: MAP_REFERENCE_SOURCE_ID,
      "source-layer": "place",
      minzoom: 14,
      filter: ["match", ["get", "class"], ["quarter", "neighbourhood"], true, false],
      layout: placeLayout(visible, ["interpolate", ["linear"], ["zoom"], 14, 9, 16, 11, 19, 13], placeName, {
        "text-letter-spacing": 0.01,
      }),
      paint: placePaint("#99b2b0", 1.05),
    },
  ];
}

// Removing the vector source when disabled is deliberate: visibility:none stops drawing, but the
// source can still fetch TileJSON/tiles. Re-adding the fixed layers before rings-casing restores the
// original z-order without touching operational GeoJSON/custom layers.
export function syncMapReferenceOverlay(map, visible, language, beforeId = "rings-casing") {
  if (!visible) {
    for (const id of [...MAP_REFERENCE_LAYER_IDS].reverse()) {
      if (map.getLayer(id)) map.removeLayer(id);
    }
    if (map.getSource(MAP_REFERENCE_SOURCE_ID)) map.removeSource(MAP_REFERENCE_SOURCE_ID);
    return;
  }

  if (!map.getSource(MAP_REFERENCE_SOURCE_ID)) {
    map.addSource(MAP_REFERENCE_SOURCE_ID, createMapReferenceSource());
  }
  for (const layer of createMapReferenceLayers({ language })) {
    if (!map.getLayer(layer.id)) map.addLayer(layer, beforeId);
  }
}
