/// <reference lib="dom" />
/**
 * The client module API (SPEC §9.4): what every game's Stage and phone clients implement, and
 * what the shell hands them. The declarations between the markers are copied exactly from the
 * spec (`test/spec-sync.test.ts` fails if they drift).
 *
 * The spec names its supporting types (`CameraRig`, `ThemeApi`, `MaterialFactories`, …) but
 * leaves their shape to this file. They are defined after the copied block as **structural
 * contracts**: `@sg/render` (M1-06/M1-07), `@sg/ui` (M1-05) and `@sg/audio` (M1-08) implement
 * them, and games program against them, so a game never imports a concrete engine class. The
 * engine only depends on three.js **types** (erased at build time), never on its runtime.
 *
 * Shell rules (SPEC §9.4): the shell owns the renderer, the single render loop, the room, table,
 * lights, ambient modes, camera rig, transitions, intro card, Results, Scoreboard, reactions,
 * audience panel and timer HUD. Games only add to `ctx.scene` and `ctx.hud`, and every
 * `StageInstance.dispose()` frees everything it created.
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
import type { AmbientMode, GameId } from "@sg/shared";

// ---------------------------------------------------------------------------------------------
// Copied exactly from SPEC §9.4.
// ---------------------------------------------------------------------------------------------

/**
 * A game's client entry (SPEC §9.4): its table mat, Stage (3D + HUD), phone controller and
 * optional custom audience panel.
 */
// prettier-ignore
export interface GameClientModule<V, A> {
  id: GameId;
  mat: MatKind;                                   // "wood-board" | "inlay" | "paper" | "cork" | "felt" | "pegboard"
  stage(ctx: StageContext): StageInstance<V>;     // 3D objects + stage HUD (DOM), consumes stage|host view
  controller(ctx: ControllerContext<A>): ControllerInstance<V>;    // phone UI for players (Preact, DOM/SVG); may call ctx.requestBoard() ONLY behind the opt-in "3D board" toggle (lazy-loads three)
  audience?(ctx: ControllerContext<never>): ControllerInstance<V>; // optional custom audience panel; default = generic poll UI
}
/**
 * Everything the shell hands a game's Stage. Games only add to `scene` and `hud`, never own a
 * render loop, and create materials only through `materials`.
 */
// prettier-ignore
export interface StageContext {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- copied exactly from SPEC §9.4
  scene: import("three").Group;                   // game root; shell owns Scene, room, table, lights
  camera: CameraRig;                              // setState("establishing"|"play"|"focus"|"top"), focusOn(vec3)
  hud: HTMLElement;                               // DOM layer for Preact
  theme: ThemeApi;                                // tokens, current mode, onModeChange
  quality: QualityTier;                           // "low" | "mid" | "high"
  loop: { invalidate(): void; beginAnim(): () => void };  // games NEVER call requestAnimationFrame
  tween: TweenApi; springs: SpringPresets;
  fx: FxApi;                                      // confetti(color[]), puff(pos, color), halo, reactions
  mats: MatApi;                                   // setMat(kind, canvasPainter)
  materials: MaterialFactories;                   // makeToon, makeMatcap, makeLambertVC, makeBasic — ONLY source of materials
  textures: ProceduralTextures;
  sfx: (name: SfxName, opts?: { pitchStep?: number }) => void;
  pick: PickApi;                                  // analytic plane picking + instanced raycast
  reducedMotion: boolean;
}
/**
 * A mounted Stage: diff-driven `update`, optional fx / scenario seek / per-frame / resize hooks,
 * and a `dispose` that frees everything it created.
 */
// prettier-ignore
export interface StageInstance<V> {
  update(view: V, prev: V | null): void;          // diff-driven animation
  onFx?(e: { name: string; data?: unknown }): void;
  seek?(anim: string, t: number): void;           // scenario t-scrub (0..1) for screenshots
  frame?(dtMs: number): void;
  resize?(w: number, h: number): void;
  dispose(): void;                                // MUST free everything it created
}
/**
 * Everything the shell hands a phone controller (DOM/SVG): root element, theme, `send`, sound,
 * haptics, the opt-in 3D board and the local player.
 */
// prettier-ignore
export interface ControllerContext<A> {
  root: HTMLElement; theme: ThemeApi; send(action: A): Promise<{ ok: boolean; err?: string }>;
  sfx: StageContext["sfx"]; haptic(ms: number): void; requestBoard(): Promise<StageContext>; me: { id: string; colorSlot: number };
}
/**
 * A mounted controller or audience panel.
 */
// prettier-ignore
export interface ControllerInstance<V> { update(view: V, prev: V | null): void; dispose(): void }

// ---------------------------------------------------------------------------------------------
// End of the SPEC §9.4 copy. Supporting contracts follow.
// ---------------------------------------------------------------------------------------------

