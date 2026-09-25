/**
 * Quality tiers (SPEC §10, research 03 §5.5 and 04 §2, §4): the per-tier presets and budgets,
 * boot-time tier detection, and dynamic resolution with asymmetric hysteresis.
 *
 * Detection runs once at boot (device hints plus the boot micro-benchmark from `bench.ts`);
 * after that {@link DynamicResolution} adapts the render scale between 0.5× and 1.0× of the
 * tier's DPR cap from the frame times of frames the loop actually renders.
 *
 * @module
 */
import type { QualityTier } from "./types.ts";

/** Everything that differs between tiers. Budgets are the SPEC §10 CI limits. */
export interface TierPreset {
  tier: QualityTier;
  /** Device-pixel-ratio cap; dynamic resolution scales 0.5×–1.0× of it. */
  dprCap: number;
  /** MSAA (`antialias` on the WebGL context). */
  antialias: boolean;
  /** Frame rate of ambient life (steam, weather, drift) when nothing else animates. */
  ambientFps: number;
  /** Frame-time target (ms) for dynamic resolution: 30 fps on low/mid, 60 fps on high. */
  frameTargetMs: number;
  /** `blob` everywhere; high adds one 1024² directional map updated only when pieces move. */
  shadows: "blob" | "blob+map";
  /** Shadow map edge (px), 0 when there is no map. */
  shadowMapSize: number;
  /** The rim "toy glow" on toon pieces (mid and high). */
  rim: boolean;
  /** Animated props (cat tail, mug steam, plant sway). */
  animatedProps: boolean;
  /** Dust motes in the lamp beam. */
  dustMotes: boolean;
  /** Weather particle count. */
  weatherParticles: number;
  /** Confetti pool size. */
  confetti: number;
  /** Grain overlay animation (static on low). */
  grainAnimated: boolean;
  /** Maximum procedural texture edge (px). */
  maxTextureSize: number;
  /** Texture anisotropy. */
  anisotropy: number;
  /** Segments for lathe-turned pieces. */
  latheSegments: number;
  /** Corner segments of rounded boxes. */
  roundedSegments: number;
  /** SPEC §10 CI budgets for a whole frame (environment included). */
  budgets: { drawCalls: number; triangles: number; programs: number; textureMB: number };
}

/** The three tier presets (SPEC §10 table; research 03 §5.5 for props/particles). */
export const TIERS: Readonly<Record<QualityTier, Readonly<TierPreset>>> = Object.freeze({
  low: Object.freeze({
    tier: "low",
    dprCap: 1.25,
    antialias: false,
    ambientFps: 30,
    frameTargetMs: 1000 / 30,
    shadows: "blob",
    shadowMapSize: 0,
    rim: false,
    animatedProps: false,
    dustMotes: false,
    weatherParticles: 80,
    confetti: 120,
    grainAnimated: false,
    maxTextureSize: 1024,
    anisotropy: 1,
    latheSegments: 12,
    roundedSegments: 2,
    budgets: Object.freeze({ drawCalls: 60, triangles: 50_000, programs: 10, textureMB: 24 }),
  }),
  mid: Object.freeze({
    tier: "mid",
    dprCap: 1.5,
    antialias: true,
    ambientFps: 30,
    frameTargetMs: 1000 / 30,
    shadows: "blob",
    shadowMapSize: 0,
    rim: true,
    animatedProps: true,
    dustMotes: false,
    weatherParticles: 180,
    confetti: 200,
    grainAnimated: true,
    maxTextureSize: 1024,
    anisotropy: 2,
    latheSegments: 16,
    roundedSegments: 3,
    budgets: Object.freeze({ drawCalls: 100, triangles: 100_000, programs: 12, textureMB: 48 }),
  }),
  high: Object.freeze({
    tier: "high",
    dprCap: 2,
    antialias: true,
    ambientFps: 60,
    frameTargetMs: 1000 / 60,
    shadows: "blob+map",
    shadowMapSize: 1024,
    rim: true,
    animatedProps: true,
    dustMotes: true,
    weatherParticles: 300,
    confetti: 300,
    grainAnimated: true,
    maxTextureSize: 2048,
    anisotropy: 4,
    latheSegments: 20,
    roundedSegments: 4,
    budgets: Object.freeze({ drawCalls: 150, triangles: 150_000, programs: 14, textureMB: 64 }),
  }),
});

/** The preset of a tier. */
export function tierPreset(tier: QualityTier): Readonly<TierPreset> {
  return TIERS[tier];
}

/** Boot micro-benchmark thresholds (median ms per frame, SPEC §10). */
export const BENCH_LOW_MS = 8;
/** Below this the device may run the high tier (with ≥ 8 cores on desktop). */
export const BENCH_HIGH_MS = 3;

