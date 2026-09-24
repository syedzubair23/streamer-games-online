/**
 * The blind critic runner: isolation flags, envelope parsing, and a real child process driven
 * through a fake CLI (so the spawn/stdin/stdout path is exercised without network access).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  claudeCliArgs,
  claudeCliRunner,
  parseCliEnvelope,
  resolveCriticCommand,
} from "../src/critic/critic-runner.ts";

describe("claudeCliArgs", () => {
  it("isolates the critic: headless, restricted, read-only, no MCP, no persisted session", () => {
    const args = claudeCliArgs({ workspace: "w", prompt: "p" }, {});
    expect(args.slice(0, 3)).toEqual(["-p", "--output-format", "json"]);
    for (const flag of ["--restricted", "--strict-mcp-config", "--no-session-persistence"])
      expect(args).toContain(flag);
    expect(args[args.indexOf("--tools") + 1]).toBe("Read");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("Read");
    expect(args).not.toContain("--model");
    expect(args).not.toContain("--json-schema");
  });

  it("adds model, budget and the schema without its $schema marker", () => {
    const args = claudeCliArgs(
      {
        workspace: "w",
        prompt: "p",
        schema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" },
      },
      { model: "opus", maxBudgetUsd: 2, prefixArgs: ["cli.mjs"] },
    );
    expect(args[0]).toBe("cli.mjs");
    expect(args[args.indexOf("--model") + 1]).toBe("opus");
    expect(args[args.indexOf("--max-budget-usd") + 1]).toBe("2");
    expect(JSON.parse(args[args.indexOf("--json-schema") + 1] as string)).toEqual({
      type: "object",
    });
  });
});

describe("parseCliEnvelope", () => {
  it("prefers structured_output, reports the costliest model and the cost", () => {
    const res = parseCliEnvelope(
      JSON.stringify({
        subtype: "success",
        result: "text",
        structured_output: { a: 1 },
        total_cost_usd: 0.5,
        modelUsage: { small: { costUSD: 0.01 }, big: { costUSD: 0.49 } },
      }),
    );
    expect(res).toEqual({ output: { a: 1 }, model: "big", costUsd: 0.5 });
  });

  it("falls back to the result text", () => {
    expect(parseCliEnvelope(JSON.stringify({ result: "hello" }))).toEqual({ output: "hello" });
  });

  it("throws on non-JSON, error envelopes and empty results", () => {
    expect(() => parseCliEnvelope("oops")).toThrow(/did not return a JSON envelope/);
    expect(() => parseCliEnvelope(JSON.stringify({ is_error: true, result: "bad" }))).toThrow(
      /reported an error/,
    );
    expect(() => parseCliEnvelope(JSON.stringify({ subtype: "error_max_budget_usd" }))).toThrow(
      /error_max_budget_usd/,
    );
    expect(() => parseCliEnvelope(JSON.stringify({ subtype: "success" }))).toThrow(/no result/);
  });
});

describe("resolveCriticCommand", () => {
  it("uses an existing SG_CRITIC_CLI / CLAUDE_CODE_EXECPATH, else `claude`", () => {
    expect(resolveCriticCommand({ SG_CRITIC_CLI: process.execPath })).toBe(process.execPath);
    expect(resolveCriticCommand({ CLAUDE_CODE_EXECPATH: process.execPath })).toBe(process.execPath);
    expect(resolveCriticCommand({ SG_CRITIC_CLI: "/definitely/not/here" })).toBe("claude");
    expect(resolveCriticCommand({})).toBe("claude");
  });
});

describe("claudeCliRunner (fake CLI child process)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sg-cli-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const script = (name: string, body: string): string => {
    const p = join(dir, name);
    writeFileSync(p, body);
    return p;
  };
  const echo = script(
    "echo.mjs",
    `let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
       process.stdout.write(JSON.stringify({ subtype: "success", total_cost_usd: 0.1,
         structured_output: { prompt: s, cwd: process.cwd(), args: process.argv.slice(2) } }));
     });`,
  );

  it("sends the prompt on stdin, runs in the workspace and returns the structured output", async () => {
    const run = claudeCliRunner({ command: process.execPath, prefixArgs: [echo], model: "m" });
    const res = await run({
      workspace: dir,
      prompt: "score ./shot.png ✓",
      schema: { type: "object" },
    });
    const out = res.output as { prompt: string; cwd: string; args: string[] };
    expect(out.prompt).toBe("score ./shot.png ✓");
    expect(out.cwd.toLowerCase()).toBe(dir.toLowerCase());
    expect(out.args).toContain("--restricted");
    expect(res.costUsd).toBe(0.1);
  });

  it("rejects on a failing CLI, a bad envelope, a timeout and a missing executable", async () => {
    const failing = script(
      "fail.mjs",
      `process.stdin.resume(); process.stdin.on("end", () => { console.error("nope"); process.exit(3); });`,
    );
    await expect(
      claudeCliRunner({ command: process.execPath, prefixArgs: [failing] })({
        workspace: dir,
        prompt: "x",
      }),
    ).rejects.toThrow(/exited with code 3: nope/);
    const garbage = script(
      "garbage.mjs",
      `process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("not json"));`,
    );
    await expect(
      claudeCliRunner({ command: process.execPath, prefixArgs: [garbage] })({
        workspace: dir,
        prompt: "x",
      }),
    ).rejects.toThrow(/JSON envelope/);
    const slow = script("slow.mjs", `setTimeout(() => {}, 60000);`);
    await expect(
      claudeCliRunner({ command: process.execPath, prefixArgs: [slow], timeoutMs: 300 })({
        workspace: dir,
        prompt: "x",
      }),
    ).rejects.toThrow(/timed out/);
    await expect(
      claudeCliRunner({ command: join(dir, "no-such-cli.exe") })({ workspace: dir, prompt: "x" }),
    ).rejects.toThrow(/could not start critic CLI/);
  }, 30_000);
});
