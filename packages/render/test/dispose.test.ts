/**
 * Disposal (SPEC §9.4) and leak checks (DOD G8a): every owned geometry, material and texture is
 * freed exactly once, shared resources are left alone, instanced buffers are released, and the
 * leak check compares memory and programs against a baseline. The real `renderer.info.memory`
 * round trip is `test/browser/render-kit.spec.ts`.
 */
import {
  BoxGeometry,
  DataTexture,
  Group,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  MeshToonMaterial,
  ShaderMaterial,
  Texture,
  type BufferGeometry,
  type Material,
} from "three";
import { describe, expect, it } from "vitest";
import {
  createLeakCheck,
  createSharedResources,
  disposeObject3D,
  materialTextures,
  memorySnapshot,
} from "../src/dispose.ts";

function watch<T extends { addEventListener(t: "dispose", cb: () => void): void }>(
  o: T,
  counts: Map<unknown, number>,
): T {
  counts.set(o, 0);
  o.addEventListener("dispose", () => counts.set(o, (counts.get(o) ?? 0) + 1));
  return o;
}

describe("disposeObject3D", () => {
  it("frees every owned resource once and skips shared ones", () => {
    const counts = new Map<unknown, number>();
    const shared = createSharedResources();
    const sharedTex = watch(new DataTexture(new Uint8Array(4), 1, 1), counts);
    shared.add(sharedTex);
    shared.add(sharedTex);
    expect(shared.size).toBe(1);
    const ownTex = watch(new Texture(), counts);
    const alpha = watch(new Texture(), counts);
    const geo = watch(new BoxGeometry(), counts) as BufferGeometry;
    const sharedGeo = watch(new BoxGeometry(), counts) as BufferGeometry;
    shared.add(sharedGeo);
    const matA = watch(
      new MeshToonMaterial({ map: ownTex, gradientMap: sharedTex, alphaMap: alpha }),
      counts,
    ) as Material;
    const matB = watch(new MeshBasicMaterial({ map: ownTex }), counts) as Material;
    const shader = watch(
      new ShaderMaterial({
        uniforms: { a: { value: ownTex }, list: { value: [alpha, sharedTex] }, n: { value: 1 } },
      }),
      counts,
    ) as Material;
    const root = new Group();
    const parent = new Group();
    parent.add(root);
    root.add(new Mesh(geo, matA));
    root.add(new Mesh(geo, [matA, matB]));
    root.add(new Mesh(sharedGeo, shader));
    const inst = new InstancedMesh(geo, matB, 4);
    let instDisposed = 0;
    inst.addEventListener("dispose", () => instDisposed++);
    root.add(inst);

    const report = disposeObject3D(root, { shared });
    expect(report).toEqual({ geometries: 1, materials: 3, textures: 2 });
    expect(counts.get(geo)).toBe(1);
    expect(counts.get(sharedGeo)).toBe(0);
    expect(counts.get(matA)).toBe(1);
    expect(counts.get(matB)).toBe(1);
    expect(counts.get(shader)).toBe(1);
    expect(counts.get(ownTex)).toBe(1);
    expect(counts.get(alpha)).toBe(1);
    expect(counts.get(sharedTex)).toBe(0);
    expect(instDisposed).toBe(1);
    expect(root.parent).toBeNull();
    shared.delete(sharedTex);
    shared.delete(sharedTex);
    expect(shared.has(sharedTex)).toBe(false);
    expect(shared.size).toBe(1);
  });

  it("can leave the root attached, and skips shared materials", () => {
    const shared = createSharedResources();
    const mat = new MeshBasicMaterial();
    shared.add(mat);
    let disposed = 0;
    mat.addEventListener("dispose", () => disposed++);
    const parent = new Group();
    const root = new Group();
    parent.add(root);
    root.add(new Mesh(new BoxGeometry(), mat));
    const r = disposeObject3D(root, { shared, detach: false });
    expect(r.materials).toBe(0);
    expect(disposed).toBe(0);
    expect(root.parent).toBe(parent);
    // Without a registry everything is owned.
    expect(disposeObject3D(new Mesh(new BoxGeometry(), new MeshBasicMaterial())).materials).toBe(1);
  });

  it("lists every texture a material references", () => {
    const t1 = new Texture();
    const t2 = new Texture();
    const m = new ShaderMaterial({
      uniforms: { a: { value: t1 }, b: { value: [t2, 3] }, c: { value: null } },
    });
    expect([...materialTextures(m)]).toEqual([t1, t2]);
    expect(materialTextures(new MeshBasicMaterial({ map: t1 })).has(t1)).toBe(true);
  });
});

describe("leak check", () => {
  it("compares geometries, textures and programs with the baseline", () => {
    const info = { memory: { geometries: 5, textures: 7 }, programs: [1, 2, 3] as unknown[] };
    const r = { info };
    expect(memorySnapshot(r)).toEqual({ geometries: 5, textures: 7, programs: 3 });
    const lc = createLeakCheck(r);
    expect(() => lc.check()).toThrow(/baseline/);
    lc.baseline();
    info.memory.geometries = 9;
    info.memory.textures = 8;
    info.programs = [1, 2, 3, 4];
    expect(lc.check()).toMatchObject({
      ok: false,
      leakedGeometries: 4,
      leakedTextures: 1,
      leakedPrograms: 1,
    });
    info.memory.geometries = 5;
    info.memory.textures = 6;
    info.programs = [1];
    expect(lc.check()).toMatchObject({
      ok: true,
      leakedGeometries: 0,
      leakedTextures: 0,
      leakedPrograms: 0,
    });
    expect(memorySnapshot({ info: { memory: { geometries: 0, textures: 0 } } }).programs).toBe(0);
  });

  it("does not count newly cached shared textures as leaks", () => {
    const info = { memory: { geometries: 1, textures: 10 }, programs: [] as unknown[] };
    let shared = 4;
    const lc = createLeakCheck({ info }, { sharedTextures: () => shared });
    lc.baseline();
    info.memory.textures = 12; // the game asked the kit for 2 new cached textures
    shared = 6;
    expect(lc.check()).toMatchObject({ ok: true, leakedTextures: 0 });
    info.memory.textures = 13; // …and leaked one of its own
    expect(lc.check()).toMatchObject({ ok: false, leakedTextures: 1 });
  });
});