/** What detection looks at. Every field is optional (browsers hide some of them). */
export interface DeviceHints {
  hardwareConcurrency?: number | undefined;
  /** GB, from `navigator.deviceMemory` (Chromium only). */
  deviceMemory?: number | undefined;
  /** A phone or tablet (UA-CH `mobile`, or the UA string). */
  mobile?: boolean | undefined;
}

/** A user/host override: Battery / Balanced / Pretty map to low / mid / high. */
export type QualityOverride = QualityTier | "auto";

/** Inputs of {@link detectTier}. */
export interface DetectInput {
  hints: DeviceHints;
  /** Median frame time of the boot micro-benchmark (ms), if it ran. */
  benchMs?: number | undefined;
  /** Settings → Graphics override. */
  override?: QualityOverride | undefined;
  /** `?obs=1` / Stage "pretty": the streamed Stage always runs high. */
  obs?: boolean | undefined;
}

/**
 * Picks the boot tier (SPEC §10): an explicit override or OBS mode wins; then **low** when
 * `hardwareConcurrency ≤ 4` or `deviceMemory ≤ 4` or the bench median is above 8 ms; **high**
 * on desktop with ≥ 8 cores and a bench under 3 ms; **mid** otherwise.
 */
export function detectTier(input: DetectInput): QualityTier {
  if (input.override !== undefined && input.override !== "auto") return input.override;
  if (input.obs === true) return "high";
  const { hardwareConcurrency: cores, deviceMemory: mem, mobile } = input.hints;
  const bench = input.benchMs;
  if (
    (cores !== undefined && cores <= 4) ||
    (mem !== undefined && mem <= 4) ||
    (bench !== undefined && bench > BENCH_LOW_MS)
  )
    return "low";
  if (
    mobile !== true &&
    cores !== undefined &&
    cores >= 8 &&
    bench !== undefined &&
    bench < BENCH_HIGH_MS
  )
    return "high";
  return "mid";
}

/** The navigator fields detection reads (a real `Navigator` satisfies it). */
export interface NavigatorLike {
  hardwareConcurrency?: number;
  userAgent?: string;
  deviceMemory?: number;
  userAgentData?: { mobile?: boolean };
}

/** Reads {@link DeviceHints} from a navigator. */
export function readDeviceHints(nav: NavigatorLike | undefined): DeviceHints {
  if (nav === undefined) return {};
  const ua = nav.userAgent ?? "";
  const mobile = nav.userAgentData?.mobile ?? /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
  return {
    hardwareConcurrency: nav.hardwareConcurrency,
    deviceMemory: nav.deviceMemory,
    mobile,
  };
}

/** URL flags that affect quality: `?quality=low|mid|high|auto`, `?obs=1`, `?overlay=1`. */
export interface QualityParams {
  override: QualityOverride;
  obs: boolean;
  overlay: boolean;
}

/** Parses the quality URL flags (unknown values fall back to `auto`). */
export function parseQualityParams(search: string): QualityParams {
  const p = new URLSearchParams(search);
  const q = p.get("quality") ?? p.get("tier");
  const override: QualityOverride = q === "low" || q === "mid" || q === "high" ? q : "auto";
  const on = (k: string): boolean => {
    const v = p.get(k);
    return v !== null && v !== "0" && v !== "false";
  };
  return { override, obs: on("obs"), overlay: on("overlay") };
}

/** The pixel ratio to render at: `min(devicePixelRatio, tier cap) × dynamic scale`. */
export function effectivePixelRatio(
  devicePixelRatio: number,
  tier: QualityTier,
  scale = 1,
): number {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return Math.min(dpr, TIERS[tier].dprCap) * scale;
}

// ---- Dynamic resolution (SPEC §10) ------------------------------------------------------------

/** Options of {@link DynamicResolution}. */
export interface DynamicResolutionOptions {
  /** Frame-time target in ms (the tier's `frameTargetMs`). */
  targetMs: number;
  /** Disabled in overlay and `?obs=1` mode (fixed output): the scale stays 1. */
  enabled?: boolean;
  /** Frames per evaluation window (default 30). */
  windowSize?: number;
  /** Frames ignored after a game load or mode switch (shader compile hitches; default 60). */
  warmupFrames?: number;
  /** Minimum time between two scale changes (default 1000 ms). */
  minIntervalMs?: number;
  /** Good windows in a row before stepping up (default 3). */
  goodWindows?: number;
  /** Called when the scale changes. */
  onChange?: (scale: number) => void;
  /** Called on each bad window while already at the floor (the shell may drop a tier). */
  onFloor?: () => void;
}

