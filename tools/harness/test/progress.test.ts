/**
 * Tests for `pnpm progress` (ROADMAP M0-03, DOD §8): roadmap parsing, the status lifecycle,
 * evidence gating, deterministic PROGRESS.md rendering, locking and the CLI itself.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applySet,
  parseAssignments,
  Refusal,
  runCli,
  syncWithRoadmap,
  UsageError,
} from "../src/progress/cli.ts";
import {
  checkVerify,
  checkVerifyCommit,
  latestCriticRound,
  verifyCommand,
} from "../src/progress/evidence.ts";
import {
  allowedNext,
  STATUSES,
  type ProgressFile,
  type ProgressItem,
  type Status,
} from "../src/progress/model.ts";
import { renderProgress } from "../src/progress/render.ts";
import { compareIds, parseRoadmap } from "../src/progress/roadmap.ts";
import {
  readProgress,
  serializeProgress,
  validateProgress,
  withLock,
} from "../src/progress/store.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ROADMAP = readFileSync(join(REPO, "docs/ROADMAP.md"), "utf8");
const NOW = new Date("2026-09-24T12:34:56.789Z");

interface Run {
  code: number;
  out: string[];
  err: string[];
}

let root = "";
const temps: string[] = [];

function makeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "sg-progress-"));
  temps.push(dir);
  mkdirSync(join(dir, "docs"), { recursive: true });
  copyFileSync(join(REPO, "docs/ROADMAP.md"), join(dir, "docs/ROADMAP.md"));
  return dir;
}

async function cli(...argv: string[]): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, {
    root,
    now: () => NOW,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  });
  return { code, out, err };
}

const read = (rel: string): string => readFileSync(join(root, rel), "utf8");
const write = (rel: string, content: string): void => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
};
const writeJson = (rel: string, value: unknown): void => write(rel, JSON.stringify(value, null, 2));
const item = (id: string): ProgressItem => {
  const found = readProgress(root).items.find((i) => i.id === id);
  if (!found) throw new Error(`no ${id}`);
  return found;
};

/** Forces an item into a status by editing progress.json directly (test setup only). */
function force(id: string, patch: Partial<ProgressItem>): void {
  const file = readProgress(root);
  const items = file.items.map((i) => (i.id === id ? { ...i, ...patch } : i));
  write("progress.json", serializeProgress({ ...file, items }));
}

const PLATFORM_GREEN = {
  id: "M0-03",
  commit: "abc1234",
  at: "2026-09-24T12:00:00Z",
  ok: true,
  gates: {
    P1: { ok: true },
    P2: { ok: true },
    P3: { ok: true, coverage: 95 },
    P4: { ok: true },
    P5: { ok: true },
    P6: { ok: true, skipped: "not-a-visual-item" },
    P7: { ok: true },
  },
  accept: [{ criterion: "refuses done without verify artifact", ok: true }],
};

const GAME_GREEN = {
  id: "ludo",
  commit: "abc1234",
  gates: Object.fromEntries(
    ["G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8a", "G8b", "G9", "G10", "G11", "G13", "G14"].map(
      (g) => [g, { ok: true }],
    ),
  ),
};

const criticReport = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  game: "ludo",
  round: 1,
  critic: "merged",
  pass: true,
  ab: [],
  scores: {},
  clipScores: {},
  minScore: 8.7,
  issues: [],
  ...over,
});

beforeEach(async () => {
  root = makeRoot();
  expect((await cli("sync")).code).toBe(0);
});

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("roadmap parsing", () => {
  const items = parseRoadmap(ROADMAP);
  const ids = items.map((i) => i.id);

  it("finds every roadmap item exactly once, sorted", () => {
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort(compareIds)).toEqual(ids);
    // Headings (M0, M1), the M10 table, the game template (Mx-01..05) and in-section extras.
    for (const id of [
      "M0-01",
      "M0-03",
      "M0-06",
      "M1-10",
      "M10-01",
      "M10-11",
      "M2-06",
      "M4-01b",
      "M5-01b",
      "M5-06",
      "M8-01b",
      "M9-00",
      "M9-00b",
    ])
      expect(ids).toContain(id);
    for (const m of [2, 3, 4, 5, 6, 7, 8, 9])
      for (const s of ["01", "02", "03", "04", "05"]) expect(ids).toContain(`M${m}-${s}`);
    expect(ids).toHaveLength(74);
  });

  it("derives titles, kinds, games and visual flags", () => {
    const by = new Map(items.map((i) => [i.id, i]));
    expect(by.get("M0-03")).toMatchObject({
      title: "Agent house rules + progress tooling",
      kind: "platform",
      game: null,
    });
    expect(by.get("M7-03")).toMatchObject({
      title: "ludo: Stage",
      kind: "game",
      game: "ludo",
      milestone: "M7",
    });
    expect(by.get("M9-00")?.title).toBe("marble-rally: Physics solver");
    expect(by.get("M4-01b")?.title).toBe("trivia-night: Bluff mode logic");
    expect(by.get("M10-03")?.title).toBe("SqliteStore + crash restore");
  });

  it("orders suffixed ids after their base and milestones numerically", () => {
    expect(["M10-01", "M9-00b", "M9-01", "M9-00", "M2-06"].sort(compareIds)).toEqual([
      "M2-06",
      "M9-00",
      "M9-00b",
      "M9-01",
      "M10-01",
    ]);
    expect(compareIds("x", "y")).toBe(-1);
    expect(compareIds("y", "x")).toBe(1);
    expect(compareIds("x", "x")).toBe(0);
  });

  it("rejects a roadmap that defines an id twice", () => {
    expect(() => parseRoadmap("### M0-01 A\n### M0-01 B\n")).toThrow(/twice/);
  });
});

