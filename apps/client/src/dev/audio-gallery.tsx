/// <reference lib="dom" />
/// <reference types="vite/client" />
/**
 * `/dev/audio?mode=`: the `@sg/audio` gallery (ROADMAP M1-08). Every sound effect, the
 * ambience bed of each mode, the lofi loop, the three level sliders, streamer-safe mode and a
 * hold-to-duck button, with a live level meter. The page takes its colours from the active
 * ambient mode's SPEC §13 tokens, so switching mode re-tints it like the Stage.
 *
 * Nothing sounds until "Enable sound" (or any key/tap) creates the AudioContext. Hiding the tab
 * suspends it; the status pill shows the context state. Keys: `1`–`0` play the ten sounds,
 * `Space` holds a reveal duck. Dev and non-production builds only (see `vite.config.ts`);
 * `window.__SG_AUDIO__` exposes the system and the library for the harness.
 *
 * @module
 */
import * as audioLib from "@sg/audio";
import {
  REVEAL_DUCK_DB,
  SFX_LIST,
  SFX_RECIPES,
  STREAMER_DUCK_DB,
  STREAMER_MUSIC_LEVEL,
  STREAM_SAFE_LABEL,
  createAudio,
  withStreamerSafe,
  type AudioSettings,
  type AudioSystem,
  type SfxName,
} from "@sg/audio";
import { AMBIENT_MODES, DEFAULT_ROOM_CONFIG, type AmbientMode } from "@sg/shared";
import "./gallery-fonts.css";
import { render } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { contrastRatio, over, tokensFor } from "./placeholder-theme.ts";

/** What each sound is for (research 03 §8.1). */
export const SFX_ROLES: Readonly<Record<SfxName, string>> = {
  pop: "Button",
  tick: "Hover / timer",
  tok: "Piece land (rises)",
  card: "Deal / flip",
  chime: "Your turn",
  success: "Correct",
  fail: "Soft miss",
  capture: "Capture",
  win: "Win sting",
  vote: "Audience vote",
};

const MODE_LABEL: Readonly<Record<AmbientMode, string>> = {
  day: "Day",
  dusk: "Golden Hour",
  night: "Night",
  rain: "Rain",
  snow: "Snow",
};

/** Consecutive `tok` hops within this window rise one pentatonic step each. */
export const HOP_WINDOW_MS = 600;

/** Reads `?mode=` (default `dusk`). */
export function parseGalleryMode(search: string): AmbientMode {
  const m = new URLSearchParams(search).get("mode");
  return (AMBIENT_MODES as readonly string[]).includes(m ?? "") ? (m as AmbientMode) : "dusk";
}

/**
 * Label ink for text on the accent fill: whichever of the mode's ink and background has the
 * higher WCAG contrast against the accent (the dark ink in every mode, since every accent is a
 * light tint; night's light ink on its amber accent would be 1.5:1).
 */
export function onAccentInk(mode: AmbientMode): string {
  const m = tokensFor(mode).mode;
  return contrastRatio(m.uiInk, m.accent) >= contrastRatio(m.uiBg, m.accent) ? m.uiInk : m.uiBg;
}

const hexAlpha = (hex: string, alpha: number): string =>
  `${hex}${Math.round(Math.min(1, Math.max(0, alpha)) * 255)
    .toString(16)
    .padStart(2, "0")}`;

/** Minimum WCAG contrast of the gallery's muted text on every surface it can sit on. */
export const MUTED_TEXT_CONTRAST = 5;

/** The opaque colours muted text can sit on in `mode` (glass cards composited over the sky). */
export function mutedTextBackgrounds(mode: AmbientMode): string[] {
  const t = tokensFor(mode);
  const m = t.mode;
  const card = mode === "night" ? m.uiSurface : t.fixed.paper;
  return [
    m.uiBg,
    m.uiSurface,
    card,
    over(card, m.uiSurfaceAlpha, m.skyTop),
    over(card, m.uiSurfaceAlpha, m.skyBottom),
    over(m.accent, 0.18, m.uiSurface),
  ];
}

/**
 * Ink for muted text (labels, details, key hints): the SPEC muted token moved toward the mode's
 * ink in 5% steps until it reaches {@link MUTED_TEXT_CONTRAST}:1 on every background of
 * {@link mutedTextBackgrounds}. The raw muted token stays for strokes and dots.
 */
