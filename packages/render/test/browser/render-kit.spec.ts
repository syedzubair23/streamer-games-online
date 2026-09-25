/**
 * `@sg/render` in a real browser (Chromium, WebGL2 on SwiftShader):
 *
 * - ROADMAP M1-06 Accept: **the loop renders 0 frames/s when idle with ambient off**;
 * - ROADMAP M1-06 Accept: **`dispose.ts` returns `renderer.info.memory` to its baseline after a
 *   mount/unmount cycle**;
 * - the material factories compile on WebGL2 without errors, patched kinds share one program,
 *   and a uniform-only mode change adds no programs;
 * - procedural textures paint real, deterministic, non-blank pixels, and the IndexedDB store
 *   serves them pixel-identically after a reload;
 * - the boot benchmark measures a finite median on real WebGL.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import type { Material, Texture } from "three";
import { openHarness } from "./serve.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || /THREE\.WebGLProgram|shader/i.test(m.text())) errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

test.describe("render loop in a real browser", () => {
  test("renders 0 frames/s when idle with ambient off (M1-06 Accept)", async ({ page }) => {
    const errors = collectErrors(page);
    await openHarness(page);
    const r = await page.evaluate(async () => {
      const { stage, mountGame, ticks } = window.__sg;
      const s = stage("low", { ambient: false });
      mountGame(s, "low");
      s.loop.invalidate();
      await ticks(10);
      const afterFirst = s.loop.frames;
      const glFrames0 = s.renderer.gl.info.render.frame;
      const t0 = performance.now();
      await ticks(120); // ~2 s of display frames with nothing changing
      const seconds = (performance.now() - t0) / 1000;
      const idleFrames = s.loop.frames - afterFirst;
      const idleGlFrames = s.renderer.gl.info.render.frame - glFrames0;
      // An animation renders every frame, then the loop goes back to idle on its own.
      const piece = s.gameRoot.children[0]?.children[0];
      const a0 = s.loop.frames;
      if (piece !== undefined)
        void s.tweens.to(piece.position, { y: 0.3 }, { durationMs: 320, easing: "back" });
      await ticks(40);
      const animFrames = s.loop.frames - a0;
      await ticks(5);
      const settled = s.loop.frames;
      await ticks(60);
      const idleAfterAnim = s.loop.frames - settled;
      s.dispose();
      return { afterFirst, idleFrames, idleGlFrames, seconds, animFrames, idleAfterAnim };
    });
    expect(r.afterFirst).toBe(1);
    expect(r.seconds).toBeGreaterThan(1);
    expect(r.idleFrames).toBe(0);
    expect(r.idleGlFrames).toBe(0);
    expect(r.idleFrames / r.seconds).toBe(0);
    expect(r.animFrames).toBeGreaterThanOrEqual(15);
    expect(r.idleAfterAnim).toBe(0);
    expect(errors).toEqual([]);
  });

  test("ambient life renders at the tier's ambient rate, not the display rate", async ({
    page,
  }) => {
    await openHarness(page);
    const r = await page.evaluate(async () => {
      const { stage, ticks } = window.__sg;
      const s = stage("low", { ambient: true });
      await ticks(10);
      const f0 = s.loop.frames;
      const t0 = performance.now();
      let displayFrames = 0;
      await new Promise<void>((resolve) => {
        const step = (): void => {
          displayFrames++;
          if (displayFrames >= 90) resolve();
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
      const seconds = (performance.now() - t0) / 1000;
      const frames = s.loop.frames - f0;
      s.loop.setAmbient(false);
      await ticks(3);
      const off = s.loop.frames;
      await ticks(30);
      const afterOff = s.loop.frames - off;
      s.dispose();
      return { frames, seconds, displayFrames, afterOff };
    });
    const displayHz = r.displayFrames / r.seconds;
    const fps = r.frames / r.seconds;
    // Capped at 30 fps: at most half the display rate (plus jitter), and clearly running.
    expect(fps).toBeLessThanOrEqual(Math.min(31, displayHz / 2 + 2));
    expect(fps).toBeGreaterThan(Math.min(20, displayHz / 3));
    expect(r.afterOff).toBe(0);
  });
});

test.describe("disposal", () => {
  test("dispose returns renderer.info.memory to its baseline after mount/unmount (M1-06 Accept)", async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await openHarness(page);
    const r = await page.evaluate(async () => {
      const { R, stage, mountGame, ticks } = window.__sg;
      const cycles: {
        mounted: { geometries: number; textures: number; programs: number };
        report: ReturnType<ReturnType<typeof R.createLeakCheck>["check"]>;
        freed: { geometries: number; materials: number; textures: number };
      }[] = [];
      const s = stage("low");
      // Shell warm-up: render the environment and upload every boot texture.
      s.loop.renderNow();
      for (const t of s.kit.all()) s.renderer.gl.initTexture?.(t);
      const leak = R.createLeakCheck(s.renderer.gl, { sharedTextures: () => s.kit.all().length });
      const baseline = leak.baseline();
      const bootCount = s.kit.all().length;
      for (let c = 0; c < 3; c++) {
        const root = mountGame(s, "low");
        s.loop.invalidate();
        await ticks(4);
        s.loop.renderNow();
        const mounted = R.memorySnapshot(s.renderer.gl);
        const freed = R.disposeObject3D(root, { shared: s.kit.shared });
        s.loop.renderNow();
        cycles.push({ mounted, report: leak.check(), freed });
      }
      const sharedAfter = s.kit.all().length;
      // A game may also ask the kit for a texture outside the boot set: the kit paints it once
      // and keeps it (shell-owned, shared, never disposed by the game), so the next mount reuses
      // it instead of painting and uploading it again.
      const nonBoot: { now: ReturnType<typeof R.memorySnapshot>; kitAdded: number }[] = [];
      for (let c = 0; c < 2; c++) {
        const before = s.kit.all().length;
        const root = mountGame(s, "low", { boardVariant: "grid-3" });
        s.loop.renderNow();
        R.disposeObject3D(root, { shared: s.kit.shared });
        s.loop.renderNow();
        nonBoot.push({
          now: R.memorySnapshot(s.renderer.gl),
          kitAdded: s.kit.all().length - before,
        });
      }
      s.dispose();
      return { baseline, cycles, sharedAfter, bootCount, nonBoot };
    });
    for (const c of r.cycles) {
      expect(c.mounted.geometries).toBeGreaterThan(r.baseline.geometries);
      expect(c.mounted.textures).toBeGreaterThan(r.baseline.textures);
      expect(c.mounted.programs).toBeGreaterThan(r.baseline.programs);
      expect(c.freed.geometries).toBeGreaterThanOrEqual(6);
      expect(c.report.ok, JSON.stringify(c.report)).toBe(true);
      expect(c.report.leakedGeometries).toBe(0);
      expect(c.report.leakedTextures).toBe(0);
      expect(c.report.leakedPrograms).toBe(0);
      // Strictly back to the baseline: geometries, textures and programs.
      expect(c.report.now).toEqual(r.baseline);
    }
    // Game-owned resources were created and freed; the kit's boot texture set is unchanged.
    expect(r.sharedAfter).toBe(r.bootCount);
    // The on-demand kit texture is painted once, kept by the kit, and reused on the next mount.
    expect(r.nonBoot[0]?.kitAdded).toBe(1);
    expect(r.nonBoot[1]?.kitAdded).toBe(0);
    expect(r.nonBoot[0]?.now.geometries).toBe(r.baseline.geometries);
    expect(r.nonBoot[0]?.now.programs).toBe(r.baseline.programs);
    expect(r.nonBoot[0]?.now.textures).toBe(r.baseline.textures + 1);
    expect(r.nonBoot[1]?.now).toEqual(r.nonBoot[0]?.now);
    expect(errors).toEqual([]);
  });
});

test.describe("materials on WebGL2", () => {
  test("every factory compiles; patched kinds share programs; mode changes add none", async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await openHarness(page);
    const r = await page.evaluate(async () => {
      const { R, T, stage } = window.__sg;
      const out: Record<string, number> = {};
      for (const tier of R.QUALITY_TIERS) {
        const s = stage(tier);
        const geo = new T.BoxGeometry(0.3, 0.3, 0.3);
        const add = (m: Material, x: number) => {
          const mesh = new T.Mesh(geo, m);
          mesh.position.set(x, 0.3, 0);
          s.gameRoot.add(mesh);
        };
        add(s.materials.makeToon({ color: "#F26B5B" }), -1.5);
        add(s.materials.makeMatcap(), -0.5);
        add(s.materials.makeMatcap({ variant: "cool" }), 0);
        add(s.materials.makeBasic({ additive: true, map: s.kit.api.blob() }), 0.5);
        add(s.materials.makeBlobShadow(), 1);
        s.loop.renderNow();
        const before = s.renderer.gl.info.programs?.length ?? 0;
        // A second rim toon and a second blended matcap in other colours: no new programs.
        add(s.materials.makeToon({ color: "#5BA8F2" }), 1.5);
        add(s.materials.makeMatcap({ color: "#F5C04A" }), 2);
        s.loop.renderNow();
        const sameKind = s.renderer.gl.info.programs?.length ?? 0;
        // An ambient mode change is uniforms only.
        s.materials.setRimColor("#5A5F9E");
        s.materials.setMatcapBlend(1);
        s.sky.material.uniforms.uStars.value = 1;
        s.sky.material.uniforms.uTop.value.set("#1C2140");
        s.loop.renderNow();
        const afterMode = s.renderer.gl.info.programs?.length ?? 0;
        out[`${tier}:before`] = before;
        out[`${tier}:sameKind`] = sameKind;
        out[`${tier}:afterMode`] = afterMode;
        s.dispose();
        geo.dispose();
      }
      return out;
    });
    for (const tier of ["low", "mid", "high"]) {
      expect(r[`${tier}:before`]).toBeGreaterThan(0);
      expect(r[`${tier}:sameKind`]).toBe(r[`${tier}:before`]);
      expect(r[`${tier}:afterMode`]).toBe(r[`${tier}:before`]);
    }
    expect(errors).toEqual([]);
  });

  test("the boot benchmark measures a finite median on real WebGL", async ({ page }) => {
    await openHarness(page);
    const r = await page.evaluate(() => {
      const { R, stage } = window.__sg;
      const s = stage("mid");
      const toon = s.materials.makeToon();
      const mat = s.materials.makeLambertVC({ vertexColors: false, map: s.kit.api.felt() });
      const res = R.runBootBench({
        renderer: s.renderer.gl,
        pieceMaterial: toon,
        matMaterial: mat,
      });
      toon.dispose();
      mat.dispose();
      s.dispose();
      return res;
    });
    expect(r.samples).toHaveLength(20);
    expect(Number.isFinite(r.medianMs)).toBe(true);
    expect(r.medianMs).toBeGreaterThan(0);
  });
});

test.describe("procedural textures in a real canvas", () => {
  test("paint deterministic, non-blank pixels for every texture and tier", async ({ page }) => {
    const errors = collectErrors(page);
    await openHarness(page);
    const r = await page.evaluate(async () => {
      await document.fonts.ready;
      const { R, pixelHash, pixelSd } = window.__sg;
      const result: Record<string, { a: string; b: string; sd: number }> = {};
      const sheets: Record<string, string> = {};
      for (const tier of R.QUALITY_TIERS) {
        const a = R.createTextureKit({ tier });
        const b = R.createTextureKit({ tier });
        a.generateBoot();
        b.generateBoot();
        const sheet = document.createElement("canvas");
        sheet.width = 1600;
        sheet.height = 900;
        const g = sheet.getContext("2d");
        if (g === null) throw new Error("no 2d");
        g.fillStyle = "#FFF3E4";
        g.fillRect(0, 0, 1600, 900);
        let x = 10;
        let y = 10;
        for (const [i, t] of a.all().entries()) {
          const ca = a.canvasOf(t);
          const cb = b.canvasOf(b.all()[i] as Texture);
          if (ca === undefined || cb === undefined) continue;
          result[`${tier}:${t.name}`] = { a: pixelHash(ca), b: pixelHash(cb), sd: pixelSd(ca) };
          const scale = Math.min(1, 380 / ca.width, 280 / ca.height);
          const w = ca.width * scale;
          const h = ca.height * scale;
          if (x + w > 1590) {
            x = 10;
            y += 290;
          }
          g.drawImage(ca, x, y, w, h);
          x += w + 10;
        }
        sheets[tier] = sheet.toDataURL("image/png");
        a.dispose();
        b.dispose();
      }
      return { result, sheets };
    });
    const out = resolve(ROOT, "artifacts/tmp/render-kit");
    mkdirSync(out, { recursive: true });
    for (const [tier, url] of Object.entries(r.sheets))
      writeFileSync(
        resolve(out, `textures-${tier}.png`),
        Buffer.from(url.split(",")[1] ?? "", "base64"),
      );
    const entries = Object.entries(r.result);
    expect(entries.length).toBeGreaterThanOrEqual(3 * 13);
    for (const [name, v] of entries) {
      expect(v.a, name).toBe(v.b);
      // Felt (±4% luminance) and paper (±3% blotches, ±2% grain) are low-contrast by design
      // (research 03 §6); everything else carries strong structure.
      expect(v.sd, name).toBeGreaterThan(/:sg:(felt|paper)\|/.test(name) ? 1.5 : 4);
    }
    expect(errors).toEqual([]);
  });

  test("repeating textures tile seamlessly (edge seam no stronger than neighbouring pixels)", async ({
    page,
  }) => {
    await openHarness(page);
    const r = await page.evaluate(() => {
      const { R } = window.__sg;
      const out: Record<string, { edgeX: number; innerX: number; edgeY: number; innerY: number }> =
        {};
      for (const tier of R.QUALITY_TIERS) {
        const kit = R.createTextureKit({ tier });
        for (const name of ["wood", "felt", "paper", "cork", "noise", "grain"] as const) {
          const t = kit.api[name]();
          const c = kit.canvasOf(t);
          if (c === undefined) continue;
          const ctx = c.getContext("2d") as
            CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
          const { width: w, height: h } = c;
          const d = ctx.getImageData(0, 0, w, h).data;
          const lum = (x: number, y: number) => {
            const i = (y * w + x) * 4;
            return (
              0.2126 * (d[i] as number) +
              0.7152 * (d[i + 1] as number) +
              0.0722 * (d[i + 2] as number)
            );
          };
          const col = (a: number, b: number) => {
            let s = 0;
            for (let y = 0; y < h; y++) s += Math.abs(lum(a, y) - lum(b, y));
            return s / h;
          };
          const row = (a: number, b: number) => {
            let s = 0;
            for (let x = 0; x < w; x++) s += Math.abs(lum(x, a) - lum(x, b));
            return s / w;
          };
          const inner = (f: (a: number, b: number) => number, n: number) => {
            let s = 0;
            const picks = [0.2, 0.35, 0.5, 0.65, 0.8];
            // Pairs straddle a multiple of 8, so granules of 1–8 px (cork's speckle cells) are
            // compared across a cell boundary, like the wrap edge (last → first) always is.
            for (const p of picks) {
              const x = Math.round((n * p) / 8) * 8;
              s += f(x - 1, x);
            }
            return s / picks.length;
          };
          out[`${tier}:${name}`] = {
            edgeX: col(w - 1, 0),
            innerX: inner(col, w),
            edgeY: row(h - 1, 0),
            innerY: inner(row, h),
          };
        }
        kit.dispose();
      }
      return out;
    });
    expect(Object.keys(r).length).toBe(18);
    for (const [name, v] of Object.entries(r)) {
      expect(v.edgeX, `${name} x seam`).toBeLessThanOrEqual(v.innerX * 1.5 + 1);
      expect(v.edgeY, `${name} y seam`).toBeLessThanOrEqual(v.innerY * 1.5 + 1);
    }
  });

  test("the IndexedDB store serves textures pixel-identically after a reload", async ({ page }) => {
    await openHarness(page);
    const first = await page.evaluate(async () => {
      const { R, pixelHash } = window.__sg;
      await new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase("sg-textures");
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
      });
      const store = await R.openIdbTextureStore();
      const kit = R.createTextureKit({ tier: "mid", store });
      const boot = kit.generateBoot();
      await store.flush();
      const hashes: Record<string, string> = {};
      for (const t of kit.all()) {
        const c = kit.canvasOf(t);
        if (c !== undefined) hashes[t.name] = pixelHash(c);
      }
      return { size: store.size, hits: kit.storeHits, total: boot.total, hashes };
    });
    expect(first.size).toBe(0);
    expect(first.hits).toBe(0);
    await page.reload();
    await page.waitForFunction(() => window.__sg !== undefined);
    const second = await page.evaluate(async () => {
      const { R, pixelHash } = window.__sg;
      const store = await R.openIdbTextureStore();
      const kit = R.createTextureKit({ tier: "mid", store });
      const boot = kit.generateBoot();
      const hashes: Record<string, string> = {};
      for (const t of kit.all()) {
        const c = kit.canvasOf(t);
        if (c !== undefined) hashes[t.name] = pixelHash(c);
      }
      // A stale version is discarded.
      const stale = await R.openIdbTextureStore({ version: "other" });
      return {
        size: store.size,
        hits: kit.storeHits,
        total: boot.total,
        hashes,
        staleSize: stale.size,
      };
    });
    const canvasEntries = Object.keys(first.hashes).length;
    expect(second.size).toBeGreaterThanOrEqual(canvasEntries);
    expect(second.hits).toBe(canvasEntries);
    for (const [name, hash] of Object.entries(first.hashes)) {
      // Alpha-only textures (blob) may differ by premultiplication rounding in the PNG trip.
      if (name.startsWith("sg:blob")) continue;
      expect(second.hashes[name], name).toBe(hash);
    }
    expect(second.staleSize).toBe(0);
  });
});
