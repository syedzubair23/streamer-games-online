/**
 * Vitest projects for the monorepo (consumed by `vitest.config.ts` as `test.projects`).
 *
 * Every workspace package is its own project. A package may add a `vitest.config.ts`
 * (e.g. to use `happy-dom`); without one it runs with Vitest defaults in Node and is
 * named after its package.json `name`. Root-level tests (scaffold + lint-rule fixtures)
 * live in `test/`.
 */
import type { TestProjectConfiguration } from "vitest/config";

export const workspace: TestProjectConfiguration[] = [
  "packages/*",
  "packages/games/*",
  "apps/*",
  "tools/*",
  {
    test: {
      name: "root",
      include: ["test/**/*.test.ts"],
      environment: "node",
      testTimeout: 60_000,
    },
  },
];

export default workspace;
