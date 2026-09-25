/**
 * Plays the ambience bed of the current mode and crossfades to a new one over the SPEC §8
 * 2.5 s mode lerp. Each bed owns its layers, its event scheduler and a fade gain; a faded-out
 * bed stops its sources and disconnects every node.
 *
 * @module
 */
import { createRng, type AmbientMode, type Rng } from "@sg/shared";
import { noteFreq } from "../pentatonic.ts";
import { noiseSource } from "../sfx/noise.ts";
import { createScheduler, type SchedulerOptions } from "../scheduler.ts";
import { BEDS, type BedEvent, type BedRecipe, type Layer } from "./beds.ts";
import { planBird, planCricket, planDroplet, poissonGap, type Blip } from "./events.ts";

/** The mode crossfade, in ms (SPEC §8). */
export const MODE_FADE_MS = 2500;

const FLOOR = 0.0001;

interface LiveBed {
  readonly recipe: BedRecipe;
  /** Fades out from `t` over `s` seconds, then frees everything. */
  fadeOut(s: number): void;
}

function blips(
  ctx: BaseAudioContext,
  out: AudioNode,
  t: number,
  list: Blip[],
  gain: number,
  fm: boolean,
): void {
  for (const b of list) {
    const start = t + b.atMs / 1000;
    const end = start + b.durMs / 1000;
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(b.hz, start);
    if (b.toHz !== b.hz) osc.frequency.exponentialRampToValueAtTime(b.toHz, end);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, start);
    env.gain.linearRampToValueAtTime(gain * b.level, start + 0.004);
    env.gain.exponentialRampToValueAtTime(FLOOR, end);
    osc.connect(env).connect(out);
    const nodes: AudioNode[] = [osc, env];
    if (fm) {
      // FM: a modulator at 2× the carrier, index 0.8, gives the chirpy bird timbre.
      const mod = ctx.createOscillator();
      mod.frequency.setValueAtTime(b.hz * 2, start);
      const depth = ctx.createGain();
      depth.gain.value = b.hz * 0.8;
      mod.connect(depth).connect(osc.frequency);
      nodes.push(mod, depth);
      mod.start(start);
      mod.stop(end + 0.02);
    }
    osc.start(start);
    osc.stop(end + 0.02);
    osc.onended = () => {
      for (const n of nodes) n.disconnect();
    };
  }
}

function droplet(ctx: BaseAudioContext, out: AudioNode, t: number, rng: Rng, gain: number): void {
  const d = planDroplet(rng);
  const end = t + d.durMs / 1000;
  const f = ctx.createBiquadFilter();
  f.type = "bandpass";
  f.frequency.value = d.bandHz;
  f.Q.value = d.q;
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(gain * d.level, t + 0.001);
  env.gain.exponentialRampToValueAtTime(FLOOR, end);
  const src = noiseSource(ctx, "white", t, false, rng.float() * 2);
  src.connect(f).connect(env).connect(out);
  src.stop(end + 0.02);
  src.onended = () => {
    for (const n of [src, f, env]) n.disconnect();
  };
}

function playEvent(ctx: BaseAudioContext, out: AudioNode, t: number, e: BedEvent, rng: Rng): void {
  if (e.kind === "droplet") droplet(ctx, out, t, rng, e.gain);
  else if (e.kind === "cricket") blips(ctx, out, t, planCricket(rng), e.gain, false);
  else blips(ctx, out, t, planBird(rng), e.gain, true);
}

/** Nodes of a layer; `sources` are the ones to stop. */
interface LayerNodes {
  nodes: AudioNode[];
  sources: AudioScheduledSourceNode[];
}

