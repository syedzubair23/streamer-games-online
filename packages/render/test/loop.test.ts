/**
 * The on-demand render loop against a manual frame scheduler (SPEC §10: 0 fps when still,
 * ambient cap, tab awareness, one scheduled frame, frame times only for consecutive frames).
 * The real-browser "0 frames/s idle" check is `test/browser/render-kit.spec.ts`.
 */
import { describe, expect, it, vi } from "vitest";
import {
  AMBIENT_SLACK_MS,
  createLoop,
  FIRST_FRAME_DT_MS,
  type LoopOptions,
  type VisibilitySource,
} from "../src/loop.ts";

/** A manual rAF: `frame()` runs the pending callbacks at the next 60 Hz timestamp. */
function scheduler(hz = 60) {
  let next = 1;
  let now = 0;
  const pending = new Map<number, (t: number) => void>();
  return {
    schedule: (cb: (t: number) => void) => {
      const id = next++;
      pending.set(id, cb);
      return id;
    },
    unschedule: (id: number) => void pending.delete(id),
    get pending() {
      return pending.size;
    },
    get now() {
      return now;
    },
    /** Advances one display frame, running whatever was scheduled. */
    frame(): void {
      now += 1000 / hz;
      const cbs = [...pending.values()];
      pending.clear();
      for (const cb of cbs) cb(now);
    },
    frames(n: number): void {
      for (let i = 0; i < n; i++) this.frame();
    },
    idle(ms: number): void {
      now += ms;
    },
  };
}

class FakeVisibility implements VisibilitySource {
  hidden = false;
  private cbs = new Set<() => void>();
  addEventListener(_t: "visibilitychange", cb: () => void) {
    this.cbs.add(cb);
  }
  removeEventListener(_t: "visibilitychange", cb: () => void) {
    this.cbs.delete(cb);
  }
  set(hidden: boolean) {
    this.hidden = hidden;
    for (const cb of this.cbs) cb();
  }
  get listeners() {
    return this.cbs.size;
  }
}

function setup(extra: Partial<LoopOptions> = {}) {
  const s = scheduler();
  const vis = new FakeVisibility();
  const render = vi.fn();
  const loop = createLoop({
    render,
    schedule: s.schedule,
    unschedule: s.unschedule,
    visibility: vis,
    ...extra,
  });
  return { s, vis, render, loop };
}

