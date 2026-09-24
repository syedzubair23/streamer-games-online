/**
 * The game module API (SPEC §9.3): what every game's pure logic implements and what the
 * {@link GameRunner} drives. The declarations between the markers below are copied exactly from
 * the spec (`test/spec-sync.test.ts` fails if they drift); the spec leaves `ContentAccess` to
 * this file, and it is defined after the copied block together with small helpers.
 *
 * Module rules (lint and the contract suite enforce these):
 * 1. No `Math.random`, `Date`, timers, I/O or globals: use `ctx.rng`, `ctx.now`, `ctx.timing`.
 * 2. State is plain JSON and treated as immutable (the runner deep-freezes it in dev).
 * 3. Every view includes `phase: string` and `deadline: number | null` (server ms).
 * 4. Hidden information lives under `secret` / `hidden` keys or in `secretPaths`.
 * 5. Content reaches clients only through `view()`, and only once revealed.
 * 6. `onAction` never throws; bad input returns the state unchanged.
 *
 * @module
 */
import type { PackItemMap, PackKind } from "@sg/shared";

// ---------------------------------------------------------------------------------------------
// Copied exactly from SPEC §9.3.
// ---------------------------------------------------------------------------------------------

import type { Rng, PlayerId, TeamId, AudId, GameId } from "@sg/shared";

// prettier-ignore
export interface GameManifest {
  id: GameId; name: string; version: string;          // semver; stored in snapshots
  minPlayers: number; maxPlayers: number;
  teamSupport: "none" | "optional" | "required";
  audience: { vote?: true; predict?: true; quiz?: true; dial?: true; guess?: true; tap?: true; direct?: true; joinQueue?: true };
  tickHz: 0 | 10 | 20 | 60;                            // 0 = timer/event driven. Only marble-rally uses 60 (server sim).
  renderMode: "on-demand" | "continuous";              // client loop hint; only marble-rally is continuous (during race)
  estMinutes: [number, number];
  tags: string[];
  contentRating: "all" | "teen";
  howToPlay: [string, string, string];                  // 3 steps, ≤ 60 chars each
}

// prettier-ignore
export type OptionSpec =
  | { kind: "int"; key: string; label: string; min: number; max: number; step?: number; default: number }
  | { kind: "bool"; key: string; label: string; default: boolean }
  | { kind: "enum"; key: string; label: string; choices: { value: string; label: string }[]; default: string }
  | { kind: "seconds"; key: string; label: string; min: number; max: number; default: number }
  | { kind: "pack"; key: string; label: string; packKind: PackKind; multi: boolean; default: string[] };

// prettier-ignore
export interface Timing {
  /** Player/audience input window: base × timerScale + streamDelay. Returns null when timerScale = 0 (no timer). */
  input(baseMs: number): number | null;
  /** Pacing (reveals, animations, readouts): base only, never scaled, never null. */
  pace(baseMs: number): number;
}

// prettier-ignore
export interface Seat { id: PlayerId; name: string; seat: number; teamId?: TeamId; colorSlot: number /*0..7*/ }

// prettier-ignore
export interface SetupContext<O> {
  players: Seat[]; teams: { id: TeamId; name: string; colorSlot: number }[];
  options: O; rng: Rng; now: number; timing: Timing;
  content: ContentAccess;          // server-only pack access (sync, pre-loaded); returns [] in client scenarios unless fixture given
  audienceCount: number;
}
// prettier-ignore
export interface Ctx { rng: Rng; now: number; timing: Timing; audienceCount: number }
// prettier-ignore
export interface ActionCtx extends Ctx { actor: { id: PlayerId; role: "player" | "host" | "moderator"; teamId?: TeamId } }

// prettier-ignore
export interface Step<S> { state: S; effects?: Effect[] }

