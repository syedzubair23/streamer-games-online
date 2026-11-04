import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import { seededPick } from "../ab-pairs.ts";
import { criticPrep } from "../critic-prep.ts";
import { collectErrors, openScenario } from "../src/browser.ts";
import {
  encodeJpegFrames,
  findFfmpeg,
  parseDuration,
  playwrightCacheDirs,
  probeDuration,
} from "../src/ffmpeg.ts";
import {
  clipScenarios,
  matrixCounts,
  midgameScenario,
  scenarioPath,
  screenshotMatrix,
  shotFile,
  shotPath,
} from "../src/matrix.ts";
import { gameTarget } from "../src/games.ts";
import {
  buildManifest,
  loadRegistry,
  readManifest,
  type ScenarioManifest,
} from "../src/scenarios/manifest.ts";
import { parseGameSpec } from "../src/scenarios/spec.ts";
import { specEnv, writeJson } from "../src/spec-env.ts";

const ROOT = resolve(import.meta.dirname, "..", "..", "..");
const tmp = (): string => mkdtempSync(join(tmpdir(), "sg-units-"));

// A private root holding a freshly built tictactoe manifest, so these tests never depend on
// (or race another test file over) the untracked artifacts/scenarios/tictactoe.json in the repo.
let MROOT = "";
beforeAll(async () => {
  MROOT = tmp();
  const t = gameTarget(ROOT, "tictactoe");
  const spec = parseGameSpec(readFileSync(join(ROOT, t.spec), "utf8"));
  const m = buildManifest(t, spec, await loadRegistry(ROOT, t));
  mkdirSync(join(MROOT, "artifacts/scenarios"), { recursive: true });
  writeFileSync(join(MROOT, "artifacts/scenarios/tictactoe.json"), JSON.stringify(m));
});

const scenario = (
  id: string,
  roles: ("stage" | "player" | "audience" | "host")[],
  anim: { name: string; durationMs: number } | null = null,
  extra: Partial<ScenarioManifest["scenarios"][number]> = {},
) => ({
  id,
  description: id,
  anim,
  roles,
  critic: "",
  variants: {},
  inSpec: true,
  registered: true,
  ...extra,
});

describe("the DOD §3 matrix", () => {
  it("counts the tictactoe matrix: 4 stage states × 4 modes × 3 viewports, phone roles × 2 modes, snow", () => {
    const m = readManifest(MROOT, "tictactoe");
    const shots = screenshotMatrix(m);
    expect(shots.filter((s) => s.set === "stage")).toHaveLength(48);
    expect(shots.filter((s) => s.set === "controller")).toHaveLength(8);
    expect(shots.filter((s) => s.set === "snow").map((s) => s.file)).toEqual([
      "midgame__snow__1920x1080.png",
    ]);
    expect(matrixCounts(m)).toEqual({ stills: 57, stream: 8, clips: 2 });
    expect(clipScenarios(m).map((s) => s.id)).toEqual(["midgame", "win"]);
    expect(shotFile("a", "dusk", "player")).toBe("a__dusk__player.png");
  });

  it("skips unregistered and off-spec scenarios, and falls back to the first stage scenario for snow", () => {
    const m: ScenarioManifest = {
      game: "g",
      spec: "s",
      perfScript: [],
      problems: [],
      notes: [],
      scenarios: [
        scenario("lobby", ["stage", "host"]),
        scenario("ghost", ["stage"], null, { registered: false }),
        scenario("extra", [], null, { inSpec: false }),
        scenario("vote", ["audience"], { name: "hearts", durationMs: 900 }),
      ],
    };
    expect(midgameScenario(m)?.id).toBe("lobby");
    const shots = screenshotMatrix(m);
    expect(new Set(shots.map((s) => s.state))).toEqual(new Set(["lobby", "vote"]));
    expect(clipScenarios(m)).toEqual([]); // vote has an anim but no stage role
    expect(midgameScenario({ ...m, scenarios: [] })).toBeNull();
    expect(screenshotMatrix({ ...m, scenarios: [] })).toEqual([]);
  });

  it("builds /dev/scenario paths with the harness seed and freeze on", () => {
    expect(scenarioPath({ game: "g", state: "s" })).toBe(
      "/dev/scenario?game=g&state=s&seed=3&freeze=1",
    );
    const p = new URLSearchParams(
      scenarioPath({
        game: "g",
        state: "s",
        mode: "night",
        seed: 9,
        quality: "low",
        vp: "360x800",
        role: "player",
        t: 0.5,
        freeze: false,
        hud: false,
        player: "p2",
        play: "perf",
        perf: ["a", "b"],
        reduced: true,
        ambient: true,
      }).split("?")[1],
    );
    expect(Object.fromEntries(p)).toEqual({
      game: "g",
      state: "s",
      mode: "night",
      seed: "9",
      quality: "low",
      vp: "360x800",
      role: "player",
      t: "0.5",
      freeze: "0",
      hud: "0",
      player: "p2",
      play: "perf",
      perf: "a,b",
      reduced: "1",
      ambient: "1",
    });
    const shot = screenshotMatrix(readManifest(MROOT, "tictactoe"))[0]!;
    expect(shotPath("tictactoe", shot)).toBe(
      "/dev/scenario?game=tictactoe&state=intro&mode=day&seed=3&quality=low&vp=360x800&role=stage&freeze=1",
    );
  });
});

