import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../web/src/tactical3d.js", import.meta.url), "utf8");

// Slice the source between two literal markers; both must exist and be in order.
function between(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `${startMarker} must exist`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `${endMarker} must follow ${startMarker}`);
  return source.slice(start, end);
}

test("the camera owns every touch gesture, not MapLibre", () => {
  // dragPan was already off (which is why phones could not pan at all); the two-finger handlers
  // join it so nothing double-drives the elevated 3D orbit pivot.
  assert.match(source, /map\.dragPan\.disable\(\)/);
  assert.match(source, /map\.touchZoomRotate\.disable\(\)/);
  assert.match(source, /map\.touchPitch\.disable\(\)/);
  assert.match(source, /container\.style\.touchAction = "none"/);
});

test("one finger pans and detaches an orbit, exactly like the mouse right-drag", () => {
  const move = between("const onTouchMove = (e) => {", "const onTouchUp = (e) => {");
  assert.match(move, /queueCameraPan\(e\.clientX - touchPan\.x, e\.clientY - touchPan\.y\)/);
  assert.match(move, /clearOrbit\(\)/);
  // A pan only begins past the tap slop, so a tap never nudges the camera.
  assert.ok(move.indexOf("TAP_SLOP_PX") < move.indexOf("queueCameraPan"));
});

