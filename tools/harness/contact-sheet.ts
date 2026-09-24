/**
 * Contact sheets (DOD §3, research 05 §B.7): the critic gets one grid image per mode instead of
 * dozens of files. For a round this writes, into `<round>/sheets/`:
 *
 * - `stage-<mode>.png` for day, dusk, night and rain: rows are states, columns the three
 *   viewports;
 * - `stream.png`: the stream-sim JPEGs, rows are states, columns dusk and night;
 * - `controller.png`: rows are states, columns mode × role;
 * - `snow.png`: the snow spot check.
 *
 * Usage: `tsx tools/harness/contact-sheet.ts <game> [--round <r>]`
 *
 * @module
 */
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import sharp, { type OverlayOptions } from "sharp";
import {
  CONTROLLER_MODES,
  roundDir,
  screenshotMatrix,
  STAGE_MODES,
  STAGE_VIEWPORTS,
  STREAM_MODES,
} from "./src/matrix.ts";
import type { ScenarioManifest } from "./src/scenarios/manifest.ts";
import { streamFile } from "./stream-sim.ts";

/** One grid cell: an image (or null for an empty cell) and its caption. */
export interface SheetCell {
  file: string | null;
  label: string;
}

/** Layout of a sheet. */
export interface SheetOptions {
  title: string;
  /** Column headers. */
  columns: string[];
  /** Row headers (one per row of cells). */
  rows: string[];
  /** Cell box size in px; images are fitted inside ("contain"). */
  cell: { width: number; height: number };
  /** Per-column cell widths (e.g. narrow columns for portrait viewports); default `cell.width`. */
  columnWidths?: readonly number[];
}

const SHEET = Object.freeze({
  bg: "#2E2A33",
  cellBg: "#3A3540",
  ink: "#F5EDE3",
  muted: "#B7ADC4",
  pad: 16,
  header: 56,
  rowHeader: 150,
  caption: 26,
});

