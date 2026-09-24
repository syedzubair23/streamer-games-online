/**
 * Renders `PROGRESS.md` from `progress.json`.
 *
 * The output is a pure function of the progress document: no clock, no environment, no
 * artifact reads, fixed ordering and LF line endings. The same `progress.json` therefore always
 * produces byte-identical Markdown, which keeps the file free of churn in git.
 */
import { STATUSES, type ProgressFile, type ProgressItem, type Status } from "./model.ts";
import { compareIds } from "./roadmap.ts";

/** Escapes text for a Markdown table cell. */
function cell(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\n+/g, "<br>")
    .trim();
}

function milestoneNumber(milestone: string): number {
  const n = Number(milestone.replace(/^M/, ""));
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

/** `2026-09-24T12:00:00Z` → `2026-09-24 12:00Z`. */
function shortTime(iso: string | null): string {
  if (!iso) return "-";
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]}Z` : cell(iso);
}

function statusCell(item: ProgressItem): string {
  return item.status === "blocked"
    ? "**blocked**"
    : item.status === "done"
      ? "**done**"
      : item.status;
}

function notesCell(item: ProgressItem): string {
  const parts: string[] = [];
  if (item.status === "blocked" && item.blockedReason) parts.push(`blocked: ${item.blockedReason}`);
  if (item.notes) parts.push(item.notes);
  return cell(parts.join("\n"));
}

/** Renders the whole PROGRESS.md document. */
export function renderProgress(file: ProgressFile): string {
  const items = [...file.items].sort((a, b) => compareIds(a.id, b.id));
  const counts = new Map<Status, number>();
  for (const item of items) counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
  const summary = STATUSES.filter((s) => counts.get(s))
    .map((s) => `${s} ${counts.get(s)}`)
    .join(" · ");

  const groups = new Map<string, ProgressItem[]>();
  for (const item of items) {
    const group = groups.get(item.milestone) ?? [];
    group.push(item);
    groups.set(item.milestone, group);
  }
  const milestones = [...groups.keys()].sort(
    (a, b) => milestoneNumber(a) - milestoneNumber(b) || a.localeCompare(b),
  );

  const out: string[] = [
    "# Progress",
    "",
    "> Generated from `progress.json` by `pnpm progress render`. Do not edit by hand:",
    "> change status with `pnpm progress set <id> status=<status>` (see CLAUDE.md).",
    "",
    `**${items.length} items:** ${summary || "none"}`,
    "",
  ];
  for (const milestone of milestones) {
    const group = groups.get(milestone) ?? [];
    const game = group.find((i) => i.game)?.game;
    const done = group.filter((i) => i.status === "done").length;
    out.push(`## ${milestone}${game ? ` \`${game}\`` : ""} (${done}/${group.length} done)`, "");
    out.push("| ID | Item | Status | Critic | Owner | Updated | Notes |");
    out.push("|---|---|---|---|---|---|---|");
    for (const item of group) {
      const critic = item.visual ? `${item.criticRound}/${item.maxRounds}` : "-";
      out.push(
        `| ${cell(item.id)} | ${cell(item.title)} | ${statusCell(item)} | ${critic} | ${
          item.owner ? cell(item.owner) : "-"
        } | ${shortTime(item.updated)} | ${notesCell(item)} |`,
      );
    }
    out.push("");
  }
  return `${out.join("\n").trimEnd()}\n`;
}
