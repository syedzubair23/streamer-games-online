/**
 * The audience leaderboard (SPEC §5): play-along points plus Seeds won. Points come from
 * `quiz`, `dial` and `guess` polls scored by the platform, and from `audience.award` effects
 * (Marble Rally race results). The Scoreboard shows the top 5; each phone shows its own rank.
 *
 * @module
 */
import type { AudId } from "@sg/shared";
import { SeedLedger } from "./seeds.ts";

/** One row of the audience leaderboard. */
export interface AudienceRow {
  audId: AudId;
  name: string;
  /** Play-along points. */
  points: number;
  /** Current Seeds balance. */
  seeds: number;
  /** Ranking score: points plus Seeds won (net winnings; losses do not subtract). */
  score: number;
  /** 1-based; ties share the higher place. */
  place: number;
}

/** Play-along points and Seeds for every audience member of a room. */
export class Leaderboard {
  readonly seeds: SeedLedger;
  readonly #points = new Map<AudId, number>();
  readonly #names = new Map<AudId, string>();
  /** Order of first appearance: the stable tie-break. */
  readonly #order = new Map<AudId, number>();

  constructor(seeds = new SeedLedger()) {
    this.seeds = seeds;
  }

  /** Records (or refreshes) a member's display name. */
  see(id: AudId, name: string): void {
    this.#names.set(id, name);
    if (!this.#order.has(id)) this.#order.set(id, this.#order.size);
  }

  /** Adds play-along points (non-finite or non-positive amounts are ignored). Returns the total. */
  addPoints(id: AudId, points: number, name?: string): number {
    if (name !== undefined) this.see(id, name);
    else if (!this.#order.has(id)) this.see(id, id);
    const n = Math.trunc(points);
    const total = this.points(id) + (Number.isFinite(n) && n > 0 ? n : 0);
    this.#points.set(id, total);
    return total;
  }

  /** A member's play-along points. */
  points(id: AudId): number {
    return this.#points.get(id) ?? 0;
  }

  /** A member's ranking score: points plus positive Seeds won. */
  score(id: AudId): number {
    return this.points(id) + Math.max(0, this.seeds.won(id));
  }

  /** Every known member, ranked (score desc, then first appearance). */
  rows(): AudienceRow[] {
    const ids = [...this.#order.keys()];
    const scored = ids.map((audId) => ({
      audId,
      name: this.#names.get(audId) ?? audId,
      points: this.points(audId),
      seeds: this.seeds.balance(audId),
      score: this.score(audId),
      place: 0,
      at: this.#order.get(audId) ?? 0,
    }));
    scored.sort((a, b) => b.score - a.score || a.at - b.at);
    let place = 0;
    let prev = Number.NaN;
    return scored.map((r, i) => {
      if (r.score !== prev) place = i + 1;
      prev = r.score;
      const { at: _at, ...row } = r;
      return { ...row, place };
    });
  }

  /** The top `n` rows (the Scoreboard shows 5). */
  top(n = 5): AudienceRow[] {
    return this.rows().slice(0, Math.max(0, n));
  }

  /** A member's row (their own rank on their phone), or `null` if unknown. */
  rowOf(id: AudId): AudienceRow | null {
    return this.rows().find((r) => r.audId === id) ?? null;
  }
}
