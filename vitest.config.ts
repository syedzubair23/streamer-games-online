import { defineConfig } from "vitest/config";
import { workspace } from "./vitest.workspace.ts";

export default defineConfig({
  test: {
    projects: workspace,
    passWithNoTests: true,
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary", "html"],
      reportsDirectory: "coverage",
      include: ["packages/**/src/**", "apps/**/src/**", "tools/**/src/**", "tools/harness/*.ts"],
      exclude: ["**/*.d.ts", "**/test/**", "**/*.test.ts", "**/*.spec.ts"],
    },
  },
});
