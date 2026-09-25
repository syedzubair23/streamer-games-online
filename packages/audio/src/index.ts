/**
 * @packageDocumentation
 * @sg/audio: synthesised, stream-safe audio (SPEC §13.7, research 03 §8): SFX recipes, the
 * C major pentatonic quantiser, ambience beds per mode, a generative lofi loop, buses and
 * ducking. Zero audio files; everything is made with WebAudio at runtime.
 *
 * - {@link createAudio}: the page's whole audio system (what the shell uses).
 * - {@link createSfxPlayer}: sfx only, for lean controller bundles.
 */
export * from "./pentatonic.ts";
export * from "./context.ts";
export * from "./buses.ts";
export * from "./scheduler.ts";
export * from "./sfx/recipes.ts";
export * from "./sfx/plan.ts";
export * from "./sfx/play.ts";
export * from "./sfx/noise.ts";
export * from "./ambience/beds.ts";
export * from "./ambience/events.ts";
export * from "./ambience/player.ts";
export * from "./lofi.ts";
export * from "./audio.ts";
