// @ts-check
/**
 * Root ESLint flat config for the whole monorepo.
 *
 * Besides the usual TypeScript hygiene, this file enforces the architecture from
 * docs/SPEC.md §9.1–§9.2 and the lint gates from docs/DOD.md (P2, G2):
 *  - package boundaries (eslint-plugin-boundaries + import bans): no game imports another game,
 *    `logic/**` stays pure, `apps/server` never reaches a client entry;
 *  - determinism: no `Math.random` / `Date` / wall clocks / timers in `**\/logic/**`;
 *  - three.js hygiene: no `import * as THREE`, no direct `new *Material` outside `@sg/render`;
 *  - one platform-owned render loop: no raw `requestAnimationFrame` in games;
 *  - tokens only: no colour or duration literals in `games/*\/src/client/**`;
 *  - phones stay light: controller/audience entries never statically import three or @sg/render;
 *  - every `eslint-disable` carries a `-- reason`.
 *
 * `test/eslint-rules.test.ts` holds fixture tests proving each of these rules fires.
 */
import js from "@eslint/js";
import comments from "@eslint-community/eslint-plugin-eslint-comments/configs";
import boundaries from "eslint-plugin-boundaries";
import globals from "globals";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

const GAME_FILES = ["packages/games/*/src/**/*.{ts,tsx}"];
const LOGIC_FILES = ["**/logic/**/*.{ts,tsx,js,mjs}"];
const GAME_CLIENT_FILES = ["packages/games/*/src/client/**/*.{ts,tsx}"];
const PHONE_ENTRY_FILES = [
  "packages/games/*/src/client/controller.tsx",
  "packages/games/*/src/client/audience.tsx",
];

/** `import * as THREE from "three"` (or any namespace import of three) is banned everywhere. */
const NO_THREE_NAMESPACE = {
  selector: "ImportDeclaration[source.value=/^three(\\/.*)?$/] > ImportNamespaceSpecifier",
  message: "Use named imports from three (tree-shaking; SPEC §9.1 bans `import * as THREE`).",
};

/** Direct material construction; only the factories in @sg/render/materials may do this. */
const NO_DIRECT_MATERIAL = {
  selector: "NewExpression[callee.name=/Material$/]",
  message:
    "Materials come only from ctx.materials / @sg/render material factories (SPEC §10, DOD G2).",
};
const NO_DIRECT_MATERIAL_MEMBER = {
  selector: "NewExpression[callee.type='MemberExpression'][callee.property.name=/Material$/]",
  message: NO_DIRECT_MATERIAL.message,
};

/** Hex / rgb() / hsl() colour strings. */
const COLOUR_STRING = String.raw`/^\s*(#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|(rgba?|hsla?|oklch|oklab|lab|lch|hwb|color)\(.*\))\s*$/`;
/** CSS duration strings such as "300ms", "2.5s", or a transition shorthand containing one. */
const DURATION_STRING = String.raw`/(^|[\s,(])-?\d*\.?\d+m?s(?=$|[\s,)])/`;
const NO_TOKEN_LITERALS = [
  {
    selector: `Literal[value=${COLOUR_STRING}]`,
    message: "No literal colours in game clients: use @sg/ui tokens (SPEC §13, DOD G2).",
  },
  {
    selector: `TemplateElement[value.raw=${COLOUR_STRING}]`,
    message: "No literal colours in game clients: use @sg/ui tokens (SPEC §13, DOD G2).",
  },
  {
    selector: "Literal[raw=/^0x[0-9a-fA-F]{6}$/]",
    message:
      "No literal hex colours (0xRRGGBB) in game clients: use @sg/ui tokens (SPEC §13, DOD G2).",
  },
  {
    selector: `Literal[value=${DURATION_STRING}]`,
    message: "No literal durations in game clients: use motion tokens (SPEC §13.4, DOD G2).",
  },
  {
    selector: `TemplateElement[value.raw=${DURATION_STRING}]`,
    message: "No literal durations in game clients: use motion tokens (SPEC §13.4, DOD G2).",
  },
  {
    selector:
      "CallExpression[callee.name=/^(setTimeout|setInterval)$/] > Literal.arguments:nth-child(2)",
    message: "No literal timer durations in game clients: use motion tokens (SPEC §13.4, DOD G2).",
  },
];

const RAF_GLOBALS = [
  {
    name: "requestAnimationFrame",
    message: "Games never own a loop: use the platform render loop (SPEC §10).",
  },
  {
    name: "cancelAnimationFrame",
    message: "Games never own a loop: use the platform render loop (SPEC §10).",
  },
];
const RAF_PROPERTIES = ["window", "globalThis", "self"].flatMap((object) =>
  ["requestAnimationFrame", "cancelAnimationFrame"].map((property) => ({
    object,
    property,
    message: "Games never own a loop: use the platform render loop (SPEC §10).",
  })),
);

