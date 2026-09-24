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
  STREAM_SAFE_LABEL,
  createAudio,
  withStreamerSafe,
  type AudioSettings,
  type AudioSystem,
  type SfxName,
} from "@sg/audio";
import { AMBIENT_MODES, DEFAULT_ROOM_CONFIG, type AmbientMode } from "@sg/shared";
import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { tokensFor } from "./placeholder-theme.ts";

/** What each sound is for (research 03 §8.1). */
export const SFX_ROLES: Readonly<Record<SfxName, string>> = {
  pop: "Button",
  tick: "Hover / timer",
  tok: "Piece land · rises per hop",
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

/** The mode's tokens as CSS custom properties for the page. */
export function galleryVars(mode: AmbientMode): Record<string, string> {
  const t = tokensFor(mode);
  return {
    "--bg": t.mode.uiBg,
    "--surface": t.mode.uiSurface,
    "--ink": t.mode.uiInk,
    "--muted": t.mode.uiMuted,
    "--line": t.mode.uiLine,
    "--accent": t.mode.accent,
    "--audience": t.semantic.audience,
    "--success": t.semantic.success,
    "--sky-top": t.mode.skyTop,
    "--sky-bottom": t.mode.skyBottom,
    "--r-md": `${t.radius.md}px`,
    "--r-lg": `${t.radius.lg}px`,
    "--r-pill": `${t.radius.pill}px`,
    "--ease": t.motion.easing.outSoft,
    "--dur": `${t.motion.durationMs.outSoft}ms`,
    "--dur-mode": "2500ms",
  };
}

const CSS = `
.ag{min-height:100%;box-sizing:border-box;padding:24px 16px 48px;color:var(--ink);
  background:linear-gradient(180deg,var(--sky-top),var(--sky-bottom) 280px,var(--bg) 520px);
  transition:background var(--dur-mode) var(--ease),color var(--dur-mode) var(--ease);
  font-family:"Nunito Variable","Nunito",system-ui,sans-serif}
.ag *{box-sizing:border-box}
.ag-wrap{max-width:980px;margin:0 auto;display:grid;gap:16px}
.ag h1{font:800 32px/1.1 "Fredoka Variable","Fredoka",system-ui,sans-serif;margin:0}
.ag h2{font:700 18px/1.2 "Fredoka Variable","Fredoka",system-ui,sans-serif;margin:0 0 12px}
.ag-head{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between}
.ag-badges{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.ag-pill{display:inline-flex;align-items:center;gap:6px;min-height:32px;padding:4px 12px;border-radius:var(--r-pill);
  background:var(--surface);border:1px solid var(--line);font-weight:700;font-size:14px}
.ag-dot{width:10px;height:10px;border-radius:var(--r-pill);background:var(--muted)}
.ag-pill[data-state=running] .ag-dot{background:var(--success)}
.ag-card{background:var(--surface);border:1px solid var(--line);border-radius:var(--r-lg);padding:16px;
  box-shadow:0 6px 20px -12px var(--ink)}
.ag-grid{display:grid;gap:8px;grid-template-columns:repeat(auto-fill,minmax(150px,1fr))}
.ag button{font:inherit;color:var(--ink);cursor:pointer;min-height:44px;min-width:44px;border-radius:var(--r-md);
  border:2px solid var(--line);background:var(--bg);padding:8px 12px;text-align:left;
  transition:transform var(--dur) var(--ease),border-color var(--dur) var(--ease),background var(--dur) var(--ease)}
.ag button:hover{border-color:var(--accent)}
.ag button:active{transform:scale(.97)}
.ag button:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.ag button[aria-pressed=true]{border-color:var(--accent);background:var(--surface)}
.ag button:disabled{cursor:not-allowed;opacity:.6}
.ag-sfx b{display:block;font-size:16px}
.ag-sfx small{display:block;color:var(--muted);font-size:13px}
.ag-sfx kbd{float:right;font:700 12px/1 ui-monospace,monospace;color:var(--muted)}
.ag-sfx[data-name=vote]{border-color:var(--audience)}
.ag-primary{background:var(--accent)!important;border-color:var(--accent)!important;font-weight:800;text-align:center!important}
.ag-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.ag-mix{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(200px,1fr))}
.ag label{display:grid;gap:4px;font-weight:700}
.ag input[type=range]{width:100%;min-height:44px;accent-color:var(--accent)}
.ag-meter{height:14px;border-radius:var(--r-pill);background:var(--bg);border:1px solid var(--line);overflow:hidden}
.ag-meter i{display:block;height:100%;width:0;background:var(--accent);transition:width 80ms linear}
.ag-muted{color:var(--muted);font-size:14px;margin:0}
@media (prefers-reduced-motion:reduce){.ag,.ag *{transition:none!important}}
`;

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
  const [last, setLast] = useState<string>("");
  const [level, setLevel] = useState(0);
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
    setLast(pitchStep > 0 ? `${name} +${pitchStep}` : name);
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

  // Live level meter from an analyser on the master bus (only while running).
  useEffect(() => {
    const ctx = audio.host.ctx;
    const buses = audio.buses;
    if (state !== "running" || !ctx || !buses || typeof ctx.createAnalyser !== "function") return;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    buses.master.connect(analyser);
    const data = new Float32Array(analyser.fftSize);
    let raf = 0;
    const tick = (): void => {
      analyser.getFloatTimeDomainData(data);
      let sum = 0;
      for (const v of data) sum += v * v;
      const rms = Math.sqrt(sum / data.length);
      setLevel(Math.min(1, Math.max(0, (20 * Math.log10(rms + 1e-9) + 60) / 60)));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      buses.master.disconnect(analyser);
    };
  }, [state, audio]);

  const vars = galleryVars(mode);
  const slider = (key: "music" | "sfx" | "ambience", label: string) => (
    <label>
      {label} · {Math.round(settings[key] * 100)}%
      <input
        type="range"
        min={0}
        max={100}
        value={Math.round(settings[key] * 100)}
        aria-label={`${label} level`}
        onInput={(e) =>
          apply({ ...settings, [key]: Number((e.target as HTMLInputElement).value) / 100 })
        }
      />
    </label>
  );

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

        {state === "locked" && (
          <button class="ag-primary" data-testid="unlock" onClick={() => void unlock()}>
            Enable sound
          </button>
        )}

        <section class="ag-card" aria-labelledby="ag-sfx">
          <h2 id="ag-sfx">Sound effects · C major pentatonic</h2>
          <div class="ag-grid">
            {SFX_LIST.map((name, i) => (
              <button
                key={name}
                class="ag-sfx"
                data-name={name}
                data-testid={`sfx-${name}`}
                onClick={() => play(name)}
                title={`${SFX_RECIPES[name].voices.length} voices`}
              >
                <kbd>{(i + 1) % 10}</kbd>
                <b>{name}</b>
                <small>{SFX_ROLES[name]}</small>
              </button>
            ))}
          </div>
          <p class="ag-muted" aria-live="polite" data-testid="last">
            {last ? `Played: ${last}` : "Press a sound, or keys 1–0."}
          </p>
        </section>

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
          <div class="ag-row" style={{ marginTop: "12px" }}>
            <button
              aria-pressed={settings.streamerSafe}
              data-testid="streamer"
              onClick={() => apply(withStreamerSafe(settings, !settings.streamerSafe))}
            >
              Streamer mode {settings.streamerSafe ? "on (music −12 dB)" : "off"}
            </button>
          </div>
          <p class="ag-muted" style={{ margin: "12px 0 4px" }}>
            Master level
          </p>
          <div
            class="ag-meter"
            role="meter"
            aria-label="Master level"
            aria-valuemin={0}
            aria-valuemax={1}
            aria-valuenow={level}
          >
            <i style={{ width: `${Math.round(level * 100)}%` }} />
          </div>
        </section>
      </div>
    </div>
  );
}

/** Mounts the gallery into `root` with a fresh audio system (or the given one). */
export function mountAudioGallery(
  root: HTMLElement,
  o: { audio?: AudioSystem; search?: string } = {},
): { audio: AudioSystem; unmount(): void } {
  const initialMode = parseGalleryMode(o.search ?? location.search);
  const audio = o.audio ?? createAudio({ mode: initialMode });
  if (o.audio) audio.setMode(initialMode);
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
