// @vitest-environment happy-dom
import { createAudio, SFX_LIST, STREAMER_MUSIC_LEVEL } from "@sg/audio";
import { SFX_NAMES, type ControllerContext, type StageContext } from "@sg/engine/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  FakeAnalyser,
  FakeAudioContext,
  FakeBufferSource,
  FakeOscillator,
} from "../../../packages/audio/test/fake-audio.ts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BURST_SOUNDS,
  HOP_WINDOW_MS,
  MUTED_TEXT_CONTRAST,
  SFX_ROLES,
  galleryVars,
  onAccentInk,
  mountAudioGallery,
  mutedTextBackgrounds,
  mutedTextInk,
  parseGalleryMode,
} from "../src/dev/audio-gallery.tsx";
import { contrastRatio, tokensFor } from "../src/dev/placeholder-theme.ts";
import { AMBIENT_MODES } from "@sg/shared";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
  document.body.replaceChildren();
});

async function mount(search = "?mode=night") {
  const root = document.createElement("main");
  document.body.appendChild(root);
  const ctx = new FakeAudioContext();
  const audio = createAudio({ create: () => ctx.asAudio, mode: "dusk" });
  const m = mountAudioGallery(root, { audio, search });
  unmount = m.unmount;
  await tick();
  const q = (id: string): HTMLElement => {
    const el = root.querySelector(`[data-testid="${id}"]`);
    if (!(el instanceof HTMLElement)) throw new Error(`missing ${id}`);
    return el;
  };
  return { root, ctx, audio, q };
}

describe("@sg/audio implements the engine's sfx contract", () => {
  it("has the same sound names and a structurally compatible sfx function", () => {
    expect([...SFX_LIST]).toEqual([...SFX_NAMES]);
    const audio = createAudio({ create: () => new FakeAudioContext().asAudio });
    const stageSfx: StageContext["sfx"] = audio.sfx;
    const controllerSfx: ControllerContext<unknown>["sfx"] = audio.sfx;
    expect(() => {
      stageSfx("tok", { pitchStep: 2 });
      controllerSfx("vote");
    }).not.toThrow();
    void audio.dispose();
  });
});

