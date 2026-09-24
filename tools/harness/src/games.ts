/**
 * Where each game's pieces live, for `verify-game` and the Playwright specs.
 *
 * The eight launch games follow the standard package layout (SPEC §9.2, ROADMAP game template):
 * `packages/games/<id>/{src/logic, src/scenarios.ts, src/client/{stage.ts, controller.tsx},
 * test/{logic, contract, sim, pacing, content}.test.ts}` with their spec in `docs/specs/<id>.md`.
 *
 * `tictactoe` is the engine's reference fixture (ROADMAP M0-04/M0-05): its logic, scenarios and
 * minimal client live in `packages/engine/test/fixtures/tictactoe/`, its gate tests in the engine
 * suite plus `tools/harness/test/fixture-tictactoe.test.ts`, and its spec (Scenarios table and
 * perf script only) in `tools/harness/fixtures/tictactoe.md`.
 *
 * @module
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

/** The eight launch games (SPEC §6). */
export const LAUNCH_GAMES = [
  "quip-clash",
  "tune-in",
  "trivia-night",
  "doodle",
  "odd-one-out",
  "ludo",
  "chess",
  "marble-rally",
] as const;

/** A test run a gate needs: a vitest project, files, and an optional name filter. */
export interface TestRun {
  project: string;
  /** Test files relative to the repo root. */
  files: string[];
  /** `vitest -t` filter. */
  filter?: string;
}

/** Everything the harness needs to know about one game. */
export interface GameTarget {
  id: string;
  fixture: boolean;
  /** Spec file (repo-relative). */
  spec: string;
  /** Package directory (repo-relative). */
  pkgDir: string;
  /** tsconfig for G1 (repo-relative). */
  tsconfig: string;
  /** Paths eslint checks for G2 (repo-relative). */
  lint: string[];
  /** Module + export that hold the ScenarioRegistry (repo-relative path). */
  scenarios: { module: string; export: string };
  /** Module + export that hold the GameModule. */
  logic: { module: string; export: string };
  /** Glob of the logic sources G3 measures branch coverage on. */
  logicCoverage: string;
  /** Test runs per gate. `null`: the gate's test file does not exist (the gate fails). */
  tests: {
    G3: TestRun | null;
    G4: TestRun | null;
    G5: TestRun | null;
    G11: TestRun | null;
    G14: TestRun | null;
  };
  /** Client entry files for the G8a chunk sizes (repo-relative); null when missing. */
  chunks: { stage: string | null; controller: string | null };
  /** Max gz KB of the stage chunk (SPEC §10: 60, Marble Rally 70) and the controller chunk. */
  chunkLimitsKB: { stage: number; controller: number };
}

/** Whether `id` is a launch game or the fixture. */
export function isKnownGame(id: string): boolean {
  return id === "tictactoe" || (LAUNCH_GAMES as readonly string[]).includes(id);
}

const ifExists = (root: string, rel: string): string | null =>
  existsSync(join(root, rel)) ? rel : null;

/** The harness target for a game id. */
export function gameTarget(root: string, id: string): GameTarget {
  if (!isKnownGame(id))
    throw new Error(`unknown game "${id}" (known: tictactoe, ${LAUNCH_GAMES.join(", ")})`);
  if (id === "tictactoe") {
    const fx = "packages/engine/test/fixtures/tictactoe";
    const engine = "@sg/engine";
    return {
      id,
      fixture: true,
      spec: "tools/harness/fixtures/tictactoe.md",
      pkgDir: "packages/engine",
      tsconfig: "packages/engine/tsconfig.json",
      lint: [fx],
      scenarios: { module: `${fx}/scenarios.ts`, export: "tictactoeScenarios" },
      logic: { module: `${fx}/logic.ts`, export: "tictactoe" },
      logicCoverage: `${fx}/logic.ts`,
      tests: {
        // The whole engine suite exercises the fixture's rules (runner, scripts, contract, sim).
        G3: { project: engine, files: ["packages/engine/test/"] },
        G4: {
          project: engine,
          files: ["packages/engine/test/contract.test.ts"],
          filter: "contract: tictactoe",
        },
        G5: {
          project: "@sg/harness",
          files: ["tools/harness/test/fixture-tictactoe.test.ts"],
          filter: "G5",
        },
        // The fixture declares no content packs: nothing for G11 to check.
        G11: null,
        G14: {
          project: "@sg/harness",
          files: ["tools/harness/test/fixture-tictactoe.test.ts"],
          filter: "G14",
        },
      },
      chunks: { stage: `${fx}/client.ts`, controller: `${fx}/client.ts` },
      chunkLimitsKB: { stage: 60, controller: 25 },
    };
  }
  const pkg = `packages/games/${id}`;
  const project = `@sg/game-${id}`;
  const run = (file: string): TestRun | null => {
    const rel = ifExists(root, `${pkg}/test/${file}`);
    return rel === null ? null : { project, files: [rel] };
  };
  return {
    id,
    fixture: false,
    spec: `docs/specs/${id}.md`,
    pkgDir: pkg,
    tsconfig: `${pkg}/tsconfig.json`,
    lint: [pkg],
    scenarios: { module: `${pkg}/src/scenarios.ts`, export: "scenarios" },
    logic: { module: `${pkg}/src/logic/index.ts`, export: "logic" },
    logicCoverage: `${pkg}/src/logic/**`,
    tests: {
      G3: run("logic.test.ts"),
      G4: run("contract.test.ts"),
      G5: run("sim.test.ts"),
      G11: run("content.test.ts"),
      G14: run("pacing.test.ts"),
    },
    chunks: {
      stage: ifExists(root, `${pkg}/src/client/stage.ts`),
      controller: ifExists(root, `${pkg}/src/client/controller.tsx`),
    },
    chunkLimitsKB: { stage: id === "marble-rally" ? 70 : 60, controller: 25 },
  };
}
