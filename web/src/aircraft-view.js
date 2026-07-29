// Merge the authoritative receiver feed with display-only area traffic. Own receiver rows win
// unless every receiver carrying that aircraft is hidden, in which case a network twin remains
// visible.
export function mergeAircraftSources(receiverAircraft, areaAircraft, hiddenReceiverIds = []) {
  if (!areaAircraft.length) return receiverAircraft;
  const hidden = new Set(hiddenReceiverIds);
  const networkByHex = new Map(areaAircraft.map((item) => [item.hex, item]));
  const merged = receiverAircraft.map((item) => {
    const receiverHidden = Array.isArray(item.receivers)
      && item.receivers.length > 0
      && item.receivers.every((id) => hidden.has(id));
    return receiverHidden ? (networkByHex.get(item.hex) || item) : item;
  });
  const ownHexes = new Set(receiverAircraft.map((item) => item.hex));
  return [...merged, ...areaAircraft.filter((item) => !ownHexes.has(item.hex))];
}

export function sortAircraft(rows, key) {
  return rows.map((row, index) => ({
    row,
    index,
    value: key === "altitude" ? ((row.altBaro ?? row.altGeom) ?? -Infinity)
      : key === "speed" ? (row.gs ?? -Infinity)
        : key === "recent" ? Date.parse(row.observedAt)
          : String(row.flight || row.hex),
  })).sort((a, b) => {
    const order = key === "callsign"
      ? a.value.localeCompare(b.value)
      : b.value - a.value;
    return order || a.index - b.index;
  }).map(({ row }) => row);
}
