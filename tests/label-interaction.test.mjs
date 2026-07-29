import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const tactical = await readFile(new URL("../web/src/tactical3d.js", import.meta.url), "utf8");

function between(startMarker, endMarker) {
  const start = tactical.indexOf(startMarker);
  assert.notEqual(start, -1, `${startMarker} must exist`);
  const end = tactical.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `${endMarker} must follow ${startMarker}`);
  return tactical.slice(start, end);
}

test("a data block is camera surface for the mouse, with only the pin as its own control", () => {
  // Without the forward, labelMode "all" turns hundreds of labels into mouse-dead camera area.
  assert.match(tactical, /overlayEl\.addEventListener\("mousedown", \(e\) => \{ if \(!e\.target\?\.closest\?\.\("\.tt-pin"\)\) onDown\(e\); \}\)/);
  assert.match(tactical, /overlayEl\.addEventListener\("contextmenu", \(e\) => e\.preventDefault\(\)\)/);
});

test("a tap that lands on a data block is a read, not a map action", () => {
  // The label must not deselect its own target, nor select whatever sits underneath it.
  const down = between("const onTouchDown = (e) =>", "const onTouchMove");
  assert.match(down, /onBlock: Boolean\(e\.target\?\.closest\?\.\("\.t3d-block"\)\)/);
  const up = between("const onTouchUp = (e) =>", "container.addEventListener");
  assert.match(up, /if \(pan\.onBlock\) lastTap = null;/);
  assert.match(up, /else handleTouchTap\(released\);/);
});

test("the second tap of a tracked double-tap can neither kill the transfer nor undo the toggle", () => {
  // The pointerdown guard mirrors the mouse path: it must not cancel the 900 ms transfer.
  const down = between("const onTouchDown = (e) =>", "const onTouchMove");
  assert.ok(
    down.indexOf("isRepeatedTrackedPointer(e.clientX, e.clientY, lastTouchAt, TOUCH_REPEAT_RADIUS_PX)") <
      down.indexOf("cancelCameraAnimation()"),
    "the repeat guard must run before the animation is cancelled",
  );
  // The repeat radius and the double-tap radius are the same constant: a second tap loose enough
  // to count as a double-tap must also be caught by the guard, or handleTap re-toggles tracking.
  assert.match(tactical, /const TOUCH_REPEAT_RADIUS_PX = 36/);
  const touchTap = between("function handleTouchTap(point)", "\n  }");
  assert.match(touchTap, /Math\.hypot\(point\.x - lastTap\.x, point\.y - lastTap\.y\) < TOUCH_REPEAT_RADIUS_PX/);
  assert.match(touchTap, /handleTap\(px, py, point\.x, point\.y, performance\.now\(\), TOUCH_REPEAT_RADIUS_PX\)/);
});

test("destroy() tears down the touch layer it installed", () => {
  const destroy = between("function destroy() {", "\n  }");
  assert.match(destroy, /container\.removeEventListener\("pointerdown", onTouchDown\)/);
  assert.match(destroy, /container\.style\.touchAction = ""/);
});
