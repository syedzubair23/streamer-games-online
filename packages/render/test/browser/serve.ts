/**
 * Serves the browser harness to a Playwright page from a routed origin
 * (`http://render.test/`): the bundle is built once with esbuild and fulfilled through
 * `page.route`, so the specs need no port, no dev server and no network, and the page has a real
 * origin (IndexedDB works).
 */
import { buildSync } from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import type { Harness } from "./harness.ts";

const here = dirname(fileURLToPath(import.meta.url));
/** The routed origin of the harness page. */
export const ORIGIN = "http://render.test";

let bundle: string | null = null;
function build(): string {
  if (bundle !== null) return bundle;
  const out = buildSync({
    entryPoints: [resolve(here, "harness.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2023",
    write: false,
    sourcemap: false,
    logLevel: "silent",
  });
  const file = out.outputFiles[0];
  if (file === undefined) throw new Error("esbuild produced no output");
  bundle = file.text;
  return bundle;
}

/**
 * The page mirrors the moment textures are generated in the app: the Iris loading screen, a
 * soft vignette with one line of tip text (research 03 §4.5), so text rendering is initialised
 * as it is in the shell.
 */
const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>render kit</title>
<style>html,body{margin:0;background:#FFF3E4;color:#3D2A33;font:600 16px system-ui,sans-serif}
canvas{display:block}#tip{position:fixed;left:24px;bottom:24px}</style></head>
<body><p id="tip">Tip: tap the table to roll.</p><script type="module" src="/harness.js"></script></body></html>`;

/** Opens the harness page and waits until `window.__sg` exists. */
export async function openHarness(page: Page): Promise<void> {
  const js = build();
  await page.route(`${ORIGIN}/**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/harness.js")
      return route.fulfill({ status: 200, contentType: "text/javascript", body: js });
    if (url.pathname === "/" || url.pathname === "/index.html")
      return route.fulfill({ status: 200, contentType: "text/html", body: HTML });
    return route.fulfill({ status: 404, body: "" });
  });
  await page.goto(`${ORIGIN}/`);
  await page.waitForFunction(() => (window as unknown as { __sg?: unknown }).__sg !== undefined);
}

declare global {
  interface Window {
    __sg: Harness;
  }
}
