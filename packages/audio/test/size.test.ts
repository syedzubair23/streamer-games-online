import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

/** SPEC §10 / ROADMAP M1-08: the package is 12 KB gz or less (also `pnpm size`). */
const LIMIT_BYTES = 12_000;

describe("@sg/audio bundle budget (ROADMAP M1-08 Accept 4)", () => {
  it("bundles (all exports kept, minified, deps included) to ≤ 12 KB gzip", async () => {
    const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
    const out = await build({
      entryPoints: [entry],
      bundle: true,
      minify: true,
      format: "esm",
      write: false,
      platform: "browser",
      target: "es2022",
      logLevel: "silent",
    });
    const js = out.outputFiles[0]?.contents;
    if (!js) throw new Error("no output");
    const gz = gzipSync(js, { level: 9 }).length;
    expect(gz).toBeGreaterThan(1000);
    expect(gz).toBeLessThanOrEqual(LIMIT_BYTES);
  }, 60_000);
});
