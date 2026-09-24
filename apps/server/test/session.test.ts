import type { Role } from "@sg/shared";
import { describe, expect, it } from "vitest";
import {
  gate,
  hashIp,
  MESSAGE_ROLES,
  newOverlayKey,
  newSessionToken,
  parseC2S,
  safeEqual,
  Session,
  SlidingWindow,
  TokenBucket,
  type ParsedC2S,
} from "../src/session.ts";
import type { Conn } from "../src/transport/types.ts";

const fakeConn = (id: number): Conn => ({
  id,
  ip: "1.2.3.4",
  isOpen: true,
  send: () => true,
  subscribe: () => {},
  unsubscribe: () => {},
  close: () => {},
  bufferedAmount: () => 0,
});

const msg = (value: unknown): ParsedC2S => {
  const r = parseC2S(value);
  if (!r.ok) throw new Error(r.error);
  return r.msg;
};

describe("secrets", () => {
  it("session tokens are 128-bit and overlay keys 96-bit, base64url", () => {
    const tokens = new Set(Array.from({ length: 500 }, newSessionToken));
    expect(tokens.size).toBe(500);
    for (const t of tokens) {
      expect(t).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(Buffer.from(t, "base64url")).toHaveLength(16);
    }
    const key = newOverlayKey();
    expect(Buffer.from(key, "base64url")).toHaveLength(12);
    expect(key).toHaveLength(16);
  });

  it("compares secrets safely and hashes IPs with a salt", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
    const a = hashIp("10.0.0.1", "salt-a");
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(hashIp("10.0.0.1", "salt-a")).toBe(a);
    expect(hashIp("10.0.0.1", "salt-b")).not.toBe(a);
    expect(hashIp("10.0.0.2", "salt-a")).not.toBe(a);
  });
});

describe("Session", () => {
  const make = (): Session =>
    new Session({
      token: "t",
      id: "p1",
      role: "player",
      name: "Ash",
      seat: 2,
      ipHash: "h",
      joinedAt: 5,
      epoch: 3,
      teamId: "t1",
    });

  it("tracks sockets per surface and replaces a surface's socket", () => {
    const s = make();
    expect(s.connected).toBe(false);
    const a = fakeConn(1);
    const b = fakeConn(2);
    expect(s.attach("controller", a)).toBeUndefined();
    expect(s.attach("controller", a)).toBeUndefined();
    expect(s.connected).toBe(true);
    expect(s.attach("controller", b)).toBe(a);
    expect(s.detach(a)).toBe(false);
    expect(s.attach("panel", a)).toBeUndefined();
    expect(s.conns.size).toBe(2);
    expect(s.detach(b)).toBe(true);
    expect(s.detach(a)).toBe(true);
    expect(s.connected).toBe(false);
  });

  it("round-trips through its record", () => {
    const s = make();
    s.queued = true;
    const r = s.toRecord();
    expect(r).toEqual({
      token: "t",
      id: "p1",
      role: "player",
      name: "Ash",
      seat: 2,
      teamId: "t1",
      ipHash: "h",
      joinedAt: 5,
      queued: true,
    });
    const back = Session.fromRecord(r, 4);
    expect(back).toMatchObject({
      token: "t",
      id: "p1",
      seat: 2,
      epoch: 4,
      queued: true,
      teamId: "t1",
    });
    const plain = new Session({
      token: "u",
      id: "a1",
      role: "audience",
      name: "V",
      seat: null,
      ipHash: "h",
      joinedAt: 1,
      epoch: 1,
    });
    expect(plain.toRecord()).not.toHaveProperty("queued");
    expect(plain.toRecord()).not.toHaveProperty("teamId");
  });
});

describe("rate limiters", () => {
  it("token bucket: burst, then the sustained rate", () => {
    const b = new TokenBucket(5, 5, 0);
    for (let i = 0; i < 5; i++) expect(b.take(0)).toBe(true);
    expect(b.take(0)).toBe(false);
    expect(b.take(199)).toBe(false);
    expect(b.take(200)).toBe(true); // 200 ms at 5/s = 1 token
    expect(b.take(10_000)).toBe(true);
    b.reset(20, 20, 10_000);
    for (let i = 0; i < 20; i++) expect(b.take(10_000)).toBe(true);
    expect(b.take(10_000)).toBe(false);
    expect(b.take(9_000)).toBe(false); // time going backwards adds nothing
  });

  it("sliding window: limit per key per window, bounded memory", () => {
    const w = new SlidingWindow(3, 60_000);
    expect([w.hit("a", 0), w.hit("a", 1), w.hit("a", 2), w.hit("a", 3)]).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(w.hit("b", 3)).toBe(true);
    expect(w.count("a", 59_999)).toBe(3);
    expect(w.hit("a", 60_000)).toBe(true); // the first hit left the window
    expect(w.count("a", 60_000)).toBe(3);
    w.sweep(200_000);
    expect(w.size).toBe(0);
  });
});