const LOGIC_MSG =
  "logic/** is pure and deterministic: use ctx.rng, ctx.now and ctx.timing (SPEC §9.3, DOD G2).";
const LOGIC_GLOBALS = [
  "Date",
  "performance",
  "setTimeout",
  "setInterval",
  "setImmediate",
  "clearTimeout",
  "clearInterval",
  "queueMicrotask",
  "crypto",
  "process",
  "window",
  "document",
  "navigator",
  "localStorage",
  "sessionStorage",
  "fetch",
  "requestAnimationFrame",
].map((name) => ({ name, message: LOGIC_MSG }));
const LOGIC_PROPERTIES = [
  { object: "Math", property: "random", message: LOGIC_MSG },
  ...["globalThis", "window", "self"].flatMap((object) =>
    ["Date", "performance", "crypto", "setTimeout", "setInterval"].map((property) => ({
      object,
      property,
      message: LOGIC_MSG,
    })),
  ),
];
const LOGIC_IMPORT_PATTERNS = [
  {
    group: ["three", "three/*"],
    message: "logic/** may not import three (SPEC §9.2).",
  },
  {
    group: ["@sg/render", "@sg/render/*", "@sg/ui", "@sg/ui/*", "@sg/audio", "@sg/audio/*"],
    message: "logic/** may not import @sg/render, @sg/ui or @sg/audio (SPEC §9.2).",
  },
  {
    group: ["preact", "preact/*", "@preact/*"],
    message: "logic/** may not touch the DOM (SPEC §9.2).",
  },
  {
    group: ["node:*", "fs", "path", "crypto", "os", "child_process", "worker_threads"],
    message: "logic/** is platform-free: no Node built-ins (SPEC §9.3).",
  },
  {
    group: ["**/client", "**/client/**"],
    message: "logic/** may not import client code (SPEC §9.2).",
  },
];
const NO_OTHER_GAME_IMPORT = {
  group: ["@sg/game-*", "@sg/game-*/**"],
  message:
    "No game imports another game (SPEC §9.2). Import your own game's files by relative path; shared code belongs in @sg/shared or @sg/engine.",
};

/** Libraries and three.js features banned in v1 (SPEC §9.1); applied to every file. */
const BANNED_PATHS = [
  { name: "react", message: "React is banned in v1: use preact (SPEC §9.1)." },
  { name: "react-dom", message: "React is banned in v1: use preact (SPEC §9.1)." },
  { name: "colyseus", message: "Banned in v1 (SPEC §9.1)." },
  { name: "socket.io", message: "Banned in v1 (SPEC §9.1)." },
  { name: "socket.io-client", message: "Banned in v1 (SPEC §9.1)." },
  { name: "partykit", message: "Banned in v1 (SPEC §9.1)." },
  { name: "cannon-es", message: "Physics engines are banned in v1 (SPEC §9.1)." },
  { name: "matter-js", message: "Physics engines are banned in v1 (SPEC §9.1)." },
  {
    name: "@dimforge/rapier3d",
    message: "Physics engines are banned in v1 (SPEC §9.1).",
  },
  {
    name: "@dimforge/rapier2d",
    message: "Physics engines are banned in v1 (SPEC §9.1).",
  },
  {
    name: "three",
    importNames: ["MeshStandardMaterial", "MeshPhysicalMaterial", "WebGPURenderer"],
    message: "MeshStandardMaterial, MeshPhysicalMaterial and WebGPU are banned in v1 (SPEC §9.1).",
  },
];
const BANNED_PATTERNS = [
  {
    group: ["three/examples/jsm/postprocessing/*", "three/addons/postprocessing/*"],
    message: "Post-processing (EffectComposer) is banned in v1 (SPEC §9.1, §10).",
  },
  {
    group: ["three/webgpu", "three/tsl"],
    message: "The WebGPU renderer is banned in v1 (SPEC §9.1).",
  },
];
/**
 * Builds a `no-restricted-imports` entry. Flat config replaces (not merges) rule options,
 * so every override must restate the global bans.
 * @param {Array<Record<string, unknown>>} [patterns]
 * @param {Array<Record<string, unknown>>} [paths]
 */
const restrictedImports = (patterns = [], paths = []) => [
  "error",
  { paths: [...BANNED_PATHS, ...paths], patterns: [...BANNED_PATTERNS, ...patterns] },
];

