/**
 * Scaffold invariants for ROADMAP M0-01: every package and app from SPEC §9.2 exists with a
 * package.json and src/index.ts, root config matches SPEC §9.1/§9.2, the tech-stack
 * dependencies are pinned as specified, and every script's entry file exists (so `pnpm build`
 * and `pnpm start` really run).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface PackageJson {
  name: string;
  private?: boolean;
  type?: string;
  packageManager?: string;
  engines?: Record<string, string>;
  exports?: Record<string, string>;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const readJson = <T>(file: string): T => JSON.parse(readFileSync(join(ROOT, file), "utf8")) as T;
const readPkg = (dir: string): PackageJson => readJson<PackageJson>(join(dir, "package.json"));

const GAMES = [
  "quip-clash",
  "tune-in",
  "trivia-night",
  "doodle",
  "odd-one-out",
  "ludo",
  "chess",
  "marble-rally",
] as const;

/** SPEC §9.2: directory → package name. */
const PACKAGES: Record<string, string> = {
  "packages/shared": "@sg/shared",
  "packages/engine": "@sg/engine",
  "packages/render": "@sg/render",
  "packages/ui": "@sg/ui",
  "packages/audio": "@sg/audio",
  ...Object.fromEntries(GAMES.map((id) => [`packages/games/${id}`, `@sg/game-${id}`])),
  "apps/server": "@sg/server",
  "apps/client": "@sg/client",
  "tools/bots": "@sg/bots",
  "tools/harness": "@sg/harness",
};

const allDeps = (pkg: PackageJson): Record<string, string> => ({
  ...pkg.dependencies,
  ...pkg.devDependencies,
});

describe("workspace packages (SPEC §9.2)", () => {
  it.each(Object.entries(PACKAGES))("%s is a stubbed package named %s", (dir, name) => {
    const pkg = readPkg(dir);
    expect(pkg.name).toBe(name);
    expect(pkg.private).toBe(true);
    expect(pkg.type).toBe("module");
    expect(pkg.exports?.["."]).toBe("./src/index.ts");
    expect(existsSync(join(ROOT, dir, "src/index.ts"))).toBe(true);
    expect(existsSync(join(ROOT, dir, "tsconfig.json"))).toBe(true);
    expect(pkg.scripts?.typecheck).toBeDefined();
    expect(pkg.scripts?.test).toBeDefined();
  });

  it("every stub entry is importable", async () => {
    for (const dir of Object.keys(PACKAGES)) {
      const mod: unknown = await import(join(ROOT, dir, "src/index.ts"));
      expect(mod, dir).toBeTypeOf("object");
    }
  });

  it("each game stub exposes its spec id", async () => {
    for (const id of GAMES) {
      expect(existsSync(join(ROOT, "docs/specs", `${id}.md`)), id).toBe(true);
      const mod = (await import(join(ROOT, "packages/games", id, "src/index.ts"))) as {
        GAME_ID: string;
      };
      expect(mod.GAME_ID).toBe(id);
    }
  });

  it("pnpm-workspace.yaml covers every package directory", () => {
    const yaml = readFileSync(join(ROOT, "pnpm-workspace.yaml"), "utf8");
    for (const glob of ["packages/*", "packages/games/*", "apps/*", "tools/*"]) {
      expect(yaml).toContain(`- ${glob}`);
    }
  });

  it("pnpm sees exactly the SPEC packages", () => {
    const out = execFileSync("pnpm", ["ls", "-r", "--depth", "-1", "--json"], {
      cwd: ROOT,
      encoding: "utf8",
      shell: process.platform === "win32",
    });
    const names = (JSON.parse(out) as { name: string }[]).map((p) => p.name).sort();
    expect(names).toEqual(["streamer-games-online", ...Object.values(PACKAGES)].sort());
  });
});

describe("root package.json (SPEC §9.1, §9.2)", () => {
  const root = readPkg(".");

  it("pins the runtime and package manager", () => {
    expect(root.packageManager).toBe("pnpm@12.4.1");
    expect(root.engines?.node).toBe(">=22.12 <25");
    expect(root.type).toBe("module");
  });

  it.each([
    "dev",
    "build",
    "start",
    "preview",
    "typecheck",
    "lint",
    "test",
    "size",
    "verify:game",
    "verify:item",
    "shots",
    "perf:game",
    "critic:prep",
    "bots",
    "progress",
  ])("wires the %s script", (script) => {
    expect(root.scripts?.[script], script).toBeTruthy();
  });
});

/**
 * Root scripts whose entry files a later ROADMAP item creates. The test fails once the file
 * exists but is still listed here, so this list can only shrink.
 */