describe("progress.json in the repo", () => {
  const file = readProgress(REPO);

  it("has exactly one entry per roadmap item id, in roadmap order", () => {
    expect(file.items.map((i) => i.id)).toEqual(parseRoadmap(ROADMAP).map((i) => i.id));
  });

  it("starts every item at todo; anything else was set through the tool (has `updated`)", () => {
    for (const i of file.items) if (i.status !== "todo") expect(i.updated, i.id).not.toBeNull();
  });

  it("is byte-identical to its own canonical serialization", () => {
    expect(readFileSync(join(REPO, "progress.json"), "utf8")).toBe(serializeProgress(file));
  });

  it("marks exactly the critic-judged items as visual, with evidence paths", () => {
    const visual = file.items.filter((i) => i.visual).map((i) => i.id);
    for (const id of [
      "M1-05",
      "M1-07",
      "M1-09",
      "M10-01",
      "M10-08",
      "M10-09",
      "M2-06",
      "M7-03",
      "M7-04",
      "M7-05",
    ])
      expect(visual).toContain(id);
    for (const id of ["M0-03", "M1-01", "M7-01", "M7-02", "M5-06", "M10-07"])
      expect(visual).not.toContain(id);
    const by = new Map(file.items.map((i) => [i.id, i]));
    expect(by.get("M7-05")?.evidence).toEqual({
      handoff: "artifacts/handoff/ludo.md",
      verify: "artifacts/verify/ludo.json",
      critic: "artifacts/critic/ludo",
      gates: [
        "G1",
        "G2",
        "G3",
        "G4",
        "G5",
        "G6",
        "G7",
        "G8a",
        "G8b",
        "G9",
        "G10",
        "G11",
        "G13",
        "G14",
      ],
    });
    expect(by.get("M0-03")?.evidence).toEqual({
      handoff: "artifacts/handoff/M0-03.md",
      verify: "artifacts/verify/M0-03.json",
      critic: null,
      gates: ["P1", "P2", "P3", "P4", "P5", "P7"],
    });
    expect(by.get("M10-09")?.evidence.critic).toBe("artifacts/critic/drift");
    expect(by.get("M2-06")?.evidence.critic).toBe("artifacts/critic/M2-06");
    expect(by.get("M7-01")?.evidence.gates).toEqual([]);
  });

  it("PROGRESS.md is current", () => {
    expect(readFileSync(join(REPO, "PROGRESS.md"), "utf8")).toBe(renderProgress(file));
  });
});

