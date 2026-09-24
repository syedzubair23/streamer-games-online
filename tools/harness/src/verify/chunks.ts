/**
 * Game chunk sizes for G8a ("stage chunk ≤ 60 KB gz (Marble Rally ≤ 70); controller chunk
 * ≤ 25 KB gz"). A game's chunk is its own code: the entry bundled and minified with the platform
 * packages the shell already loads kept external (three, preact, `@sg/*`), then gzipped.
 *
 * @module
 */
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";

/** Packages the shell provides; never counted in a game chunk. */
export const SHELL_EXTERNALS: readonly string[] = [
  "three",
  "three/*",
  "preact",
  "preact/*",
  "@preact/*",
  "@sg/shared",
  "@sg/shared/*",
  "@sg/engine",
  "@sg/engine/*",
  "@sg/render",
  "@sg/render/*",
  "@sg/ui",
  "@sg/ui/*",
  "@sg/audio",
  "@sg/audio/*",
];

/** Bundles one entry like the client build would and returns its gzip size in KB. */
export async function chunkGzipKB(root: string, entry: string): Promise<number> {
  const res = await build({
    entryPoints: [join(root, entry)],
    bundle: true,
    minify: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    write: false,
    external: [...SHELL_EXTERNALS],
    jsx: "automatic",
    jsxImportSource: "preact",
    logLevel: "silent",
  });
  const bytes = res.outputFiles.reduce((n, f) => n + gzipSync(f.contents, { level: 9 }).length, 0);
  return Math.round((bytes / 1024) * 10) / 10;
}
