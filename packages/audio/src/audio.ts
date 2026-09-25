/**
 * The audio system the shell owns (one per page): the shared context, the buses, sfx, the
 * ambience bed and the lofi loop, driven by the room's `audio` settings and ambient mode.
 *
 * Nothing makes a sound (or even creates an `AudioContext`) before the first user gesture;
 * calls made before that only update state, so the right bed and music start on unlock.
 * `sfx` is structurally the engine's `StageContext["sfx"]`, so the shell can hand it to games
 * directly. Streamer safety: all audio is synthesised here, so the UI can say "Stream-safe
 * audio ✓" ({@link STREAM_SAFE_LABEL}).
 *
 * @module
 */
import type { AmbientMode } from "@sg/shared";
import { createAmbience, type Ambience } from "./ambience/player.ts";
import { createBuses, REVEAL_DUCK_DB, type AudioSettings, type Buses } from "./buses.ts";
import {
  createAudioContextHost,
  type AudioContextHost,
  type AudioContextHostOptions,
} from "./context.ts";
import { createLofi, type Lofi } from "./lofi.ts";
import { createSfxPlayer, type SfxPlayer } from "./sfx/play.ts";
import type { SfxName } from "./sfx/recipes.ts";

/** The label the UI shows next to the audio settings (SPEC §13.7). */
export const STREAM_SAFE_LABEL = "Stream-safe audio ✓";

/** Options of {@link createAudio}. */
export interface AudioOptions extends Omit<AudioContextHostOptions, "onCreate"> {
  /** Initial settings (default: music 0.6, sfx 0.8, ambience 0.5, not streamer-safe). */
  settings?: AudioSettings;
  /** Initial ambient mode (default `dusk`). */
  mode?: AmbientMode;
  /** Seed for the lofi loop's tempo and chord-set order. */
  seed?: number | string;
}

/** The page's audio system. */
export interface AudioSystem {
  readonly host: AudioContextHost;
  /** The buses, once the context exists. */
  readonly buses: Buses | null;
  readonly settings: Readonly<AudioSettings>;
  readonly mode: AmbientMode;
  /** Unlock from a user gesture (see {@link AudioContextHost.unlock}). */
  unlock(): Promise<void>;
  /** Plays a sound effect now; a no-op until unlocked or while hidden. */
  sfx(name: SfxName, opts?: { pitchStep?: number }): void;
  /** Applies new room audio settings (levels + streamer-safe duck). */
  applySettings(settings: AudioSettings): void;
  /** Switches the ambient mode: swell, 2.5 s bed crossfade, lofi style from the next bar. */
  setMode(mode: AmbientMode): void;
  /** Starts or stops the ambience bed (on by default). */
  setAmbience(on: boolean): void;
  /** Starts or stops the lofi loop (off by default). */
  setMusic(on: boolean): void;
  /** Holds a music duck (default −4 dB) for a reveal or countdown; call the result to release. */
  duck(db?: number): () => void;
  /** Stops everything and closes the context. */
  dispose(): Promise<void>;
}

const DEFAULT_SETTINGS: AudioSettings = {
  music: 0.6,
  sfx: 0.8,
  ambience: 0.5,
  streamerSafe: false,
};

/** Creates the page's {@link AudioSystem}. Call `host.unlockOnGesture()` or `unlock()` next. */
export function createAudio(o: AudioOptions = {}): AudioSystem {
  let settings: AudioSettings = { ...(o.settings ?? DEFAULT_SETTINGS) };
  let mode: AmbientMode = o.mode ?? "dusk";
  let wantAmbience = true;
  let wantMusic = false;
  let buses: Buses | null = null;
  let player: SfxPlayer | null = null;
  let ambience: Ambience | null = null;
  let lofi: Lofi | null = null;
  // Duck holds; ones taken before the context exists are replayed onto the buses.
  const holds = new Map<number, { db: number; release: (() => void) | null }>();
  let duckId = 0;

  const syncBeds = (): void => {
    const ctx = host.ctx;
    if (!ctx || !buses) return;
    if (wantAmbience) {
      ambience ??= createAmbience(ctx, buses.ambience);
      ambience.setMode(mode);
    } else if (ambience) {
      ambience.stop();
      ambience = null;
    }
    if (wantMusic) {
      if (lofi) lofi.setMode(mode);
      else
        lofi = createLofi(ctx, buses.music, {
          mode,
          ...(o.seed !== undefined ? { seed: o.seed } : {}),
        });
    } else if (lofi) {
      lofi.stop();
      lofi = null;
    }
  };

  const host = createAudioContextHost({
    ...(o.create ? { create: o.create } : {}),
    ...(o.doc ? { doc: o.doc } : {}),
    onCreate(ctx) {
      buses = createBuses(ctx, settings);
      player = createSfxPlayer(ctx, buses.sfx);
      for (const d of holds.values()) d.release = buses.duck(d.db);
      syncBeds();
    },
  });

  return {
    host,
    get buses() {
      return buses;
    },
    get settings() {
      return settings;
    },
    get mode() {
      return mode;
    },
    unlock: () => host.unlock(),
    sfx(name, opts) {
      if (host.running) player?.play(name, opts);
    },
    applySettings(s) {
      settings = { ...s };
      buses?.apply(settings);
    },
    setMode(m) {
      if (m === mode) return;
      mode = m;
      if (host.running) player?.swell();
      syncBeds();
    },
    setAmbience(on) {
      wantAmbience = on;
      syncBeds();
    },
    setMusic(on) {
      wantMusic = on;
      syncBeds();
    },
    duck(db) {
      const id = ++duckId;
      const entry = { db: db ?? REVEAL_DUCK_DB, release: buses ? buses.duck(db) : null };
      holds.set(id, entry);
      return () => {
        if (!holds.delete(id)) return;
        entry.release?.();
      };
    },
    async dispose() {
      wantAmbience = false;
      wantMusic = false;
      syncBeds();
      buses?.dispose();
      buses = null;
      player = null;
      await host.dispose();
    },
  };
}
