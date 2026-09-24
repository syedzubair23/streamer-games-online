/**
 * Game-gate tests for the tictactoe harness fixture, so `pnpm verify:game tictactoe` runs the same
 * gates a launch game does (ROADMAP M0-05). The logic-level gates of a real game live in its own
 * `test/{sim,pacing}.test.ts`; the fixture's live here because its code is engine-owned.
 *
 * - **G5**: 1,000 seeded bot-vs-bot games: 0 exceptions, 0 illegal actions, every game ends
 *   within its max-steps bound, the board invariants hold after every step, and no seat wins more
 *   than 1.25 / N of the games.
 * - **G14**: the pacing report over 50 seeds per player count passes `checkPacing`, and is written
 *   to `artifacts/verify/tictactoe-pacing.json`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tictactoe, type TttState } from "@sg/engine/fixtures/tictactoe";
import { checkPacing, pacingReport, simulateGame } from "@sg/engine/testing";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
/** A tictactoe game has at most 9 moves; with intro/result/poll events 200 steps is a hard bound. */
const MAX_STEPS = 200;

function boardInvariants(s: TttState): string | null {
  const x = s.board.filter((m) => m === 0).length;
  const o = s.board.filter((m) => m === 1).length;
  if (x + o !== s.moves) return `moves ${s.moves} but ${x + o} marks`;
  if (s.history.length !== s.moves) return "history length differs from moves";
  if (Math.abs(x - o) > 1) return `mark counts ${x}/${o}`;
  if (s.winner !== null && s.draw) return "both a winner and a draw";
  return null;
}

describe("tictactoe fixture gates", () => {
  it("G5: 1,000 seeded bot games end cleanly, legally and fairly", () => {
    const wins = [0, 0];
    let maxSteps = 0;
    let illegal = 0;
    let unfinished = 0;
    const broken: string[] = [];
    for (let seed = 1; seed <= 1000; seed++) {
      const sim = simulateGame(tictactoe, {
        seed,
        players: 2,
        maxSteps: MAX_STEPS,
        onStep: ({ state }) => {
          const problem = boardInvariants(state);
          if (problem !== null && broken.length < 5) broken.push(`seed ${seed}: ${problem}`);
        },
      });
      maxSteps = Math.max(maxSteps, sim.steps);
      illegal += sim.illegalActions;
      if (!sim.ended) unfinished++;
      const top = sim.result?.ranking[0];
      const tie = sim.result?.ranking[1]?.place === top?.place;
      if (top !== undefined && !tie) {
        const seat = Number(top.id.slice(1)) - 1;
        wins[seat] = (wins[seat] ?? 0) + 1;
      }
    }
    const rates = wins.map((w) => w / 1000);
    const bound = 1.25 / 2;
    const ok =
      broken.length === 0 &&
      unfinished === 0 &&
      illegal === 0 &&
      maxSteps <= MAX_STEPS &&
      rates.every((r) => r <= bound);
    mkdirSync(join(ROOT, "artifacts/verify"), { recursive: true });
    writeFileSync(
      join(ROOT, "artifacts/verify/tictactoe-sim.json"),
      `${JSON.stringify({ ok, games: 1000, maxSteps, seatWinRates: rates }, null, 2)}\n`,
    );
    expect(broken).toEqual([]);
    expect(unfinished).toBe(0);
    expect(illegal).toBe(0);
    expect(maxSteps).toBeLessThanOrEqual(MAX_STEPS);
    for (const r of rates) expect(r).toBeLessThanOrEqual(bound);
  });

  it("G14: pacing over 50 seeds passes and is written to artifacts/verify/tictactoe-pacing.json", () => {
    const report = pacingReport(tictactoe, { seeds: 50 });
    const verdict = checkPacing(report);
    const path = join(ROOT, "artifacts/verify/tictactoe-pacing.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ ...report, verdict }, null, 2)}\n`);
    expect(verdict.failures).toEqual([]);
    expect(verdict.ok).toBe(true);
  });
});
