/**
 * Test fixtures for the M9-00 solver: a representative marble run (tray, peg field, three
 * zig-zag ramps, a boost, an arc funnel, 3 gates and a finish) and tray packing. The shipped
 * tracks are M9-00b's; this one only exercises every collider kind at race scale.
 */
import {
  addMarble,
  createBodies,
  FP,
  MARBLE_RADIUS_UNITS,
  type Bodies,
  type TrackPhysicsDef,
} from "../src/logic/physics/index.ts";

const pegs: [number, number, number][] = [];
for (let row = 0; row < 5; row++)
  for (let col = 0; col < 18; col++) {
    const x = 200 + col * 210 + (row % 2) * 105;
    if (x < 4000) pegs.push([x, 6000 + row * 200, 18]);
  }

/** A 4096 × 8192 test run using segments, pegs, arcs (all three sweep modes) and zones. */
export const TEST_TRACK: TrackPhysicsDef = {
  segments: [
    [40, 60, 40, 8150, 16], // left wall
    [4056, 60, 4056, 8150, 16], // right wall
    [40, 5600, 3600, 5000, 24], // ramp 1 (rolls right)
    [4056, 4600, 500, 4000, 24], // ramp 2 (rolls left)
    [40, 3400, 3600, 2800, 24], // ramp 3 (rolls right)
    [40, 60, 4056, 60, 16], // floor below the finish
  ],
  pegs,
  arcs: [
    [2048, 1500, 900, -1, 0, -1, -6, 16], // funnel, left half (80° sweep)
    [2048, 1500, 900, 1, -6, 1, 0, 16], // funnel, right half
    [3500, 6980, 80, 1, 0, -1, 0, 12], // a half ring bumper (180°)
    [700, 6980, 80, 0, 1, 0, 1, 12], // a full ring bumper
    [2048, 6990, 100, 1, 1, 1, -1, 12], // a 270° hook
  ],
  zones: {
    boost: [[2000, 2900, 2000, 3300, 20, 0]],
    funnel: [
      [300, 2400, 1150, 1500, 16],
      [3796, 2400, 2946, 1500, 16],
    ],
    gates: [
      [40, 5800, 4056, 5800],
      [40, 3800, 4056, 3800],
      [40, 2000, 4056, 2000],
    ],
    finish: [40, 300, 4056, 300],
  },
};

/**
 * Packs `n` marbles hexagonally into the start tray (top of the world), left to right, then
 * downward, with `gapUnits` of clearance between neighbours.
 */
export function packTray(n: number, capacity = n, topUnits = 8100, gapUnits = 4): Bodies {
  const b = createBodies(capacity);
  const d = 2 * MARBLE_RADIUS_UNITS + gapUnits;
  const rowH = Math.round(d * 0.866);
  const x0 = 60 + MARBLE_RADIUS_UNITS + 8;
  const x1 = 4036 - MARBLE_RADIUS_UNITS - 8;
  let row = 0;
  let placed = 0;
  while (placed < n) {
    const off = row % 2 === 0 ? 0 : d / 2;
    for (let x = x0 + off; x <= x1 && placed < n; x += d) {
      addMarble(b, Math.round(x * FP), (topUnits - row * rowH) * FP);
      placed++;
    }
    row++;
  }
  return b;
}
