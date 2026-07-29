import assert from "node:assert/strict";
import test from "node:test";
import { mergeAircraftSources, sortAircraft } from "../web/src/aircraft-view.js";

test("receiver aircraft stay authoritative and network-only traffic fills gaps", () => {
  const receiver = [
    { hex: "own001", flight: "LOCAL", receivers: ["rx-a"] },
    { hex: "own002", flight: "SECOND", receivers: ["rx-b"] },
  ];
  const area = [
    { hex: "own001", flight: "NETWORK", areaFeed: true },
    { hex: "net003", flight: "REMOTE", areaFeed: true },
  ];

  assert.deepEqual(
    mergeAircraftSources(receiver, area).map(({ hex, flight }) => ({ hex, flight })),
    [
      { hex: "own001", flight: "LOCAL" },
      { hex: "own002", flight: "SECOND" },
      { hex: "net003", flight: "REMOTE" },
    ],
  );
});

test("a network twin replaces a receiver row only when every carrying receiver is hidden", () => {
  const local = { hex: "abc123", flight: "LOCAL", receivers: ["rx-a", "rx-b"] };
  const network = { hex: "abc123", flight: "NETWORK", areaFeed: true };

  assert.equal(mergeAircraftSources([local], [network], ["rx-a"])[0], local);
  assert.equal(mergeAircraftSources([local], [network], ["rx-a", "rx-b"])[0], network);
  assert.equal(mergeAircraftSources([local], [], ["rx-a", "rx-b"])[0], local);
});

test("aircraft sorting handles fallbacks and preserves input order for ties", () => {
  const rows = [
    { hex: "bbb222", flight: "", altGeom: 12000, gs: 200, observedAt: "2026-01-01T00:00:01Z" },
    { hex: "aaa111", flight: "ALPHA", altBaro: 12000, gs: null, observedAt: "2026-01-01T00:00:03Z" },
    { hex: "ccc333", flight: "CHARLIE", altBaro: 9000, gs: 300, observedAt: "2026-01-01T00:00:02Z" },
  ];

  assert.deepEqual(sortAircraft(rows, "altitude").map((row) => row.hex), [
    "bbb222",
    "aaa111",
    "ccc333",
  ]);
  assert.deepEqual(sortAircraft(rows, "speed").map((row) => row.hex), [
    "ccc333",
    "bbb222",
    "aaa111",
  ]);
  assert.deepEqual(sortAircraft(rows, "recent").map((row) => row.hex), [
    "aaa111",
    "ccc333",
    "bbb222",
  ]);
  assert.deepEqual(sortAircraft(rows, "callsign").map((row) => row.hex), [
    "aaa111",
    "bbb222",
    "ccc333",
  ]);
});
