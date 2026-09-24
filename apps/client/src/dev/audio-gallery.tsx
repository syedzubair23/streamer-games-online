/// <reference lib="dom" />
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
import "@fontsource-variable/fredoka/wght.css";
import "@fontsource-variable/nunito/wght.css";
import { render } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { contrastRatio, tokensFor } from "./placeholder-theme.ts";

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

/** The mode's tokens as CSS custom properties for the page. */
export function galleryVars(mode: AmbientMode): Record<string, string> {
  const t = tokensFor(mode);
  const m = t.mode;
  return {
    "--bg": m.uiBg,
    "--surface": m.uiSurface,
    "--surface-glass": hexAlpha(m.uiSurface, m.uiSurfaceAlpha),
    "--ink": m.uiInk,
    "--muted": m.uiMuted,
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

const CSS = `
html,body{height:100%;margin:0;background:var(--bg);transition:background var(--dur-mode) var(--ease)}
.ag{min-height:100dvh;box-sizing:border-box;padding:24px 16px 48px;color:var(--ink);
  background:linear-gradient(180deg,var(--sky-top),var(--sky-bottom) 45%,var(--bg)) fixed;
  transition:color var(--dur-mode) var(--ease);
  font:600 1rem/1.4 "Nunito Variable","Nunito",system-ui,sans-serif;font-variant-numeric:tabular-nums}
.ag *{box-sizing:border-box}
.ag-wrap{max-width:1440px;margin:0 auto;display:grid;gap:24px;grid-template-columns:minmax(0,1fr);align-items:start}
.ag-side{display:grid;gap:24px;align-content:start}
@media (min-width:1280px){.ag{padding:32px 48px 48px}.ag-wrap{grid-template-columns:minmax(0,7fr) minmax(0,5fr)}
  .ag-hero,.ag-head{grid-column:1/-1}}
.ag h1{font:700 2rem/1.1 ${DISPLAY};margin:0}
.ag h2{font:600 1.5rem/1.2 ${DISPLAY};margin:0 0 16px}
.ag-head{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between}
.ag-badges{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.ag-pill{display:inline-flex;align-items:center;gap:8px;min-height:36px;padding:4px 14px;border-radius:var(--r-pill);
  background:var(--surface-glass);border:1px solid var(--line);font-weight:700;font-size:.875rem}
.ag-dot{width:10px;height:10px;border-radius:var(--r-pill);background:var(--muted)}
.ag-pill[data-state=running] .ag-dot{background:var(--success);box-shadow:0 0 0 4px color-mix(in srgb,var(--success),transparent 70%)}
.ag-card{background:var(--surface-glass);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);
  border:1px solid var(--line);border-bottom:3px solid ${BASE};border-radius:var(--r-lg);padding:24px;
  box-shadow:0 14px 32px -16px var(--shadow),0 2px 6px -2px var(--shadow)}
.ag-hero{display:grid;gap:16px;grid-template-columns:minmax(0,1fr);align-items:center;
  box-shadow:0 18px 40px -18px var(--shadow),0 0 48px -12px var(--glow)}
@media (min-width:720px){.ag-hero{grid-template-columns:minmax(0,1fr) minmax(240px,auto)}}
.ag-now{display:grid;gap:12px;min-width:0}
.ag-now-label{font-size:.875rem;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;font-weight:800}
.ag-now-title{font:600 1.5rem/1.2 ${DISPLAY};margin:0;min-height:1.8rem}
.ag-slot{min-height:56px;display:grid}
.ag-grid{display:grid;gap:12px;grid-template-columns:repeat(2,minmax(0,1fr));grid-auto-rows:1fr}
@media (min-width:480px){.ag-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media (min-width:900px){.ag-grid{grid-template-columns:repeat(5,minmax(0,1fr))}}
.ag button{position:relative;font:inherit;font-weight:700;color:var(--ink);cursor:pointer;min-height:48px;min-width:48px;
  border-radius:var(--r-md);border:2px solid var(--line);border-bottom:3px solid ${BASE};background:var(--surface);
  padding:10px 14px;text-align:left;
  transition:transform var(--dur-back) var(--ease-back),box-shadow var(--dur) var(--ease),background var(--dur) var(--ease),border-color var(--dur) var(--ease)}
.ag button:hover{transform:translateY(-2px);box-shadow:0 10px 20px -10px var(--shadow)}
.ag button:active{transform:scale(.96);transition-duration:120ms;transition-timing-function:var(--ease)}
.ag button:focus-visible{outline:3px solid var(--accent);outline-offset:3px}
.ag button[aria-pressed=true]{background:color-mix(in srgb,var(--accent) 18%,var(--surface));border-color:var(--accent)}
.ag button[aria-pressed=true]::before{content:"\\2713";display:inline-block;margin-right:8px;font-weight:800}
.ag button:disabled{cursor:not-allowed;opacity:.6}
.ag-sfx{display:grid;align-content:start;gap:2px;height:100%}
.ag-sfx b{display:block;font:600 1.25rem/1.2 ${DISPLAY}}
.ag-sfx small{display:block;color:var(--muted);font-size:.875rem;font-weight:600}
.ag-sfx kbd{position:absolute;top:8px;right:10px;min-width:24px;height:24px;display:grid;place-items:center;
  border-radius:8px;border:1px solid var(--line);font:inherit;font-size:.75rem;font-weight:800;color:var(--muted);background:var(--bg)}
.ag-sfx[data-last=true]{animation:ag-glow 400ms var(--ease)}
@keyframes ag-glow{0%{box-shadow:0 0 0 3px var(--glow),0 0 28px 6px var(--glow)}100%{box-shadow:0 0 0 0 transparent}}
.ag-aud{display:inline-flex;align-items:center;gap:6px;color:var(--ink)}
.ag-aud::before{content:"";width:10px;height:10px;border-radius:var(--r-pill);background:var(--audience)}
@media (hover:none){.ag-sfx kbd,.ag-keys{display:none}}
.ag .ag-primary{width:100%;min-height:56px;text-align:center;font:600 1.25rem/1 ${DISPLAY};
  background:var(--accent);color:var(--on-accent);border-color:var(--accent);
  border-bottom-color:color-mix(in srgb,var(--accent),#000 22%);box-shadow:0 10px 24px -10px var(--accent)}
.ag-chip{display:flex;align-items:center;justify-content:center;gap:10px;min-height:56px;padding:8px 18px;
  border-radius:var(--r-pill);background:color-mix(in srgb,var(--success) 20%,var(--surface));border:2px solid var(--success);
  font-weight:800;animation:ag-in var(--dur) var(--ease)}
@keyframes ag-in{from{transform:scale(.92);opacity:.4}to{transform:none;opacity:1}}
.ag-row{display:flex;flex-wrap:wrap;gap:12px;align-items:center}
.ag-mix{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(180px,1fr))}
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
.ag-muted{color:var(--muted);font-size:.875rem;margin:0}
@media (prefers-reduced-motion:reduce){.ag,.ag *,html,body{transition:none!important;animation:none!important}}
`;

/** Peak-hold fall per animation frame (fraction of full scale). */
const PEAK_DECAY = 0.006;

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

  return (
    <div class="ag" style={vars} data-mode={mode}>
      <style>{CSS}</style>
      <div class="ag-wrap">
        <header class="ag-head">
          <h1>Audio gallery</h1>
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
            {state === "locked" ? (
              <button class="ag-primary" data-testid="unlock" onClick={() => void unlock()}>
                Enable sound
              </button>
            ) : (
              <span class="ag-chip" data-testid="sound-on">
                <span class="ag-dot" aria-hidden="true" style={{ background: "var(--success)" }} />
                {state === "running" ? "Sound on" : `Sound ${state}`}
              </span>
            )}
          </div>
        </section>

        <section class="ag-card" aria-labelledby="ag-sfx">
          <h2 id="ag-sfx">Sound effects · C major pentatonic</h2>
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
                <kbd aria-hidden="true">{(i + 1) % 10}</kbd>
                <b>{name}</b>
                <small class={name === "vote" ? "ag-aud" : undefined}>{SFX_ROLES[name]}</small>
              </button>
            ))}
          </div>
          <p class="ag-muted ag-keys" style={{ marginTop: "16px" }}>
            Keys 1–0 play the sounds · hold Space to duck the music
          </p>
        </section>

        <div class="ag-side">
          <section class="ag-card" aria-labelledby="ag-amb">
            <h2 id="ag-amb">Ambience · 2.5 s crossfade</h2>
            <div class="ag-row" role="group" aria-label="Ambient mode">
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
              <button
                aria-pressed={ambienceOn}
                data-testid="ambience"
                onClick={() => {
                  audio.setAmbience(!ambienceOn);
                  setAmbienceOn(!ambienceOn);
                }}
              >
                {ambienceOn ? "Bed on" : "Bed off"}
              </button>
            </div>
          </section>

          <section class="ag-card" aria-labelledby="ag-music">
            <h2 id="ag-music">Lofi loop · ii–V–I–vi, 72–84 BPM, swing 58%</h2>
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
                {musicOn ? "Stop music" : "Play music"}
              </button>
              <button
                aria-pressed={ducking}
                data-testid="duck"
                onPointerDown={() => duck(true)}
                onPointerUp={() => duck(false)}
                onPointerLeave={() => ducking && duck(false)}
              >
                Hold to duck (reveal, −{REVEAL_DUCK_DB} dB)
              </button>
            </div>
          </section>

          <section class="ag-card" aria-labelledby="ag-mix">
            <h2 id="ag-mix">Mix</h2>
            <div class="ag-mix">
              {slider("music", "Music")}
              {slider("sfx", "SFX")}
              {slider("ambience", "Ambience")}
            </div>
            <div class="ag-row" style={{ marginTop: "16px" }}>
              <button
                aria-pressed={settings.streamerSafe}
                data-testid="streamer"
                onClick={() => apply(withStreamerSafe(settings, !settings.streamerSafe))}
              >
                Streamer mode {settings.streamerSafe ? "on" : "off"}
              </button>
              {duckDb > 0 && (
                <span class="ag-duck" data-testid="duck-state" role="status">
                  Music ducked −{duckDb} dB
                </span>
              )}
            </div>
            <p class="ag-muted" style={{ marginTop: "12px" }}>
              Streamer mode ducks the music {STREAMER_DUCK_DB} dB and caps it at{" "}
              {Math.round(STREAMER_MUSIC_LEVEL * 100)}% (research 03 §8).
            </p>
          </section>
        </div>
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
