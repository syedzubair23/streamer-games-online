/**
 * The one shared `AudioContext` (research 03 §8.1): created lazily on the first user gesture (so
 * browsers never log an autoplay warning), resumed on later gestures, and **suspended while the
 * tab is hidden** (SPEC §10: when the tab is hidden the loop stops and the AudioContext
 * suspends). It resumes when the tab is visible again, but only if sound was unlocked before.
 *
 * @module
 */

/** The subset of `Document` the host listens to (injectable for tests). */
export interface DocumentLike {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: string, fn: () => void, opts?: AddEventListenerOptions): void;
  removeEventListener(type: string, fn: () => void, opts?: EventListenerOptions): void;
}

/** Options of {@link createAudioContextHost}. */
export interface AudioContextHostOptions {
  /** Makes the context (default: `new AudioContext({ latencyHint: "interactive" })`). */
  create?: () => AudioContext;
  /** The document whose visibility and gestures drive the context (default: `document`). */
  doc?: DocumentLike;
  /** Called once, right after the context is created (e.g. to build the buses). */
  onCreate?: (ctx: AudioContext) => void;
}

/** Owner of the single shared `AudioContext`. */
export interface AudioContextHost {
  /** The context, or `null` before the first {@link AudioContextHost.unlock}. */
  readonly ctx: AudioContext | null;
  /** Whether sound is audible now: unlocked, visible and `running`. */
  readonly running: boolean;
  /**
   * Creates (first call) and resumes the context. Call it from a user gesture handler; while the
   * tab is hidden it only records the unlock and resumes on the next visible.
   */
  unlock(): Promise<void>;
  /**
   * Unlocks on the first `pointerdown`/`keydown`/`touchend` on the document, then keeps
   * resuming on later gestures (iOS may interrupt the context). Returns a remover.
   */
  unlockOnGesture(): () => void;
  /** Stops listening and closes the context. */
  dispose(): Promise<void>;
}

const GESTURES = ["pointerdown", "keydown", "touchend"] as const;

/** Creates the {@link AudioContextHost}; it starts listening for visibility changes at once. */
export function createAudioContextHost(o: AudioContextHostOptions = {}): AudioContextHost {
  const doc: DocumentLike = o.doc ?? document;
  const create = o.create ?? (() => new AudioContext({ latencyHint: "interactive" }));
  let ctx: AudioContext | null = null;
  let unlocked = false;
  let disposed = false;
  const removers = new Set<() => void>();
  const hidden = (): boolean => doc.visibilityState === "hidden";

  const resume = async (): Promise<void> => {
    if (ctx && ctx.state !== "running" && ctx.state !== "closed") await ctx.resume();
  };
  const onVisibility = (): void => {
    if (!ctx || ctx.state === "closed") return;
    if (hidden()) void ctx.suspend();
    else if (unlocked) void resume();
  };
  doc.addEventListener("visibilitychange", onVisibility);

  const host: AudioContextHost = {
    get ctx() {
      return ctx;
    },
    get running() {
      return unlocked && !hidden() && ctx?.state === "running";
    },
    async unlock() {
      if (disposed) return;
      unlocked = true;
      if (!ctx) {
        ctx = create();
        o.onCreate?.(ctx);
      }
      if (hidden()) await ctx.suspend();
      else await resume();
    },
    unlockOnGesture() {
      const onGesture = (): void => void host.unlock();
      for (const g of GESTURES) doc.addEventListener(g, onGesture, { passive: true });
      const remove = (): void => {
        for (const g of GESTURES) doc.removeEventListener(g, onGesture);
        removers.delete(remove);
      };
      removers.add(remove);
      return remove;
    },
    async dispose() {
      disposed = true;
      doc.removeEventListener("visibilitychange", onVisibility);
      for (const remove of [...removers]) remove();
      const c = ctx;
      ctx = null;
      if (c && c.state !== "closed") await c.close();
    },
  };
  return host;
}
