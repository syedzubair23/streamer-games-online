/**
 * M0-06 critic kit: the rubric, schema and prompts are faithful copies of DOD §4–§6, and the
 * parsing, validation and merge logic behave as DOD §4.3/§5 require.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type CriticReport,
  createReportValidator,
  extractJson,
  groupMean,
  loadReportSchema,
  mergeGroup,
  needsThirdCritic,
} from "../src/critic/report.ts";
import { loadRubric, parseRubric, stillItems } from "../src/critic/rubric.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (p: string): string => readFileSync(join(root, p), "utf8").replace(/\r\n/g, "\n");
const dod = read("docs/DOD.md");

/** The DOD text between two headings (exclusive of the end heading). */
function dodSection(start: string, end: string): string {
  const a = dod.indexOf(start);
  const b = dod.indexOf(end, a + start.length);
  expect(a, `DOD heading ${start}`).toBeGreaterThanOrEqual(0);
  expect(b, `DOD heading ${end}`).toBeGreaterThan(a);
  return dod.slice(a, b);
}
const fenced = (text: string, lang: string): string => {
  const m = new RegExp("```" + lang + "\\n([\\s\\S]*?)```").exec(text);
  expect(m, `a \`\`\`${lang} block`).not.toBeNull();
  return (m as RegExpExecArray)[1] as string;
};

describe("critic kit files are copies of DOD.md", () => {
  it("RUBRIC.md contains DOD §4.1–§4.3 verbatim", () => {
    const section = dodSection("### 4.1 Anchors", "\n---\n\n## 5.").trim();
    expect(read("docs/critic/RUBRIC.md")).toContain(section);
  });

  it("report.schema.json equals the DOD §5 schema", () => {
    const section = dodSection("## 5. Critic report schema", "## 6. Prompts");
    expect(JSON.parse(read("docs/critic/report.schema.json"))).toEqual(
      JSON.parse(fenced(section, "json")),
    );
  });

  it("BUILDER_PROMPT.md contains the DOD §6.1 prompt verbatim", () => {
    const section = dodSection("### 6.1 Builder prompt", "### 6.2 Critic prompt");
    expect(read("docs/critic/BUILDER_PROMPT.md")).toContain(fenced(section, "text"));
  });

  it("CRITIC_PROMPT.md contains the DOD §6.2 prompt verbatim", () => {
    const section = dodSection("### 6.2 Critic prompt", "## 7. Critic loop protocol");
    expect(read("docs/critic/CRITIC_PROMPT.md")).toContain(fenced(section, "text"));
  });
});

describe("rubric parsing", () => {
  const rubric = loadRubric(root);

  it("finds the 18 items with the right ★, clip and phone flags", () => {
    expect(rubric.items.map((i) => i.id)).toEqual(Array.from({ length: 18 }, (_, i) => i + 1));
    expect(rubric.items.filter((i) => i.star).map((i) => i.id)).toEqual([1, 2, 6, 15]);
    expect(rubric.items.filter((i) => i.clip).map((i) => i.id)).toEqual([12, 16]);
    expect(rubric.items.filter((i) => i.phone).map((i) => i.id)).toEqual([14]);
    expect(rubric.items[0]?.name).toBe("Style consistency");
    expect(stillItems(rubric)).toHaveLength(15);
  });

  it("finds the §4.1 anchors", () => {
    expect([...rubric.anchors.keys()]).toEqual([10, 9.5, 9, 8.5, 7, 5, 3]);
    expect(rubric.anchors.get(5)).toMatch(/^A working prototype/);
    expect(rubric.anchors.get(3)).toMatch(/^Broken or placeholder/);
  });

  it("rejects a document without items, anchors or with a numbering gap", () => {
    expect(() => parseRubric("| **10** | top |\n")).toThrow(/no items/);
    expect(() => parseRubric("| 1 | **A** | x | y |\n")).toThrow(/no score anchors/);
    expect(() =>
      parseRubric("| **10** | top |\n| 1 | **A** | x | y |\n| 3 | **C** | x | y |\n"),
    ).toThrow(/numbered/);
  });
});

const validReport = (): CriticReport => ({
  game: "ludo",
  round: 1,
  critic: "c1",
  pass: false,
  ab: [{ pair: "pair-01", choice: "tie", why: "Both cohesive." }],
  scores: { "night/360x800": { "1": 8, "2": 9, "12": null } },
  clipScores: { "12": 8.5 },
  minScore: 8,
  issues: [
    {
      id: "LUD-R1-01",
      item: 1,
      severity: "blocker",
      files: ["packages/games/ludo/src/client/stage.ts"],
      region: "centre 30%",
      problem: "Grey default material on pawns.",
      rule: "SPEC §13.3",
      fix: "Use ctx.materials.clay with token wood-300.",
    },
  ],
});

