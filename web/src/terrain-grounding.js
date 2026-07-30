const FT_TO_M = 0.3048;

// Keep the geographic contact just above the sampled DEM. The renderer adds a tiny depth bias as
// well; this physical offset prevents exact coplanarity while remaining far below one screen pixel.
export const TERRAIN_CONTACT_OFFSET_M = 0.75;

export function queryTerrainContactElevation(map, longitude, latitude) {
  try {
    const elevation = map.queryTerrainElevation([longitude, latitude]);
    return (Number.isFinite(elevation) ? elevation : 0) + TERRAIN_CONTACT_OFFSET_M;
  } catch {
    // Terrain may be between style/source states. Sea level is the safe temporary fallback; DEM
    // source-data events rebuild the aircraft as soon as the rendered terrain becomes available.
    return TERRAIN_CONTACT_OFFSET_M;
  }
}

export function resolveAircraftTerrainState(item, groundElevation, altitudeExaggeration) {
  const barometric = Number.isFinite(item?.altBaro) ? item.altBaro : null;
  const geometric = Number.isFinite(item?.altGeom) ? item.altGeom : null;
  // A numeric zero without readsb's explicit ground flag is occasionally paired with a useful
  // geometric altitude. Prefer that real airborne measurement instead of pinning it to terrain.
  const altitudeFt = !item?.onGround && barometric === 0 && geometric !== null && geometric !== 0
    ? geometric
    : barometric ?? geometric;
  const grounded = Boolean(item?.onGround) || altitudeFt === null || altitudeFt === 0;
  return {
    altitudeFt,
    grounded,
    airborne: !grounded,
    z: grounded ? groundElevation : altitudeFt * FT_TO_M * altitudeExaggeration,
  };
}
