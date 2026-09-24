/**
 * Room configuration (SPEC §7). The type declarations are copied exactly from the spec;
 * `test/spec-sync.test.ts` fails if they drift.
 *
 * @module
 */

// prettier-ignore
export type AmbientMode = "day" | "dusk" | "night" | "rain" | "snow"; // "dusk" is labelled "Golden Hour"; default
// prettier-ignore
export interface RoomConfig {
  visibility: "private" | "public";
  password?: string;
  maxPlayers: number;               // seated players in the room, 1..12; each game takes up to its own max (§3 step 4)
  maxAudience: number;              // default 10_000
  lateJoin: "audience" | "queue" | "deny";
  seatPick: "fifo" | "raffle";      // how free seats are filled from the queue at game boundaries
  playlistMode: "fixed" | "audience-vote";  // default audience-vote (§3 step 5)
  antiSnipe: boolean;               // default true: audience sessions sharing an IP hash with a seated player get the restricted view.
                                    // Turn OFF for classrooms/LAN parties where everyone shares one NAT IP (otherwise nobody sees secrets).
  contentFilter: "family" | "standard";   // family also filters names, disables spicy packs
  moderation: "off" | "reveal-review";    // reveal-review: user text/drawings wait for host/mod approval before stage reveal
  hideCode: boolean;
  timerScale: 0 | 0.75 | 1 | 1.5 | 2;  // 0 = no input timers (host advances); 0.75 = "Snappy" for experienced groups
  streamDelaySec: number;           // 0..8, default 3
  audienceMin: number;              // default 5
  reconnectGraceSec: number;        // default 60
  teams: { mode: "none" | "host" | "auto" | "self"; count: 2 | 3 | 4 };
  scoring: "placement" | "raw";
  theme: { ambient: AmbientMode; autoCycleMin: 0 | 10 | 20 | 30; audienceModeVote: boolean };
  streamLayout: { enabled: boolean; webcam: "br" | "bl" | "tr" | "tl" | "none" };  // keeps zones clear via camera view offset
  audio: { music: number; sfx: number; ambience: number; streamerSafe: boolean };  // 0..1
  quality: "auto" | "battery" | "balanced" | "pretty";
  playlist: PlaylistItem[];
}
// prettier-ignore
export interface PlaylistItem { gameId: GameId; options: Record<string, unknown>; label?: string }
// prettier-ignore
export type GameId = "quip-clash" | "tune-in" | "trivia-night" | "doodle" | "odd-one-out" | "ludo" | "chess" | "marble-rally";

/** Every launch game id, in build order (SPEC §6). */
export const GAME_IDS = [
  "quip-clash",
  "tune-in",
  "trivia-night",
  "doodle",
  "odd-one-out",
  "ludo",
  "chess",
  "marble-rally",
] as const satisfies readonly GameId[];

/** True when `id` is one of the 8 launch games. */
export function isGameId(id: unknown): id is GameId {
  return typeof id === "string" && (GAME_IDS as readonly string[]).includes(id);
}

/** The 5 ambient modes (SPEC §8). `dusk` ("Golden Hour") is the default. */
export const AMBIENT_MODES = [
  "day",
  "dusk",
  "night",
  "rain",
  "snow",
] as const satisfies readonly AmbientMode[];

/** Numeric bounds for the numeric `RoomConfig` fields (SPEC §7, §9.5). */
export const ROOM_LIMITS = {
  maxPlayers: { min: 1, max: 12 },
  maxAudience: { min: 0, max: 10_000 },
  streamDelaySec: { min: 0, max: 8 },
  audienceMin: { min: 1, max: 10_000 },
  reconnectGraceSec: { min: 0, max: 600 },
  audioLevel: { min: 0, max: 1 },
} as const;

/**
 * The defaults a new room starts with (SPEC §3, §4, §7, §8). Frozen so it can be shared;
 * copy it (for example with `structuredClone`) before changing anything.
 */
export const DEFAULT_ROOM_CONFIG: Readonly<RoomConfig> = deepFreeze({
  visibility: "private",
  maxPlayers: 8,
  maxAudience: 10_000,
  lateJoin: "audience",
  seatPick: "fifo",
  playlistMode: "audience-vote",
  antiSnipe: true,
  contentFilter: "standard",
  moderation: "off",
  hideCode: false,
  timerScale: 1,
  streamDelaySec: 3,
  audienceMin: 5,
  reconnectGraceSec: 60,
  teams: { mode: "none", count: 2 },
  scoring: "placement",
  theme: { ambient: "dusk", autoCycleMin: 0, audienceModeVote: false },
  streamLayout: { enabled: false, webcam: "none" },
  audio: { music: 0.6, sfx: 0.8, ambience: 0.5, streamerSafe: false },
  quality: "auto",
  playlist: [],
} satisfies RoomConfig);

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
