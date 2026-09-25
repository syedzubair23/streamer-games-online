/**
 * The mix (research 03 §8, SPEC §13.7):
 *
 * ```
 * sfx      → lowpass 7 kHz → gentle compressor ─┐
 * music    → duck ──────────────────────────────┼→ master → destination
 * ambience ─────────────────────────────────────┘
 * ```
 *
 * Separate Music / SFX / Ambience levels (room setting `audio`, 0..1 on a squared taper).
 * **Ducking:** reveals and countdowns hold a −4 dB duck on the music ({@link Buses.duck}), and
 * streamer-safe mode holds −12 dB while it is on. Holds are reference counted and the deepest
 * active one wins; the duck dips in 150 ms and swells back over 800 ms.
 *
 * @module
 */

/** The room's audio settings (SPEC §7 `RoomConfig.audio`). Levels are 0..1. */
export interface AudioSettings {
  music: number;
  sfx: number;
  ambience: number;
  streamerSafe: boolean;
}

/** Music duck for reveals and countdowns, in dB (SPEC §13.7). */
export const REVEAL_DUCK_DB = 4;
/** Music duck while streamer-safe mode is on, in dB (research 03 §8). */
export const STREAMER_DUCK_DB = 12;
/** Music level streamer-safe mode defaults to (research 03 §8). */
export const STREAMER_MUSIC_LEVEL = 0.35;
/** SFX bus lowpass: no energy above ~6 kHz reaches the stream (research 03 §8). */
export const SFX_LOWPASS_HZ = 7000;
/** Duck attack and release, in ms. */
export const DUCK_ATTACK_MS = 150;
export const DUCK_RELEASE_MS = 800;
/** Level changes ramp over this long so sliders never zipper. */
export const LEVEL_RAMP_MS = 80;

/** dB → linear gain. */
export function dbToGain(db: number): number {
  return 10 ** (db / 20);
}

/** Slider level (0..1) → gain on a squared taper, so 50% sounds about half as loud. */
export function levelToGain(level: number): number {
  const v = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
  return v * v;
}

/**
 * Turns streamer-safe mode on or off in a settings object (pure). Turning it on also lowers the
 * music to {@link STREAMER_MUSIC_LEVEL} if it is louder; turning it off leaves the levels alone.
 */
export function withStreamerSafe(s: AudioSettings, on: boolean): AudioSettings {
  return on
    ? { ...s, streamerSafe: true, music: Math.min(s.music, STREAMER_MUSIC_LEVEL) }
    : { ...s, streamerSafe: false };
}

/** The bus graph of one context. */
export interface Buses {
  readonly master: GainNode;
  /** Input for sound effects. */
  readonly sfx: GainNode;
  /** Input for music. */
  readonly music: GainNode;
  /** Input for ambience beds. */
  readonly ambience: GainNode;
  /** The music duck stage (its gain is the current duck). */
  readonly musicDuck: GainNode;
  readonly sfxLowpass: BiquadFilterNode;
  readonly compressor: DynamicsCompressorNode;
  /** Applies levels (and the streamer-safe duck) from the room settings. */
  apply(settings: AudioSettings): void;
  /**
   * Holds a music duck of `db` (default {@link REVEAL_DUCK_DB}) until the returned release is
   * called (idempotent). Use around reveals and countdowns; release after the win sting.
   */
  duck(db?: number): () => void;
  /** The current duck target in dB (0 = none). */
  readonly duckDb: number;
  /** Disconnects every node. */
  dispose(): void;
}

function ramp(param: AudioParam, value: number, now: number, ms: number): void {
  param.cancelScheduledValues(now);
  param.setValueAtTime(param.value, now);
  param.setTargetAtTime(value, now, ms / 1000 / 3);
}

/** Builds the bus graph on `ctx`, connected to `destination` (default `ctx.destination`). */
export function createBuses(
  ctx: BaseAudioContext,
  settings: AudioSettings,
  destination: AudioNode = ctx.destination,
): Buses {
  const master = ctx.createGain();
  const sfx = ctx.createGain();
  const music = ctx.createGain();
  const ambience = ctx.createGain();
  const musicDuck = ctx.createGain();
  const sfxLowpass = ctx.createBiquadFilter();
  sfxLowpass.type = "lowpass";
  sfxLowpass.frequency.value = SFX_LOWPASS_HZ;
  sfxLowpass.Q.value = 0.5;
  // Gentle: only catches pile-ups of overlapping sfx.
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -18;
  compressor.knee.value = 12;
  compressor.ratio.value = 3;
  compressor.attack.value = 0.01;
  compressor.release.value = 0.25;

  sfx.connect(sfxLowpass).connect(compressor).connect(master);
  music.connect(musicDuck).connect(master);
  ambience.connect(master);
  master.connect(destination);

  const holds = new Map<number, number>();
  let streamerHold: (() => void) | null = null;
  let duckDb = 0;
  let nextId = 1;
  const retarget = (): void => {
    let deepest = 0;
    for (const db of holds.values()) deepest = Math.max(deepest, db);
    if (deepest === duckDb) return;
    const deeper = deepest > duckDb;
    duckDb = deepest;
    ramp(
      musicDuck.gain,
      dbToGain(-deepest),
      ctx.currentTime,
      deeper ? DUCK_ATTACK_MS : DUCK_RELEASE_MS,
    );
  };

  const buses: Buses = {
    master,
    sfx,
    music,
    ambience,
    musicDuck,
    sfxLowpass,
    compressor,
    get duckDb() {
      return duckDb;
    },
    apply(s) {
      const now = ctx.currentTime;
      ramp(sfx.gain, levelToGain(s.sfx), now, LEVEL_RAMP_MS);
      ramp(music.gain, levelToGain(s.music), now, LEVEL_RAMP_MS);
      ramp(ambience.gain, levelToGain(s.ambience), now, LEVEL_RAMP_MS);
      if (s.streamerSafe && !streamerHold) streamerHold = buses.duck(STREAMER_DUCK_DB);
      else if (!s.streamerSafe && streamerHold) {
        streamerHold();
        streamerHold = null;
      }
    },
    duck(db = REVEAL_DUCK_DB) {
      const id = nextId++;
      holds.set(id, Math.max(0, db));
      retarget();
      return () => {
        if (holds.delete(id)) retarget();
      };
    },
    dispose() {
      for (const n of [sfx, sfxLowpass, compressor, music, musicDuck, ambience, master])
        n.disconnect();
    },
  };
  // Start at the settings' levels without a ramp from unity.
  sfx.gain.value = levelToGain(settings.sfx);
  music.gain.value = levelToGain(settings.music);
  ambience.gain.value = levelToGain(settings.ambience);
  buses.apply(settings);
  return buses;
}
