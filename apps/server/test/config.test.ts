import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_ROOM_CONFIG, GAME_IDS } from "@sg/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyRoomConfigPatch,
  envOverrides,
  initialRoomConfig,
  loadServerConfig,
  parseRoomConfigPatch,
  parseServerConfig,
  systemClock,
} from "../src/config.ts";

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "sg-config-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("server config", () => {
  it("has the SPEC §9.5 defaults", () => {
    const c = parseServerConfig({});
    expect(c).toMatchObject({
      port: 8787,
      transport: "uws",
      store: "memory",
      maxRooms: 200,
      perIpConnections: 64,
      perIpJoinsPerMin: 40,
      maxPayloadBytes: 16 * 1024,
      idleTimeoutSec: 30,
      playerMsgPerSec: 20,
      audienceMsgPerSec: 5,
      roomCleanupMs: 600_000,
      codeReleaseMs: 1_800_000,
      publicListing: false,
      defaultContentFilter: "standard",
      trustProxy: false,
    });
    expect(c.allowedGames).toEqual([...GAME_IDS]);
    expect(c.adminKey).toBeUndefined();
  });

  it("rejects bad values and unknown keys with every problem listed", () => {
    expect(() => parseServerConfig({ port: -1 })).toThrow(/port/);
    expect(() => parseServerConfig({ perIpJoinsPerMin: 0 })).toThrow(/perIpJoinsPerMin/);
    expect(() => parseServerConfig({ bogus: true })).toThrow(/invalid server config/);
    expect(() => parseServerConfig({ allowedGames: ["pong"] })).toThrow(/allowedGames/);
    expect(() => parseServerConfig({ adminKey: "short" })).toThrow(/adminKey/);
  });

  it("the join rate limit is configurable from server.config.json", () => {
    const dir = tmp();
    writeFileSync(
      join(dir, "server.config.json"),
      JSON.stringify({ perIpJoinsPerMin: 120, perIpConnections: 200, maxRooms: 5 }),
    );
    const c = loadServerConfig({}, dir);
    expect(c.perIpJoinsPerMin).toBe(120);
    expect(c.perIpConnections).toBe(200);
    expect(c.maxRooms).toBe(5);
  });

  it("env overrides the file; SG_CONFIG picks the file", () => {
    const dir = tmp();
    writeFileSync(join(dir, "alt.json"), JSON.stringify({ port: 9000, transport: "ws" }));
    const c = loadServerConfig(
      {
        SG_CONFIG: "alt.json",
        PORT: "5212",
        ADMIN_KEY: "k".repeat(20),
        TRUST_PROXY: "1",
        STATIC_DIR: "dist",
        HOST: "127.0.0.1",
        STORE: "memory",
      },
      dir,
    );
    expect(c).toMatchObject({
      port: 5212,
      transport: "ws",
      adminKey: "k".repeat(20),
      trustProxy: true,
      staticDir: "dist",
      host: "127.0.0.1",
    });
    expect(() => loadServerConfig({ SG_CONFIG: "missing.json" }, dir)).toThrow(/missing file/);
    writeFileSync(join(dir, "broken.json"), "{ nope");
    expect(() => loadServerConfig({ SG_CONFIG: "broken.json" }, dir)).toThrow(/cannot read/);
    expect(loadServerConfig({}, dir).port).toBe(8787);
  });

  it("validates env enums", () => {
    expect(envOverrides({ TRANSPORT: "ws", STORE: "sqlite", TRUST_PROXY: "0" })).toEqual({
      transport: "ws",
      store: "sqlite",
      trustProxy: false,
    });
    expect(() => envOverrides({ TRANSPORT: "tcp" })).toThrow(/TRANSPORT/);
    expect(() => envOverrides({ STORE: "redis" })).toThrow(/STORE/);
    expect(envOverrides({})).toEqual({});
  });
});

describe("room config patches", () => {
  it("accepts partial nested patches and merges them", () => {
    const r = parseRoomConfigPatch({
      maxPlayers: 4,
      theme: { ambient: "snow" },
      audio: { music: 0.2 },
      teams: { count: 3 },
      streamLayout: { webcam: "tl" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const next = applyRoomConfigPatch(DEFAULT_ROOM_CONFIG, r.patch, GAME_IDS);
    expect(next.maxPlayers).toBe(4);
    expect(next.theme).toEqual({ ...DEFAULT_ROOM_CONFIG.theme, ambient: "snow" });
    expect(next.audio).toEqual({ ...DEFAULT_ROOM_CONFIG.audio, music: 0.2 });
    expect(next.teams).toEqual({ mode: "none", count: 3 });
    expect(next.streamLayout.webcam).toBe("tl");
    expect(DEFAULT_ROOM_CONFIG.maxPlayers).toBe(8); // the input is untouched
  });

  it("rejects out-of-range and unknown fields", () => {
    for (const bad of [
      { maxPlayers: 13 },
      { maxPlayers: 0 },
      { timerScale: 3 },
      { streamDelaySec: 9 },
      { audio: { music: 2 } },
      { theme: { ambient: "fog" } },
      { password: "x".repeat(65) },
      { hacker: true },
      { teams: { count: 5 } },
    ]) {
      const r = parseRoomConfigPatch(bad);
      expect(r.ok, JSON.stringify(bad)).toBe(false);
      if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
    }
    expect(parseRoomConfigPatch(undefined)).toEqual({ ok: true, patch: {} });
  });

  it("sets and clears the password, and drops disallowed games from the playlist", () => {
    const set = parseRoomConfigPatch({
      password: "pw",
      playlist: [
        { gameId: "chess", options: {} },
        { gameId: "ludo", label: "Board" },
      ],
    });
    if (!set.ok) throw new Error(set.error);
    const a = applyRoomConfigPatch(DEFAULT_ROOM_CONFIG, set.patch, ["ludo"]);
    expect(a.password).toBe("pw");
    expect(a.playlist).toEqual([{ gameId: "ludo", options: {}, label: "Board" }]);
    const clear = parseRoomConfigPatch({ password: "" });
    if (!clear.ok) throw new Error(clear.error);
    expect("password" in applyRoomConfigPatch(a, clear.patch, GAME_IDS)).toBe(false);
  });

  it("new rooms start from the defaults with the server's content filter", () => {
    const c = initialRoomConfig(parseServerConfig({ defaultContentFilter: "family" }));
    expect(c.contentFilter).toBe("family");
    expect(c.maxPlayers).toBe(DEFAULT_ROOM_CONFIG.maxPlayers);
    c.maxPlayers = 2;
    expect(DEFAULT_ROOM_CONFIG.maxPlayers).toBe(8);
  });
});

describe("system clock", () => {
  it("schedules and cancels unref'd timers", async () => {
    expect(Math.abs(systemClock.now() - Date.now())).toBeLessThan(50);
    let fired = 0;
    const cancelled = systemClock.setTimeout(() => fired--, 5);
    systemClock.clearTimeout(cancelled);
    await new Promise<void>((resolve) =>
      systemClock.setTimeout(() => {
        fired++;
        resolve();
      }, 5),
    );
    expect(fired).toBe(1);
  });
});
