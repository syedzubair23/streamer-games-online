/**
 * The process entry: starts from env config, answers /health, and fails loudly on bad config.
 */
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const serverDir = fileURLToPath(new URL("..", import.meta.url));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

function run(env: Record<string, string>) {
  const child = spawn(process.execPath, ["--import", "tsx", "src/bin.ts"], {
    cwd: serverDir,
    env: { ...process.env, SG_CONFIG: "", ...env },
  });
  let out = "";
  child.stdout.on("data", (d: Buffer) => (out += d.toString()));
  child.stderr.on("data", (d: Buffer) => (out += d.toString()));
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  const output = (): string => out;
  return { child, exited, output };
}

describe("bin.ts", () => {
  it("starts the configured transport and serves /health", { timeout: 30_000 }, async () => {
    const port = await freePort();
    const p = run({ PORT: String(port), HOST: "127.0.0.1", TRANSPORT: "ws" });
    try {
      await expect
        .poll(() => p.output(), { timeout: 20_000, interval: 100 })
        .toContain(`listening on 127.0.0.1:${port} (transport ws, store memory)`);
      const health = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as {
        ok: boolean;
        transport: string;
      };
      expect(health).toMatchObject({ ok: true, transport: "ws" });
    } finally {
      p.child.kill();
      await p.exited;
    }
  });

  it("exits 1 with a clear message on invalid config", { timeout: 30_000 }, async () => {
    const p = run({ TRANSPORT: "carrier-pigeon" });
    expect(await p.exited).toBe(1);
    expect(p.output()).toMatch(/failed to start: invalid TRANSPORT "carrier-pigeon"/);
  });
});
