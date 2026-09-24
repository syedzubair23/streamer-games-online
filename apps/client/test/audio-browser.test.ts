/**
 * `@sg/audio` in a real Chromium (ROADMAP M1-08): the `/dev/audio` gallery served by the Vite dev
 * server, a real `AudioContext` that suspends while the tab is hidden, and music ducking measured
 * on rendered audio (`OfflineAudioContext`), not on parameter values. The dev server listens on
 * a free port chosen at run time (`SG_AUDIO_TEST_PORT` pins one).
 */
import { createServer as createNetServer } from "node:net";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import type * as AudioLib from "@sg/audio";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CLIENT = resolve(import.meta.dirname, "..");
let server: ViteDevServer;
let browser: Browser;
let base = "";

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createNetServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      s.close(() => (typeof a === "object" && a ? ok(a.port) : fail(new Error("no port"))));
    });
  });
}

beforeAll(async () => {
  const port = Number(process.env["SG_AUDIO_TEST_PORT"] ?? (await freePort()));
  server = await createServer({
    root: CLIENT,
    configFile: resolve(CLIENT, "vite.config.ts"),
    logLevel: "error",
    server: { port, strictPort: true, host: "127.0.0.1", hmr: false },
  });
  await server.listen();
  base = `http://127.0.0.1:${port}`;
  browser = await chromium.launch();
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

async function openGallery(mode = "rain"): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${base}/dev/audio.html?mode=${mode}`);
  await page.waitForFunction(() => "__SG_AUDIO__" in window);
  return { page, errors };
}

const ctxState = (page: Page): Promise<string | null> =>
  page.evaluate(
    () =>
      (window as unknown as { __SG_AUDIO__: { audio: { host: { ctx: AudioContext | null } } } })
        .__SG_AUDIO__.audio.host.ctx?.state ?? null,
  );

async function setHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((h) => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => (h ? "hidden" : "visible"),
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}

describe("@sg/audio in Chromium", () => {
  it("the gallery unlocks on a gesture and plays every sound with no console errors", async () => {
    const { page, errors } = await openGallery();
    expect(await ctxState(page)).toBeNull();
    await page.getByTestId("unlock").click();
    await page.waitForFunction(
      () =>
        (window as unknown as { __SG_AUDIO__: { audio: { host: { running: boolean } } } })
          .__SG_AUDIO__.audio.host.running,
    );
    await expect.poll(() => page.getByTestId("ctx-state").textContent()).toContain("running");
    for (const name of [
      "pop",
      "tick",
      "tok",
      "card",
      "chime",
      "success",
      "fail",
      "capture",
      "win",
      "vote",
    ])
      await page.getByTestId(`sfx-${name}`).click();
    await page.getByTestId("music").click();
    await page.getByTestId("mode-night").click();
    expect(await page.getByTestId("stream-safe").textContent()).toBe("Stream-safe audio ✓");
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);

  it("the real AudioContext suspends when the tab is hidden and resumes when visible (Accept 3)", async () => {
    const { page } = await openGallery("night");
    await page.getByTestId("unlock").click();
    await expect.poll(() => ctxState(page)).toBe("running");
    await setHidden(page, true);
    await expect.poll(() => ctxState(page)).toBe("suspended");
    await expect.poll(() => page.getByTestId("ctx-state").textContent()).toContain("suspended");
    await setHidden(page, false);
    await expect.poll(() => ctxState(page)).toBe("running");
    await page.close();
  }, 60_000);

  it("music ducking: rendered music drops 4 dB for a reveal, 12 dB in streamer mode, and swells back (Accept 5)", async () => {
    const { page } = await openGallery();
    const levels = await page.evaluate(async () => {
      type Lib = typeof AudioLib;
      const { lib } = (window as unknown as { __SG_AUDIO__: { lib: Lib } }).__SG_AUDIO__;
      const rate = 48_000;
      const render = async (streamerSafe: boolean): Promise<number[]> => {
        const ctx = new OfflineAudioContext(1, rate * 4, rate);
        const buses = lib.createBuses(ctx, { music: 1, sfx: 1, ambience: 1, streamerSafe: false });
        const osc = ctx.createOscillator();
        osc.frequency.value = lib.noteFreq("A4");
        osc.connect(buses.music);
        osc.start(0);
        let release: () => void = () => undefined;
        void ctx.suspend(1).then(() => {
          if (streamerSafe) buses.apply({ music: 1, sfx: 1, ambience: 1, streamerSafe: true });
          else release = buses.duck();
          void ctx.resume();
        });
        void ctx.suspend(2.5).then(() => {
          if (streamerSafe) buses.apply({ music: 1, sfx: 1, ambience: 1, streamerSafe: false });
          else release();
          void ctx.resume();
        });
        const data = (await ctx.startRendering()).getChannelData(0);
        const rms = (a: number, b: number): number => {
          let s = 0;
          for (let i = Math.round(a * rate); i < Math.round(b * rate); i++)
            s += (data[i] ?? 0) ** 2;
          return Math.sqrt(s / ((b - a) * rate));
        };
        return [rms(0.3, 0.9), rms(1.6, 2.4), rms(3.7, 4)];
      };
      return { reveal: await render(false), streamer: await render(true) };
    });
    const db = (a: number, b: number): number => 20 * Math.log10(a / b);
    const [before, ducked, after] = levels.reveal as [number, number, number];
    expect(before).toBeGreaterThan(0.1);
    expect(db(ducked, before)).toBeCloseTo(-4, 0);
    expect(Math.abs(db(ducked, before) + 4)).toBeLessThan(0.3);
    expect(Math.abs(db(after, before))).toBeLessThan(0.3);
    const [sBefore, sDucked, sAfter] = levels.streamer as [number, number, number];
    expect(Math.abs(db(sDucked, sBefore) + 12)).toBeLessThan(0.3);
    expect(Math.abs(db(sAfter, sBefore))).toBeLessThan(0.3);
    await page.close();
  }, 60_000);

  it("rendered sfx are audible, never clip, and the bus keeps them under 7 kHz", async () => {
    const { page } = await openGallery();
    const res = await page.evaluate(async () => {
      type Lib = typeof AudioLib;
      const { lib } = (window as unknown as { __SG_AUDIO__: { lib: Lib } }).__SG_AUDIO__;
      const rate = 48_000;
      const out: Record<string, { peak: number; hiRatio: number }> = {};
      for (const name of lib.SFX_LIST) {
        const ctx = new OfflineAudioContext(1, rate * 2, rate);
        const buses = lib.createBuses(ctx, { music: 1, sfx: 1, ambience: 1, streamerSafe: false });
        lib.createSfxPlayer(ctx, buses.sfx).play(name);
        const d = (await ctx.startRendering()).getChannelData(0);
        let peak = 0;
        let all = 0;
        let hi = 0;
        // Energy of a crude 1st-difference highpass vs the signal: small when the lowpass works.
        for (let i = 1; i < d.length; i++) {
          const v = d[i] ?? 0;
          peak = Math.max(peak, Math.abs(v));
          all += v * v;
          hi += (v - (d[i - 1] ?? 0)) ** 2;
        }
        out[name] = { peak, hiRatio: all > 0 ? hi / all : 0 };
      }
      return out;
    });
    for (const [name, r] of Object.entries(res)) {
      expect(r.peak, name).toBeGreaterThan(0.01);
      expect(r.peak, name).toBeLessThan(1);
      // A signal band-limited below 7 kHz at 48 kHz has diff/energy ratio well under (2π·7/48)² ≈ 0.84.
      expect(r.hiRatio, name).toBeLessThan(0.84);
    }
    await page.close();
  }, 60_000);
});
