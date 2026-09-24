/**
 * The reference board (ROADMAP M0-06): `docs/references/manifest.json` lists every reference
 * image, where it came from and what the critic should take from it. The images themselves are
 * third-party store screenshots, so they are **never committed or shipped** (.gitignore): any
 * checkout rebuilds them with `pnpm refs:fetch`, and `docs/references/SOURCES.md` is generated
 * from the same manifest so the two can never disagree.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import sharp from "sharp";

/** The six style sources ROADMAP M0-06 names for `_style/`; each needs at least one image. */
export const STYLE_SOURCES = [
  { label: "A Short Hike", match: /^A Short Hike$/ },
  { label: "Unpacking", match: /^Unpacking$/ },
  { label: "Alba", match: /^Alba\b/ },
  { label: "Tiny Glade", match: /^Tiny Glade$/ },
  { label: "Townscaper", match: /^Townscaper$/ },
  { label: "Jackbox", match: /Jackbox/ },
] as const;

/** Count bounds from ROADMAP M0-06. */
export const STYLE_COUNT = { min: 12, max: 20 } as const;
export const GAME_COUNT = { min: 3, max: 6 } as const;

/** The reference set an image belongs to: `_style` or a game id. */
export type ReferenceSet = string;

export interface ReferenceEntry {
  /** `_style` or a game id (a `docs/specs/<id>.md` exists for it). */
  set: ReferenceSet;
  /** File name inside `docs/references/<set>/`, e.g. `tiny-glade-02.png`. */
  file: string;
  /** Title of the source game as its store page names it. */
  game: string;
  steamAppId: number;
  /** The official store page the screenshot is published on. */
  storePage: string;
  /** Direct URL of the full-size official store screenshot. */
  url: string;
  /** What the critic should take from this image. */
  note: string;
  /**
   * sha256 (hex) of the source bytes served at `url`. Required for `_style` entries, which the
   * calibration scores: `pnpm refs:fetch` refuses a download that does not match, so a changed
   * URL or a re-encoded store image cannot silently replace a calibrated reference.
   */
  sha256?: string;
}

export interface ReferenceManifest {
  /** Target size; images are scaled to fit inside it (never enlarged). */
  size: { width: number; height: number };
  /**
   * The written, score-independent rules the `_style` frames were picked by (ROADMAP M0-06;
   * docs/critic/CALIBRATION.md). Rendered into SOURCES.md.
   */
  styleSelection?: string[];
  entries: ReferenceEntry[];
}

export const MANIFEST_PATH = "docs/references/manifest.json";
export const SOURCES_PATH = "docs/references/SOURCES.md";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Reads and shape-checks the manifest; throws with a clear message when it is malformed. */
export function loadManifest(root: string): ReferenceManifest {
  const raw: unknown = JSON.parse(readFileSync(join(root, MANIFEST_PATH), "utf8"));
  if (!isRecord(raw) || !Array.isArray(raw["entries"]) || !isRecord(raw["size"])) {
    throw new Error(`${MANIFEST_PATH}: expected { size, entries[] }`);
  }
  const size = raw["size"];
  if (typeof size["width"] !== "number" || typeof size["height"] !== "number") {
    throw new Error(`${MANIFEST_PATH}: size needs numeric width and height`);
  }
  const entries = raw["entries"].map((e: unknown, i): ReferenceEntry => {
    const fields = ["set", "file", "game", "storePage", "url", "note"] as const;
    if (
      !isRecord(e) ||
      fields.some((f) => typeof e[f] !== "string") ||
      typeof e["steamAppId"] !== "number"
    ) {
      throw new Error(
        `${MANIFEST_PATH}: entry #${i + 1} is missing a field (${fields.join(", ")}, steamAppId)`,
      );
    }
    if (e["sha256"] !== undefined && typeof e["sha256"] !== "string") {
      throw new Error(`${MANIFEST_PATH}: entry #${i + 1} sha256 must be a string`);
    }
    const out: ReferenceEntry = {
      set: e["set"] as string,
      file: e["file"] as string,
      game: e["game"] as string,
      steamAppId: e["steamAppId"],
      storePage: e["storePage"] as string,
      url: e["url"] as string,
      note: e["note"] as string,
    };
    if (typeof e["sha256"] === "string") out.sha256 = e["sha256"];
    return out;
  });
  const manifest: ReferenceManifest = {
    size: { width: size["width"], height: size["height"] },
    entries,
  };
  const rules = raw["styleSelection"];
  if (rules !== undefined) {
    if (!Array.isArray(rules) || rules.some((r) => typeof r !== "string")) {
      throw new Error(`${MANIFEST_PATH}: styleSelection must be an array of strings`);
    }
    manifest.styleSelection = rules as string[];
  }
  return manifest;
}