test("zoom, rotate and tilt engage per axis so one gesture can do all three", () => {
  const apply = between("function applyTwoFinger() {", "const onTouchDown = (e) => {");
  // An exclusive mode lock made horizontal rotation and vertical rotation impossible to combine.
  assert.equal(apply.includes("twoFinger.mode"), false);
  assert.match(apply, /if \(!zoom\.on && Math\.abs\(spread - twoFinger\.spread\) > PINCH_THRESHOLD_PX\)/);
  assert.match(apply, /if \(!bearing\.on && Math\.abs\(wrapDelta\(twist - twoFinger\.twist\)\) > TWIST_THRESHOLD_DEG\)/);
  assert.match(apply, /if \(!pitch\.on && Math\.abs\(parallelY\) > TILT_THRESHOLD_PX\)/);
  // Each axis is re-baselined the moment it engages, so engaging one never jumps the camera.
  assert.match(apply, /zoom\.base = spread;\s*\n\s*zoom\.camera = map\.getZoom\(\)/);
  assert.match(apply, /pitch\.base = parallelY;\s*\n\s*pitch\.camera = map\.getPitch\(\)/);
  // All three are written into ONE camera frame, not into competing ones.
  const frame = apply.slice(apply.indexOf("const frame = {"));
  assert.match(frame, /if \(zoom\.on\) \{[\s\S]*frame\.zoom/);
  assert.match(frame, /if \(bearing\.on\)/);
  assert.match(frame, /if \(pitch\.on\) frame\.pitch/);
});

test("a two-finger gesture can zoom, rotate and tilt at the same time", () => {
  const apply = between("function applyTwoFinger() {", "const onTouchDown = (e) => {");
  // Nothing gates one axis on another being idle: all three are tested and applied every move.
  const zoomAt = apply.indexOf("if (zoom.on) {");
  const bearingAt = apply.indexOf("if (bearing.on) {");
  const pitchAt = apply.indexOf("if (pitch.on) frame.pitch");
  assert.ok(zoomAt > 0 && bearingAt > zoomAt && pitchAt > bearingAt);
  const activation = apply.slice(
    apply.indexOf("if (!zoom.on"),
    apply.indexOf("if (!zoom.on && !bearing.on && !pitch.on)"),
  );
  assert.equal(activation.includes("else if"), false);
  // One queued camera frame carries whichever axes are live.
  assert.equal((apply.match(/queueCameraFrame\(/g) || []).length, 1);
});

test("tilt reads the centroid, which a rotation and a pinch both leave untouched", () => {
  const apply = between("function applyTwoFinger() {", "const onTouchDown = (e) => {");
  // A rotation moves the fingers in opposite vertical directions and a pinch moves them apart, so
  // both contribute zero here — only a real two-finger slide does. Taking the smaller of the two
  // fingers' travel instead reported barely a degree of tilt during a combined gesture.
  assert.match(apply, /const parallelY = \(points\[0\]\.y - twoFinger\.start\[0\]\.y \+ points\[1\]\.y - twoFinger\.start\[1\]\.y\) \/ 2/);
});

test("two-finger zoom and rotate stay anchored on the active orbit target", () => {
  const apply = between("function applyTwoFinger() {", "const onTouchDown = (e) => {");
  assert.match(apply, /const target = activeOrbitTarget\(\)/);
  assert.match(apply, /center: target \? \[target\.lon, target\.lat\] : null/);
  assert.match(apply, /elevation: target \? target\.z \|\| 0 : currentElevation/);
  // Fingers turning clockwise decrease the bearing, matching MapLibre's own touch rotate, and the
  // twist accumulates per frame so a rotation past 180 degrees keeps going instead of folding back.
  assert.match(apply, /bearing\.total \+= wrapDelta\(twist - bearing\.prev\)/);
  assert.match(apply, /frame\.bearing = bearing\.camera - bearing\.total/);
  assert.match(apply, /frame\.zoom = zoom\.camera \+ Math\.log2\(spread \/ Math\.max\(1, zoom\.base\)\)/);
});

test("a detached pinch lowers the aircraft pivot only while its midpoint stays ground-pinned", () => {
  const begin = between("function beginTwoFinger() {", "function applyTwoFinger() {");
  const apply = between("function applyTwoFinger() {", "const onTouchDown = (e) => {");
  assert.match(begin, /anchor: null/);
  assert.match(apply, /zoom\.anchor = freeGrounding[\s\S]*\? groundZoomAnchor\(point\)[\s\S]*: flatZoomAnchor\(point\)/);
  assert.match(apply, /freeViewElevationForZoom\(\{/);
  assert.match(apply, /pinGroundLocationAtPoint\(probe, zoom\.anchor\)/);
  assert.match(apply, /frame\.elevation = currentElevation[\s\S]*const currentLoc = live\.screenPointToLocation\(zoom\.anchor\.point\)/);
  assert.doesNotMatch(apply, /flatLoc|grounding: true/);
});

test("lifting one finger re-anchors instead of jumping, and is never read as a tap", () => {
  const up = between("const onTouchUp = (e) => {", "container.addEventListener(\"pointerdown\"");
  assert.match(up, /touchMoved = true/);
  assert.match(up, /beginTwoFinger\(\)/);
  assert.match(up, /const \[survivor\] = orderedTouches\(\)/);
  // Only a released last finger that never moved, within TAP_MAX_MS, counts as a tap.
  assert.match(up, /if \(pan && !touchMoved && e\.type === "pointerup" && performance\.now\(\) - pan\.at < TAP_MAX_MS\)/);
});

test("taps reuse the mouse click and double-click actions rather than re-implementing them", () => {
  const tap = between("function handleTouchTap(point) {", "function canvasPoint(event) {");
  assert.match(tap, /handleTap\(px, py, point\.x, point\.y, performance\.now\(\), TOUCH_REPEAT_RADIUS_PX\)/);
  assert.match(tap, /handleDoubleTap\(px, py\)/);
  // The single-tap action fires immediately: no double-tap disambiguation delay before selecting.
  assert.ok(tap.indexOf("handleTap(px, py") < tap.indexOf("if (isSecondTap)"));
  assert.doesNotMatch(tap, /setTimeout/);
});

test("touch compatibility mouse events cannot double-drive the camera or the hover state", () => {
  const guard = between("function isTouchCompatibilityEvent() {", "function orderedTouches() {");
  assert.match(guard, /performance\.now\(\) - lastTouchAt < SYNTHETIC_MOUSE_MS/);
  for (const handler of ["const onCanvasClick", "const onCanvasDoubleClick", "const onCanvasPointerMove"]) {
    const start = source.indexOf(handler);
    assert.notEqual(start, -1, `${handler} must exist`);
    const body = source.slice(start, source.indexOf("};", start));
    assert.match(body, /isTouchCompatibilityEvent\(\)/, `${handler} must ignore touch replays`);
  }
  assert.doesNotMatch(source, /map\.on\("(?:click|dblclick|mousemove)"/);
  const onDown = source.slice(source.indexOf("const onDown = (e) => {"), source.indexOf("const onMove = (e) => {"));
  assert.match(onDown, /if \(isTouchCompatibilityEvent\(\)\) return/);
});

test("the touch listeners are torn down with the map", () => {
  const destroy = between("function destroy() {", "const hideLoading =");
  assert.match(destroy, /window\.removeEventListener\("pointermove", onTouchMove\)/);
  assert.match(destroy, /window\.removeEventListener\("pointerup", onTouchUp\)/);
  assert.match(destroy, /window\.removeEventListener\("pointercancel", onTouchUp\)/);
  assert.match(destroy, /cv\.removeEventListener\("click", onCanvasClick\)/);
  assert.match(destroy, /cv\.removeEventListener\("dblclick", onCanvasDoubleClick\)/);
  assert.match(destroy, /cv\.removeEventListener\("pointermove", onCanvasPointerMove\)/);
  assert.match(destroy, /cv\.removeEventListener\("wheel", onWheel\)/);
});

test("the pin control keeps its tap without hijacking a two-finger gesture", () => {
  const down = between("const onTouchDown = (e) => {", "const onTouchMove = (e) => {");
  // Scoped to the pin, and only while no gesture is running: skipping every touch that landed on a
  // label meant a second finger on one was never tracked, degrading a two-finger gesture into a
  // one-finger pan — which detaches tracking.
  assert.match(down, /if \(!touchPoints\.size && e\.target\?\.closest\?\.\(".tt-pin, .tt-close"\)\) \{/);
  // The pin path still stamps the touch time: its compatibility mouseover must not arm the hover
  // label forever on a phone (mouseout never follows a touch).
  const pinBranch = down.slice(down.indexOf('".tt-pin'), down.indexOf("// Cancels the browser's"));
  assert.match(pinBranch, /lastTouchAt = performance\.now\(\)/);
  // A touch landing on a label body is still tracked as a gesture pointer (its tap is made inert
  // later, at pointerup) — an early return here would degrade two-finger gestures again.
  assert.doesNotMatch(down, /\.t3d-block"\)\) return/);
});