describe("lifecycle", () => {
  const legal = (status: Status, visual: boolean): Status[] => allowedNext({ status, visual });

  it("follows DOD §8 for visual and non-visual items", () => {
    expect(legal("todo", false)).toEqual(["building", "blocked"]);
    expect(legal("building", true)).toEqual(["verifying", "blocked"]);
    expect(legal("verifying", false)).toEqual(["done", "fixing", "blocked"]);
    expect(legal("verifying", true)).toEqual(["critic", "fixing", "blocked"]);
    expect(legal("critic", true)).toEqual(["done", "fixing", "blocked"]);
    expect(legal("fixing", true)).toEqual(["verifying", "blocked"]);
    expect(legal("done", true)).toEqual(["fixing", "blocked"]);
    expect(legal("blocked", false)).toEqual(["todo", "building", "fixing"]);
    for (const s of STATUSES) if (s !== "blocked") expect(legal(s, true)).toContain("blocked");
  });

  it("refuses illegal jumps and leaves the files untouched", async () => {
    const before = read("progress.json");
    const run = await cli("set", "M0-03", "status=done");
    expect(run.code).toBe(2);
    expect(run.err.join("\n")).toMatch(/illegal transition todo → done/);
    expect(read("progress.json")).toBe(before);
    expect((await cli("set", "M0-03", "status=verifying")).code).toBe(2);
    expect((await cli("set", "M0-03", "status=todo")).err.join()).toMatch(
      /illegal transition todo → todo/,
    );
  });

  it("refuses the critic for items without visuals and verifying → done for visual ones", async () => {
    force("M0-03", { status: "verifying" });
    expect((await cli("set", "M0-03", "status=critic")).err.join()).toMatch(/no visuals/);
    force("M1-05", { status: "verifying" });
    expect((await cli("set", "M1-05", "status=done")).err.join()).toMatch(/must pass the critic/);
  });

  it("walks a platform item todo → done with evidence at each step", async () => {
    expect((await cli("set", "M0-03", "status=building", "owner=builder-1")).code).toBe(0);
    expect(item("M0-03")).toMatchObject({
      status: "building",
      owner: "builder-1",
      updated: "2026-09-24T12:34:56Z",
    });

    const noHandoff = await cli("set", "M0-03", "status=verifying");
    expect(noHandoff.code).toBe(2);
    expect(noHandoff.err.join()).toMatch(/no handoff at artifacts\/handoff\/M0-03\.md/);
    write("artifacts/handoff/M0-03.md", "   \n");
    expect((await cli("set", "M0-03", "status=verifying")).err.join()).toMatch(/empty/);
    write("artifacts/handoff/M0-03.md", "# M0-03 handoff\n");
    expect((await cli("set", "M0-03", "status=verifying")).code).toBe(0);

    writeJson("artifacts/verify/M0-03.json", PLATFORM_GREEN);
    const done = await cli("set", "M0-03", "status=done");
    expect(done.code).toBe(0);
    expect(done.out[0]).toBe("M0-03: verifying → done");
    expect(done.out.join()).toMatch(/not a git work tree/);
    expect(item("M0-03").status).toBe("done");
    expect(read("PROGRESS.md")).toBe(renderProgress(readProgress(root)));
    expect(read("PROGRESS.md")).toMatch(
      /\| M0-03 \| Agent house rules \+ progress tooling \| \*\*done\*\* \|/,
    );
  });

  it("blocked needs a reason, keeps it while blocked and clears it on unblock", async () => {
    expect((await cli("set", "M0-04", "status=blocked")).err.join()).toMatch(/needs reason/);
    expect((await cli("set", "M0-04", "status=blocked", "reason=waiting on M0-02")).code).toBe(0);
    expect(item("M0-04")).toMatchObject({ status: "blocked", blockedReason: "waiting on M0-02" });
    expect(readProgress(root).items.find((i) => i.id === "M0-04")?.blockedReason).toBe(
      "waiting on M0-02",
    );
    expect(read("PROGRESS.md")).toMatch(/\*\*blocked\*\* .*blocked: waiting on M0-02/);
    expect((await cli("set", "M0-04", "blockedReason=still waiting")).code).toBe(0);
    expect(item("M0-04").blockedReason).toBe("still waiting");
    expect((await cli("set", "M0-04", "reason=  ")).code).toBe(1);
    expect((await cli("set", "M0-04", "status=building")).code).toBe(0);
    expect(item("M0-04")).toMatchObject({ status: "building", blockedReason: null });
    expect((await cli("set", "M0-04", "reason=x")).err.join()).toMatch(
      /only valid with status=blocked/,
    );
  });

  it("counts critic rounds and refuses a sixth", async () => {
    force("M7-05", { status: "verifying" });
    writeJson("artifacts/verify/ludo.json", GAME_GREEN);
    expect((await cli("set", "M7-05", "status=critic")).code).toBe(0);
    expect(item("M7-05").criticRound).toBe(1);
    force("M7-05", { status: "verifying", criticRound: 5 });
    const run = await cli("set", "M7-05", "status=critic");
    expect(run.code).toBe(2);
    expect(run.err.join()).toMatch(/5\/5 critic rounds.*blocked/);
  });
});

