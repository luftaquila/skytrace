import test from "node:test";
import assert from "node:assert/strict";

import { aircraftAttitudeMatrix } from "../web/src/aircraft-layer.js";

function direction(matrix, [x, y, z]) {
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z,
    matrix[1] * x + matrix[5] * y + matrix[9] * z,
    matrix[2] * x + matrix[6] * y + matrix[10] * z,
  ];
}

function near(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-12, `${message}: expected ${expected}, got ${actual}`);
}

test("model span axis resolves to physical left and right after compass yaw", () => {
  // Northbound: +X nose points north. Consequently +Y is west/left and -Y east/right.
  const levelNorth = aircraftAttitudeMatrix(90, 0, 0);
  const leftWing = direction(levelNorth, [0, 1, 0]);
  const rightWing = direction(levelNorth, [0, -1, 0]);

  near(leftWing[0], -1, "left wing points west");
  near(rightWing[0], 1, "right wing points east");
  near(leftWing[2], 0, "left wing is level");
  near(rightWing[2], 0, "right wing is level");
});

test("negative ADS-B bank lowers the left wing and positive bank lowers the right wing", () => {
  const leftBank = aircraftAttitudeMatrix(90, 0, -20);
  assert.ok(direction(leftBank, [0, 1, 0])[2] < 0, "left bank must lower physical left wing (+Y)");
  assert.ok(direction(leftBank, [0, -1, 0])[2] > 0, "left bank must raise physical right wing (-Y)");

  const rightBank = aircraftAttitudeMatrix(90, 0, 20);
  assert.ok(direction(rightBank, [0, -1, 0])[2] < 0, "right bank must lower physical right wing (-Y)");
  assert.ok(direction(rightBank, [0, 1, 0])[2] > 0, "right bank must raise physical left wing (+Y)");
});
