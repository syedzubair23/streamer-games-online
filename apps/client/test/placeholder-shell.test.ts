// @vitest-environment happy-dom
import {
  Group,
  InstancedMesh,
  Mesh,
  BoxGeometry,
  DataTexture,
  RedFormat,
  Texture,
  Vector3,
} from "three";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  CAMERA_PRESETS,
  createPlaceholderShell,
  DPR_CAP,
  PORTRAIT_ELEVATION,
  type ShellOptions,
} from "../src/dev/placeholder-shell.ts";
import {
  createPlaceholderTextures,
  MAX_TEXTURE_SIZE,
  textureBytes,
  TOON_RAMP,
} from "../src/dev/placeholder-textures.ts";
import { fakeRenderer, installCanvasStub, manualScheduler } from "./helpers.ts";

beforeAll(() => installCanvasStub());

function host(w = 1280, h = 720): HTMLElement {
  const el = document.createElement("div");
  Object.defineProperty(el, "clientWidth", { value: w });
  Object.defineProperty(el, "clientHeight", { value: h });
  document.body.appendChild(el);
  return el;
}

function make(over: Partial<ShellOptions> = {}) {
  const sched = manualScheduler();
  const renderer = fakeRenderer();
  const shell = createPlaceholderShell({
    host: host(),
    mode: "dusk",
    quality: "mid",
    reducedMotion: false,
    seed: 3,
    hud: true,
    ambient: false,
    preserveDrawingBuffer: true,
    renderer,
    schedule: sched.schedule,
    unschedule: sched.unschedule,
    ...over,
  });
  return { shell, sched, renderer };
}

const palette = {
  wood: "#B87445",
  felt: "#4F9488",
  paper: "#FBF5EA",
  wall: "#F0D2B6",
  shadow: "#7A3F5C",
  ink: "#3D2A33",
};

describe("placeholder procedural textures", () => {
  it("caches per name/options, clamps sizes per tier and builds the SPEC §13.5 toon ramp", () => {
    const t = createPlaceholderTextures("low", palette);
    const a = t.api.wood({ size: 2048, seed: 2 });
    expect(t.api.wood({ size: 2048, seed: 2 })).toBe(a);
    expect((a.image as HTMLCanvasElement).width).toBe(MAX_TEXTURE_SIZE.low);
    expect(t.api.wood({ seed: 3 })).not.toBe(a);
    const ramp = t.api.ramp() as DataTexture;
    expect([...(ramp.image.data as Uint8Array)]).toEqual([...TOON_RAMP]);
    for (const name of [
      "noise",
      "felt",
      "paper",
      "cork",
      "board",
      "cards",
      "dice",
      "blob",
      "matcap",
      "grain",
    ] as const)
      expect(
        t.api[name]({
          variant: name === "board" ? "3" : name === "matcap" ? "cool" : undefined,
          tint: "#ffffff",
        }),
      ).toBeDefined();
    expect(t.all().length).toBeGreaterThanOrEqual(12);
    t.dispose();
    expect(t.all()).toEqual([]);
  });

  it("estimates GPU bytes (RGBA8 + mipmaps; single-channel ramp)", () => {
    const tex = new Texture({ width: 256, height: 256 } as unknown as HTMLImageElement);
    expect(textureBytes(tex)).toBe(Math.round(256 * 256 * 4 * (4 / 3)));
    const ramp = new DataTexture(new Uint8Array(3), 3, 1, RedFormat);
    ramp.generateMipmaps = false;
    expect(textureBytes(ramp)).toBe(3);
    expect(textureBytes(new Texture())).toBe(0);
  });

  it("throws when no 2D canvas is available", () => {
    const doc = { createElement: () => ({ getContext: () => null }) } as unknown as Document;
    expect(() => createPlaceholderTextures("mid", palette, doc).api.paper()).toThrow(/2D canvas/);
  });
});

