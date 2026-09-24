/** `fakeContent`: content-pack fixtures as a ContentAccess (validated by the real schemas). */
import type { AnyPack } from "@sg/shared";
import { describe, expect, it } from "vitest";
import { contentKey, EMPTY_CONTENT } from "../src/game-module.ts";
import { fakeContent, markAllUsed } from "../src/testing/fake-content.ts";

const quips: AnyPack = {
  id: "quip-test",
  kind: "quip-prompts",
  name: "Test prompts",
  lang: "en",
  rating: "all",
  version: 1,
  items: [
    { id: "q1", text: "The worst thing to find in a sandwich: ___", safety: ["a", "b", "c"] },
    { id: "q2", text: "A terrible name for a boat: ___", safety: ["x", "y", "z"] },
  ],
};

describe("fakeContent", () => {
  it("lists packs, returns items in pack order and skips unknown or foreign packs", () => {
    const c = fakeContent([quips]);
    expect(c.packs("quip-prompts")).toEqual([
      { id: "quip-test", kind: "quip-prompts", name: "Test prompts", rating: "all", count: 2 },
    ]);
    expect(c.items("quip-prompts", ["quip-test", "nope"]).map((q) => q.id)).toEqual(["q1", "q2"]);
    expect(c.items("trivia-mc", ["quip-test"])).toEqual([]);
    expect(c.packs("trivia-mc")).toEqual([]);
  });

  it("tracks used items by content key", () => {
    const c = fakeContent([quips], { used: { "quip-prompts": ["q2"] } });
    expect(c.isUsed("quip-prompts", "q2")).toBe(true);
    expect(c.isUsed("quip-prompts", "q1")).toBe(false);
    expect(c.isUsed("doodle-words", "q1")).toBe(false);
    markAllUsed(c, "quip-prompts", c.items("quip-prompts", ["quip-test"]));
    expect(c.isUsed("quip-prompts", "q1")).toBe(true);
    c.markUsed("doodle-words", "teapot");
    expect(c.isUsed("doodle-words", "teapot")).toBe(true);
  });

  it("validates packs against the schemas and rejects duplicate ids", () => {
    const bad = { ...quips, items: [{ id: "q1", text: "", safety: [] }] } as unknown as AnyPack;
    expect(() => fakeContent([bad])).toThrow(/pack quip-test is invalid/);
    expect(() => fakeContent([bad], { validate: false })).not.toThrow();
    expect(() => fakeContent([quips, quips])).toThrow(/duplicate pack id/);
    const alien = { ...quips, kind: "nope" } as unknown as AnyPack;
    expect(() => fakeContent([alien])).toThrow(/unknown pack kind/);
  });

  it("contentKey and EMPTY_CONTENT", () => {
    expect(contentKey("doodle-words", { w: "kite" } as never)).toBe("kite");
    expect(contentKey("ooo-pairs", { a: "cat", b: "dog" } as never)).toBe("cat|dog");
    expect(contentKey("quip-prompts", { id: "q9" } as never)).toBe("q9");
    expect(EMPTY_CONTENT.packs("quip-prompts")).toEqual([]);
    expect(EMPTY_CONTENT.items("quip-prompts", ["x"])).toEqual([]);
    expect(EMPTY_CONTENT.isUsed("quip-prompts", "x")).toBe(false);
  });
});
