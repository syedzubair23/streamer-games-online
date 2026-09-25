import { ROOM_CODE_ALPHABET } from "@sg/shared";
import { describe, expect, it } from "vitest";
import {
  CODE_BLOCKED_CODES,
  CODE_BLOCKED_SUBSTRINGS,
  CodeRegistry,
  isBlockedCode,
} from "../src/codes.ts";
import { FakeClock } from "./fake-clock.ts";

const idx = (code: string): number[] => [...code].map((l) => ROOM_CODE_ALPHABET.indexOf(l));

/** A random source that replays `seq` and then falls back to `rest`. */
function scripted(seq: number[], rest: (max: number) => number = () => 0): (max: number) => number {
  let i = 0;
  return (max) => (i < seq.length ? (seq[i++] ?? 0) % max : rest(max));
}

describe("room codes", () => {
  it("codes use only the 20-consonant alphabet", () => {
    expect(ROOM_CODE_ALPHABET).toBe("BCDFGHJKLMNPQRSTVWXZ");
    expect(ROOM_CODE_ALPHABET).toHaveLength(20);
    expect(ROOM_CODE_ALPHABET).not.toMatch(/[AEIOUY]/);
    const reg = new CodeRegistry({ clock: new FakeClock(), releaseMs: 0 });
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const issued = reg.issue();
      expect(issued).not.toBeNull();
      const code = issued?.code ?? "";
      expect(code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
      expect(seen.has(code)).toBe(false);
      seen.add(code);
    }
    expect(reg.liveCount).toBe(2000);
  });

  it("every blocklist entry is spelled with the code alphabet (so it can actually match)", () => {
    for (const bad of [...CODE_BLOCKED_SUBSTRINGS, ...CODE_BLOCKED_CODES])
      expect(bad, bad).toMatch(new RegExp(`^[${ROOM_CODE_ALPHABET}]+$`));
    for (const bad of CODE_BLOCKED_CODES) expect(bad).toHaveLength(4);
  });

  it("a blocklisted code is never issued", () => {
    expect(isBlockedCode("FCKB")).toBe(true);
    expect(isBlockedCode("BKKK")).toBe(true);
    expect(isBlockedCode("BTCH")).toBe(true);
    expect(isBlockedCode("BCDF")).toBe(false);
    // The random source proposes blocked codes first; the registry skips them.
    const reg = new CodeRegistry({
      clock: new FakeClock(),
      releaseMs: 0,
      random: scripted([...idx("FCKB"), ...idx("KKKD"), ...idx("BCDF")]),
    });
    expect(reg.issue()?.code).toBe("BCDF");
  });

  it("never issues a blocked code, including from the fallback scan", () => {
    const reg = new CodeRegistry({ clock: new FakeClock(), releaseMs: 0 });
    for (let i = 0; i < 20_000; i++) expect(isBlockedCode(reg.issue()?.code ?? "FCKK")).toBe(false);
    // A random source stuck on a blocked code forces the linear scan for every issue.
    const stuck = new CodeRegistry({ clock: new FakeClock(), releaseMs: 0, random: () => 3 });
    for (let i = 0; i < 500; i++) expect(isBlockedCode(stuck.issue()?.code ?? "FCKK")).toBe(false);
    // Most of the space stays usable.
    let allowed = 0;
    const n = ROOM_CODE_ALPHABET.length;
    for (let v = 0; v < CodeRegistry.SPACE; v++) {
      const code = [3, 2, 1, 0].map((p) => ROOM_CODE_ALPHABET[Math.floor(v / n ** p) % n]).join("");
      if (!isBlockedCode(code)) allowed++;
    }
    expect(allowed).toBeGreaterThan(CodeRegistry.SPACE * 0.8);
  });

  it("does not reissue a live code and falls back to a scan when random picks collide", () => {
    const reg = new CodeRegistry({ clock: new FakeClock(), releaseMs: 0, random: () => 0 });
    const a = reg.issue();
    expect(a?.code).toBe("BBBB");
    const b = reg.issue();
    expect(b?.code).not.toBe("BBBB");
    expect(reg.isTaken("BBBB")).toBe(true);
  });

  it("reserves a released code for the release window, then reissues it with a higher epoch", () => {
    const clock = new FakeClock();
    const reg = new CodeRegistry({ clock, releaseMs: 30 * 60_000, random: () => 0 });
    expect(reg.issue()).toEqual({ code: "BBBB", epoch: 1 });
    reg.release("BBBB");
    expect(reg.isTaken("BBBB")).toBe(true);
    expect(reg.issue()?.code).not.toBe("BBBB");
    clock.advance(30 * 60_000);
    expect(reg.isTaken("BBBB")).toBe(false);
    expect(reg.issue()).toEqual({ code: "BBBB", epoch: 2 });
    reg.release("NOPE"); // unknown: no-op
    reg.dispose();
  });

  it("adopts restored codes without a new epoch", () => {
    const clock = new FakeClock();
    const reg = new CodeRegistry({ clock, releaseMs: 1000, nextEpoch: () => 7 });
    expect(reg.adopt("QRST")).toBe(true);
    expect(reg.adopt("QRST")).toBe(false);
    reg.release("QRST");
    expect(reg.adopt("QRST")).toBe(true);
    expect(reg.isTaken("QRST")).toBe(true);
    clock.advance(5000);
    expect(reg.isTaken("QRST")).toBe(true);
  });
});