// prettier-ignore
export type Effect =
  | { type: "timer.set"; id: string; atMs: number }
  | { type: "timer.clear"; id: string }
  | { type: "audience.open"; poll: PollSpec }
  | { type: "audience.close"; pollId: string }
  | { type: "audience.resolve"; pollId: string; correct?: string; target?: number; bands?: { within: number; points: number }[] }
  | { type: "audience.enroll"; open: boolean; closesAtMs?: number; cap?: number }
  | { type: "score"; deltas: Record<string, number> }            // PlayerId | TeamId -> points (in-game running score)
  | { type: "fx"; name: string; data?: unknown }                 // cosmetic cue: sfx, confetti, camera
  | { type: "moderate"; itemId: string; kind: "text" | "drawing"; ownerId: PlayerId | AudId; preview: string }
  | { type: "stream"; channel: "stage" | "aud"; frame: Uint8Array }   // binary side-channel (marble-rally only), published as-is to a topic
  | { type: "streamEach"; frames: { to: AudId | PlayerId; frame: Uint8Array }[] }  // tiny per-socket binary frames (marble-rally 0x03 "your rank"); never used for > 1 Hz
  | { type: "private"; to: PlayerId; name: string; data?: unknown }   // one-off private cue to one player (e.g. "close guess!") — not part of the view
  | { type: "audience.award"; points: Record<AudId, number> }         // direct play-along points (marble-rally race results)
  | { type: "end"; result: GameResult };

// prettier-ignore
export interface PollSpec {
  pollId: string; kind: "vote" | "predict" | "quiz" | "dial" | "guess" | "tap";
  prompt: string; options?: { id: string; label: string }[];
  closesAtMs: number;
  accept?: string[];               // guess only — server-side secret, never broadcast
  speedBonus?: boolean;            // quiz only
  teamSplit?: boolean;
  hideLive?: boolean;              // broadcast answered-count only until close (§4)
  closeOn?: "deadline" | "event";  // "event": closed by the game via audience.close; exempt from stream delay (§4)
}
// prettier-ignore
export interface PollResult {
  pollId: string; kind: PollSpec["kind"]; total: number;
  tallies: Record<string, number>;           // optionId -> count; dial: bin index -> count; tap: {taps}
  byTeam?: Record<TeamId, Record<string, number>>;
  mean?: number;                             // dial
  firstCorrect?: { audId: AudId; name: string }[]; // guess
}
// prettier-ignore
export interface GameResult {
  ranking: { id: PlayerId | TeamId; score: number; place: number }[];
  highlights?: { label: string; playerId?: PlayerId; audId?: AudId }[];
}

// prettier-ignore
export type ViewerKey =
  | { role: "player"; id: PlayerId }
  | { role: "audience"; restricted?: boolean }  // ONE shared view for all audience; `restricted` = second shared view for audience sessions whose IP hash matches a seated player (games strip secrets there)
  | { role: "stage" }        // safe to broadcast; used by host Stage and overlay
  | { role: "host" }         // stage + host-only info (moderation previews, pending counts); never player secrets. Delivered ONLY to the host panel pop-out, never to the Stage window (§2)
  | { role: "moderator" };

// prettier-ignore
export interface GameModule<S, A, O, V> {
  manifest: GameManifest;
  optionSpecs: OptionSpec[];
  parseAction(raw: unknown): A | null;                         // never throws
  setup(ctx: SetupContext<O>): Step<S>;
  onAction(state: S, action: A, ctx: ActionCtx): Step<S>;      // illegal -> { state } unchanged + fx "illegal"
  onTimer?(state: S, timerId: string, ctx: Ctx): Step<S>;
  onTick?(state: S, dtMs: number, ctx: Ctx): Step<S>;
  onAudienceResult?(state: S, r: PollResult, ctx: Ctx): Step<S>;
  onAudienceEnroll?(state: S, entrants: { audId: AudId; name: string; skin: number }[], ctx: Ctx): Step<S>;
  onAudienceAction?(state: S, audId: AudId, action: unknown, ctx: Ctx): Step<S>;
  onModeration?(state: S, itemId: string, approved: boolean, ctx: Ctx): Step<S>;
  onPlayerLeave?(state: S, id: PlayerId, ctx: Ctx): Step<S>;
  onPlayerRejoin?(state: S, id: PlayerId, ctx: Ctx): Step<S>;
  onHostCommand?(state: S, cmd: { c: "forceAdvance" } | { c: "skipItem"; itemId: string }, ctx: Ctx): Step<S>;
  view(state: S, viewer: ViewerKey): V;                        // SECURITY BOUNDARY
  legalActions(state: S, player: PlayerId): A[];               // may return a representative sample for text games
  bot(state: S, player: PlayerId, rng: Rng): A | null;         // REQUIRED: takeover + sims
  serialize(state: S): string;
  deserialize(data: string): S;
}

