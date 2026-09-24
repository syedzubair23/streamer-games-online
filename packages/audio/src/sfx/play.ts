/**
 * Renders planned sfx voices with `OscillatorNode`/`AudioBufferSourceNode` + `GainNode`
 * envelopes (linear attack, exponential decay), and guards the mix: at most
 * {@link SfxPlayerOptions.maxVoices} voices at once, and each sound at most once per
 * {@link SfxPlayerOptions.minIntervalMs} (a wave of audience votes becomes a patter, not a roar).
 * Every node disconnects itself when it ends.
 *
 * @module
 */
import { createRng, type Rng } from "@sg/shared";
import { noiseSource } from "./noise.ts";
import { planSfx, type PlannedVoice, type PlanOptions } from "./plan.ts";
import { MODE_SWELL, SFX_RECIPES, type SfxName } from "./recipes.ts";

/** Envelope floor for the exponential decay (−80 dB). */
const FLOOR = 0.0001;
/** Extra time after the envelope before a source stops, in s. */
const TAIL_S = 0.02;

/**
 * Schedules one planned voice at context time `t0` (s) into `out`. Returns its source node.
 */
export function renderVoice(
  ctx: BaseAudioContext,
  out: AudioNode,
  v: PlannedVoice,
  t0: number,
  noiseOffset = 0,
): AudioScheduledSourceNode {
  const t = t0 + v.atMs / 1000;
  const peakAt = t + v.attackMs / 1000;
  const end = peakAt + v.decayMs / 1000;
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(v.peak, peakAt);
  env.gain.exponentialRampToValueAtTime(FLOOR, end);
  env.connect(out);
  const nodes: AudioNode[] = [env];
  let src: AudioScheduledSourceNode;
  if (v.kind === "tone") {
    const osc = ctx.createOscillator();
    osc.type = v.type;
    osc.frequency.setValueAtTime(v.hz, t);
    if (v.toHz !== undefined)
      osc.frequency.exponentialRampToValueAtTime(v.toHz, t + (v.glideMs ?? v.decayMs) / 1000);
    osc.detune.value = v.detune;
    let head: AudioNode = env;
    if (v.lowpassHz !== undefined) {
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = v.lowpassHz;
      lp.connect(env);
      nodes.push(lp);
      head = lp;
    }
    osc.connect(head);
    osc.start(t);
    src = osc;
  } else {
    const f = ctx.createBiquadFilter();
    f.type = v.filter.type;
    f.Q.value = v.filter.q;
    f.frequency.setValueAtTime(v.filter.hz, t);
    if (v.filter.toHz !== undefined) f.frequency.exponentialRampToValueAtTime(v.filter.toHz, end);
    f.connect(env);
    nodes.push(f);
    const n = noiseSource(ctx, "white", t, false, noiseOffset);
    n.connect(f);
    src = n;
  }
  nodes.push(src);
  src.stop(end + TAIL_S);
  src.onended = () => {
    for (const n of nodes) n.disconnect();
  };
  return src;
}

/** Options of {@link createSfxPlayer}. */
export interface SfxPlayerOptions {
  /** Randomness for variation (default: a generator seeded per player). */
  rng?: Rng;
  /** Voice budget; triggers that would exceed it are dropped (default 32). */
  maxVoices?: number;
  /** Minimum gap between two triggers of the same sound, in ms (default 30). */
  minIntervalMs?: number;
}

/** Plays sfx into one output node. */
export interface SfxPlayer {
  /** Triggers a sound now. Returns `false` if it was dropped by the voice or rate guard. */
  play(name: SfxName, opts?: PlanOptions): boolean;
  /** The mode-switch noise swell (0.6 s). */
  swell(): void;
  /** Voices sounding now. */
  readonly active: number;
}

/** Creates an {@link SfxPlayer} that renders into `out` (usually the sfx bus). */
export function createSfxPlayer(
  ctx: BaseAudioContext,
  out: AudioNode,
  o: SfxPlayerOptions = {},
): SfxPlayer {
  const rng = o.rng ?? createRng("sfx");
  const maxVoices = o.maxVoices ?? 32;
  const minGap = (o.minIntervalMs ?? 30) / 1000;
  const last = new Map<SfxName, number>();
  let active = 0;
  const start = (v: PlannedVoice, t0: number): void => {
    active++;
    const src = renderVoice(ctx, out, v, t0, rng.float() * 2);
    const onended = src.onended;
    src.onended = (e) => {
      active--;
      onended?.call(src, e);
    };
  };
  return {
    get active() {
      return active;
    },
    play(name, opts) {
      const now = ctx.currentTime;
      const prev = last.get(name);
      if (prev !== undefined && now - prev < minGap) return false;
      const plan = planSfx(SFX_RECIPES[name], rng, opts);
      if (active + plan.length > maxVoices) return false;
      last.set(name, now);
      for (const v of plan) start(v, now);
      return true;
    },
    swell() {
      start(MODE_SWELL, ctx.currentTime);
    },
  };
}
