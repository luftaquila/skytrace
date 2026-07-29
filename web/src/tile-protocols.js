const ESRI_PLACEHOLDER_BYTES = 2521;
const GENERATED_TILE_CACHE_CONTROL = "public, max-age=86400";

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException("The operation was aborted", "AbortError");
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

async function fetchWithRetry(fetchImpl, url, signal) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    throwIfAborted(signal);
    try {
      const response = await fetchImpl(url, { signal });
      if (response.ok || response.status < 500 || attempt === 1) {
        return { response, error: null };
      }
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") throw error;
      lastError = error;
      if (attempt === 1) break;
    }
  }
  return { response: null, error: lastError || new Error(`tile request failed: ${url}`) };
}

function responseCacheControl(response) {
  return response?.headers?.get?.("cache-control") || GENERATED_TILE_CACHE_CONTROL;
}

function parseTileUrl(url, pattern, order) {
  const match = pattern.exec(url);
  if (!match) return null;
  const values = Object.fromEntries(order.map((key, index) => [key, Number(match[index + 1])]));
  if (!Object.values(values).every(Number.isSafeInteger)) return null;
  return values;
}

export function parseEsriTileUrl(url) {
  return parseTileUrl(
    url,
    /\/tile\/(\d+)\/(\d+)\/(\d+)(?:[?#]|$)/,
    ["z", "y", "x"],
  );
}

export function parseMapterhornTileUrl(url) {
  return parseTileUrl(
    url,
    /\/(\d+)\/(\d+)\/(\d+)\.webp(?:[?#]|$)/,
    ["z", "x", "y"],
  );
}

function esriUrl({ z, x, y }) {
  return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
}

function mapterhornUrl({ z, x, y }) {
  return `https://tiles.mapterhorn.com/${z}/${x}/${y}.webp`;
}

function parentTile(tile) {
  if (!tile || tile.z <= 0) return null;
  return {
    z: tile.z - 1,
    x: Math.floor(tile.x / 2),
    y: Math.floor(tile.y / 2),
  };
}

function canvas2d(size) {
  const canvas = typeof OffscreenCanvas === "function"
    ? new OffscreenCanvas(size, size)
    : document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("2D canvas unavailable");
  return { canvas, context };
}

async function canvasTileData(canvas) {
  if (typeof createImageBitmap === "function") return createImageBitmap(canvas);
  const blob = typeof canvas.convertToBlob === "function"
    ? await canvas.convertToBlob({ type: "image/png" })
    : await new Promise((resolve, reject) => {
      canvas.toBlob((value) => (value ? resolve(value) : reject(new Error("tile encoding failed"))), "image/png");
    });
  return blob.arrayBuffer();
}

async function renderAncestorTile(data, {
  x,
  y,
  depth,
  size,
  smoothing = true,
}) {
  const bitmap = await createImageBitmap(new Blob([data]));
  try {
    const scale = 2 ** depth;
    const sourceWidth = bitmap.width / scale;
    const sourceHeight = bitmap.height / scale;
    const sourceX = (x % scale) * sourceWidth;
    const sourceY = (y % scale) * sourceHeight;
    const { canvas, context } = canvas2d(size);
    context.imageSmoothingEnabled = smoothing;
    if (smoothing && "imageSmoothingQuality" in context) context.imageSmoothingQuality = "high";
    context.drawImage(
      bitmap,
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
      0,
      0,
      size,
      size,
    );
    return canvasTileData(canvas);
  } finally {
    bitmap.close?.();
  }
}

async function renderSolidTile(size, color) {
  const { canvas, context } = canvas2d(size);
  context.fillStyle = color;
  context.fillRect(0, 0, size, size);
  return canvasTileData(canvas);
}

export function createEsriTileProtocol({
  fetchImpl = fetch,
  renderAncestor = renderAncestorTile,
  renderSolid = renderSolidTile,
} = {}) {
  return async (params, abortController) => {
    const original = parseEsriTileUrl(params.url);
    if (!original) throw new Error("invalid Esri tile URL");
    let candidate = original;
    let depth = 0;
    let cacheControl = GENERATED_TILE_CACHE_CONTROL;
    while (candidate && depth <= 8) {
      const { response } = await fetchWithRetry(fetchImpl, esriUrl(candidate), abortController.signal);
      if (response?.ok) {
        const data = await response.arrayBuffer();
        throwIfAborted(abortController.signal);
        if (data.byteLength !== ESRI_PLACEHOLDER_BYTES) {
          cacheControl = responseCacheControl(response);
          if (depth === 0) return { data, cacheControl };
          return {
            data: await renderAncestor(data, {
              x: original.x,
              y: original.y,
              depth,
              size: 256,
              smoothing: true,
            }),
            cacheControl,
          };
        }
      }
      candidate = parentTile(candidate);
      depth += 1;
    }
    throwIfAborted(abortController.signal);
    return { data: await renderSolid(256, "#050a0c"), cacheControl };
  };
}

export function createMapterhornTileProtocol({
  fetchImpl = fetch,
  renderAncestor = renderAncestorTile,
  renderSolid = renderSolidTile,
} = {}) {
  return async (params, abortController) => {
    const original = parseMapterhornTileUrl(params.url);
    if (!original) throw new Error("invalid Mapterhorn tile URL");
    let candidate = original;
    let depth = 0;
    while (candidate && depth <= 2) {
      const { response } = await fetchWithRetry(
        fetchImpl,
        mapterhornUrl(candidate),
        abortController.signal,
      );
      if (response?.ok) {
        const data = await response.arrayBuffer();
        throwIfAborted(abortController.signal);
        if (depth === 0) return { data, cacheControl: responseCacheControl(response) };
        return {
          // Terrarium elevations are base-256 RGB values. Nearest-neighbour enlargement preserves
          // those exact values; colour interpolation would invent invalid elevations at every pixel.
          data: await renderAncestor(data, {
            x: original.x,
            y: original.y,
            depth,
            size: 512,
            smoothing: false,
          }),
          cacheControl: responseCacheControl(response),
        };
      }
      // Mapterhorn uses 404 for ocean tiles. A sea-level Terrarium tile is the correct terrain,
      // while a transient network/server failure gets two coarser fallback chances first.
      if (response?.status === 404) break;
      candidate = parentTile(candidate);
      depth += 1;
    }
    throwIfAborted(abortController.signal);
    // Terrarium: 128*256 + 0 + 0/256 - 32768 = exactly 0 metres.
    return {
      data: await renderSolid(512, "rgb(128, 0, 0)"),
      cacheControl: GENERATED_TILE_CACHE_CONTROL,
    };
  };
}
