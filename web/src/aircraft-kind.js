// The two independent axes the 3D view resolves from an ADS-B emitter category:
//
//   SIZE  — planeSizeScale(): the on-screen pixel multiplier. Behaviour is unchanged from when it was
//           the only axis; it still decides which of the three size-bucket jets a target falls into.
//   SHAPE — planeMeshKind(): which mesh in AIRCRAFT_GEOMETRY to draw. Categories with a dedicated
//           silhouette return its key; everything else returns null and falls back to the size bucket,
//           so an unknown, missing or reserved category renders exactly as it always did.
//
// Category letters are DO-260B emitter categories as normalised by the ingest layer ("A7", "B1", …).

const MESH_BY_CATEGORY = {
  A6: "fighter",      // High performance (>5g, >400 kt)
  A7: "helicopter",   // Rotorcraft
  B1: "glider",       // Glider / sailplane
  B2: "airship",      // Lighter-than-air
  B3: "parachute",    // Parachutist / skydiver
  B4: "glider",       // Ultralight / hang-glider / paraglider — the closest silhouette we carry
  B6: "drone",        // Unmanned aerial vehicle
  B7: "spacecraft",   // Space / trans-atmospheric vehicle
  C1: "ground",       // Surface vehicle — emergency
  C2: "ground",       // Surface vehicle — service
};

// Deliberately NOT mapped: A0–A5 (ordinary aeroplanes → size buckets), B0/B5 (no info / reserved),
// C0 (no info) and C3–C5 (obstacles, which are not vehicles and should not be drawn as one).

export function planeMeshKind(category) {
  return MESH_BY_CATEGORY[String(category || "").toUpperCase()] || null;
}

export function planeSizeScale(category) {
  const cat = String(category || "").toUpperCase();
  if (cat === "A1" || cat === "A2" || cat === "B1") return 0.85;
  if (cat === "A4" || cat === "A5") return 1.18;
  return 1;
}

export { MESH_BY_CATEGORY };
