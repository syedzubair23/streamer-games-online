/**
 * Reads the parts of a game spec (`docs/specs/<id>.md`) the harness automates:
 *
 * - the **Scenarios** table (`| id | roles | description | what the critic should see | anim |`),
 *   which drives G6 coverage and the §3 screenshot matrix;
 * - the **Perf script** line (G8b);
 * - the numbered **rules** (`**R7**`) and **test cases** (`**T12**`) G3 requires a test for;
 * - the **Builder notes** section (G13, at most 20 lines).
 *
 * @module
 */

/** A scenario role (SPEC §14). */
export type Role = "stage" | "host" | "player" | "audience";
export const ROLES: readonly Role[] = ["stage", "host", "player", "audience"];

/** One row of a spec's Scenarios table. */
export interface SpecScenario {
  id: string;
  /** Base roles, in table order (`player(drawer)` counts as `player`). */
  roles: Role[];
  /**
   * Role qualifiers from the table, e.g. `player(drawer), player(guesser)` gives
   * `{ player: ["drawer", "guesser"] }`. The harness renders a scenario's own viewer per role.
   */
  variants: Partial<Record<Role, string[]>>;
  description: string;
  /** "What the critic should see" (column 4). */
  critic: string;
  /** The hero animation, or null for "—". */
  anim: { name: string; durationMs: number } | null;
}

/** Everything the harness reads from a spec. */
export interface GameSpec {
  scenarios: SpecScenario[];
  /** Animation names of the perf script, in order (repeats expanded). */
  perfScript: string[];
  /** Rule ids, e.g. `R1`, `R3a`. */
  rules: string[];
  /** Test-case ids, e.g. `T1`. */
  tests: string[];
  /** Lines of the Builder notes section (without the heading), or null when missing. */
  builderNotes: string[] | null;
}

/** Splits markdown into `## ` sections: heading text → body. */
export function sections(md: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  let current: string | null = null;
  let body: string[] = [];
  const flush = (): void => {
    if (current !== null) out.set(current, body.join("\n"));
  };
  for (const line of lines) {
    const m = /^## (?!#)(.+?)\s*$/.exec(line);
    if (m !== null) {
      flush();
      current = (m[1] as string).trim();
      body = [];
    } else if (current !== null) body.push(line);
  }
  flush();
  return out;
}

/** Finds a section whose heading starts with `prefix` (case-insensitive). */
export function section(md: string, prefix: string): string | null {
  for (const [heading, body] of sections(md)) {
    if (heading.toLowerCase().startsWith(prefix.toLowerCase())) return body;
  }
  return null;
}

const cells = (row: string): string[] =>
  row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());

/** Parses an anim cell such as "`plane` 600 ms", "`win` 2 s" or "—". */
export function parseAnim(cell: string): SpecScenario["anim"] {
  const text = cell.replace(/`/g, "").trim();
  if (text === "" || /^[—–-]+$/.test(text)) return null;
  const m = /^([a-z][a-z0-9-]*)\s+(\d+(?:\.\d+)?)\s*(ms|s)\b/i.exec(text);
  if (m === null) throw new Error(`cannot parse anim cell "${cell}" (want "\`name\` 600 ms")`);
  const n = Number(m[2]);
  return {
    name: (m[1] as string).toLowerCase(),
    durationMs: Math.round((m[3] as string).toLowerCase() === "s" ? n * 1000 : n),
  };
}

/** Parses a roles cell such as `stage, player(drawer), audience`. */
export function parseRoles(id: string, cell: string): Pick<SpecScenario, "roles" | "variants"> {
  const roles: Role[] = [];
  const variants: Partial<Record<Role, string[]>> = {};
  for (const raw of cell.split(",").map((r) => r.trim().toLowerCase())) {
    if (raw === "") continue;
    const m = /^([a-z]+)(?:\(([a-z0-9 -]+)\))?$/.exec(raw);
    const role = m?.[1] ?? raw;
    if (m === null || !(ROLES as readonly string[]).includes(role))
      throw new Error(`scenario ${id}: unknown role "${raw}"`);
    if (!roles.includes(role as Role)) roles.push(role as Role);
    if (m[2] !== undefined) (variants[role as Role] ??= []).push(m[2].trim());
  }
  if (roles.length === 0) throw new Error(`scenario ${id}: no roles`);
  return { roles, variants };
}

/** Parses the Scenarios table of a spec. */
export function parseScenarioTable(md: string): SpecScenario[] {
  const body = section(md, "Scenarios");
  if (body === null) throw new Error("spec has no ## Scenarios section");
  const rows = body.split("\n").filter((l) => l.trim().startsWith("|"));
  const header = rows[0] === undefined ? [] : cells(rows[0]).map((c) => c.toLowerCase());
  const col = (name: string): number => header.findIndex((h) => h.startsWith(name));
  const [iId, iRoles, iDesc, iCritic, iAnim] = [
    col("id"),
    col("roles"),
    col("description"),
    col("what"),
    col("anim"),
  ];
  if (iId < 0 || iRoles < 0 || iDesc < 0)
    throw new Error("Scenarios table needs id, roles and description columns");
  const out: SpecScenario[] = [];
  for (const row of rows.slice(1)) {
    const c = cells(row);
    if (c.every((x) => /^:?-{2,}:?$/.test(x))) continue; // separator row
    const id = (c[iId] ?? "").replace(/`/g, "");
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`bad scenario id "${id}"`);
    const { roles, variants } = parseRoles(id, c[iRoles] ?? "");
    if (out.some((s) => s.id === id)) throw new Error(`scenario ${id} is listed twice`);
    out.push({
      id,
      roles,
      variants,
      description: c[iDesc] ?? "",
      critic: iCritic >= 0 ? (c[iCritic] ?? "") : "",
      anim: iAnim >= 0 ? parseAnim(c[iAnim] ?? "") : null,
    });
  }
  if (out.length === 0) throw new Error("Scenarios table has no rows");
  return out;
}