describe("report schema validation", () => {
  const validate = createReportValidator(loadReportSchema(root));

  it("accepts a well-formed report", () => {
    expect(validate(validReport()).ok).toBe(true);
  });

  it.each([
    [
      "a score above 10",
      (r: CriticReport) => void ((r.scores["night/360x800"] as Record<string, number>)["1"] = 11),
    ],
    [
      "a malformed issue id",
      (r: CriticReport) => void ((r.issues[0] as { id: string }).id = "bad"),
    ],
    [
      "an issue with no files",
      (r: CriticReport) => void ((r.issues[0] as { files: string[] }).files = []),
    ],
    [
      "an unknown A/B choice",
      (r: CriticReport) => void ((r.ab[0] as { choice: string }).choice = "C"),
    ],
    [
      "a missing required field",
      (r: CriticReport) => void delete (r as Partial<CriticReport>).minScore,
    ],
  ])("rejects %s", (_label, mutate) => {
    const r = validReport();
    mutate(r);
    const res = validate(r);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.length).toBeGreaterThan(0);
  });
});

describe("extractJson", () => {
  it("parses plain JSON, a fenced block, or the outermost object in prose", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('Here:\n```json\n{"a":2}\n```\nthanks')).toEqual({ a: 2 });
    expect(extractJson('Result: {"a":{"b":3}} done')).toEqual({ a: { b: 3 } });
  });
  it("throws when there is no JSON", () => {
    expect(() => extractJson("no json here")).toThrow(/no parseable JSON/);
  });
});

describe("DOD §4.3 merge", () => {
  const rubric = parseRubric(
    [
      "| **10** | top |",
      "| 1 ★ | **Star** | a | b |",
      "| 2 | **Plain** | a | b |",
      "| 3 | **Clip** (clip) | a | b |",
    ].join("\n"),
  );

  it("uses the minimum for ★ items and the mean for the others", () => {
    expect(
      mergeGroup(
        [
          { "1": 9, "2": 8, "3": null },
          { "1": 8, "2": 9, "3": null },
        ],
        rubric,
      ),
    ).toEqual({
      "1": 8,
      "2": 8.5,
      "3": null,
    });
  });

  it("uses the median of every item with three critics", () => {
    expect(
      mergeGroup(
        [
          { "1": 9, "2": 5 },
          { "1": 6, "2": 9 },
          { "1": 8, "2": 7 },
        ],
        rubric,
      ),
    ).toEqual({
      "1": 8,
      "2": 7,
      "3": null,
    });
    expect(
      mergeGroup(
        [
          { "1": 9, "2": 6 },
          { "1": 6, "2": null },
          { "1": 8, "2": 8 },
        ],
        rubric,
      )["2"],
    ).toBe(7);
  });

  it("skips nulls from one critic and refuses zero critics", () => {
    expect(
      mergeGroup(
        [
          { "1": 9, "2": null },
          { "1": 9, "2": 7 },
        ],
        rubric,
      )["2"],
    ).toBe(7);
    expect(() => mergeGroup([], rubric)).toThrow();
  });

  it("asks for a third critic on a > 1.5 ★ gap or a > 1.5 overall-mean gap only", () => {
    expect(
      needsThirdCritic(
        [
          [
            { "1": 9, "2": 8 },
            { "1": 7.4, "2": 8 },
          ],
        ],
        rubric,
      ),
    ).toBe(true);
    expect(
      needsThirdCritic(
        [
          [
            { "1": 9, "2": 8 },
            { "1": 7.5, "2": 8 },
          ],
        ],
        rubric,
      ),
    ).toBe(false);
    expect(
      needsThirdCritic(
        [
          [
            { "1": 9, "2": 9 },
            { "1": 8, "2": 6 },
          ],
        ],
        rubric,
      ),
    ).toBe(true);
    expect(needsThirdCritic([[{ "1": 9, "2": 9 }]], rubric)).toBe(false);
  });

  it("groupMean ignores nulls", () => {
    expect(groupMean({ "1": 8, "2": null, "3": 9 })).toBe(8.5);
    expect(groupMean({ "1": null })).toBeNaN();
  });
});
