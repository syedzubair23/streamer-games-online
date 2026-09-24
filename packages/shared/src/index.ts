/**
 * @packageDocumentation
 * @sg/shared: the types and utilities every package shares.
 *
 * - `ids`: `PlayerId`, `TeamId`, `AudId`, room-code alphabet and validation.
 * - `room`: `RoomConfig` (SPEC §7), game ids, defaults.
 * - `protocol`: `C2S` / `S2C` messages (SPEC §9.6) and their supporting types.
 * - `rng`: seeded, serialisable sfc32 (`createRng`, `rngFrom`).
 * - `diff`: structural JSON `diff` / `apply` for view patches.
 * - `codec`: JSON text frames, the patch-vs-full rule, Marble Rally binary frames.
 * - `text`: `normalize`, `levenshtein`, `classifyGuess`, `cleanUserText`, `filterText`.
 * - `content`: content pack types and zod schemas (SPEC §12).
 */

export * from "./ids.ts";
export * from "./room.ts";
export * from "./protocol.ts";
export * from "./rng.ts";
export * from "./diff.ts";
export * from "./codec.ts";
export * from "./text.ts";
export * from "./content.ts";
