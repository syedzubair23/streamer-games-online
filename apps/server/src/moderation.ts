/**
 * Moderation & safety (SPEC §9.7, ROADMAP M1-04): the production {@link ModerationPort}.
 *
 * On top of the review queue of {@link BasicModeration} (`reveal-review`: `moderate` items wait
 * in the `modq` for a host or moderator, the game's `onModeration` is withheld until then, and
 * an item still pending after 20 s resolves as rejected) it adds:
 *
 * - **Text screening of player actions.** A *text action* is an action object with a string
 *   `text` field (quip answers, doodle guesses and captions, clues, bluffs; every game spec
 *   uses this shape). In `family` mode the profanity filter masks matches (`****`) before the
 *   game ever sees the text; in `standard` mode the text passes unchanged and the Stage blurs
 *   flagged text itself. Names are filtered the same way at join (room manager) and on
 *   `rename`.
 * - **Mute.** `mod { c: "mute", id, minutes }` stops a member's text actions for `minutes`
 *   (0 lifts it); a muted player's text action is acked `{ ok: false, err: "MUTED" }`, and
 *   non-text actions (votes, moves) still work so a mute never takes a seat out of the game.
 * - **Rename.** `mod { c: "rename", id, name }` cleans (and in family mode masks) the name and
 *   rebroadcasts the room.
 * - **Ban bookkeeping.** With a {@link BanList}, the room's bans are forgotten when the room is
 *   destroyed.
 *
 * Only the host (panel) and moderators can send `mod` (session gate). Nobody can mute or
 * rename the host, and only the host can mute or rename a moderator.
 *
 * @module
 */
import {
  cleanName,
  createTextFilter,
  filterText,
  type ErrorCode,
  type TextFilter,
} from "@sg/shared";
import type { BanList } from "./bans.ts";
import {
  BasicModeration,
  type MemberModCommand,
  type ModerationContext,
  type ModerationFactory,
  type ScreenResult,
} from "./room.ts";
import type { Session } from "./session.ts";

/** Options for {@link createModeration}. */
export interface ModerationOptions {
  /** The server's ban list; the room's bans are dropped when the room is destroyed. */
  bans?: BanList;
  /** Extra blocked words on top of the default filter (obscenity English + house list). */
  extraTerms?: readonly string[];
}

/** Returns the `text` field of a text action, or null for any other action. */
export function actionText(action: unknown): string | null {
  if (typeof action !== "object" || action === null || Array.isArray(action)) return null;
  const text = (action as Record<string, unknown>)["text"];
  return typeof text === "string" ? text : null;
}

/** The production moderation port. See the module docs. */
export class Moderation extends BasicModeration {
  readonly #ctx: ModerationContext;
  readonly #bans: BanList | undefined;
  readonly #filter: TextFilter | null;
  /** Member id → server ms the mute ends. */
  readonly #muted = new Map<string, number>();

  constructor(ctx: ModerationContext, reviewTimeoutMs: number, o: ModerationOptions = {}) {
    super(ctx, reviewTimeoutMs);
    this.#ctx = ctx;
    this.#bans = o.bans;
    this.#filter =
      o.extraTerms !== undefined && o.extraTerms.length > 0
        ? createTextFilter({ extraTerms: o.extraTerms })
        : null;
  }

  /** Server ms a member's mute ends, or null when not muted. */
  mutedUntil(id: string): number | null {
    const until = this.#muted.get(id);
    if (until === undefined) return null;
    if (until <= this.#ctx.clock.now()) {
      this.#muted.delete(id);
      return null;
    }
    return until;
  }

  /** Filters `text` for the room's content filter mode. */
  filter(text: string): string {
    const mode = this.#ctx.room.config.contentFilter;
    return (this.#filter?.filter(text, mode) ?? filterText(text, mode)).text;
  }

  screenAction(session: Session, action: unknown): ScreenResult {
    const text = actionText(action);
    if (text === null) return { ok: true, action };
    if (this.mutedUntil(session.id) !== null) return { ok: false, err: "MUTED" };
    const filtered = this.filter(text);
    if (filtered === text) return { ok: true, action };
    return { ok: true, action: { ...(action as Record<string, unknown>), text: filtered } };
  }

  modCommand(from: Session, cmd: MemberModCommand): { code: ErrorCode; msg: string } | null {
    const target = this.#ctx.room.byId.get(cmd.id);
    if (target === undefined || target.role === "overlay")
      return { code: "ILLEGAL", msg: `no member ${cmd.id}` };
    if (target.id === this.#ctx.room.hostId || target.role === "host")
      return { code: "NOT_ALLOWED", msg: `the host cannot be ${cmd.c}d` };
    if (target.role === "moderator" && from.role !== "host")
      return { code: "NOT_ALLOWED", msg: `only the host can ${cmd.c} a moderator` };

    if (cmd.c === "mute") {
      if (cmd.minutes <= 0) {
        if (this.#muted.delete(target.id))
          this.#ctx.fanout.toMember(target.id, { t: "fx", events: [{ name: "unmuted" }] });
        return null;
      }
      const until = this.#ctx.clock.now() + cmd.minutes * 60_000;
      this.#muted.set(target.id, until);
      this.#ctx.fanout.toMember(target.id, {
        t: "fx",
        events: [{ name: "muted", data: { until } }],
      });
      return null;
    }

    const cleaned = cleanName(cmd.name);
    if (cleaned === "") return { code: "ILLEGAL", msg: "a name needs at least one character" };
    const name = this.#ctx.room.config.contentFilter === "family" ? this.filter(cleaned) : cleaned;
    if (name !== target.name) {
      target.name = name;
      this.#ctx.roomChanged();
    }
    return null;
  }

  override dispose(): void {
    super.dispose();
    this.#muted.clear();
    this.#bans?.forget(this.#ctx.room);
  }
}

/** A {@link ModerationFactory} for {@link RoomActorOptions.moderation}. */
export function createModeration(o: ModerationOptions = {}): ModerationFactory {
  return (ctx, reviewTimeoutMs) => new Moderation(ctx, reviewTimeoutMs, o);
}
