/**
 * Command execution for the verify scripts, behind an interface so tests can inject results.
 *
 * @module
 */
import { spawn } from "node:child_process";
import { stripAnsi } from "./reports.ts";

/** The outcome of one command. */
export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  ms: number;
}

/** Runs a command (no shell interpolation of arguments beyond what the platform requires). */
export type CommandRunner = (
  cmd: string,
  args: readonly string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; echo?: boolean; shell?: boolean },
) => Promise<CommandResult>;

const TAIL = 64 * 1024;
const keepTail = (s: string): string => (s.length > TAIL ? s.slice(-TAIL) : s);

/** Quotes one argument for `cmd.exe` (used when a Windows `.cmd` shim needs a shell). */
export function quoteWinArg(arg: string): string {
  return /[\s"&|<>^%]/.test(arg) || arg === "" ? `"${arg.replace(/"/g, '""')}"` : arg;
}

/**
 * The real runner: spawns the command and captures (the tail of) its output. `pnpm` on Windows is
 * a `.cmd` shim that needs a shell; its arguments are quoted so spaces and `&` survive. With
 * `shell: true` and no arguments, `cmd` is a whole shell command line (item accept checks).
 */
export const spawnRunner: CommandRunner = (cmd, args, opts) =>
  new Promise((resolve) => {
    const start = Date.now();
    const isWin = process.platform === "win32";
    const viaShim = isWin && cmd === "pnpm";
    const child = spawn(viaShim ? "pnpm.cmd" : cmd, viaShim ? args.map(quoteWinArg) : [...args], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      shell: opts.shell === true || viaShim,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout = keepTail(stdout + d.toString());
      if (opts.echo === true) process.stdout.write(d);
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr = keepTail(stderr + d.toString());
      if (opts.echo === true) process.stderr.write(d);
    });
    child.on("error", (err) =>
      resolve({ code: -1, stdout, stderr: `${stderr}${String(err)}`, ms: Date.now() - start }),
    );
    child.on("close", (code) =>
      resolve({ code: code ?? -1, stdout, stderr, ms: Date.now() - start }),
    );
  });

/** Formats a command for the `cmd` field of a gate. */
export const formatCmd = (cmd: string, args: readonly string[]): string =>
  [cmd, ...args.map((a) => (/[\s"*]/.test(a) ? JSON.stringify(a) : a))].join(" ");

/** The last `n` non-empty lines of a command's output, for gate notes. */
export function tailLines(r: Pick<CommandResult, "stdout" | "stderr">, n = 8): string {
  return `${r.stdout}\n${r.stderr}`
    .split(/\r?\n/)
    .map((l) => stripAnsi(l).trimEnd())
    .filter((l) => l.trim() !== "")
    .slice(-n)
    .join("\n");
}
