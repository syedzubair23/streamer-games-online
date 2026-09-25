/**
 * Extruded pieces (SPEC §13.6, research 03 §6): `ExtrudeGeometry` with bevels for tiles, cards,
 * chips and table slabs. Pieces lie flat (extruded along +Y, bottom at `y = 0`), and cap UVs are
 * normalised to `0..1` over the shape's bounds so a card face or tile art maps exactly once.
 *
 * @module
 */
import { ExtrudeGeometry, Shape, Vector2 } from "three";
import { TIERS } from "../quality.ts";
import type { QualityTier } from "../types.ts";

/** A rounded-rectangle shape centred on the origin. */
export function roundedRectShape(width: number, height: number, radius: number): Shape {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  const x = -width / 2;
  const y = -height / 2;
  const s = new Shape();
  s.moveTo(x + r, y);
  s.lineTo(x + width - r, y);
  if (r > 0) s.absarc(x + width - r, y + r, r, -Math.PI / 2, 0, false);
  s.lineTo(x + width, y + height - r);
  if (r > 0) s.absarc(x + width - r, y + height - r, r, 0, Math.PI / 2, false);
  s.lineTo(x + r, y + height);
  if (r > 0) s.absarc(x + r, y + height - r, r, Math.PI / 2, Math.PI, false);
  s.lineTo(x, y + r);
  if (r > 0) s.absarc(x + r, y + r, r, Math.PI, Math.PI * 1.5, false);
  return s;
}

/** A closed polygon shape from points (counter-clockwise). */
export function polygonShape(points: readonly (readonly [number, number])[]): Shape {
  if (points.length < 3) throw new RangeError("extrude: a polygon needs at least 3 points");
  return new Shape(points.map(([x, y]) => new Vector2(x, y)));
}

/** Options of {@link extrudePiece}. */
export interface ExtrudeOptions {
  /** Total thickness along +Y (bevels included). */
  thickness: number;
  /** Bevel size (default 25% of the thickness, capped at 0.06). */
  bevel?: number;
  /** Bevel segments (default: 1 on low, 2 on mid, 3 on high). */
  bevelSegments?: number;
  /** Segments per curved edge (default: the tier's `latheSegments / 2`). */
  curveSegments?: number;
  tier?: QualityTier;
}

/**
 * Extrudes a shape into a flat-lying piece: the shape's XY plane becomes the XZ table plane
 * (shape +Y → world −Z, so art painted "up" faces away from the camera side), bottom at y = 0,
 * top at y = thickness. Cap UVs span `0..1` over the shape's bounding box.
 */
export function extrudePiece(shape: Shape, o: ExtrudeOptions): ExtrudeGeometry {
  const tier = o.tier ?? "mid";
  const bevel = Math.max(
    0,
    Math.min(o.bevel ?? Math.min(0.06, o.thickness * 0.25), o.thickness / 2),
  );
  const bevelSegments = Math.max(
    1,
    o.bevelSegments ?? (tier === "low" ? 1 : tier === "mid" ? 2 : 3),
  );
  const curveSegments = Math.max(2, o.curveSegments ?? Math.round(TIERS[tier].latheSegments / 2));
  const geo = new ExtrudeGeometry(shape, {
    depth: Math.max(1e-4, o.thickness - 2 * bevel),
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: -bevel,
    bevelSegments,
    curveSegments,
  });
  // Normalise UVs to the shape bounds (ExtrudeGeometry emits raw shape coordinates).
  const pts = shape.extractPoints(curveSegments).shape;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const uv = geo.getAttribute("uv");
  const pos = geo.getAttribute("position");
  const sx = 1 / Math.max(1e-9, maxX - minX);
  const sy = 1 / Math.max(1e-9, maxY - minY);
  for (let i = 0; i < uv.count; i++)
    uv.setXY(i, (pos.getX(i) - minX) * sx, (pos.getY(i) - minY) * sy);
  uv.needsUpdate = true;
  // Lay flat: extrusion (+Z) becomes +Y; shape +Y becomes −Z.
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, bevel, 0);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

/** A flat rounded tile (board tiles, chips). */
export function tileGeometry(
  width: number,
  depth: number,
  thickness: number,
  radius = Math.min(width, depth) * 0.18,
  tier: QualityTier = "mid",
): ExtrudeGeometry {
  return extrudePiece(roundedRectShape(width, depth, radius), { thickness, tier });
}

/** A playing card (5:7 by default), thin with a tiny bevel; top-face UVs span `0..1`. */
export function cardGeometry(
  width = 0.5,
  height = width * 1.4,
  thickness = 0.012,
  tier: QualityTier = "mid",
): ExtrudeGeometry {
  return extrudePiece(roundedRectShape(width, height, width * 0.08), {
    thickness,
    bevel: thickness * 0.3,
    bevelSegments: 1,
    tier,
  });
}
