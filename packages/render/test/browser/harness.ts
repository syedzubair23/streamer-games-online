/**
 * Browser entry for the `@sg/render` Playwright specs: bundles the kit and the few three.js
 * classes the specs need, and exposes them as `window.__sg`. Served by `serve.ts` from a routed
 * origin (so IndexedDB works) with no network and no dev server.
 */
import {
  BoxGeometry,
  CanvasTexture,
  DirectionalLight,
  Group,
  HemisphereLight,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  SphereGeometry,
} from "three";
import * as R from "../../src/index.ts";

const T = {
  BoxGeometry,
  CanvasTexture,
  DirectionalLight,
  Group,
  HemisphereLight,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  SphereGeometry,
};

/** Waits `n` display frames (a probe independent of the loop under test). */
function ticks(n: number): Promise<void> {
  return new Promise((resolve) => {
    let left = n;
    const step = (): void => {
      if (--left <= 0) resolve();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

/** A SHA-like digest of a canvas's pixels (FNV-1a over RGBA), for determinism checks. */
function pixelHash(canvas: HTMLCanvasElement | OffscreenCanvas): string {
  const ctx = canvas.getContext("2d") as
    CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (ctx === null) return "no-2d";
  const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let h = 0x811c9dc5;
  for (let i = 0; i < d.length; i++) {
    h ^= d[i] as number;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${canvas.width}x${canvas.height}:${h.toString(16)}`;
}

/** Luminance standard deviation of a canvas (blank-canvas check). */
function pixelSd(canvas: HTMLCanvasElement | OffscreenCanvas): number {
  const ctx = canvas.getContext("2d") as
    CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (ctx === null) return 0;
  const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let sum = 0;
  let sq = 0;
  const n = d.length / 4;
  for (let i = 0; i < d.length; i += 4) {
    const l =
      0.2126 * (d[i] as number) + 0.7152 * (d[i + 1] as number) + 0.0722 * (d[i + 2] as number);
    const a = (d[i + 3] as number) / 255;
    const v = l * a;
    sum += v;
    sq += v * v;
  }
  const mean = sum / n;
  return Math.sqrt(Math.max(0, sq / n - mean * mean));
}

/** A shell-like stage: renderer, texture kit, factories, sky, lights, table, loop and tweens. */
function stage(
  tier: R.QualityTier,
  opts: { ambient?: boolean; width?: number; height?: number } = {},
) {
  const w = opts.width ?? 640;
  const h = opts.height ?? 360;
  const canvas = document.createElement("canvas");
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  document.body.appendChild(canvas);
  const renderer = R.createRenderer({
    tier,
    canvas,
    devicePixelRatio: 1,
    preserveDrawingBuffer: true,
  });
  renderer.resize(w, h);
  const kit = R.createTextureKit({ tier });
  kit.generateBoot();
  const materials = R.createMaterialFactories(tier, {
    ramp: kit.api.ramp(),
    matcapWarm: kit.api.matcap({ variant: "warm" }),
    matcapCool: kit.api.matcap({ variant: "cool" }),
    blob: kit.api.blob(),
  });
  const scene = new Scene();
  const camera = new PerspectiveCamera(30, w / h, 0.1, 100);
  camera.position.set(0, 5.2, 6.4);
  camera.lookAt(0, 0, 0);
  const hemi = new HemisphereLight("#FFD2B0", "#B7797A", 0.8);
  const key = new DirectionalLight("#FFC98A", 2.6);
  key.position.set(-4, 7, 3);
  scene.add(hemi, key, key.target);
  const skyMat = materials.makeSky();
  const sky = new Mesh(new SphereGeometry(40, 24, 12), skyMat);
  scene.add(sky);
  const tableGeo = R.bakeVertexAO(R.roundedBoxGeometry(7.2, 0.5, 5.4, { tier, radius: 0.2 }));
  tableGeo.translate(0, -0.25, 0);
  const tableMat = materials.makeLambertVC({ map: kit.api.wood({ variant: "table" }) });
  const table = new Mesh(tableGeo, tableMat);
  scene.add(table);
  const gameRoot = new Group();
  scene.add(gameRoot);
  const tweens = R.createTweens({ onStart: () => loop.invalidate() });
  const loop = R.createLoop({
    render: () => renderer.render(scene, camera),
    ambient: opts.ambient === true,
    ambientFps: R.TIERS[tier].ambientFps,
  });
  loop.add({ update: (dt) => tweens.step(dt), busy: () => tweens.active > 0 });
  return {
    canvas,
    renderer,
    kit,
    materials,
    scene,
    camera,
    gameRoot,
    loop,
    tweens,
    sky,
    dispose() {
      loop.dispose();
      R.disposeObject3D(scene, { shared: kit.shared });
      kit.dispose();
      renderer.dispose();
      canvas.remove();
    },
  };
}

/**
 * Mounts representative game content (what a game's stage() builds): instanced lathe pieces on
 * rim toon, a matcap rounded box, an extruded card with its own canvas texture, instanced blob
 * shadows with per-instance opacity, an additive halo on the shared blob, and a tile using the
 * kit's board texture (the boot one, or `boardVariant`, which the kit paints on demand and then
 * caches as a shell-owned texture). Everything is built from the factories.
 */
function mountGame(
  s: ReturnType<typeof stage>,
  tier: R.QualityTier,
  o: { boardVariant?: string } = {},
) {
  const root = new Group();
  const pieces = new InstancedMesh(
    R.latheGeometry("pawn", { tier, scale: 0.4 }),
    s.materials.makeToon({ color: "#F26B5B" }),
    16,
  );
  const m = new Matrix4();
  for (let i = 0; i < 16; i++)
    pieces.setMatrixAt(
      i,
      m.makeTranslation(((i % 4) - 1.5) * 0.6, 0, (Math.floor(i / 4) - 1.5) * 0.6),
    );
  root.add(pieces);
  const shadowGeo = new PlaneGeometry(0.4, 0.4);
  shadowGeo.rotateX(-Math.PI / 2);
  const shadows = new InstancedMesh(shadowGeo, s.materials.makeBlobShadow({ instanced: true }), 16);
  const op = new Float32Array(16).fill(0.8);
  shadows.geometry.setAttribute(R.BLOB_OPACITY_ATTRIBUTE, new InstancedBufferAttribute(op, 1));
  for (let i = 0; i < 16; i++)
    shadows.setMatrixAt(
      i,
      m.makeTranslation(((i % 4) - 1.5) * 0.6, 0.002, (Math.floor(i / 4) - 1.5) * 0.6),
    );
  root.add(shadows);
  const clay = new Mesh(R.roundedBoxGeometry(0.5, 0.5, 0.5, { tier }), s.materials.makeMatcap());
  clay.position.set(2, 0.25, 0);
  root.add(clay);
  const own = document.createElement("canvas");
  own.width = 128;
  own.height = 180;
  const g = own.getContext("2d");
  if (g !== null) {
    g.fillStyle = "#FBF5EA";
    g.fillRect(0, 0, 128, 180);
  }
  const cardTex = new CanvasTexture(own);
  const card = new Mesh(
    R.cardGeometry(0.5, 0.7, 0.012, tier),
    s.materials.makeToon({ map: cardTex, rim: false }),
  );
  card.position.set(-2, 0, 0);
  root.add(card);
  const halo = new Mesh(
    new PlaneGeometry(1, 1),
    s.materials.makeBasic({ additive: true, map: s.kit.api.blob(), color: "#FFC26B" }),
  );
  halo.position.set(0, 1, 0);
  root.add(halo);
  const tile = new Mesh(
    R.tileGeometry(1, 1, 0.08, 0.15, tier),
    s.materials.makeLambertVC({
      vertexColors: false,
      map: s.kit.api.board(o.boardVariant !== undefined ? { variant: o.boardVariant } : {}),
    }),
  );
  tile.position.set(0, 0, 1.8);
  root.add(tile);
  s.gameRoot.add(root);
  return root;
}

const api = { R, T, ticks, pixelHash, pixelSd, stage, mountGame };
export type Harness = typeof api;
(window as unknown as { __sg: Harness }).__sg = api;