/** Scale bounds and steps of SPEC §10. */
export const DYNRES = Object.freeze({
  min: 0.5,
  max: 1,
  down: 0.1,
  up: 0.05,
  /** A window is bad when its p90 exceeds `target × badRatio`. */
  badRatio: 1.15,
  /** A window is good when its p90 is below `target × goodRatio`. */
  goodRatio: 0.7,
});

/**
 * Dynamic resolution with asymmetric hysteresis (SPEC §10): the render scale steps **down by
 * 0.1 after one bad window** (p90 > 1.15 × target) and **up by 0.05 after three good windows**
 * in a row (p90 < 0.7 × target), **at most once per second**, clamped to 0.5–1.0 and quantized
 * to 0.05 so the framebuffer is not reallocated for noise. Feed it the frame time of each
 * rendered frame (never idle gaps) with {@link push}; it allocates nothing per frame.
 */
export class DynamicResolution {
  #scale = 1;
  readonly #target: number;
  readonly #enabled: boolean;
  readonly #window: Float32Array;
  readonly #sorted: Float32Array;
  #filled = 0;
  #ignore: number;
  readonly #warmup: number;
  readonly #minInterval: number;
  readonly #goodNeeded: number;
  #good = 0;
  #lastChange = Number.NEGATIVE_INFINITY;
  readonly #onChange: ((scale: number) => void) | undefined;
  readonly #onFloor: (() => void) | undefined;
  /** Evaluated windows so far (tests and the perf HUD). */
  windows = 0;
  /** p90 of the last evaluated window (ms). */
  lastP90 = 0;

  constructor(o: DynamicResolutionOptions) {
    if (!(o.targetMs > 0)) throw new RangeError("DynamicResolution: targetMs must be > 0");
    this.#target = o.targetMs;
    this.#enabled = o.enabled !== false;
    const size = Math.max(4, Math.floor(o.windowSize ?? 30));
    this.#window = new Float32Array(size);
    this.#sorted = new Float32Array(size);
    this.#warmup = Math.max(0, Math.floor(o.warmupFrames ?? 60));
    this.#ignore = this.#warmup;
    this.#minInterval = o.minIntervalMs ?? 1000;
    this.#goodNeeded = Math.max(1, Math.floor(o.goodWindows ?? 3));
    this.#onChange = o.onChange;
    this.#onFloor = o.onFloor;
  }

  /** The current render scale (0.5–1.0; always 1 when disabled). */
  get scale(): number {
    return this.#scale;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  /**
   * Records the frame time of one rendered frame at time `nowMs`. Returns `true` when the scale
   * changed (the caller then resizes the drawing buffer).
   */
  push(frameMs: number, nowMs: number): boolean {
    if (!this.#enabled || !Number.isFinite(frameMs) || frameMs < 0) return false;
    if (this.#ignore > 0) {
      this.#ignore--;
      return false;
    }
    this.#window[this.#filled++] = frameMs;
    if (this.#filled < this.#window.length) return false;
    this.#filled = 0;
    this.windows++;
    const p90 = percentileInto(this.#window, this.#sorted, 0.9);
    this.lastP90 = p90;
    if (p90 > this.#target * DYNRES.badRatio) {
      this.#good = 0;
      if (this.#scale <= DYNRES.min + 1e-9) {
        this.#onFloor?.();
        return false;
      }
      return this.#set(this.#scale - DYNRES.down, nowMs);
    }
    if (p90 < this.#target * DYNRES.goodRatio) {
      if (this.#scale >= DYNRES.max - 1e-9) {
        this.#good = 0;
        return false;
      }
      this.#good++;
      if (this.#good < this.#goodNeeded) return false;
      const changed = this.#set(this.#scale + DYNRES.up, nowMs);
      if (changed) this.#good = 0;
      return changed;
    }
    this.#good = 0;
    return false;
  }

  /**
   * Ignores the next `frames` frames and clears the current window: call it after a game load
   * or an ambient mode switch (compile hitches must not count).
   */
  reset(frames = this.#warmup): void {
    this.#ignore = Math.max(0, Math.floor(frames));
    this.#filled = 0;
    this.#good = 0;
  }

  #set(next: number, nowMs: number): boolean {
    if (nowMs - this.#lastChange < this.#minInterval) return false;
    const q = Math.round(Math.min(DYNRES.max, Math.max(DYNRES.min, next)) * 20) / 20;
    if (q === this.#scale) return false;
    this.#scale = q;
    this.#lastChange = nowMs;
    this.#onChange?.(q);
    return true;
  }
}

/**
 * The `p` percentile (nearest-rank) of `values`, sorted into the preallocated `scratch` (same
 * length) so it allocates nothing.
 */
export function percentileInto(values: Float32Array, scratch: Float32Array, p: number): number {
  scratch.set(values);
  scratch.sort();
  const n = scratch.length;
  const rank = Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1));
  return scratch[rank] as number;
}
