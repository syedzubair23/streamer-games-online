/**
 * The scenario route's theme: the SPEC §13 "Cozy Table" tokens as a {@link ThemeApi}.
 *
 * This is a **placeholder** for `@sg/ui/tokens.ts` (M1-05) and `@sg/render/ambient/modes.ts`
 * (M1-06/M1-07). The values are transcribed exactly from SPEC §13.2–§13.4 so a game rendered
 * through `/dev/scenario` today already uses the right palette; once `@sg/ui` exports its tokens
 * the route switches to them and this file is deleted.
 *
 * @module
 */
import type {
  EasingName,
  IdentityColor,
  ModeTokens,
  SpringName,
  SpringPresets,
  ThemeApi,
  ThemeTokens,
} from "@sg/engine/client";
import type { AmbientMode } from "@sg/shared";

/** SPEC §13.2, one column per mode. Alphas are the `@NN%` suffixes. */
export const MODE_TOKENS: Readonly<Record<AmbientMode, Readonly<ModeTokens>>> = Object.freeze({
  day: {
    skyTop: "#9FD3F2",
    skyBottom: "#FDEBD3",
    hemiSky: "#DDEEFF",
    hemiGround: "#E9C9A3",
    key: "#FFF4E0",
    keyIntensity: 2.2,
    fillIntensity: 1.1,
    fog: "#F6E7D6",
    wall: "#F3E6D3",
    wood: "#C98E5B",
    felt: "#5FA89A",
    shadow: "#6B4F6E",
    shadowAlpha: 0.28,
    glow: "#FFE7B0",
    glowIntensity: 0.1,
    uiBg: "#FFF8EF",
    uiSurface: "#FFFFFF",
    uiSurfaceAlpha: 0.86,
    uiInk: "#3B2F3A",
    uiMuted: "#8A7A86",
    uiLine: "#EADBC8",
    accent: "#FF8A65",
  },
  dusk: {
    skyTop: "#F6A58B",
    skyBottom: "#FFE1A8",
    hemiSky: "#FFD2B0",
    hemiGround: "#B7797A",
    key: "#FFC98A",
    keyIntensity: 2.6,
    fillIntensity: 0.8,
    fog: "#F4C9A6",
    wall: "#F0D2B6",
    wood: "#B87445",
    felt: "#4F9488",
    shadow: "#7A3F5C",
    shadowAlpha: 0.32,
    glow: "#FFC26B",
    glowIntensity: 0.5,
    uiBg: "#FFF3E4",
    uiSurface: "#FFF9F1",
    uiSurfaceAlpha: 0.88,
    uiInk: "#3D2A33",
    uiMuted: "#8F7078",
    uiLine: "#F0D3B8",
    accent: "#F2705A",
  },
  night: {
    skyTop: "#1C2140",
    skyBottom: "#3D3A6B",
    hemiSky: "#5A5F9E",
    hemiGround: "#2A2338",
    key: "#FFC98A",
    keyIntensity: 2.4,
    fillIntensity: 0.45,
    fog: "#262544",
    wall: "#3A3553",
    wood: "#8A5A3E",
    felt: "#3D7A74",
    shadow: "#120E24",
    shadowAlpha: 0.45,
    glow: "#FFB45E",
    glowIntensity: 1.0,
    uiBg: "#1F1D33",
    uiSurface: "#2C2946",
    uiSurfaceAlpha: 0.88,
    uiInk: "#F5EDE3",
    uiMuted: "#A89EBC",
    uiLine: "#403B5E",
    accent: "#FFB36B",
  },
  rain: {
    skyTop: "#7D8FA6",
    skyBottom: "#B8C3CF",
    hemiSky: "#B9C8D8",
    hemiGround: "#6D6470",
    key: "#E8EEF5",
    keyIntensity: 1.3,
    fillIntensity: 1.0,
    fog: "#A9B3BF",
    wall: "#D8D6DA",
    wood: "#A57A5C",
    felt: "#56908C",
    shadow: "#3A3F55",
    shadowAlpha: 0.34,
    glow: "#FFD08F",
    glowIntensity: 0.7,
    uiBg: "#F2F1F4",
    uiSurface: "#FFFFFF",
    uiSurfaceAlpha: 0.84,
    uiInk: "#2F3342",
    uiMuted: "#7B8093",
    uiLine: "#D9DBE3",
    accent: "#6FA8DC",
  },
  snow: {
    skyTop: "#C9D8EC",
    skyBottom: "#F4F1F6",
    hemiSky: "#E6EEFA",
    hemiGround: "#C7B3B8",
    key: "#F7F3FF",
    keyIntensity: 1.8,
    fillIntensity: 1.2,
    fog: "#E9ECF4",
    wall: "#EFE9EE",
    wood: "#B7835F",
    felt: "#5E9A96",
    shadow: "#56507A",
    shadowAlpha: 0.26,
    glow: "#FFD9A0",
    glowIntensity: 0.6,
    uiBg: "#FAF8FC",
    uiSurface: "#FFFFFF",
    uiSurfaceAlpha: 0.88,
    uiInk: "#34324A",
    uiMuted: "#8886A0",
    uiLine: "#E2DEEA",
    accent: "#E77FA0",
  },
});