// ---------------------------------------------------------------------------------------------
// End of the SPEC §9.3 copy.
// ---------------------------------------------------------------------------------------------

/** Summary of one content pack a game may draw from (never the items themselves). */
export interface PackInfo {
  id: string;
  kind: PackKind;
  name: string;
  rating: "all" | "teen";
  count: number;
}

/**
 * Server-only, synchronous access to the pre-loaded content packs (SPEC §9.3 `SetupContext.content`,
 * §12). Clients never receive a whole pack: games copy the items they use into `hidden` state and
 * reveal them through `view()`. In client scenarios it returns `[]` unless a fixture is given
 * (see `fakeContent` in `@sg/engine/testing`).
 */
export interface ContentAccess {
  /** The packs of `kind` available to this room (after the room's content filter). */
  packs(kind: PackKind): readonly PackInfo[];
  /**
   * Every item of `kind` in the given packs, in pack order then item order. Unknown pack ids
   * (or packs of another kind) are skipped, so the result can be empty.
   */
  items<K extends PackKind>(kind: K, packIds: readonly string[]): readonly PackItemMap[K][];
  /**
   * True when a content item was already used earlier in this room session (no repeats across
   * games, e.g. trivia-night). `key` is the item's `id`, or for id-less kinds its main text
   * (see {@link contentKey}).
   */
  isUsed(kind: PackKind, key: string): boolean;
}

/**
 * The stable key of a content item, used by {@link ContentAccess.isUsed}: the item's `id` when it
 * has one; `doodle-words` use the word, `ooo-pairs` use `"a|b"`.
 */
export function contentKey<K extends PackKind>(kind: K, item: PackItemMap[K]): string {
  if (kind === "doodle-words") return (item as PackItemMap["doodle-words"]).w;
  if (kind === "ooo-pairs") {
    const pair = item as PackItemMap["ooo-pairs"];
    return `${pair.a}|${pair.b}`;
  }
  return (item as { id: string }).id;
}

/** Content access with no packs at all: every lookup is empty and nothing is used. */
export const EMPTY_CONTENT: ContentAccess = Object.freeze({
  packs: () => [],
  items: () => [],
  isUsed: () => false,
});

/** Keys under which state holds hidden information (SPEC §9.3 rule 4). */
export const SECRET_KEYS: readonly string[] = Object.freeze(["secret", "hidden"]);

/**
 * The default option values of a game, from its `optionSpecs` (each spec's `default`). The
 * runner merges host options over these.
 */
export function defaultOptions(specs: readonly OptionSpec[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const spec of specs) {
    out[spec.key] = Array.isArray(spec.default) ? [...spec.default] : spec.default;
  }
  return out;
}

/** Any game module, for registries and tooling that do not care about the type parameters. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- variance escape hatch for heterogeneous module registries; callers re-narrow via the module's own types
export type AnyGameModule = GameModule<any, any, any, any>;

/** The host commands a game may receive through `onHostCommand`. */
export type GameHostCommand = Parameters<
  NonNullable<GameModule<unknown, unknown, unknown, unknown>["onHostCommand"]>
>[1];
