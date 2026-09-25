import { defineProject } from "vitest/config";

/**
 * Vitest project for `@sg/render`. Only `test/**\/*.test.ts` are Vitest tests: the
 * `test/browser/*.spec.ts` files are Playwright specs that need real WebGL and a real 2D canvas
 * (run with `pnpm --filter @sg/render test:browser`).
 */
export default defineProject({
  test: {
    name: "@sg/render",
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
