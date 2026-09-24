/**
 * Tweens and springs for the scenario route's placeholder shell (`ctx.tween`, SPEC §9.4,
 * §13.4), driven by an explicit clock so the route stays deterministic: time only advances when
 * the shell calls {@link MotionEngine.step} (one step per rendered frame, or a fixed-step
 * {@link MotionEngine.settle} before a frozen screenshot).
 *
 * `@sg/render` (M1-06) ships the production tween/spring kit; this module is the route's
 * stand-in until then and follows the same contract: token easings and springs only, reduced
 * motion jumps to the end value, and `cancelAll(target)` stops everything on a target.
 *
 * @module
 */
import type {
  EasingName,
  SpringConfig,
  SpringName,
  SpringPresets,
  TweenApi,
  TweenHandle,
  TweenOptions,
  TweenTargets,
} from "@sg/engine/client";
import { EASINGS } from "./placeholder-theme.ts";

/** A cubic-bezier easing `(x) → y` for control points (x1, y1, x2, y2), like CSS. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number): number => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number): number => ((ay * t + by) * t + cy) * t;
  const slopeX = (t: number): number => (3 * ax * t + 2 * bx) * t + cx;
  return (x: number): number => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const err = sampleX(t) - x;
      if (Math.abs(err) < 1e-7) return sampleY(t);
      const d = slopeX(t);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    // Newton did not converge: bisect.
    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < 40; i++) {
      const v = sampleX(t);
      if (Math.abs(v - x) < 1e-7) break;
      if (v < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return sampleY(t);
  };
}

const EASING_FNS: Readonly<Record<EasingName, (x: number) => number>> = Object.freeze(
  Object.fromEntries(
    (Object.keys(EASINGS) as EasingName[]).map((name) => {
      const [a, b, c, d] = EASINGS[name].bezier;
      return [name, name === "linear" ? (x: number) => x : cubicBezier(a, b, c, d)];
    }),
  ) as Record<EasingName, (x: number) => number>,
);

/** The easing function for a token easing name. */
export function easing(name: EasingName): (x: number) => number {
  return EASING_FNS[name];
}

/** Integration step for springs (ms). Fixed, so results do not depend on the frame rate. */
export const SPRING_STEP_MS = 1000 / 240;
/** A spring is at rest when both its offset and velocity are below this. */
const REST = 1e-4;

interface Anim {
  target: Record<string, unknown>;
  keys: string[];
  /** Advances by `dt` ms; returns true when finished. */
  advance(dt: number): boolean;
  /** Jumps to the end values. */
  finish(): void;
  onUpdate?: () => void;
  onComplete?: () => void;
  resolve: () => void;
  done: boolean;
}

/** The route's tween engine: a {@link TweenApi} plus the clock controls the shell uses. */
export interface MotionEngine extends TweenApi {
  /** Advances every running tween and spring by `dtMs`. */
  step(dtMs: number): void;
  /**
   * Steps with a fixed `stepMs` until nothing is running or `maxMs` has elapsed; returns the
   * simulated milliseconds. Used before a frozen frame so the capture never depends on timing.
   */
  settle(maxMs?: number, stepMs?: number): number;
  /** Finishes every running animation at its end value (reduced motion, teardown). */
  finishAll(): void;
  /** The number of running tweens and springs. */
  readonly active: number;
}

/** Options of {@link createMotion}. */
export interface MotionOptions {
  springs: SpringPresets;
  /** Reduced motion: every tween and spring jumps straight to its end value. */
  reducedMotion: boolean;
  /** Called whenever an animation starts, so the shell's on-demand loop wakes up. */
  onStart?: () => void;
}

function numericKeys<T extends object>(target: T, to: TweenTargets<T>): string[] {
  const rec = target as Record<string, unknown>;
  return Object.keys(to).filter((k) => {
    const goal = (to as Record<string, unknown>)[k];
    if (typeof goal !== "number" || !Number.isFinite(goal)) return false;
    if (typeof rec[k] !== "number") throw new Error(`tween: property "${k}" is not a number`);
    return true;
  });
}

