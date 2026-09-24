/// <reference lib="dom" />
/**
 * The scenario route's **placeholder Stage shell**: a complete, deterministic
 * {@link StageContext} (renderer, one on-demand loop, sky, table, mat, two lights, camera rig,
 * tweens, fx, picking, materials and procedural textures) that a game's `stage()` mounts into.
 *
 * ROADMAP M0-05: "the route can render a placeholder stage until M1-07 exists". The Cozy Table
 * diorama, ambient modes, weather and the production material/texture/fx kits arrive with
 * `@sg/render` (M1-06, M1-07); the route then builds its StageContext from those and this file
 * is deleted. Until then it follows the same shell rules (SPEC §9.4, §10, §13.5):
 *
 * - one render loop, owned here, rendering **on demand** (0 frames per second when idle);
 * - WebGL2 `WebGLRenderer`, `alpha: false`, NeutralToneMapping at exposure 1, sRGB output;
 * - a hemisphere light plus one directional key from the upper left (the night lamp from the
 *   upper right); the environment stays inside 12 draws / 15k triangles on low;
 * - materials only from the factories below; zero allocations per frame (scratch objects);
 * - time only advances through the loop clock, so a frozen frame is reproducible.
 *
 * @module
 */
import type {
  CameraRig,
  CameraState,
  ColorLike,
  FxApi,
  MatApi,
  MaterialFactories,
  MaterialOptions,
  MatKind,
  PickApi,
  PointerLike,
  QualityTier,
  ReactionName,
  SfxName,
  StageContext,
  Vec3Like,
} from "@sg/engine/client";
import { createRng, type AmbientMode, type Rng } from "@sg/shared";
import {
  AdditiveBlending,
  CanvasTexture,
  Color,
  DoubleSide,
  DirectionalLight,
  ExtrudeGeometry,
  Fog,
  Group,
  HemisphereLight,
  InstancedBufferAttribute,
  InstancedMesh,
  MathUtils,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshMatcapMaterial,
  MeshToonMaterial,
  NeutralToneMapping,
  type Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  Plane,
  Quaternion,
  Raycaster,
  Scene,
  Shape,
  SRGBColorSpace,
  type Texture,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import { createMotion, type MotionEngine } from "./motion.ts";
import { createPlaceholderTheme, SPRINGS, type PlaceholderTheme } from "./placeholder-theme.ts";
import {
  createPlaceholderTextures,
  textureBytes,
  type PlaceholderTextures,
} from "./placeholder-textures.ts";

/** Device-pixel-ratio cap per tier (SPEC §10). */
export const DPR_CAP: Readonly<Record<QualityTier, number>> = Object.freeze({
  low: 1.25,
  mid: 1.5,
  high: 2,
});

/** Camera states of SPEC §13.4: elevation (deg), vertical FOV (deg), distance factor. */
export const CAMERA_PRESETS: Readonly<
  Record<CameraState, { elevation: number; fov: number; distance: number }>
> = Object.freeze({
  establishing: { elevation: 35, fov: 35, distance: 1.25 },
  play: { elevation: 55, fov: 30, distance: 1 },
  focus: { elevation: 55, fov: 28, distance: 0.8 },
  top: { elevation: 88, fov: 20, distance: 1 },
});
/** Portrait framing uses a steeper elevation (SPEC §13.4). */
export const PORTRAIT_ELEVATION = 65;
/** Radius (world units) the play camera keeps in frame: the mat plus breathing room. */
export const FRAME_RADIUS = 2.35;
/** Idle drift: ±1.5° yaw on a 14 s loop (SPEC §13.4), only with ambient life on. */
export const DRIFT = Object.freeze({ yawDeg: 1.5, periodMs: 14_000 });
/** The mat's edge length (world units) on the table top. */
export const MAT_SIZE = 4.2;

/** The subset of `WebGLRenderer` the shell uses (tests inject a fake). */
export type RendererLike = Pick<
  WebGLRenderer,
  "domElement" | "info" | "setPixelRatio" | "setSize" | "render" | "dispose"
> & {
  toneMapping?: WebGLRenderer["toneMapping"];
  toneMappingExposure?: number;
  outputColorSpace?: WebGLRenderer["outputColorSpace"];
  getContext?: () => WebGLRenderingContext | WebGL2RenderingContext;
  initTexture?: (texture: Texture) => void;
};

/** What `__SCENE_INFO__` reports (SPEC §14), plus texture memory for G8a. */
export interface SceneInfo {
  drawCalls: number;
  tris: number;
  programs: number;
  textures: number;
  geometries: number;
  /** Estimated GPU texture memory of everything in the scene and the texture cache, in MB. */
  texMB: number;
}

/** One `ctx.fx` / `ctx.sfx` call, as the harness sees it (a11y reduced-motion checks). */
export interface FxRecord {
  name: string;
  /** True when the call was a no-op (reduced motion, or shake below high tier). */
  suppressed: boolean;
}

/** Options of {@link createPlaceholderShell}. */
export interface ShellOptions {
  /** Element the canvas and HUD layer are appended to (should fill the viewport). */
  host: HTMLElement;
  mode: AmbientMode;
  quality: QualityTier;
  reducedMotion: boolean;
  /** Seeds every randomised visual (particles). */
  seed: number;
  /** Show the HUD layer. */
  hud: boolean;
  /** Keep the idle camera drift running (continuous loop at the ambient frame rate). */
  ambient: boolean;
  /** Keep the drawing buffer so a frozen frame can be captured at any time. */
  preserveDrawingBuffer: boolean;
  /**
   * Start with the loop paused: `invalidate()` only marks the frame dirty until
   * {@link PlaceholderShell.start}. The route keeps it paused until the ready frame, so no
   * wall-clock frame can run before a frozen capture.
   */
  paused?: boolean;
  /** Injected renderer (tests); by default a WebGL2 `WebGLRenderer` on a new canvas. */
  renderer?: RendererLike;
  /** Frame scheduler (tests); defaults to `requestAnimationFrame`. */
  schedule?: (cb: (now: number) => void) => number;
  /** Cancels a scheduled frame; defaults to `cancelAnimationFrame`. */
  unschedule?: (id: number) => void;
}

/** The placeholder shell: the StageContext plus the controls the route and harness use. */
export interface PlaceholderShell {
  /** Handed to the game's `stage()`. */
  readonly ctx: StageContext;
  readonly theme: PlaceholderTheme;
  readonly motion: MotionEngine;
  readonly renderer: RendererLike;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  /** The game root (`ctx.scene`). */
  readonly gameRoot: Group;
  /** Every fx/sfx call so far. */
  readonly fxLog: FxRecord[];
  readonly sfxLog: SfxName[];
  /** Frames rendered so far. */
  readonly renders: number;
  /** Per-frame hook (the mounted stage's `frame`). */
  onFrame: ((dtMs: number) => void) | null;
  /** Resize hook (the mounted stage's `resize`). */
  onResize: ((w: number, h: number) => void) | null;
  /** Advances the clock by `dtMs` (tweens, fx, camera) without rendering. */
  advance(dtMs: number): void;
  /** Runs tweens, springs, particles and the camera glide to rest with fixed steps. */
  settle(maxMs?: number): void;
  /** Renders one frame now (synchronously). */
  renderNow(): void;
  /** Starts a paused loop (renders the pending frame, if any). */
  start(): void;
  /**
   * Uploads every shell-owned GPU resource (particle and halo geometry, every cached
   * procedural texture) with one render, and returns the memory counts: the baseline a
   * mounted game's `dispose()` must return to (DOD G8a).
   */
  prepareBaseline(): { geometries: number; textures: number };
  /** Uploads every cached procedural texture (so shared textures never count as a leak). */
  uploadSharedTextures(): void;
  /** Stops the loop for good: later `invalidate()` calls render nothing (frozen frame). */
  freeze(): void;
  readonly frozen: boolean;
  /** Draw calls, triangles, programs and memory of the last frame. */
  info(): SceneInfo;
  /** Live GPU object counts (leak checks). */
  memory(): { geometries: number; textures: number };
  /** Textures in the shared procedural cache (owned by the shell, not the game). */
  sharedTextureCount(): number;
  /** Resizes the canvas to the host element. */
  resize(): void;
  dispose(): void;
}

function toColor(c: ColorLike | undefined, out: Color): Color {
  if (c === undefined) return out;
  if (typeof c === "string") return out.set(c);
  return out.copy(c);
}

/* eslint-disable no-restricted-syntax -- placeholder for the @sg/render material factories (M1-06): the factories are the one place allowed to construct materials */
function makeMaterialFactories(ramp: Texture, matcaps: { warm: Texture; cool: Texture }) {
  const apply = (
    m: MeshToonMaterial | MeshLambertMaterial | MeshMatcapMaterial | MeshBasicMaterial,
    o: MaterialOptions | undefined,
  ): void => {
    if (o === undefined) return;
    toColor(o.color, m.color);
    if (o.map !== undefined) m.map = o.map;
    if (o.vertexColors !== undefined) m.vertexColors = o.vertexColors;
    if (o.transparent !== undefined) m.transparent = o.transparent;
    if (o.opacity !== undefined) m.opacity = o.opacity;
  };
  const factories: MaterialFactories = {
    makeToon(o) {
      const m = new MeshToonMaterial({ gradientMap: ramp });
      apply(m, o);
      return m;
    },
    makeMatcap(o) {
      const m = new MeshMatcapMaterial({
        matcap: o?.variant === "cool" ? matcaps.cool : matcaps.warm,
      });
      apply(m, o);
      return m;
    },
    makeLambertVC(o) {
      const m = new MeshLambertMaterial();
      apply(m, o);
      return m;
    },
    makeBasic(o) {
      const m = new MeshBasicMaterial();
      apply(m, o);
      if (o?.additive === true) {
        m.blending = AdditiveBlending;
        m.transparent = true;
      }
      if (o?.depthWrite !== undefined) m.depthWrite = o.depthWrite;
      return m;
    },
  };
  return factories;
}
/* eslint-enable no-restricted-syntax -- end of the placeholder material factories */

/** A rounded-rectangle slab (the table top), `w × d`, `h` thick, top face at y = 0. */
function roundedSlab(w: number, d: number, h: number, r: number): ExtrudeGeometry {
  const s = new Shape();
  const x = -w / 2;
  const y = -d / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + d - r);
  s.quadraticCurveTo(x + w, y + d, x + w - r, y + d);
  s.lineTo(x + r, y + d);
  s.quadraticCurveTo(x, y + d, x, y + d - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  const bevel = Math.min(0.08, h / 3);
  const geo = new ExtrudeGeometry(s, {
    depth: h - 2 * bevel,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 3,
    curveSegments: 6,
  });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, -h + bevel, 0);
  return geo;
}

