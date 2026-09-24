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
import {
  HOP_WINDOW_MS,
  SFX_ROLES,
  galleryVars,
  mountAudioGallery,
  parseGalleryMode,
} from "../src/dev/audio-gallery.tsx";
import { tokensFor } from "../src/dev/placeholder-theme.ts";

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
    expect(root.querySelector("[data-testid=unlock]")).toBeNull();
    expect(ctx.of(FakeAnalyser)).toHaveLength(1);

    const oscs = ctx.of(FakeOscillator).length;
    q("sfx-chime").click();
    await tick();
    expect(ctx.of(FakeOscillator).length).toBe(oscs + 3);
    expect(q("last").textContent).toContain("chime");

    q("mode-rain").click();
    await tick();
    expect(audio.mode).toBe("rain");
    expect(root.querySelector(".ag")?.getAttribute("data-mode")).toBe("rain");

    q("music").click();
    await tick();
    expect(q("music").getAttribute("aria-pressed")).toBe("true");
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

    const range = root.querySelector('input[aria-label="SFX level"]') as HTMLInputElement;
    range.value = "25";
    range.dispatchEvent(new Event("input"));
    await tick();
    expect(audio.settings.sfx).toBe(0.25);

    q("ambience").click();
    await tick();
    expect(q("ambience").textContent).toBe("Bed off");
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
