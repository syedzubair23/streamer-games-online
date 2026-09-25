/**
 * `tap` (SPEC §4): members tap as fast as they like, but at most {@link TAP_MAX_PER_SEC} taps
 * per second count per member (a token bucket, so a batched `{ n ≤ 10 }` message is trimmed to
 * what the bucket holds). Broadcast and result: the total taps. Cosmetic meters only.
 *
 * @module
 */
import type { AudId, PublicPollResult } from "@sg/shared";
import type { PollResult, PollSpec } from "@sg/engine";
import { BallotPoll, type InputOutcome, type Live, type PollEnv, type Voter } from "./types.ts";

/** At most 5 taps per second count per member (SPEC §4). */
export const TAP_MAX_PER_SEC = 5;
/** A `tap` message carries at most 10 taps (SPEC §9.6). */
export const TAP_MAX_BATCH = 10;

interface Bucket {
  tokens: number;
  at: number;
}

/** A `tap` poll. */
export class TapPoll extends BallotPoll<number> {
  readonly #buckets = new Map<AudId, Bucket>();
  #taps = 0;

  constructor(spec: PollSpec) {
    super(spec);
  }

  /** Total counted taps. */
  get taps(): number {
    return this.#taps;
  }

  vote(): InputOutcome {
    return { ok: false, reason: "kind" };
  }

  override tap(voter: Voter, n: number, env: PollEnv): InputOutcome {
    if (!Number.isInteger(n) || n < 1 || n > TAP_MAX_BATCH) return { ok: false, reason: "invalid" };
    const b = this.#buckets.get(voter.audId) ?? { tokens: TAP_MAX_PER_SEC, at: env.now };
    b.tokens = Math.min(TAP_MAX_PER_SEC, b.tokens + ((env.now - b.at) * TAP_MAX_PER_SEC) / 1000);
    b.at = env.now;
    const counted = Math.min(n, Math.floor(b.tokens));
    this.#buckets.set(voter.audId, b);
    if (counted <= 0) return { ok: false, reason: "rate" };
    b.tokens -= counted;
    this.#taps += counted;
    const prev = this.ballots.get(voter.audId)?.value ?? 0;
    this.record(voter, prev + counted, env.now);
    return { ok: true, changed: true };
  }

  override live(): Live {
    return { tallies: { taps: this.#taps }, total: this.ballots.size };
  }

  override result(): PollResult {
    const r: PollResult = {
      pollId: this.spec.pollId,
      kind: "tap",
      total: this.ballots.size,
      tallies: { taps: this.#taps },
    };
    if (this.spec.teamSplit === true) {
      const byTeam: Record<string, Record<string, number>> = {};
      for (const b of this.ballots.values())
        if (b.teamId !== undefined) {
          const t = (byTeam[b.teamId] ??= { taps: 0 });
          t["taps"] = (t["taps"] ?? 0) + b.value;
        }
      r.byTeam = byTeam;
    }
    return r;
  }

  override closedPublic(): PublicPollResult {
    return { ...this.result() };
  }
}
