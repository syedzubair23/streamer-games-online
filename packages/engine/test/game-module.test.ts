/** Helpers next to the SPEC §9.3 / §9.4 declarations: option resolution and client constants. */
import { describe, expect, it } from "vitest";
import {
  CAMERA_STATES,
  EASING_NAMES,
  MAT_KINDS,
  QUALITY_TIERS,
  SFX_NAMES,
  SPRING_NAMES,
} from "../src/client-module.ts";
import {
  defaultOptions,
  resolveOptions,
  SECRET_KEYS,
  type OptionSpec,
} from "../src/game-module.ts";

const specs: OptionSpec[] = [
  { kind: "int", key: "rounds", label: "Rounds", min: 1, max: 9, step: 2, default: 3 },
  { kind: "seconds", key: "answerSec", label: "Answer", min: 30, max: 120, default: 60 },
  { kind: "bool", key: "spicy", label: "Spicy", default: false },
  {
    kind: "enum",
    key: "mode",
    label: "Mode",
    choices: [
      { value: "ffa", label: "FFA" },
      { value: "teams", label: "Teams" },
    ],
    default: "ffa",
  },
  {
    kind: "pack",
    key: "packs",
    label: "Packs",
    packKind: "quip-prompts",
    multi: true,
    default: ["core"],
  },
  { kind: "pack", key: "one", label: "One", packKind: "trivia-mc", multi: false, default: ["a"] },
];

describe("defaultOptions / resolveOptions", () => {
  it("defaults come from the specs, with fresh arrays", () => {
    const d = defaultOptions(specs);
    expect(d).toEqual({
      rounds: 3,
      answerSec: 60,
      spicy: false,
      mode: "ffa",
      packs: ["core"],
      one: ["a"],
    });
    (d["packs"] as string[]).push("x");
    expect(defaultOptions(specs)["packs"]).toEqual(["core"]);
  });

  it("accepts valid values, clamps and snaps numbers, and drops unknown keys", () => {
    expect(
      resolveOptions(specs, {
        rounds: 6,
        answerSec: 200,
        spicy: true,
        mode: "teams",
        packs: ["a", "b", "a"],
        one: ["x", "y"],
        extra: 1,
      }),
    ).toEqual({
      rounds: 7,
      answerSec: 120,
      spicy: true,
      mode: "teams",
      packs: ["a", "b"],
      one: ["x"],
    });
    expect(resolveOptions(specs, { rounds: -5, answerSec: 44.6 })).toMatchObject({
      rounds: 1,
      answerSec: 45,
    });
    expect(resolveOptions(specs, { rounds: 100 })["rounds"]).toBe(9);
  });

  it("falls back to defaults for invalid values", () => {
    expect(
      resolveOptions(specs, {
        rounds: Number.NaN,
        answerSec: "60",
        spicy: "yes",
        mode: "chaos",
        packs: [],
        one: [3],
      }),
    ).toEqual(defaultOptions(specs));
    expect(resolveOptions(specs, { packs: "core" })["packs"]).toEqual(["core"]);
    expect(resolveOptions(specs, { packs: [""] })["packs"]).toEqual(["core"]);
  });

  it("secret keys are the SPEC §9.3 rule 4 names", () => {
    expect(SECRET_KEYS).toEqual(["secret", "hidden"]);
  });
});

describe("client module constants", () => {
  it("list the SPEC §9.4 / §13 names", () => {
    expect(MAT_KINDS).toEqual(["wood-board", "inlay", "paper", "cork", "felt", "pegboard"]);
    expect(QUALITY_TIERS).toEqual(["low", "mid", "high"]);
    expect(CAMERA_STATES).toEqual(["establishing", "play", "focus", "top"]);
    expect(SPRING_NAMES).toEqual(["snappy", "bouncy", "gentle", "wobbly", "camera"]);
    expect(EASING_NAMES).toEqual(["outSoft", "inSoft", "inout", "back", "linear"]);
    expect(SFX_NAMES).toHaveLength(10);
    for (const list of [MAT_KINDS, QUALITY_TIERS, CAMERA_STATES, SPRING_NAMES, SFX_NAMES]) {
      expect(Object.isFrozen(list)).toBe(true);
    }
  });
});
