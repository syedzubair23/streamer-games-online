/**
 * The recipe contract every procedural texture implements, and the default palette (the
 * SPEC §13.2 Golden Hour tokens; the shell passes the active mode's tokens instead).
 *
 * @module
 */
import type { Rng } from "@sg/shared";
import type { RGB } from "../color.ts";
import type { ColorLike, QualityTier, TextureName } from "../types.ts";
import type { Canvas2D, Ctx2D } from "./canvas.ts";

/** Colours the painters use when a caller gives no tint. */
export interface TexturePalette {
  wood: ColorLike;
  felt: ColorLike;
  paper: ColorLike;
  cork: ColorLike;
  wall: ColorLike;
  ink: ColorLike;
  line: ColorLike;
  shadow: ColorLike;
  cream: ColorLike;
  accent: ColorLike;
}

/** SPEC §13.2 Golden Hour (dusk, the default mode) and the SPEC §13.3 fixed tokens. */
export const DEFAULT_PALETTE: Readonly<TexturePalette> = Object.freeze({
  wood: "#B87445",
  felt: "#4F9488",
  paper: "#FBF5EA",
  cork: "#D2A679",
  wall: "#F0D2B6",
  ink: "#3D2A33",
  line: "#F0D3B8",
  shadow: "#7A3F5C",
  cream: "#FFF6E6",
  accent: "#F2705A",
});

/** What a painter receives. */
export interface PaintInput {
  ctx: Ctx2D;
  w: number;
  h: number;
  /** Seeded from the texture name and `seed`: the same inputs paint the same pixels. */
  rng: Rng;
  seed: number;
  /** The tint (or the recipe's palette default) as 8-bit sRGB. */
  tint: RGB;
  /** Whether the caller passed a tint (else `tint` is the recipe's palette default). */
  tinted: boolean;
  variant: string | undefined;
  palette: Readonly<TexturePalette>;
  tier: QualityTier;
  /**
   * Paints (or fetches from the cache) another texture's canvas, e.g. board art over wood or the
   * shared grain tile. `w` defaults to that texture's size for this tier (so the cache is shared).
   */
  source(
    name: TextureName,
    opts?: { w?: number; seed?: number; tint?: ColorLike; variant?: string },
  ): Canvas2D["canvas"];
  /** A temporary canvas (fields before upscaling). */
  scratch(w: number, h: number): Canvas2D;
}

/** A procedural texture recipe. */
export interface TextureRecipe {
  name: Exclude<TextureName, "ramp">;
  /** Default width (px) per tier; callers may ask for another size (clamped per tier). */
  size(tier: QualityTier, variant: string | undefined): number;
  /** Height = round(width × aspect). */
  aspect: number | ((variant: string | undefined) => number);
  /** `srgb` for colour, `none` for data (masks, noise). */
  colorSpace: "srgb" | "none";
  /** Repeating textures tile seamlessly. */
  wrap: "repeat" | "clamp" | ((variant: string | undefined) => "repeat" | "clamp");
  /** The palette colour used when no tint is given. */
  tint(p: Readonly<TexturePalette>): ColorLike;
  paint(input: PaintInput): void;
}
