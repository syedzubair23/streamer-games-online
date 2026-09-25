/**
 * Procedural geometry (SPEC §13.6): lathe profiles, rounded boxes and extruded pieces — sizes,
 * normals, UVs and per-tier detail.
 */
import { Vector3 } from "three";
import { describe, expect, it } from "vitest";
import {
  cardGeometry,
  extrudePiece,
  polygonShape,
  roundedRectShape,
  tileGeometry,
} from "../src/pieces/extrude.ts";
import { latheGeometry, PROFILES, smoothProfile } from "../src/pieces/lathe.ts";
import { roundedBoxGeometry } from "../src/pieces/rounded-box.ts";

describe("lathe", () => {
  it("builds every built-in profile with tier segments", () => {
    for (const name of Object.keys(PROFILES) as (keyof typeof PROFILES)[]) {
      const low = latheGeometry(name, { tier: "low" });
      const high = latheGeometry(name, { tier: "high" });
      expect(high.getAttribute("position").count).toBeGreaterThan(
        low.getAttribute("position").count,
      );
      const box = low.boundingBox;
      expect(box?.min.y).toBeCloseTo(0, 6);
      expect(box?.max.x).toBeLessThanOrEqual(0.5);
    }
    expect(latheGeometry("pawn", { segments: 8, scale: 2 }).boundingBox?.max.y).toBeCloseTo(2, 6);
  });

  it("stays within research 04 §3.2 budgets (≤ 600 tris on low, ≤ 1.5k on high)", () => {
    const tris = (tier: "low" | "mid" | "high") =>
      (latheGeometry("pawn", { tier }).index?.count ?? 0) / 3;
    expect(tris("low")).toBeLessThanOrEqual(600);
    expect(tris("low")).toBeGreaterThan(100);
    expect(tris("high")).toBeLessThanOrEqual(1500);
  });

  it("smooths profiles without folding or negative radii", () => {
    const pts = smoothProfile(PROFILES.pawn, 3);
    expect(pts.length).toBe((PROFILES.pawn.length - 1) * 4 + 1);
    for (let i = 1; i < pts.length; i++) {
      expect(pts[i]!.y).toBeGreaterThanOrEqual(pts[i - 1]!.y);
      expect(pts[i]!.x).toBeGreaterThanOrEqual(0);
    }
    expect(smoothProfile(PROFILES.peg, 0).length).toBe(PROFILES.peg.length);
    expect(() => smoothProfile([[0, 0]])).toThrow(RangeError);
    const custom = latheGeometry(
      [
        [0, 0],
        [0.2, 0],
        [0.2, 0.3],
        [0, 0.4],
      ],
      { subdivisions: 0, segments: 2 },
    );
    expect(custom.getAttribute("position").count).toBeGreaterThan(0);
  });
});

describe("rounded box", () => {
  it("fits its dimensions exactly with unit normals on the rounded surface", () => {
    const g = roundedBoxGeometry(2, 1, 0.6, { radius: 0.2, segments: 3 });
    const box = g.boundingBox!;
    expect(box.min.x).toBeCloseTo(-1, 6);
    expect(box.max.y).toBeCloseTo(0.5, 6);
    expect(box.max.z).toBeCloseTo(0.3, 6);
    const pos = g.getAttribute("position");
    const nrm = g.getAttribute("normal");
    const p = new Vector3();
    const n = new Vector3();
    let cornerMax = 0;
    for (let i = 0; i < pos.count; i++) {
      n.fromBufferAttribute(nrm, i);
      expect(n.length()).toBeCloseTo(1, 5);
      p.fromBufferAttribute(pos, i);
      // Never outside the rounded envelope: distance to the inner box ≤ radius.
      const dx = Math.max(0, Math.abs(p.x) - 0.8);
      const dy = Math.max(0, Math.abs(p.y) - 0.3);
      const dz = Math.max(0, Math.abs(p.z) - 0.1);
      const d = Math.hypot(dx, dy, dz);
      expect(d).toBeLessThanOrEqual(0.2 + 1e-6);
      cornerMax = Math.max(cornerMax, Math.hypot(p.x, p.y, p.z));
    }
    // Corners are rounded off: nothing reaches the sharp corner distance.
    expect(cornerMax).toBeLessThan(Math.hypot(1, 0.5, 0.3) - 0.05);
  });

  it("uses tier detail, clamps the radius and supports sharp boxes", () => {
    const low = roundedBoxGeometry(1, 1, 1, { tier: "low" });
    const high = roundedBoxGeometry(1, 1, 1, { tier: "high" });
    expect(high.getAttribute("position").count).toBeGreaterThan(low.getAttribute("position").count);
    const huge = roundedBoxGeometry(1, 1, 1, { radius: 5, segments: 2 });
    expect(huge.boundingBox!.max.x).toBeCloseTo(0.5, 6);
    const sharp = roundedBoxGeometry(1, 1, 1, { radius: 0 });
    expect(sharp.boundingBox!.max.x).toBeCloseTo(0.5, 6);
    expect(roundedBoxGeometry(1, 2, 3).boundingBox!.max.z).toBeCloseTo(1.5, 6);
  });
});

describe("extruded pieces", () => {
  it("lie flat from y = 0 to the thickness with cap UVs in 0..1", () => {
    const g = tileGeometry(1, 0.8, 0.1);
    const box = g.boundingBox!;
    expect(box.min.y).toBeCloseTo(0, 6);
    expect(box.max.y).toBeCloseTo(0.1, 6);
    expect(box.max.x).toBeCloseTo(0.5, 5);
    expect(box.max.z).toBeCloseTo(0.4, 5);
    const uv = g.getAttribute("uv");
    for (let i = 0; i < uv.count; i++) {
      expect(uv.getX(i)).toBeGreaterThanOrEqual(-1e-6);
      expect(uv.getX(i)).toBeLessThanOrEqual(1 + 1e-6);
    }
  });

  it("builds 5:7 cards and arbitrary polygons", () => {
    const card = cardGeometry();
    const b = card.boundingBox!;
    expect(b.max.x - b.min.x).toBeCloseTo(0.5, 5);
    expect(b.max.z - b.min.z).toBeCloseTo(0.7, 5);
    expect(b.max.y).toBeCloseTo(0.012, 6);
    const tri = extrudePiece(
      polygonShape([
        [0, 0],
        [1, 0],
        [0.5, 1],
      ]),
      { thickness: 0.2, bevel: 0, tier: "low" },
    );
    expect(tri.boundingBox!.max.y).toBeCloseTo(0.2, 6);
    expect(() =>
      polygonShape([
        [0, 0],
        [1, 1],
      ]),
    ).toThrow(RangeError);
    const high = extrudePiece(roundedRectShape(1, 1, 0.2), { thickness: 0.1, tier: "high" });
    const low = extrudePiece(roundedRectShape(1, 1, 0.2), { thickness: 0.1, tier: "low" });
    expect(high.getAttribute("position").count).toBeGreaterThan(low.getAttribute("position").count);
    expect(roundedRectShape(1, 1, 0).getPoints().length).toBeGreaterThanOrEqual(4);
  });
});
