/**
 * Unit tests for the room actor's pure parts (ROADMAP M1-02): the playlist decisions, Night
 * Champion, the game registry and content packs, and the fan-out's patch/full-view rule.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tictactoe } from "@sg/engine/fixtures/tictactoe";
import { viewerKeyId, type AnyGameModule, type ViewerKey } from "@sg/engine";
import { createRng, type AnyPack } from "@sg/shared";
import {
  Fanout,
  GameRegistry,
  isGameModule,
  LOWER_PLACE_POINTS,
  PackLibrary,
  placementPoints,
  Scoreboard,
  UsedContent,
  fillFromQueue,
  nextGameCandidates,
  nextInOrder,
  pickParticipants,
  raffle,
  resolveNextGameVote,
  unplayedAfter,
  type ManagedRoom,
  type Session,
  type Surface,
} from "../src/index.ts";
import type { Conn } from "../src/transport/types.ts";

const ttt = tictactoe as unknown as AnyGameModule;
const items = (n: number) =>
  Array.from({ length: n }, () => ({ gameId: "quip-clash" as const, options: {} }));

// ---------------------------------------------------------------------------------------------
// playlist.ts
// ---------------------------------------------------------------------------------------------

describe("playlist decisions", () => {
  it("unplayedAfter wraps around and skips played entries", () => {
    expect(unplayedAfter(items(5), new Set([1, 3]), 2)).toEqual([4, 0, 2]);
    expect(unplayedAfter(items(5), new Set(), -1, 2)).toEqual([0, 1]);
    expect(unplayedAfter([], new Set(), -1)).toEqual([]);
    expect(nextInOrder(items(3), new Set([0, 1, 2]), 0)).toBeNull();
    expect(nextInOrder(items(3), new Set([0]), 0)).toBe(1);
    expect(nextGameCandidates(items(6), new Set([1]), 0)).toEqual([2, 3, 4]);
  });

  it("the next-game vote takes the plurality, ties go to the earlier candidate, and a quiet audience falls back to playlist order", () => {
    expect(resolveNextGameVote([2, 3, 4], { "2": 1, "3": 4, "4": 2 }, 7, 5)).toEqual({
      index: 3,
      counted: true,
    });
    expect(resolveNextGameVote([2, 3, 4], { "3": 3, "4": 3 }, 6, 5)).toEqual({
      index: 3,
      counted: true,
    });
    expect(resolveNextGameVote([2, 3, 4], { "4": 2 }, 2, 5)).toEqual({ index: 2, counted: false });
    expect(resolveNextGameVote([2, 3], {}, 9, 5)).toEqual({ index: 2, counted: false });
    expect(() => resolveNextGameVote([], {}, 0, 0)).toThrow(RangeError);
  });

  it("participants: host-benched sit out, sat-out players go first, and a priority overflow draws among them", () => {
    const seated = Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, seat: i }));
    const split = pickParticipants({
      seated,
      capacity: 3,
      satOut: new Set(["p4", "p5"]),
      hostBenched: new Set(["p0"]),
      rng: createRng(1),
    });
    expect(split.participants.map((p) => p.id)).toEqual(expect.arrayContaining(["p4", "p5"]));
    expect(split.participants).toHaveLength(3);
    expect(split.benched.map((p) => p.id)).toContain("p0");
    const over = pickParticipants({
      seated,
      capacity: 2,
      satOut: new Set(["p1", "p2", "p3"]),
      hostBenched: new Set(),
      rng: createRng(2),
    });
    expect(over.participants).toHaveLength(2);
    for (const p of over.participants) expect(["p1", "p2", "p3"]).toContain(p.id);
    // Deterministic for a fixed seed; results are in seat order.
    const again = pickParticipants({
      seated,
      capacity: 2,
      satOut: new Set(["p1", "p2", "p3"]),
      hostBenched: new Set(),
      rng: createRng(2),
    });
    expect(again).toEqual(over);
    expect(
      pickParticipants({
        seated,
        capacity: 0,
        satOut: new Set(),
        hostBenched: new Set(),
        rng: createRng(1),
      }).participants,
    ).toEqual([]);
  });

  it("raffle and queue fill: distinct, bounded, seeded; fifo keeps join order", () => {
    const pool = ["a", "b", "b", "c", "d"];
    const r = raffle(pool, 3, createRng(9));
    expect(new Set(r).size).toBe(3);
    expect(raffle(pool, 3, createRng(9))).toEqual(r);
    expect(raffle(pool, 10, createRng(9))).toHaveLength(4);
    expect(raffle(pool, 0, createRng(9))).toEqual([]);
    expect(fillFromQueue(["x", "y", "z"], 2, "fifo", createRng(1))).toEqual(["x", "y"]);
    expect(fillFromQueue(["x", "y", "z"], 2, "raffle", createRng(1))).toHaveLength(2);
    expect(fillFromQueue([], 2, "fifo", createRng(1))).toEqual([]);
    expect(fillFromQueue(["x"], 0, "fifo", createRng(1))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// scoreboard.ts
// ---------------------------------------------------------------------------------------------

describe("Night Champion scoreboard", () => {
  const people = ["a", "b", "c", "d", "e", "f", "g", "h"].map((id) => ({
    id,
    name: id.toUpperCase(),
  }));

  it("placement points 10/7/5/3/2/1 then 1; ties share the higher placement", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 12].map(placementPoints)).toEqual([
      10,
      7,
      5,
      3,
      2,
      1,
      LOWER_PLACE_POINTS,
      1,
    ]);
    expect(placementPoints(0)).toBe(0);
    expect(placementPoints(1.5)).toBe(0);
    const sb = new Scoreboard();
    sb.record(
      "quip-clash",
      {
        ranking: [
          { id: "a", score: 9, place: 1 },
          { id: "b", score: 5, place: 2 },
          { id: "c", score: 5, place: 2 },
          { id: "x", score: 1, place: 4 },
        ],
      },
      people.slice(0, 3),
      "placement",
    );
    expect(sb.standings()).toEqual([
      { id: "a", name: "A", points: 10, place: 1 },
      { id: "b", name: "B", points: 7, place: 2 },
      { id: "c", name: "C", points: 7, place: 2 },
    ]);
    expect(sb.points("x")).toBe(0);
  });

  it("raw scoring, rename, empty rankings and the record round-trip", () => {
    const sb = new Scoreboard();
    sb.record(
      "ludo",
      {
        ranking: [
          { id: "a", score: 42, place: 1 },
          { id: "b", score: Number.NaN, place: 2 },
        ],
      },
      people,
      "raw",
    );
    expect(sb.points("a")).toBe(42);
    expect(sb.points("b")).toBe(0);
    const empty = sb.record("chess", { ranking: [] }, people, "placement");
    expect(empty.points).toEqual({});
    sb.rename("a", "Alice");
    sb.rename("nobody", "x");
    const copy = Scoreboard.fromRecord(JSON.parse(JSON.stringify(sb.toRecord())));
    expect(copy.standings()).toEqual(sb.standings());
    expect(copy.standings()[0]?.name).toBe("Alice");
    expect(copy.history).toHaveLength(2);
  });

  it("team rows award team members; a player listed twice keeps the better award", () => {
    const sb = new Scoreboard();
    const award = sb.record(
      "quip-clash",
      {
        ranking: [
          { id: "t1", score: 3, place: 1 },
          { id: "b", score: 1, place: 2 },
          { id: "t2", score: 0, place: 3 },
        ],
      },
      [
        { id: "a", name: "A", teamId: "t1" },
        { id: "b", name: "B", teamId: "t1" },
        { id: "c", name: "C", teamId: "t2" },
      ],
      "placement",
    );
    expect(award.points).toEqual({ a: 10, b: 10, c: 5 });
  });
});

// ---------------------------------------------------------------------------------------------
// games.ts
// ---------------------------------------------------------------------------------------------

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function pack(id: string, rating: "all" | "teen", words: string[]): AnyPack {
  return {
    id,
    kind: "doodle-words",
    name: id,
    lang: "en",
    rating,
    version: 1,
    items: words.map((w) => ({ w, d: 1 })),
  } as AnyPack;
}

describe("game registry and content packs", () => {
  it("isGameModule checks the manifest and every required function", () => {
    expect(isGameModule(ttt)).toBe(true);
    expect(isGameModule(ttt, "nope")).toBe(false);
    expect(isGameModule(null)).toBe(false);
    expect(isGameModule({})).toBe(false);
    expect(isGameModule({ manifest: { id: "x" }, optionSpecs: [] })).toBe(false);
    expect(isGameModule({ manifest: { id: "x", minPlayers: 1, maxPlayers: 2 } })).toBe(false);
    expect(isGameModule({ ...ttt, view: 3 })).toBe(false);
  });

  it("preload records games that fail, export nothing, or have no loader; registered modules win", async () => {
    const good = { ...ttt, manifest: { ...ttt.manifest, id: "ludo" } } as AnyGameModule;
    const reg = new GameRegistry(
      { chess: ttt },
      {
        ludo: async () => ({ logic: good }),
        doodle: async () => ({}),
        "tune-in": async () => {
          throw new Error("boom");
        },
        chess: async () => {
          throw new Error("never called");
        },
      },
    );
    const missing = await reg.preload();
    expect(reg.get("chess")).toBe(ttt);
    expect(reg.get("ludo")).toBe(good);
    expect(reg.get("doodle")).toBeNull();
    const why = new Map(missing.map((m) => [m.id, m.reason]));
    expect(why.get("doodle")).toMatch(/does not export/);
    expect(why.get("tune-in")).toBe("boom");
    expect(why.get("quip-clash")).toBe("no loader");
    expect(reg.whyUnavailable("doodle")).toMatch(/does not export/);
    expect(reg.whyUnavailable("chess")).toMatch(/not registered/);
    expect(() => reg.register("doodle", {} as AnyGameModule)).toThrow(TypeError);
    reg.register("doodle", ttt);
    expect(reg.unavailable().some((u) => u.id === "doodle")).toBe(false);
  });

  it("the default loaders import every launch game without throwing", async () => {
    const reg = new GameRegistry();
    const missing = await reg.preload();
    for (const m of missing) expect(typeof m.reason).toBe("string");
  });

  it("PackLibrary.load validates packs and reports bad, misplaced and duplicate ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "sg-packs-"));
    dirs.push(dir);
    mkdirSync(join(dir, "doodle-words"));
    mkdirSync(join(dir, "spectrum"));
    writeFileSync(
      join(dir, "doodle-words", "a.json"),
      JSON.stringify(pack("words-a", "all", ["cat", "dog"])),
    );
    writeFileSync(
      join(dir, "doodle-words", "b.json"),
      JSON.stringify(pack("words-a", "all", ["sun"])),
    );
    writeFileSync(join(dir, "doodle-words", "c.json"), "{ not json");
    writeFileSync(
      join(dir, "doodle-words", "d.json"),
      JSON.stringify({ kind: "doodle-words", id: "bad" }),
    );
    writeFileSync(
      join(dir, "spectrum", "e.json"),
      JSON.stringify(pack("words-e", "all", ["moon"])),
    );
    writeFileSync(join(dir, "doodle-words", "ignored.txt"), "x");
    const lib = PackLibrary.load(dir);
    expect(lib.size).toBe(1);
    const files = lib.problems.map((p) => p.file).sort();
    expect(files).toEqual([
      "doodle-words/b.json",
      "doodle-words/c.json",
      "doodle-words/d.json",
      "spectrum/e.json",
    ]);
    expect(lib.problems.find((p) => p.file === "spectrum/e.json")?.errors[0]).toMatch(/folder/);
    expect(lib.problems.find((p) => p.file === "doodle-words/b.json")?.errors[0]).toMatch(
      /duplicate/,
    );
    expect(PackLibrary.load(join(dir, "missing")).size).toBe(0);
    expect(PackLibrary.empty().size).toBe(0);
  });

  it("forRoom: family rooms see only 'all' packs; commit marks the items the game kept", () => {
    const lib = new PackLibrary([
      pack("kids", "all", ["cat", "dog"]),
      pack("spicy", "teen", ["wine"]),
    ]);
    const used = new UsedContent();
    const family = lib.forRoom("family", used);
    expect(family.access.packs("doodle-words").map((p) => p.id)).toEqual(["kids"]);
    expect(family.access.packs("spectrum")).toEqual([]);
    expect(family.access.items("doodle-words", ["kids", "spicy", "nope"])).toHaveLength(2);
    expect(family.access.items("spectrum", ["kids"])).toEqual([]);
    family.commit(JSON.stringify({ hidden: { word: "cat" } }));
    expect(used.has("doodle-words", "cat")).toBe(true);
    expect(used.has("doodle-words", "dog")).toBe(false);
    expect(family.access.isUsed("doodle-words", "cat")).toBe(true);
    const standard = lib.forRoom("standard", used);
    expect(standard.access.packs("doodle-words")).toHaveLength(2);
    const restored = UsedContent.fromRecord(JSON.parse(JSON.stringify(used.toRecord())));
    expect(restored.has("doodle-words", "cat")).toBe(true);
    expect(UsedContent.fromRecord(undefined).toRecord()).toEqual({});
  });
});

// ---------------------------------------------------------------------------------------------
// fanout.ts
// ---------------------------------------------------------------------------------------------

interface Sent {
  to: string;
  data: string | Uint8Array;
}

function fakeConn(name: string, log: Sent[], subs: Set<string>): Conn {
  return {
    send: (data: string | Uint8Array) => log.push({ to: name, data }),
    subscribe: (t: string) => subs.add(`${name}@${t}`),
    unsubscribe: (t: string) => subs.delete(`${name}@${t}`),
  } as unknown as Conn;
}

describe("fan-out", () => {
  function setup() {
    const log: Sent[] = [];
    const subs = new Set<string>();
    const conns = (name: string) =>
      new Map<Surface, Conn>([["controller", fakeConn(name, log, subs)]]);
    const player = {
      id: "p1",
      role: "player",
      connected: true,
      background: false,
      conns: conns("p1"),
    } as unknown as Session;
    const aud = {
      id: "a1",
      role: "audience",
      connected: true,
      background: false,
      conns: conns("a1"),
    } as unknown as Session;
    const room = {
      byId: new Map([
        ["p1", player],
        ["a1", aud],
      ]),
      topics: { aud: "r:X:aud", stage: "r:X:stage" },
    } as unknown as ManagedRoom;
    const views = new Map<string, unknown>();
    let calls = 0;
    const fan = new Fanout(
      room,
      {
        send: (conn, data) => conn.send(data),
        publish: (topic, data) => log.push({ to: topic, data }),
      },
      {
        keyFor: (s: Session): ViewerKey =>
          s.role === "player" ? { role: "player", id: s.id } : { role: "audience" },
      },
    );
    const source = {
      view: (k: ViewerKey) => {
        calls++;
        return views.get(viewerKeyId(k)) ?? null;
      },
    };
    return { log, subs, fan, views, source, player, aud, calls: () => calls };
  }
  const texts = (log: Sent[], to: string) =>
    log
      .filter((s) => s.to === to && typeof s.data === "string")
      .map((s) => JSON.parse(s.data as string) as { t: string; seq: number });

  it("sends a patch with the next seq, and the full view when the patch is larger than 60% of it", () => {
    const { log, fan, views, source, player } = setup();
    const big = { score: 1, words: Array.from({ length: 40 }, (_, i) => `word${i}`) };
    views.set("audience", big);
    views.set("player:p1", { a: 1 });
    fan.setSource("quip-clash", source);
    fan.flush();
    expect(texts(log, "r:X:aud").map((m) => [m.t, m.seq])).toEqual([["view", 1]]);
    // Small change: patch.
    views.set("audience", { ...big, score: 2 });
    fan.flush();
    expect(texts(log, "r:X:aud").at(-1)).toMatchObject({ t: "patch", seq: 2 });
    // Everything changes: the patch would be bigger than 60% of the full view, so the full view goes out.
    views.set("audience", { score: 3, words: big.words.map((w) => `${w}!`) });
    fan.flush();
    expect(texts(log, "r:X:aud").at(-1)).toMatchObject({ t: "view", seq: 3 });
    // No change: nothing is sent.
    const n = log.length;
    fan.flush();
    expect(log.length).toBe(n);
    expect(fan.seqOf({ role: "audience" })).toBe(3);
    expect(fan.stats.patches).toBe(1);
    // A resync gets the stream's last frame at the current seq.
    fan.sendFull(player, "controller", player.conns.get("controller") as Conn);
    expect(texts(log, "p1").at(-1)).toMatchObject({ t: "view", seq: 1 });
  });

  it("several steps in one turn coalesce into one frame per key, and view() runs once per key per flush", () => {
    const { log, fan, views, source, calls } = setup();
    views.set("audience", { n: 0 });
    views.set("player:p1", { n: 0 });
    fan.setSource("quip-clash", source);
    fan.flush();
    const before = log.length;
    const c0 = calls();
    for (let i = 1; i <= 5; i++) views.set("audience", { n: i });
    fan.flush();
    expect(log.length - before).toBe(1);
    expect(calls() - c0).toBe(2);
  });

  it("topics follow the viewer key; fx batch per turn and skip hidden tabs; binary frames go where they belong", () => {
    const { log, subs, fan, player, aud } = setup();
    fan.syncTopics(player);
    fan.syncTopics(aud);
    expect([...subs]).toEqual(["a1@r:X:aud"]);
    (player as { background: boolean }).background = true;
    fan.queueFx([{ name: "a" }, { name: "b", data: 1 }]);
    fan.flush();
    expect(log.filter((s) => s.to === "p1")).toEqual([]);
    expect(texts(log, "r:X:stage")).toHaveLength(1);
    fan.stream("aud", new Uint8Array([1]));
    fan.streamEach([
      { to: "a1", frame: new Uint8Array([3]) },
      { to: "ghost", frame: new Uint8Array([3]) },
    ]);
    expect(log.filter((s) => s.data instanceof Uint8Array).map((s) => s.to)).toEqual([
      "r:X:aud",
      "a1",
    ]);
    fan.toMember("ghost", { t: "fx", events: [] });
    fan.setSource(null, null);
    expect(fan.game).toBeNull();
    fan.sendFull(player, "controller", player.conns.get("controller") as Conn);
  });
});
