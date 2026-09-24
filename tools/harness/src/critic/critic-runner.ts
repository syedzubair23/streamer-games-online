/**
 * Spawning a **fresh, blind** critic (DOD §6.2, §7). The default runner drives the Claude Code CLI
 * headless (`claude -p`) in an isolated working directory that holds only the critic's inputs:
 *  - `--restricted` + `--strict-mcp-config`: no shell, no web, no MCP, no user/project settings,
 *    and file tools confined to the working directory;
 *  - `--tools Read`: the critic can only read (look at) its inputs;
 *  - `--no-session-persistence`: every call is a brand-new session with no memory of others.
 * The runner is an interface so tests (and other critic back-ends) can substitute it.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

export interface CriticRequest {
  /** Isolated directory holding only the critic's inputs; becomes the critic's cwd. */
  workspace: string;
  prompt: string;
  /** Optional JSON schema for structured output. */
  schema?: Record<string, unknown>;
}

export interface CriticResponse {
  /** The critic's final answer: the structured JSON object, or the raw reply text. */
  output: unknown;
  model?: string;
  costUsd?: number;
}

export type CriticRunner = (req: CriticRequest) => Promise<CriticResponse>;

export interface ClaudeCliOptions {
  /** Executable; defaults to $SG_CRITIC_CLI, then $CLAUDE_CODE_EXECPATH, then `claude` on PATH. */
  command?: string;
  /** Extra leading args (e.g. a script path when `command` is `node`). */
  prefixArgs?: string[];
  model?: string;
  timeoutMs?: number;
  /** Hard spend cap per critic call, passed to `--max-budget-usd`. */
  maxBudgetUsd?: number;
}

/** Resolves which CLI executable to run. */
export function resolveCriticCommand(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env["SG_CRITIC_CLI"] ?? env["CLAUDE_CODE_EXECPATH"];
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  return "claude";
}

/** The CLI arguments for one blind critic call (exported so the isolation flags are testable). */
export function claudeCliArgs(req: CriticRequest, opts: ClaudeCliOptions): string[] {
  const args = [
    ...(opts.prefixArgs ?? []),
    "-p",
    "--output-format",
    "json",
    "--restricted",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--tools",
    "Read",
    "--allowedTools",
    "Read",
  ];
  if (opts.model) args.push("--model", opts.model);
  if (opts.maxBudgetUsd !== undefined) args.push("--max-budget-usd", String(opts.maxBudgetUsd));
  if (req.schema) {
    // The CLI validator does not load the draft 2020-12 meta-schema; the caller still validates
    // the reply against the full schema, so dropping the `$schema` marker loses nothing.
    const { $schema: _meta, ...cliSchema } = req.schema;
    args.push("--json-schema", JSON.stringify(cliSchema));
  }
  return args;
}

/**
 * Parses the CLI's `--output-format json` envelope. Prefers `structured_output` (set when a
 * schema was given), then the `result` text. Throws on an error envelope.
 */
export function parseCliEnvelope(stdout: string): CriticResponse {
  let env: Record<string, unknown>;
  try {
    env = JSON.parse(stdout.trim()) as Record<string, unknown>;
  } catch {
    throw new Error(`critic CLI did not return a JSON envelope: ${stdout.slice(0, 300)}`);
  }
  if (
    env["is_error"] === true ||
    (typeof env["subtype"] === "string" && env["subtype"] !== "success")
  ) {
    throw new Error(
      `critic CLI reported an error (${String(env["subtype"])}): ${String(env["result"] ?? "").slice(0, 300)}`,
    );
  }
  const usage = env["modelUsage"];
  const models = usage && typeof usage === "object" ? Object.keys(usage) : [];
  // The CLI may use a small helper model for housekeeping; report the most expensive one.
  const model = models
    .map((m) => ({
      m,
      c: Number((usage as Record<string, { costUSD?: number }>)[m]?.costUSD ?? 0),
    }))
    .sort((a, b) => b.c - a.c)[0]?.m;
  const output = env["structured_output"] ?? env["result"];
  if (output === undefined || output === null) throw new Error("critic CLI envelope has no result");
  const res: CriticResponse = { output };
  if (model !== undefined) res.model = model;
  if (typeof env["total_cost_usd"] === "number") res.costUsd = env["total_cost_usd"];
  return res;
}

/** A runner backed by the Claude Code CLI in headless mode. The prompt goes in on stdin. */
export function claudeCliRunner(opts: ClaudeCliOptions = {}): CriticRunner {
  const command = opts.command ?? resolveCriticCommand();
  const timeoutMs = opts.timeoutMs ?? 15 * 60_000;
  return (req) =>
    new Promise<CriticResponse>((resolvePromise, reject) => {
      const child = spawn(command, claudeCliArgs(req, opts), {
        cwd: req.workspace,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill(); // rejected on "close", once the process has really gone
      }, timeoutMs);
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(new Error(`could not start critic CLI "${command}": ${err.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(new Error(`critic timed out after ${timeoutMs} ms`));
          return;
        }
        if (code !== 0 && stdout.trim() === "") {
          reject(new Error(`critic CLI exited with code ${code}: ${stderr.slice(0, 500)}`));
          return;
        }
        try {
          resolvePromise(parseCliEnvelope(stdout));
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
      child.stdin.end(req.prompt, "utf8");
    });
}
