/**
 * Room settings for Odd One Out: the clue filter level (SPEC §7 `RoomConfig.contentFilter`,
 * §9.7) and whether the host holds a player seat (R11, Views table).
 *
 * The engine's `SetupContext` carries neither yet (docs/engine-requests.md ER-006 for the
 * content filter, ER-009 for the seated host). Until it does, the module reads an optional
 * `room` field from the setup context, and `createOddOneOut(room)` can pin the settings (tests,
 * scenarios, and the server until the engine lands the fields). Anything missing falls back to
 * the room defaults (`standard` filter, host not seated).
 *
 * @module
 */
import { DEFAULT_ROOM_CONFIG, type RoomConfig } from "@sg/shared";
import type { SetupContext } from "@sg/engine";
import type { OooRoomSettings } from "./types.ts";

/** A setup context that may carry the room settings (the shape ER-006 / ER-009 ask for). */
export type SetupContextWithRoom<O> = SetupContext<O> & {
  room?: Partial<RoomConfig> & { hostSeated?: boolean };
};

const FILTERS: readonly RoomConfig["contentFilter"][] = ["family", "standard"];

/**
 * Resolves the room settings: `override` first, then `ctx.room`, then the defaults. Invalid
 * values fall back to the defaults.
 */
export function resolveRoomSettings<O>(
  ctx: SetupContextWithRoom<O>,
  override: Partial<OooRoomSettings> = {},
): OooRoomSettings {
  const merged: { contentFilter?: unknown; hostSeated?: unknown } = { ...ctx.room, ...override };
  const filter = merged.contentFilter;
  return {
    contentFilter: FILTERS.includes(filter as RoomConfig["contentFilter"])
      ? (filter as RoomConfig["contentFilter"])
      : DEFAULT_ROOM_CONFIG.contentFilter,
    hostSeated: merged.hostSeated === true,
  };
}
