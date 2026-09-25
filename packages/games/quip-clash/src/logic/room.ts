/**
 * Room settings for Quip Clash (SPEC §7 `RoomConfig`: `contentFilter`, `moderation`,
 * `audienceMin`).
 *
 * The engine's `SetupContext` does not pass these yet. Until it does
 * (docs/engine-requests.md ER-006), the module reads an optional `room` field from the setup
 * context, and `createQuipClash(room)` can pin them (tests, scenarios, and the server until the
 * engine lands the field). Anything missing falls back to `DEFAULT_ROOM_CONFIG`.
 *
 * @module
 */
import { DEFAULT_ROOM_CONFIG, type RoomConfig } from "@sg/shared";
import type { SetupContext } from "@sg/engine";
import type { QcRoomSettings } from "./types.ts";

/** A setup context that may carry the room settings (the shape ER-006 asks for). */
export type SetupContextWithRoom<O> = SetupContext<O> & { room?: Partial<RoomConfig> };

const FILTERS: readonly RoomConfig["contentFilter"][] = ["family", "standard"];
const MODERATION: readonly RoomConfig["moderation"][] = ["off", "reveal-review"];

/**
 * Resolves the room settings: `override` first, then `ctx.room`, then the room defaults.
 * Invalid values fall back to the defaults.
 */
export function resolveRoomSettings<O>(
  ctx: SetupContextWithRoom<O>,
  override: Partial<QcRoomSettings> = {},
): QcRoomSettings {
  const merged: Partial<RoomConfig> = { ...ctx.room, ...override };
  const filter = merged.contentFilter;
  const moderation = merged.moderation;
  const min = merged.audienceMin;
  return {
    contentFilter:
      filter !== undefined && FILTERS.includes(filter) ? filter : DEFAULT_ROOM_CONFIG.contentFilter,
    moderation:
      moderation !== undefined && MODERATION.includes(moderation)
        ? moderation
        : DEFAULT_ROOM_CONFIG.moderation,
    audienceMin:
      typeof min === "number" && Number.isInteger(min) && min >= 1
        ? min
        : DEFAULT_ROOM_CONFIG.audienceMin,
  };
}
