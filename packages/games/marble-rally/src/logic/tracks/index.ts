/**
 * The shipped Marble Rally tracks (ROADMAP M9-00b, docs/specs/marble-rally.md "Content"):
 * `pencil-drop`, `cup-cascade` and `book-stack-switchback`, authored as JSON segment lists that
 * drive both the solver and the Stage's visual pieces.
 *
 * ```ts
 * const course = getCourse("cup-cascade");       // compiled once, cached
 * const [x, y] = [course.slots[0], course.slots[1]]; // first start slot (fixed units)
 * const p = trackProgress(course, x, y, 0);         // race progress 0–10000 (R4)
 * ```
 *
 * The JSON files sit next to this module, inside `logic/`, because the race logic compiles
 * them on the server and `logic/**` may only import its own game's logic (SPEC §9.2).
 *
 * @module
 */
import { TrackError } from "../physics/index.ts";
import bookStackSwitchback from "./book-stack-switchback.json" with { type: "json" };
import { compileCourse, type Course } from "./course.ts";
import cupCascade from "./cup-cascade.json" with { type: "json" };
import pencilDrop from "./pencil-drop.json" with { type: "json" };
import { TRACK_IDS, type TrackDef, type TrackId } from "./types.ts";

export * from "./types.ts";
export * from "./tuning.ts";
export {
  compileCourse,
  GATES_PER_TRACK,
  PROGRESS_MAX,
  PROGRESS_WINDOW,
  trackProgress,
  traySlots,
  TRAY_GAP_UNITS,
  type Course,
} from "./course.ts";

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function tuples(v: unknown, len: number, label: string): void {
  if (!Array.isArray(v)) throw new TrackError(`${label} must be an array`);
  v.forEach((t, i) => {
    if (!Array.isArray(t) || t.length !== len || t.some((x) => typeof x !== "number"))
      throw new TrackError(`${label}[${i}] must be ${len} numbers`);
  });
}

function tuple(v: unknown, len: number, label: string): void {
  if (!Array.isArray(v) || v.length !== len || v.some((x) => typeof x !== "number"))
    throw new TrackError(`${label} must be ${len} numbers`);
}

/**
 * Checks that `json` has the shape of a {@link TrackDef} (field types and tuple lengths) and
 * returns it typed. Geometry, gates, tray and visuals coverage are checked by `compileCourse`.
 * @throws TrackError naming the first malformed field.
 */
export function parseTrackDef(json: unknown): TrackDef {
  if (!isObj(json)) throw new TrackError("a track must be an object");
  const { id, name, blurb, start, segments, pegs, arcs, zones, centerline, visuals } = json;
  if (typeof id !== "string" || !(TRACK_IDS as readonly string[]).includes(id))
    throw new TrackError(`unknown track id ${JSON.stringify(id)}`);
  if (typeof name !== "string" || typeof blurb !== "string")
    throw new TrackError(`${id}: name and blurb must be strings`);
  if (!isObj(start)) throw new TrackError(`${id}: start must be an object`);
  tuple(start.gate, 4, `${id} start.gate`);
  if (typeof start.top !== "number") throw new TrackError(`${id}: start.top must be a number`);
  tuples(segments, 5, `${id} segments`);
  if (pegs !== undefined) tuples(pegs, 3, `${id} pegs`);
  if (arcs !== undefined) tuples(arcs, 8, `${id} arcs`);
  if (!isObj(zones)) throw new TrackError(`${id}: zones must be an object`);
  if (zones.boost !== undefined) tuples(zones.boost, 6, `${id} zones.boost`);
  if (zones.funnel !== undefined) tuples(zones.funnel, 5, `${id} zones.funnel`);
  tuples(zones.gates, 4, `${id} zones.gates`);
  tuple(zones.finish, 4, `${id} zones.finish`);
  tuples(centerline, 2, `${id} centerline`);
  if (!isObj(visuals)) throw new TrackError(`${id}: visuals must be an object`);
  if (!Array.isArray(visuals.pieces) || !visuals.pieces.every(isObj))
    throw new TrackError(`${id}: visuals.pieces must be objects`);
  const kinds = ["pencil", "ruler", "book", "cup", "deflector", "frame", "dowel"];
  const srcs = ["segments", "funnel", "arcs", "pegs"];
  for (const p of visuals.pieces as Record<string, unknown>[])
    if (
      !kinds.includes(p.kind as string) ||
      !srcs.includes(p.src as string) ||
      typeof p.index !== "number" ||
      typeof p.variant !== "number"
    )
      throw new TrackError(`${id}: bad piece ${JSON.stringify(p)}`);
  const train = visuals.train;
  if (!isObj(train) || typeof train.periodSec !== "number")
    throw new TrackError(`${id}: visuals.train must have a periodSec`);
  tuple(train.rail, 4, `${id} visuals.train.rail`);
  tuple(visuals.flag, 2, `${id} visuals.flag`);
  if (!Array.isArray(visuals.trapdoors) || visuals.trapdoors.some((t) => typeof t !== "number"))
    throw new TrackError(`${id}: visuals.trapdoors must be numbers`);
  const decorKinds = ["eraser", "sharpener", "paperclip", "sticky-note", "crayon"];
  if (
    !Array.isArray(visuals.decor) ||
    !visuals.decor.every(
      (d) =>
        isObj(d) &&
        decorKinds.includes(d.kind as string) &&
        typeof d.x === "number" &&
        typeof d.y === "number" &&
        typeof d.rot === "number",
    )
  )
    throw new TrackError(`${id}: bad visuals.decor`);
  return json as unknown as TrackDef;
}

/** The authored tracks by id, shape-checked at load. */
export const TRACKS: Readonly<Record<TrackId, TrackDef>> = {
  "pencil-drop": parseTrackDef(pencilDrop),
  "cup-cascade": parseTrackDef(cupCascade),
  "book-stack-switchback": parseTrackDef(bookStackSwitchback),
};

const courses = new Map<TrackId, Course>();

/**
 * The compiled course for a shipped track, compiled on first use and cached (compiling builds
 * the static broadphase grid, so a room reuses one course for every race on that track).
 */
export function getCourse(id: TrackId): Course {
  let c = courses.get(id);
  if (c === undefined) {
    c = compileCourse(TRACKS[id]);
    courses.set(id, c);
  }
  return c;
}

/** True when `v` is a shipped track id. */
export function isTrackId(v: unknown): v is TrackId {
  return typeof v === "string" && (TRACK_IDS as readonly string[]).includes(v);
}