describe("placeholder shell: StageContext", () => {
  it("builds the full SPEC §9.4 context over a sky, table and mat inside the environment budget", () => {
    const { shell, renderer } = make();
    const ctx = shell.ctx;
    for (const k of [
      "scene",
      "camera",
      "hud",
      "theme",
      "quality",
      "loop",
      "tween",
      "springs",
      "fx",
      "mats",
      "materials",
      "textures",
      "sfx",
      "pick",
      "reducedMotion",
    ])
      expect(ctx).toHaveProperty(k);
    expect(ctx.scene).toBe(shell.gameRoot);
    expect(ctx.hud.id).toBe("sg-hud");
    shell.renderNow();
    const info = shell.info();
    expect(info.drawCalls).toBeLessThanOrEqual(12); // SPEC §10 environment share on low
    expect(info.tris).toBeLessThanOrEqual(15_000);
    expect(info.texMB).toBeGreaterThan(0);
    expect(shell.renders).toBe(1);
    expect(renderer.frames).toBe(1);
    expect(shell.memory().geometries).toBeGreaterThan(0);
  });

  it("materials come from the factories with token colours; each factory honours its options", () => {
    const { shell } = make();
    const m = shell.ctx.materials;
    const toon = m.makeToon({ color: "#F26B5B", rim: true, transparent: true, opacity: 0.5 });
    expect(toon.type).toBe("MeshToonMaterial");
    expect(toon.gradientMap).not.toBeNull();
    expect(toon.opacity).toBe(0.5);
    expect(m.makeMatcap({ variant: "cool" }).matcap).not.toBeNull();
    expect(m.makeLambertVC({ vertexColors: true, map: null }).vertexColors).toBe(true);
    const add = m.makeBasic({ additive: true, depthWrite: false });
    expect(add.transparent).toBe(true);
    expect(add.depthWrite).toBe(false);
    expect(m.makeBasic().blending).not.toBe(add.blending);
  });

  it("the camera rig frames states per SPEC §13.4, glides on the camera spring and snaps when asked", () => {
    const { shell } = make();
    const cam = shell.ctx.camera;
    expect(cam.state).toBe("play");
    cam.setState("top");
    expect(cam.state).toBe("top");
    expect(shell.motion.active).toBe(1); // gliding
    shell.settle();
    shell.renderNow();
    expect(shell.camera.fov).toBeCloseTo(CAMERA_PRESETS.top.fov, 5);
    cam.focusOn(new Vector3(1, 0, -1), { immediate: true });
    shell.renderNow();
    expect(cam.state).toBe("focus");
    expect(shell.camera.fov).toBe(CAMERA_PRESETS.focus.fov);
    cam.setState("establishing", { immediate: true });
    shell.renderNow();
    expect(shell.camera.fov).toBe(CAMERA_PRESETS.establishing.fov);
  });

  it("portrait viewports use the steeper elevation", () => {
    const sched = manualScheduler();
    const shell = createPlaceholderShell({
      host: host(360, 800),
      mode: "night",
      quality: "low",
      reducedMotion: false,
      seed: 1,
      hud: false,
      ambient: false,
      preserveDrawingBuffer: false,
      renderer: fakeRenderer(),
      schedule: sched.schedule,
      unschedule: sched.unschedule,
    });
    shell.renderNow();
    const p = shell.camera.position;
    const elevation = (Math.atan2(p.y, Math.hypot(p.x, p.z)) * 180) / Math.PI;
    expect(elevation).toBeCloseTo(PORTRAIT_ELEVATION, 3);
    expect(shell.ctx.hud.style.display).toBe("none");
    expect(DPR_CAP.low).toBe(1.25);
  });
});

describe("placeholder shell: the one on-demand loop", () => {
  it("renders on demand: one frame per invalidate, nothing when idle", () => {
    const { shell, sched } = make();
    shell.ctx.loop.invalidate();
    shell.ctx.loop.invalidate();
    expect(sched.pending).toBe(1);
    sched.flush(16);
    expect(shell.renders).toBe(1);
    expect(sched.pending).toBe(0);
  });

  it("an invalidate during a frame never schedules a second frame (no runaway loop)", () => {
    const { shell, sched } = make();
    const stop = shell.ctx.loop.beginAnim();
    shell.onFrame = () => shell.ctx.loop.invalidate();
    for (let i = 0; i < 20; i++) {
      expect(sched.pending).toBe(1);
      sched.flush(16 * (i + 1));
    }
    expect(shell.renders).toBe(20);
    stop();
    stop();
    shell.onFrame = null;
    sched.flush(1000);
    expect(sched.pending).toBe(0);
  });

  it("starts paused when asked, then renders the pending frame on start; freeze stops for good", () => {
    const { shell, sched } = make({ paused: true });
    shell.ctx.loop.invalidate();
    expect(sched.pending).toBe(0);
    shell.start();
    shell.start();
    expect(sched.pending).toBe(1);
    shell.freeze();
    expect(sched.pending).toBe(0);
    expect(shell.frozen).toBe(true);
    shell.ctx.loop.invalidate();
    expect(sched.pending).toBe(0);
  });

  it("tweens and particles keep the loop awake until they settle", () => {
    const { shell, sched } = make();
    shell.ctx.tween.to({ x: 0 }, { x: 1 }, { durationMs: 50 });
    let frames = 0;
    for (let t = 16; sched.pending > 0 && frames < 100; t += 16, frames++) sched.flush(t);
    expect(frames).toBeGreaterThan(2);
    expect(shell.motion.active).toBe(0);
  });

  it("ambient life drifts the camera continuously", () => {
    const { shell, sched } = make({ ambient: true });
    shell.ctx.loop.invalidate();
    sched.flush(0);
    const a = shell.camera.position.x;
    sched.flush(3000);
    expect(sched.pending).toBe(1);
    expect(shell.camera.position.x).not.toBe(a);
  });
});

