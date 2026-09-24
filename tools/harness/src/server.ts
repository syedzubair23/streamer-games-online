/**
 * The scenario server: builds `apps/client` in `scenario` mode (the production build leaves
 * `/dev/scenario` out) and serves it with `vite preview` on a given port.
 *
 * @module
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { join } from "node:path";

/** A running scenario server. */
export interface ScenarioServer {
  url: string;
  stop(): Promise<void>;
}

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

/**
 * Output of the scenario build, relative to `apps/client` (mirrors `SCENARIO_OUT_DIR` in
 * `apps/client/vite.config.ts`; the harness may not import app code).
 */
export const SCENARIO_OUT_DIR = "../../artifacts/tmp/scenario-client";

/** Builds the client in scenario mode (into `artifacts/tmp/scenario-client`). */
export function buildScenarioClient(root: string): void {
  const res = spawnSync(
    pnpm,
    ["exec", "vite", "build", "--mode", "scenario", "--logLevel", "warn"],
    {
      cwd: join(root, "apps/client"),
      stdio: "inherit",
      shell: process.platform === "win32",
    },
  );
  if (res.status !== 0) throw new Error(`scenario build failed (exit ${res.status ?? "?"})`);
}

/** Resolves once `url` answers HTTP 200, or rejects when the process exits first. */
async function waitForHttp(url: string, child: ChildProcess, maxMs: number): Promise<void> {
  const start = Date.now();
  let exited: number | null = null;
  child.once("exit", (code) => {
    exited = code ?? -1;
  });
  for (;;) {
    if (exited !== null) throw new Error(`vite preview exited with code ${exited}`);
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    if (Date.now() - start > maxMs) throw new Error(`vite preview did not answer at ${url}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** Builds (unless `skipBuild`) and starts `vite preview` on `port`. */
export async function startScenarioServer(
  root: string,
  port: number,
  opts: { skipBuild?: boolean } = {},
): Promise<ScenarioServer> {
  if (opts.skipBuild !== true) buildScenarioClient(root);
  const child = spawn(
    pnpm,
    [
      "exec",
      "vite",
      "preview",
      "--outDir",
      SCENARIO_OUT_DIR,
      "--port",
      String(port),
      "--strictPort",
    ],
    {
      cwd: join(root, "apps/client"),
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    },
  );
  let log = "";
  child.stdout?.on("data", (d: Buffer) => (log += d.toString()));
  child.stderr?.on("data", (d: Buffer) => (log += d.toString()));
  const url = `http://localhost:${port}`;
  try {
    await waitForHttp(`${url}/dev/scenario?game=tictactoe&state=intro`, child, 60_000);
  } catch (err) {
    child.kill();
    throw new Error(`${err instanceof Error ? err.message : String(err)}\n${log}`, { cause: err });
  }
  return {
    url,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", () => resolve());
        if (process.platform === "win32" && child.pid !== undefined)
          spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
        else child.kill("SIGTERM");
      }),
  };
}
