/**
 * The contract suite (DOD G4, SPEC §9.3 module rules) for Odd One Out: determinism, serialize
 * round-trip, the secrecy fuzz (200 games), termination (within the spec's 1,000 max steps),
 * the parseAction fuzz (1,000 payloads), illegal actions and view shape. It runs for the default
 * room over every major option preset, and for each room setting that changes the rules: the
 * family clue filter, a seated host (the host panel loses the secret) and timerScale 0
 * (host-advanced input phases).
 *
 * The secret itself is one of the 12 public category options, so the engine's generic secrecy
 * fuzz treats it as public; the Views table for the secret, the decoy and the odd ones is checked
 * separately by `logic.test.ts` T5. Here the fuzz still guards the future rounds' deck, the clue
 * banks and every ballot.
 */
import { describe } from "vitest";
import { runContractSuite } from "@sg/engine/testing";
import { createOddOneOut, involves, logic, type OooOptions } from "../src/logic/index.ts";
import { content } from "./helpers.ts";

/** Every major option preset of the spec's host options. */
const PRESETS: Partial<OooOptions>[] = [
  {},
  { variant: "undercover" },
  { oddCount: "2", clueRounds: "1" },
  { rounds: 8, clueRounds: "3", clueSec: 10, discussSec: 20 },
  { audienceSecret: "off", oddCount: "1", clueSec: 60, discussSec: 180, rounds: 2 },
  { variant: "undercover", oddCount: "2", clueRounds: "2" },
];

const base = {
  content: () => content(),
  presets: PRESETS,
  maxSteps: 1_000,
  sim: { involves },
  timeoutMs: 3_600_000,
};

describe("default room", () => {
  runContractSuite(logic, base);
});

describe("family filter", () => {
  runContractSuite(createOddOneOut({ contentFilter: "family" }), {
    ...base,
    fuzzGames: 60,
    checks: ["determinism", "secrecy", "termination", "illegal", "views"],
  });
});

describe("host seated", () => {
  runContractSuite(createOddOneOut({ hostSeated: true }), {
    ...base,
    fuzzGames: 60,
    checks: ["determinism", "secrecy", "termination", "views"],
  });
});

describe("timerScale 0", () => {
  runContractSuite(logic, {
    ...base,
    timerScale: 0,
    fuzzGames: 60,
    checks: ["determinism", "secrecy", "termination", "views"],
  });
});
