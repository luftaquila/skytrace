import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SETTINGS } from "../web/src/settings.js";
import {
  MAP_FONT_STACK,
  MAP_REFERENCE_BOUNDARY_LAYER_IDS,
  MAP_REFERENCE_LAYER_IDS,
  MAP_REFERENCE_PLACE_LAYER_IDS,
  MAP_REFERENCE_SOURCE_ID,
  createMapReferenceLayers,
  createMapReferenceSource,
  mapPlaceName,
  syncMapReferenceOverlay,
} from "../web/src/map-reference-style.js";

function layer(id, visible = true, language) {
  return createMapReferenceLayers({ visible, language }).find((candidate) => candidate.id === id);
}

test("the reference source is the public unauthenticated OpenFreeMap planet source", () => {
  const source = createMapReferenceSource();
  assert.deepEqual(Object.keys(source).sort(), ["attribution", "type", "url"]);
  assert.equal(source.type, "vector");
  assert.equal(source.url, "https://tiles.openfreemap.org/planet");
  assert.doesNotMatch(source.url, /[?&](key|token)=/i);
  for (const provider of ["OpenFreeMap", "OpenMapTiles", "OpenStreetMap"]) {
    assert.match(source.attribution, new RegExp(provider));
  }
});

test("only boundary and place source layers are used in the fixed z-order", () => {
  const layers = createMapReferenceLayers();
  assert.deepEqual(layers.map((candidate) => candidate.id), MAP_REFERENCE_LAYER_IDS);
  assert.deepEqual(
    [...new Set(layers.map((candidate) => candidate["source-layer"]))].sort(),
    ["boundary", "place"],
  );
  assert.ok(layers.every((candidate) => candidate.source === MAP_REFERENCE_SOURCE_ID));
  assert.deepEqual(layers.slice(0, MAP_REFERENCE_BOUNDARY_LAYER_IDS.length).map(({ id }) => id), MAP_REFERENCE_BOUNDARY_LAYER_IDS);
  assert.deepEqual(layers.slice(MAP_REFERENCE_BOUNDARY_LAYER_IDS.length).map(({ id }) => id), MAP_REFERENCE_PLACE_LAYER_IDS);

  for (const forbidden of ["transportation", "building", "poi"]) {
    assert.equal(layers.some((candidate) => candidate["source-layer"] === forbidden), false);
  }
});

test("administrative boundary filters separate recognized, disputed and local levels", () => {
  const country = JSON.stringify(layer("admin-country-boundary").filter);
  assert.match(country, /admin_level.*2/);
  assert.match(country, /maritime/);
  assert.match(country, /disputed/);
  assert.match(country, /claimed_by/);

  const disputed = JSON.stringify(layer("admin-country-disputed").filter);
  assert.match(disputed, /disputed.*1/);
  assert.match(disputed, /maritime/);
  assert.doesNotMatch(disputed, /claimed_by/);

  assert.match(JSON.stringify(layer("admin-subdivision-boundary").filter), /admin_level.*3.*admin_level.*4/);
  assert.equal(layer("admin-subdivision-boundary").minzoom, 4);
  assert.match(JSON.stringify(layer("admin-local-boundary").filter), /admin_level.*5.*admin_level.*6/);
  assert.equal(layer("admin-local-boundary").minzoom, 8);
  assert.match(JSON.stringify(layer("admin-district-boundary").filter), /admin_level.*7/);
  assert.equal(layer("admin-district-boundary").minzoom, 11);
  assert.match(JSON.stringify(layer("admin-neighborhood-boundary").filter), /admin_level.*8/);
  assert.equal(layer("admin-neighborhood-boundary").minzoom, 13);
});

test("optional OpenMapTiles numbers are coerced before comparisons", () => {
  for (const id of MAP_REFERENCE_LAYER_IDS) {
    const filter = JSON.stringify(layer(id).filter);
    if (/[<>]=?/.test(filter) || /admin_level|disputed|maritime|capital/.test(filter)) {
      assert.match(filter, /to-number/, `${id} must tolerate omitted numeric properties`);
    }
  }
});

