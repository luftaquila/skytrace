const EARTH_RADIUS_NM = 3440.065;

function radians(degrees) {
  return degrees * Math.PI / 180;
}

function unitPoint(pos) {
  const lat = radians(pos.lat);
  const lon = radians(pos.lng);
  const cosLat = Math.cos(lat);
  return [cosLat * Math.cos(lon), cosLat * Math.sin(lon), Math.sin(lat)];
}

function greatCircleNm(a, b) {
  const lat1 = radians(a.lat);
  const lat2 = radians(b.lat);
  const dLat = lat2 - lat1;
  const dLon = radians(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function spatialConflictPairs(rows, maxDistNm, maxVertFt) {
  if (!(maxDistNm > 0) || !(maxVertFt >= 0)) return [];
  const chord = 2 * Math.sin(Math.min(Math.PI, maxDistNm / EARTH_RADIUS_NM) / 2);
  const cellSize = Math.max(chord, 1e-9);
  const grid = new Map();
  const coordinates = rows.map((row) => unitPoint(row.pos));
  const key = (x, y, z) => `${x}:${y}:${z}`;
  const cells = coordinates.map(([x, y, z], index) => {
    const cell = [Math.floor(x / cellSize), Math.floor(y / cellSize), Math.floor(z / cellSize)];
    const bucketKey = key(...cell);
    const bucket = grid.get(bucketKey) || [];
    bucket.push(index);
    grid.set(bucketKey, bucket);
    return cell;
  });
  const pairs = [];
  for (let i = 0; i < rows.length; i += 1) {
    const [cx, cy, cz] = cells[i];
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dz = -1; dz <= 1; dz += 1) {
          for (const j of grid.get(key(cx + dx, cy + dy, cz + dz)) || []) {
            if (j <= i) continue;
            const vertFt = Math.abs(rows[i].alt - rows[j].alt);
            if (vertFt > maxVertFt) continue;
            const distNm = greatCircleNm(rows[i].pos, rows[j].pos);
            if (distNm <= maxDistNm) {
              pairs.push({ a: rows[i].item, b: rows[j].item, distNm, vertFt });
            }
          }
        }
      }
    }
  }
  return pairs;
}