describe("spec environment", () => {
  it("reads SG_GAME / SG_ROUND and the manifest; writes JSON artifacts", () => {
    expect(() => specEnv({})).toThrow(/set SG_GAME/);
    expect(() => specEnv({ SG_GAME: "tictactoe", SG_ROUND: "../x" })).toThrow(/bad SG_ROUND/);
    const env = specEnv({ SG_GAME: "tictactoe" }, MROOT);
    expect(env.round).toBe("1");
    expect(env.manifest.game).toBe("tictactoe");
    expect(() => specEnv({ SG_GAME: "ludo" }, tmp())).toThrow(
      /cannot read artifacts\/scenarios\/ludo.json/,
    );
    const root = tmp();
    writeJson("a/b.json", { x: 1 }, root);
    expect(existsSync(join(root, "a/b.json"))).toBe(true);
  });

  it("collects console errors and page errors", () => {
    const handlers: Record<string, (x: unknown) => void> = {};
    const page = { on: (ev: string, fn: (x: unknown) => void) => (handlers[ev] = fn) };
    const errors = collectErrors(page as unknown as Parameters<typeof collectErrors>[0]);
    handlers["console"]!({ type: () => "log", text: () => "fine" });
    handlers["console"]!({ type: () => "error", text: () => "bad" });
    handlers["pageerror"]!(new Error("boom"));
    expect(errors).toEqual(["bad", "pageerror: boom"]);
  });
});

describe("openScenario fails fast when the route cannot run", () => {
  const fakePage = (trigger: (emit: (ev: string, arg: unknown) => void) => void) => {
    const handlers = new Map<string, (arg: unknown) => void>();
    const emit = (ev: string, arg: unknown) => handlers.get(ev)?.(arg);
    return {
      on: (ev: string, fn: (arg: unknown) => void) => handlers.set(ev, fn),
      off: (ev: string) => handlers.delete(ev),
      goto: async () => trigger(emit),
      waitForFunction: () => new Promise(() => undefined), // the route never reports
      evaluate: async () => undefined,
      handlers,
    };
  };
  const req = (type: string) => ({
    resourceType: () => type,
    url: () => "http://x/app.js",
    failure: () => ({ errorText: "net::ERR" }),
  });

  it("rejects on a script that answers 404, a failed request or a crash, and unhooks itself", async () => {
    const p404 = fakePage((emit) =>
      emit("response", {
        status: () => 404,
        url: () => "http://x/app.js",
        request: () => req("script"),
      }),
    );
    await expect(openScenario(p404 as never, "/dev/scenario?x")).rejects.toThrow(
      /script http:\/\/x\/app.js answered 404/,
    );
    expect(p404.handlers.size).toBe(0);
    const pFail = fakePage((emit) => {
      emit("response", {
        status: () => 404,
        url: () => "http://x/img.png",
        request: () => req("image"),
      }); // ignored
      emit("requestfailed", req("image")); // ignored
      emit("requestfailed", req("document"));
    });
    await expect(openScenario(pFail as never, "/p")).rejects.toThrow(
      /document http:\/\/x\/app.js failed \(net::ERR\)/,
    );
    const pCrash = fakePage((emit) => emit("crash", undefined));
    await expect(openScenario(pCrash as never, "/p")).rejects.toThrow(/crashed/);
  });

  it("reports the route's own error", async () => {
    const page = {
      on: () => undefined,
      off: () => undefined,
      goto: async () => undefined,
      waitForFunction: async () => undefined,
      evaluate: async () => "no scenario",
    };
    await expect(openScenario(page as never, "/p")).rejects.toThrow(
      /scenario \/p failed: no scenario/,
    );
  });
});