describe("parseC2S", () => {
  it("accepts every protocol message", () => {
    const ok: unknown[] = [
      { t: "hello", v: 1, code: "BCDF", want: "player", name: "x", token: "t", password: "p" },
      { t: "hello", v: 1, code: "BCDF", want: "overlay", overlayKey: "k" },
      { t: "create", v: 1, name: "Host", config: { maxPlayers: 4 } },
      { t: "act", id: 0, a: { anything: [1, 2] } },
      { t: "aud", pollId: "p1", choice: "b" },
      { t: "aud", pollId: "p1", choice: 42 },
      { t: "tap", pollId: "p1", n: 10 },
      { t: "audAct", a: { nudge: 1 } },
      { t: "enroll", skin: 47 },
      { t: "react", e: "heart" },
      { t: "queue", join: true },
      { t: "host", cmd: { c: "config", patch: { theme: { ambient: "night" } } } },
      { t: "host", cmd: { c: "playlist.set", items: [{ gameId: "ludo", options: {} }] } },
      ...["start", "next", "pause", "resume", "endGame", "forceAdvance"].map((c) => ({
        t: "host",
        cmd: { c },
      })),
      { t: "host", cmd: { c: "kick", id: "p2", ban: true } },
      { t: "host", cmd: { c: "promote", id: "a3", role: "moderator" } },
      { t: "host", cmd: { c: "team.assign", id: "p2", teamId: null } },
      { t: "host", cmd: { c: "revealCode", on: true } },
      { t: "host", cmd: { c: "ambient", mode: "snow" } },
      { t: "host", cmd: { c: "transferHost", id: "p1" } },
      { t: "host", cmd: { c: "raffle", n: 3 } },
      { t: "host", cmd: { c: "bench", ids: ["p1"] } },
      { t: "host", cmd: { c: "fillBots", on: true } },
      { t: "mod", cmd: { c: "approve", itemId: "i" } },
      { t: "mod", cmd: { c: "reject", itemId: "i" } },
      { t: "mod", cmd: { c: "mute", id: "p1", minutes: 5 } },
      { t: "mod", cmd: { c: "rename", id: "p1", name: "Nice" } },
      { t: "resync", lastSeq: 3 },
      { t: "bg", on: true },
      { t: "ping", ts: 123.5 },
    ];
    for (const m of ok) expect(parseC2S(m).ok, JSON.stringify(m)).toBe(true);
  });

  it("rejects malformed messages and strips unknown fields", () => {
    const bad: unknown[] = [
      null,
      { t: "nope" },
      { t: "hello", v: 1, code: "BCDF", want: "god" },
      { t: "tap", pollId: "p", n: 11 },
      { t: "enroll", skin: 48 },
      { t: "react", e: "angry" },
      { t: "act", id: -1, a: 0 },
      { t: "aud", pollId: "p", choice: "x".repeat(201) },
      { t: "host", cmd: { c: "raffle", n: 0 } },
      { t: "host", cmd: { c: "config", patch: { maxPlayers: 50 } } },
      { t: "host", cmd: { c: "sudo" } },
      { t: "mod", cmd: { c: "mute", id: "p", minutes: -1 } },
      { t: "ping", ts: Number.NaN },
    ];
    for (const m of bad) {
      const r = parseC2S(m);
      expect(r.ok, JSON.stringify(m)).toBe(false);
    }
    expect(msg({ t: "queue", join: false, role: "host" })).toEqual({ t: "queue", join: false });
  });
});

describe("role gate", () => {
  const roles: Role[] = ["host", "player", "audience", "moderator", "overlay"];

  it("overlays are read-only", () => {
    const allowed = Object.keys(MESSAGE_ROLES).filter((t) =>
      (MESSAGE_ROLES as Record<string, readonly Role[]>)[t]?.includes("overlay"),
    );
    expect(allowed.sort()).toEqual(["bg", "ping", "resync"]);
    expect(gate("overlay", msg({ t: "act", id: 1, a: 0 }))).toBe(false);
    expect(gate("overlay", msg({ t: "host", cmd: { c: "start" } }))).toBe(false);
  });

  it("only players act, only the audience votes, only host/moderators moderate", () => {
    const act = msg({ t: "act", id: 1, a: 0 });
    const vote = msg({ t: "aud", pollId: "p", choice: "a" });
    const mod = msg({ t: "mod", cmd: { c: "approve", itemId: "x" } });
    expect(roles.filter((r) => gate(r, act))).toEqual(["player"]);
    expect(roles.filter((r) => gate(r, vote))).toEqual(["audience"]);
    expect(roles.filter((r) => gate(r, mod))).toEqual(["host", "moderator"]);
    expect(roles.filter((r) => gate(r, msg({ t: "ping", ts: 1 })))).toEqual(roles);
    expect(gate("host", msg({ t: "hello", v: 1, code: "BCDF", want: "player" }))).toBe(false);
  });

  it("moderators may kick and pause but not run the show", () => {
    expect(gate("moderator", msg({ t: "host", cmd: { c: "kick", id: "p1" } }))).toBe(true);
    expect(gate("moderator", msg({ t: "host", cmd: { c: "pause" } }))).toBe(true);
    expect(gate("moderator", msg({ t: "host", cmd: { c: "resume" } }))).toBe(true);
    expect(gate("moderator", msg({ t: "host", cmd: { c: "start" } }))).toBe(false);
    expect(gate("moderator", msg({ t: "host", cmd: { c: "transferHost", id: "p1" } }))).toBe(false);
    expect(gate("host", msg({ t: "host", cmd: { c: "transferHost", id: "p1" } }))).toBe(true);
    expect(gate("player", msg({ t: "host", cmd: { c: "pause" } }))).toBe(false);
  });
});
