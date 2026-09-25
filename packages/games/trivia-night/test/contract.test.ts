/**
 * DOD G4: the engine's contract suite on Trivia Night (Classic), at the DoD sizes (secrecy fuzz
 * over 200 games, 1,000 garbage payloads), across every major option preset, with the spec's
 * max-steps bound (1,500). Each preset is played at 1 (solo), 3 (the smallest Showdown table),
 * 6 and 10 players; a second run covers timerScale 0 (no input timers, the host advances).
 */
import { runContractSuite } from "@sg/engine/testing";
import { describe } from "vitest";
import { involves, triviaNight } from "../src/logic/index.ts";
import { MAX_STEPS, PRESETS, testContent } from "./fixtures.ts";

runContractSuite(triviaNight, {
  seeds: 20,
  players: [1, 3, 6, 10],
  presets: PRESETS,
  fuzzGames: 200,
  garbage: 1000,
  maxSteps: MAX_STEPS,
  content: testContent,
  sim: { involves },
  timeoutMs: 600_000,
});

describe("timerScale 0", () => {
  runContractSuite(triviaNight, {
    seeds: 6,
    players: [1, 4, 10],
    presets: PRESETS,
    fuzzGames: 40,
    garbage: 200,
    maxSteps: MAX_STEPS,
    content: testContent,
    timerScale: 0,
    sim: { involves },
    timeoutMs: 600_000,
  });
});