function startLayer(
  ctx: BaseAudioContext,
  out: AudioNode,
  l: Layer,
  t: number,
  rng: Rng,
): LayerNodes {
  if (l.kind === "hum") {
    const osc = ctx.createOscillator();
    osc.frequency.value = noteFreq(l.note);
    const g = ctx.createGain();
    g.gain.value = l.gain;
    osc.connect(g).connect(out);
    osc.start(t);
    return { nodes: [osc, g], sources: [osc] };
  }
  const src = noiseSource(ctx, l.color, t, true, rng.float() * 2);
  const f = ctx.createBiquadFilter();
  f.type = l.filter.type;
  f.frequency.value = l.filter.hz;
  f.Q.value = l.filter.q;
  const g = ctx.createGain();
  g.gain.value = l.gain;
  src.connect(f).connect(g).connect(out);
  const nodes: AudioNode[] = [src, f, g];
  const sources: AudioScheduledSourceNode[] = [src];
  if (l.lfo) {
    const lfo = ctx.createOscillator();
    lfo.frequency.value = l.lfo.rateHz;
    const toGain = ctx.createGain();
    toGain.gain.value = l.gain * l.lfo.depth * 0.5;
    g.gain.value = l.gain * (1 - l.lfo.depth * 0.5);
    const toFilter = ctx.createGain();
    toFilter.gain.value = l.lfo.filterHz;
    lfo.connect(toGain).connect(g.gain);
    lfo.connect(toFilter).connect(f.frequency);
    lfo.start(t);
    nodes.push(lfo, toGain, toFilter);
    sources.push(lfo);
  }
  return { nodes, sources };
}

function startBed(
  ctx: BaseAudioContext,
  out: AudioNode,
  recipe: BedRecipe,
  rng: Rng,
  fadeS: number,
  sched: SchedulerOptions,
): LiveBed {
  const t = ctx.currentTime;
  const fade = ctx.createGain();
  fade.gain.setValueAtTime(FLOOR, t);
  fade.gain.exponentialRampToValueAtTime(1, t + Math.max(0.01, fadeS));
  fade.connect(out);
  const nodes: AudioNode[] = [fade];
  const sources: AudioScheduledSourceNode[] = [];
  for (const l of recipe.layers) {
    const ln = startLayer(ctx, fade, l, t, rng);
    nodes.push(...ln.nodes);
    sources.push(...ln.sources);
  }
  const next = recipe.events.map((e) => t + poissonGap(rng, e.ratePerS));
  const scheduler =
    recipe.events.length > 0
      ? createScheduler(
          ctx,
          (_from, to) => {
            recipe.events.forEach((e, i) => {
              while ((next[i] as number) < to) {
                playEvent(ctx, fade, next[i] as number, e, rng);
                next[i] = (next[i] as number) + poissonGap(rng, e.ratePerS);
              }
            });
          },
          sched,
        )
      : null;
  return {
    recipe,
    fadeOut(s) {
      scheduler?.stop();
      const now = ctx.currentTime;
      fade.gain.cancelScheduledValues(now);
      fade.gain.setValueAtTime(Math.max(FLOOR, fade.gain.value), now);
      fade.gain.exponentialRampToValueAtTime(FLOOR, now + Math.max(0.01, s));
      for (const src of sources) src.stop(now + s + 0.05);
      const free = (): void => {
        for (const n of nodes) n.disconnect();
      };
      const first = sources[0];
      if (first) first.onended = free;
      else free();
    },
  };
}

/** Options of {@link createAmbience}. */
export interface AmbienceOptions {
  rng?: Rng;
  scheduler?: SchedulerOptions;
}

/** The ambience controller. */
export interface Ambience {
  /** The playing mode, or `null` when stopped. */
  readonly mode: AmbientMode | null;
  /** Crossfades to `mode`'s bed over `fadeMs` (default {@link MODE_FADE_MS}). No-op if current. */
  setMode(mode: AmbientMode, fadeMs?: number): void;
  /** Fades the bed out and stops. */
  stop(fadeMs?: number): void;
}

/** Creates the ambience controller, rendering into `out` (the ambience bus). */
export function createAmbience(
  ctx: BaseAudioContext,
  out: AudioNode,
  o: AmbienceOptions = {},
): Ambience {
  const rng = o.rng ?? createRng("ambience");
  let live: LiveBed | null = null;
  let starts = 0;
  return {
    get mode() {
      return live?.recipe.mode ?? null;
    },
    setMode(mode, fadeMs = MODE_FADE_MS) {
      if (live?.recipe.mode === mode) return;
      live?.fadeOut(fadeMs / 1000);
      live = startBed(
        ctx,
        out,
        BEDS[mode],
        rng.fork(`${mode}:${starts++}`),
        fadeMs / 1000,
        o.scheduler ?? {},
      );
    },
    stop(fadeMs = 600) {
      live?.fadeOut(fadeMs / 1000);
      live = null;
    },
  };
}
