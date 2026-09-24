import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

/**
 * Client build. The dev server proxies `/ws` (and `/api`) to the game server on
 * port 8787 (SPEC §9.2). M1-09 adds the two entry points (`stage`, `controller`)
 * and the chunk naming contract documented in the root `.size-limit.cjs`.
 */
const SERVER = process.env.SG_SERVER_URL ?? "http://localhost:8787";

export default defineConfig({
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
  },
});
