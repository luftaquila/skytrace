// The per-receiver anchor the client is allowed to use. A coverage mesh's published origin is
// only its datum — when a feeder reports its location the server echoes it there, and the client
// must not treat that as a receiver position. Everything per-receiver (the focus button, the
// range rings) anchors instead on a position ESTIMATED from the dome itself: the mean of its
// mesh vertices, which approximates the reception centroid far better than a bounds midpoint
// (one long-range lobe drags a bounding box a long way; it barely moves the mean).
export const M_PER_DEG_LAT = 111320;

function decodeBase64Uint16(encoded) {
  const binary = atob(encoded);
  const view = new DataView(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) view.setUint8(i, binary.charCodeAt(i));
  const values = new Uint16Array(binary.length >> 1);
  for (let i = 0; i < values.length; i += 1) values[i] = view.getUint16(i * 2, true);
  return values;
}

function decodeBase64Float32(encoded) {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

// Mean local east/north offset of the mesh vertices, in metres from the datum. For the quantized
// encoding the mean is taken on the raw uint16 values and dequantized once — same result, no
// per-vertex float work.
function meanVertexOffset(mesh) {
  try {
    if (mesh.encoding === "quantized-uint16-le-base64" && typeof mesh.positions === "string"
      && Array.isArray(mesh.positionBounds) && mesh.positionBounds.length === 6) {
      const q = decodeBase64Uint16(mesh.positions);
      if (q.length < 3) return null;
      let sumE = 0;
      let sumN = 0;
      for (let i = 0; i < q.length; i += 3) { sumE += q[i]; sumN += q[i + 1]; }
      const n = q.length / 3;
      const b = mesh.positionBounds;
      return { east: b[0] + (b[3] - b[0]) * (sumE / n / 65535), north: b[1] + (b[4] - b[1]) * (sumN / n / 65535) };
    }
    if (mesh.encoding === "float32-le-base64" && typeof mesh.positions === "string") {
      const f = decodeBase64Float32(mesh.positions);
      if (f.length < 3) return null;
      let sumE = 0;
      let sumN = 0;
      for (let i = 0; i < f.length; i += 3) { sumE += f[i]; sumN += f[i + 1]; }
      const n = f.length / 3;
      return { east: sumE / n, north: sumN / n };
    }
  } catch { /* malformed base64: fall through to the coarser estimates */ }
  return null;
}

// Decoding runs per coverage snapshot, not per caller: rows recompute on every poll and the
// rings on every refresh, all against the same mesh object.
const centreCache = new WeakMap();

export function domeCentre(mesh) {
  const origin = mesh?.origin;
  if (!Array.isArray(origin) || origin.length !== 2 || !origin.every(Number.isFinite)) return null;
  if (centreCache.has(mesh)) return centreCache.get(mesh);
  let offset = meanVertexOffset(mesh);
  if (!offset) {
    const b = mesh.positionBounds;
    offset = Array.isArray(b) && b.length === 6 && b.every(Number.isFinite)
      ? { east: (b[0] + b[3]) / 2, north: (b[1] + b[4]) / 2 } // bounds midpoint beats the raw datum
      : { east: 0, north: 0 };
  }
  const lat = origin[1] + offset.north / M_PER_DEG_LAT;
  const lon = origin[0] + offset.east / (M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180) || 1);
  const centre = { lon, lat };
  centreCache.set(mesh, centre);
  return centre;
}
