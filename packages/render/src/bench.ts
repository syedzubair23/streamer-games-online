/**
 * The boot micro-benchmark (SPEC §10, research 04 §2): about 150 ms while the lobby loads, it
 * renders ~20 frames of a representative scene (instanced toon pieces on a textured mat, the
 * two-light rig) and takes the **median** frame time. `detectTier` puts a device on **low** above
 * 8 ms and allows **high** below 3 ms. GPU renderer strings are unreliable and deprecated, so
 * they are never used.
 *
 * Each frame ends with a 1-pixel `readPixels`, which waits for the GPU, so the sample measures
 * real work rather than command submission.
 *
 * @module
 */
import {
  BoxGeometry,
  Color,
  DirectionalLight,
  HemisphereLight,
  InstancedMesh,
  Matrix4,
  Mesh,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  type Camera,
  type Material,
  type Object3D,
} from "three";

/** What the benchmark renders with (a `WebGLRenderer` satisfies it). */
export interface BenchRenderer {
  render(scene: Object3D, camera: Camera): void;
  getContext?(): { readPixels(...args: unknown[]): void; RGBA: number; UNSIGNED_BYTE: number };
  setSize?(w: number, h: number, updateStyle?: boolean): void;
}

/** Options of {@link runBootBench}. */
export interface BenchOptions {
  renderer: BenchRenderer;
  /** Materials for the pieces and the mat (from the factories). Disposed by the caller. */
  pieceMaterial: Material;
  matMaterial: Material;
  /** Frames to sample (default 20) after `warmup` unmeasured frames (default 3: compiles). */
  frames?: number;
  warmup?: number;
  /** Pieces in the instanced mesh (default 120). */
  pieces?: number;
  now?: () => number;
}

/** The benchmark's result. */
export interface BenchResult {
  medianMs: number;
  samples: number[];
}

/** The median of a list (0 for an empty list). */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1
    ? (s[mid] as number)
    : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/**
 * Renders the representative scene and returns the median frame time. Everything the benchmark
 * creates (geometry, lights, scene) is disposed before it returns; materials belong to the caller.
 */
export function runBootBench(o: BenchOptions): BenchResult {
  const now = o.now ?? (() => performance.now());
  const scene = new Scene();
  scene.background = new Color(0.9, 0.8, 0.7);
  const camera = new PerspectiveCamera(30, 16 / 9, 0.1, 50);
  camera.position.set(0, 6, 6);
  camera.lookAt(0, 0, 0);
  scene.add(new HemisphereLight(0xffffff, 0x886655, 1), new DirectionalLight(0xffffff, 2));
  const matGeo = new PlaneGeometry(6, 6);
  matGeo.rotateX(-Math.PI / 2);
  scene.add(new Mesh(matGeo, o.matMaterial));
  const n = o.pieces ?? 120;
  const boxGeo = new BoxGeometry(0.2, 0.3, 0.2, 2, 2, 2);
  const pieces = new InstancedMesh(boxGeo, o.pieceMaterial, n);
  const m = new Matrix4();
  for (let i = 0; i < n; i++) {
    m.makeTranslation(((i % 12) - 5.5) * 0.45, 0.15, (Math.floor(i / 12) - 4.5) * 0.45);
    pieces.setMatrixAt(i, m);
  }
  scene.add(pieces);
  const gl = o.renderer.getContext?.();
  const px = new Uint8Array(4);
  const sync = (): void => gl?.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const samples: number[] = [];
  try {
    const warm = o.warmup ?? 3;
    const frames = Math.max(1, o.frames ?? 20);
    for (let f = 0; f < warm + frames; f++) {
      pieces.rotation.y = f * 0.05;
      const t0 = now();
      o.renderer.render(scene, camera);
      sync();
      if (f >= warm) samples.push(now() - t0);
    }
  } finally {
    matGeo.dispose();
    boxGeo.dispose();
    pieces.dispose();
    scene.clear();
  }
  return { medianMs: median(samples), samples };
}
