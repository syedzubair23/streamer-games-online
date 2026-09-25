/**
 * Tweens and springs (`ctx.tween`, SPEC §9.4, §13.4) driven by the platform loop's clock.
 *
 * - Easings are the SPEC §13.4 token curves (CSS `cubic-bezier` semantics).
 * - Springs integrate at a fixed {@link SPRING_STEP_MS}, so a path never depends on the frame
 *   rate; retargeting a spring keeps its velocity (no visible kink when the camera changes its
 *   mind mid-glide).
 * - A new animation on the same property of the same target takes that property over from any
 *   older one.
 * - Reduced motion: tweens and springs jump straight to their end value (callbacks still run).
 * - Zero allocations per step: animations are plain records with typed-array state, stepped with
 *   index loops and compacted in place. Allocation happens only when an animation starts.
 *
 * Time only advances through {@link TweenEngine.step}, which the loop calls once per rendered
 * frame (or a scenario calls with fixed steps before a frozen screenshot).
 *
 * @module
 */
import { resolveSpring, SPRING_REST, SPRING_STEP_MS, SPRINGS } from "./springs.ts";
import type {
  EasingName,
  SpringConfig,
  SpringName,
  SpringPresets,
  TweenApi,
  TweenHandle,
} from "./types.ts";

/** The SPEC §13.4 easing curves as cubic-bezier control points. */
export const EASING_CURVES: Readonly<
  Record<EasingName, readonly [number, number, number, number]>
> = Object.freeze({
  outSoft: Object.freeze([0.22, 1, 0.36, 1] as const),
  inSoft: Object.freeze([0.55, 0, 0.78, 0.4] as const),
  inout: Object.freeze([0.65, 0, 0.35, 1] as const),
  back: Object.freeze([0.34, 1.56, 0.64, 1] as const),
  linear: Object.freeze([0, 0, 1, 1] as const),
});

/** The SPEC §13.4 reference durations (ms) of each easing (`inout` spans 400–700 ms). */
export const EASING_DURATIONS_MS: Readonly<Record<EasingName, number>> = Object.freeze({
  outSoft: 240,
  inSoft: 160,
  inout: 550,
  back: 320,
  linear: 240,
});

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
    // Newton did not converge (flat slope): bisect.
    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < 48; i++) {
      const v = sampleX(t);
      if (Math.abs(v - x) < 1e-7) break;
      if (v < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return sampleY(t);
  };
}

const LINEAR = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : x);
const EASING_FNS: Readonly<Record<EasingName, (x: number) => number>> = Object.freeze({
  outSoft: cubicBezier(...EASING_CURVES.outSoft),
  inSoft: cubicBezier(...EASING_CURVES.inSoft),
  inout: cubicBezier(...EASING_CURVES.inout),
  back: cubicBezier(...EASING_CURVES.back),
  linear: LINEAR,
});

/** The easing function of a token easing name. */
export function easing(name: EasingName): (x: number) => number {
  const fn = EASING_FNS[name] as ((x: number) => number) | undefined;
  if (fn === undefined) throw new RangeError(`unknown easing "${String(name)}"`);
  return fn;
}

/** Longest frame a single step integrates (ms): a stalled tab resumes smoothly, not in a jump. */
export const MAX_STEP_MS = 100;

interface Anim {
  target: Record<string, unknown>;
  keys: readonly string[];
  from: Float64Array;
  to: Float64Array;
  vel: Float64Array;
  /** 1 while this animation still owns the key (a newer one may take it over). */
  live: Uint8Array;
  liveCount: number;
  spring: SpringConfig | null;
  ease: (x: number) => number;
  durationMs: number;
  delayMs: number;
  elapsed: number;
  acc: number;
  started: boolean;
  done: boolean;
  onUpdate: (() => void) | undefined;
  onComplete: (() => void) | undefined;
  resolve: () => void;
}

/** The tween/spring engine: the {@link TweenApi} plus the clock the loop drives. */
export interface TweenEngine extends TweenApi {
  /** Advances every animation by `dtMs` (clamped to {@link MAX_STEP_MS}). */
  step(dtMs: number): void;
  /** Running animations (the loop keeps rendering while this is above zero). */
  readonly active: number;
  /** Jumps every animation to its end value, firing completions. */
  finishAll(): void;
  /** Steps with a fixed 60 Hz clock until nothing runs (or `maxMs`); returns the ms stepped. */
  settle(maxMs?: number): number;
}