describe("verify evidence", () => {
  beforeEach(() => force("M0-03", { status: "verifying" }));

  it("refuses done while there is no verify artifact (ROADMAP M0-03 Accept)", async () => {
    const before = read("progress.json");
    const run = await cli("set", "M0-03", "status=done");
    expect(run.code).toBe(2);
    expect(run.err.join("\n")).toMatch(
      /no verify artifact at artifacts\/verify\/M0-03\.json \(run `pnpm verify:item M0-03`\)/,
    );
    expect(read("progress.json")).toBe(before);
    expect(item("M0-03").status).toBe("verifying");
  });

  const red: [string, Record<string, unknown>, RegExp][] = [
    [
      "a failing gate",
      { gates: { ...PLATFORM_GREEN.gates, P3: { ok: false } } },
      /gate P3 is not ok/,
    ],
    ["a missing required gate", { gates: { P1: { ok: true } } }, /gate P2 is missing/],
    [
      "a gate that is not an object",
      { gates: { ...PLATFORM_GREEN.gates, P1: true } },
      /gate P1 is not an object/,
    ],
    ["top-level ok: false", { ok: false }, /ok: false/],
    ["another item's id", { id: "M0-02" }, /is for "M0-02", not M0-03/],
    [
      "a failed acceptance bullet",
      { accept: [{ criterion: "renders the same", ok: false }] },
      /acceptance criterion not ok: renders the same/,
    ],
    [
      "an unlabeled failed acceptance bullet",
      { accept: [null] },
      /acceptance criterion not ok: #1/,
    ],
    ["a malformed accept list", { accept: "yes" }, /accept is not an array/],
    ["no gates object", { gates: undefined }, /no gates object/],
    ["an empty gates object", { gates: {} }, /reports no gates/],
  ];
  it.each(red)("refuses done with %s", async (_label, patch, message) => {
    writeJson("artifacts/verify/M0-03.json", { ...PLATFORM_GREEN, ...patch });
    const run = await cli("set", "M0-03", "status=done");
    expect(run.code).toBe(2);
    expect(run.err.join("\n")).toMatch(message);
  });

  it("refuses unreadable verify JSON", async () => {
    write("artifacts/verify/M0-03.json", "{ nope");
    expect((await cli("set", "M0-03", "status=done")).err.join()).toMatch(/not valid JSON/);
    write("artifacts/verify/M0-03.json", "[1]");
    expect((await cli("set", "M0-03", "status=done")).err.join()).toMatch(/not a JSON object/);
  });

  it("accepts G8b skipped for no-gpu, except for M10-07", () => {
    const skipped = { ...GAME_GREEN, gates: { ...GAME_GREEN.gates, G8b: { skipped: "no-gpu" } } };
    writeJson("artifacts/verify/ludo.json", skipped);
    expect(checkVerify(root, item("M7-05")).ok).toBe(true);
    writeJson("artifacts/verify/ludo.json", {
      ...skipped,
      gates: { ...skipped.gates, G8b: { skipped: "other" } },
    });
    expect(checkVerify(root, item("M7-05")).problems).toEqual(["gate G8b is not ok"]);
    const m1007 = item("M10-07");
    writeJson("artifacts/verify/M10-07.json", {
      ...PLATFORM_GREEN,
      id: "M10-07",
      gates: { ...PLATFORM_GREEN.gates, G8b: { skipped: "no-gpu" } },
    });
    expect(checkVerify(root, m1007).problems).toEqual([
      "gate G8b is skipped (no-gpu), which blocks M10-07",
    ]);
  });

  it("ignores critic-owned gates for visual items only", () => {
    writeJson("artifacts/verify/M1-05.json", {
      ...PLATFORM_GREEN,
      id: "M1-05",
      gates: { ...PLATFORM_GREEN.gates, P6: { ok: false, pending: "critic" } },
    });
    expect(checkVerify(root, item("M1-05")).ok).toBe(true);
    writeJson("artifacts/verify/M0-03.json", {
      ...PLATFORM_GREEN,
      gates: { ...PLATFORM_GREEN.gates, P6: { ok: false } },
    });
    expect(checkVerify(root, item("M0-03")).problems).toEqual(["gate P6 is not ok"]);
  });

  it("names the right verify command", () => {
    expect(verifyCommand(item("M7-05"))).toBe("pnpm verify:game ludo");
    expect(verifyCommand(item("M7-01"))).toBe("pnpm verify:item M7-01");
    expect(verifyCommand(item("M0-03"))).toBe("pnpm verify:item M0-03");
  });
});