const PENDING_ENTRIES: Record<string, string> = {
  "tools/harness/verify-game.ts": "M0-05",
  "tools/harness/verify-item.ts": "M0-05",
  // Not in any Files list; its inputs (shots, sheets, clips, A/B pairs) are M0-05's harness.
  "tools/harness/critic-prep.ts": "M0-05",
  "tools/bots/src/swarm.ts": "M1-10",
};

/** Files a script runs: the first positional argument after `tsx [watch]`, `esbuild` or `node`. */
const scriptEntries = (script: string): string[] => {
  const entries: string[] = [];
  for (const command of script.split(/&&|\|\||;/)) {
    const words = command.trim().split(/\s+/);
    const at = words.findIndex((w) => w === "tsx" || w === "esbuild" || w === "node");
    if (at < 0) continue;
    const rest = words.slice(at + 1).filter((w) => !w.startsWith("-") && w !== "watch");
    if (rest[0]) entries.push(rest[0]);
  }
  return entries;
};

/** `esbuild src/bin.ts ... --outdir=dist` produces `dist/bin.js`. */
const esbuildOutputs = (build: string | undefined): string[] => {
  if (!build?.includes("esbuild")) return [];
  const outdir = /--outdir=(\S+)/.exec(build)?.[1] ?? ".";
  return scriptEntries(build).map((entry) =>
    join(outdir, entry.replace(/^.*\//, "").replace(/\.tsx?$/, ".js")).replaceAll("\\", "/"),
  );
};

describe("script entry files exist (pnpm build/dev/start are runnable)", () => {
  const dirs = [".", ...Object.keys(PACKAGES)];

  it.each(dirs)("%s: every tsx/esbuild/node entry exists or is built", (dir) => {
    const pkg = readPkg(dir);
    const built = esbuildOutputs(pkg.scripts?.build);
    for (const [name, script] of Object.entries(pkg.scripts ?? {})) {
      for (const entry of scriptEntries(script)) {
        const label = `${dir} ${name}: ${entry}`;
        if (entry.startsWith("dist/")) {
          expect(built, `${label} is not produced by the build script`).toContain(entry);
          continue;
        }
        const owner = dir === "." ? PENDING_ENTRIES[entry] : undefined;
        if (owner) {
          expect(
            existsSync(join(ROOT, entry)),
            `${label} exists: drop it from PENDING_ENTRIES`,
          ).toBe(false);
          continue;
        }
        expect(existsSync(join(ROOT, dir, entry)), label).toBe(true);
      }
    }
  });

  it("pnpm build succeeds and the built server starts and exits 0", () => {
    const run = (cmd: string, args: string[]): string =>
      execFileSync(cmd, args, {
        cwd: ROOT,
        encoding: "utf8",
        stdio: "pipe",
        shell: process.platform === "win32",
      });
    run("pnpm", ["build"]);
    expect(existsSync(join(ROOT, "apps/server/dist/bin.js"))).toBe(true);
    expect(run("node", ["apps/server/dist/bin.js"])).toContain("@sg/server");
  }, 180_000);
});

describe("game package subpath exports (SPEC §9.2)", () => {
  const SUBPATHS: Record<string, string> = {
    ".": "./src/index.ts",
    "./logic": "./src/logic/index.ts",
    "./client": "./src/client/index.ts",
    "./scenarios": "./src/scenarios.ts",
  };

  it.each(GAMES)("%s exports ., ./logic, ./client and ./scenarios", async (id) => {
    const dir = join("packages/games", id);
    expect(readPkg(dir).exports).toEqual(SUBPATHS);
    for (const file of Object.values(SUBPATHS)) {
      const mod = (await import(join(ROOT, dir, file))) as { GAME_ID: string };
      expect(mod.GAME_ID, `${id} ${file}`).toBe(id);
    }
  });
});

describe("tech stack versions (SPEC §9.1)", () => {
  /** [package dir, dependency, exact spec from SPEC §9.1] */
  const EXPECTED: [string, string, string][] = [
    [".", "typescript", "6.0.3"],
    [".", "vitest", "^5.0.1"],
    [".", "@vitest/coverage-v8", "^5.0.1"],
    [".", "eslint", "^10.11.0"],
    [".", "typescript-eslint", "^8.70.1"],
    [".", "eslint-plugin-boundaries", "^7.2.0"],
    [".", "prettier", "^3.9.9"],
    [".", "size-limit", "^14.0.0"],
    [".", "concurrently", "^10.0.5"],
    [".", "esbuild", "^0.28.2"],
    [".", "tsx", "^4.23.15"],
    [".", "@playwright/test", "^1.63.0"],
    ["packages/render", "three", "0.186.1"],
    ["packages/render", "@types/three", "0.186.0"],
    ["packages/shared", "zod", "^4.6.5"],
    ["packages/shared", "obscenity", "^0.4.6"],
    ["packages/ui", "preact", "^10.29.8"],
    ["packages/ui", "@preact/signals", "^2.11.2"],
    ["packages/ui", "@fontsource-variable/fredoka", "^5.3.0"],
    ["packages/ui", "@fontsource-variable/nunito", "^5.3.0"],
    ["packages/ui", "@fontsource/caveat", "^5.3.0"],
    ["packages/ui", "lucide", "^1.48.0"],
    ["packages/ui", "qrcode-generator", "^2.0.4"],
    ["packages/games/chess", "chess.js", "^1.4.0"],
    ["apps/server", "uWebSockets.js", "github:uNetworking/uWebSockets.js#v20.71.0"],
    ["apps/server", "ws", "^8.21.3"],
    ["apps/server", "@types/ws", "^8.18.1"],
    ["apps/server", "better-sqlite3", "^13.0.3"],
    ["apps/client", "vite", "^8.3.1"],
    ["apps/client", "@preact/preset-vite", "^2.10.6"],
    ["apps/client", "vite-plugin-pwa", "^1.3.0"],
    ["apps/client", "three", "0.186.1"],
    ["tools/harness", "@axe-core/playwright", "^4.13.0"],
    ["tools/harness", "sharp", "^0.35.4"],
    ["tools/harness", "pixelmatch", "^7.2.0"],
    ["tools/harness", "pngjs", "^7.0.0"],
  ];

  it.each(EXPECTED)("%s depends on %s@%s", (dir, dep, version) => {
    expect(allDeps(readPkg(dir))[dep]).toBe(version);
  });

  it("every game pins three exactly and never depends on another game", () => {
    for (const id of GAMES) {
      const deps = allDeps(readPkg(`packages/games/${id}`));
      expect(deps.three, id).toBe("0.186.1");
      expect(
        Object.keys(deps).filter((d) => d.startsWith("@sg/game-")),
        id,
      ).toEqual([]);
    }
  });

  it("no banned framework is a dependency anywhere", () => {
    const banned = [
      "react",
      "react-dom",
      "colyseus",
      "socket.io",
      "partykit",
      "cannon-es",
      "matter-js",
    ];
    for (const dir of [".", ...Object.keys(PACKAGES)]) {
      const deps = Object.keys(allDeps(readPkg(dir)));
      expect(
        deps.filter((d) => banned.includes(d)),
        dir,
      ).toEqual([]);
    }
  });

  it("the server does not depend on client-only kits", () => {
    const deps = Object.keys(allDeps(readPkg("apps/server")));
    for (const d of ["@sg/client", "@sg/render", "@sg/ui", "@sg/audio", "three", "preact"]) {
      expect(deps).not.toContain(d);
    }
  });
});

describe("root TypeScript config", () => {
  const { compilerOptions } = readJson<{ compilerOptions: Record<string, unknown> }>(
    "tsconfig.base.json",
  );

  it("is strict with bundler resolution and noUncheckedIndexedAccess", () => {
    expect(compilerOptions.strict).toBe(true);
    expect(compilerOptions.moduleResolution).toBe("bundler");
    expect(compilerOptions.noUncheckedIndexedAccess).toBe(true);
  });

  it("every package tsconfig extends the base", () => {
    for (const dir of Object.keys(PACKAGES)) {
      const cfg = readJson<{ extends: string }>(join(dir, "tsconfig.json"));
      expect(resolve(ROOT, dir, cfg.extends), dir).toBe(join(ROOT, "tsconfig.base.json"));
    }
  });
});

describe(".gitignore", () => {
  const ignored = (path: string): boolean => {
    try {
      execFileSync("git", ["check-ignore", "-q", "--no-index", path], { cwd: ROOT });
      return true;
    } catch {
      return false;
    }
  };

  it("ignores artifacts/ except artifacts/critic/", () => {
    expect(ignored("artifacts/verify/M0-01.json")).toBe(true);
    expect(ignored("artifacts/screenshots/ludo/round-1/a.png")).toBe(true);
    expect(ignored("artifacts/critic/ludo/round-1.json")).toBe(false);
  });

  it("ignores dependencies and build output", () => {
    expect(ignored("node_modules/x/index.js")).toBe(true);
    expect(ignored("apps/client/dist/index.html")).toBe(true);
    expect(ignored("coverage/index.html")).toBe(true);
    expect(ignored("packages/shared/src/index.ts")).toBe(false);
  });
});
