import { describe, expect, it, vi } from "vitest";
import {
  contrastRatio,
  createPlaceholderTheme,
  EASINGS,
  IDENTITY,
  MODE_TOKENS,
  over,
  relativeLuminance,
  SPRINGS,
  tokensFor,
} from "../src/dev/placeholder-theme.ts";

describe("placeholder theme (SPEC §13 tokens)", () => {
  it("transcribes SPEC §13.2–§13.4 exactly", () => {
    expect(MODE_TOKENS.dusk).toMatchObject({
      skyTop: "#F6A58B",
      keyIntensity: 2.6,
      uiBg: "#FFF3E4",
      accent: "#F2705A",
      shadowAlpha: 0.32,
    });
    expect(MODE_TOKENS.night).toMatchObject({ uiBg: "#1F1D33", uiInk: "#F5EDE3", glowIntensity: 1 });
    expect(Object.keys(MODE_TOKENS)).toEqual(["day", "dusk", "night", "rain", "snow"]);
    expect(IDENTITY.map((c) => c.base)).toEqual([
      "#F26B5B",
      "#5BA8F2",
      "#F5C04A",
      "#5CC79A",
      "#A98BE8",
      "#FF9F6E",
      "#3FB8C4",
      "#EE86B9",
    ]);
    expect(SPRINGS.bouncy).toEqual({ stiffness: 380, damping: 18 });
    expect(SPRINGS.camera).toEqual({ stiffness: 120, damping: 22 });
    expect(EASINGS.outSoft).toEqual({ bezier: [0.22, 1, 0.36, 1], ms: 240 });
    const t = tokensFor("day");
    expect(t.semantic.audience).toBe("#B58AF0");
    expect(t.radius).toEqual({ sm: 10, md: 16, lg: 24, xl: 32, pill: 9999 });
    expect(t.space).toEqual([4, 8, 12, 16, 24, 32, 48]);
    expect(t.motion.easing.back).toBe("cubic-bezier(0.34,1.56,0.64,1)");
    expect(t.motion.durationMs.inSoft).toBe(160);
  });

  it("wraps identity slots and notifies mode subscribers until they unsubscribe", () => {
    const theme = createPlaceholderTheme("dusk");
    expect(theme.identity(9).name).toBe("Sky");
    expect(theme.identity(-1).name).toBe("Rose");
    const cb = vi.fn();
    const off = theme.onModeChange(cb);
    expect(theme.listenerCount).toBe(1);
    theme.setMode("dusk");
    expect(cb).not.toHaveBeenCalled();
    theme.setMode("night");
    expect(cb).toHaveBeenCalledWith(
      "night",
      expect.objectContaining({ mode: expect.objectContaining({ uiBg: "#1F1D33" }) }),
    );
    expect(theme.mode).toBe("night");
    expect(theme.tokens.mode.uiBg).toBe("#1F1D33");
    off();
    expect(theme.listenerCount).toBe(0);
  });

  it("computes WCAG contrast and alpha compositing; ink clears 4.5:1 in every mode", () => {
    expect(relativeLuminance("#FFFFFF")).toBeCloseTo(1, 5);
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 1);
    expect(over("#FFFFFF", 0.5, "#000000")).toBe("#808080");
    expect(() => relativeLuminance("red")).toThrow();
    for (const m of Object.values(MODE_TOKENS)) {
      expect(contrastRatio(m.uiInk, m.uiBg)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(m.uiInk, over(m.uiSurface, m.uiSurfaceAlpha, m.uiBg))).toBeGreaterThanOrEqual(4.5);
    }
  });
});