/**
 * Parses the `**Perf script:**` line into animation names, keeping only names that are anims in
 * the Scenarios table (in order; `×4` repeats the previous name).
 */
export function parsePerfScript(md: string, scenarios: readonly SpecScenario[]): string[] {
  const line = md.split(/\r?\n/).find((l) => /\*\*Perf script:?\*\*/i.test(l));
  if (line === undefined) return [];
  const anims = new Set(scenarios.flatMap((s) => (s.anim !== null ? [s.anim.name] : [])));
  const text = line.replace(/\*\*Perf script:?\*\*/i, "");
  const out: string[] = [];
  const re = /`?([a-z][a-z0-9-]*)`?(?:\s*[×x]\s*(\d+))?/gi;
  for (const m of text.matchAll(re)) {
    const name = (m[1] as string).toLowerCase();
    if (!anims.has(name)) continue;
    const times = m[2] !== undefined ? Number(m[2]) : 1;
    for (let i = 0; i < times; i++) out.push(name);
  }
  return out;
}

/**
 * Rule ids (`**R7**`, `**R8 QUIP-OUT:**`, `(R3a)`) in every rules section (`## Rules`,
 * `## Guess mode rules`, …).
 */
export function parseRuleIds(md: string): string[] {
  const ids = new Set<string>();
  for (const [heading, body] of sections(md)) {
    if (!/\brules\b/i.test(heading)) continue;
    for (const m of body.matchAll(/\*\*(R\d+[a-z]?)\b/g)) ids.add(m[1] as string);
    for (const m of body.matchAll(/\((R\d+[a-z])\)/g)) ids.add(m[1] as string);
  }
  return [...ids];
}

/** Test-case ids (`**T12**`) in the "Test cases" section. */
export function parseTestIds(md: string): string[] {
  const body = section(md, "Test cases");
  if (body === null) return [];
  const ids = new Set<string>();
  for (const m of body.matchAll(/\*\*(T\d+)\*\*/g)) ids.add(m[1] as string);
  return [...ids];
}

/** The Builder notes lines (trimmed of blank edges), or null when the section is missing. */
export function parseBuilderNotes(md: string): string[] | null {
  const body = section(md, "Builder notes");
  if (body === null) return null;
  const lines = body.split("\n");
  while (lines.length > 0 && (lines[lines.length - 1] ?? "").trim() === "") lines.pop();
  while (lines.length > 0 && (lines[0] ?? "").trim() === "") lines.shift();
  return lines;
}

/** Parses everything the harness needs from a spec. */
export function parseGameSpec(md: string): GameSpec {
  const scenarios = parseScenarioTable(md);
  return {
    scenarios,
    perfScript: parsePerfScript(md, scenarios),
    rules: parseRuleIds(md),
    tests: parseTestIds(md),
    builderNotes: parseBuilderNotes(md),
  };
}

/** Rule/test ids with no test named `R7:` / `T12:` among `testNames` (DOD G3 naming). */
export function missingNumberedTests(
  ids: readonly string[],
  testNames: readonly string[],
): string[] {
  return ids.filter((id) => !testNames.some((n) => new RegExp(`(^|[^A-Za-z0-9])${id}:`).test(n)));
}
