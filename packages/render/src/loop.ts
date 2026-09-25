/**
 * The one platform-owned render loop (SPEC §10, research 04 §5). Games never call
 * `requestAnimationFrame`; they get {@link LoopApi} (`invalidate`, `beginAnim`) through
 * `ctx.loop`, and tweens/particles register as {@link LoopParticipant}s.
 *
 * - **On demand:** a still board renders **0 frames per second** with ambient off. A frame is
 *   scheduled only by `invalidate()`, an open `beginAnim()`, a busy participant, continuous mode
 *   (real-time games) or ambient life.
 * - **Ambient cap:** ambient life alone renders at the tier's ambient rate (30 fps on low/mid,
 *   60 on high); anything else animating renders at the display rate.
 * - **Tab aware:** when the document is hidden the loop cancels its frame and calls the
 *   `onHidden` hooks (the shell suspends audio and tells the server `bg`); on return it renders
 *   a fresh frame and calls `onVisible`.
 * - **Frame times** of consecutively rendered frames (never idle gaps) go to `onFrameTime`
 *   (dynamic resolution, the perf HUD).
 * - Exactly one frame is ever scheduled; invalidations during a frame mark it dirty.
 * - Zero allocations per frame.
 *
 * @module
 */
import type { LoopApi } from "./types.ts";

/** Something the loop advances each rendered frame (tweens, particles, the camera rig). */
export interface LoopParticipant {
  /** Advances by `dtMs` before the frame renders. */
  update?(dtMs: number): void;
  /** While this returns true the loop keeps rendering every frame. */
  busy?(): boolean;
}

/** The document fields the loop uses (a real `Document` satisfies it). */
export interface VisibilitySource {
  readonly hidden: boolean;
  addEventListener(type: "visibilitychange", cb: () => void): void;
  removeEventListener(type: "visibilitychange", cb: () => void): void;
}

/** Options of {@link createLoop}. */
export interface LoopOptions {
  /** Renders one frame (after participants have been updated). */
  render: (dtMs: number) => void;
  /** Frame scheduler (default `requestAnimationFrame`). */
  schedule?: (cb: (now: number) => void) => number;
  /** Cancels a scheduled frame (default `cancelAnimationFrame`). */
  unschedule?: (id: number) => void;
  /** Visibility source (default `document` when there is one). */
  visibility?: VisibilitySource | null;
  /** Ambient life on (host/OBS view default) or off (still board: 0 fps). */
  ambient?: boolean;
  /** Ambient frame rate (the tier's `ambientFps`). */
  ambientFps?: number;
  /** Start paused: invalidations only mark the frame pending until {@link RenderLoop.start}. */
  paused?: boolean;
  /** Receives the frame time of consecutively rendered frames (not idle gaps). */
  onFrameTime?: (frameMs: number, now: number) => void;
  /** Called when the tab becomes hidden. */
  onHidden?: () => void;
  /** Called when the tab becomes visible again. */
  onVisible?: () => void;
}

/** The loop: {@link LoopApi} for games plus the shell's controls. */
export interface RenderLoop extends LoopApi {
  /** Registers a participant; returns its remover. */
  add(p: LoopParticipant): () => void;
  /** Turns ambient life on or off (optionally with a new rate). */
  setAmbient(on: boolean, fps?: number): void;
  readonly ambient: boolean;
  /** Continuous mode for real-time games: render every display frame while on. */
  setContinuous(on: boolean): void;
  /** Starts a paused loop (renders the pending frame, if any). */
  start(): void;
  /** Pauses: the scheduled frame is cancelled and invalidations are held until `start()`. */
  pause(): void;
  /** Advances participants by `dtMs` and renders one frame synchronously (scenarios, tests). */
  renderNow(dtMs?: number): void;
  /** Advances participants without rendering. */
  advance(dtMs: number): void;
  /** Frames rendered so far. */
  readonly frames: number;
  /** Whether a frame is currently scheduled. */
  readonly scheduled: boolean;
  /** Whether the loop is paused. */
  readonly paused: boolean;
  /** Stops for good and detaches listeners. */
  dispose(): void;
}

/** Longest frame delta handed to participants (ms). */
export const MAX_FRAME_DT_MS = 100;
/** The delta assumed for the first frame after an idle period (ms). */
export const FIRST_FRAME_DT_MS = 1000 / 60;
/**
 * Ambient frames are due when this close to their interval (ms): rAF timestamps jitter, and a
 * strict `>=` would drop a 30 fps cap to 20 fps on a 60 Hz display.
 */
export const AMBIENT_SLACK_MS = 2;

