/**
 * @packageDocumentation
 * @sg/render: three.js render kit: renderer, on-demand loop, quality tiers, the only material and
 * procedural texture factories, Cozy Table diorama, FX and ambient modes.
 *
 * M1-06 (this kit): `createRenderer`, `createLoop`, quality tiers and `DynamicResolution`, the
 * boot bench, springs and tweens, disposal and leak checks, picking, the material factories, the
 * procedural textures, lathe / rounded-box / extrude pieces and the perf HUD. The diorama,
 * ambient modes, camera rig and FX build on it (M1-07).
 */

export * from "./types.ts";
export * from "./color.ts";
export * from "./quality.ts";
export * from "./springs.ts";
export * from "./tween.ts";
export * from "./loop.ts";
export * from "./renderer.ts";
export * from "./bench.ts";
export * from "./dispose.ts";
export * from "./picking.ts";
export * from "./perf-hud.ts";
export * from "./materials/index.ts";
export * from "./textures/index.ts";
export * from "./pieces/lathe.ts";
export * from "./pieces/rounded-box.ts";
export * from "./pieces/extrude.ts";
