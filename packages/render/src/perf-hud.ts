/**
 * Perf instrumentation (research 04 §11.1; dev builds and `?perf=1`): a per-frame sampler with
 * fixed-size ring buffers (no allocation per frame), percentile summaries (p50/p90/p99, jank),
 * peak draw calls / triangles, live memory and program counts, an optional DOM overlay updated
 * at 4 Hz, and `window.__perf` for bug reports and the harness. Tree-shaken out of production
 * unless the flag imports it.
 *
 * @module
 */

/** The renderer fields the monitor samples (a `WebGLRenderer` satisfies it). */
export interface PerfRenderer {
  info: {
    render: { calls: number; triangles: number };
    memory: { geometries: number; textures: number };
    programs?: readonly unknown[] | null;
  };
  getPixelRatio?(): number;
}

/** A summary of the sampled frames. */
export interface PerfSummary {
  frames: number;
  p50FrameMs: number;
  p90FrameMs: number;
  p99FrameMs: number;
  /** Share of frames slower than 33.3 ms. */
  jankPct: number;
  maxDrawCalls: number;
  maxTriangles: number;
  lastDrawCalls: number;
  lastTriangles: number;
  programs: number;
  geometries: number;
  textures: number;
  pixelRatio: number;
  /** Rendered frames per second over the last second of wall time. */
  rendersPerSec: number;
}

/** Options of {@link createPerfMonitor}. */
export interface PerfMonitorOptions {
  renderer: PerfRenderer;
  /** Ring buffer size in frames (default 600 ≈ 10 s at 60 fps). */
  capacity?: number;
  now?: () => number;
}

/** The monitor. */
export interface PerfMonitor {
  /** Records one rendered frame (call right after `renderer.render`). */
  sample(frameMs: number): void;
  summary(): PerfSummary;
  /** A JSON-able dump: summary plus the raw ring buffers (oldest first). */
  dump(): { summary: PerfSummary; frameMs: number[]; calls: number[]; tris: number[] };
  /** Clears every sample. */
  reset(): void;
  /** Mounts a small fixed overlay in `parent` (4 Hz text updates); returns the remover. */
  mountHud(parent: HTMLElement): () => void;
  /** Exposes `__perf` ({ summary, dump, reset }) on `target` (default `globalThis`). */
  install(target?: object): () => void;
}

/** Frames slower than this count as jank (research 04 §11.1). */
export const JANK_MS = 1000 / 30;

/** Creates a perf monitor on a renderer. */
export function createPerfMonitor(o: PerfMonitorOptions): PerfMonitor {
  const cap = Math.max(8, Math.floor(o.capacity ?? 600));
  const now = o.now ?? (() => performance.now());
  const frameMs = new Float32Array(cap);
  const calls = new Uint32Array(cap);
  const tris = new Uint32Array(cap);
  const stamps = new Float64Array(cap);
  const scratch = new Float32Array(cap);
  let head = 0;
  let count = 0;
  let maxCalls = 0;
  let maxTris = 0;
  let hudText: ((s: PerfSummary) => void) | null = null;
  let lastHud = Number.NEGATIVE_INFINITY;

  const ordered = <T extends Float32Array | Uint32Array>(buf: T): number[] => {
    const out: number[] = [];
    const start = count < cap ? 0 : head;
    for (let i = 0; i < count; i++) out.push(buf[(start + i) % cap] as number);
    return out;
  };

  const pct = (p: number): number => {
    if (count === 0) return 0;
    const view = scratch.subarray(0, count);
    view.set(count < cap ? frameMs.subarray(0, count) : frameMs);
    view.sort();
    return view[Math.min(count - 1, Math.max(0, Math.ceil(p * count) - 1))] as number;
  };

  const monitor: PerfMonitor = {
    sample(ms) {
      const info = o.renderer.info;
      frameMs[head] = ms;
      calls[head] = info.render.calls;
      tris[head] = info.render.triangles;
      stamps[head] = now();
      head = (head + 1) % cap;
      if (count < cap) count++;
      if (info.render.calls > maxCalls) maxCalls = info.render.calls;
      if (info.render.triangles > maxTris) maxTris = info.render.triangles;
      if (hudText !== null) {
        const t = now();
        if (t - lastHud >= 250) {
          lastHud = t;
          hudText(monitor.summary());
        }
      }
    },
    summary() {
      const info = o.renderer.info;
      let jank = 0;
      for (let i = 0; i < count; i++) if ((frameMs[i] as number) > JANK_MS) jank++;
      const last = (head + cap - 1) % cap;
      const t = now();
      let recent = 0;
      for (let i = 0; i < count; i++) if (t - (stamps[i] as number) <= 1000) recent++;
      return {
        frames: count,
        p50FrameMs: pct(0.5),
        p90FrameMs: pct(0.9),
        p99FrameMs: pct(0.99),
        jankPct: count === 0 ? 0 : (jank / count) * 100,
        maxDrawCalls: maxCalls,
        maxTriangles: maxTris,
        lastDrawCalls: count === 0 ? 0 : (calls[last] as number),
        lastTriangles: count === 0 ? 0 : (tris[last] as number),
        programs: info.programs?.length ?? 0,
        geometries: info.memory.geometries,
        textures: info.memory.textures,
        pixelRatio: o.renderer.getPixelRatio?.() ?? 1,
        rendersPerSec: recent,
      };
    },
    dump() {
      return {
        summary: monitor.summary(),
        frameMs: ordered(frameMs),
        calls: ordered(calls),
        tris: ordered(tris),
      };
    },
    reset() {
      head = 0;
      count = 0;
      maxCalls = 0;
      maxTris = 0;
    },
    mountHud(parent) {
      const doc = parent.ownerDocument;
      const el = doc.createElement("pre");
      el.setAttribute("aria-hidden", "true");
      el.dataset["sgPerfHud"] = "";
      el.style.cssText =
        "position:absolute;left:8px;bottom:8px;margin:0;padding:6px 8px;z-index:9999;" +
        "font:12px/1.35 ui-monospace,monospace;color:#F5EDE3;background:rgba(31,29,51,0.78);" +
        "border-radius:10px;pointer-events:none;white-space:pre";
      parent.appendChild(el);
      hudText = (s) => {
        el.textContent =
          `${s.rendersPerSec} fps  p90 ${s.p90FrameMs.toFixed(1)} ms  jank ${s.jankPct.toFixed(0)}%\n` +
          `draws ${s.lastDrawCalls} (max ${s.maxDrawCalls})  tris ${s.lastTriangles}\n` +
          `prog ${s.programs}  geo ${s.geometries}  tex ${s.textures}  dpr ${s.pixelRatio.toFixed(2)}`;
      };
      hudText(monitor.summary());
      lastHud = now();
      return () => {
        hudText = null;
        el.remove();
      };
    },
    install(target = globalThis) {
      const api = {
        summary: () => monitor.summary(),
        dump: () => monitor.dump(),
        reset: () => monitor.reset(),
      };
      (target as { __perf?: unknown }).__perf = api;
      return () => {
        const t = target as { __perf?: unknown };
        if (t.__perf === api) delete t.__perf;
      };
    },
  };
  return monitor;
}