describe("critic evidence", () => {
  beforeEach(() => {
    force("M7-05", { status: "critic", criticRound: 2 });
    writeJson("artifacts/verify/ludo.json", GAME_GREEN);
  });

  it("refuses done without a critic report", async () => {
    const run = await cli("set", "M7-05", "status=done");
    expect(run.code).toBe(2);
    expect(run.err.join()).toMatch(/no critic report at artifacts\/critic\/ludo\/round-\*\.json/);
  });

  it("uses the latest round numerically and needs pass: true", async () => {
    writeJson("artifacts/critic/ludo/round-9.json", criticReport());
    writeJson("artifacts/critic/ludo/round-10.json", criticReport({ pass: false }));
    mkdirSync(join(root, "artifacts/critic/ludo/round-11"), { recursive: true }); // screenshot dir, not a report
    write("artifacts/critic/ludo/round-12.png", "");
    expect(latestCriticRound(root, item("M7-05"))?.round).toBe(10);
    expect((await cli("set", "M7-05", "status=done")).err.join()).toMatch(
      /round-10\.json has pass: false/,
    );
    writeJson("artifacts/critic/ludo/round-10.json", criticReport());
    expect((await cli("set", "M7-05", "status=done")).code).toBe(0);
  });

  it("refuses open blockers but accepts waived ones", async () => {
    const blocker = {
      id: "LU-R1-01",
      item: 2,
      severity: "blocker",
      files: ["x"],
      region: "r",
      problem: "unreadable",
      rule: "r",
      fix: "f",
    };
    writeJson("artifacts/critic/ludo/round-1.json", criticReport({ issues: [blocker] }));
    expect((await cli("set", "M7-05", "status=done")).err.join()).toMatch(
      /open blockers: LU-R1-01/,
    );
    writeJson(
      "artifacts/critic/ludo/round-1.json",
      criticReport({ issues: [{ ...blocker, waived: "orchestrator: n/a on phone" }] }),
    );
    expect((await cli("set", "M7-05", "status=done")).code).toBe(0);
  });

  it("refuses an unreadable report", async () => {
    write("artifacts/critic/ludo/round-1.json", "not json");
    expect((await cli("set", "M7-05", "status=done")).err.join()).toMatch(
      /round-1\.json is unreadable/,
    );
    expect(latestCriticRound(root, item("M0-03"))).toBeNull();
  });

  it("show lists the latest round and its open issues", async () => {
    const issue = (n: number, severity = "major"): Record<string, unknown> => ({
      id: `LU-R3-${String(n).padStart(2, "0")}`,
      item: 3,
      severity,
      problem: `problem ${n}`,
    });
    writeJson(
      "artifacts/critic/ludo/round-3.json",
      criticReport({
        pass: false,
        minScore: 7.2,
        issues: [
          ...Array.from({ length: 10 }, (_, i) => issue(i + 1)),
          issue(11, "minor"),
          { junk: true },
        ],
      }),
    );
    const run = await cli("show", "M7-05");
    expect(run.code).toBe(0);
    const text = run.out.join("\n");
    expect(text).toMatch(/latest round 3: fail, min 7.2/);
    expect(text).toMatch(/LU-R3-01 \[major\] item 3: problem 1/);
    expect(text).toMatch(/… 3 more/); // 11 non-minor issues (incl. the malformed one) → 8 shown
    expect(text).not.toMatch(/LU-R3-11/);
  });
});

