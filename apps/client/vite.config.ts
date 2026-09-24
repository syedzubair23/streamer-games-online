import { fileURLToPath } from "node:url";
import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

/**
 * Client build. The dev server proxies `/ws` (and `/api`) to the game server on
 * port 8787 (SPEC §9.2). M1-09 adds the two entry points (`stage`, `controller`)
 * and the chunk naming contract documented in the root `.size-limit.cjs`.
 *
 * `/dev/scenario` (SPEC §14) is a separate page (`dev/scenario.html`). It exists in dev and in
 * every non-production build (the harness builds with `--mode scenario`, into `dist/scenario`)
 * and is left out of the production build.
 */
const SERVER = process.env.SG_SERVER_URL ?? "http://localhost:8787";
const root = fileURLToPath(new URL(".", import.meta.url));

/** The HTML pages of a build: the app, plus the dev scenario page outside production. */
export function pageInputs(mode: string, base = root): Record<string, string> {
  const pages: Record<string, string> = { main: `${base}index.html` };
  if (mode !== "production") pages["dev/scenario"] = `${base}dev/scenario.html`;
  return pages;
}

/** Output directory per mode: harness builds never overwrite the production `dist`. */
export function outDirFor(mode: string): string {
  return mode === "scenario" ? "dist/scenario" : "dist";
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
    rollupOptions: {
      input: pageInputs(mode),
    },
  },
}));
