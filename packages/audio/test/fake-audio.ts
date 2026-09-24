/**
 * A recording fake of the WebAudio API for unit tests (Node has no AudioContext): nodes keep
 * their connections, AudioParams keep their automation events and can be evaluated at a time,
 * sources end (and fire `onended`) when the fake clock passes their stop time.
 */

export type ParamEvent =
  | { type: "set"; value: number; time: number }
  | { type: "linear"; value: number; time: number }
  | { type: "exp"; value: number; time: number }
  | { type: "target"; value: number; time: number; tc: number }
  | { type: "cancel"; time: number };

export class FakeParam {
  events: ParamEvent[] = [];
  inputs: FakeNode[] = [];
  private _value: number;
  readonly initial: number;
  constructor(
    readonly owner: FakeNode,
    readonly name: string,
    value: number,
  ) {
    this._value = value;
    this.initial = value;
  }
  /** Like Chrome: the automated value at the context's current time. */
  get value(): number {
    return this.events.some((e) => e.time !== -1)
      ? this.valueAt(this.owner.ctx.currentTime)
      : this._value;
  }
  set value(v: number) {
    this._value = v;
    this.events.push({ type: "set", value: v, time: -1 });
  }
  setValueAtTime(value: number, time: number): this {
    this.events.push({ type: "set", value, time });
    return this;
  }
  linearRampToValueAtTime(value: number, time: number): this {
    this.events.push({ type: "linear", value, time });
    return this;
  }
  exponentialRampToValueAtTime(value: number, time: number): this {
    if (value <= 0) throw new RangeError("exponential ramp to a non-positive value");
    this.events.push({ type: "exp", value, time });
    return this;
  }
  setTargetAtTime(value: number, time: number, tc: number): this {
    this.events.push({ type: "target", value, time, tc });
    return this;
  }
  cancelScheduledValues(time: number): this {
    this.events.push({ type: "cancel", time });
    return this;
  }
  /** Every value this param is set or ramped to (frequencies, for the pentatonic checks). */
  targets(): number[] {
    return this.events
      .filter((e) => e.type !== "cancel")
      .map((e) => (e as { value: number }).value);
  }
  /**
   * The automated value at time `t` (WebAudio semantics, sufficient for the patterns used here:
   * set/linear/exp ramps and setTarget; `cancel` drops later events).
   */
  valueAt(t: number): number {
    let evs: ParamEvent[] = [];
    for (const e of this.events) {
      if (e.type === "cancel") evs = evs.filter((x) => x.time === -1 || x.time < e.time);
      else evs.push(e);
    }
    let v = this.initial;
    let vT = 0;
    let target: { value: number; start: number; tc: number; v0: number } | null = null;
    const cur = (time: number): number =>
      target
        ? target.value + (target.v0 - target.value) * Math.exp(-(time - target.start) / target.tc)
        : v;
    for (const e of evs) {
      if (e.type === "cancel") continue;
      if (e.time === -1) {
        v = e.value;
        target = null;
        continue;
      }
      if (e.time > t) {
        if (e.type === "linear") return v + ((e.value - v) * (t - vT)) / (e.time - vT);
        if (e.type === "exp") return v * (e.value / v) ** ((t - vT) / (e.time - vT));
        return cur(t);
      }
      if (e.type === "target") {
        target = { value: e.value, start: e.time, tc: e.tc, v0: cur(e.time) };
      } else {
        v = e.value;
        target = null;
      }
      vT = e.time;
    }
    return cur(t);
  }
}

export class FakeNode {
  outputs: (FakeNode | FakeParam)[] = [];
  disconnected = false;
  constructor(
    readonly ctx: FakeAudioContext,
    readonly kind: string,
  ) {
    ctx.nodes.push(this);
  }
  connect<T extends FakeNode | FakeParam>(dest: T): T {
    this.outputs.push(dest);
    if (dest instanceof FakeParam) dest.inputs.push(this);
    this.disconnected = false;
    return dest;
  }
  disconnect(): void {
    this.outputs = [];
    this.disconnected = true;
  }
}

export class FakeGain extends FakeNode {
  gain = new FakeParam(this, "gain", 1);
  constructor(ctx: FakeAudioContext) {
    super(ctx, "gain");
  }
}

export class FakeBiquad extends FakeNode {
  type = "lowpass";
  frequency = new FakeParam(this, "frequency", 350);
  Q = new FakeParam(this, "Q", 1);
  constructor(ctx: FakeAudioContext) {
    super(ctx, "biquad");
  }
}

export class FakeCompressor extends FakeNode {
  threshold = new FakeParam(this, "threshold", -24);
  knee = new FakeParam(this, "knee", 30);
  ratio = new FakeParam(this, "ratio", 12);
  attack = new FakeParam(this, "attack", 0.003);
  release = new FakeParam(this, "release", 0.25);
  constructor(ctx: FakeAudioContext) {
    super(ctx, "compressor");
  }
}