/** Game ids are the spec files in `docs/specs/`. */
export function gameIds(root: string): string[] {
  return readdirSync(join(root, "docs/specs"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3))
    .sort();
}

/**
 * Every rule ROADMAP M0-06 puts on the board. Returns human-readable problems (empty = valid).
 */
export function validateManifest(manifest: ReferenceManifest, games: string[]): string[] {
  const problems: string[] = [];
  const bySet = new Map<string, ReferenceEntry[]>();
  const seen = new Set<string>();
  for (const e of manifest.entries) {
    const key = `${e.set}/${e.file}`;
    if (seen.has(key)) problems.push(`duplicate entry ${key}`);
    seen.add(key);
    if (e.set !== "_style" && !games.includes(e.set))
      problems.push(`${key}: unknown set "${e.set}"`);
    if (!/^[a-z0-9]+(-[a-z0-9]+)*-\d{2}\.png$/.test(e.file))
      problems.push(`${key}: file must be <slug>-NN.png`);
    if (!/^https:\/\/[^\s]+$/.test(e.url)) problems.push(`${key}: url must be https`);
    if (!/^https:\/\/store\.steampowered\.com\/app\/\d+\/$/.test(e.storePage)) {
      problems.push(`${key}: storePage must be an official store page URL`);
    } else if (!e.storePage.includes(`/app/${e.steamAppId}/`)) {
      problems.push(`${key}: storePage does not match steamAppId ${e.steamAppId}`);
    }
    if (e.note.trim() === "") problems.push(`${key}: note is empty`);
    if (e.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(e.sha256)) {
      problems.push(`${key}: sha256 must be 64 lowercase hex characters`);
    } else if (e.sha256 === undefined && e.set === "_style") {
      problems.push(`${key}: _style entries need the sha256 of their source image`);
    }
    bySet.set(e.set, [...(bySet.get(e.set) ?? []), e]);
  }
  const style = bySet.get("_style") ?? [];
  if (style.length < STYLE_COUNT.min || style.length > STYLE_COUNT.max) {
    problems.push(`_style has ${style.length} images; needs ${STYLE_COUNT.min}–${STYLE_COUNT.max}`);
  }
  for (const source of STYLE_SOURCES) {
    if (!style.some((e) => source.match.test(e.game)))
      problems.push(`_style has no ${source.label} image`);
  }
  for (const id of games) {
    const n = bySet.get(id)?.length ?? 0;
    if (n < GAME_COUNT.min || n > GAME_COUNT.max) {
      problems.push(`${id} has ${n} images; needs ${GAME_COUNT.min}–${GAME_COUNT.max}`);
    }
  }
  return problems;
}

/** Local path of a reference image. */
export const referencePath = (root: string, e: ReferenceEntry): string =>
  join(root, "docs/references", e.set, e.file);

/** Entries whose image is not on disk yet. */
export function missingReferences(root: string, manifest: ReferenceManifest): ReferenceEntry[] {
  return manifest.entries.filter((e) => !existsSync(referencePath(root, e)));
}

