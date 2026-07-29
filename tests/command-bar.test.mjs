import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Button state, station visibility and desktop/mobile layout are exercised in tests/e2e. These
// two source contracts remain because they protect ordering shared by the map and alert surfaces.
const app = await readFile(new URL("../web/src/App.vue", import.meta.url), "utf8");

function block(startText, endText) {
  const start = app.indexOf(startText);
  assert.notEqual(start, -1, `${startText} must exist`);
  const end = app.indexOf(endText, start + startText.length);
  assert.notEqual(end, -1, `${endText} must follow ${startText}`);
  return app.slice(start, end);
}

test("display counts use the same filter and drop predicates as the rendered aircraft", () => {
  const counts = block("const hudCounts = computed(", "const receiverStatus");
  assert.match(counts, /passesFilters\(item\)/);
  assert.match(counts, /isDropped\(item\)/);
  // The list is capped for DOM cost; deriving the display count from it would under-report.
  assert.doesNotMatch(counts, /filteredAircraft/);
});

test("emergencies are counted before display filters can hide their aircraft", () => {
  const counts = block("const hudCounts = computed(", "const receiverStatus");
  assert.ok(
    counts.indexOf("aircraftAlert(item)") < counts.indexOf("passesFilters(item)"),
    "aircraftAlert must be evaluated before the filter guard",
  );
});