test("local place names reveal progressively below the city level", () => {
  const expected = [
    ["place-town", 10, ["town"]],
    ["place-borough", 11, ["borough", "suburb"]],
    ["place-village", 12, ["village"]],
    ["place-quarter", 14, ["quarter", "neighbourhood"]],
  ];
  for (const [id, minzoom, classNames] of expected) {
    const local = layer(id);
    const filter = JSON.stringify(local.filter);
    assert.equal(local.minzoom, minzoom, id);
    for (const className of classNames) assert.match(filter, new RegExp(className), `${id} ${className}`);
    for (const other of expected.flatMap(([, , names]) => names).filter((name) => !classNames.includes(name))) {
      assert.doesNotMatch(filter, new RegExp(other), `${id} excludes ${other}`);
    }
  }
});

test("place names prefer browser locale, then romanised, English and local names", () => {
  assert.deepEqual(MAP_FONT_STACK, ["sans-serif"]);
  assert.deepEqual(mapPlaceName("ko-KR"), [
    "coalesce",
    ["get", "name:ko"],
    ["get", "name:latin"],
    ["get", "name:en"],
    ["get", "name_en"],
    ["get", "name"],
  ]);
  assert.deepEqual(mapPlaceName("en-US"), [
    "coalesce",
    ["get", "name:en"],
    ["get", "name:latin"],
    ["get", "name_en"],
    ["get", "name"],
  ]);
  assert.deepEqual(mapPlaceName("zh-TW"), [
    "coalesce",
    ["get", "name:zh-Hant"],
    ["get", "name:latin"],
    ["get", "name:en"],
    ["get", "name_en"],
    ["get", "name"],
  ]);
  assert.deepEqual(mapPlaceName("not a locale"), [
    "coalesce",
    ["get", "name:latin"],
    ["get", "name:en"],
    ["get", "name_en"],
    ["get", "name"],
  ]);
});

test("all place labels remain screen-upright and share the locale expression", () => {
  const expectedName = mapPlaceName("ja-JP");
  for (const id of MAP_REFERENCE_PLACE_LAYER_IDS) {
    const layout = layer(id, true, "ja-JP").layout;
    assert.deepEqual(layout["text-font"], MAP_FONT_STACK, `${id} font`);
    assert.deepEqual(layout["text-field"], expectedName, `${id} language expression`);
    assert.equal(layout["text-rotation-alignment"], "viewport", `${id} rotation`);
    assert.equal(layout["text-pitch-alignment"], "viewport", `${id} pitch`);
    assert.equal(layout["text-keep-upright"], true, `${id} upright`);
    assert.match(JSON.stringify(layout["symbol-sort-key"]), /rank/, `${id} rank priority`);
  }
});

test("the saved setting defaults on and the overlay can be enabled and removed", () => {
  assert.equal(DEFAULT_SETTINGS.mapReferenceLabels, true);

  const sources = new Map();
  const layers = new Map([["rings-casing", { id: "rings-casing" }]]);
  const calls = [];
  const map = {
    getSource: (id) => sources.get(id),
    addSource: (id, source) => { sources.set(id, source); calls.push(["addSource", id]); },
    removeSource: (id) => { sources.delete(id); calls.push(["removeSource", id]); },
    getLayer: (id) => layers.get(id),
    addLayer: (candidate, beforeId) => {
      layers.set(candidate.id, candidate);
      calls.push(["addLayer", candidate.id, beforeId]);
    },
    removeLayer: (id) => { layers.delete(id); calls.push(["removeLayer", id]); },
  };

  syncMapReferenceOverlay(map, true, "ko-KR");
  assert.ok(sources.has(MAP_REFERENCE_SOURCE_ID));
  assert.deepEqual(
    calls.filter(([operation]) => operation === "addLayer").map(([, id, beforeId]) => [id, beforeId]),
    MAP_REFERENCE_LAYER_IDS.map((id) => [id, "rings-casing"]),
  );
  assert.deepEqual(layers.get("place-city").layout["text-field"], mapPlaceName("ko-KR"));

  calls.length = 0;
  syncMapReferenceOverlay(map, false, "ko-KR");
  assert.equal(sources.has(MAP_REFERENCE_SOURCE_ID), false);
  assert.equal(MAP_REFERENCE_LAYER_IDS.some((id) => layers.has(id)), false);
  assert.deepEqual(calls.at(-1), ["removeSource", MAP_REFERENCE_SOURCE_ID]);
});