const PARTICLES = 240;
/** Particle lifetimes (ms), from the SPEC §13.1 "events last 120–400 ms" rhythm, scaled up for bursts. */
const LIFE = Object.freeze({ confetti: 1600, puff: 480, reaction: 1800 });

interface Particle {
  alive: boolean;
  age: number;
  life: number;
  kind: "confetti" | "puff" | "reaction";
  p: Vector3;
  v: Vector3;
  spin: number;
  angle: number;
  scale: number;
  grow: number;
}

/** Creates the placeholder shell and mounts its canvas and HUD layer into `opts.host`. */
export function createPlaceholderShell(opts: ShellOptions): PlaceholderShell {
  const { quality, reducedMotion } = opts;
  const doc = opts.host.ownerDocument;
  const win = doc.defaultView;
  const theme = createPlaceholderTheme(opts.mode);
  const tokens = theme.tokens;
  const rng: Rng = createRng(`shell:${opts.seed}`);

  // ---- Renderer --------------------------------------------------------------------------
  const renderer: RendererLike =
    opts.renderer ??
    new WebGLRenderer({
      antialias: quality !== "low",
      alpha: false,
      powerPreference: "default",
      preserveDrawingBuffer: opts.preserveDrawingBuffer,
    });
  renderer.toneMapping = NeutralToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.outputColorSpace = SRGBColorSpace;
  const canvas = renderer.domElement;
  canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block";
  canvas.setAttribute("aria-hidden", "true");
  opts.host.appendChild(canvas);

  const hud = doc.createElement("div");
  hud.id = "sg-hud";
  hud.style.cssText = `position:absolute;inset:0;pointer-events:none;overflow:hidden;color:${tokens.mode.uiInk}`;
  if (!opts.hud) hud.style.display = "none";
  opts.host.appendChild(hud);

  // ---- Scene: sky, fog, lights, table, mat -------------------------------------------------
  const scene = new Scene();
  const textures: PlaceholderTextures = createPlaceholderTextures(
    quality,
    {
      wood: tokens.mode.wood,
      felt: tokens.mode.felt,
      paper: tokens.fixed.paper,
      wall: tokens.mode.wall,
      shadow: tokens.mode.shadow,
      ink: tokens.mode.uiInk,
    },
    doc,
  );
  const ramp = textures.api.ramp();
  const materials = makeMaterialFactories(ramp, {
    warm: textures.api.matcap({ variant: "warm" }),
    cool: textures.api.matcap({ variant: "cool" }),
  });

  const skyCanvas = doc.createElement("canvas");
  skyCanvas.width = 2;
  skyCanvas.height = 256;
  const skyG = skyCanvas.getContext("2d");
  if (skyG !== null) {
    const grad = skyG.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, tokens.mode.skyTop);
    grad.addColorStop(1, tokens.mode.skyBottom);
    skyG.fillStyle = grad;
    skyG.fillRect(0, 0, 2, 256);
  }
  const sky = new CanvasTexture(skyCanvas);
  sky.colorSpace = SRGBColorSpace;
  scene.background = sky;
  scene.fog = new Fog(tokens.mode.fog, 14, 34);

  const hemi = new HemisphereLight(
    tokens.mode.hemiSky,
    tokens.mode.hemiGround,
    tokens.mode.fillIntensity,
  );
  const key = new DirectionalLight(tokens.mode.key, tokens.mode.keyIntensity);
  // Upper-left key; the night lamp comes from the upper right (SPEC §13.5).
  key.position.set(opts.mode === "night" ? 4 : -4, 7, 3);
  scene.add(hemi, key, key.target);

  const env = new Group();
  env.name = "sg-environment";
  const tableGeo = roundedSlab(7.2, 5.4, 0.5, 0.5);
  const tableMat = materials.makeLambertVC({
    color: tokens.mode.wood,
    map: textures.api.wood({ seed: opts.seed }),
  });
  const table = new Mesh(tableGeo, tableMat);
  table.name = "sg-table";
  table.position.y = -0.002;
  env.add(table);

  const matCanvas = doc.createElement("canvas");
  const matPx = quality === "low" ? 512 : 1024;
  matCanvas.width = matPx;
  matCanvas.height = matPx;
  const matTex = new CanvasTexture(matCanvas);
  matTex.colorSpace = SRGBColorSpace;
  matTex.anisotropy = quality === "high" ? 4 : 1;
  const matGeo = new PlaneGeometry(MAT_SIZE, MAT_SIZE);
  matGeo.rotateX(-Math.PI / 2);
  const matMat = materials.makeLambertVC({ map: matTex });
  const matMesh = new Mesh(matGeo, matMat);
  matMesh.name = "sg-mat";
  matMesh.position.y = 0.001;
  env.add(matMesh);
  scene.add(env);

  const gameRoot = new Group();
  gameRoot.name = "sg-game";
  scene.add(gameRoot);

  const paintMat = (kind: MatKind, painter?: Parameters<MatApi["setMat"]>[1]): void => {
    const g = matCanvas.getContext("2d");
    if (g === null) return;
    const t = theme.tokens;
    const base: Record<MatKind, string> = {
      "wood-board": t.mode.wood,
      inlay: t.mode.wood,
      paper: t.fixed.paper,
      cork: t.mode.wall,
      felt: t.mode.felt,
      pegboard: t.mode.wall,
    };
    const src =
      kind === "felt"
        ? textures.api.felt({ size: 256 })
        : kind === "paper"
          ? textures.api.paper({ size: 256 })
          : kind === "cork"
            ? textures.api.cork({ size: 256, tint: base.cork })
            : textures.api.wood({ size: 256, tint: base[kind], seed: 7 });
    const img = src.image as CanvasImageSource | undefined;
    g.fillStyle = base[kind];
    g.fillRect(0, 0, matPx, matPx);
    if (img !== undefined && "width" in img) {
      const tile = matPx / 2;
      for (let y = 0; y < matPx; y += tile)
        for (let x = 0; x < matPx; x += tile) g.drawImage(img, x, y, tile, tile);
    }
    // A soft inset border so the mat reads as a separate surface on the table.
    g.strokeStyle = `rgba(40,20,30,0.22)`;
    g.lineWidth = matPx / 64;
    g.strokeRect(matPx / 64, matPx / 64, matPx - matPx / 32, matPx - matPx / 32);
    if (kind === "pegboard") {
      g.fillStyle = "rgba(40,20,30,0.25)";
      for (let y = matPx / 16; y < matPx; y += matPx / 8)
        for (let x = matPx / 16; x < matPx; x += matPx / 8) {
          g.beginPath();
          g.arc(x, y, matPx / 160, 0, Math.PI * 2);
          g.fill();
        }
    }
    painter?.(g, { w: matPx, h: matPx });
    matTex.needsUpdate = true;
  };
  paintMat("wood-board");

  // ---- Camera rig ------------------------------------------------------------------------
  const camera = new PerspectiveCamera(30, 1, 0.1, 80);
  const rigState = { elevation: 55, fov: 30, distance: 1, tx: 0, ty: 0, tz: 0, yaw: 0, shake: 0 };
  let camState: CameraState = "play";
  let aspect = 1;
  let clockMs = 0;
  const rigTarget = new Vector3();

  const presetFor = (state: CameraState) => {
    const p = CAMERA_PRESETS[state];
    const elevation = aspect < 1 && state !== "top" ? PORTRAIT_ELEVATION : p.elevation;
    return { ...p, elevation };
  };
  const setRig = (
    to: { elevation: number; fov: number; distance: number; tx: number; ty: number; tz: number },
    immediate: boolean,
  ): void => {
    if (immediate || reducedMotion) {
      motion.cancelAll(rigState);
      Object.assign(rigState, to);
      loop.invalidate();
      return;
    }
    motion.spring(rigState, to, "camera");
  };
  const applyCamera = (): void => {
    const vfov = rigState.fov;
    const hfov = MathUtils.radToDeg(2 * Math.atan(Math.tan(MathUtils.degToRad(vfov / 2)) * aspect));
    const fit = Math.min(vfov, hfov);
    const dist = (FRAME_RADIUS / Math.tan(MathUtils.degToRad(fit / 2))) * rigState.distance;
    const drift = opts.ambient
      ? DRIFT.yawDeg * Math.sin((clockMs / DRIFT.periodMs) * Math.PI * 2)
      : 0;
    const el = MathUtils.degToRad(rigState.elevation);
    const yaw = MathUtils.degToRad(rigState.yaw + drift);
    rigTarget.set(rigState.tx, rigState.ty, rigState.tz);
    camera.fov = vfov;
    camera.aspect = aspect;
    camera.position.set(
      rigTarget.x + dist * Math.cos(el) * Math.sin(yaw),
      rigTarget.y + dist * Math.sin(el),
      rigTarget.z + dist * Math.cos(el) * Math.cos(yaw),
    );
    if (rigState.shake > 0) {
      const s = rigState.shake * 0.04;
      camera.position.x += Math.sin(clockMs * 0.09) * s;
      camera.position.y += Math.cos(clockMs * 0.11) * s;
    }
    camera.lookAt(rigTarget);
    camera.updateProjectionMatrix();
  };
  const cameraRig: CameraRig = {
    get state() {
      return camState;
    },
    setState(state, o) {
      camState = state;
      const p = presetFor(state);
      setRig(
        {
          elevation: p.elevation,
          fov: p.fov,
          distance: p.distance,
          tx: state === "focus" ? rigState.tx : 0,
          ty: 0,
          tz: state === "focus" ? rigState.tz : 0,
        },
        o?.immediate === true,
      );
    },
    focusOn(target: Vec3Like, o) {
      camState = "focus";
      const p = presetFor("focus");
      setRig(
        { elevation: p.elevation, fov: p.fov, distance: p.distance, tx: target.x, ty: 0, tz: target.z },
        o?.immediate === true,
      );
    },
  };

  // ---- Loop --------------------------------------------------------------------------------
  const schedule = opts.schedule ?? ((cb: (now: number) => void) => (win ?? window).requestAnimationFrame(cb));
  const unschedule = opts.unschedule ?? ((id: number) => (win ?? window).cancelAnimationFrame(id));
  let frameId: number | null = null;
  let lastNow: number | null = null;
  let anims = 0;
  let frozen = false;
  let paused = opts.paused === true;
  let pending = false;
  let disposed = false;
  let renders = 0;
  const fxLog: FxRecord[] = [];
  const sfxLog: SfxName[] = [];

  const busy = (): boolean => anims > 0 || motion.active > 0 || liveParticles > 0 || opts.ambient;
  // While a frame runs, invalidations only mark it dirty: exactly one frame is ever scheduled.
  let ticking = false;
  let dirty = false;
  const tick = (now: number): void => {
    frameId = null;
    if (frozen || disposed) return;
    ticking = true;
    dirty = false;
    const dt = lastNow === null ? 1000 / 60 : Math.min(50, Math.max(0, now - lastNow));
    lastNow = now;
    try {
      shell.advance(dt);
      shell.renderNow();
    } finally {
      ticking = false;
    }
    if (!frozen && !disposed && (busy() || dirty)) frameId = schedule(tick);
    else lastNow = null;
  };
  const loop = {
    invalidate(): void {
      if (frozen || disposed || frameId !== null) return;
      if (ticking) {
        dirty = true;
        return;
      }
      if (paused) {
        pending = true;
        return;
      }
      frameId = schedule(tick);
    },
    beginAnim(): () => void {
      anims++;
      loop.invalidate();
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        anims--;
      };
    },
  };
  const motion = createMotion({ springs: SPRINGS, reducedMotion, onStart: () => loop.invalidate() });

  // ---- FX ----------------------------------------------------------------------------------
  const particleGeo = new PlaneGeometry(0.09, 0.13);
  const particleMat = materials.makeBasic({ transparent: true });
  particleMat.side = DoubleSide;
  const particles = new InstancedMesh(particleGeo, particleMat, PARTICLES);
  particles.name = "sg-fx-particles";
  particles.instanceColor = new InstancedBufferAttribute(new Float32Array(PARTICLES * 3), 3);
  particles.frustumCulled = false;
  particles.count = 0;
  particles.visible = false;
  scene.add(particles);
  const pool: Particle[] = Array.from({ length: PARTICLES }, () => ({
    alive: false,
    age: 0,
    life: 0,
    kind: "confetti" as const,
    p: new Vector3(),
    v: new Vector3(),
    spin: 0,
    angle: 0,
    scale: 1,
    grow: 0,
  }));
  let liveParticles = 0;
  const pm = new Matrix4();
  const pq = new Quaternion();
  const ps = new Vector3();
  const axis = new Vector3(0.3, 1, 0.2).normalize();
  const scratchColor = new Color();
  const audienceColor = new Color(tokens.semantic.audience);

  const spawn = (
    kind: Particle["kind"],
    origin: Vec3Like,
    color: Color,
    speed: number,
    upward: number,
  ): void => {
    const slot = pool.findIndex((p) => !p.alive);
    if (slot < 0) return;
    const p = pool[slot] as Particle;
    p.alive = true;
    p.kind = kind;
    p.age = 0;
    p.life = LIFE[kind];
    p.p.set(origin.x, origin.y, origin.z);
    const a = rng.float() * Math.PI * 2;
    p.v.set(Math.cos(a) * speed * rng.float(), upward * (0.6 + rng.float() * 0.4), Math.sin(a) * speed * rng.float());
    p.spin = (rng.float() - 0.5) * 12;
    p.angle = rng.float() * Math.PI * 2;
    p.scale = kind === "puff" ? 1.6 : 1;
    p.grow = kind === "puff" ? 3 : 0;
    particles.setColorAt(slot, color);
    liveParticles++;
  };
  const stepParticles = (dt: number): void => {
    if (liveParticles === 0 && !particles.visible) return;
    const s = dt / 1000;
    let maxIndex = -1;
    for (let i = 0; i < PARTICLES; i++) {
      const p = pool[i] as Particle;
      if (!p.alive) {
        particles.setMatrixAt(i, pm.makeScale(0, 0, 0));
        continue;
      }
      p.age += dt;
      if (p.age >= p.life) {
        p.alive = false;
        liveParticles--;
        particles.setMatrixAt(i, pm.makeScale(0, 0, 0));
        continue;
      }
      maxIndex = i;
      if (p.kind === "confetti") p.v.y -= 6 * s;
      else if (p.kind === "reaction") p.v.y = 0.9;
      else p.v.multiplyScalar(1 - Math.min(1, 4 * s));
      p.p.addScaledVector(p.v, s);
      p.angle += p.spin * s;
      p.scale += p.grow * s;
      const fade = 1 - p.age / p.life;
      pq.setFromAxisAngle(axis, p.angle);
      const k = p.scale * (p.kind === "confetti" ? 1 : 0.4 + 0.6 * fade);
      particles.setMatrixAt(i, pm.compose(p.p, pq, ps.set(k, k, k)));
    }
    particles.count = maxIndex + 1;
    particles.visible = liveParticles > 0;
    particles.instanceMatrix.needsUpdate = true;
    if (particles.instanceColor !== null) particles.instanceColor.needsUpdate = true;
  };

  const haloGeo = new PlaneGeometry(1, 1);
  const halos = new Set<Mesh>();
  const fx: FxApi = {
    confetti(colors, o) {
      const suppressed = reducedMotion || colors.length === 0;
      fxLog.push({ name: "confetti", suppressed });
      if (suppressed) return;
      const origin = o?.origin ?? { x: 0, y: 0.4, z: 0 };
      const n = Math.min(PARTICLES, o?.count ?? (quality === "low" ? 60 : 120));
      for (let i = 0; i < n; i++)
        spawn("confetti", origin, toColor(colors[i % colors.length], scratchColor), 2.2, 4.2);
      loop.invalidate();
    },
    puff(pos, color) {
      fxLog.push({ name: "puff", suppressed: reducedMotion });
      if (reducedMotion) return;
      for (let i = 0; i < 6; i++) spawn("puff", pos, toColor(color, scratchColor), 1.4, 0.6);
      loop.invalidate();
    },
    halo(target: Object3D, o) {
      fxLog.push({ name: "halo", suppressed: false });
      const mat = materials.makeBasic({
        additive: true,
        depthWrite: false,
        map: textures.api.blob(),
        color: o?.color ?? theme.tokens.mode.glow,
        opacity: 0.8,
      });
      const mesh = new Mesh(haloGeo, mat);
      mesh.name = "sg-halo";
      mesh.scale.setScalar(o?.scale ?? 1.2);
      mesh.renderOrder = 2;
      target.add(mesh);
      halos.add(mesh);
      loop.invalidate();
      return () => {
        if (!halos.delete(mesh)) return;
        mesh.removeFromParent();
        mat.dispose();
        loop.invalidate();
      };
    },
    reactions(_name: ReactionName, count = 1) {
      fxLog.push({ name: "reactions", suppressed: reducedMotion });
      if (reducedMotion) return;
      const live = pool.filter((p) => p.alive && p.kind === "reaction").length;
      const n = Math.max(0, Math.min(count, 30 - live));
      for (let i = 0; i < n; i++)
        spawn("reaction", { x: 2.6 + rng.float() * 0.6, y: 0.3, z: 1.2 - rng.float() }, audienceColor, 0.3, 0.9);
      loop.invalidate();
    },
    shake(strength = 1) {
      const suppressed = reducedMotion || quality !== "high";
      fxLog.push({ name: "shake", suppressed });
      if (suppressed) return;
      rigState.shake = Math.min(2, strength);
      motion.to(rigState, { shake: 0 }, { durationMs: 320, easing: "outSoft" });
    },
  };

  // ---- Picking -----------------------------------------------------------------------------
  const raycaster = new Raycaster();
  const ndc = new Vector2();
  const hitPlane = new Plane(new Vector3(0, 1, 0), 0);
  const planeOut = new Vector3();
  const setRay = (p: PointerLike): void => {
    const r = canvas.getBoundingClientRect();
    const w = r.width || 1;
    const h = r.height || 1;
    ndc.set(((p.clientX - r.left) / w) * 2 - 1, -((p.clientY - r.top) / h) * 2 + 1);
    camera.updateMatrixWorld();
    raycaster.setFromCamera(ndc, camera);
  };
  const pick: PickApi = {
    plane(pointer, planeY = 0, out) {
      setRay(pointer);
      hitPlane.constant = -planeY;
      return raycaster.ray.intersectPlane(hitPlane, out ?? planeOut);
    },
    instance(mesh, pointer) {
      setRay(pointer);
      const hit = raycaster.intersectObject(mesh, false)[0];
      return hit?.instanceId ?? null;
    },
    object(targets, pointer) {
      setRay(pointer);
      for (const hit of raycaster.intersectObjects(targets as Object3D[], true)) {
        let o: Object3D | null = hit.object;
        while (o !== null) {
          if (targets.includes(o)) return o;
          o = o.parent;
        }
      }
      return null;
    },
  };

  // ---- Context -------------------------------------------------------------------------------
  const ctx: StageContext = {
    scene: gameRoot,
    camera: cameraRig,
    hud,
    theme,
    quality,
    loop,
    tween: motion,
    springs: SPRINGS,
    fx,
    mats: { setMat: (kind, painter) => { paintMat(kind, painter); loop.invalidate(); } },
    materials,
    textures: textures.api,
    sfx: (name) => {
      sfxLog.push(name);
    },
    pick,
    reducedMotion,
  };

  const collectTextures = (): Set<Texture> => {
    const set = new Set<Texture>([sky, matTex, ...textures.all()]);
    scene.traverse((o) => {
      const m = (o as Mesh).material as
        | (MeshBasicMaterial & { gradientMap?: Texture | null; matcap?: Texture | null })
        | (MeshBasicMaterial & { gradientMap?: Texture | null; matcap?: Texture | null })[]
        | undefined;
      const list = Array.isArray(m) ? m : m !== undefined ? [m] : [];
      for (const mat of list) {
        for (const t of [mat.map, mat.gradientMap, mat.matcap, mat.alphaMap])
          if (t !== null && t !== undefined) set.add(t);
      }
    });
    return set;
  };

  const shell: PlaceholderShell = {
    ctx,
    theme,
    motion,
    renderer,
    scene,
    camera,
    gameRoot,
    fxLog,
    sfxLog,
    get renders() {
      return renders;
    },
    get frozen() {
      return frozen;
    },
    onFrame: null,
    onResize: null,
    advance(dtMs: number): void {
      clockMs += dtMs;
      motion.step(dtMs);
      stepParticles(dtMs);
      shell.onFrame?.(dtMs);
      for (const h of halos) h.quaternion.copy(camera.quaternion);
    },
    settle(maxMs = 10_000): void {
      const step = 1000 / 60;
      let t = 0;
      do {
        shell.advance(step);
        t += step;
      } while ((motion.active > 0 || liveParticles > 0) && t < maxMs);
    },
    renderNow(): void {
      if (disposed) return;
      applyCamera();
      for (const h of halos) h.quaternion.copy(camera.quaternion);
      renderer.render(scene, camera);
      renders++;
    },
    start(): void {
      if (!paused) return;
      paused = false;
      if (pending || busy()) {
        pending = false;
        loop.invalidate();
      }
    },
    uploadSharedTextures(): void {
      if (renderer.initTexture === undefined) return;
      for (const t of textures.all()) renderer.initTexture(t);
    },
    prepareBaseline() {
      const warm = new Mesh(haloGeo, particleMat);
      warm.scale.setScalar(0);
      scene.add(warm);
      const wasVisible = particles.visible;
      const wasCount = particles.count;
      particles.visible = true;
      particles.count = 1;
      particles.setMatrixAt(0, pm.makeScale(0, 0, 0));
      particles.instanceMatrix.needsUpdate = true;
      shell.renderNow();
      scene.remove(warm);
      particles.visible = wasVisible;
      particles.count = wasCount;
      shell.uploadSharedTextures();
      return shell.memory();
    },
    freeze(): void {
      frozen = true;
      if (frameId !== null) unschedule(frameId);
      frameId = null;
    },
    info(): SceneInfo {
      const i = renderer.info;
      let bytes = 0;
      for (const t of collectTextures()) bytes += textureBytes(t);
      return {
        drawCalls: i.render.calls,
        tris: i.render.triangles,
        programs: i.programs?.length ?? 0,
        textures: i.memory.textures,
        geometries: i.memory.geometries,
        texMB: Math.round((bytes / (1024 * 1024)) * 100) / 100,
      };
    },
    memory() {
      return { geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures };
    },
    sharedTextureCount: () => textures.all().length,
    resize(): void {
      const w = Math.max(1, opts.host.clientWidth || win?.innerWidth || 1);
      const h = Math.max(1, opts.host.clientHeight || win?.innerHeight || 1);
      aspect = w / h;
      renderer.setPixelRatio(Math.min(win?.devicePixelRatio ?? 1, DPR_CAP[quality]));
      renderer.setSize(w, h, false);
      // Re-frame for the new aspect (portrait elevation), without a glide.
      const p = presetFor(camState);
      rigState.elevation = p.elevation;
      shell.onResize?.(w, h);
      loop.invalidate();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (frameId !== null) unschedule(frameId);
      motion.finishAll();
      for (const h of [...halos]) {
        h.removeFromParent();
        (h.material as MeshBasicMaterial).dispose();
      }
      halos.clear();
      for (const g of [tableGeo, matGeo, particleGeo, haloGeo]) g.dispose();
      for (const m of [tableMat, matMat, particleMat]) m.dispose();
      particles.dispose();
      sky.dispose();
      matTex.dispose();
      textures.dispose();
      renderer.dispose();
      canvas.remove();
      hud.remove();
    },
  };

  cameraRig.setState("play", { immediate: true });
  shell.resize();
  return shell;
}
