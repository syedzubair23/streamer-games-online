/**
 * WCAG 2.x contrast for the G9 token check ("text contrast ≥ 4.5:1 in all modes"): the mode's
 * ink must clear 4.5:1 on the UI background and on the translucent UI surface composited over it.
 *
 * @module
 */

/** `#RRGGBB` → [r, g, b]. */
export function parseHex(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (m === null) throw new Error(`not a #RRGGBB colour: ${hex}`);
  const n = Number.parseInt(m[1] as string, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** WCAG relative luminance of `#RRGGBB`. */
export function luminance(hex: string): number {
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = parseHex(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio (1..21). */
export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** `top` at `alpha` composited over opaque `bottom`, as `#rrggbb`. */
export function composite(top: string, alpha: number, bottom: string): string {
  const t = parseHex(top);
  const b = parseHex(bottom);
  return `#${t
    .map((c, i) => Math.round(c * alpha + (b[i] ?? 0) * (1 - alpha)).toString(16).padStart(2, "0"))
    .join("")}`;
}

/** The mode tokens the check reads (a subset of `ModeTokens`). */
export interface UiTokens {
  uiBg: string;
  uiSurface: string;
  uiSurfaceAlpha: number;
  uiInk: string;
}

/** One failing pair. */
export interface ContrastFailure {
  pair: string;
  ratio: number;
}

/** Checks the text pairs of one mode against `min` (default 4.5). */
export function checkTokenContrast(t: UiTokens, min = 4.5): { ok: boolean; failures: ContrastFailure[]; ratios: Record<string, number> } {
  const surface = composite(t.uiSurface, t.uiSurfaceAlpha, t.uiBg);
  const ratios = {
    "ink/bg": contrast(t.uiInk, t.uiBg),
    "ink/surface": contrast(t.uiInk, surface),
  };
  const failures = Object.entries(ratios)
    .filter(([, r]) => r < min)
    .map(([pair, ratio]) => ({ pair, ratio: Math.round(ratio * 100) / 100 }));
  return { ok: failures.length === 0, failures, ratios };
}
