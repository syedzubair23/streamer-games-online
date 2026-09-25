/**
 * Disposal and leak detection (SPEC §9.4 "dispose() MUST free everything it created", DOD G8a
 * "unmounting returns `renderer.info.memory` to baseline").
 *
 * {@link disposeObject3D} frees every geometry, material and texture under a subtree exactly once,
 * skipping resources registered as **shared** (the procedural texture cache, the shell's own
 * geometry), and {@link createLeakCheck} compares `renderer.info.memory` (and the live program
 * count) against a baseline taken before a game mounted.
 *
 * @module
 */
import type { BufferGeometry, Material, Object3D, Texture } from "three";

/** Resources owned by the shell: never disposed by {@link disposeObject3D}. */
export interface SharedResources {
  add(resource: Texture | BufferGeometry | Material): void;
  delete(resource: Texture | BufferGeometry | Material): void;
  has(resource: Texture | BufferGeometry | Material): boolean;
  readonly size: number;
}

/** Creates a registry of shared (shell-owned) resources. */
export function createSharedResources(): SharedResources {
  const set = new WeakSet<object>();
  let size = 0;
  return {
    add(r) {
      if (set.has(r)) return;
      set.add(r);
      size++;
    },
    delete(r) {
      if (set.delete(r)) size--;
    },
    has: (r) => set.has(r),
    get size() {
      return size;
    },
  };
}

/** What {@link disposeObject3D} freed. */
export interface DisposeReport {
  geometries: number;
  materials: number;
  textures: number;
}

/** Options of {@link disposeObject3D}. */
export interface DisposeOptions {
  /** Shell-owned resources to leave alone. */
  shared?: SharedResources;
  /** Detach `root` from its parent (default true). */
  detach?: boolean;
}

function isTexture(v: unknown): v is Texture {
  return typeof v === "object" && v !== null && (v as { isTexture?: boolean }).isTexture === true;
}

/** Every texture a material references: map slots and `ShaderMaterial` uniforms. */
export function materialTextures(material: Material, out: Set<Texture> = new Set()): Set<Texture> {
  const m = material as unknown as Record<string, unknown>;
  for (const key of Object.keys(m)) {
    const v = m[key];
    if (isTexture(v)) out.add(v);
  }
  const uniforms = m["uniforms"] as Record<string, { value?: unknown }> | undefined;
  if (uniforms !== undefined && typeof uniforms === "object")
    for (const u of Object.values(uniforms)) {
      const v = u?.value;
      if (isTexture(v)) out.add(v);
      else if (Array.isArray(v)) for (const t of v) if (isTexture(t)) out.add(t);
    }
  return out;
}

/**
 * Disposes every geometry, material and texture under `root` (once each), except shared ones,
 * and detaches `root`. Instanced meshes release their instance buffers too. Safe to call twice.
 */
export function disposeObject3D(root: Object3D, opts: DisposeOptions = {}): DisposeReport {
  const shared = opts.shared;
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  const textures = new Set<Texture>();
  const disposables: { dispose(): void }[] = [];
  root.traverse((o) => {
    const node = o as Object3D & {
      geometry?: BufferGeometry;
      material?: Material | Material[];
      isInstancedMesh?: boolean;
      isBatchedMesh?: boolean;
      dispose?: () => void;
    };
    if (node.geometry !== undefined && !shared?.has(node.geometry)) geometries.add(node.geometry);
    const mats =
      node.material === undefined
        ? []
        : Array.isArray(node.material)
          ? node.material
          : [node.material];
    for (const m of mats) {
      if (shared?.has(m)) continue;
      materials.add(m);
    }
    if (
      (node.isInstancedMesh === true || node.isBatchedMesh === true) &&
      node.dispose !== undefined
    )
      disposables.push(node as { dispose(): void });
  });
  for (const m of materials) materialTextures(m, textures);
  for (const t of textures) if (shared?.has(t)) textures.delete(t);
  for (const g of geometries) g.dispose();
  for (const m of materials) m.dispose();
  for (const t of textures) t.dispose();
  for (const d of disposables) d.dispose();
  if (opts.detach !== false) root.removeFromParent();
  return { geometries: geometries.size, materials: materials.size, textures: textures.size };
}

/** The renderer fields leak detection reads (a `WebGLRenderer` satisfies it). */
export interface RendererInfoLike {
  info: {
    memory: { geometries: number; textures: number };
    programs?: readonly unknown[] | null;
  };
}

/** GPU object counts at one moment. */
export interface MemorySnapshot {
  geometries: number;
  textures: number;
  programs: number;
}

/** Reads the renderer's live GPU object counts. */
export function memorySnapshot(r: RendererInfoLike): MemorySnapshot {
  return {
    geometries: r.info.memory.geometries,
    textures: r.info.memory.textures,
    programs: r.info.programs?.length ?? 0,
  };
}

/** The result of a leak check. */
export interface LeakReport {
  ok: boolean;
  baseline: MemorySnapshot;
  now: MemorySnapshot;
  leakedGeometries: number;
  leakedTextures: number;
  leakedPrograms: number;
}

/** A baseline/compare pair around a mount/unmount cycle. */
export interface LeakCheck {
  /** Records the baseline (call after the shell is fully warmed, before the game mounts). */
  baseline(): MemorySnapshot;
  /** Compares the live counts with the baseline. */
  check(): LeakReport;
}

/** Options of {@link createLeakCheck}. */
export interface LeakCheckOptions {
  /**
   * The number of shared (cached, shell-owned) textures right now, e.g. `() => kit.all().length`.
   * A game may ask the texture kit for a texture the boot set did not contain; that texture is
   * cached for every later game and is not a leak, so texture growth up to the growth of the
   * shared cache is allowed.
   */
  sharedTextures?: () => number;
}

/**
 * Creates a leak check on a renderer. Programs are compared too: a program is released when the
 * last material using it is disposed, so a leaked material shows up here even if it never
 * held a texture.
 */
export function createLeakCheck(r: RendererInfoLike, o: LeakCheckOptions = {}): LeakCheck {
  let base: MemorySnapshot | null = null;
  let sharedBase = 0;
  return {
    baseline() {
      base = memorySnapshot(r);
      sharedBase = o.sharedTextures?.() ?? 0;
      return base;
    },
    check() {
      if (base === null) throw new Error("leak check: call baseline() first");
      const now = memorySnapshot(r);
      const sharedGrowth = Math.max(0, (o.sharedTextures?.() ?? 0) - sharedBase);
      const leakedGeometries = Math.max(0, now.geometries - base.geometries);
      const leakedTextures = Math.max(0, now.textures - base.textures - sharedGrowth);
      const leakedPrograms = Math.max(0, now.programs - base.programs);
      return {
        ok: leakedGeometries === 0 && leakedTextures === 0 && leakedPrograms === 0,
        baseline: base,
        now,
        leakedGeometries,
        leakedTextures,
        leakedPrograms,
      };
    },
  };
}
