/**
 * The authored track format (docs/specs/marble-rally.md "Content"): one JSON file per track
 * holding the solver geometry, the start tray, the progress centreline and the visual pieces the
 * Stage builds from the same geometry. Every value is in **world units** (the world is 4096 ×
 * 8192, y up) and every number is an integer, so the solver compiles it exactly.
 *
 * @module
 */
import type { TrackPhysicsDef } from "../physics/index.ts";

/** The shipped track ids (host option `tracks`). */
export const TRACK_IDS = ["pencil-drop", "cup-cascade", "book-stack-switchback"] as const;
/** A shipped track id. */
export type TrackId = (typeof TRACK_IDS)[number];

/** A centreline vertex `[x, y]` in world units. */
export type PointDef = readonly [number, number];

/**
 * The start tray: marbles wait in hexagonal rows resting on the start gate `[x1, y, x2, y]`
 * (a horizontal line, left to right), between the tray walls. The gate is visual only: during
 * enrolment and the countdown the marbles are not simulated, and at the race start they drop
 * through it. The tray walls are ordinary solid segments of the track.
 */
export interface StartDef {
  /** The start gate line (y1 must equal y2; x1 < x2). */
  gate: readonly [number, number, number, number];
  /** The top of the tray: the highest row centre may not be above this y. */
  top: number;
}

/**
 * The visual piece families of the set (spec "Visual & animation spec"): each solid collider is
 * drawn as one of these. `frame` is the pegboard's own wooden frame (the world walls).
 */
export type PieceKind = "pencil" | "ruler" | "book" | "cup" | "deflector" | "frame" | "dowel";

/** The collider lists a piece can refer to. */
export type PieceSource = "segments" | "funnel" | "arcs" | "pegs";

/** One visual piece: a collider of the physics lists and how the Stage draws it. */
export interface PieceDef {
  kind: PieceKind;
  src: PieceSource;
  /** Index into the `src` list. */
  index: number;
  /**
   * A design variant, 0-based and cosmetic (which pencil paint, book spine or cup print the
   * Stage picks from its token-driven palette). Never a colour.
   */
  variant: number;
}

/** A purely cosmetic prop (no collider), placed in world units, rotation in degrees. */
export interface DecorDef {
  kind: "eraser" | "sharpener" | "paperclip" | "sticky-note" | "crayon";
  x: number;
  y: number;
  rot: number;
}

/** The visual description of a track: every collider mapped to a piece, plus cosmetic props. */
export interface VisualsDef {
  /** Every solid collider appears in exactly one piece (checked by `validateTrack`). */
  pieces: readonly PieceDef[];
  /**
   * The toy-train crossing: a straight rail `[x1, y1, x2, y2]` the train loops along every
   * `periodSec` seconds. Cosmetic: it has no collider and never touches the race.
   */
  train: { rail: readonly [number, number, number, number]; periodSec: number };
  /** Where the finish flag stands `[x, y]` (on the finish line). */
  flag: PointDef;
  /** Gate indices drawn as cardboard trapdoors (R7 elimination gates 1 and 2 → 0 and 1). */
  trapdoors: readonly number[];
  decor: readonly DecorDef[];
}

/**
 * A complete authored track. `segments`, `pegs`, `arcs` and `zones` are the solver geometry
 * (see `TrackPhysicsDef`); the rest drives the race logic and the Stage.
 */
export interface TrackDef extends TrackPhysicsDef {
  id: TrackId;
  /** Display name. */
  name: string;
  /** One line for the host's track picker. */
  blurb: string;
  start: StartDef;
  /**
   * The authored centre polyline from the start gate to the finish line: the race progress
   * metric (R4) is the distance along it. It must start at the start gate, cross every gate
   * once in order and end below the finish line.
   */
  centerline: readonly PointDef[];
  visuals: VisualsDef;
}