const escapeXml = (s: string): string =>
  s.replace(
    /[<>&'"]/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c] ?? c,
  );

function textSvg(
  width: number,
  height: number,
  text: string,
  size: number,
  color: string,
  anchor: "start" | "middle" = "start",
): Buffer {
  const x = anchor === "middle" ? width / 2 : 4;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<text x="${x}" y="${Math.round(height * 0.72)}" font-family="Segoe UI, Helvetica, Arial, sans-serif" ` +
      `font-size="${size}" font-weight="600" fill="${color}" text-anchor="${anchor}">${escapeXml(text)}</text></svg>`,
  );
}

/**
 * Renders a grid of images with row/column headers and per-cell captions. `cells` is row-major
 * with `rows.length × columns.length` entries.
 */
export async function contactSheet(cells: readonly SheetCell[], o: SheetOptions): Promise<Buffer> {
  const cols = o.columns.length;
  const rows = o.rows.length;
  if (cells.length !== cols * rows)
    throw new Error(`contact sheet: ${cells.length} cells for ${rows}×${cols} grid`);
  const { pad, header, rowHeader, caption } = SHEET;
  const widths = o.columns.map((_, i) => o.columnWidths?.[i] ?? o.cell.width);
  const lefts = widths.map(
    (_, i) => pad + rowHeader + widths.slice(0, i).reduce((a, w) => a + w + pad, 0),
  );
  const ch = o.cell.height + caption;
  const width = pad + rowHeader + widths.reduce((a, w) => a + w + pad, 0);
  const height = header + pad + 30 + rows * (ch + pad);
  const layers: OverlayOptions[] = [
    { input: textSvg(width - 2 * pad, header, o.title, 26, SHEET.ink), left: pad, top: 0 },
  ];
  o.columns.forEach((c, i) =>
    layers.push({
      input: textSvg(Math.max(widths[i] ?? 0, 40), 30, c, 18, SHEET.muted, "middle"),
      left: lefts[i] ?? 0,
      top: header,
    }),
  );
  for (let r = 0; r < rows; r++) {
    const top = header + 30 + pad + r * (ch + pad);
    layers.push({
      input: textSvg(rowHeader - 8, 30, o.rows[r] ?? "", 18, SHEET.ink),
      left: pad,
      top: top + Math.round(o.cell.height / 2) - 15,
    });
    for (let c = 0; c < cols; c++) {
      const cell = cells[r * cols + c] as SheetCell;
      const cw = widths[c] ?? o.cell.width;
      const left = lefts[c] ?? 0;
      if (cell.file !== null) {
        const img = await sharp(cell.file)
          .resize(cw, o.cell.height, { fit: "contain", background: SHEET.cellBg })
          .png()
          .toBuffer();
        layers.push({ input: img, left, top });
      }
      layers.push({
        input: textSvg(cw, caption, cell.label, 12, SHEET.muted),
        left,
        top: top + o.cell.height,
      });
    }
  }
  return sharp({ create: { width, height, channels: 3, background: SHEET.bg } })
    .composite(layers)
    .png({ compressionLevel: 9 })
    .toBuffer();
}

const maybe = (path: string): string | null => (existsSync(path) ? path : null);

/** Writes every contact sheet of a round; returns the written files (repo-relative). */
export async function contactSheetsForRound(
  root: string,
  manifest: ScenarioManifest,
  round: number | string,
): Promise<string[]> {
  const dir = roundDir(manifest.game, round);
  const abs = (f: string): string => join(root, dir, f);
  const shots = screenshotMatrix(manifest);
  const stageStates = [...new Set(shots.filter((s) => s.set === "stage").map((s) => s.state))];
  const phone = shots.filter((s) => s.set === "controller");
  const phoneStates = [...new Set(phone.map((s) => s.state))];
  const out: string[] = [];
  const write = async (name: string, buf: Buffer): Promise<void> => {
    const rel = `${dir}/sheets/${name}`;
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    await sharp(buf).toFile(join(root, rel));
    out.push(rel);
  };

  if (stageStates.length > 0) {
    for (const mode of STAGE_MODES) {
      const cells = stageStates.flatMap((state) =>
        STAGE_VIEWPORTS.map((vp) => ({
          file: maybe(abs(`${state}__${mode}__${vp.label}.png`)),
          label: `${state}__${mode}__${vp.label}`,
        })),
      );
      await write(
        `stage-${mode}.png`,
        await contactSheet(cells, {
          title: `${manifest.game} · Stage · ${mode}`,
          columns: STAGE_VIEWPORTS.map((v) => v.label),
          rows: stageStates,
          cell: { width: 640, height: 360 },
          columnWidths: STAGE_VIEWPORTS.map((v) => Math.round((360 * v.width) / v.height)),
        }),
      );
    }
    const streamCells = stageStates.flatMap((state) =>
      STREAM_MODES.map((mode) => ({
        file: maybe(abs(`stream/${streamFile(state, mode)}`)),
        label: `${state}__${mode} (720p q60)`,
      })),
    );
    await write(
      "stream.png",
      await contactSheet(streamCells, {
        title: `${manifest.game} · Stream-sim (1280×720 JPEG q60)`,
        columns: [...STREAM_MODES],
        rows: stageStates,
        cell: { width: 640, height: 360 },
      }),
    );
  }
  if (phoneStates.length > 0) {
    const combos = CONTROLLER_MODES.flatMap((mode) =>
      (["player", "audience"] as const).map((role) => ({ mode, role })),
    );
    const cells = phoneStates.flatMap((state) =>
      combos.map(({ mode, role }) => {
        const hit = phone.find((s) => s.state === state && s.mode === mode && s.role === role);
        return {
          file: hit === undefined ? null : maybe(abs(hit.file)),
          label: hit === undefined ? "—" : `${state}__${mode}__${role}`,
        };
      }),
    );
    await write(
      "controller.png",
      await contactSheet(cells, {
        title: `${manifest.game} · Controller (360×800)`,
        columns: combos.map((c) => `${c.mode} · ${c.role}`),
        rows: phoneStates,
        cell: { width: 180, height: 400 },
      }),
    );
  }
  const snow = shots.find((s) => s.set === "snow");
  if (snow !== undefined) {
    await write(
      "snow.png",
      await contactSheet([{ file: maybe(abs(snow.file)), label: snow.file }], {
        title: `${manifest.game} · Snow spot check`,
        columns: [snow.viewport.label],
        rows: [snow.state],
        cell: { width: 960, height: 540 },
      }),
    );
  }
  return out;
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { round: { type: "string", default: "1" } },
  });
  const game = positionals[0];
  if (game === undefined) throw new Error("usage: contact-sheet.ts <game> [--round <r>]");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const { readManifest } = await import("./src/scenarios/manifest.ts");
  const files = await contactSheetsForRound(root, readManifest(root, game), values.round ?? "1");
  console.log(`contact-sheet: wrote ${files.join(", ")}`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