describe("ffmpeg for clips", () => {
  it("locates Playwright's ffmpeg and parses durations", () => {
    expect(parseDuration("  Duration: 00:01:05.50, start: 0")).toBeCloseTo(65.5, 5);
    expect(parseDuration("Duration: N/A")).toBeNull();
    expect(
      playwrightCacheDirs({ PLAYWRIGHT_BROWSERS_PATH: "/pw", LOCALAPPDATA: "C:/L" }, "win32"),
    ).toEqual(["/pw", join("C:/L", "ms-playwright")]);
    expect(playwrightCacheDirs({}, "darwin")[0]).toMatch(/Library[\\/]Caches[\\/]ms-playwright$/);
    expect(playwrightCacheDirs({ XDG_CACHE_HOME: "/c" }, "linux")).toEqual([
      join("/c", "ms-playwright"),
    ]);
    const d = tmp();
    const fake = join(d, "ff.exe");
    writeFileSync(fake, "");
    expect(findFfmpeg({ SG_FFMPEG: fake })).toBe(fake);
    const cache = join(d, "cache", "ffmpeg-1");
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, "ffmpeg-linux"), "");
    const env = { PLAYWRIGHT_BROWSERS_PATH: join(d, "cache") };
    expect(findFfmpeg(env, "linux", () => true)).toBe(join(cache, "ffmpeg-linux"));
    // A newer build without VP8 is passed over for an older one that has it.
    const newer = join(d, "cache", "ffmpeg-2");
    mkdirSync(newer);
    writeFileSync(join(newer, "ffmpeg-linux"), "");
    expect(findFfmpeg(env, "linux", (p) => p !== join(newer, "ffmpeg-linux"))).toBe(
      join(cache, "ffmpeg-linux"),
    );
    expect(findFfmpeg(env, "linux", () => false)).toBeNull();
  });

  it("encodes JPEG frames into a VP8 WebM of the right length", async () => {
    const ffmpeg = findFfmpeg();
    expect(
      ffmpeg,
      "Playwright's ffmpeg is part of the harness toolchain (npx playwright install ffmpeg)",
    ).not.toBeNull();
    const frames = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        sharp({
          create: { width: 64, height: 36, channels: 3, background: { r: i * 10, g: 80, b: 120 } },
        })
          .jpeg()
          .toBuffer(),
      ),
    );
    const out = join(tmp(), "clip.webm");
    encodeJpegFrames(ffmpeg!, frames, 25, out);
    expect(probeDuration(ffmpeg!, out)).toBeCloseTo(1, 1);
    expect(() => encodeJpegFrames(ffmpeg!, [], 25, out)).toThrow(/no frames/);
    expect(() =>
      encodeJpegFrames(ffmpeg!, [Buffer.from("not a jpeg")], 25, join(tmp(), "bad.webm")),
    ).toThrow(/ffmpeg encode failed/);
  });
});

describe("critic:prep", () => {
  it("lays out sheets, clips, shots and blind A/B pairs for a round", async () => {
    const root = tmp();
    const round = join(root, "artifacts/screenshots/demo/round-4");
    const img = await sharp({
      create: { width: 64, height: 36, channels: 3, background: "#806040" },
    })
      .png()
      .toBuffer();
    for (const d of ["sheets", "clips", "stream"]) mkdirSync(join(round, d), { recursive: true });
    writeFileSync(join(round, "sheets/stage-dusk.png"), img);
    writeFileSync(join(round, "clips/win__dusk__1280x720.webm"), "webm");
    writeFileSync(join(round, "intro__dusk__1920x1080.png"), img);
    writeFileSync(join(round, "stream/intro__dusk__stream.jpg"), "jpg");
    mkdirSync(join(root, "docs/references/_style/golden"), { recursive: true });
    writeFileSync(join(root, "docs/references/_style/golden/g.png"), img);
    const res = await criticPrep(root, "demo", "4", { pairsPerKind: 2, pick: seededPick(1) });
    expect(res).toMatchObject({
      dir: "artifacts/critic/demo/round-4",
      sheets: 1,
      clips: 1,
      shots: 2,
      pairs: 2,
    });
    expect(res.notes).toEqual(["no external references found: external pairs skipped"]);
    expect(readdirSync(join(root, "artifacts/critic/demo/ab-4"))).toEqual([
      "pair-01.png",
      "pair-02.png",
    ]);
    expect(existsSync(join(root, "artifacts/ab-keys/demo/ab-4.json"))).toBe(true);
    await expect(criticPrep(root, "demo", "9")).rejects.toThrow(
      /run `pnpm verify:game demo --round 9` first/,
    );
    const empty = join(root, "artifacts/screenshots/demo/round-5");
    mkdirSync(empty, { recursive: true });
    writeFileSync(join(empty, "a__dusk__1920x1080.png"), img);
    expect((await criticPrep(root, "demo", "5", { pick: seededPick(2) })).notes[0]).toMatch(
      /no contact sheets/,
    );
  });
});