/** The table mat a game plays on (SPEC §11). */
export type MatKind = "wood-board" | "inlay" | "paper" | "cork" | "felt" | "pegboard";
/** Every {@link MatKind}. */
export const MAT_KINDS: readonly MatKind[] = Object.freeze([
  "wood-board",
  "inlay",
  "paper",
  "cork",
  "felt",
  "pegboard",
]);

/** The device quality tier (SPEC §10). Games must stay inside that tier's budget. */
export type QualityTier = "low" | "mid" | "high";
/** Every {@link QualityTier}, cheapest first. */
export const QUALITY_TIERS: readonly QualityTier[] = Object.freeze(["low", "mid", "high"]);

/** A plain 3D point; `three`'s `Vector3` satisfies it. */
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

/**
 * A colour: an `@sg/ui` token value (a CSS colour string taken from {@link ThemeTokens}) or a
 * three.js `Color`. Games never write colour literals (SPEC §13, DOD G2).
 */
export type ColorLike = string | Color;

// ---- Camera (SPEC §13.4) --------------------------------------------------------------------

/** The four camera states (SPEC §13.4). */
export type CameraState = "establishing" | "play" | "focus" | "top";
/** Every {@link CameraState}. */
export const CAMERA_STATES: readonly CameraState[] = Object.freeze([
  "establishing",
  "play",
  "focus",
  "top",
]);

/**
 * The shell's camera rig. It always glides on the `camera` spring and never cuts during play;
 * idle drift, portrait framing and Stream Layout offsets are applied by the rig itself.
 */
export interface CameraRig {
  /** The state the rig is in or gliding towards. */
  readonly state: CameraState;
  /**
   * Glides to a camera state. `immediate` snaps (allowed only before the first frame of a
   * scenario or behind a transition).
   */
  setState(state: CameraState, opts?: { immediate?: boolean }): void;
  /** Glides the `focus` state towards a point on the table (15–25% closer, 28° FOV). */
  focusOn(target: Vec3Like, opts?: { immediate?: boolean }): void;
}

// ---- Theme (SPEC §8, §13) -------------------------------------------------------------------

/** The per-mode colour and light tokens (SPEC §13.2); colours are CSS colour strings. */
export interface ModeTokens {
  skyTop: string;
  skyBottom: string;
  hemiSky: string;
  hemiGround: string;
  key: string;
  keyIntensity: number;
  fillIntensity: number;
  fog: string;
  wall: string;
  wood: string;
  felt: string;
  shadow: string;
  shadowAlpha: number;
  glow: string;
  glowIntensity: number;
  uiBg: string;
  uiSurface: string;
  uiSurfaceAlpha: number;
  uiInk: string;
  uiMuted: string;
  uiLine: string;
  accent: string;
}

/** The glyph paired with each identity colour (SPEC §13.3). */
export type IdentityGlyph =
  "circle" | "triangle" | "square" | "diamond" | "star" | "plus" | "pentagon" | "heart";

/** One of the 8 identity colours (SPEC §13.3), fixed in every mode. */
export interface IdentityColor {
  /** Colour slot `0..7` (`Seat.colorSlot`). */
  slot: number;
  /** Display name, e.g. "Tomato". */
  name: string;
  base: string;
  deep: string;
  glyph: IdentityGlyph;
}

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

/** A spring's physical parameters (SPEC §13.4 lists stiffness/damping). */
export interface SpringConfig {
  stiffness: number;
  damping: number;
  /** Default 1. */
  mass?: number;
}

/** The spring presets handed to games (`ctx.springs`). */
export type SpringPresets = Readonly<Record<SpringName, SpringConfig>>;

/** The full token set of the active mode (SPEC §13; implemented by `@sg/ui/tokens.ts`). */
export interface ThemeTokens {
  mode: ModeTokens;
  /** The 8 identity colours, indexed by colour slot. */
  identity: readonly IdentityColor[];
  semantic: { success: string; warning: string; danger: string; info: string; audience: string };
  /** Game-specific fixed tokens (SPEC §13.3). */
  fixed: { chessLight: string; chessDark: string; paper: string; glass: string };
  /** Radii in px (SPEC §13.4); `pill` is fully rounded. */
  radius: { sm: number; md: number; lg: number; xl: number; pill: number };
  /** The 4-pt spacing scale in px. */
  space: readonly number[];
  /** Durations in ms and easings (CSS `cubic-bezier(…)` strings) by name. */
  motion: {
    durationMs: Readonly<Record<EasingName, number>>;
    easing: Readonly<Record<EasingName, string>>;
  };
}

