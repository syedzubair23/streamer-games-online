import { fileURLToPath } from "node:url";
import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

/**
 * Client build. The dev server proxies `/ws` (and `/api`) to the game server on
 * port 8787 (SPEC §9.2). M1-09 adds the two entry points (`stage`, `controller`)
 * and the chunk naming contract documented in the root `.size-limit.cjs`.
 *
 * `/dev/scenario` (SPEC §14) is a separate page (`dev/scenario.html`). It exists in dev and in
 * every non-production build and is left out of the production build. The harness builds it with
 * `--mode scenario` into `artifacts/tmp/scenario-client` (git-ignored, and outside `dist/`, which
 * a production build empties while a harness server may be serving the scenario build).
 */
const SERVER = process.env.SG_SERVER_URL ?? "http://localhost:8787";
const root = fileURLToPath(new URL(".", import.meta.url));

/** The HTML pages of a build: the app, plus the dev scenario page outside production. */
export function pageInputs(mode: string, base = root): Record<string, string> {
  const pages: Record<string, string> = { main: `${base}index.html` };
  if (mode !== "production") pages["dev/scenario"] = `${base}dev/scenario.html`;
  return pages;
}

/** Where `--mode scenario` builds go, relative to `apps/client` (see the header). */
export const SCENARIO_OUT_DIR = "../../artifacts/tmp/scenario-client";

/** Output directory per mode: harness builds never share the production `dist`. */
export function outDirFor(mode: string): string {
  return mode === "scenario" ? SCENARIO_OUT_DIR : "dist";
}

export default defineConfig(({ mode }) => ({
  plugins: [preact()],
  server: {
    port: 5173,
    proxy: {
      "/ws": { target: SERVER, ws: true, changeOrigin: true },
      "/api": { target: SERVER, changeOrigin: true },
    },
  },
  build: {
    target: "es2022",
    sourcemap: true,
    outDir: outDirFor(mode),
    emptyOutDir: true,
    rollupOptions: {
      input: pageInputs(mode),
    },
  },
}));