describe("render loop", () => {
  it("renders nothing when idle (0 frames per second with ambient off)", () => {
    const { s, render, loop } = setup();
    s.frames(120);
    expect(render).not.toHaveBeenCalled();
    expect(loop.frames).toBe(0);
    expect(loop.scheduled).toBe(false);
  });

  it("invalidate() renders exactly one frame, then goes idle", () => {
    const { s, render, loop } = setup();
    loop.invalidate();
    loop.invalidate();
    loop.invalidate();
    expect(s.pending).toBe(1);
    s.frames(60);
    expect(render).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledWith(FIRST_FRAME_DT_MS);
    expect(loop.scheduled).toBe(false);
  });

  it("an open beginAnim() renders every frame until it ends", () => {
    const { s, render, loop } = setup();
    const end = loop.beginAnim();
    s.frames(30);
    expect(render).toHaveBeenCalledTimes(30);
    end();
    end(); // idempotent
    s.frames(30);
    // The frame after end() may still be the one already scheduled; then it stops.
    expect(render.mock.calls.length).toBeLessThanOrEqual(31);
    const n = render.mock.calls.length;
    s.frames(60);
    expect(render.mock.calls.length).toBe(n);
  });

  it("participants update before each frame and keep it busy while they want", () => {
    const { s, render, loop } = setup();
    let remaining = 5;
    const order: string[] = [];
    render.mockImplementation(() => order.push("render"));
    const remove = loop.add({
      update: (dt) => {
        order.push(`update:${Math.round(dt)}`);
        remaining--;
      },
      busy: () => remaining > 0,
    });
    loop.invalidate();
    s.frames(20);
    expect(render).toHaveBeenCalledTimes(5);
    expect(order.slice(0, 4)).toEqual(["update:17", "render", "update:17", "render"]);
    remove();
    remove();
    loop.invalidate();
    s.frames(3);
    expect(render).toHaveBeenCalledTimes(6);
  });

  it("caps ambient-only rendering at the ambient frame rate", () => {
    const { s, render } = setup({ ambient: true, ambientFps: 30 });
    // Ambient on at construction starts the loop at the ambient rate.
    s.frames(60);
    expect(render.mock.calls.length).toBeGreaterThanOrEqual(29);
    expect(render.mock.calls.length).toBeLessThanOrEqual(31);
    const { s: s2, render: r2, loop: l2 } = setup({ ambientFps: 30 });
    l2.setAmbient(true);
    expect(l2.ambient).toBe(true);
    s2.frames(120); // 2 s at 60 Hz
    expect(r2.mock.calls.length).toBeGreaterThanOrEqual(58);
    expect(r2.mock.calls.length).toBeLessThanOrEqual(61);
    l2.setAmbient(false);
    s2.frames(2);
    const n = r2.mock.calls.length;
    s2.frames(60);
    expect(r2.mock.calls.length).toBe(n);
  });

  it("ambient at 60 fps renders every display frame; animation overrides the cap", () => {
    const { s, render, loop } = setup({ ambientFps: 60 });
    loop.setAmbient(true);
    s.frames(60);
    expect(render.mock.calls.length).toBeGreaterThanOrEqual(59);
    const { s: s2, render: r2, loop: l2 } = setup({ ambientFps: 30 });
    l2.setAmbient(true);
    const end = l2.beginAnim();
    s2.frames(60);
    expect(r2).toHaveBeenCalledTimes(60);
    end();
    void AMBIENT_SLACK_MS;
  });

  it("continuous mode renders every frame until switched off", () => {
    const { s, render, loop } = setup();
    loop.setContinuous(true);
    s.frames(10);
    expect(render).toHaveBeenCalledTimes(10);
    loop.setContinuous(false);
    s.frames(10);
    expect(render.mock.calls.length).toBeLessThanOrEqual(11);
  });

  it("an invalidate during a frame schedules exactly one more frame", () => {
    const { s, render, loop } = setup();
    let once = true;
    render.mockImplementation(() => {
      if (once) {
        once = false;
        loop.invalidate();
        loop.invalidate();
      }
    });
    loop.invalidate();
    s.frames(10);
    expect(render).toHaveBeenCalledTimes(2);
  });

  it("stops when the tab is hidden and resumes with a fresh frame", () => {
    const onHidden = vi.fn();
    const onVisible = vi.fn();
    const { s, vis, render, loop } = setup({ onHidden, onVisible });
    const end = loop.beginAnim();
    s.frames(5);
    vis.set(true);
    expect(onHidden).toHaveBeenCalledTimes(1);
    expect(loop.scheduled).toBe(false);
    s.frames(30);
    expect(render).toHaveBeenCalledTimes(5);
    loop.invalidate(); // ignored while hidden
    expect(loop.scheduled).toBe(false);
    vis.set(false);
    expect(onVisible).toHaveBeenCalledTimes(1);
    s.frames(3);
    expect(render).toHaveBeenCalledTimes(8);
    // The first frame after returning uses the default delta (no giant catch-up step).
    expect(render.mock.calls[5]?.[0]).toBe(FIRST_FRAME_DT_MS);
    end();
  });

  it("reports frame times only for consecutively rendered frames", () => {
    const onFrameTime = vi.fn();
    const { s, loop } = setup({ onFrameTime });
    loop.invalidate();
    s.frame();
    s.idle(5000);
    loop.invalidate();
    s.frame();
    expect(onFrameTime).not.toHaveBeenCalled();
    const end = loop.beginAnim();
    s.frames(4);
    end();
    // Four frames in a row after an idle period: the first has no predecessor.
    expect(onFrameTime).toHaveBeenCalledTimes(3);
    for (const [ms] of onFrameTime.mock.calls) expect(ms).toBeCloseTo(1000 / 60, 3);
  });

  it("clamps long deltas handed to participants", () => {
    const { s, render, loop } = setup();
    const end = loop.beginAnim();
    s.frame();
    s.idle(10_000);
    s.frame();
    expect(render.mock.calls[1]?.[0]).toBe(100);
    end();
  });

  it("paused loops hold invalidations until start()", () => {
    const { s, render, loop } = setup({ paused: true });
    expect(loop.paused).toBe(true);
    loop.invalidate();
    s.frames(5);
    expect(render).not.toHaveBeenCalled();
    loop.start();
    loop.start();
    s.frames(5);
    expect(render).toHaveBeenCalledTimes(1);
    const end = loop.beginAnim();
    s.frame();
    loop.pause();
    loop.pause();
    s.frames(5);
    expect(render).toHaveBeenCalledTimes(2);
    loop.start();
    s.frames(2);
    expect(render).toHaveBeenCalledTimes(4);
    end();
  });

  it("start() with nothing pending stays idle", () => {
    const { s, render, loop } = setup({ paused: true });
    loop.start();
    s.frames(5);
    expect(render).not.toHaveBeenCalled();
  });

  it("renderNow() advances and renders synchronously; advance() only advances", () => {
    const update = vi.fn();
    const { render, loop } = setup();
    loop.add({ update });
    loop.renderNow(16);
    expect(update).toHaveBeenCalledWith(16);
    expect(render).toHaveBeenCalledWith(16);
    loop.advance(5);
    expect(update).toHaveBeenLastCalledWith(5);
    expect(render).toHaveBeenCalledTimes(1);
    loop.renderNow();
    expect(loop.frames).toBe(2);
  });

  it("dispose() cancels the frame and detaches listeners", () => {
    const { s, vis, render, loop } = setup();
    loop.beginAnim();
    expect(vis.listeners).toBe(1);
    loop.dispose();
    loop.dispose();
    expect(vis.listeners).toBe(0);
    s.frames(5);
    loop.invalidate();
    loop.renderNow();
    expect(render).not.toHaveBeenCalled();
  });

  it("falls back to globalThis requestAnimationFrame and document", () => {
    const s = scheduler();
    const g = globalThis as Record<string, unknown>;
    g["requestAnimationFrame"] = s.schedule;
    g["cancelAnimationFrame"] = s.unschedule;
    try {
      const render = vi.fn();
      const loop = createLoop({ render });
      loop.invalidate();
      s.frame();
      expect(render).toHaveBeenCalledTimes(1);
      loop.beginAnim();
      loop.dispose();
    } finally {
      delete g["requestAnimationFrame"];
      delete g["cancelAnimationFrame"];
    }
    const loop = createLoop({ render: vi.fn(), visibility: null });
    expect(() => loop.invalidate()).toThrow(/requestAnimationFrame/);
  });
});
