/**
 * Picking (`ctx.pick`): analytic table-plane hits, instanced and object raycasts, orthographic
 * cameras and misses; no allocation per pick in the plane path (the result vector is reused).
 */
import {
  BoxGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  Vector3,
} from "three";
import { describe, expect, it } from "vitest";
import { createPicker } from "../src/picking.ts";

const rect = { left: 100, top: 50, width: 800, height: 600 };
const element = { getBoundingClientRect: () => rect };
const centre = { clientX: 500, clientY: 350 };

function topDown(): PerspectiveCamera {
  const cam = new PerspectiveCamera(40, 800 / 600, 0.1, 100);
  cam.up.set(0, 0, -1); // straight down: screen-up is table −Z
  cam.position.set(0, 10, 0);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld();
  return cam;
}

describe("picker", () => {
  it("hits the table plane under the centre of the canvas", () => {
    const p = createPicker({ camera: topDown(), element });
    const hit = p.plane(centre);
    expect(hit).not.toBeNull();
    expect(hit?.x).toBeCloseTo(0, 6);
    expect(hit?.y).toBeCloseTo(0, 6);
    expect(hit?.z).toBeCloseTo(0, 6);
    // The same internal vector is reused (no allocation per pick).
    expect(p.plane({ clientX: 600, clientY: 350 })).toBe(hit);
    expect((hit as Vector3).x).toBeGreaterThan(0);
  });

  it("writes into a caller vector and honours the plane height", () => {
    const p = createPicker({ camera: topDown(), element, tableY: 1 });
    const out = new Vector3();
    expect(p.plane(centre, undefined, out)).toBe(out);
    expect(out.y).toBeCloseTo(1, 6);
    p.plane(centre, 2.5, out);
    expect(out.y).toBeCloseTo(2.5, 6);
  });

  it("returns null when the ray misses (parallel or behind)", () => {
    const cam = new PerspectiveCamera(40, 1, 0.1, 100);
    cam.position.set(0, 1, 5);
    cam.lookAt(0, 1, 0); // looking horizontally
    const p = createPicker({ camera: cam, element });
    expect(p.plane(centre, 1)).toBeNull(); // parallel to y = 1
    expect(p.plane({ clientX: 500, clientY: 60 }, 0)).toBeNull(); // above the horizon
  });

  it("supports orthographic cameras", () => {
    const cam = new OrthographicCamera(-4, 4, 3, -3, 0.1, 50);
    cam.up.set(0, 0, -1);
    cam.position.set(1, 10, 2);
    cam.lookAt(1, 0, 2);
    const p = createPicker({ camera: cam, element });
    const hit = p.plane(centre);
    expect(hit?.x).toBeCloseTo(1, 5);
    expect(hit?.z).toBeCloseTo(2, 5);
    p.setCamera(topDown());
    expect(p.plane(centre)?.x).toBeCloseTo(0, 5);
  });

  it("converts pointers to NDC and refreshes the cached rect", () => {
    const r = { left: 0, top: 0, width: 0, height: 0 };
    const p = createPicker({ camera: topDown(), element: { getBoundingClientRect: () => r } });
    const v = p.toNdc({ clientX: 1, clientY: 1 }, new Vector3() as never);
    expect(v.x).toBe(1); // zero-size rects fall back to 1 × 1
    r.width = 200;
    r.height = 100;
    p.updateRect();
    const n = p.toNdc({ clientX: 50, clientY: 25 }, new Vector3() as never);
    expect(n.x).toBeCloseTo(-0.5, 9);
    expect(n.y).toBeCloseTo(0.5, 9);
  });

  it("finds the instance under the pointer", () => {
    const cam = topDown();
    const mesh = new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial(), 3);
    const m = new Matrix4();
    mesh.setMatrixAt(0, m.makeTranslation(-3, 0, 0));
    mesh.setMatrixAt(1, m.makeTranslation(0, 0, 0));
    mesh.setMatrixAt(2, m.makeTranslation(3, 0, 0));
    mesh.computeBoundingSphere();
    const p = createPicker({ camera: cam, element });
    expect(p.instance(mesh, centre)).toBe(1);
    expect(p.instance(mesh, { clientX: 105, clientY: 55 })).toBeNull();
  });

  it("finds the first target under the pointer, resolving children to their target", () => {
    const cam = topDown();
    const piece = new Group();
    piece.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial()));
    const other = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
    other.position.set(3, 0, 0);
    // The renderer updates world matrices every frame; picks run between frames.
    piece.updateMatrixWorld();
    other.updateMatrixWorld();
    const p = createPicker({ camera: cam, element });
    expect(p.object([piece, other], centre)).toBe(piece);
    expect(p.object([piece, other], { clientX: 105, clientY: 55 })).toBeNull();
    // Only the listed targets count: the centre ray passes over `other`.
    expect(p.object([other], centre)).toBeNull();
  });
});