/** SPEC §13.3 identity colours, in colour-slot order. */
export const IDENTITY: readonly IdentityColor[] = Object.freeze([
  { slot: 0, name: "Tomato", base: "#F26B5B", deep: "#B8382C", glyph: "circle" },
  { slot: 1, name: "Sky", base: "#5BA8F2", deep: "#2A6DB3", glyph: "triangle" },
  { slot: 2, name: "Sunflower", base: "#F5C04A", deep: "#A87A10", glyph: "square" },
  { slot: 3, name: "Mint", base: "#5CC79A", deep: "#23845C", glyph: "diamond" },
  { slot: 4, name: "Lilac", base: "#A98BE8", deep: "#6A4DB8", glyph: "star" },
  { slot: 5, name: "Peach", base: "#FF9F6E", deep: "#C0602F", glyph: "plus" },
  { slot: 6, name: "Teal", base: "#3FB8C4", deep: "#1D7782", glyph: "pentagon" },
  { slot: 7, name: "Rose", base: "#EE86B9", deep: "#B0457C", glyph: "heart" },
]);

/** SPEC §13.4 springs (stiffness / damping). */
export const SPRINGS: SpringPresets = Object.freeze({
  snappy: { stiffness: 520, damping: 34 },
  bouncy: { stiffness: 380, damping: 18 },
  gentle: { stiffness: 170, damping: 26 },
  wobbly: { stiffness: 240, damping: 12 },
  camera: { stiffness: 120, damping: 22 },
} satisfies Record<SpringName, { stiffness: number; damping: number }>);

/** SPEC §13.4 easings as cubic-bezier control points, with their token durations (ms). */
export const EASINGS: Readonly<
  Record<EasingName, { bezier: readonly [number, number, number, number]; ms: number }>
> = Object.freeze({
  outSoft: { bezier: [0.22, 1, 0.36, 1], ms: 240 },
  inSoft: { bezier: [0.55, 0, 0.78, 0.4], ms: 160 },
  inout: { bezier: [0.65, 0, 0.35, 1], ms: 550 },
  back: { bezier: [0.34, 1.56, 0.64, 1], ms: 320 },
  linear: { bezier: [0, 0, 1, 1], ms: 240 },
});

const bezierCss = (b: readonly number[]): string => `cubic-bezier(${b.join(",")})`;

/** The full token set for a mode (SPEC §13). */
export function tokensFor(mode: AmbientMode): ThemeTokens {
  const names = Object.keys(EASINGS) as EasingName[];
  return {
    mode: { ...MODE_TOKENS[mode] },
    identity: IDENTITY,
    semantic: {
      success: "#6CC08B",
      warning: "#F5B94A",
      danger: "#EC6A6A",
      info: "#6FA8DC",
      audience: "#B58AF0",
    },
    fixed: { chessLight: "#F1E6D2", chessDark: "#7FA88E", paper: "#FBF5EA", glass: "#DDEBF2" },
    radius: { sm: 10, md: 16, lg: 24, xl: 32, pill: 9999 },
    space: [4, 8, 12, 16, 24, 32, 48],
    motion: {
      durationMs: Object.fromEntries(names.map((n) => [n, EASINGS[n].ms])) as Record<
        EasingName,
        number
      >,
      easing: Object.fromEntries(names.map((n) => [n, bezierCss(EASINGS[n].bezier)])) as Record<
        EasingName,
        string
      >,
    },
  };
}

/** A {@link ThemeApi} with a settable mode (the route sets it once; tests switch it). */
export interface PlaceholderTheme extends ThemeApi {
  /** Switches the mode and notifies subscribers (no-op when unchanged). */
  setMode(mode: AmbientMode): void;
  /** The number of live `onModeChange` subscribers (leak checks). */
  readonly listenerCount: number;
}

/** Creates the route's theme in `mode`. */
export function createPlaceholderTheme(mode: AmbientMode): PlaceholderTheme {
  let current = mode;
  let tokens = tokensFor(mode);
  const listeners = new Set<(mode: AmbientMode, tokens: ThemeTokens) => void>();
  return {
    get mode() {
      return current;
    },
    get tokens() {
      return tokens;
    },
    get listenerCount() {
      return listeners.size;
    },
    identity(slot: number): IdentityColor {
      const n = IDENTITY.length;
      const i = ((Math.trunc(slot) % n) + n) % n;
      return IDENTITY[i] as IdentityColor;
    },
    onModeChange(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    setMode(next: AmbientMode): void {
      if (next === current) return;
      current = next;
      tokens = tokensFor(next);
      for (const cb of [...listeners]) cb(current, tokens);
    },
  };
}

/** Parses `#RRGGBB` into linear-light relative luminance (WCAG 2.x). */
export function relativeLuminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (m === null) throw new Error(`relativeLuminance: ${hex} is not #RRGGBB`);
  const n = Number.parseInt(m[1] as string, 16);
  const channel = (c: number): number => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
  );
}

/** WCAG contrast ratio between two `#RRGGBB` colours (1..21). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Composites `#RRGGBB` `top` at `alpha` over opaque `#RRGGBB` `bottom`. */
export function over(top: string, alpha: number, bottom: string): string {
  const parse = (h: string): number[] => {
    const n = Number.parseInt(h.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const t = parse(top);
  const b = parse(bottom);
  return `#${t
    .map((c, i) => Math.round(c * alpha + (b[i] ?? 0) * (1 - alpha)))
    .map((c) => c.toString(16).padStart(2, "0"))
    .join("")}`;
}
