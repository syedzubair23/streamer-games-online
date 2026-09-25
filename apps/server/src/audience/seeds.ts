/**
 * Seeds, the audience's prediction currency (SPEC §4): every audience member starts with
 * {@link SEEDS_START} and a balance never drops below {@link SEEDS_FLOOR}. `predict` polls stake
 * a fixed amount ({@link DEFAULT_PREDICT_STAKE}, host-configurable) and pay out pari-mutuel
 * when the game emits `audience.resolve`.
 *
 * The floor also limits the stake: a member can only stake Seeds they can actually lose, the
 * part of their balance above the floor ({@link stakeable}). A member at the floor still
 * votes but stakes nothing, so the pari-mutuel pool is exactly what the losers lose and a
 * resolve never creates Seeds. Everyone stays in the game all night; nobody bets risk-free.
 *
 * @module
 */
import type { AudId } from "@sg/shared";

/** Starting balance of every audience member (SPEC §4). */
export const SEEDS_START = 1000;
/** A balance never drops below this (SPEC §4). */
export const SEEDS_FLOOR = 100;
/** Default `predict` stake (SPEC §4: 100 Seeds, host-configurable). */
export const DEFAULT_PREDICT_STAKE = 100;

/** One member's stake on one option of a `predict` poll. */
export interface Stake {
  option: string;
  amount: number;
}

/**
 * Pari-mutuel settlement: all stakes form one pool, and the members who backed `winner`
 * split it in proportion to their stakes (rounded down, so the house never pays more than the
 * pool). Losers lose their stake. When nobody backed the winner (or `winner` is `null`, a
 * cancelled prediction) every stake is refunded: every delta is 0.
 *
 * Returns each member's net change (payout minus stake), before the {@link SEEDS_FLOOR} clamp.
 */
export function parimutuel(
  stakes: ReadonlyMap<AudId, Stake>,
  winner: string | null,
): Map<AudId, number> {
  let pool = 0;
  let winPool = 0;
  for (const s of stakes.values()) {
    pool += s.amount;
    if (s.option === winner) winPool += s.amount;
  }
  const out = new Map<AudId, number>();
  for (const [id, s] of stakes) {
    if (winner === null || winPool === 0) out.set(id, 0);
    else if (s.option === winner) out.set(id, Math.floor((s.amount * pool) / winPool) - s.amount);
    else out.set(id, -s.amount);
  }
  return out;
}

/**
 * The stake a member can place: `want`, capped at their balance above the floor (never
 * negative). Staking this much can never take the balance below the floor.
 */
export function stakeable(ledger: SeedLedger, id: AudId, want: number): number {
  return Math.max(0, Math.min(Math.trunc(want), ledger.balance(id) - ledger.floor));
}

/**
 * Implied decimal odds per option (pool ÷ option pool) for a `predict` poll with equal
 * stakes, from its live tallies. An option nobody backed has no odds (`null`). Clients show
 * these next to the tallies; the server broadcasts only the tallies.
 */
export function impliedOdds(
  tallies: Readonly<Record<string, number>>,
): Record<string, number | null> {
  let total = 0;
  for (const n of Object.values(tallies)) total += n;
  const out: Record<string, number | null> = {};
  for (const [id, n] of Object.entries(tallies)) out[id] = n > 0 ? total / n : null;
  return out;
}

/** Every audience member's Seeds balance, clamped at {@link SEEDS_FLOOR}. */
export class SeedLedger {
  readonly #balances = new Map<AudId, number>();
  readonly #won = new Map<AudId, number>();

  constructor(
    readonly start = SEEDS_START,
    readonly floor = SEEDS_FLOOR,
  ) {}

  /** Current balance (members who never predicted hold {@link start}). */
  balance(id: AudId): number {
    return this.#balances.get(id) ?? this.start;
  }

  /** Net Seeds won so far (payouts minus lost stakes after the floor clamp; may be negative). */
  won(id: AudId): number {
    return this.#won.get(id) ?? 0;
  }

  /** Applies a net change, clamped so the balance never drops below the floor. Returns it. */
  apply(id: AudId, delta: number): number {
    const before = this.balance(id);
    const after = Math.max(this.floor, before + Math.trunc(delta));
    this.#balances.set(id, after);
    this.#won.set(id, this.won(id) + (after - before));
    return after;
  }

  /** Members with a ledger entry. */
  ids(): IterableIterator<AudId> {
    return this.#balances.keys();
  }
}
