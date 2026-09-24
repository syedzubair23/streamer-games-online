// @ts-check
/**
 * Bundle budgets (SPEC §10, DOD P5/G8a), measured gzip by size-limit.
 *
 * Two kinds of entries:
 *  - package entries, bundled from source with esbuild (always measurable), and
 *  - built client chunks under apps/client/dist, measured as files. These are only
 *    listed once the matching files exist (`pnpm build` first), so `pnpm size` stays
 *    usable before the client shell (M1-09) and the game clients (Mx-03/Mx-04) exist.
 *
 * Built chunk naming contract for apps/client's Vite config (rollup `output.chunkFileNames`/
 * `entryFileNames`): `assets/stage-*.js`, `assets/controller-*.js`, `assets/audience-*.js`,
 * and per game `assets/game-<id>-stage-*.js` / `assets/game-<id>-controller-*.js`.
 */
const { globSync } = require("node:fs");

const GAMES = [
  "quip-clash",
  "tune-in",
  "trivia-night",
  "doodle",
  "odd-one-out",
  "ludo",
  "chess",
  "marble-rally",
];

/** @param {string} pattern */
const exists = (pattern) => globSync(pattern).length > 0;

/** @type {Array<{ name: string; path: string; limit: string; ignore?: string[] }>} */
const sourceEntries = [
  {
    name: "@sg/ui kit (without preact)",
    path: "packages/ui/src/index.ts",
    limit: "25 KB",
    ignore: ["preact", "@preact/signals", "@preact/signals-core"],
  },
  {
    name: "@sg/audio",
    path: "packages/audio/src/index.ts",
    limit: "12 KB",
  },
];

/** @type {Array<{ name: string; path: string; limit: string }>} */
const builtCandidates = [
  { name: "Stage shell", path: "apps/client/dist/assets/stage-*.js", limit: "180 KB" },
  { name: "Controller shell", path: "apps/client/dist/assets/controller-*.js", limit: "70 KB" },
  { name: "Audience lite route", path: "apps/client/dist/assets/audience-*.js", limit: "60 KB" },
  ...GAMES.flatMap((id) => [
    {
      name: `${id} stage chunk`,
      path: `apps/client/dist/assets/game-${id}-stage-*.js`,
      limit: id === "marble-rally" ? "70 KB" : "60 KB",
    },
    {
      name: `${id} controller chunk`,
      path: `apps/client/dist/assets/game-${id}-controller-*.js`,
      limit: "25 KB",
    },
  ]),
];

module.exports = [
  ...sourceEntries.map((e) => ({ ...e, gzip: true })),
  ...builtCandidates
    .filter((e) => exists(e.path))
    .map((e) => ({ ...e, gzip: true, esbuild: false })),
];
