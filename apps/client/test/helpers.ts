/**
 * Test helpers for the scenario route under happy-dom: a no-op 2D canvas context (happy-dom has
 * none) and a fake WebGL renderer that tracks draw calls and GPU memory like three's
 * `renderer.info` (objects count once rendered, and leave on `dispose`).
 */
import type { BufferGeometry, Material, Mesh, Object3D, Scene, Texture } from "three";
import type { RendererLike } from "../src/dev/placeholder-shell.ts";

/** Makes every `<canvas>` return a no-op 2D context. */
export function installCanvasStub(): void {
  const proto = HTMLCanvasElement.prototype as unknown as {
    getContext: unknown;
    __stubbed?: boolean;
  };
  if (proto.__stubbed === true) return;
  proto.__stubbed = true;
  const gradient = { addColorStop: () => undefined };
  proto.getContext = function (this: HTMLCanvasElement, kind: string) {
    if (kind !== "2d") return null;
    const canvas = this;
    return new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "canvas") return canvas;
          if (prop === "createImageData")
            return (w: number, h: number) => ({
              width: w,
              height: h,
              data: new Uint8ClampedArray(w * h * 4),
            });
          if (prop === "createLinearGradient" || prop === "createRadialGradient")
            return () => gradient;
          return () => undefined;
        },
        set: () => true,
      },
    );
  };
}

type Disposable = { addEventListener: (t: "dispose", f: () => void) => void };

/** A fake renderer with three-like `info` bookkeeping. */
export function fakeRenderer(doc: Document = document): RendererLike & { frames: number } {
  const geos = new Set<BufferGeometry>();
  const texs = new Set<Texture>();
  const programs = new Set<string>();
  const info = {
    render: { calls: 0, triangles: 0, frame: 0, lines: 0, points: 0 },
    memory: { geometries: 0, textures: 0 },
    programs: [] as unknown[],
    autoReset: true,
    reset: () => undefined,
  };
  const sync = (): void => {
    info.memory.geometries = geos.size;
    info.memory.textures = texs.size;
    info.programs = [...programs];
  };
  const track = <T extends Disposable>(set: Set<T>, o: T): void => {
    if (set.has(o)) return;
    set.add(o);
    o.addEventListener("dispose", () => {
      set.delete(o);
      sync();
    });
  };
  const r = {
    frames: 0,
    domElement: doc.createElement("canvas"),
    info,
    setPixelRatio: () => undefined,
    setSize: () => undefined,
    dispose: () => undefined,
    initTexture: (t: Texture) => {
      track(texs, t);
      sync();
    },
    render(scene: Scene) {
      r.frames++;
      let calls = 1; // the background
      let tris = 2;
      scene.traverseVisible((o: Object3D) => {
        const mesh = o as Mesh;
        if ((mesh as { isMesh?: boolean }).isMesh !== true) return;
        calls++;
        track(geos, mesh.geometry);
        const idx = mesh.geometry.index;
        tris += (idx !== null ? idx.count : (mesh.geometry.attributes["position"]?.count ?? 0)) / 3;
        const mats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as (Material &
          Record<string, unknown>)[];
        for (const m of mats) {
          programs.add(m.type);
          for (const k of ["map", "gradientMap", "matcap"]) {
            const t = m[k] as Texture | null | undefined;
            if (t !== null && t !== undefined) track(texs, t);
          }
        }
      });
      info.render.calls = calls;
      info.render.triangles = Math.round(tris);
      sync();
    },
  };
  return r as unknown as RendererLike & { frames: number };
}

/** A manual frame scheduler: `flush(now)` runs the queued callbacks once. */
export function manualScheduler() {
  let queue: { id: number; cb: (now: number) => void }[] = [];
  let next = 1;
  return {
    schedule: (cb: (now: number) => void): number => {
      const id = next++;
      queue.push({ id, cb });
      return id;
    },
    unschedule: (id: number): void => {
      queue = queue.filter((q) => q.id !== id);
    },
    get pending(): number {
      return queue.length;
    },
    flush(now: number): void {
      const run = queue;
      queue = [];
      for (const q of run) q.cb(now);
    },
  };
}