describe("placeholder shell: fx, mats, sfx, picking, memory", () => {
  it("confetti and puffs spawn pooled particles that die out; reduced motion suppresses them", () => {
    const { shell } = make({ quality: "high" });
    shell.ctx.fx.confetti(["#F26B5B", "#5BA8F2"], { count: 40, origin: { x: 0, y: 1, z: 0 } });
    shell.ctx.fx.puff({ x: 0, y: 0, z: 0 }, "#F5C04A");
    shell.ctx.fx.reactions("heart", 50);
    const particles = shell.scene.getObjectByName("sg-fx-particles") as InstancedMesh;
    shell.advance(16);
    expect(particles.visible).toBe(true);
    expect(particles.count).toBeGreaterThan(0);
    shell.settle();
    expect(particles.visible).toBe(false);
    shell.ctx.fx.confetti([]);
    expect(shell.fxLog.map((f) => `${f.name}:${f.suppressed}`)).toEqual([
      "confetti:false",
      "puff:false",
      "reactions:false",
      "confetti:true",
    ]);

    const calm = make({ reducedMotion: true, quality: "high" }).shell;
    calm.ctx.fx.confetti(["#F26B5B"]);
    calm.ctx.fx.puff({ x: 0, y: 0, z: 0 }, "#F26B5B");
    calm.ctx.fx.reactions("wow");
    calm.ctx.fx.shake(1);
    expect(calm.fxLog.every((f) => f.suppressed)).toBe(true);
  });

  it("shake runs only on high tier; halo adds and removes an additive sprite", () => {
    const low = make({ quality: "low" }).shell;
    low.ctx.fx.shake();
    expect(low.fxLog[0]).toEqual({ name: "shake", suppressed: true });
    const high = make({ quality: "high" }).shell;
    high.ctx.fx.shake(3);
    expect(high.motion.active).toBe(1);
    high.advance(16);
    high.renderNow();
    const target = new Group();
    high.gameRoot.add(target);
    const remove = high.ctx.fx.halo(target, { color: "#FFC26B", scale: 2 });
    expect(target.getObjectByName("sg-halo")).toBeDefined();
    high.advance(16);
    remove();
    remove();
    expect(target.getObjectByName("sg-halo")).toBeUndefined();
  });

  it("setMat repaints the mat with the painter; sfx are recorded", () => {
    const { shell } = make();
    const painter = vi.fn();
    for (const kind of ["felt", "paper", "cork", "pegboard", "inlay"] as const)
      shell.ctx.mats.setMat(kind, painter);
    expect(painter).toHaveBeenCalledTimes(5);
    expect(painter).toHaveBeenCalledWith(expect.anything(), { w: 1024, h: 1024 });
    shell.ctx.sfx("pop");
    expect(shell.sfxLog).toEqual(["pop"]);
  });

  it("picks the table plane, instances and objects under the pointer", () => {
    const { shell } = make();
    shell.renderNow();
    const canvas = shell.renderer.domElement;
    canvas.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      width: 1280,
      height: 720,
      right: 1280,
      bottom: 720,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const hit = shell.ctx.pick.plane({ clientX: 640, clientY: 360 });
    expect(hit).not.toBeNull();
    expect(Math.abs(hit!.y)).toBeLessThan(1e-6);
    const box = new Mesh(new BoxGeometry(1, 1, 1), shell.ctx.materials.makeBasic());
    const child = new Mesh(new BoxGeometry(0.2, 0.2, 0.2), shell.ctx.materials.makeBasic());
    box.add(child);
    box.position.copy(hit!);
    shell.gameRoot.add(box);
    box.updateMatrixWorld(true);
    expect(shell.ctx.pick.object([box], { clientX: 640, clientY: 360 })).toBe(box);
    expect(shell.ctx.pick.object([box], { clientX: 0, clientY: 0 })).toBeNull();
    const inst = new InstancedMesh(new BoxGeometry(1, 1, 1), shell.ctx.materials.makeBasic(), 1);
    inst.position.copy(hit!);
    inst.updateMatrixWorld(true);
    expect(shell.ctx.pick.instance(inst, { clientX: 640, clientY: 360 })).toBe(0);
    expect(shell.ctx.pick.instance(inst, { clientX: 1, clientY: 1 })).toBeNull();
    canvas.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      width: 0,
      height: 0,
      right: 0,
      bottom: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    shell.ctx.pick.plane({ clientX: 0, clientY: 0 }, 0.5, new Vector3());
  });

  it("prepareBaseline uploads shell-owned resources; dispose frees everything and detaches", () => {
    const { shell } = make();
    const hostEl = shell.renderer.domElement.parentElement!;
    const base = shell.prepareBaseline();
    expect(base.geometries).toBeGreaterThan(0);
    // every cached procedural texture plus the mat canvas (this fake does not count the sky)
    expect(base.textures).toBe(shell.sharedTextureCount() + 1);
    shell.onResize = vi.fn();
    shell.resize();
    expect(shell.onResize).toHaveBeenCalledWith(1280, 720);
    shell.dispose();
    shell.dispose();
    shell.renderNow();
    expect(hostEl.querySelector("canvas")).toBeNull();
    expect(hostEl.querySelector("#sg-hud")).toBeNull();
    expect(shell.memory()).toEqual({ geometries: 0, textures: 0 });
  });
});
