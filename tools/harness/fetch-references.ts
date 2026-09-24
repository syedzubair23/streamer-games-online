/**
 * `pnpm refs:fetch [--force] [--sources]`: rebuilds the local reference board from
 * docs/references/manifest.json (ROADMAP M0-06).
 *  - default: validate the manifest, download every missing image, regenerate SOURCES.md
 *  - `--force`: re-download images that already exist
 *  - `--sources`: only regenerate SOURCES.md (no network)
 */
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SOURCES_PATH,
  fetchReferences,
  gameIds,
  loadManifest,
  renderSources,
  validateManifest,
} from "./src/critic/references.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = new Set(process.argv.slice(2));
const manifest = loadManifest(root);
const problems = validateManifest(manifest, gameIds(root));
if (problems.length) {
  console.error(`manifest is invalid:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
writeFileSync(join(root, SOURCES_PATH), renderSources(manifest));
console.log(`wrote ${SOURCES_PATH}`);
if (!args.has("--sources")) {
  const { fetched, skipped } = await fetchReferences(root, manifest, {
    force: args.has("--force"),
    log: (l) => console.log(l),
  });
  console.log(`references: ${fetched.length} fetched, ${skipped.length} already present`);
}