export default defineConfig(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      "artifacts/**",
      "**/test-results/**",
      "**/playwright-report/**",
      "**/*.d.ts",
      "docs/**",
    ],
  },
  {
    linterOptions: { reportUnusedDisableDirectives: "error" },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  comments.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: { ...globals.es2024, ...globals.node },
    },
    rules: {
      "@eslint-community/eslint-comments/require-description": ["error", { ignore: [] }],
      "@eslint-community/eslint-comments/no-unlimited-disable": "error",
      "@eslint-community/eslint-comments/disable-enable-pair": ["error", { allowWholeFile: true }],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-var": "error",
      "prefer-const": "error",
      "no-restricted-syntax": ["error", NO_THREE_NAMESPACE],
      "no-restricted-imports": restrictedImports(),
    },
  },

  // ---- Package boundaries (SPEC §9.2) -------------------------------------------------------
  {
    files: ["**/*.{ts,tsx,js,mjs,cjs}"],
    plugins: { boundaries },
    settings: {
      "import/resolver": {
        typescript: {
          alwaysTryTypes: true,
          noWarnOnMultipleProjects: true,
          project: [
            "tsconfig.json",
            "packages/*/tsconfig.json",
            "packages/games/*/tsconfig.json",
            "apps/*/tsconfig.json",
            "tools/*/tsconfig.json",
          ],
        },
      },
      "boundaries/include": ["packages/**/*", "apps/**/*", "tools/**/*"],
      "boundaries/elements": [
        {
          type: "game-logic",
          pattern: "packages/games/*/src/logic",
          capture: ["game"],
        },
        {
          type: "game-client",
          pattern: "packages/games/*/src/client",
          capture: ["game"],
        },
        { type: "game", pattern: "packages/games/*", capture: ["game"] },
        { type: "shared", pattern: "packages/shared" },
        { type: "engine", pattern: "packages/engine" },
        { type: "render", pattern: "packages/render" },
        { type: "ui", pattern: "packages/ui" },
        { type: "audio", pattern: "packages/audio" },
        { type: "server", pattern: "apps/server" },
        { type: "client", pattern: "apps/client" },
        { type: "bots", pattern: "tools/bots" },
        { type: "harness", pattern: "tools/harness" },
      ],
    },
    rules: {
      "boundaries/dependencies": [
        "error",
        {
          default: "disallow",
          message:
            "Package boundary violated: {{from.element.type}} may not import {{to.element.type}} (SPEC §9.2).",
          policies: [
            {
              from: { element: { type: "shared" } },
              allow: { to: { element: { type: "shared" } } },
            },
            {
              from: { element: { type: "engine" } },
              allow: { to: { element: { types: { anyOf: ["shared", "engine"] } } } },
            },
            {
              from: { element: { types: { anyOf: ["render", "ui", "audio"] } } },
              allow: {
                to: [
                  { element: { type: "shared" } },
                  { element: { type: "{{from.element.type}}" } },
                ],
              },
            },
            {
              from: { element: { type: "game-logic" } },
              allow: {
                to: [
                  { element: { types: { anyOf: ["shared", "engine"] } } },
                  {
                    element: {
                      type: "game-logic",
                      captured: { game: "{{from.element.captured.game}}" },
                    },
                  },
                ],
              },
            },
            {
              from: { element: { type: "game" } },
              allow: {
                to: [
                  { element: { types: { anyOf: ["shared", "engine"] } } },
                  {
                    element: {
                      types: { anyOf: ["game", "game-logic"] },
                      captured: { game: "{{from.element.captured.game}}" },
                    },
                  },
                ],
              },
            },
            {
              from: { element: { type: "game-client" } },
              allow: {
                to: [
                  { element: { types: { anyOf: ["shared", "engine", "render", "ui", "audio"] } } },
                  {
                    element: {
                      types: { anyOf: ["game", "game-logic", "game-client"] },
                      captured: { game: "{{from.element.captured.game}}" },
                    },
                  },
                ],
              },
            },
            {
              from: { element: { type: "server" } },
              allow: {
                to: {
                  element: {
                    types: { anyOf: ["shared", "engine", "game", "game-logic", "server"] },
                  },
                },
              },
            },
            {
              from: { element: { type: "client" } },
              allow: {
                to: {
                  element: {
                    types: {
                      anyOf: [
                        "shared",
                        "engine",
                        "render",
                        "ui",
                        "audio",
                        "game",
                        "game-logic",
                        "game-client",
                        "client",
                      ],
                    },
                  },
                },
              },
            },
            {
              from: { element: { type: "bots" } },
              allow: { to: { element: { types: { anyOf: ["shared", "engine", "bots"] } } } },
            },
            {
              from: { element: { type: "harness" } },
              allow: {
                to: {
                  element: {
                    types: {
                      anyOf: [
                        "shared",
                        "engine",
                        "render",
                        "ui",
                        "audio",
                        "game",
                        "game-logic",
                        "game-client",
                        "harness",
                      ],
                    },
                  },
                },
              },
            },
          ],
        },
      ],
    },
  },

  // ---- Games: no cross-game imports, no raw rAF, no direct materials ----------------------
  {
    files: GAME_FILES,
    rules: {
      "no-restricted-imports": restrictedImports([NO_OTHER_GAME_IMPORT]),
      "no-restricted-globals": ["error", ...RAF_GLOBALS],
      "no-restricted-properties": ["error", ...RAF_PROPERTIES],
      "no-restricted-syntax": [
        "error",
        NO_THREE_NAMESPACE,
        NO_DIRECT_MATERIAL,
        NO_DIRECT_MATERIAL_MEMBER,
      ],
    },
  },
  // Game clients: additionally no colour/duration literals (tokens only).
  {
    files: GAME_CLIENT_FILES,
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      "no-restricted-syntax": [
        "error",
        NO_THREE_NAMESPACE,
        NO_DIRECT_MATERIAL,
        NO_DIRECT_MATERIAL_MEMBER,
        ...NO_TOKEN_LITERALS,
      ],
    },
  },
  // Phone entries: never statically import three or @sg/render (only the lazy requestBoard path).
  {
    files: PHONE_ENTRY_FILES,
    rules: {
      "no-restricted-imports": restrictedImports([
        NO_OTHER_GAME_IMPORT,
        {
          group: ["three", "three/*", "@sg/render", "@sg/render/*", "./stage", "./stage.*"],
          allowTypeImports: true,
          message:
            "Controllers and audience panels never statically import three or @sg/render; use the lazy requestBoard() path (SPEC §10, DOD G2).",
        },
      ]),
    },
  },
  // Direct materials are banned outside @sg/render everywhere else too (M1-06).
  {
    files: ["apps/**/*.{ts,tsx}", "packages/{shared,engine,ui,audio}/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        NO_THREE_NAMESPACE,
        NO_DIRECT_MATERIAL,
        NO_DIRECT_MATERIAL_MEMBER,
      ],
    },
  },

  // ---- Pure logic (any **/logic/**, e.g. packages/games/*/src/logic) ------------------------
  {
    files: LOGIC_FILES,
    languageOptions: { globals: { ...globals.es2024 } },
    rules: {
      "no-restricted-globals": ["error", ...LOGIC_GLOBALS],
      "no-restricted-properties": ["error", ...LOGIC_PROPERTIES, ...RAF_PROPERTIES],
      "no-restricted-syntax": [
        "error",
        NO_THREE_NAMESPACE,
        NO_DIRECT_MATERIAL,
        NO_DIRECT_MATERIAL_MEMBER,
        { selector: "NewExpression[callee.name='Date']", message: LOGIC_MSG },
        { selector: "CallExpression[callee.name='Date']", message: LOGIC_MSG },
        { selector: "MemberExpression[object.name='Date']", message: LOGIC_MSG },
      ],
      "no-restricted-imports": restrictedImports([NO_OTHER_GAME_IMPORT, ...LOGIC_IMPORT_PATTERNS]),
    },
  },

  // ---- Server: never imports a client entry --------------------------------------------------
  {
    files: ["apps/server/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": restrictedImports([
        {
          group: [
            "@sg/game-*/client",
            "@sg/game-*/client/**",
            "@sg/client",
            "@sg/client/**",
            "@sg/render",
            "@sg/render/**",
            "@sg/ui",
            "@sg/ui/**",
            "@sg/audio",
            "@sg/audio/**",
            "three",
            "three/*",
            "preact",
            "preact/*",
          ],
          message: "apps/server never imports any client entry (SPEC §9.2).",
        },
      ]),
    },
  },

  // ---- Browser globals for DOM packages ----------------------------------------------------
  {
    files: [
      "apps/client/**/*.{ts,tsx}",
      "packages/{ui,render,audio}/**/*.{ts,tsx}",
      "tools/harness/**/*.spec.ts",
    ],
    languageOptions: { globals: { ...globals.browser } },
  },

  // ---- Plain JS config files ----------------------------------------------------------------
  {
    files: ["**/*.cjs"],
    languageOptions: { sourceType: "commonjs" },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
);