/** Creates a deterministic tween/spring engine. */
export function createMotion(opts: MotionOptions): MotionEngine {
  const running: Anim[] = [];

  const makeHandle = (anim: Anim, finished: Promise<void>): TweenHandle => ({
    cancel(): void {
      if (anim.done) return;
      anim.done = true;
      const i = running.indexOf(anim);
      if (i >= 0) running.splice(i, 1);
      anim.resolve();
    },
    finished,
  });

  const complete = (anim: Anim): void => {
    anim.done = true;
    anim.onUpdate?.();
    anim.onComplete?.();
    anim.resolve();
  };

  const start = (anim: Anim): TweenHandle => {
    const finished = new Promise<void>((resolve) => {
      anim.resolve = resolve;
    });
    const handle = makeHandle(anim, finished);
    if (opts.reducedMotion || anim.keys.length === 0) {
      anim.finish();
      complete(anim);
      return handle;
    }
    // A new tween on the same property replaces the running one (no fighting animations).
    for (const other of [...running]) {
      if (other.target === anim.target && other.keys.some((k) => anim.keys.includes(k))) {
        other.keys = other.keys.filter((k) => !anim.keys.includes(k));
        if (other.keys.length === 0) {
          other.done = true;
          running.splice(running.indexOf(other), 1);
          other.resolve();
        }
      }
    }
    running.push(anim);
    opts.onStart?.();
    return handle;
  };

  const resolveSpring = (spring: SpringName | SpringConfig): Required<SpringConfig> => {
    const cfg = typeof spring === "string" ? opts.springs[spring] : spring;
    if (cfg === undefined) throw new Error(`tween.spring: unknown spring ${String(spring)}`);
    return { stiffness: cfg.stiffness, damping: cfg.damping, mass: cfg.mass ?? 1 };
  };

  const engine: MotionEngine = {
    to<T extends object>(target: T, to: TweenTargets<T>, o: TweenOptions): TweenHandle {
      if (!(o.durationMs >= 0)) throw new Error("tween.to: durationMs must be >= 0");
      const rec = target as Record<string, unknown>;
      const keys = numericKeys(target, to);
      const goal = to as Record<string, number>;
      const ease = easing(o.easing ?? "outSoft");
      const from: Record<string, number> = {};
      let elapsed = -(o.delayMs ?? 0);
      let captured = false;
      const capture = (): void => {
        for (const k of anim.keys) from[k] = rec[k] as number;
        captured = true;
      };
      const anim: Anim = {
        target: rec,
        keys,
        advance(dt: number): boolean {
          elapsed += dt;
          if (elapsed < 0) return false;
          if (!captured) capture();
          const x = o.durationMs === 0 ? 1 : Math.min(1, elapsed / o.durationMs);
          const y = ease(x);
          for (const k of anim.keys) {
            const a = from[k] as number;
            rec[k] = a + ((goal[k] as number) - a) * y;
          }
          if (x >= 1) {
            for (const k of anim.keys) rec[k] = goal[k] as number;
            return true;
          }
          anim.onUpdate?.();
          return false;
        },
        finish(): void {
          for (const k of anim.keys) rec[k] = goal[k] as number;
        },
        onUpdate: o.onUpdate,
        onComplete: o.onComplete,
        resolve: () => undefined,
        done: false,
      };
      return start(anim);
    },

    spring<T extends object>(
      target: T,
      to: TweenTargets<T>,
      spring: SpringName | SpringConfig,
      o?: { onUpdate?: () => void; onComplete?: () => void },
    ): TweenHandle {
      const { stiffness, damping, mass } = resolveSpring(spring);
      const rec = target as Record<string, unknown>;
      const keys = numericKeys(target, to);
      const goal = to as Record<string, number>;
      const velocity: Record<string, number> = {};
      for (const k of keys) velocity[k] = 0;
      let carry = 0;
      const anim: Anim = {
        target: rec,
        keys,
        advance(dt: number): boolean {
          carry += dt;
          let atRest = false;
          while (carry >= SPRING_STEP_MS) {
            carry -= SPRING_STEP_MS;
            const h = SPRING_STEP_MS / 1000;
            atRest = true;
            for (const k of anim.keys) {
              const x = rec[k] as number;
              const g = goal[k] as number;
              let v = velocity[k] ?? 0;
              v += ((-stiffness * (x - g) - damping * v) / mass) * h;
              const nx = x + v * h;
              rec[k] = nx;
              velocity[k] = v;
              if (Math.abs(nx - g) > REST || Math.abs(v) > REST) atRest = false;
            }
            if (atRest) break;
          }
          if (atRest) {
            for (const k of anim.keys) rec[k] = goal[k] as number;
            return true;
          }
          anim.onUpdate?.();
          return false;
        },
        finish(): void {
          for (const k of anim.keys) rec[k] = goal[k] as number;
        },
        onUpdate: o?.onUpdate,
        onComplete: o?.onComplete,
        resolve: () => undefined,
        done: false,
      };
      return start(anim);
    },

    cancelAll(target: object): void {
      for (const anim of [...running]) {
        if (anim.target !== target) continue;
        anim.done = true;
        running.splice(running.indexOf(anim), 1);
        anim.resolve();
      }
    },

    step(dtMs: number): void {
      if (!(dtMs > 0)) return;
      for (const anim of [...running]) {
        if (anim.done) continue;
        if (anim.advance(dtMs)) {
          running.splice(running.indexOf(anim), 1);
          complete(anim);
        }
      }
    },

    settle(maxMs = 10_000, stepMs = 1000 / 60): number {
      let t = 0;
      while (running.length > 0 && t < maxMs) {
        engine.step(stepMs);
        t += stepMs;
      }
      return t;
    },

    finishAll(): void {
      for (const anim of running.splice(0)) {
        anim.finish();
        complete(anim);
      }
    },

    get active(): number {
      return running.length;
    },
  };
  return engine;
}