/** Theme access for games (`ctx.theme`). */
export interface ThemeApi {
  /** The active ambient mode. */
  readonly mode: AmbientMode;
  /** The active mode's tokens. Replaced (not mutated) on a mode change. */
  readonly tokens: ThemeTokens;
  /** The identity colour of a colour slot (`0..7`; other values wrap). */
  identity(slot: number): IdentityColor;
  /**
   * Subscribes to mode changes (the shell lerps the environment over 2.5 s; games re-tint on
   * this callback). Returns the unsubscribe function; call it in `dispose()`.
   */
  onModeChange(cb: (mode: AmbientMode, tokens: ThemeTokens) => void): () => void;
}

// ---- Motion (SPEC §13.4) --------------------------------------------------------------------

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

/**
 * Tweens and springs driven by the shell's loop (`ctx.tween`). Every running animation keeps
 * the on-demand loop awake; with reduced motion, tweens jump to their end value.
 */
export interface TweenApi {
  /** Tweens numeric properties of `target` (e.g. an `Object3D.position`) to `to`. */
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

// ---- FX, mats, materials, textures, sound, picking ------------------------------------------

/** One of the 6 audience emotes (the same ids as `ReactionId` in `@sg/shared`). */
export type ReactionName = "heart" | "laugh" | "wow" | "clap" | "fire" | "sad";

/**
 * Pooled stage effects (`ctx.fx`). All respect the quality tier and reduced motion (no
 * confetti, no shake).
 */
export interface FxApi {
  /** A confetti burst in the given colours (usually identity colours), from `origin` or centre. */
  confetti(colors: readonly ColorLike[], opts?: { origin?: Vec3Like; count?: number }): void;
  /** A soft puff (6 instanced circles) at a point, e.g. a capture. */
  puff(pos: Vec3Like, color: ColorLike): void;
  /** Adds an additive halo sprite to an object ("fake bloom"). Returns the remover. */
  halo(target: Object3D, opts?: { color?: ColorLike; scale?: number }): () => void;
  /** Floating reaction sprites (at most 30 on screen, shared with the audience layer). */
  reactions(name: ReactionName, count?: number): void;
  /** Camera micro-shake (high tier only; a no-op with reduced motion). */
  shake(strength?: number): void;
}

/** Paints a mat's canvas texture; `w`/`h` are the canvas size in px. */
export type CanvasPainter = (ctx: CanvasRenderingContext2D, size: { w: number; h: number }) => void;

/** The table mat (`ctx.mats`). */
export interface MatApi {
  /** Switches the table mat, optionally overpainting it (board art, card layout, …). */
  setMat(kind: MatKind, painter?: CanvasPainter): void;
}

/** Options for the material factories. Colours come from tokens. */
export interface MaterialOptions {
  color?: ColorLike;
  map?: Texture | null;
  vertexColors?: boolean;
  transparent?: boolean;
  opacity?: number;
}

/**
 * The ONLY source of materials (SPEC §13.5; lint bans `new *Material` in games). The caller
 * owns each returned material and disposes it in `dispose()`.
 */
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

/** The procedural textures of SPEC §13.6 / M1-06. */
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

/** Options of a procedural texture. */
export interface ProceduralTextureOptions {
  /** Edge length in px (the factory clamps it per quality tier). */
  size?: number;
  seed?: number;
  tint?: ColorLike;
  /** Kind-specific variant, e.g. a board layout or a matcap flavour. */
  variant?: string;
}

/**
 * Procedural, cached textures (`ctx.textures`; v1 ships no image files). Returned textures are
 * shared: never dispose them.
 */
export type ProceduralTextures = {
  readonly [K in TextureName]: (opts?: ProceduralTextureOptions) => CanvasTexture | DataTexture;
};

/** The core synthesized sound set (SPEC §13.7). */
export type SfxName =
  "pop" | "tick" | "tok" | "card" | "chime" | "success" | "fail" | "capture" | "win" | "vote";
/** Every {@link SfxName}. */
export const SFX_NAMES: readonly SfxName[] = Object.freeze([
  "pop",
  "tick",
  "tok",
  "card",
  "chime",
  "success",
  "fail",
  "capture",
  "win",
  "vote",
]);

/** Picking without per-frame allocation (`ctx.pick`). */
export interface PickApi {
  /**
   * Analytic intersection of the pointer ray with the horizontal plane `y = planeY` (default:
   * the table top). Writes into and returns `out` (or an internal vector), or `null` if the ray
   * misses.
   */
  plane(pointer: PointerLike, planeY?: number, out?: Vector3): Vector3 | null;
  /** The instance id under the pointer on an instanced mesh, or `null`. */
  instance(mesh: InstancedMesh, pointer: PointerLike): number | null;
  /** The first of `targets` under the pointer (recursive), or `null`. */
  object(targets: readonly Object3D[], pointer: PointerLike): Object3D | null;
}