export function mutedTextInk(mode: AmbientMode): string {
  const m = tokensFor(mode).mode;
  const bgs = mutedTextBackgrounds(mode);
  for (let step = 0; step <= 20; step++) {
    const ink = over(m.uiInk, step / 20, m.uiMuted);
    if (bgs.every((bg) => contrastRatio(ink, bg) >= MUTED_TEXT_CONTRAST)) return ink;
  }
  return m.uiInk;
}

/** The mode's tokens as CSS custom properties for the page. */
export function galleryVars(mode: AmbientMode): Record<string, string> {
  const t = tokensFor(mode);
  const m = t.mode;
  return {
    "--bg": m.uiBg,
    "--surface": m.uiSurface,
    "--surface-glass": hexAlpha(m.uiSurface, m.uiSurfaceAlpha),
    // Cards are paper in the light modes and the night surface after dark, both translucent.
    "--card": hexAlpha(mode === "night" ? m.uiSurface : t.fixed.paper, m.uiSurfaceAlpha),
    "--ink": m.uiInk,
    "--muted": m.uiMuted,
    "--muted-text": mutedTextInk(mode),
    "--line": m.uiLine,
    "--accent": m.accent,
    "--on-accent": onAccentInk(mode),
    "--shadow": hexAlpha(m.shadow, m.shadowAlpha),
    "--glow": hexAlpha(m.glow, Math.max(0.35, Math.min(0.8, m.glowIntensity))),
    "--audience": t.semantic.audience,
    "--success": t.semantic.success,
    "--sky-top": m.skyTop,
    "--sky-bottom": m.skyBottom,
    "--r-md": `${t.radius.md}px`,
    "--r-lg": `${t.radius.lg}px`,
    "--r-pill": `${t.radius.pill}px`,
    "--ease": t.motion.easing.outSoft,
    "--dur": `${t.motion.durationMs.outSoft}ms`,
    "--ease-back": t.motion.easing.back,
    "--dur-back": `${t.motion.durationMs.back}ms`,
    "--dur-mode": "2500ms",
  };
}

const DISPLAY = `"Fredoka Variable","Fredoka",system-ui,sans-serif`;
/** The 3 px "darker base" border colour of buttons and cards (SPEC §13.4). */
const BASE = "color-mix(in srgb,var(--line),var(--ink) 28%)";
/** Procedural paper grain: greyscale fractal noise (no image file, no colour literal). */
const GRAIN =
  `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='180' height='180'>` +
  `<filter id='g'><feTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3' stitchTiles='stitch'/>` +
  `<feColorMatrix type='saturate' values='0'/></filter><rect width='100%' height='100%' filter='url(%23g)'/></svg>")`;
/** Win and success get a 6-particle burst from the clay speaker. */
export const BURST_SOUNDS: readonly SfxName[] = ["win", "success"];
const BURST_COUNT = 6;