/** `docs/references/SOURCES.md`, generated deterministically from the manifest. */
export function renderSources(manifest: ReferenceManifest): string {
  const sets = [...new Set(manifest.entries.map((e) => e.set))].sort((a, b) =>
    a === "_style" ? -1 : b === "_style" ? 1 : a.localeCompare(b),
  );
  const lines = [
    "# Reference image sources",
    "",
    `<!-- Generated from ${MANIFEST_PATH} by \`pnpm refs:fetch --sources\`. Do not edit by hand. -->`,
    "",
    "Every image is an **official store screenshot** published by the game's developer on its Steam store",
    "page. They are used **only** for critic comparison (DOD §4, §7; ROADMAP M0-06): never shipped, never",
    "committed (see `.gitignore`), never used as texture or asset input. Rebuild the local copies with",
    `\`pnpm refs:fetch\`; images are scaled to fit ${manifest.size.width}×${manifest.size.height} and stored as PNG.`,
    "A download whose sha256 differs from the one the manifest pins is refused.",
    "",
  ];
  if (manifest.styleSelection?.length) {
    lines.push(
      "## How the `_style/` frames were chosen",
      "",
      "These rules were fixed before calibration scoring and do not depend on any score (docs/critic/CALIBRATION.md):",
      "",
      ...manifest.styleSelection.map((r, i) => `${i + 1}. ${r}`),
      "",
    );
  }
  for (const set of sets) {
    lines.push(`## ${set === "_style" ? "`_style/` — house-style board" : `\`${set}/\``}`, "");
    lines.push(
      "| File | Source game | Store page | Image URL | What to take from it |",
      "|---|---|---|---|---|",
    );
    for (const e of manifest.entries.filter((x) => x.set === set)) {
      lines.push(`| \`${e.set}/${e.file}\` | ${e.game} | ${e.storePage} | ${e.url} | ${e.note} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export interface FetchOptions {
  /** Re-download images that already exist. */
  force?: boolean;
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: (
    url: string,
  ) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;
  /** Attempts per image (network hiccups are common on store CDNs). */
  attempts?: number;
  retryDelayMs?: number;
  log?: (line: string) => void;
}

/** Downloads every missing reference image and stores it as a PNG that fits `manifest.size`. */
export async function fetchReferences(
  root: string,
  manifest: ReferenceManifest,
  opts: FetchOptions = {},
): Promise<{ fetched: string[]; skipped: string[] }> {
  const doFetch = opts.fetchImpl ?? ((url: string) => fetch(url));
  const attempts = opts.attempts ?? 5;
  const log = opts.log ?? (() => {});
  const fetched: string[] = [];
  const skipped: string[] = [];
  for (const e of manifest.entries) {
    const out = referencePath(root, e);
    const label = `${e.set}/${e.file}`;
    if (!opts.force && existsSync(out)) {
      skipped.push(label);
      continue;
    }
    let lastError = "";
    let bytes: Buffer | null = null;
    for (let a = 1; a <= attempts && bytes === null; a++) {
      try {
        const res = await doFetch(e.url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        bytes = Buffer.from(await res.arrayBuffer());
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (a < attempts) await new Promise((r) => setTimeout(r, opts.retryDelayMs ?? 2000));
      }
    }
    if (bytes === null) throw new Error(`could not fetch ${label} from ${e.url}: ${lastError}`);
    if (e.sha256 !== undefined) {
      const got = createHash("sha256").update(bytes).digest("hex");
      if (got !== e.sha256) {
        throw new Error(
          `${label}: the image at ${e.url} has sha256 ${got}, but the manifest pins ${e.sha256}; ` +
            "change the pin only together with a new calibration run",
        );
      }
    }
    mkdirSync(dirname(out), { recursive: true });
    const png = await sharp(bytes)
      .resize(manifest.size.width, manifest.size.height, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .png({ compressionLevel: 9 })
      .toBuffer();
    writeFileSync(out, png);
    fetched.push(label);
    log(`fetched ${label}`);
  }
  return { fetched, skipped };
}
