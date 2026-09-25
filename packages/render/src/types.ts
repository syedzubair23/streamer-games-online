/**
 * Structural contracts implemented by `@sg/render`.
 *
 * The package boundary rules (SPEC §9.2, eslint-plugin-boundaries) let `@sg/render` import only
 * `@sg/shared` and three.js, so it cannot name the `@sg/engine/client` interfaces directly. The
 * types below mirror those contracts member for member (`QualityTier`, `TweenApi`,
 * `MaterialFactories`, `ProceduralTextures`, `PickApi`, …). TypeScript is structural, so the
 * objects this package builds are assignable to the engine types; the root test
 * `test/render-contract.test.ts` (which may import both packages) proves it at compile time, so
 * any drift fails `pnpm typecheck`.
 *
 * @module
 */
import type {
  CanvasTexture,
  Color,
  DataTexture,
  InstancedMesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshMatcapMaterial,
  MeshToonMaterial,
  Object3D,
  Texture,
  Vector3,
} from "three";

/** The device quality tier (SPEC §10). */
export type QualityTier = "low" | "mid" | "high";
/** Every {@link QualityTier}, cheapest first. */
export const QUALITY_TIERS: readonly QualityTier[] = Object.freeze(["low", "mid", "high"]);

/** A colour: a CSS colour string (an `@sg/ui` token value) or a three.js `Color`. */
export type ColorLike = string | Color;

/** A plain 3D point; three's `Vector3` satisfies it. */
export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** A pointer position in client (CSS) pixels; a DOM `PointerEvent` satisfies it. */
export interface PointerLike {
  clientX: number;
  clientY: number;
}

// ---- Motion (SPEC §13.4) ----------------------------------------------------------------------

/** The named easings of SPEC §13.4. */
export type EasingName = "outSoft" | "inSoft" | "inout" | "back" | "linear";
/** Every {@link EasingName}. */
export const EASING_NAMES: readonly EasingName[] = Object.freeze([
  "outSoft",
  "inSoft",
  "inout",
  "back",
  "linear",
]);

/** The named springs of SPEC §13.4. */
export type SpringName = "snappy" | "bouncy" | "gentle" | "wobbly" | "camera";
/** Every {@link SpringName}. */
export const SPRING_NAMES: readonly SpringName[] = Object.freeze([
  "snappy",
  "bouncy",
  "gentle",
  "wobbly",
  "camera",
]);

/** A spring's physical parameters. */
export interface SpringConfig {
  stiffness: number;
  damping: number;
  /** Default 1. */
  mass?: number;
}

/** The spring presets handed to games (`ctx.springs`). */
export type SpringPresets = Readonly<Record<SpringName, SpringConfig>>;

/** A running tween or spring. */
export interface TweenHandle {
  /** Stops it where it is; `finished` then resolves. */
  cancel(): void;
  /** Resolves when it completes or is cancelled. */
  readonly finished: Promise<void>;
}

/** Options of a timed tween. Durations come from tokens, never literals. */
export interface TweenOptions {
  durationMs: number;
  easing?: EasingName;
  delayMs?: number;
  onUpdate?: () => void;
  onComplete?: () => void;
}

/** The numeric properties of `T` a tween may drive. */
export type TweenTargets<T> = Partial<Record<keyof T, number>>;

/** Tweens and springs driven by the shell's loop (`ctx.tween`). */
export interface TweenApi {
  /** Tweens numeric properties of `target` to `to`. */
  to<T extends object>(target: T, to: TweenTargets<T>, opts: TweenOptions): TweenHandle;
  /** Animates numeric properties of `target` to `to` on a spring preset or config. */
  spring<T extends object>(
    target: T,
    to: TweenTargets<T>,
    spring: SpringName | SpringConfig,
    opts?: { onUpdate?: () => void; onComplete?: () => void },
  ): TweenHandle;
  /** Cancels every tween and spring on `target`. */
  cancelAll(target: object): void;
}

// ---- Loop -------------------------------------------------------------------------------------

/** What games get of the loop (`ctx.loop`): they never call `requestAnimationFrame`. */
export interface LoopApi {
  /** Requests one frame (a no-op if one is already scheduled). */
  invalidate(): void;
  /** Keeps the loop rendering every frame until the returned function is called. */
  beginAnim(): () => void;
}

// ---- Materials and textures (SPEC §13.5, §13.6) ----------------------------------------------

/** Options for the material factories. Colours come from tokens. */
export interface MaterialOptions {
  color?: ColorLike;
  map?: Texture | null;
  vertexColors?: boolean;
  transparent?: boolean;
  opacity?: number;
}

/** The four game-facing material factories (the engine's `MaterialFactories`). */
export interface MaterialFactories {
  /** Toon with the 3-step ramp, plus the rim "toy glow" on mid/high: pieces. */
  makeToon(opts?: MaterialOptions & { rim?: boolean }): MeshToonMaterial;
  /** Procedural clay matcap, warm/cool blended per mode: chess and clay objects. */
  makeMatcap(opts?: MaterialOptions & { variant?: "warm" | "cool" | "blend" }): MeshMatcapMaterial;
  /** Lambert with vertex-colour AO: room and table pieces. */
  makeLambertVC(opts?: MaterialOptions): MeshLambertMaterial;
  /** Unlit: sky, halos, confetti, shadows. */
  makeBasic(
    opts?: MaterialOptions & { additive?: boolean; depthWrite?: boolean },
  ): MeshBasicMaterial;
}

/** The procedural textures of SPEC §13.6. */
export type TextureName =
  | "noise"
  | "wood"
  | "felt"
  | "paper"
  | "cork"
  | "board"
  | "cards"
  | "dice"
  | "blob"
  | "matcap"
  | "ramp"
  | "grain";
/** Every {@link TextureName}. */
export const TEXTURE_NAMES: readonly TextureName[] = Object.freeze([
  "noise",
  "wood",
  "felt",
  "paper",
  "cork",
  "board",
  "cards",
  "dice",
  "blob",
  "matcap",
  "ramp",
  "grain",
]);

/** Options of a procedural texture. */
export interface ProceduralTextureOptions {
  /** Edge length in px (the factory clamps it per quality tier). For atlases: the width. */
  size?: number;
  seed?: number;
  tint?: ColorLike;
  /** Kind-specific variant, e.g. a board layout or a matcap flavour. */
  variant?: string;
}

/** Procedural, cached textures (`ctx.textures`). Returned textures are shared: never dispose. */
export type ProceduralTextures = {
  readonly [K in TextureName]: (opts?: ProceduralTextureOptions) => CanvasTexture | DataTexture;
};

// ---- Picking ---------------------------------------------------------------------------------

/** Picking without per-frame allocation (`ctx.pick`). */
export interface PickApi {
  /** Analytic ray/plane intersection with `y = planeY`; writes into `out`; `null` on a miss. */
  plane(pointer: PointerLike, planeY?: number, out?: Vector3): Vector3 | null;
  /** The instance id under the pointer on an instanced mesh, or `null`. */
  instance(mesh: InstancedMesh, pointer: PointerLike): number | null;
  /** The first of `targets` under the pointer (recursive), or `null`. */
  object(targets: readonly Object3D[], pointer: PointerLike): Object3D | null;
}