describe("verify commit (git)", () => {
  function gitRun(...args: string[]): string {
    return execFileSync(
      "git",
      [
        "-C",
        root,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
  }

  it("requires a commit on the current history when inside a git work tree", async () => {
    gitRun("init", "-q", "-b", "main");
    force("M0-03", { status: "verifying" });
    writeJson("artifacts/verify/M0-03.json", { ...PLATFORM_GREEN, commit: undefined });
    // No HEAD yet.
    expect(checkVerifyCommit(root, item("M0-03")).problems.join()).toMatch(/no commit sha/);
    gitRun("add", "-A");
    gitRun("commit", "-q", "-m", "first");
    const first = gitRun("rev-parse", "HEAD");

    expect((await cli("set", "M0-03", "status=done")).err.join()).toMatch(/has no commit sha/);
    writeJson("artifacts/verify/M0-03.json", { ...PLATFORM_GREEN, commit: "deadbee" });
    expect((await cli("set", "M0-03", "status=done")).err.join()).toMatch(
      /deadbee is not in this repository/,
    );

    gitRun("checkout", "-q", "-b", "side");
    write("side.txt", "x");
    gitRun("add", "-A");
    gitRun("commit", "-q", "-m", "side");
    const side = gitRun("rev-parse", "HEAD");
    gitRun("checkout", "-q", "main");
    write("main.txt", "y");
    gitRun("add", "-A");
    gitRun("commit", "-q", "-m", "second");
    writeJson("artifacts/verify/M0-03.json", { ...PLATFORM_GREEN, commit: side.slice(0, 7) });
    expect((await cli("set", "M0-03", "status=done")).err.join()).toMatch(
      /not on the current history/,
    );

    writeJson("artifacts/verify/M0-03.json", { ...PLATFORM_GREEN, commit: first.slice(0, 7) });
    const ok = await cli("set", "M0-03", "status=done");
    expect(ok.code).toBe(0);
    expect(ok.out.join()).toMatch(/verified at .*HEAD is/);
  });

  it("reports no HEAD in an empty repository", () => {
    gitRun("init", "-q");
    writeJson("artifacts/verify/M0-03.json", PLATFORM_GREEN);
    expect(checkVerifyCommit(root, item("M0-03")).problems).toEqual([
      "the repository has no HEAD commit",
    ]);
  });
});

describe("PROGRESS.md rendering", () => {
  it("regenerates byte-identically every time", async () => {
    await cli("set", "M1-01", "status=building", "owner=builder-a", "notes=line one\\nline | two");
    const first = read("PROGRESS.md");
    expect((await cli("render")).code).toBe(0);
    expect(read("PROGRESS.md")).toBe(first);
    expect((await cli("render")).code).toBe(0);
    expect(read("PROGRESS.md")).toBe(first);
    expect(first).not.toMatch(/\r/);
    expect(first.endsWith("\n")).toBe(true);
    // Independent of the item order and of key order inside progress.json.
    const file = readProgress(root);
    const shuffled: ProgressFile = {
      version: 1,
      items: [...file.items]
        .reverse()
        .map((i) => Object.fromEntries(Object.entries(i).reverse()) as unknown as ProgressItem),
    };
    expect(renderProgress(shuffled)).toBe(first);
    expect(renderProgress(validateProgress(JSON.parse(JSON.stringify(shuffled))))).toBe(first);
  });

  it("renders groups, a summary and escaped cells", async () => {
    await cli("set", "M1-01", "status=building", "owner=a|b", "notes=x | y\\nz \\\\ w");
    const md = read("PROGRESS.md");
    expect(md).toMatch(/^# Progress\n/);
    expect(md).toMatch(/\*\*74 items:\*\* todo 73 · building 1/);
    expect(md).toMatch(/## M7 `ludo` \(0\/5 done\)/);
    expect(md).toMatch(/## M0 \(0\/6 done\)/);
    expect(md).toMatch(
      /\| M1-01 \| .* \| building \| - \| a\\\|b \| 2026-09-24 12:34Z \| x \\\| y<br>z \\\\\\\\ w \|/,
    );
    expect(md).toMatch(/\| M7-05 \| ludo: Verify & critic \| todo \| 0\/5 \| - \| - \| {2}\|/);
    expect(md.indexOf("## M9")).toBeLessThan(md.indexOf("## M10"));
  });

  it("render --check and check detect a stale PROGRESS.md", async () => {
    expect((await cli("render", "--check")).code).toBe(0);
    expect((await cli("check")).code).toBe(0);
    write("PROGRESS.md", "hand edited\n");
    expect((await cli("render", "--check")).code).toBe(1);
    const check = await cli("check");
    expect(check.code).toBe(1);
    expect(check.err.join()).toMatch(/PROGRESS.md is out of date/);
    rmSync(join(root, "PROGRESS.md"));
    expect((await cli("render", "--check")).code).toBe(1);
  });

  it("renders unusual timestamps and an empty document", () => {
    const file = readProgress(root);
    const odd = {
      ...file,
      items: file.items.slice(0, 1).map((i) => ({ ...i, updated: "yesterday", milestone: "Mx" })),
    };
    expect(renderProgress(odd)).toMatch(/## Mx .*\n[\s\S]*\| yesterday \|/);
    expect(renderProgress({ version: 1, items: [] })).toMatch(/\*\*0 items:\*\* none/);
  });
});

describe("set arguments", () => {
  it("parses key=value, allowing = in values", () => {
    expect([...parseAssignments(["status=building", "notes=a=b"])]).toEqual([
      ["status", "building"],
      ["notes", "a=b"],
    ]);
    expect(() => parseAssignments([])).toThrow(UsageError);
    expect(() => parseAssignments(["status"])).toThrow(/key=value/);
    expect(() => parseAssignments(["colour=red"])).toThrow(/unknown field/);
    expect(() => parseAssignments(["reason=a", "blockedReason=b"])).toThrow(/given twice/);
  });

  it("edits owner and notes without a status change, and caps notes at 3 lines", async () => {
    expect((await cli("set", "M0-02", "owner=agent-7", "notes=one\\ntwo\\nthree")).code).toBe(0);
    expect(item("M0-02")).toMatchObject({
      status: "todo",
      owner: "agent-7",
      notes: "one\ntwo\nthree",
    });
    expect((await cli("set", "M0-02", "owner=-")).code).toBe(0);
    expect(item("M0-02").owner).toBeNull();
    const four = await cli("set", "M0-02", "notes=1\\n2\\n3\\n4");
    expect(four.code).toBe(1);
    expect(four.err.join()).toMatch(/capped at 3 lines/);
    expect((await cli("set", "M0-02", `notes=${"x".repeat(201)}`)).err.join()).toMatch(
      /200 characters/,
    );
  });

  it("rejects bad input with exit code 1", async () => {
    expect((await cli("set", "M99-01", "status=building")).err.join()).toMatch(/unknown item/);
    expect((await cli("set", "M0-02", "status=shipped")).err.join()).toMatch(/unknown status/);
    expect((await cli("set")).code).toBe(1);
    expect((await cli("show")).code).toBe(1);
    expect((await cli("show", "M0-01", "extra")).code).toBe(1);
    expect((await cli("render", "--force")).code).toBe(1);
    expect((await cli("list", "nope")).code).toBe(1);
    expect((await cli("list", "todo", "x")).code).toBe(1);
    expect((await cli("sync", "--all")).code).toBe(1);
    expect((await cli("check", "x")).code).toBe(1);
    expect((await cli("frobnicate")).code).toBe(1);
    expect((await cli("--root")).code).toBe(1);
    expect((await cli()).code).toBe(1);
    expect((await cli("help")).code).toBe(0);
    expect((await cli("--", "list", "building")).code).toBe(0);
  });

  it("applySet throws typed errors and does not mutate its input", () => {
    const file = readProgress(root);
    const snapshot = JSON.stringify(file);
    expect(() => applySet(file, "M0-03", new Map([["status", "done"]]), root, NOW)).toThrow(
      Refusal,
    );
    const { file: next } = applySet(file, "M0-03", new Map([["status", "building"]]), root, NOW);
    expect(JSON.stringify(file)).toBe(snapshot);
    expect(next.items.find((i) => i.id === "M0-03")?.status).toBe("building");
  });
});

describe("show and list", () => {
  it("show prints the row, legal next states and evidence", async () => {
    await cli("set", "M0-04", "status=blocked", "reason=needs M0-02", "notes=a\\nb");
    const run = await cli("show", "M0-04");
    const text = run.out.join("\n");
    expect(text).toMatch(/^M0-04 {2}@sg\/engine/);
    expect(text).toMatch(/status {5}blocked {3}\(next: todo, building, fixing\)/);
    expect(text).toMatch(/blocked {4}needs M0-02/);
    expect(text).toMatch(/handoff {2}artifacts\/handoff\/M0-04\.md {2}MISSING\/RED/);
    expect(text).toMatch(/verify {3}artifacts\/verify\/M0-04\.json {2}MISSING\/RED/);
    expect(text).not.toMatch(/critic {5}round/);
    const visual = (await cli("show", "M1-05")).out.join("\n");
    expect(visual).toMatch(/critic {5}round 0\/5/);
    expect(visual).toMatch(/artifacts\/critic\/M1-05\/round-\*\.json {2}none/);
  });

  it("list filters by status", async () => {
    await cli("set", "M0-02", "status=building", "owner=me");
    const run = await cli("list", "building");
    expect(run.out).toHaveLength(1);
    expect(run.out[0]).toMatch(/^M0-02 +building +me {2}@sg\/shared foundations$/);
    expect((await cli("list")).out).toHaveLength(74);
  });
});

describe("sync and consistency", () => {
  it("keeps state, refreshes derived fields, and reports orphans", async () => {
    await cli("set", "M0-02", "status=building", "owner=me");
    const file = readProgress(root);
    const orphan: ProgressItem = { ...file.items[0]!, id: "M0-99", title: "gone" };
    const tampered = file.items
      .filter((i) => i.id !== "M0-06")
      .map((i) => (i.id === "M0-02" ? { ...i, title: "old title" } : i));
    write("progress.json", serializeProgress({ version: 1, items: [...tampered, orphan] }));
    const check = await cli("check");
    expect(check.code).toBe(1);
    expect(check.err.join("\n")).toMatch(/M0-06 is in ROADMAP.md but not in progress.json/);
    expect(check.err.join("\n")).toMatch(/M0-99 is in progress.json but not in ROADMAP.md/);

    const kept = await cli("sync");
    expect(kept.out.join()).toMatch(/added 1: M0-06/);
    expect(kept.out.join()).toMatch(/kept .*M0-99/);
    expect(item("M0-02")).toMatchObject({
      status: "building",
      owner: "me",
      title: "@sg/shared foundations",
    });
    expect(readProgress(root).items.map((i) => i.id)).toContain("M0-99");
    expect((await cli("sync", "--prune")).out.join()).toMatch(/pruned: M0-99/);
    expect((await cli("check")).code).toBe(0);
  });

  it("seeds every roadmap item at todo", () => {
    const { file, added } = syncWithRoadmap(null, ROADMAP, false);
    expect(added).toHaveLength(74);
    expect(
      file.items.every((i) => i.status === "todo" && i.owner === null && i.updated === null),
    ).toBe(true);
  });

  it("sync and check need the roadmap", async () => {
    rmSync(join(root, "docs/ROADMAP.md"));
    expect((await cli("sync")).err.join()).toMatch(/no docs\/ROADMAP.md/);
    const check = await cli("check");
    expect(check.err.join()).toMatch(/no docs\/ROADMAP.md/);
  });
});

describe("progress.json validation", () => {
  it("reports every structural problem", () => {
    const file = readProgress(root);
    const good = file.items[0]!;
    const bad = [
      { ...good, id: "" },
      {
        ...good,
        id: "M0-02",
        title: 1,
        milestone: null,
        kind: "x",
        game: 3,
        visual: "no",
        status: "shipped",
        owner: 5,
      },
      { ...good, id: "M0-02" },
      {
        ...good,
        id: "M0-04",
        criticRound: -1,
        maxRounds: 1.5,
        blockedReason: 3,
        notes: 4,
        updated: 5,
      },
      { ...good, id: "M0-05", status: "blocked", blockedReason: null, notes: "1\n2\n3\n4" },
      { ...good, id: "M0-06", evidence: null },
      {
        ...good,
        id: "M1-01",
        visual: true,
        evidence: { handoff: 1, verify: 2, critic: 3, gates: [1] },
      },
      "nope",
    ];
    let message = "";
    try {
      validateProgress({ version: 2, items: bad });
    } catch (e) {
      message = (e as Error).message;
    }
    for (const fragment of [
      "version must be 1",
      "items[0].id must be a non-empty string",
      "(M0-02).title must be a string",
      "(M0-02).milestone must be a string",
      "kind must be platform|game",
      "game must be a string or null",
      "visual must be a boolean",
      'status "shipped" is not a status',
      "owner must be a string or null",
      "(M0-02): duplicate id",
      "criticRound must be a non-negative integer",
      "maxRounds must be a non-negative integer",
      "blockedReason must be a string or null",
      "notes must be a string",
      "updated must be a string or null",
      "blocked without blockedReason",
      "notes are capped at 3 lines",
      "evidence must be an object",
      "evidence.handoff must be a string",
      "evidence.verify must be a string",
      "evidence.critic must be a string or null",
      "visual item without evidence.critic",
      "evidence.gates must be an array of strings",
      "items[7] is not an object",
    ])
      expect(message).toContain(fragment);
    expect(() => validateProgress(null)).toThrow(/not a JSON object/);
    expect(() => validateProgress({ version: 1 })).toThrow(/items must be an array/);
  });

  it("reports a missing or corrupt progress.json", async () => {
    write("progress.json", "{");
    expect((await cli("list")).err.join()).toMatch(/not valid JSON/);
    rmSync(join(root, "progress.json"));
    expect((await cli("show", "M0-01")).err.join()).toMatch(/no progress.json/);
  });
});

describe("locking", () => {
  it("serializes concurrent sets so no update is lost", async () => {
    const ids = ["M1-01", "M1-02", "M1-03", "M1-04", "M1-06", "M1-08"];
    const runs = await Promise.all(
      ids.map((id) => cli("set", id, "status=building", `owner=${id}`)),
    );
    expect(runs.map((r) => r.code)).toEqual(ids.map(() => 0));
    for (const id of ids) expect(item(id)).toMatchObject({ status: "building", owner: id });
    expect(existsSync(join(root, "progress.json.lock"))).toBe(false);
  });

  it("times out on a live lock and clears a stale one", async () => {
    const lock = join(root, "progress.json.lock");
    writeFileSync(lock, "123\n");
    await expect(withLock(root, () => 1, 120)).rejects.toThrow(/locked by another process/);
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    await expect(withLock(root, () => 2, 120)).resolves.toBe(2);
    expect(existsSync(lock)).toBe(false);
  });

  it("releases the lock when the body throws", async () => {
    await expect(
      withLock(root, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(existsSync(join(root, "progress.json.lock"))).toBe(false);
  });
});

describe("the real CLI (`pnpm progress`)", () => {
  const pnpm = (args: string[]): { status: number | null; stdout: string; stderr: string } => {
    const r = spawnSync("pnpm", ["--silent", "progress", ...args], {
      cwd: REPO,
      encoding: "utf8",
      shell: process.platform === "win32",
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };

  it("`pnpm progress set M0-03 status=done` is refused while there is no verify artifact", () => {
    force("M0-03", { status: "verifying" });
    const before = read("progress.json");
    const refused = pnpm(["set", "M0-03", "status=done", "--root", root]);
    expect(refused.status).toBe(2);
    expect(refused.stderr).toMatch(/refused: cannot set M0-03 to done/);
    expect(refused.stderr).toMatch(/no verify artifact at artifacts\/verify\/M0-03\.json/);
    expect(read("progress.json")).toBe(before);

    writeJson("artifacts/verify/M0-03.json", PLATFORM_GREEN);
    const accepted = pnpm(["set", "M0-03", "status=done", "--root", root]);
    expect(accepted.stderr).toBe("");
    expect(accepted.status).toBe(0);
    expect(item("M0-03").status).toBe("done");
  }, 60_000);

  it("`pnpm progress render` writes the same PROGRESS.md twice", () => {
    expect(pnpm(["render", "--root", root]).status).toBe(0);
    const first = read("PROGRESS.md");
    expect(pnpm(["render", "--root", root]).status).toBe(0);
    expect(read("PROGRESS.md")).toBe(first);
    expect(first).toBe(renderProgress(readProgress(root)));
  }, 60_000);
});
