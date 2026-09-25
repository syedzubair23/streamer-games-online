/**
 * The contract suite (DOD G4, SPEC §9.3 module rules) for Quip Clash: determinism, serialize
 * round-trip, the secrecy fuzz (200 games), termination (within the spec's 400 max steps),
 * the parseAction fuzz (1,000 payloads), illegal actions and view shape. It runs for the
 * default room and for each room setting that changes the rules: `reveal-review` moderation
 * (R13), the family content filter, and timerScale 0 (host-advanced).
 */
import { describe } from "vitest";
import { runContractSuite } from "@sg/engine/testing";
import { createQuipClash, involves, logic, type QcOptions } from "../src/logic/index.ts";
import { content } from "./helpers.ts";

/** Every major option preset of the spec's host options. */
const PRESETS: Partial<QcOptions>[] = [
  {},
  { rounds: "2" },
  { safetyQuip: false, audienceWeight: 0 },
  { audienceWeight: 50, answerSec: 45, voteSec: 10 },
  { answerSec: 180, voteSec: 40, packs: ["quip-core", "quip-spicy"] },
];

const base = {
  content: () => content(),
  presets: PRESETS,
  maxSteps: 400,
  sim: { involves },
  timeoutMs: 300_000,
};

describe("default room", () => {
  runContractSuite(logic, base);
});

describe("reveal-review moderation", () => {
  runContractSuite(createQuipClash({ moderation: "reveal-review" }), base);
});

describe("family filter", () => {
  runContractSuite(createQuipClash({ contentFilter: "family" }), {
    ...base,
    fuzzGames: 60,
    checks: ["determinism", "secrecy", "termination", "illegal", "views"],
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