const CSS = `
html,body{height:100%;margin:0;background:var(--bg);transition:background var(--dur-mode) var(--ease)}
.ag{min-height:100dvh;box-sizing:border-box;padding:24px 16px 48px;color:var(--ink);
  background:linear-gradient(180deg,var(--sky-top),var(--sky-bottom));
  transition:color var(--dur-mode) var(--ease);
  font:600 1rem/1.4 "Nunito Variable","Nunito",system-ui,sans-serif;font-variant-numeric:tabular-nums}
.ag *{box-sizing:border-box}
.ag-wrap{max-width:1440px;margin:0 auto;display:grid;gap:24px;grid-template-columns:minmax(0,1fr)}
@media (min-width:1280px){.ag{padding:32px 48px 48px}
  .ag-wrap{grid-template-columns:repeat(12,minmax(0,1fr))}
  .ag-head,.ag-hero,.ag-mixcard{grid-column:1/-1}
  .ag-sfxcard{grid-column:1/8;grid-row:span 2}
  .ag-ambcard,.ag-musiccard{grid-column:8/13}}
.ag h1{font:700 2rem/1.1 ${DISPLAY};margin:0}
.ag h2{font:600 1.5rem/1.2 ${DISPLAY};margin:0;text-wrap:balance}
.ag-detail{margin:4px 0 16px;color:var(--muted-text);font-size:.875rem;font-weight:700;text-wrap:balance}
.ag-detail span{white-space:nowrap}
.ag-head{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between}
.ag-badges{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.ag-pill{display:inline-flex;align-items:center;gap:8px;min-height:36px;padding:4px 14px;border-radius:var(--r-pill);
  background:var(--card);border:1px solid var(--line);font-weight:700;font-size:.875rem}
.ag-dot{width:10px;height:10px;border-radius:var(--r-pill);background:var(--muted)}
.ag-pill[data-state=running] .ag-dot{background:var(--success);box-shadow:0 0 0 4px color-mix(in srgb,var(--success),transparent 70%)}
.ag-card{position:relative;isolation:isolate;display:flex;flex-direction:column;background:var(--card);
  -webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);
  border:1px solid var(--line);border-bottom:3px solid ${BASE};border-radius:var(--r-lg);padding:24px;
  box-shadow:0 14px 32px -16px var(--shadow),0 2px 6px -2px var(--shadow)}
.ag-card::before{content:"";position:absolute;inset:0;z-index:-1;border-radius:inherit;pointer-events:none;
  background:${GRAIN};background-size:180px;mix-blend-mode:multiply;opacity:.06}
.ag[data-mode=night] .ag-card::before{mix-blend-mode:screen;opacity:.05}
.ag-hero{display:grid;gap:16px 24px;grid-template-columns:auto minmax(0,1fr);align-items:center;
  box-shadow:0 18px 40px -18px var(--shadow),0 0 72px -6px var(--glow)}
.ag-hero .ag-slot{grid-column:1/-1}
@media (min-width:720px){.ag-hero{grid-template-columns:auto minmax(0,1fr) minmax(240px,auto)}.ag-hero .ag-slot{grid-column:auto}}
.ag-now{display:grid;gap:12px;min-width:0}
.ag-now-label{font-size:.875rem;color:var(--muted-text);text-transform:uppercase;letter-spacing:.08em;font-weight:800}
.ag-now-title{font:600 1.5rem/1.2 ${DISPLAY};margin:0;min-height:1.8rem}
.ag-clay{position:relative;width:88px;height:80px}
@media (min-width:720px){.ag-clay{width:128px;height:112px}}
.ag-clay-shadow{position:absolute;left:8%;right:8%;bottom:0;height:16%;border-radius:50%;
  background:radial-gradient(closest-side,var(--shadow),transparent)}
.ag-clay-body{position:absolute;left:6%;right:6%;top:4%;bottom:12%;border-radius:32% 32% 28% 28%/38% 38% 30% 30%;
  background:radial-gradient(circle at 30% 24%,color-mix(in srgb,var(--accent),var(--bg) 42%),var(--accent) 46%,color-mix(in srgb,var(--accent),var(--ink) 22%));
  box-shadow:inset -6px -8px 14px color-mix(in srgb,var(--accent),var(--ink) 28%),inset 5px 6px 10px color-mix(in srgb,var(--accent),var(--bg) 35%);
  transform-origin:50% 100%}
.ag-clay-body[data-kick]{animation:ag-squash var(--dur-back) var(--ease-back)}
@keyframes ag-squash{0%{transform:scale(1.08,.9)}100%{transform:none}}
.ag-clay-grille{position:absolute;left:14%;top:22%;width:46%;aspect-ratio:1;border-radius:50%;
  background:repeating-radial-gradient(circle,color-mix(in srgb,var(--accent),var(--ink) 45%) 0 2px,transparent 2px 5px);
  box-shadow:inset 0 2px 4px color-mix(in srgb,var(--accent),var(--ink) 40%)}
.ag-clay-knob{position:absolute;right:13%;width:18%;aspect-ratio:1;border-radius:50%;
  background:radial-gradient(circle at 35% 30%,color-mix(in srgb,var(--line),var(--bg) 40%),${BASE})}
.ag-clay-knob:nth-of-type(2){top:22%}.ag-clay-knob:nth-of-type(3){top:52%}
.ag-burst{position:absolute;left:50%;top:40%;width:0;height:0;pointer-events:none}
.ag-burst i{position:absolute;left:-5px;top:-5px;width:10px;height:10px;border-radius:var(--r-pill);background:var(--accent);
  box-shadow:0 0 8px var(--glow);opacity:0;animation:ag-fly 640ms var(--ease) forwards}
@keyframes ag-fly{0%{opacity:1;transform:rotate(var(--a)) translateY(0) scale(.6)}
  100%{opacity:0;transform:rotate(var(--a)) translateY(-64px) scale(1)}}
.ag-slot{min-height:56px;display:grid}
.ag-slot>*{grid-area:1/1;transition:opacity var(--dur) var(--ease),visibility 0s linear 0s}
.ag-slot>[data-gone]{opacity:0;visibility:hidden;pointer-events:none;
  transition:opacity var(--dur) var(--ease),visibility 0s linear var(--dur)}
.ag-grid{flex:1;display:grid;gap:12px;grid-template-columns:repeat(2,minmax(0,1fr));grid-auto-rows:1fr}
@media (min-width:480px){.ag-grid{grid-template-columns:repeat(auto-fill,minmax(132px,1fr))}}
@media (min-width:1280px){.ag-grid{grid-template-columns:repeat(5,minmax(0,1fr))}}
.ag button{position:relative;font:inherit;font-weight:700;color:var(--ink);cursor:pointer;min-height:48px;min-width:48px;
  border-radius:var(--r-md);border:2px solid var(--line);border-bottom:3px solid ${BASE};background:var(--surface-glass);
  padding:10px 14px;text-align:left;display:inline-flex;align-items:center;gap:10px;
  transition:transform var(--dur-back) var(--ease-back),box-shadow var(--dur) var(--ease),background var(--dur) var(--ease),border-color var(--dur) var(--ease)}
.ag button:hover{transform:translateY(-2px);box-shadow:0 10px 20px -10px var(--shadow)}
.ag button:active{transform:translateY(2px);border-bottom-width:1px;padding-bottom:12px;box-shadow:none;
  transition-duration:80ms;transition-timing-function:var(--ease)}
.ag button:focus-visible{outline:3px solid var(--accent);outline-offset:3px}
.ag button[aria-pressed=true]{background:color-mix(in srgb,var(--accent) 18%,var(--surface));border-color:var(--accent)}
.ag button:disabled{cursor:not-allowed}
.ag button svg{flex:none;width:18px;height:18px;fill:currentColor}
.ag .ag-sfx{display:grid;grid-template-rows:auto auto 1fr;align-content:start;gap:4px;height:100%;padding:10px 12px 12px}
.ag .ag-sfx:active{padding-bottom:14px}
.ag-sfx-top{display:flex;align-items:center;justify-content:space-between;min-height:28px}
.ag-sfx-top i{width:12px;height:12px;border-radius:var(--r-pill);background:var(--accent);
  box-shadow:inset -2px -2px 3px color-mix(in srgb,var(--accent),var(--ink) 30%)}
.ag-sfx[data-name=vote] .ag-sfx-top i{background:var(--audience)}
.ag-sfx b{display:block;font:600 1.25rem/1.2 ${DISPLAY};overflow-wrap:anywhere}
.ag-sfx small{display:block;color:var(--muted-text);font-size:.875rem;font-weight:700}
.ag-sfx kbd{min-width:28px;height:28px;display:grid;place-items:center;padding:0 6px;
  border-radius:8px;border:1px solid var(--line);border-bottom-width:2px;font:inherit;font-size:.875rem;font-weight:800;
  color:var(--muted-text);background:var(--bg)}
@media (min-width:1280px){.ag-sfx b{font-size:1.5rem}.ag-sfx small{font-size:1rem}}
.ag .ag-sfx[data-last=true]{animation:ag-pop var(--dur-back) var(--ease-back),ag-tint 1200ms var(--ease)}
@keyframes ag-pop{0%{transform:scale(1)}45%{transform:scale(1.04)}100%{transform:scale(1)}}
@keyframes ag-tint{0%,70%{background:color-mix(in srgb,var(--accent) 18%,var(--surface));border-color:var(--accent);
  border-bottom-color:var(--accent);box-shadow:0 0 0 3px var(--glow)}}
@media (hover:none),(pointer:coarse){.ag-sfx kbd,.ag-keys{display:none}}
.ag .ag-primary{width:100%;min-height:56px;justify-content:center;text-align:center;font:600 1.25rem/1 ${DISPLAY};
  background:var(--accent);color:var(--on-accent);border-color:var(--accent);
  border-bottom-color:color-mix(in srgb,var(--accent),var(--ink) 22%);box-shadow:0 10px 24px -10px var(--accent)}
.ag-chip{display:flex;align-items:center;justify-content:center;gap:10px;min-height:56px;padding:8px 18px;
  border-radius:var(--r-md);background:color-mix(in srgb,var(--success) 20%,var(--surface));border:2px solid var(--success);
  border-bottom-width:3px;font:600 1.25rem/1 ${DISPLAY}}
.ag-row{display:flex;flex-wrap:wrap;gap:12px;align-items:center}
.ag-seg{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:4px;padding:4px;margin-bottom:16px;
  border-radius:var(--r-md);background:color-mix(in srgb,var(--line) 55%,transparent);border:1px solid var(--line)}
.ag .ag-seg button{grid-column:span 2;justify-content:center;text-align:center;line-height:1.15;padding:6px 8px;border:0;border-radius:12px;background:transparent;min-height:44px}
.ag .ag-seg button:nth-child(n+4){grid-column:span 3}
.ag .ag-seg button:hover{transform:none;background:var(--surface-glass);box-shadow:none}
.ag .ag-seg button:active{padding-bottom:10px}
.ag .ag-seg button[aria-pressed=true]{background:var(--surface);box-shadow:0 0 0 2px var(--accent),0 6px 14px -8px var(--shadow)}
.ag-switch-track{position:relative;flex:none;width:44px;height:26px;border-radius:var(--r-pill);background:var(--line);
  transition:background var(--dur) var(--ease)}
.ag-switch-track i{position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:var(--r-pill);background:var(--surface);
  box-shadow:0 2px 4px var(--shadow);transition:transform var(--dur) var(--ease-back)}
.ag button[role=switch][aria-checked=true] .ag-switch-track{background:var(--accent)}
.ag button[role=switch][aria-checked=true] .ag-switch-track i{transform:translateX(18px)}
.ag-mix{display:grid;gap:16px 24px;grid-template-columns:minmax(0,1fr)}
@media (min-width:720px){.ag-mix{grid-template-columns:repeat(3,minmax(0,1fr))}}
.ag label{display:grid;gap:8px;font-weight:700;font-size:.875rem}
.ag input[type=range]{-webkit-appearance:none;appearance:none;width:100%;height:44px;margin:0;background:transparent;cursor:pointer}
.ag input[type=range]::-webkit-slider-runnable-track{height:8px;border-radius:var(--r-pill);
  background:linear-gradient(90deg,var(--accent) var(--fill,0%),var(--line) var(--fill,0%))}
.ag input[type=range]::-moz-range-track{height:8px;border-radius:var(--r-pill);background:var(--line)}
.ag input[type=range]::-moz-range-progress{height:8px;border-radius:var(--r-pill);background:var(--accent)}
.ag input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:24px;height:24px;margin-top:-8px;border-radius:var(--r-pill);
  background:var(--surface);border:2px solid var(--accent);border-bottom-width:3px;box-shadow:0 4px 10px -4px var(--shadow)}
.ag input[type=range]::-moz-range-thumb{width:24px;height:24px;border-radius:var(--r-pill);background:var(--surface);
  border:2px solid var(--accent);border-bottom-width:3px;box-shadow:0 4px 10px -4px var(--shadow)}
.ag input[type=range]:focus-visible{outline:3px solid var(--accent);outline-offset:3px;border-radius:var(--r-md)}
.ag-meter{position:relative;height:24px;border-radius:var(--r-pill);background:var(--bg);border:1px solid var(--line);overflow:hidden}
.ag-meter i{display:block;height:100%;width:100%;transform-origin:left;transform:scaleX(0);
  background:linear-gradient(90deg,var(--success),var(--accent));transition:transform 80ms linear}
.ag-meter b{position:absolute;top:3px;bottom:3px;width:3px;margin-left:-3px;border-radius:2px;background:var(--ink);opacity:.7}
.ag-duck{display:inline-flex;align-items:center;gap:8px;min-height:36px;padding:4px 14px;border-radius:var(--r-pill);
  background:color-mix(in srgb,var(--accent) 18%,var(--surface));border:1px solid var(--accent);font-weight:800;font-size:.875rem}
.ag-muted{color:var(--muted-text);font-size:.875rem;font-weight:700;margin:0}
@media (prefers-reduced-motion:reduce){.ag,.ag *,html,body{transition:none!important;animation:none!important}
  .ag-burst{display:none}
  .ag .ag-sfx[data-last=true]{animation:ag-tint 1200ms step-end!important}
  .ag button:hover,.ag button:active{transform:none}}
`;

