/**
 * Shared noise buffers, generated once per context from a fixed seed (so every run sounds the
 * same and nothing is downloaded): white noise for bursts and clicks, pink noise (Paul Kellet's
 * economy filter) for rain, wind and room tone, and brown noise for the low room rumble.
 *
 * @module
 */
import { createRng } from "@sg/shared";

/** Noise colours. */
export type NoiseColor = "white" | "pink" | "brown";

/** Seconds of noise per buffer; loops seamlessly enough for beds because it is noise. */
export const NOISE_SECONDS = 2;

const cache = new WeakMap<BaseAudioContext, Partial<Record<NoiseColor, AudioBuffer>>>();

/** Fills `out` with noise of the given colour in [-1, 1] (deterministic for a seed). */
export function fillNoise(out: Float32Array, color: NoiseColor, seed = 0x5eed): void {
  const rng = createRng(`noise:${color}:${seed}`);
  let b0 = 0,
    b1 = 0,
    b2 = 0,
    brown = 0;
  for (let i = 0; i < out.length; i++) {
    const w = rng.float() * 2 - 1;
    if (color === "white") out[i] = w;
    else if (color === "pink") {
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      out[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2;
    } else {
      brown = (brown + 0.02 * w) / 1.02;
      out[i] = brown * 3.5;
    }
  }
}

/** The cached noise buffer of a colour for `ctx` (mono, {@link NOISE_SECONDS} long). */
export function noiseBuffer(ctx: BaseAudioContext, color: NoiseColor = "white"): AudioBuffer {
  let entry = cache.get(ctx);
  if (!entry) cache.set(ctx, (entry = {}));
  let buf = entry[color];
  if (!buf) {
    buf = ctx.createBuffer(1, Math.round(ctx.sampleRate * NOISE_SECONDS), ctx.sampleRate);
    fillNoise(buf.getChannelData(0), color);
    entry[color] = buf;
  }
  return buf;
}

/** A started noise source (looping when `loop`), beginning at a random offset. */
export function noiseSource(
  ctx: BaseAudioContext,
  color: NoiseColor,
  when: number,
  loop = false,
  offset = 0,
): AudioBufferSourceNode {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, color);
  src.loop = loop;
  src.start(when, offset % NOISE_SECONDS);
  return src;
}