/** Options of {@link createTweens}. */
export interface TweenEngineOptions {
  /** Reduced motion: animations jump to their end value. */
  reducedMotion?: boolean;
  /** Spring presets (default {@link SPRINGS}). */
  springs?: SpringPresets;
  /** Called whenever an animation starts (the loop invalidates so the first frame renders). */
  onStart?: () => void;
}

function readNumber(target: Record<string, unknown>, key: string): number {
  const v = target[key];
  if (typeof v !== "number" || Number.isNaN(v))
    throw new TypeError(`tween: property "${key}" is not a number`);
  return v;
}

/** Creates a tween/spring engine. */
export function createTweens(opts: TweenEngineOptions = {}): TweenEngine {
  const reduced = opts.reducedMotion === true;
  const presets = opts.springs ?? SPRINGS;
  const anims: Anim[] = [];
  // Imported bindings are read once: hot loops touch only locals (a bundler-less module
  // namespace read of a double would box it on every access).
  const STEP_MS = SPRING_STEP_MS;
  const REST = SPRING_REST;
  const STEP_S = STEP_MS / 1000;

  const finish = (a: Anim, complete: boolean): void => {
    if (a.done) return;
    a.done = true;
    if (complete) a.onComplete?.();
    a.resolve();
  };

  /** Hands the properties of `a` over from older animations on the same target. */
  const takeOver = (a: Anim): void => {
    for (let i = 0; i < anims.length; i++) {
      const o = anims[i] as Anim;
      if (o.done || o.target !== a.target) continue;
      for (let k = 0; k < o.keys.length; k++) {
        if (o.live[k] === 0) continue;
        const idx = a.keys.indexOf(o.keys[k] as string);
        if (idx < 0) continue;
        o.live[k] = 0;
        o.liveCount--;
        // Carry the velocity of a spring into a spring that retargets it.
        if (a.spring !== null && o.spring !== null) a.vel[idx] = o.vel[k] as number;
      }
      if (o.liveCount <= 0) finish(o, false);
    }
  };

  const write = (a: Anim, t: number): void => {
    for (let k = 0; k < a.keys.length; k++) {
      if (a.live[k] === 0) continue;
      const f = a.from[k] as number;
      a.target[a.keys[k] as string] = f + ((a.to[k] as number) - f) * t;
    }
  };

  const start = (
    target: object,
    to: Record<string, number | undefined>,
    spring: SpringConfig | null,
    o: {
      durationMs?: number;
      easing?: EasingName;
      delayMs?: number;
      onUpdate?: (() => void) | undefined;
      onComplete?: (() => void) | undefined;
    },
  ): TweenHandle => {
    const t = target as Record<string, unknown>;
    const keys = Object.keys(to).filter((k) => to[k] !== undefined);
    const n = keys.length;
    const a: Anim = {
      target: t,
      keys,
      from: new Float64Array(n),
      to: new Float64Array(n),
      vel: new Float64Array(n),
      live: new Uint8Array(n).fill(1),
      liveCount: n,
      spring,
      ease: easing(o.easing ?? "outSoft"),
      durationMs: Math.max(0, o.durationMs ?? 0),
      delayMs: Math.max(0, o.delayMs ?? 0),
      elapsed: 0,
      acc: 0,
      started: false,
      done: false,
      onUpdate: o.onUpdate,
      onComplete: o.onComplete,
      resolve: () => undefined,
    };
    for (let k = 0; k < n; k++) {
      const key = keys[k] as string;
      const goal = to[key] as number;
      if (typeof goal !== "number" || Number.isNaN(goal))
        throw new TypeError(`tween: target value for "${key}" is not a number`);
      a.from[k] = readNumber(t, key);
      a.to[k] = goal;
    }
    const finished = new Promise<void>((resolve) => {
      a.resolve = resolve;
    });
    const handle: TweenHandle = {
      cancel: () => finish(a, false),
      finished,
    };
    takeOver(a);
    if (n === 0 || reduced) {
      write(a, 1);
      if (n > 0) a.onUpdate?.();
      finish(a, true);
      return handle;
    }
    anims.push(a);
    opts.onStart?.();
    return handle;
  };

  const stepAnim = (a: Anim, dt: number): void => {
    if (a.liveCount <= 0) {
      finish(a, false);
      return;
    }
    if (a.spring !== null) {
      a.acc += dt;
      // Integrated inline (semi-implicit Euler, as `stepSpring`): calls with double arguments
      // would box them, and this runs for every spring on every frame.
      const cfg = a.spring;
      const h = STEP_S;
      const k = cfg.stiffness;
      const c = cfg.damping;
      const invMass = 1 / (cfg.mass ?? 1);
      const n = a.keys.length;
      // The epsilon absorbs float drift in the accumulator (4 × step must be 4 substeps).
      while (a.acc >= STEP_MS - 1e-9) {
        a.acc -= STEP_MS;
        for (let i = 0; i < n; i++) {
          if (a.live[i] === 0) continue;
          const x = a.from[i] as number;
          const v =
            (a.vel[i] as number) +
            (-k * (x - (a.to[i] as number)) - c * (a.vel[i] as number)) * invMass * h;
          a.vel[i] = v;
          a.from[i] = x + v * h;
        }
      }
      let rest = true;
      for (let i = 0; i < n && rest; i++) {
        if (a.live[i] === 0) continue;
        const goal = a.to[i] as number;
        const eps = REST * (Math.abs(goal) > 1 ? Math.abs(goal) : 1);
        rest = Math.abs((a.from[i] as number) - goal) < eps && Math.abs(a.vel[i] as number) < eps;
      }
      if (rest) for (let i = 0; i < n; i++) a.from[i] = a.to[i] as number;
      for (let i = 0; i < n; i++)
        if (a.live[i] === 1) a.target[a.keys[i] as string] = a.from[i] as number;
      a.onUpdate?.();
      if (rest) finish(a, true);
      return;
    }
    a.elapsed += dt;
    if (a.elapsed < a.delayMs) return;
    if (!a.started) {
      a.started = true;
      // Tweens start from the value at the moment they begin (after any delay).
      for (let k = 0; k < a.keys.length; k++)
        if (a.live[k] === 1) a.from[k] = readNumber(a.target, a.keys[k] as string);
    }
    const p = a.durationMs <= 0 ? 1 : Math.min(1, (a.elapsed - a.delayMs) / a.durationMs);
    write(a, p >= 1 ? 1 : a.ease(p));
    a.onUpdate?.();
    if (p >= 1) finish(a, true);
  };

  const compact = (): void => {
    let j = 0;
    for (let i = 0; i < anims.length; i++) {
      const a = anims[i] as Anim;
      if (!a.done) anims[j++] = a;
    }
    anims.length = j;
  };

  const engine: TweenEngine = {
    to(target, to, o) {
      return start(target, to as Record<string, number | undefined>, null, o);
    },
    spring(target, to, spring: SpringName | SpringConfig, o) {
      return start(
        target,
        to as Record<string, number | undefined>,
        resolveSpring(spring, presets),
        {
          onUpdate: o?.onUpdate,
          onComplete: o?.onComplete,
        },
      );
    },
    cancelAll(target) {
      for (let i = 0; i < anims.length; i++) {
        const a = anims[i] as Anim;
        if (a.target === target) finish(a, false);
      }
      compact();
    },
    step(dtMs) {
      const dt = Math.min(MAX_STEP_MS, Math.max(0, dtMs));
      // Animations started by callbacks during this step begin on the next one.
      const n = anims.length;
      for (let i = 0; i < n; i++) {
        const a = anims[i] as Anim;
        if (!a.done) stepAnim(a, dt);
      }
      compact();
    },
    get active() {
      let n = 0;
      for (let i = 0; i < anims.length; i++) if (!(anims[i] as Anim).done) n++;
      return n;
    },
    finishAll() {
      // Completion callbacks may start new animations; finish those too (bounded).
      for (let guard = 0; guard < 16 && anims.length > 0; guard++) {
        const batch = anims.splice(0, anims.length);
        for (const a of batch) {
          if (a.done) continue;
          write(a, 1);
          if (a.spring !== null)
            for (let k = 0; k < a.keys.length; k++)
              if (a.live[k] === 1) a.from[k] = a.to[k] as number;
          a.onUpdate?.();
          finish(a, true);
        }
      }
    },
    settle(maxMs = 10_000) {
      const step = 1000 / 60;
      let t = 0;
      while (engine.active > 0 && t < maxMs) {
        engine.step(step);
        t += step;
      }
      return t;
    },
  };
  return engine;
}