/** Peak-hold fall per animation frame (fraction of full scale). */
const PEAK_DECAY = 0.006;

const PlayIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M8 5.5v13a1 1 0 0 0 1.5.9l10-6.5a1 1 0 0 0 0-1.7l-10-6.5A1 1 0 0 0 8 5.5z" />
  </svg>
);
const PauseIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="6" y="5" width="4.5" height="14" rx="1.5" />
    <rect x="13.5" y="5" width="4.5" height="14" rx="1.5" />
  </svg>
);
const SwitchTrack = () => (
  <span class="ag-switch-track" aria-hidden="true">
    <i />
  </span>
);

/** Options of {@link AudioGallery}. */
export interface AudioGalleryProps {
  audio: AudioSystem;
  initialMode: AmbientMode;
  /** Clock for the hop window (default `performance.now`). */
  now?: () => number;
}

/** The gallery UI. */
export function AudioGallery({
  audio,
  initialMode,
  now = () => performance.now(),
}: AudioGalleryProps) {
  const [mode, setModeState] = useState<AmbientMode>(initialMode);
  const [settings, setSettings] = useState<AudioSettings>({ ...DEFAULT_ROOM_CONFIG.audio });
  const [state, setState] = useState<string>("locked");
  const [ambienceOn, setAmbienceOn] = useState(true);
  const [musicOn, setMusicOn] = useState(false);
  const [ducking, setDucking] = useState(false);
  const [last, setLast] = useState<{ name: SfxName; label: string; n: number } | null>(null);
  const [meter, setMeter] = useState({ level: 0, peak: 0 });
  const hop = useRef({ step: 0, at: -Infinity });
  const releaseDuck = useRef<(() => void) | null>(null);

  const refresh = (): void => setState(audio.host.ctx?.state ?? "locked");
  const unlock = async (): Promise<void> => {
    await audio.unlock();
    refresh();
  };
  const play = (name: SfxName): void => {
    let pitchStep = 0;
    if (name === "tok") {
      const t = now();
      hop.current = { step: t - hop.current.at < HOP_WINDOW_MS ? hop.current.step + 1 : 0, at: t };
      pitchStep = hop.current.step;
    }
    void unlock().then(() => audio.sfx(name, { pitchStep }));
    setLast((prev) => ({
      name,
      label: pitchStep > 0 ? `${name} +${pitchStep}` : name,
      n: (prev?.n ?? 0) + 1,
    }));
  };
  const duck = (on: boolean): void => {
    releaseDuck.current?.();
    releaseDuck.current = on ? audio.duck(REVEAL_DUCK_DB) : null;
    setDucking(on);
  };
  const apply = (s: AudioSettings): void => {
    setSettings(s);
    audio.applySettings(s);
  };

  useEffect(() => {
    audio.applySettings(settings);
    const onVis = (): void => refresh();
    document.addEventListener("visibilitychange", onVis);
    const onKey = (e: KeyboardEvent): void => {
      if (e.target instanceof HTMLInputElement) return;
      const i = "1234567890".indexOf(e.key);
      if (i >= 0) play(SFX_LIST[i] as SfxName);
      else if (e.key === " " && !e.repeat) {
        e.preventDefault();
        duck(true);
      }
    };
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.key === " ") duck(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    const removeGesture = audio.host.unlockOnGesture();
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
      removeGesture();
      releaseDuck.current?.();
    };
    // Mount-only: the handlers read refs and the stable audio system.
  }, []);

  const vars = galleryVars(mode);

  // The page background (html/body) follows the mode too, so no untinted band shows below
  // the content on tall viewports. A layout effect, so it is set before the first paint.
  useLayoutEffect(() => {
    const root = document.documentElement;
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
    return () => {
      for (const k of Object.keys(vars)) root.style.removeProperty(k);
    };
  }, [mode]);

  // Live level meter with peak hold from an analyser on the master bus (only while running).
  useEffect(() => {
    const ctx = audio.host.ctx;
    const buses = audio.buses;
    if (state !== "running" || !ctx || !buses || typeof ctx.createAnalyser !== "function") return;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    buses.master.connect(analyser);
    const data = new Float32Array(analyser.fftSize);
    let raf = 0;
    let peak = 0;
    const tick = (): void => {
      analyser.getFloatTimeDomainData(data);
      let sum = 0;
      for (const v of data) sum += v * v;
      const rms = Math.sqrt(sum / data.length);
      const level = Math.min(1, Math.max(0, (20 * Math.log10(rms + 1e-9) + 60) / 60));
      peak = Math.max(level, peak - PEAK_DECAY);
      setMeter({ level, peak });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      buses.master.disconnect(analyser);
    };
  }, [state, audio]);

  const slider = (key: "music" | "sfx" | "ambience", label: string) => {
    const pct = Math.round(settings[key] * 100);
    return (
      <label>
        <span>
          {label} · {pct}%
        </span>
        <input
          type="range"
          min={0}
          max={100}
          value={pct}
          style={{ "--fill": `${pct}%` }}
          aria-label={`${label} level`}
          onInput={(e) =>
            apply({ ...settings, [key]: Number((e.target as HTMLInputElement).value) / 100 })
          }
        />
      </label>
    );
  };

  const duckDb = settings.streamerSafe
    ? Math.max(STREAMER_DUCK_DB, ducking ? REVEAL_DUCK_DB : 0)
    : ducking
      ? REVEAL_DUCK_DB
      : 0;
  const locked = state === "locked";

  return (
    <div class="ag" style={vars} data-mode={mode}>
      <style>{CSS}</style>
      <div class="ag-wrap">
        <header class="ag-head">
          <h1>Sound check</h1>
          <div class="ag-badges">
            <span class="ag-pill" data-testid="stream-safe">
              {STREAM_SAFE_LABEL}
            </span>
            <span class="ag-pill" data-state={state} data-testid="ctx-state" role="status">
              <span class="ag-dot" aria-hidden="true" />
              {state}
            </span>
          </div>
        </header>

        <section class="ag-card ag-hero" aria-labelledby="ag-now">
          <div class="ag-clay" aria-hidden="true" data-testid="clay">
            <div class="ag-clay-shadow" />
            <div class="ag-clay-body" key={last?.n ?? 0} data-kick={last ? "" : undefined}>
              <i class="ag-clay-grille" />
              <i class="ag-clay-knob" />
              <i class="ag-clay-knob" />
            </div>
            {last && BURST_SOUNDS.includes(last.name) && (
              <div class="ag-burst" key={`burst-${last.n}`} data-testid="burst">
                {Array.from({ length: BURST_COUNT }, (_, i) => (
                  <i key={i} style={{ "--a": `${(360 / BURST_COUNT) * i}deg` }} />
                ))}
              </div>
            )}
          </div>
          <div class="ag-now">
            <span class="ag-now-label" id="ag-now">
              Now playing · {MODE_LABEL[mode]}
            </span>
            <p class="ag-now-title" aria-live="polite" data-testid="last">
              {last ? `Played: ${last.label}` : "Press a sound to hear it"}
            </p>
            <div
              class="ag-meter"
              role="meter"
              aria-label="Master level"
              aria-valuemin={0}
              aria-valuemax={1}
              aria-valuenow={meter.level}
            >
              <i style={{ transform: `scaleX(${meter.level.toFixed(3)})` }} />
              <b style={{ left: `${(meter.peak * 100).toFixed(1)}%` }} aria-hidden="true" />
            </div>
          </div>
          <div class="ag-slot">
            <button
              class="ag-primary"
              data-testid="unlock"
              data-gone={locked ? undefined : ""}
              disabled={!locked}
              onClick={() => void unlock()}
            >
              Enable sound
            </button>
            <span class="ag-chip" data-testid="sound-on" data-gone={locked ? "" : undefined}>
              <span class="ag-dot" aria-hidden="true" style={{ background: "var(--success)" }} />
              {locked ? "Sound off" : state === "running" ? "Sound on" : `Sound ${state}`}
            </span>
          </div>
        </section>

        <section class="ag-card ag-sfxcard" aria-labelledby="ag-sfx">
          <h2 id="ag-sfx">Sounds</h2>
          <p class="ag-detail">Ten game sounds, all tuned to one happy scale</p>
          <div class="ag-grid">
            {SFX_LIST.map((name, i) => (
              <button
                key={last?.name === name ? `${name}-${last.n}` : name}
                class="ag-sfx"
                data-name={name}
                data-testid={`sfx-${name}`}
                data-last={last?.name === name ? "true" : undefined}
                onClick={() => play(name)}
                title={`${SFX_RECIPES[name].voices.length} voices`}
              >
                <span class="ag-sfx-top" aria-hidden="true">
                  <i />
                  <kbd>{(i + 1) % 10}</kbd>
                </span>
                <b>{name}</b>
                <small>{SFX_ROLES[name]}</small>
              </button>
            ))}
          </div>
          <p class="ag-muted ag-keys" style={{ marginTop: "16px" }}>
            Keys 1–0 play the sounds · hold Space to duck the music
          </p>
        </section>

        <section class="ag-card ag-ambcard" aria-labelledby="ag-amb">
          <h2 id="ag-amb">Room ambience</h2>
          <p class="ag-detail">
            Every mode has its own bed · <span>2.5 s crossfade</span>
          </p>
          <div class="ag-seg" role="group" aria-label="Ambient mode">
            {AMBIENT_MODES.map((m) => (
              <button
                key={m}
                aria-pressed={m === mode}
                data-testid={`mode-${m}`}
                onClick={() => {
                  setModeState(m);
                  audio.setMode(m);
                }}
              >
                {MODE_LABEL[m]}
              </button>
            ))}
          </div>
          <div class="ag-row">
            <button
              role="switch"
              aria-checked={ambienceOn}
              data-testid="ambience"
              onClick={() => {
                audio.setAmbience(!ambienceOn);
                setAmbienceOn(!ambienceOn);
              }}
            >
              <SwitchTrack />
              {ambienceOn ? "Bed on" : "Bed off"}
            </button>
          </div>
        </section>

        <section class="ag-card ag-musiccard" aria-labelledby="ag-music">
          <h2 id="ag-music">Music</h2>
          <p class="ag-detail">
            <span>Lofi loop</span> · <span>ii–V–I–vi</span> · <span>72–84 BPM</span> ·{" "}
            <span>swing 58%</span>
          </p>
          <div class="ag-row">
            <button
              aria-pressed={musicOn}
              data-testid="music"
              onClick={() => {
                void unlock();
                audio.setMusic(!musicOn);
                setMusicOn(!musicOn);
              }}
            >
              {musicOn ? <PauseIcon /> : <PlayIcon />}
              {musicOn ? "Pause music" : "Play music"}
            </button>
            <button
              aria-pressed={ducking}
              data-testid="duck"
              onPointerDown={() => duck(true)}
              onPointerUp={() => duck(false)}
              onPointerLeave={() => ducking && duck(false)}
            >
              Hold for a reveal (−{REVEAL_DUCK_DB} dB)
            </button>
          </div>
        </section>

        <section class="ag-card ag-mixcard" aria-labelledby="ag-mix">
          <h2 id="ag-mix">Mix</h2>
          <p class="ag-detail" data-testid="mix-note">
            Streamer mode ducks music by {STREAMER_DUCK_DB} dB and sets it to{" "}
            {Math.round(STREAMER_MUSIC_LEVEL * 100)}%
          </p>
          <div class="ag-mix">
            {slider("music", "Music")}
            {slider("sfx", "Sounds")}
            {slider("ambience", "Ambience")}
          </div>
          <div class="ag-row" style={{ marginTop: "16px" }}>
            <button
              role="switch"
              aria-checked={settings.streamerSafe}
              data-testid="streamer"
              onClick={() => apply(withStreamerSafe(settings, !settings.streamerSafe))}
            >
              <SwitchTrack />
              Streamer mode
            </button>
            {duckDb > 0 && (
              <span class="ag-duck" data-testid="duck-state" role="status">
                Music ducked −{duckDb} dB
              </span>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

/** Reveals `root` once the web fonts are ready, so the first paint never uses fallbacks. */
function revealWhenFontsReady(root: HTMLElement): void {
  const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
  if (!fonts) return;
  root.style.visibility = "hidden";
  const show = (): void => {
    root.style.visibility = "";
  };
  void Promise.all([
    fonts.load('600 1rem "Nunito Variable"'),
    fonts.load('600 1rem "Fredoka Variable"'),
  ])
    .then(() => fonts.ready)
    .then(show, show);
}

/** Mounts the gallery into `root` with a fresh audio system (or the given one). */
export function mountAudioGallery(
  root: HTMLElement,
  o: { audio?: AudioSystem; search?: string } = {},
): { audio: AudioSystem; unmount(): void } {
  const initialMode = parseGalleryMode(o.search ?? location.search);
  const audio = o.audio ?? createAudio({ mode: initialMode });
  if (o.audio) audio.setMode(initialMode);
  revealWhenFontsReady(root);
  render(<AudioGallery audio={audio} initialMode={initialMode} />, root);
  (window as unknown as { __SG_AUDIO__?: unknown }).__SG_AUDIO__ = { audio, lib: audioLib };
  return {
    audio,
    unmount() {
      render(null, root);
      void audio.dispose();
    },
  };
}

const appRoot = typeof document !== "undefined" ? document.getElementById("audio-gallery") : null;
if (appRoot) mountAudioGallery(appRoot);
