/**
 * DOD G4: the engine's contract suite on Doodle at the DoD sizes (secrecy fuzz over 200
 * games, 1,000 garbage payloads), across every major option preset, with the spec's max-steps
 * bound (20,000; strokes count as steps). FFA runs at the default player counts (3, 8, 12)
 * plus 4 and 5 (the `rounds: auto` boundary); Team Doodle and timerScale 0 run as well.
 */
import { runContractSuite } from "@sg/engine/testing";
import { describe } from "vitest";
import { logic } from "../src/logic/index.ts";
import { MAX_STEPS, PRESETS, teamDoodle, testContent } from "./fixtures.ts";

runContractSuite(logic, {
  seeds: 12,
  players: [3, 4, 5, 8, 12],
  presets: PRESETS,
  fuzzGames: 200,
  garbage: 1000,
  maxSteps: MAX_STEPS,
  content: testContent,
  timeoutMs: 900_000,
});

describe("Team Doodle (R7)", () => {
  runContractSuite(teamDoodle(), {
    seeds: 6,
    players: [4, 7, 12],
    presets: [{}, { rounds: "2", audiencePicksTier: false }],
    fuzzGames: 60,
    garbage: 300,
    maxSteps: MAX_STEPS,
    content: testContent,
    timeoutMs: 900_000,
  });
});

// No input timers (timerScale 0): the simulated host advances every phase.
describe("timerScale 0", () => {
  runContractSuite(logic, {
    seeds: 4,
    players: [3, 6],
    presets: PRESETS,
    fuzzGames: 30,
    garbage: 200,
    maxSteps: MAX_STEPS,
    content: testContent,
    timerScale: 0,
    timeoutMs: 900_000,
  });
});
