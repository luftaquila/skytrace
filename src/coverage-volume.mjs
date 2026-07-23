const NM_TO_M = 1852;
const FT_TO_M = 0.3048;

const CUBE_OFFSETS = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [1, 1, 1],
  [0, 1, 1],
];

const CUBE_EDGES = [
  [0, 1], [1, 2], [2, 3], [3, 0],
  [4, 5], [5, 6], [6, 7], [7, 4],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function pointAltitude(row) {
  return finiteNumber(row.alt_baro ?? row.alt_geom ?? row.altBaro ?? row.altGeom);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function gridIndex(field, x, y, z) {
  return x + field.nx * (y + field.ny * z);
}

function cellIndex(field, x, y, z) {
  return x + (field.nx - 1) * (y + (field.ny - 1) * z);
}

function gridPoint(field, x, y, z) {
  return [
    (field.minEastNm + x * field.horizontalStepNm) * NM_TO_M,
    (field.minNorthNm + y * field.horizontalStepNm) * NM_TO_M,
    (field.minAltitudeFt + z * field.verticalStepFt) * FT_TO_M,
  ];
}

function interpolate(a, b, aValue, bValue, isoLevel) {
  const span = bValue - aValue;
  const t = Math.abs(span) < 1e-12 ? 0.5 : clamp((isoLevel - aValue) / span, 0, 1);
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

function localPoint(row, origin, cosLat) {
  const lat = finiteNumber(row.lat);
  const lon = finiteNumber(row.lon);
  const altitudeFt = pointAltitude(row);
  if (lat == null || lon == null || altitudeFt == null || altitudeFt < 0 || altitudeFt > 80000) return null;
  return {
    eastNm: (lon - origin.lon) * cosLat * 60,
    northNm: (lat - origin.lat) * 60,
    altitudeFt,
    hex: String(row.hex || ""),
    timeMs: Date.parse(row.position_at ?? row.positionAt ?? ""),
  };
}

function distance3Steps(a, b, horizontalStepNm, verticalStepFt) {
  return Math.max(
    Math.hypot(b.eastNm - a.eastNm, b.northNm - a.northNm) / horizontalStepNm,
    Math.abs(b.altitudeFt - a.altitudeFt) / verticalStepFt,
  );
}

function coverageSamples(points, options) {
  const samples = [...points];
  const byAircraft = new Map();
  for (const point of points) {
    if (!point.hex || !Number.isFinite(point.timeMs)) continue;
    const list = byAircraft.get(point.hex) || [];
    list.push(point);
    byAircraft.set(point.hex, list);
  }

  // Stored points normally arrive every five seconds. Interpolating only short, physically
  // plausible runs prevents polling gaps from punching slits through an otherwise observed
  // flight path without drawing bridges between separate flights or unrelated aircraft.
  for (const list of byAircraft.values()) {
    list.sort((a, b) => a.timeMs - b.timeMs);
    for (let i = 1; i < list.length; i += 1) {
      const a = list[i - 1];
      const b = list[i];
      const dtSeconds = (b.timeMs - a.timeMs) / 1000;
      const horizontalNm = Math.hypot(b.eastNm - a.eastNm, b.northNm - a.northNm);
      if (!(dtSeconds > 0 && dtSeconds <= options.maxSegmentSeconds)
        || horizontalNm > options.maxSegmentNm
        || Math.abs(b.altitudeFt - a.altitudeFt) > options.maxSegmentAltitudeFt) continue;
      const steps = Math.min(24, Math.ceil(distance3Steps(a, b, options.horizontalStepNm * 0.75, options.verticalStepFt * 0.75)));
      for (let step = 1; step < steps; step += 1) {
        const t = step / steps;
        samples.push({
          eastNm: a.eastNm + (b.eastNm - a.eastNm) * t,
          northNm: a.northNm + (b.northNm - a.northNm) * t,
          altitudeFt: a.altitudeFt + (b.altitudeFt - a.altitudeFt) * t,
        });
      }
    }
  }

  // Repeated traffic in the same small cell cannot expand an observed-volume union. Removing
  // those duplicates keeps a 50k-point refresh comfortably below the five-minute budget.
  const unique = new Map();
  const h = options.horizontalStepNm * 0.5;
  const v = options.verticalStepFt * 0.5;
  for (const point of samples) {
    const key = `${Math.round(point.eastNm / h)},${Math.round(point.northNm / h)},${Math.round(point.altitudeFt / v)}`;
    if (!unique.has(key)) unique.set(key, point);
  }
  return [...unique.values()];
}

function fieldBounds(points, options) {
  let minEastNm = Infinity;
  let maxEastNm = -Infinity;
  let minNorthNm = Infinity;
  let maxNorthNm = -Infinity;
  let minAltitudeFt = Infinity;
  let maxAltitudeFt = -Infinity;
  for (const point of points) {
    minEastNm = Math.min(minEastNm, point.eastNm);
    maxEastNm = Math.max(maxEastNm, point.eastNm);
    minNorthNm = Math.min(minNorthNm, point.northNm);
    maxNorthNm = Math.max(maxNorthNm, point.northNm);
    minAltitudeFt = Math.min(minAltitudeFt, point.altitudeFt);
    maxAltitudeFt = Math.max(maxAltitudeFt, point.altitudeFt);
  }

  const horizontalPadding = options.horizontalSupportNm
    + (1 + options.horizontalSmoothingPasses) * options.horizontalStepNm;
  const verticalPadding = options.verticalSupportFt
    + (1 + options.verticalSmoothingPasses) * options.verticalStepFt;
  return {
    minEastNm: Math.floor((minEastNm - horizontalPadding) / options.horizontalStepNm) * options.horizontalStepNm,
    maxEastNm: Math.ceil((maxEastNm + horizontalPadding) / options.horizontalStepNm) * options.horizontalStepNm,
    minNorthNm: Math.floor((minNorthNm - horizontalPadding) / options.horizontalStepNm) * options.horizontalStepNm,
    maxNorthNm: Math.ceil((maxNorthNm + horizontalPadding) / options.horizontalStepNm) * options.horizontalStepNm,
    minAltitudeFt: Math.max(
      -options.verticalSupportFt,
      Math.floor((minAltitudeFt - verticalPadding) / options.verticalStepFt) * options.verticalStepFt,
    ),
    maxAltitudeFt: Math.ceil((maxAltitudeFt + verticalPadding) / options.verticalStepFt) * options.verticalStepFt,
  };
}

function gridShape(bounds, horizontalStepNm, verticalStepFt) {
  const nx = Math.round((bounds.maxEastNm - bounds.minEastNm) / horizontalStepNm) + 1;
  const ny = Math.round((bounds.maxNorthNm - bounds.minNorthNm) / horizontalStepNm) + 1;
  const nz = Math.round((bounds.maxAltitudeFt - bounds.minAltitudeFt) / verticalStepFt) + 1;
  return { nx, ny, nz, gridNodes: nx * ny * nz };
}

// Grayscale closing fills narrow valleys between nearby observed corridors without
// expanding the outside boundary like a larger reception kernel would. Apply it only in
// horizontal slices: nearby routes at a similar altitude may support interpolation, while
// large lateral gaps and unobserved altitude bands remain empty.
function interpolateNarrowHorizontalGaps(field) {
  const radius = field.horizontalInterpolationCells;
  if (radius < 1) return;

  const planeSize = field.nx * field.ny;
  const dilated = new Float32Array(planeSize);
  const closed = new Float32Array(planeSize);
  for (let z = 0; z < field.nz; z += 1) {
    const zOffset = z * planeSize;
    for (let y = 0; y < field.ny; y += 1) {
      for (let x = 0; x < field.nx; x += 1) {
        let maximum = 0;
        for (let dy = -radius; dy <= radius; dy += 1) {
          const ny = y + dy;
          if (ny < 0 || ny >= field.ny) continue;
          for (let dx = -radius; dx <= radius; dx += 1) {
            const nx = x + dx;
            if (nx < 0 || nx >= field.nx) continue;
            maximum = Math.max(maximum, field.values[zOffset + nx + field.nx * ny]);
          }
        }
        dilated[x + field.nx * y] = maximum;
      }
    }

    for (let y = 0; y < field.ny; y += 1) {
      for (let x = 0; x < field.nx; x += 1) {
        let minimum = Infinity;
        for (let dy = -radius; dy <= radius; dy += 1) {
          const ny = y + dy;
          for (let dx = -radius; dx <= radius; dx += 1) {
            const nx = x + dx;
            const value = nx < 0 || nx >= field.nx || ny < 0 || ny >= field.ny
              ? 0
              : dilated[nx + field.nx * ny];
            minimum = Math.min(minimum, value);
          }
        }
        const index = x + field.nx * y;
        closed[index] = Math.max(field.values[zOffset + index], minimum);
      }
    }

    field.values.set(closed, zOffset);
  }
}

// A short separable blur rounds the remaining grid-aligned corners after closing. Its
// support is limited to one horizontal grid cell per pass, so large occupancy holes remain.
function smoothHorizontalTransitions(field) {
  const passes = field.horizontalSmoothingPasses;
  if (passes < 1) return;

  const planeSize = field.nx * field.ny;
  const horizontal = new Float32Array(planeSize);
  const smoothed = new Float32Array(planeSize);
  for (let pass = 0; pass < passes; pass += 1) {
    for (let z = 0; z < field.nz; z += 1) {
      const zOffset = z * planeSize;
      for (let y = 0; y < field.ny; y += 1) {
        const rowOffset = y * field.nx;
        for (let x = 0; x < field.nx; x += 1) {
          const left = x > 0 ? field.values[zOffset + rowOffset + x - 1] : 0;
          const current = field.values[zOffset + rowOffset + x];
          const right = x + 1 < field.nx ? field.values[zOffset + rowOffset + x + 1] : 0;
          horizontal[rowOffset + x] = left * 0.25 + current * 0.5 + right * 0.25;
        }
      }
      for (let y = 0; y < field.ny; y += 1) {
        for (let x = 0; x < field.nx; x += 1) {
          const below = y > 0 ? horizontal[x + field.nx * (y - 1)] : 0;
          const current = horizontal[x + field.nx * y];
          const above = y + 1 < field.ny ? horizontal[x + field.nx * (y + 1)] : 0;
          smoothed[x + field.nx * y] = below * 0.25 + current * 0.5 + above * 0.25;
        }
      }
      field.values.set(smoothed, zOffset);
    }
  }
}

// Smooth only along altitude columns. This rounds shelves caused by traffic clustering at
// discrete flight levels while leaving every horizontally unobserved column exactly empty.
function interpolateVerticalTransitions(field) {
  const passes = field.verticalSmoothingPasses;
  if (passes < 1) return;

  const planeSize = field.nx * field.ny;
  const smoothed = new Float32Array(field.values.length);
  for (let pass = 0; pass < passes; pass += 1) {
    for (let z = 0; z < field.nz; z += 1) {
      const zOffset = z * planeSize;
      const belowOffset = (z - 1) * planeSize;
      const aboveOffset = (z + 1) * planeSize;
      for (let index = 0; index < planeSize; index += 1) {
        const below = z > 0 ? field.values[belowOffset + index] : 0;
        const current = field.values[zOffset + index];
        const above = z + 1 < field.nz ? field.values[aboveOffset + index] : 0;
        smoothed[zOffset + index] = below * 0.25 + current * 0.5 + above * 0.25;
      }
    }
    field.values.set(smoothed);
  }
}

export function sampleObservedCoverageField(field, eastNm, northNm, altitudeFt) {
  const gx = (eastNm - field.minEastNm) / field.horizontalStepNm;
  const gy = (northNm - field.minNorthNm) / field.horizontalStepNm;
  const gz = (altitudeFt - field.minAltitudeFt) / field.verticalStepFt;
  if (gx < 0 || gy < 0 || gz < 0 || gx > field.nx - 1 || gy > field.ny - 1 || gz > field.nz - 1) return 0;

  const x0 = Math.min(field.nx - 2, Math.floor(gx));
  const y0 = Math.min(field.ny - 2, Math.floor(gy));
  const z0 = Math.min(field.nz - 2, Math.floor(gz));
  const tx = clamp(gx - x0, 0, 1);
  const ty = clamp(gy - y0, 0, 1);
  const tz = clamp(gz - z0, 0, 1);
  let value = 0;
  for (let dz = 0; dz <= 1; dz += 1) {
    for (let dy = 0; dy <= 1; dy += 1) {
      for (let dx = 0; dx <= 1; dx += 1) {
        const weight = (dx ? tx : 1 - tx) * (dy ? ty : 1 - ty) * (dz ? tz : 1 - tz);
        value += field.values[gridIndex(field, x0 + dx, y0 + dy, z0 + dz)] * weight;
      }
    }
  }
  return value;
}

export function buildObservedCoverageField(rows, origin, rawOptions = {}) {
  let horizontalStepNm = Math.max(0.75, Number(rawOptions.horizontalStepNm) || 2);
  let verticalStepFt = Math.max(250, Number(rawOptions.verticalStepFt) || 800);
  const supportHorizontalRatio = Math.max(1.25, (Number(rawOptions.horizontalSupportNm) || 4.5) / horizontalStepNm);
  const supportVerticalRatio = Math.max(1.25, (Number(rawOptions.verticalSupportFt) || 2500) / verticalStepFt);
  const maxCells = Math.max(25000, Number(rawOptions.maxCells) || 1200000);
  const requestedIsoLevel = clamp(Number(rawOptions.isoLevel) || 0.16, 0.02, 0.8);
  const rawInterpolationCells = Number(rawOptions.horizontalInterpolationCells);
  const horizontalInterpolationCells = clamp(
    Number.isFinite(rawInterpolationCells) ? Math.floor(rawInterpolationCells) : 2,
    0,
    3,
  );
  const rawHorizontalSmoothingPasses = Number(rawOptions.horizontalSmoothingPasses);
  const horizontalSmoothingPasses = clamp(
    Number.isFinite(rawHorizontalSmoothingPasses) ? Math.floor(rawHorizontalSmoothingPasses) : 2,
    0,
    2,
  );
  const rawVerticalSmoothingPasses = Number(rawOptions.verticalSmoothingPasses);
  const verticalSmoothingPasses = clamp(
    Number.isFinite(rawVerticalSmoothingPasses) ? Math.floor(rawVerticalSmoothingPasses) : 4,
    0,
    4,
  );
  const cosLat = Math.cos(Number(origin.lat) * Math.PI / 180) || 1e-6;
  const points = rows.map((row) => localPoint(row, origin, cosLat)).filter(Boolean);
  if (points.length < 4) return null;

  let options;
  let bounds;
  let shape;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    options = {
      horizontalStepNm,
      verticalStepFt,
      horizontalSupportNm: supportHorizontalRatio * horizontalStepNm,
      verticalSupportFt: supportVerticalRatio * verticalStepFt,
      horizontalInterpolationCells,
      horizontalSmoothingPasses,
      verticalSmoothingPasses,
      maxSegmentSeconds: Math.max(15, Number(rawOptions.maxSegmentSeconds) || 90),
      maxSegmentNm: Math.max(2, Number(rawOptions.maxSegmentNm) || 15),
      maxSegmentAltitudeFt: Math.max(1000, Number(rawOptions.maxSegmentAltitudeFt) || 6000),
    };
    bounds = fieldBounds(points, options);
    shape = gridShape(bounds, horizontalStepNm, verticalStepFt);
    if (shape.gridNodes <= maxCells) break;
    const scale = Math.max(1.08, Math.cbrt(shape.gridNodes / maxCells) * 1.04);
    horizontalStepNm *= scale;
    verticalStepFt *= scale;
  }
  if (shape.gridNodes > maxCells) {
    throw new Error(`coverage occupancy grid ${shape.nx}x${shape.ny}x${shape.nz} exceeds ${maxCells} nodes`);
  }

  const samples = coverageSamples(points, options);
  const field = {
    ...shape,
    ...options,
    minEastNm: bounds.minEastNm,
    minNorthNm: bounds.minNorthNm,
    minAltitudeFt: bounds.minAltitudeFt,
    values: new Float32Array(shape.gridNodes),
    points,
    samples,
    isoLevel: requestedIsoLevel,
  };

  for (const point of samples) {
    const minX = Math.max(0, Math.ceil((point.eastNm - field.horizontalSupportNm - field.minEastNm) / horizontalStepNm));
    const maxX = Math.min(field.nx - 1, Math.floor((point.eastNm + field.horizontalSupportNm - field.minEastNm) / horizontalStepNm));
    const minY = Math.max(0, Math.ceil((point.northNm - field.horizontalSupportNm - field.minNorthNm) / horizontalStepNm));
    const maxY = Math.min(field.ny - 1, Math.floor((point.northNm + field.horizontalSupportNm - field.minNorthNm) / horizontalStepNm));
    const minZ = Math.max(0, Math.ceil((point.altitudeFt - field.verticalSupportFt - field.minAltitudeFt) / verticalStepFt));
    const maxZ = Math.min(field.nz - 1, Math.floor((point.altitudeFt + field.verticalSupportFt - field.minAltitudeFt) / verticalStepFt));
    for (let z = minZ; z <= maxZ; z += 1) {
      const dz = (field.minAltitudeFt + z * verticalStepFt - point.altitudeFt) / field.verticalSupportFt;
      for (let y = minY; y <= maxY; y += 1) {
        const dy = (field.minNorthNm + y * horizontalStepNm - point.northNm) / field.horizontalSupportNm;
        for (let x = minX; x <= maxX; x += 1) {
          const dx = (field.minEastNm + x * horizontalStepNm - point.eastNm) / field.horizontalSupportNm;
          const distanceSquared = dx * dx + dy * dy + dz * dz;
          if (distanceSquared >= 1) continue;
          const strength = (1 - distanceSquared) ** 2;
          const index = gridIndex(field, x, y, z);
          if (strength > field.values[index]) field.values[index] = strength;
        }
      }
    }
  }

  interpolateNarrowHorizontalGaps(field);
  smoothHorizontalTransitions(field);
  interpolateVerticalTransitions(field);

  let minObservedField = Infinity;
  for (const point of points) {
    minObservedField = Math.min(minObservedField, sampleObservedCoverageField(field, point.eastNm, point.northNm, point.altitudeFt));
  }
  field.isoLevel = Math.min(requestedIsoLevel, minObservedField * 0.9);
  field.minObservedField = minObservedField;
  return field;
}

function pushQuad(indices, ids, reverse) {
  const [a, b, c, d] = reverse ? [ids[0], ids[3], ids[2], ids[1]] : ids;
  if (new Set([a, b, c, d]).size < 4) return;
  indices.push(a, b, c, a, c, d);
}

export function polygonizeObservedCoverageField(field, rawOptions = {}) {
  const isoLevel = field.isoLevel;
  const maxTriangles = Math.max(1000, Number(rawOptions.maxTriangles) || 200000);
  const cellIds = new Int32Array((field.nx - 1) * (field.ny - 1) * (field.nz - 1));
  cellIds.fill(-1);
  const positions = [];

  for (let z = 0; z < field.nz - 1; z += 1) {
    for (let y = 0; y < field.ny - 1; y += 1) {
      for (let x = 0; x < field.nx - 1; x += 1) {
        const values = CUBE_OFFSETS.map(([dx, dy, dz]) => field.values[gridIndex(field, x + dx, y + dy, z + dz)]);
        const insideCount = values.reduce((count, value) => count + (value >= isoLevel ? 1 : 0), 0);
        if (insideCount === 0 || insideCount === 8) continue;
        const points = CUBE_OFFSETS.map(([dx, dy, dz]) => gridPoint(field, x + dx, y + dy, z + dz));
        const crossings = [];
        for (const [a, b] of CUBE_EDGES) {
          if ((values[a] >= isoLevel) === (values[b] >= isoLevel)) continue;
          crossings.push(interpolate(points[a], points[b], values[a], values[b], isoLevel));
        }
        if (!crossings.length) continue;
        const vertex = crossings.reduce((sum, point) => [sum[0] + point[0], sum[1] + point[1], sum[2] + point[2]], [0, 0, 0])
          .map((value) => value / crossings.length);
        const id = positions.length / 3;
        positions.push(...vertex);
        cellIds[cellIndex(field, x, y, z)] = id;
      }
    }
  }

  const cellId = (x, y, z) => cellIds[cellIndex(field, x, y, z)];
  const indices = [];
  const crossing = (a, b) => (a >= isoLevel) !== (b >= isoLevel);
  const addQuad = (ids, reverse) => {
    if (ids.some((id) => id < 0)) return;
    pushQuad(indices, ids, reverse);
    if (indices.length / 3 > maxTriangles) throw new Error(`coverage occupancy mesh exceeds ${maxTriangles} triangles`);
  };

  // One quad surrounds every sign-changing grid edge. The four adjacent active cells share their
  // surface-net vertices, producing a compact, watertight indexed mesh instead of triangle soup.
  for (let z = 1; z < field.nz - 1; z += 1) {
    for (let y = 1; y < field.ny - 1; y += 1) {
      for (let x = 0; x < field.nx - 1; x += 1) {
        const a = field.values[gridIndex(field, x, y, z)];
        const b = field.values[gridIndex(field, x + 1, y, z)];
        if (crossing(a, b)) addQuad([
          cellId(x, y - 1, z - 1), cellId(x, y, z - 1), cellId(x, y, z), cellId(x, y - 1, z),
        ], a >= isoLevel);
      }
    }
  }
  for (let z = 1; z < field.nz - 1; z += 1) {
    for (let y = 0; y < field.ny - 1; y += 1) {
      for (let x = 1; x < field.nx - 1; x += 1) {
        const a = field.values[gridIndex(field, x, y, z)];
        const b = field.values[gridIndex(field, x, y + 1, z)];
        if (crossing(a, b)) addQuad([
          cellId(x - 1, y, z - 1), cellId(x - 1, y, z), cellId(x, y, z), cellId(x, y, z - 1),
        ], a < isoLevel);
      }
    }
  }
  for (let z = 0; z < field.nz - 1; z += 1) {
    for (let y = 1; y < field.ny - 1; y += 1) {
      for (let x = 1; x < field.nx - 1; x += 1) {
        const a = field.values[gridIndex(field, x, y, z)];
        const b = field.values[gridIndex(field, x, y, z + 1)];
        if (crossing(a, b)) addQuad([
          cellId(x - 1, y - 1, z), cellId(x, y - 1, z), cellId(x, y, z), cellId(x - 1, y, z),
        ], a >= isoLevel);
      }
    }
  }

  return { positions: Float32Array.from(positions), indices };
}

export function smoothIndexedCoverageSurface(surface, rawIterations = 2) {
  const vertexCount = surface.positions.length / 3;
  const iterations = clamp(Math.floor(Number(rawIterations) || 0), 0, 5);
  if (iterations === 0 || vertexCount < 4) return surface;

  const neighbors = Array.from({ length: vertexCount }, () => new Set());
  const connect = (a, b) => {
    if (a === b) return;
    neighbors[a].add(b);
    neighbors[b].add(a);
  };
  for (let i = 0; i < surface.indices.length; i += 3) {
    const a = surface.indices[i];
    const b = surface.indices[i + 1];
    const c = surface.indices[i + 2];
    connect(a, b);
    connect(b, c);
    connect(c, a);
  }

  let positions = Float32Array.from(surface.positions);
  const pass = (factor) => {
    const next = new Float32Array(positions.length);
    for (let vertex = 0; vertex < vertexCount; vertex += 1) {
      const adjacent = neighbors[vertex];
      if (!adjacent.size) {
        next.set(positions.subarray(vertex * 3, vertex * 3 + 3), vertex * 3);
        continue;
      }
      const average = [0, 0, 0];
      for (const neighbor of adjacent) {
        average[0] += positions[neighbor * 3];
        average[1] += positions[neighbor * 3 + 1];
        average[2] += positions[neighbor * 3 + 2];
      }
      for (let axis = 0; axis < 3; axis += 1) {
        average[axis] /= adjacent.size;
        const index = vertex * 3 + axis;
        next[index] = positions[index] + factor * (average[axis] - positions[index]);
      }
    }
    positions = next;
  };

  // A positive Laplacian pass rounds grid corners; the short negative pass restores most
  // of the lost volume. A few Taubin-style cycles soften the surface without moving
  // topology or bridging any occupancy gap.
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    pass(0.42);
    pass(-0.44);
  }
  return { positions, indices: surface.indices };
}

function surfaceTopologyCounts(surface) {
  const vertexCount = surface.positions.length / 3;
  const edges = new Map();
  for (let index = 0; index < surface.indices.length; index += 3) {
    const triangle = [
      surface.indices[index],
      surface.indices[index + 1],
      surface.indices[index + 2],
    ];
    for (const [a, b] of [
      [triangle[0], triangle[1]],
      [triangle[1], triangle[2]],
      [triangle[2], triangle[0]],
    ]) {
      const low = Math.min(a, b);
      const high = Math.max(a, b);
      const key = low * vertexCount + high;
      edges.set(key, (edges.get(key) || 0) + 1);
    }
  }
  let openEdges = 0;
  let nonManifoldEdges = 0;
  for (const count of edges.values()) {
    if (count === 1) openEdges += 1;
    else if (count > 2) nonManifoldEdges += 1;
  }
  return { openEdges, nonManifoldEdges };
}

function encodeQuantizedMesh(surface) {
  const vertexCount = surface.positions.length / 3;
  const bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < surface.positions.length; i += 3) {
    bounds[0] = Math.min(bounds[0], surface.positions[i]);
    bounds[1] = Math.min(bounds[1], surface.positions[i + 1]);
    bounds[2] = Math.min(bounds[2], surface.positions[i + 2]);
    bounds[3] = Math.max(bounds[3], surface.positions[i]);
    bounds[4] = Math.max(bounds[4], surface.positions[i + 1]);
    bounds[5] = Math.max(bounds[5], surface.positions[i + 2]);
  }
  const spans = [
    Math.max(1e-6, bounds[3] - bounds[0]),
    Math.max(1e-6, bounds[4] - bounds[1]),
    Math.max(1e-6, bounds[5] - bounds[2]),
  ];
  const quantized = new Uint16Array(surface.positions.length);
  for (let i = 0; i < surface.positions.length; i += 1) {
    const axis = i % 3;
    quantized[i] = Math.round((surface.positions[i] - bounds[axis]) / spans[axis] * 65535);
  }
  const IndexArray = vertexCount <= 65535 ? Uint16Array : Uint32Array;
  const indices = IndexArray.from(surface.indices);
  return {
    encoding: "quantized-uint16-le-base64",
    positions: Buffer.from(quantized.buffer).toString("base64"),
    positionBounds: bounds.map((value) => Number(value.toFixed(3))),
    indexEncoding: IndexArray === Uint16Array ? "uint16-le-base64" : "uint32-le-base64",
    indices: Buffer.from(indices.buffer).toString("base64"),
    vertexCount,
    triangleCount: indices.length / 3,
    binaryBytes: quantized.byteLength + indices.byteLength,
  };
}

