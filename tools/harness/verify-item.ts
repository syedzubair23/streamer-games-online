/**
 * `pnpm verify:item <id>`: the Platform DoD (P1–P7) for one roadmap item, written to
 * `artifacts/verify/<id>.json`. The item's Accept criteria and their commands live in
 * `tools/harness/items/<id>.json`. See `src/verify/item.ts`.
 *
 * Options: --skip-accept (quick run of the other gates; P4 is then not green)
 * Exit code: 0 when every gate and criterion is green, 1 otherwise, 2 on a setup error.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { verifyItem } from "./src/verify/item.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

try {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { "skip-accept": { type: "boolean", default: false } },
  });
  const id = positionals[0];
  if (id === undefined || !/^M\d+-\d+[a-z]?$/.test(id))
    throw new Error("usage: pnpm verify:item <item id, e.g. M0-05>");
  const report = await verifyItem({ root, id, skipAccept: values["skip-accept"] });
  for (const [name, g] of Object.entries(report.gates))
    console.log(
      `${g.ok === true ? "ok  " : "FAIL"} ${name}${g.note !== undefined && g.ok !== true ? `  ${String(g.note).split("\n")[0]}` : ""}`,
    );
  for (const a of report.accept) console.log(`${a.ok ? "ok  " : "FAIL"} accept: ${a.criterion}`);
  process.exitCode = report.ok ? 0 : 1;
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 2;
}
