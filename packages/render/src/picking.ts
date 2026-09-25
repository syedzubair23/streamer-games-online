/**
 * Picking (`ctx.pick`, research 04 §3.1): analytic ray/plane intersection for boards (O(1), no
 * allocation) and instanced/object raycasts that reuse one intersection array.
 *
 * The canvas rect is cached and refreshed by {@link Picker.updateRect} (call it on resize), so a
 * pick never forces layout or allocates a `DOMRect`.
 *
 * @module
 */
import { Raycaster, Vector2, Vector3, type Camera, type Intersection, type Object3D } from "three";
import type { PickApi, PointerLike } from "./types.ts";

/** An element with a client rect (the canvas). */
export interface RectSource {
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
}

/** The picker: {@link PickApi} plus rect/camera management. */
export interface Picker extends PickApi {
  /** Re-reads the element's client rect (call on resize/scroll). */
  updateRect(): void;
  /** Switches the camera (e.g. the opt-in phone board). */
  setCamera(camera: Camera): void;
  /** Converts a pointer to normalized device coordinates (into `out`). */
  toNdc(pointer: PointerLike, out: Vector2): Vector2;
}

/** Options of {@link createPicker}. */
export interface PickerOptions {
  camera: Camera;
  element: RectSource;
  /** The default plane height for {@link PickApi.plane} (the table top, default 0). */
  tableY?: number;
}

/** Creates a picker for a camera and canvas. */
export function createPicker(o: PickerOptions): Picker {
  let camera = o.camera;
  const rect = { left: 0, top: 0, width: 1, height: 1 };
  const ndc = new Vector2();
  const origin = new Vector3();
  const dir = new Vector3();
  const planeOut = new Vector3();
  const raycaster = new Raycaster();
  const hits: Intersection[] = [];
  const tableY = o.tableY ?? 0;

  const picker: Picker = {
    updateRect() {
      const r = o.element.getBoundingClientRect();
      rect.left = r.left;
      rect.top = r.top;
      rect.width = r.width > 0 ? r.width : 1;
      rect.height = r.height > 0 ? r.height : 1;
    },
    setCamera(c) {
      camera = c;
    },
    toNdc(p, out) {
      return out.set(
        ((p.clientX - rect.left) / rect.width) * 2 - 1,
        -((p.clientY - rect.top) / rect.height) * 2 + 1,
      );
    },
    plane(pointer, planeY = tableY, out) {
      picker.toNdc(pointer, ndc);
      camera.updateMatrixWorld();
      const persp = (camera as { isPerspectiveCamera?: boolean }).isPerspectiveCamera === true;
      if (persp) {
        origin.setFromMatrixPosition(camera.matrixWorld);
        dir.set(ndc.x, ndc.y, 0.5).unproject(camera).sub(origin).normalize();
      } else {
        // Orthographic: the ray starts on the near plane and looks down the camera's -Z.
        origin.set(ndc.x, ndc.y, -1).unproject(camera);
        dir.set(0, 0, -1).transformDirection(camera.matrixWorld);
      }
      if (Math.abs(dir.y) < 1e-9) return null;
      const t = (planeY - origin.y) / dir.y;
      if (t < 0) return null;
      return (out ?? planeOut).copy(origin).addScaledVector(dir, t);
    },
    instance(mesh, pointer) {
      picker.toNdc(pointer, ndc);
      camera.updateMatrixWorld();
      raycaster.setFromCamera(ndc, camera);
      hits.length = 0;
      raycaster.intersectObject(mesh, false, hits);
      const id = hits[0]?.instanceId;
      hits.length = 0;
      return id ?? null;
    },
    object(targets, pointer) {
      picker.toNdc(pointer, ndc);
      camera.updateMatrixWorld();
      raycaster.setFromCamera(ndc, camera);
      hits.length = 0;
      raycaster.intersectObjects(targets as Object3D[], true, hits);
      for (let i = 0; i < hits.length; i++) {
        let n: Object3D | null = (hits[i] as Intersection).object;
        while (n !== null) {
          if (targets.includes(n)) {
            hits.length = 0;
            return n;
          }
          n = n.parent;
        }
      }
      hits.length = 0;
      return null;
    },
  };
  picker.updateRect();
  return picker;
}
