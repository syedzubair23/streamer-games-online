/**
 * DOD G4: the engine's contract suite on Tune In, at the DoD sizes (secrecy fuzz over 200
 * games, 1,000 garbage payloads), across every major option preset, with the spec's max-steps
 * bound (2,000). Each preset is played at the default player counts (2, 7, 12) plus 4 (the
 * smallest teams table).
 */
import { runContractSuite } from "@sg/engine/testing";
import { describe } from "vitest";
import { tuneIn } from "../src/logic/index.ts";
import { MAX_STEPS, PRESETS, testContent } from "./fixtures.ts";

runContractSuite(tuneIn, {
  seeds: 20,
  players: [2, 4, 7, 12],
  presets: PRESETS,
  fuzzGames: 200,
  garbage: 1000,
  maxSteps: MAX_STEPS,
  content: testContent,
  timeoutMs: 600_000,
});

// The same contract with no input timers (timerScale 0): the simulated host advances.
describe("timerScale 0", () => {
  runContractSuite(tuneIn, {
    seeds: 6,
    players: [2, 6],
    presets: PRESETS,
    fuzzGames: 40,
    garbage: 200,
    maxSteps: MAX_STEPS,
    content: testContent,
    timerScale: 0,
    timeoutMs: 600_000,
  });
});
