import assert from "node:assert/strict";
import test from "node:test";

import {
  createEsriTileProtocol,
  createMapterhornTileProtocol,
  parseEsriTileUrl,
  parseMapterhornTileUrl,
} from "../web/src/tile-protocols.js";

function response(status, bytes = 16, cacheControl = "public, max-age=60") {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (name.toLowerCase() === "cache-control" ? cacheControl : null) },
    arrayBuffer: async () => new Uint8Array(bytes).buffer,
  };
}

test("provider tile URLs preserve each provider's coordinate order", () => {
  assert.deepEqual(
    parseEsriTileUrl("esrisat://server/MapServer/tile/9/201/443"),
    { z: 9, y: 201, x: 443 },
  );
  assert.deepEqual(
    parseMapterhornTileUrl("mapterhorn://tiles.mapterhorn.com/7/111/52.webp"),
    { z: 7, x: 111, y: 52 },
  );
});

test("Esri placeholder tiles are replaced by the correctly cropped real ancestor", async () => {
  const urls = [];
  let rendered;
  const protocol = createEsriTileProtocol({
    fetchImpl: async (url) => {
      urls.push(url);
      return urls.length === 1 ? response(200, 2521) : response(200, 32, "ancestor");
    },
    renderAncestor: async (data, options) => {
      rendered = { bytes: data.byteLength, ...options };
      return new Uint8Array([7]).buffer;
    },
  });

  const result = await protocol(
    { url: "esrisat://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/9/201/443" },
    new AbortController(),
  );

  assert.deepEqual(urls, [
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/9/201/443",
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/8/100/221",
  ]);
  assert.deepEqual(rendered, {
    bytes: 32,
    x: 443,
    y: 201,
    depth: 1,
    size: 256,
    smoothing: true,
  });
  assert.equal(result.data.byteLength, 1);
  assert.equal(result.cacheControl, "ancestor");
});

test("Mapterhorn ocean 404 becomes an exact flat Terrarium tile without another request", async () => {
  const urls = [];
  let solid;
  const protocol = createMapterhornTileProtocol({
    fetchImpl: async (url) => {
      urls.push(url);
      return response(404, 0);
    },
    renderSolid: async (size, color) => {
      solid = { size, color };
      return new Uint8Array([1, 2]).buffer;
    },
  });

  const result = await protocol(
    { url: "mapterhorn://tiles.mapterhorn.com/7/111/52.webp" },
    new AbortController(),
  );

  assert.deepEqual(urls, ["https://tiles.mapterhorn.com/7/111/52.webp"]);
  assert.deepEqual(solid, { size: 512, color: "rgb(128, 0, 0)" });
  assert.equal(result.data.byteLength, 2);
});

test("a transient Mapterhorn failure uses a nearest-neighbour parent DEM", async () => {
  const urls = [];
  let rendered;
  const protocol = createMapterhornTileProtocol({
    fetchImpl: async (url) => {
      urls.push(url);
      if (urls.length <= 2) throw new TypeError("temporary network failure");
      return response(200, 64);
    },
    renderAncestor: async (data, options) => {
      rendered = { bytes: data.byteLength, ...options };
      return new Uint8Array([3]).buffer;
    },
  });

  await protocol(
    { url: "mapterhorn://tiles.mapterhorn.com/7/110/50.webp" },
    new AbortController(),
  );

  assert.deepEqual(urls, [
    "https://tiles.mapterhorn.com/7/110/50.webp",
    "https://tiles.mapterhorn.com/7/110/50.webp",
    "https://tiles.mapterhorn.com/6/55/25.webp",
  ]);
  assert.deepEqual(rendered, {
    bytes: 64,
    x: 110,
    y: 50,
    depth: 1,
    size: 512,
    smoothing: false,
  });
});