/** Creates the render loop. */
export function createLoop(o: LoopOptions): RenderLoop {
  const g = globalThis as {
    requestAnimationFrame?: (cb: (now: number) => void) => number;
    cancelAnimationFrame?: (id: number) => void;
    document?: VisibilitySource;
  };
  const schedule =
    o.schedule ??
    ((cb: (now: number) => void): number => {
      if (g.requestAnimationFrame === undefined)
        throw new Error("render loop: no requestAnimationFrame; pass `schedule`");
      return g.requestAnimationFrame(cb);
    });
  const unschedule = o.unschedule ?? ((id: number) => g.cancelAnimationFrame?.(id));
  const vis: VisibilitySource | null =
    o.visibility === undefined ? (g.document ?? null) : o.visibility;

  const participants: LoopParticipant[] = [];
  let frameId: number | null = null;
  let ambient = o.ambient === true;
  let ambientFps = o.ambientFps ?? 30;
  let continuous = false;
  let anims = 0;
  let paused = o.paused === true;
  let pending = false;
  let dirty = false;
  let ticking = false;
  let disposed = false;
  let frames = 0;
  /** Timestamp of the last rendered frame while the loop has run without a gap. */
  let lastRender: number | null = null;
  /** Timestamp of the last ambient frame. */
  let lastAmbient = Number.NEGATIVE_INFINITY;
  /** The previous tick rendered (so this frame's delta is a real frame time). */
  let prevTickRendered = false;
  /** Set by `invalidate()` so the scheduled tick renders even when nothing else is due. */
  let pendingInvalidate = false;

  const hidden = (): boolean => vis?.hidden === true;

  const busy = (): boolean => {
    if (anims > 0 || continuous) return true;
    for (let i = 0; i < participants.length; i++) {
      const p = participants[i] as LoopParticipant;
      if (p.busy?.() === true) return true;
    }
    return false;
  };

  const kick = (): void => {
    if (frameId !== null || disposed || hidden()) return;
    if (paused) {
      pending = true;
      return;
    }
    frameId = schedule(tick);
  };

  const advance = (dt: number): void => {
    for (let i = 0; i < participants.length; i++) participants[i]?.update?.(dt);
  };

  const tick = (now: number): void => {
    frameId = null;
    if (disposed || paused || hidden()) return;
    const isBusy = busy();
    const ambientDue = ambient && now - lastAmbient >= 1000 / ambientFps - AMBIENT_SLACK_MS;
    const render = dirty || isBusy || ambientDue || pendingInvalidate;
    pendingInvalidate = false;
    if (render) {
      ticking = true;
      dirty = false;
      const dt =
        lastRender === null
          ? FIRST_FRAME_DT_MS
          : Math.min(MAX_FRAME_DT_MS, Math.max(0, now - lastRender));
      if (prevTickRendered && lastRender !== null) o.onFrameTime?.(now - lastRender, now);
      lastRender = now;
      if (ambientDue) lastAmbient = now;
      try {
        advance(dt);
        o.render(dt);
        frames++;
      } finally {
        ticking = false;
      }
    }
    prevTickRendered = render;
    // Keep going while anything animates; otherwise go fully idle (0 fps).
    if (!disposed && !paused && (ambient || continuous || dirty || busy() || anims > 0)) {
      frameId = schedule(tick);
    } else {
      lastRender = null;
      prevTickRendered = false;
    }
  };
  const onVisibility = (): void => {
    if (disposed) return;
    if (hidden()) {
      if (frameId !== null) unschedule(frameId);
      frameId = null;
      lastRender = null;
      prevTickRendered = false;
      o.onHidden?.();
    } else {
      o.onVisible?.();
      loop.invalidate();
    }
  };
  vis?.addEventListener("visibilitychange", onVisibility);

  const loop: RenderLoop = {
    invalidate(): void {
      if (disposed) return;
      if (ticking) {
        dirty = true;
        return;
      }
      pendingInvalidate = true;
      kick();
    },
    beginAnim(): () => void {
      anims++;
      loop.invalidate();
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        anims--;
      };
    },
    add(p) {
      participants.push(p);
      return () => {
        const i = participants.indexOf(p);
        if (i >= 0) participants.splice(i, 1);
      };
    },
    setAmbient(on, fps) {
      ambient = on;
      if (fps !== undefined && fps > 0) ambientFps = fps;
      if (on) kick();
    },
    get ambient() {
      return ambient;
    },
    setContinuous(on) {
      continuous = on;
      if (on) kick();
    },
    start() {
      if (!paused || disposed) return;
      paused = false;
      if (pending || ambient || busy()) {
        pending = false;
        pendingInvalidate = true;
        kick();
      }
    },
    pause() {
      if (paused) return;
      paused = true;
      if (frameId !== null) {
        unschedule(frameId);
        frameId = null;
        pending = true;
      }
      lastRender = null;
      prevTickRendered = false;
    },
    renderNow(dtMs = 0) {
      if (disposed) return;
      ticking = true;
      try {
        advance(dtMs);
        o.render(dtMs);
        frames++;
      } finally {
        ticking = false;
      }
      dirty = false;
    },
    advance(dtMs) {
      advance(dtMs);
    },
    get frames() {
      return frames;
    },
    get scheduled() {
      return frameId !== null;
    },
    get paused() {
      return paused;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (frameId !== null) unschedule(frameId);
      frameId = null;
      vis?.removeEventListener("visibilitychange", onVisibility);
      participants.length = 0;
    },
  };
  // Ambient life on from the start keeps the loop running at the ambient rate.
  if (ambient) kick();
  return loop;
}
