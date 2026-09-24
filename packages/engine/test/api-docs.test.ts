/**
 * DOD P7: `docs/engine-api.md` is generated from the TSDoc of the public API and must be
 * regenerated whenever that API changes (`pnpm --filter @sg/engine api-docs`).
 */
import { describe, expect, it } from "vitest";
import { apiDocsUpToDate, renderApiDocs } from "../scripts/gen-api-docs.ts";

describe("docs/engine-api.md", () => {
  it("is up to date with the TSDoc (run `pnpm --filter @sg/engine api-docs`)", () => {
    expect(apiDocsUpToDate()).toBe(true);
  }, 60_000);

  it("documents every entry point and the core API", () => {
    const md = renderApiDocs();
    for (const heading of [
      "## `@sg/engine`",
      "## `@sg/engine/client`",
      "## `@sg/engine/testing`",
    ]) {
      expect(md).toContain(heading);
    }
    for (const name of [
      "GameModule",
      "GameRunner",
      "createTiming",
      "resolveScenario",
      "GameClientModule",
      "StageContext",
      "runContractSuite",
      "simulateGame",
      "pacingReport",
      "runScript",
      "fakeContent",
    ]) {
      expect(md).toMatch(new RegExp(`^#### ${name} [(]`, "m"));
    }
    expect(md).not.toMatch(/\b[A-Z]:[\\/]/); // no absolute local paths in a public doc
  }, 60_000);
});