export function buildObservedCoverageMesh(rows, origin, options = {}) {
  const startedAt = performance.now();
  const field = buildObservedCoverageField(rows, origin, options);
  if (!field) return null;
  const initialIsoLevel = field.isoLevel;
  let rawSurface = null;
  let topology = { openEdges: Infinity, nonManifoldEdges: Infinity };
  let selectedIsoLevel = initialIsoLevel;
  for (const factor of [1, 0.875, 0.75]) {
    field.isoLevel = Math.max(0.02, initialIsoLevel * factor);
    const candidate = polygonizeObservedCoverageField(field, options);
    const candidateTopology = surfaceTopologyCounts(candidate);
    const score = candidateTopology.openEdges * 1000000 + candidateTopology.nonManifoldEdges;
    const bestScore = topology.openEdges * 1000000 + topology.nonManifoldEdges;
    if (score < bestScore) {
      rawSurface = candidate;
      topology = candidateTopology;
      selectedIsoLevel = field.isoLevel;
    }
    if (score === 0) break;
  }
  if (topology.openEdges !== 0) {
    throw new Error(`coverage occupancy surface has ${topology.openEdges} open edges`);
  }
  field.isoLevel = selectedIsoLevel;
  const rawSmoothingIterations = Number(options.smoothingIterations);
  const smoothingIterations = clamp(
    Number.isFinite(rawSmoothingIterations) ? Math.floor(rawSmoothingIterations) : 5,
    0,
    5,
  );
  const surface = smoothIndexedCoverageSurface(rawSurface, smoothingIterations);
  if (!surface.positions.length || !surface.indices.length) return null;
  const encoded = encodeQuantizedMesh(surface);
  const occupiedNodes = field.values.reduce((count, value) => count + (value >= field.isoLevel ? 1 : 0), 0);
  return {
    type: "observed-occupancy-surface",
    origin: [Number(origin.lon.toFixed(6)), Number(origin.lat.toFixed(6))],
    ...encoded,
    sourcePointCount: field.points.length,
    samplePointCount: field.samples.length,
    horizontalStepNm: Number(field.horizontalStepNm.toFixed(3)),
    verticalStepFt: Number(field.verticalStepFt.toFixed(1)),
    supportHorizontalNm: Number(field.horizontalSupportNm.toFixed(3)),
    supportVerticalFt: Number(field.verticalSupportFt.toFixed(1)),
    horizontalInterpolationCells: field.horizontalInterpolationCells,
    horizontalSmoothingPasses: field.horizontalSmoothingPasses,
    verticalSmoothingPasses: field.verticalSmoothingPasses,
    smoothingIterations,
    isoLevel: Number(field.isoLevel.toFixed(6)),
    stats: {
      grid: [field.nx, field.ny, field.nz],
      gridNodes: field.values.length,
      occupiedNodes,
      nonManifoldEdges: topology.nonManifoldEdges,
      minObservedField: Number(field.minObservedField.toFixed(6)),
      generatedMs: Math.round((performance.now() - startedAt) * 10) / 10,
      binaryBytes: encoded.binaryBytes,
    },
  };
}
