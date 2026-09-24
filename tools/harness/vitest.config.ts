import { defineProject } from "vitest/config";

/**
 * Vitest project for `@sg/harness`. Only `test/**` holds Vitest tests: the `*.spec.ts` files in
 * this package are Playwright specs (run by `playwright test` / `pnpm verify:game`).
 */
export default defineProject({
  test: {
    name: "@sg/harness",
    include: ["test/**/*.test.ts"],
  },
});