describe("/dev/audio gallery (ROADMAP M1-08)", () => {
  it("parses ?mode= and themes itself from the mode tokens (no colour literals)", () => {
    expect(parseGalleryMode("?mode=rain")).toBe("rain");
    expect(parseGalleryMode("?mode=nope")).toBe("dusk");
    expect(parseGalleryMode("")).toBe("dusk");
    const v = galleryVars("night");
    expect(v["--bg"]).toBe(tokensFor("night").mode.uiBg);
    expect(v["--audience"]).toBe(tokensFor("night").semantic.audience);
  });

  it("labels on the accent fill (the Enable sound CTA) meet 4.5:1 in every mode", () => {
    for (const mode of AMBIENT_MODES) {
      const ink = onAccentInk(mode);
      expect(galleryVars(mode)["--on-accent"]).toBe(ink);
      expect(contrastRatio(ink, tokensFor(mode).mode.accent)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("muted text ink reaches 5:1 on every surface in every mode; the muted token stays for strokes", () => {
    expect(MUTED_TEXT_CONTRAST).toBe(5);
    for (const mode of AMBIENT_MODES) {
      const ink = mutedTextInk(mode);
      expect(galleryVars(mode)["--muted-text"]).toBe(ink);
      expect(galleryVars(mode)["--muted"]).toBe(tokensFor(mode).mode.uiMuted);
      for (const bg of mutedTextBackgrounds(mode))
        expect(contrastRatio(ink, bg), `${mode} on ${bg}`).toBeGreaterThanOrEqual(5);
    }
  });

  it("cards are translucent paper in the light modes and the night surface after dark", () => {
    expect(galleryVars("day")["--card"]).toBe(`${tokensFor("day").fixed.paper}db`);
    expect(galleryVars("night")["--card"]).toBe(`${tokensFor("night").mode.uiSurface}e0`);
  });

  it("the page CSS takes every colour from tokens (no pure black or white, no hex literals)", async () => {
    const { root } = await mount();
    const css = root.querySelector("style")?.textContent ?? "";
    expect(css.length).toBeGreaterThan(1000);
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).not.toMatch(/\b(black|white)\b(?!-)/i);
    expect(css).not.toMatch(/rgba?\(/i);
  });

  it("loads only the latin and latin-ext font subsets (SPEC §5)", () => {
    const src = readFileSync(resolve(import.meta.dirname, "../src/dev/audio-gallery.tsx"), "utf8");
    expect(src).not.toMatch(/@fontsource-variable\/[a-z]+\/(wght|index|standard)\.css/);
    const css = readFileSync(resolve(import.meta.dirname, "../src/dev/gallery-fonts.css"), "utf8");
    const files = [...css.matchAll(/url\("([^"]+)"\)/g)].map((m) => m[1]);
    expect(files).toEqual([
      "@fontsource-variable/fredoka/files/fredoka-latin-ext-wght-normal.woff2",
      "@fontsource-variable/fredoka/files/fredoka-latin-wght-normal.woff2",
      "@fontsource-variable/nunito/files/nunito-latin-ext-wght-normal.woff2",
      "@fontsource-variable/nunito/files/nunito-latin-wght-normal.woff2",
    ]);
  });

  it("tints the whole page background from the mode and clears it on unmount", async () => {
    const { q } = await mount("?mode=night");
    const rootStyle = document.documentElement.style;
    expect(rootStyle.getPropertyValue("--bg")).toBe(tokensFor("night").mode.uiBg);
    q("mode-snow").click();
    await tick();
    expect(rootStyle.getPropertyValue("--bg")).toBe(tokensFor("snow").mode.uiBg);
    unmount?.();
    unmount = null;
    await tick();
    expect(rootStyle.getPropertyValue("--bg")).toBe("");
  });

  it("the CTA becomes a status chip after unlock and the duck shows as its own indicator", async () => {
    const { root, audio, q } = await mount();
    expect(root.querySelector("[data-testid=duck-state]")).toBeNull();
    expect(q("sound-on").hasAttribute("data-gone")).toBe(true);
    expect(q("sound-on").textContent).toContain("Sound off");
    q("unlock").click();
    await tick();
    await tick();
    expect(q("sound-on").textContent).toContain("Sound on");
    expect(q("sound-on").hasAttribute("data-gone")).toBe(false);
    // The CTA crossfades out in the same slot: hidden and disabled, not yanked from the layout.
    expect(q("unlock").hasAttribute("data-gone")).toBe(true);
    expect((q("unlock") as HTMLButtonElement).disabled).toBe(true);
    expect(q("mix-note").textContent).toBe("Streamer mode ducks music by 12 dB and sets it to 35%");
    q("streamer").click();
    await tick();
    expect(q("duck-state").textContent).toBe("Music ducked −12 dB");
    q("streamer").click();
    await tick();
    expect(root.querySelector("[data-testid=duck-state]")).toBeNull();
    q("duck").dispatchEvent(new Event("pointerdown"));
    await tick();
    expect(q("duck-state").textContent).toBe("Music ducked −4 dB");
    q("duck").dispatchEvent(new Event("pointerup"));
    await tick();
    expect(root.querySelector("[data-testid=duck-state]")).toBeNull();
    expect(audio.buses?.duckDb).toBe(0);
  });

  it("shows the stream-safe label, every sound and every mode; nothing sounds before unlock", async () => {
    const { root, ctx, audio, q } = await mount();
    expect(q("stream-safe").textContent).toBe("Stream-safe audio ✓");
    expect(q("ctx-state").textContent).toContain("locked");
    for (const name of Object.keys(SFX_ROLES)) expect(q(`sfx-${name}`).textContent).toContain(name);
    expect(root.querySelectorAll("[data-testid^=mode-]")).toHaveLength(5);
    expect(q("mode-night").getAttribute("aria-pressed")).toBe("true");
    expect(audio.mode).toBe("night");
    expect(ctx.nodes).toHaveLength(1);
  });

  it("Enable sound unlocks; sounds, modes, music, mix and duck drive the audio system", async () => {
    const { root, ctx, audio, q } = await mount();
    q("unlock").click();
    await tick();
    await tick();
    expect(ctx.state).toBe("running");
    expect(q("ctx-state").textContent).toContain("running");
    expect(q("unlock").hasAttribute("data-gone")).toBe(true);
    expect(ctx.of(FakeAnalyser)).toHaveLength(1);

    const oscs = ctx.of(FakeOscillator).length;
    q("sfx-chime").click();
    await tick();
    expect(ctx.of(FakeOscillator).length).toBe(oscs + 3);
    expect(q("last").textContent).toContain("chime");
    expect(q("sfx-chime").getAttribute("data-last")).toBe("true");
    expect(root.querySelector("[data-testid=burst]")).toBeNull();
    q("sfx-win").click();
    await tick();
    expect(BURST_SOUNDS).toEqual(["win", "success"]);
    expect(q("burst").children).toHaveLength(6);
    expect(q("sfx-chime").hasAttribute("data-last")).toBe(false);

    q("mode-rain").click();
    await tick();
    expect(audio.mode).toBe("rain");
    expect(root.querySelector(".ag")?.getAttribute("data-mode")).toBe("rain");

    q("music").click();
    await tick();
    expect(q("music").getAttribute("aria-pressed")).toBe("true");
    expect(q("music").textContent).toBe("Pause music");
    expect(ctx.of(FakeBufferSource).filter((s) => s.loop).length).toBeGreaterThanOrEqual(3);

    q("streamer").click();
    await tick();
    expect(audio.settings.streamerSafe).toBe(true);
    expect(audio.settings.music).toBe(STREAMER_MUSIC_LEVEL);
    expect(audio.buses?.duckDb).toBe(12);
    q("streamer").click();
    await tick();
    expect(audio.buses?.duckDb).toBe(0);

    q("duck").dispatchEvent(new Event("pointerdown"));
    await tick();
    expect(audio.buses?.duckDb).toBe(4);
    expect(q("duck").getAttribute("aria-pressed")).toBe("true");
    q("duck").dispatchEvent(new Event("pointerup"));
    await tick();
    expect(audio.buses?.duckDb).toBe(0);

    expect(q("streamer").getAttribute("role")).toBe("switch");
    const range = root.querySelector('input[aria-label="Sounds level"]') as HTMLInputElement;
    range.value = "25";
    range.dispatchEvent(new Event("input"));
    await tick();
    expect(audio.settings.sfx).toBe(0.25);

    expect(q("ambience").getAttribute("aria-checked")).toBe("true");
    q("ambience").click();
    await tick();
    expect(q("ambience").textContent).toBe("Bed off");
    expect(q("ambience").getAttribute("aria-checked")).toBe("false");
    q("music").click();
    await tick();
    expect(q("music").textContent).toBe("Play music");
  });

  it("keys 1–0 play sounds, Space holds a duck, and tok hops rise within the window", async () => {
    const { ctx, audio, q } = await mount();
    await audio.unlock();
    await tick();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "1" }));
    await tick();
    expect(q("last").textContent).toContain("pop");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: " " }));
    await tick();
    expect(audio.buses?.duckDb).toBe(4);
    window.dispatchEvent(new KeyboardEvent("keyup", { key: " " }));
    await tick();
    expect(audio.buses?.duckDb).toBe(0);
    q("sfx-tok").click();
    ctx.advance(0.05);
    q("sfx-tok").click();
    await tick();
    expect(q("last").textContent).toBe("Played: tok +1");
    expect(HOP_WINDOW_MS).toBe(600);
  });

  it("unmount disposes the audio system", async () => {
    const { ctx, audio } = await mount();
    await audio.unlock();
    unmount?.();
    unmount = null;
    await tick();
    expect(ctx.state).toBe("closed");
  });
});
