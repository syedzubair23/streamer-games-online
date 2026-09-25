import { describe, expect, it } from "vitest";
import { createAudio, createAudioContextHost } from "../src/index.ts";
import { FakeAudioContext, FakeDocument, flush } from "./fake-audio.ts";

function setup() {
  const doc = new FakeDocument();
  const made: FakeAudioContext[] = [];
  const host = createAudioContextHost({
    doc,
    create: () => {
      const c = new FakeAudioContext();
      made.push(c);
      return c.asAudio;
    },
  });
  return { doc, made, host };
}

describe("the shared AudioContext suspends when the tab is hidden (ROADMAP M1-08 Accept 3)", () => {
  it("creates nothing before the first gesture", () => {
    const { host, made } = setup();
    expect(host.ctx).toBeNull();
    expect(host.running).toBe(false);
    expect(made).toHaveLength(0);
  });

  it("suspends on hidden and resumes on visible", async () => {
    const { doc, made, host } = setup();
    await host.unlock();
    const ctx = made[0] as FakeAudioContext;
    expect(ctx.state).toBe("running");
    expect(host.running).toBe(true);

    doc.setVisibility("hidden");
    await flush();
    expect(ctx.state).toBe("suspended");
    expect(host.running).toBe(false);

    doc.setVisibility("visible");
    await flush();
    expect(ctx.state).toBe("running");
    expect(ctx.calls).toEqual(["resume", "suspend", "resume"]);
  });

  it("an unlock while hidden stays suspended until the tab is visible", async () => {
    const { doc, made, host } = setup();
    doc.visibilityState = "hidden";
    await host.unlock();
    const ctx = made[0] as FakeAudioContext;
    expect(ctx.state).toBe("suspended");
    expect(host.running).toBe(false);
    doc.setVisibility("visible");
    await flush();
    expect(ctx.state).toBe("running");
  });

  it("hidden/visible before any unlock does nothing", async () => {
    const { doc, made } = setup();
    doc.setVisibility("hidden");
    doc.setVisibility("visible");
    await flush();
    expect(made).toHaveLength(0);
  });

  it("unlocks on the first gesture and keeps one context; the remover stops listening", async () => {
    const { doc, made, host } = setup();
    const remove = host.unlockOnGesture();
    expect(doc.count("pointerdown")).toBe(1);
    doc.fire("keydown");
    await flush();
    doc.fire("pointerdown");
    await flush();
    expect(made).toHaveLength(1);
    expect(made[0]?.state).toBe("running");
    remove();
    expect(doc.count("pointerdown") + doc.count("keydown") + doc.count("touchend")).toBe(0);
  });

  it("dispose closes the context and removes every listener", async () => {
    const { doc, made, host } = setup();
    host.unlockOnGesture();
    await host.unlock();
    await host.dispose();
    expect(made[0]?.state).toBe("closed");
    expect(host.ctx).toBeNull();
    expect(doc.count("visibilitychange") + doc.count("pointerdown")).toBe(0);
    await host.unlock();
    expect(made).toHaveLength(1);
  });

  it("the audio system goes silent while hidden: sfx are dropped, then play again", async () => {
    const doc = new FakeDocument();
    const ctx = new FakeAudioContext();
    const audio = createAudio({ doc, create: () => ctx.asAudio });
    await audio.unlock();
    const before = ctx.nodes.length;
    doc.setVisibility("hidden");
    await flush();
    expect(ctx.state).toBe("suspended");
    audio.sfx("pop");
    expect(ctx.nodes.length).toBe(before);
    doc.setVisibility("visible");
    await flush();
    audio.sfx("pop");
    expect(ctx.nodes.length).toBeGreaterThan(before);
    await audio.dispose();
  });
});