export class FakeSource extends FakeNode {
  startTime: number | null = null;
  stopTime: number | null = null;
  ended = false;
  onended: ((e: unknown) => void) | null = null;
  start(when = 0): void {
    if (this.startTime !== null) throw new Error("start called twice");
    this.startTime = when;
  }
  stop(when = 0): void {
    if (this.startTime === null) throw new Error("stop before start");
    this.stopTime = when;
  }
}

export class FakeOscillator extends FakeSource {
  type = "sine";
  frequency = new FakeParam(this, "frequency", 440);
  detune = new FakeParam(this, "detune", 0);
  constructor(ctx: FakeAudioContext) {
    super(ctx, "oscillator");
  }
}

export class FakeBufferSource extends FakeSource {
  buffer: FakeBuffer | null = null;
  loop = false;
  offset = 0;
  constructor(ctx: FakeAudioContext) {
    super(ctx, "buffer-source");
  }
  override start(when = 0, offset = 0): void {
    super.start(when);
    this.offset = offset;
  }
}

export class FakeAnalyser extends FakeNode {
  fftSize = 2048;
  constructor(ctx: FakeAudioContext) {
    super(ctx, "analyser");
  }
  getFloatTimeDomainData(out: Float32Array): void {
    out.fill(0.1);
  }
}

export class FakeBuffer {
  private data: Float32Array;
  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {
    this.data = new Float32Array(length);
  }
  getChannelData(): Float32Array {
    return this.data;
  }
}

export class FakeAudioContext {
  currentTime = 0;
  sampleRate = 8000;
  state: AudioContextState = "suspended";
  nodes: FakeNode[] = [];
  calls: string[] = [];
  destination: FakeNode;
  constructor() {
    this.destination = new FakeNode(this, "destination");
  }
  createGain(): FakeGain {
    return new FakeGain(this);
  }
  createBiquadFilter(): FakeBiquad {
    return new FakeBiquad(this);
  }
  createDynamicsCompressor(): FakeCompressor {
    return new FakeCompressor(this);
  }
  createOscillator(): FakeOscillator {
    return new FakeOscillator(this);
  }
  createBufferSource(): FakeBufferSource {
    return new FakeBufferSource(this);
  }
  createAnalyser(): FakeAnalyser {
    return new FakeAnalyser(this);
  }
  createBuffer(channels: number, length: number, rate: number): FakeBuffer {
    return new FakeBuffer(channels, length, rate);
  }
  async resume(): Promise<void> {
    this.calls.push("resume");
    if (this.state !== "closed") this.state = "running";
  }
  async suspend(): Promise<void> {
    this.calls.push("suspend");
    if (this.state !== "closed") this.state = "suspended";
  }
  async close(): Promise<void> {
    this.calls.push("close");
    this.state = "closed";
  }
  /** Moves the clock to `t` and ends every source whose stop time has passed. */
  advance(t: number): void {
    this.currentTime = t;
    for (const n of this.nodes)
      if (n instanceof FakeSource && !n.ended && n.stopTime !== null && n.stopTime <= t) {
        n.ended = true;
        n.onended?.({});
      }
  }
  of<T extends FakeNode>(cls: new (ctx: FakeAudioContext) => T): T[] {
    return this.nodes.filter((n): n is T => n instanceof cls);
  }
  /** As the DOM type, for code under test. */
  get asAudio(): AudioContext {
    return this as unknown as AudioContext;
  }
}

/** Manual timers for the look-ahead scheduler. */
export class FakeTimers {
  fns = new Map<number, () => void>();
  private id = 0;
  setInterval = (fn: () => void): number => {
    this.fns.set(++this.id, fn);
    return this.id;
  };
  clearInterval = (id: unknown): void => {
    this.fns.delete(id as number);
  };
  tick(): void {
    for (const fn of [...this.fns.values()]) fn();
  }
}

/** Runs a fake context forward in `stepS` increments, ticking the timers each step. */
export function run(
  ctx: FakeAudioContext,
  timers: FakeTimers,
  untilS: number,
  stepS = 0.025,
): void {
  for (let t = ctx.currentTime; t <= untilS + 1e-9; t += stepS) {
    ctx.advance(t);
    timers.tick();
  }
}

/** A fake document with controllable visibility. */
export class FakeDocument {
  visibilityState: DocumentVisibilityState = "visible";
  listeners = new Map<string, Set<() => void>>();
  addEventListener(type: string, fn: () => void): void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(fn);
  }
  removeEventListener(type: string, fn: () => void): void {
    this.listeners.get(type)?.delete(fn);
  }
  fire(type: string): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn();
  }
  setVisibility(v: DocumentVisibilityState): void {
    this.visibilityState = v;
    this.fire("visibilitychange");
  }
  count(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

/** Flushes pending promise callbacks. */
export const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
