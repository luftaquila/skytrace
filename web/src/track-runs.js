export const TRACK_BREAK_MS = 10 * 60 * 1000;

function hasPosition(point) {
  return point?.lat != null && point?.lon != null;
}

// A hex can be reused across multiple flights. The current flight is the final continuous
// positioned run; a receiver silence longer than ten minutes starts a new run.
export function currentTrackRun(points, gapMs = TRACK_BREAK_MS) {
  const positioned = (points || []).filter(hasPosition);
  let start = 0;
  let previousTime = null;

  for (let index = 0; index < positioned.length; index += 1) {
    const time = Date.parse(positioned[index].positionAt);
    if (Number.isFinite(time) && Number.isFinite(previousTime) && time - previousTime > gapMs) start = index;
    if (Number.isFinite(time)) previousTime = time;
  }

  return positioned.slice(start);
}

function pointKey(point) {
  if (Number.isSafeInteger(point?.id)) return `id:${point.id}`;
  return [point?.positionAt, point?.lat, point?.lon, point?.altBaro, point?.altGeom].join("|");
}

export function mergeTrackPoints(current, incoming, historic = false) {
  const base = current || [];
  const additions = (incoming || []).filter(hasPosition);
  if (!additions.length) return base;
  const tailId = Number(base.at(-1)?.id);
  if (
    base.length
    && Number.isSafeInteger(tailId)
    && additions.every((point, index) => Number.isSafeInteger(point.id)
      && point.id > tailId
      && (index === 0 || point.id > additions[index - 1].id))
  ) {
    const appended = [...base, ...additions];
    return historic ? appended : currentTrackRun(appended);
  }
  const merged = new Map();
  for (const point of [...base, ...additions]) {
    if (hasPosition(point)) merged.set(pointKey(point), point);
  }
  const sorted = [...merged.values()].sort((a, b) => {
    const timeDelta = Date.parse(a.positionAt) - Date.parse(b.positionAt);
    return timeDelta || (Number(a.id) || 0) - (Number(b.id) || 0);
  });
  if (sorted.length === base.length && sorted.every((point, index) => point === base[index])) {
    return base;
  }
  return historic ? sorted : currentTrackRun(sorted);
}

export function reconcilePlaybackIndex(previousPoints, nextPoints, currentIndex) {
  const previous = previousPoints || [];
  const next = nextPoints || [];
  if (!next.length) return 0;

  const previousLatest = Math.max(0, previous.length - 1);
  const nextLatest = next.length - 1;
  if (!previous.length || currentIndex >= previousLatest) return nextLatest;

  const selectedId = previous[Math.min(Math.max(0, currentIndex), previousLatest)]?.id;
  if (selectedId != null) {
    const anchoredIndex = next.findIndex((point) => point.id === selectedId);
    if (anchoredIndex >= 0) return anchoredIndex;
  }
  return Math.min(Math.max(0, currentIndex), nextLatest);
}
