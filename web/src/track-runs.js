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
