/** `ctx.timing` (SPEC §9.3 Timing, §4 stream delay, §15 timers). */
import { describe, expect, it } from "vitest";
import { createTiming, minAudienceWindowMs, TIMER_SCALES } from "../src/timing.ts";

describe("createTiming", () => {
  it("input = base × timerScale + streamDelay", () => {
    expect(createTiming({ timerScale: 1, streamDelaySec: 3 }).input(20_000)).toBe(23_000);
    expect(createTiming({ timerScale: 1.5, streamDelaySec: 0 }).input(20_000)).toBe(30_000);
    expect(createTiming({ timerScale: 0.75, streamDelaySec: 8 }).input(10_000)).toBe(15_500);
    expect(createTiming({ timerScale: 2, streamDelaySec: 2.5 }).input(1_001)).toBe(4_502);
  });

  it("input is null when timerScale = 0 (host advances)", () => {
    expect(createTiming({ timerScale: 0, streamDelaySec: 3 }).input(20_000)).toBeNull();
  });

  it("pace is never scaled and never null", () => {
    for (const timerScale of TIMER_SCALES) {
      const t = createTiming({ timerScale, streamDelaySec: 8 });
      expect(t.pace(6_000)).toBe(6_000);
    }
  });

  it("rejects bad configs and bad durations", () => {
    expect(() => createTiming({ timerScale: 3 as never, streamDelaySec: 3 })).toThrow(RangeError);
    expect(() => createTiming({ timerScale: 1, streamDelaySec: 9 })).toThrow(RangeError);
    expect(() => createTiming({ timerScale: 1, streamDelaySec: -1 })).toThrow(RangeError);
    expect(() => createTiming({ timerScale: 1, streamDelaySec: Number.NaN })).toThrow(RangeError);
    const t = createTiming({ timerScale: 1, streamDelaySec: 3 });
    expect(() => t.input(-5)).toThrow(RangeError);
    expect(() => t.pace(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(Object.isFrozen(t)).toBe(true);
  });

  it("minimum audience window = streamDelay + 5 s", () => {
    expect(minAudienceWindowMs(3)).toBe(8_000);
    expect(minAudienceWindowMs(0)).toBe(5_000);
    expect(minAudienceWindowMs(8)).toBe(13_000);
  });
});
