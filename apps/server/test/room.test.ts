/**
 * Room actor (ROADMAP M1-02) through the real RoomManager on a fake clock and fake network.
 * Each ROADMAP Accept bullet has a test named after it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { tictactoe, type TttView } from "@sg/engine/fixtures/tictactoe";
import type { AnyGameModule, GameModule } from "@sg/engine";
import type { S2C } from "@sg/shared";
import { MemoryStore, NEXT_GAME_POLL_ID, type RoomRecord } from "../src/index.ts";
import { HOST_ONLY_MARK, partyGame, type PartyView } from "./fixtures/party.ts";
import { RoomHarness, type FakeClient } from "./room-harness.ts";

const harnesses: RoomHarness[] = [];
function harness(...args: ConstructorParameters<typeof RoomHarness>): RoomHarness {
  const h = new RoomHarness(...args);
  harnesses.push(h);
  return h;
}
afterEach(() => {
  for (const h of harnesses.splice(0)) h.shutdown();
});

const FAST = { introMs: 1_000, resultsMs: 1_000, scoreboardMs: 1_000 };
const ttt = tictactoe as unknown as AnyGameModule;

/** Plays tictactoe moves for a client whenever it is its turn. */
function tttBot(c: FakeClient): void {
  c.pump();
  const v = c.view as TttView | null;
  if (v === null || v.phase !== "turn" || v.you?.yourTurn !== true) return;
  const cell = v.board.findIndex((m) => m === null);
  if (cell >= 0)
    c.send({ t: "act", id: Math.floor(Math.random() * 1e6), a: { type: "move", cell } });
}

function standings(c: FakeClient): { id: string; points: number; place: number }[] {
  c.pump();
  return (c.room?.standings ?? []).map((r) => ({ id: r.id, points: r.points, place: r.place }));
}

describe("room actor: accept criteria", () => {
  it("a room with the tictactoe fixture plays a full playlist of 2 games using 2 bot clients", async () => {
    const h = harness({
      games: { chess: ttt, ludo: ttt },
      actor: { timings: FAST },
    });
    const host = h.create({
      playlistMode: "fixed",
      streamDelaySec: 0,
      playlist: [
        { gameId: "chess", options: { turnSec: 10 } },
        { gameId: "ludo", options: { turnSec: 10 } },
      ],
    });
    const code = host.room?.code as string;
    const a = h.join(code, { name: "Ann" });
    const b = h.join(code, { name: "Bob" });
    h.host(host, { c: "start" });
    const phases = new Set<string>();
    const games = new Set<string>();
    for (let t = 0; t < 120_000 && host.room?.phase !== "ended"; t += 200) {
      await h.advance(200, 200, [host, a, b]);
      tttBot(a);
      tttBot(b);
      phases.add(host.room?.phase ?? "");
      if (host.room?.current) games.add(host.room.current);
    }
    expect(host.room?.phase).toBe("ended");
    expect([...games].sort()).toEqual(["chess", "ludo"]);
    for (const p of ["intro", "game", "results", "scoreboard", "ended"])
      expect(phases).toContain(p);
    expect(h.actor(code).played).toEqual([0, 1]);
    expect(h.actor(code).scoreboard.history).toHaveLength(2);
    // Every view patch applied in order; players saw their own game views.
    expect(a.seqGaps + b.seqGaps + host.seqGaps).toBe(0);
    expect(a.all.some((m) => m.t === "view" && m.game === "ludo")).toBe(true);
    // Both players acted through the protocol and every ack came back ok.
    const acks = [...a.all, ...b.all].filter((m): m is Extract<S2C, { t: "ack" }> => m.t === "ack");
    expect(acks.length).toBeGreaterThan(4);
    expect(acks.every((m) => m.ok)).toBe(true);
  });

  it("the Scoreboard shows placement points", async () => {
    const h = harness({
      games: { "quip-clash": partyGame({ min: 3, max: 8 }) },
      actor: { timings: FAST },
    });
    const host = h.create({
      playlistMode: "fixed",
      streamDelaySec: 0,
      playlist: [{ gameId: "quip-clash", options: {} }],
    });
    const code = host.room?.code as string;
    const ps = ["A", "B", "C", "D"].map((name) => h.join(code, { name }));
    h.host(host, { c: "start" });
    await h.advance(1_000, 100, [host, ...ps]);
    expect(host.room?.phase).toBe("game");
    // Submit in the order C, A, D, B → places 1..4.
    for (const i of [2, 0, 3, 1])
      ps[i]?.send({ t: "act", id: 1, a: { type: "submit", text: `line ${i}` } });
    await h.advance(100, 100, [host]);
    expect(host.room?.phase).toBe("results");
    const byName = Object.fromEntries(
      (host.room?.standings ?? []).map((r) => [r.name, { points: r.points, place: r.place }]),
    );
    expect(byName).toEqual({
      C: { points: 10, place: 1 },
      A: { points: 7, place: 2 },
      D: { points: 5, place: 3 },
      B: { points: 3, place: 4 },
    });
    // Every audience member and player sees the same standings in the room snapshot.
    ps[0]?.pump();
    expect(ps[0]?.room?.standings).toEqual(host.room?.standings);
  });

  it("killing a client's socket mid-turn leads to bot takeover after the grace period", async () => {
    const h = harness({ games: { chess: ttt }, actor: { timings: FAST, botDelayMs: 500 } });
    const host = h.create({
      playlistMode: "fixed",
      streamDelaySec: 0,
      reconnectGraceSec: 3,
      playlist: [{ gameId: "chess", options: { turnSec: 60 } }],
    });
    const code = host.room?.code as string;
    const a = h.join(code, { name: "Ann" });
    const b = h.join(code, { name: "Bob" });
    h.host(host, { c: "start" });
    await h.advance(1_000 + 3_000 + 100, 100, [host, a, b]); // room intro + ttt intro
    const v = host.view as TttView;
    expect(v.phase).toBe("turn");
    const mover = v.players[v.turn]?.id as string;
    const victim = mover === a.id ? a : b;
    const movesBefore = v.moves;
    victim.close(); // socket killed mid-turn
    await h.advance(2_900, 100, [host]);
    // Inside the grace period the seat is held, nobody moves for them.
    expect((host.view as TttView).moves).toBe(movesBefore);
    expect(host.room?.members.find((m) => m.id === victim.id)).toMatchObject({ connected: false });
    expect(host.room?.members.find((m) => m.id === victim.id)?.bot).toBeUndefined();
    await h.advance(100 + 500 + 100, 100, [host]);
    // Grace over: the module's bot plays the seat (well before the 60 s turn timer).
    expect((host.view as TttView).moves).toBe(movesBefore + 1);
    expect(host.room?.members.find((m) => m.id === victim.id)).toMatchObject({
      bot: true,
      connected: false,
    });
    expect(h.actor(code).runner?.isBot(victim.id)).toBe(true);
  });

  it("with 1 audience member and 1,000 audience members, the server calls view() for the audience the same number of times", async () => {
    const run = async (audience: number): Promise<{ audienceViews: number; steps: number }> => {
      let audienceViews = 0;
      const base = partyGame({ min: 2, max: 8 }) as GameModule<unknown, unknown, unknown, unknown>;
      const spy: AnyGameModule = {
        ...base,
        view(state, viewer) {
          if (viewer.role === "audience") audienceViews++;
          return base.view(state, viewer);
        },
      };
      const h = harness({ games: { "quip-clash": spy }, actor: { timings: FAST } });
      const host = h.create({
        playlistMode: "fixed",
        streamDelaySec: 0,
        antiSnipe: false,
        playlist: [{ gameId: "quip-clash", options: {} }],
      });
      const code = host.room?.code as string;
      const ps = [0, 1, 2].map((i) => h.join(code, { name: `P${i}` }));
      const aud: FakeClient[] = [];
      for (let i = 0; i < audience; i++)
        aud.push(h.join(code, { want: "audience", ip: `10.1.${i >> 8}.${i & 255}` }));
      h.host(host, { c: "start" });
      await h.advance(1_100, 100);
      ps[0]?.send({ t: "act", id: 1, a: { type: "submit", text: "one" } });
      await h.settle();
      ps[1]?.send({ t: "act", id: 2, a: { type: "submit", text: "two" } });
      ps[2]?.send({ t: "act", id: 3, a: { type: "submit", text: "three" } });
      await h.settle();
      // Every audience member received the same shared audience frames through one topic.
      const last = aud[aud.length - 1] as FakeClient;
      last.pump();
      expect((last.view as PartyView).submitted).toHaveLength(3);
      return { audienceViews, steps: h.actor(code).fanout.stats.flushes };
    };
    const one = await run(1);
    const thousand = await run(1_000);
    expect(one.audienceViews).toBeGreaterThan(0);
    expect(thousand.audienceViews).toBe(one.audienceViews);
    // Once per step at most: never more audience view() calls than flushes that sent frames.
    expect(one.audienceViews).toBeLessThanOrEqual(one.steps);
  });

  it("9 seated players and a 4-seat game: exactly 4 participants, the 5 benched players are guaranteed seats in the next game with room, and benched players get no placement points", async () => {
    const h = harness({
      games: {
        ludo: partyGame({ id: "ludo", min: 2, max: 4 }),
        "quip-clash": partyGame({ min: 2, max: 8 }),
      },
      actor: { timings: FAST },
    });
    const host = h.create({
      playlistMode: "fixed",
      streamDelaySec: 0,
      maxPlayers: 12,
      playlist: [
        { gameId: "ludo", options: {} },
        { gameId: "quip-clash", options: {} },
      ],
    });
    const code = host.room?.code as string;
    const ps = Array.from({ length: 9 }, (_, i) => h.join(code, { name: `P${i + 1}` }));
    h.host(host, { c: "start" });
    await h.settle();
    const actor = h.actor(code);
    const game1 = actor.participants;
    const benched1 = actor.benched;
    expect(game1).toHaveLength(4);
    expect(benched1).toHaveLength(5);
    expect(new Set([...game1, ...benched1]).size).toBe(9);
    // Benched players are audience for this game and flagged in the room snapshot.
    host.pump();
    for (const id of benched1)
      expect(host.room?.members.find((m) => m.id === id)).toMatchObject({
        benched: true,
        seat: expect.any(Number),
      });
    const benchedClient = ps.find((p) => p.id === benched1[0]) as FakeClient;
    benchedClient.pump();
    await h.advance(1_000, 100, ps);
    expect(benchedClient.view).not.toHaveProperty("you");
    // A benched player cannot act.
    benchedClient.send({ t: "act", id: 5, a: { type: "submit", text: "x" } });
    expect(benchedClient.take("ack").at(-1)).toMatchObject({ ok: false, err: "NOT_ALLOWED" });
    for (const id of game1)
      ps.find((p) => p.id === id)?.send({ t: "act", id: 1, a: { type: "submit", text: "go" } });
    await h.settle();
    host.pump();
    expect(host.room?.phase).toBe("results");
    const pts = new Map(standings(host).map((r) => [r.id, r.points]));
    expect([...pts.values()].sort((x, y) => y - x)).toEqual([10, 7, 5, 3]);
    for (const id of benched1) expect(pts.has(id)).toBe(false);
    // Next game (8 seats): all 5 benched players play.
    await h.advance(1_000 + 1_000, 100, [host]);
    expect(host.room?.phase).toBe("intro");
    const game2 = actor.participants;
    for (const id of benched1) expect(game2).toContain(id);
    expect(game2).toHaveLength(8);
    expect(actor.benched).toHaveLength(1);
  });

  it("raffle 3 with a queue of 50 picks 3 distinct members, deterministic for a fixed seed", async () => {
    const pick = async (seed: number): Promise<string[]> => {
      const h = harness({
        games: { "quip-clash": partyGame() },
        actor: { timings: FAST, seed: () => seed },
      });
      const host = h.create({ maxPlayers: 12, playlist: [{ gameId: "quip-clash", options: {} }] });
      const code = host.room?.code as string;
      h.join(code, { name: "P1" });
      const aud = Array.from({ length: 50 }, (_, i) =>
        h.join(code, { want: "audience", name: `V${i}` }),
      );
      for (const c of aud) c.send({ t: "queue", join: true });
      h.host(host, { c: "raffle", n: 3 });
      await h.settle();
      host.pump();
      const fx = host.all
        .filter((m): m is Extract<S2C, { t: "fx" }> => m.t === "fx")
        .flatMap((m) => m.events);
      const raffleFx = fx.find((e) => e.name === "raffle");
      const winners = (raffleFx?.data as { winners: { id: string }[] }).winners.map((w) => w.id);
      // In the lobby the winners take their seats at once (the lobby is a game boundary).
      const seated = (host.room?.members ?? []).filter((m) => m.role === "player").map((m) => m.id);
      for (const w of winners) expect(seated).toContain(w);
      const queuedIds = new Set(aud.map((c) => c.id));
      for (const w of winners) expect(queuedIds.has(w)).toBe(true);
      return winners;
    };
    const w1 = await pick(7);
    expect(w1).toHaveLength(3);
    expect(new Set(w1).size).toBe(3);
    expect(await pick(7)).toEqual(w1);
    const others = [await pick(8), await pick(9), await pick(10)];
    expect(others.some((w) => JSON.stringify(w) !== JSON.stringify(w1))).toBe(true);
  });

  const votePlaylist = [
    { gameId: "quip-clash", options: {} },
    { gameId: "tune-in", options: {} },
    { gameId: "doodle", options: {} },
    { gameId: "trivia-night", options: {} },
  ];
  async function toVote(
    voters: number,
    choice: string,
  ): Promise<{ h: RoomHarness; code: string; host: FakeClient }> {
    const h = harness({
      games: {
        "quip-clash": partyGame({ id: "quip-clash" }),
        "tune-in": partyGame({ id: "tune-in" }),
        doodle: partyGame({ id: "doodle" }),
        "trivia-night": partyGame({ id: "trivia-night" }),
      },
      actor: { timings: FAST },
    });
    const host = h.create({
      playlistMode: "audience-vote",
      streamDelaySec: 0,
      audienceMin: 5,
      playlist: votePlaylist,
    });
    const code = host.room?.code as string;
    const ps = [h.join(code, { name: "A" }), h.join(code, { name: "B" })];
    const aud = Array.from({ length: 8 }, (_, i) =>
      h.join(code, { want: "audience", ip: `10.2.0.${i}` }),
    );
    h.host(host, { c: "start" });
    await h.advance(1_000, 100);
    for (const p of ps) p.send({ t: "act", id: 1, a: { type: "submit", text: "x" } });
    await h.advance(1_000, 100, [host, ...aud]);
    expect(host.room?.phase).toBe("scoreboard");
    const poll = aud[0]?.take("poll").find((m) => m.poll.pollId === NEXT_GAME_POLL_ID)?.poll;
    expect(poll?.options?.map((o) => o.id)).toEqual(["1", "2", "3"]);
    expect(poll?.kind).toBe("vote");
    // Split: one vote for "2", then `voters` votes for `choice`.
    aud[7]?.send({ t: "aud", pollId: NEXT_GAME_POLL_ID, choice: "2" });
    for (let i = 0; i < voters; i++) aud[i]?.send({ t: "aud", pollId: NEXT_GAME_POLL_ID, choice });
    await h.advance(15_100, 500, [host]);
    return { h, code, host };
  }

  it("the next-game vote picks the plurality candidate", async () => {
    const { host } = await toVote(5, "3");
    expect(host.room?.phase).toBe("intro");
    expect(host.room?.current).toBe("trivia-night");
    expect(host.room?.playlistIndex).toBe(3);
  });

  it("with 2 voters (below audienceMin) the playlist order is used", async () => {
    // 1 + 1 voters = 2 < audienceMin 5: the next entry in playlist order (index 1) runs.
    const { host } = await toVote(1, "3");
    expect(host.room?.phase).toBe("intro");
    expect(host.room?.current).toBe("tune-in");
    expect(host.room?.playlistIndex).toBe(1);
  });

  it("pausing for 30 s and resuming leaves the remaining input time unchanged (±50 ms)", async () => {
    const h = harness({ games: { chess: ttt }, actor: { timings: FAST } });
    const host = h.create({
      playlistMode: "fixed",
      streamDelaySec: 3,
      playlist: [{ gameId: "chess", options: { turnSec: 20 } }],
    });
    const code = host.room?.code as string;
    const a = h.join(code);
    const b = h.join(code);
    h.host(host, { c: "start" });
    await h.advance(1_000 + 3_000 + 1_234, 100, [host, a, b]);
    const before = host.view as TttView;
    expect(before.phase).toBe("turn");
    const remainingBefore = (before.deadline as number) - h.clock.now();
    expect(remainingBefore).toBeGreaterThan(10_000);
    h.host(host, { c: "pause" });
    await h.settle();
    host.pump();
    expect(host.room?.paused).toBe(true);
    await h.advance(30_000, 1_000, [host]);
    // Frozen: nothing moved while paused (no timeout move, no bot).
    expect((host.view as TttView).moves).toBe(before.moves);
    h.host(host, { c: "resume" });
    await h.settle();
    host.pump();
    expect(host.room?.paused).toBe(false);
    const after = host.view as TttView;
    const remainingAfter = (after.deadline as number) - h.clock.now();
    expect(Math.abs(remainingAfter - remainingBefore)).toBeLessThanOrEqual(50);
    // And the turn timer really fires at the restored deadline, not 30 s early.
    await h.advance(remainingAfter - 200, 100, [host]);
    expect((host.view as TttView).moves).toBe(before.moves);
    await h.advance(400, 100, [host]);
    expect((host.view as TttView).moves).toBe(before.moves + 1);
  });

  it("a Stage socket never receives a frame containing a host-view-only field (frame grep test)", async () => {
    const h = harness({ games: { "quip-clash": partyGame() }, actor: { timings: FAST } });
    const stage = h.create({
      playlistMode: "fixed",
      streamDelaySec: 0,
      moderation: "reveal-review",
      playlist: [{ gameId: "quip-clash", options: {} }],
    });
    const code = stage.room?.code as string;
    const panel = h.join(code, { token: stage.token, want: "moderator" });
    const overlayKey = h.room(code).overlayKey;
    const overlay = h.join(code, { want: "overlay", overlayKey });
    const mod = h.join(code, { name: "Mod" });
    h.host(stage, { c: "promote", id: mod.id, role: "moderator" });
    const ps = [
      h.join(code, { name: "A" }),
      h.join(code, { name: "B" }),
      h.join(code, { name: "C" }),
    ];
    const aud = h.join(code, { want: "audience", ip: "10.9.9.9" });
    h.host(stage, { c: "start" });
    await h.advance(1_000, 100);
    ps[0]?.send({ t: "act", id: 1, a: { type: "submit", text: "SECRETLINE-alpha" } });
    ps[1]?.send({ t: "act", id: 2, a: { type: "submit", text: "SECRETLINE-beta" } });
    await h.advance(500, 100);
    h.host(stage, { c: "next" }); // forceAdvance: game ends, auto-submits the last seat
    await h.advance(3_000, 100, [stage, panel, overlay, mod, aud, ...ps]);
    // Positive control: the host panel and moderators did get host-only data.
    expect(panel.rawText()).toContain(HOST_ONLY_MARK);
    expect(panel.rawText()).toContain("SECRETLINE-alpha"); // modq preview
    expect(mod.rawText()).toContain("SECRETLINE-alpha");
    // The Stage window and the overlay never did: no host view, no modq, no pending text.
    for (const c of [stage, overlay, aud]) {
      const text = c.rawText();
      expect(text).not.toContain(HOST_ONLY_MARK);
      expect(text).not.toContain("hostOnly");
      expect(text).not.toContain('"t":"modq"');
      expect(text).not.toContain("SECRETLINE");
    }
    // The Stage did receive the game (stage view) the whole time.
    expect(stage.all.some((m) => m.t === "view")).toBe(true);
    expect(stage.conn.topics.has(`r:${code}:aud`)).toBe(false);
  });
});

describe("room actor: host commands and lifecycle", () => {
  function setup(
    extra: Record<string, unknown> = {},
    games: Parameters<typeof harness>[0]["games"] = { "quip-clash": partyGame() },
  ) {
    const h = harness({ games, actor: { timings: FAST } });
    const host = h.create({
      playlistMode: "fixed",
      streamDelaySec: 0,
      playlist: [{ gameId: "quip-clash", options: {} }],
      ...extra,
    });
    const code = host.room?.code as string;
    return { h, host, code };
  }

  it("start refuses an empty playlist and a running night; next walks every phase", async () => {
    const { h, host, code } = setup({ playlist: [] });
    h.host(host, { c: "start" });
    expect(host.take("error").at(-1)).toMatchObject({
      code: "ILLEGAL",
      msg: "the playlist is empty",
    });
    h.host(host, {
      c: "playlist.set",
      items: [
        { gameId: "quip-clash", options: {} },
        { gameId: "quip-clash", options: { roundSec: 10 } },
      ],
    });
    const a = h.join(code);
    h.join(code);
    h.host(host, { c: "next" }); // lobby → start
    await h.settle();
    host.pump();
    expect(host.room?.phase).toBe("intro");
    h.host(host, { c: "start" });
    expect(host.take("error").at(-1)?.code).toBe("ILLEGAL");
    h.host(host, { c: "next" }); // intro → game
    await h.settle();
    host.pump();
    expect(host.room?.phase).toBe("game");
    h.host(host, { c: "next" }); // game → forceAdvance → results
    await h.settle();
    host.pump();
    expect(host.room?.phase).toBe("results");
    h.host(host, { c: "next" }); // results → scoreboard
    await h.settle();
    host.pump();
    expect(host.room?.phase).toBe("scoreboard");
    h.host(host, { c: "next" }); // scoreboard → next intro
    await h.settle();
    host.pump();
    expect(host.room).toMatchObject({ phase: "intro", playlistIndex: 1 });
    for (const c of ["next", "next", "next", "next"]) h.host(host, { c });
    await h.settle();
    host.pump();
    expect(host.room?.phase).toBe("ended");
    h.host(host, { c: "next" });
    expect(host.take("error").at(-1)?.code).toBe("ILLEGAL");
    // A new night from the end starts over.
    h.host(host, { c: "start" });
    await h.settle();
    host.pump();
    expect(host.room).toMatchObject({ phase: "intro", playlistIndex: 0 });
    void a;
  });

  it("forceAdvance and endGame: endGame leaves Night Champion unchanged", async () => {
    const { h, host, code } = setup();
    h.join(code);
    h.join(code);
    h.host(host, { c: "forceAdvance" });
    expect(host.take("error").at(-1)?.code).toBe("ILLEGAL");
    h.host(host, { c: "start" });
    await h.advance(1_000, 100, [host]);
    h.host(host, { c: "endGame" });
    await h.settle();
    host.pump();
    expect(host.room?.phase).toBe("results");
    expect(host.room?.standings).toEqual([]);
    h.host(host, { c: "endGame" });
    expect(host.take("error").at(-1)?.code).toBe("ILLEGAL");
  });

  it("forceAdvance ends the round through the game's onHostCommand", async () => {
    const { h, host, code } = setup();
    h.join(code);
    h.join(code);
    h.host(host, { c: "start" });
    await h.advance(1_000, 100, [host]);
    h.host(host, { c: "forceAdvance" });
    await h.settle();
    host.pump();
    expect(host.room?.phase).toBe("results");
    expect(host.room?.standings.map((s) => s.points)).toEqual([10, 7]);
  });

  it("player actions are acked; illegal and out-of-game actions are refused", async () => {
    const { h, host, code } = setup();
    const a = h.join(code);
    h.join(code);
    a.send({ t: "act", id: 1, a: { type: "submit", text: "early" } });
    expect(a.take("ack").at(-1)).toMatchObject({ id: 1, ok: false, err: "ILLEGAL" });
    h.host(host, { c: "start" });
    await h.advance(1_000, 100);
    a.send({ t: "act", id: 2, a: { type: "bogus" } });
    expect(a.take("ack").at(-1)).toMatchObject({ id: 2, ok: false, err: "ILLEGAL" });
    a.send({ t: "act", id: 3, a: { type: "submit", text: "hi" } });
    expect(a.take("ack").at(-1)).toMatchObject({ id: 3, ok: true });
    a.send({ t: "act", id: 4, a: { type: "submit", text: "again" } });
    expect(a.take("ack").at(-1)).toMatchObject({ id: 4, ok: false, err: "ILLEGAL" });
    await h.settle();
    a.pump();
    expect((a.view as PartyView).you).toEqual({ id: a.id, note: "hi" });
    // private / fx / binary side channels reached the right sockets.
    const fxNames = a.all
      .filter((m): m is Extract<S2C, { t: "fx" }> => m.t === "fx")
      .flatMap((m) => m.events.map((e) => e.name));
    expect(fxNames).toContain("thanks");
    expect(fxNames).toContain("submitted");
    expect(fxNames).not.toContain("illegal");
    expect(a.binary.map((f) => [...f])).toContainEqual([0x03, 1]);
    host.pump();
    expect(host.binary.map((f) => [...f])).toContainEqual([0x02, 1]);
    expect(host.binary.map((f) => [...f])).not.toContainEqual([0x03, 1]);
    const hostFx = host.all
      .filter((m): m is Extract<S2C, { t: "fx" }> => m.t === "fx")
      .flatMap((m) => m.events.map((e) => e.name));
    expect(hostFx).not.toContain("thanks");
  });

  it("pause freezes the intro card; BRB fx and the snapshot flag go out", async () => {
    const { h, host, code } = setup();
    h.join(code);
    h.join(code);
    h.host(host, { c: "start" });
    await h.advance(400, 100, [host]);
    h.host(host, { c: "pause" });
    h.host(host, { c: "pause" }); // idempotent
    await h.advance(10_000, 1_000, [host]);
    expect(host.room).toMatchObject({ phase: "intro", paused: true });
    h.host(host, { c: "resume" });
    h.host(host, { c: "resume" });
    await h.advance(500, 100, [host]);
    expect(host.room?.phase).toBe("intro");
    await h.advance(200, 100, [host]);
    expect(host.room?.phase).toBe("game");
    const brb = host.all
      .filter((m): m is Extract<S2C, { t: "fx" }> => m.t === "fx")
      .flatMap((m) => m.events)
      .filter((e) => e.name === "brb");
    expect(brb.map((e) => (e.data as { on: boolean }).on)).toEqual([true, false]);
  });

  it("moderators may pause and resume; timerScale 0 waits for the host at the intro", async () => {
    const { h, host, code } = setup({ timerScale: 0 });
    h.join(code);
    h.join(code);
    const mod = h.join(code, { name: "Mod" });
    h.host(host, { c: "promote", id: mod.id, role: "moderator" });
    h.host(host, { c: "start" });
    await h.advance(20_000, 1_000, [host]);
    expect(host.room?.phase).toBe("intro");
    h.host(host, { c: "next" });
    await h.settle();
    mod.send({ t: "host", cmd: { c: "pause" } });
    await h.settle();
    host.pump();
    expect(host.room).toMatchObject({ phase: "game", paused: true });
    mod.send({ t: "host", cmd: { c: "resume" } });
    await h.settle();
    host.pump();
    expect(host.room?.paused).toBe(false);
    expect((host.view as PartyView).deadline).toBeNull();
  });

  it("kick removes a member; a kicked participant's seat is finished by a bot and earns nothing", async () => {
    const bans: string[] = [];
    const h = harness({
      games: { "quip-clash": partyGame() },
      actor: { timings: FAST, botDelayMs: 300, onBan: (_r, s) => bans.push(s.id) },
    });
    const host = h.create({
      playlistMode: "fixed",
      streamDelaySec: 0,
      playlist: [{ gameId: "quip-clash", options: {} }],
    });
    const code = host.room?.code as string;
    const a = h.join(code, { name: "A" });
    const b = h.join(code, { name: "B" });
    const c = h.join(code, { name: "C" });
    h.host(host, { c: "kick", id: "host" });
    expect(host.take("error").at(-1)?.code).toBe("NOT_ALLOWED");
    h.host(host, { c: "kick", id: "nobody" });
    expect(host.take("error").at(-1)?.code).toBe("ILLEGAL");
    h.host(host, { c: "start" });
    await h.advance(1_000, 100);
    h.host(host, { c: "kick", id: c.id, ban: true });
    expect(c.conn.closedWith).toEqual({ code: 4001, reason: "banned" });
    expect(bans).toEqual([c.id]);
    a.send({ t: "act", id: 1, a: { type: "submit", text: "a" } });
    b.send({ t: "act", id: 1, a: { type: "submit", text: "b" } });
    await h.advance(1_000, 100, [host]);
    expect(host.room?.phase).toBe("results");
    const ids = standings(host).map((r) => r.id);
    expect(ids).not.toContain(c.id);
    expect(ids.sort()).toEqual([a.id, b.id].sort());
    expect(host.room?.members.some((m) => m.id === c.id)).toBe(false);
  });

  it("promote moves members between audience, player and moderator (mid-game promotions wait for the boundary)", async () => {
    const { h, host, code } = setup({
      playlist: [
        { gameId: "quip-clash", options: {} },
        { gameId: "quip-clash", options: { roundSec: 9 } },
      ],
    });
    const a = h.join(code, { name: "A" });
    const b = h.join(code, { name: "B" });
    const c = h.join(code, { name: "C" });
    const v = h.join(code, { name: "V", want: "audience" });
    h.host(host, { c: "promote", id: v.id, role: "player" });
    await h.settle();
    v.pump();
    expect(v.room?.members.find((m) => m.id === v.id)).toMatchObject({ role: "player", seat: 3 });
    h.host(host, { c: "promote", id: v.id, role: "audience" });
    h.host(host, { c: "promote", id: "host", role: "audience" });
    expect(host.take("error").at(-1)?.code).toBe("NOT_ALLOWED");
    h.host(host, { c: "start" });
    await h.advance(1_000, 100);
    // Mid-game: an audience member promoted to player is seated at the next boundary.
    h.host(host, { c: "promote", id: v.id, role: "player" });
    expect(h.actor(code).pendingSeats).toEqual([v.id]);
    // A participant moved to the audience mid-game: a bot finishes their seat.
    h.host(host, { c: "promote", id: c.id, role: "audience" });
    expect(h.actor(code).runner?.isBot(c.id)).toBe(true);
    a.send({ t: "act", id: 1, a: { type: "submit", text: "a" } });
    b.send({ t: "act", id: 1, a: { type: "submit", text: "b" } });
    await h.advance(2_500, 100, [host]);
    expect(host.room?.phase).toBe("scoreboard");
    expect(host.room?.members.find((m) => m.id === v.id)?.role).toBe("player");
    expect(h.actor(code).pendingSeats).toEqual([]);
    h.host(host, { c: "promote", id: a.id, role: "moderator" });
    await h.settle();
    host.pump();
    expect(host.room?.members.find((m) => m.id === a.id)).toMatchObject({
      role: "moderator",
      seat: null,
    });
    h.host(host, { c: "promote", id: "ghost", role: "player" });
    expect(host.take("error").at(-1)?.code).toBe("ILLEGAL");
  });

  it("team.assign sets room teams; team games receive balanced teams", async () => {
    const { h, host, code } = setup(
      { teams: { mode: "host", count: 2 } },
      { "quip-clash": partyGame({ min: 2, max: 8, teamSupport: "optional" }) },
    );
    const ps = ["A", "B", "C", "D"].map((name) => h.join(code, { name }));
    h.host(host, { c: "team.assign", id: ps[0]?.id, teamId: "t2" });
    h.host(host, { c: "team.assign", id: ps[1]?.id, teamId: "t9" });
    expect(host.take("error").at(-1)?.code).toBe("ILLEGAL");
    h.host(host, { c: "team.assign", id: "zzz", teamId: "t1" });
    expect(host.take("error").at(-1)?.code).toBe("ILLEGAL");
    await h.settle();
    host.pump();
    expect(host.room?.teams.map((t) => t.name)).toEqual(["Tomato", "Sky"]);
    expect(host.room?.members.find((m) => m.id === ps[0]?.id)?.teamId).toBe("t2");
    h.host(host, { c: "start" });
    await h.advance(1_000, 100);
    const seats = h.actor(code).runner?.players ?? [];
    const count = (t: string): number => seats.filter((s) => s.teamId === t).length;
    expect(count("t1")).toBe(2);
    expect(count("t2")).toBe(2);
    expect(seats.find((s) => s.id === ps[0]?.id)?.teamId).toBe("t2");
    h.host(host, { c: "team.assign", id: ps[0]?.id, teamId: null });
    await h.settle();
    host.pump();
    expect(host.room?.members.find((m) => m.id === ps[0]?.id)?.teamId).toBeUndefined();
  });

  it("team rankings award every member of the team", async () => {
    const teamGame = partyGame({ min: 2, max: 8, teamSupport: "required" }) as GameModule<
      { players: { id: string; teamId?: string }[] },
      unknown,
      unknown,
      unknown
    >;
    const g: AnyGameModule = {
      ...teamGame,
      onHostCommand(state, cmd, ctx) {
        const players = (state as { players: { id: string; teamId?: string }[] }).players;
        const teams = [...new Set(players.map((p) => p.teamId ?? ""))].sort();
        void cmd;
        void ctx;
        return {
          state,
          effects: [
            {
              type: "end",
              result: { ranking: teams.map((id, i) => ({ id, score: 9 - i, place: i + 1 })) },
            },
          ],
        };
      },
    };
    const { h, host, code } = setup({}, { "quip-clash": g });
    const ps = ["A", "B", "C", "D"].map((name) => h.join(code, { name }));
    h.host(host, { c: "start" });
    await h.advance(1_000, 100);
    h.host(host, { c: "forceAdvance" });
    await h.settle();
    host.pump();
    const seats = h.actor(code).runner?.players ?? [];
    const pts = new Map(standings(host).map((r) => [r.id, r.points]));
    for (const p of ps) {
      const team = seats.find((s) => s.id === p.id)?.teamId;
      expect(pts.get(p.id)).toBe(team === "t1" ? 10 : 7);
    }
  });

  it("transferHost hands the Stage to another member; the old host becomes a moderator", async () => {
    const { h, host, code } = setup();
    const a = h.join(code, { name: "A" });
    const panel = h.join(code, { token: host.token, want: "moderator" });
    panel.send({ t: "host", cmd: { c: "transferHost", id: "nobody" } });
    expect(panel.take("error").at(-1)?.code).toBe("ILLEGAL");
    h.host(host, { c: "transferHost", id: a.id });
    await h.settle();
    host.pump();
    expect(host.room?.hostId).toBe(a.id);
    expect(host.room?.members.find((m) => m.id === a.id)).toMatchObject({
      role: "host",
      seat: null,
    });
    expect(host.room?.members.find((m) => m.id === "host")?.role).toBe("moderator");
    // The new host can run the room; the old one cannot start it any more.
    host.send({ t: "host", cmd: { c: "start" } });
    expect(host.take("error").at(-1)?.code).toBe("NOT_ALLOWED");
    a.send({ t: "host", cmd: { c: "fillBots", on: true } });
    a.send({ t: "host", cmd: { c: "start" } });
    await h.settle();
    a.pump();
    expect(a.room?.phase).toBe("intro");
  });

  it("fillBots fills seats up to minPlayers with bots that never reach the standings; otherwise the game waits and a second next skips it", async () => {
    const { h, host, code } = setup(
      {
        playlist: [
          { gameId: "quip-clash", options: {} },
          { gameId: "ludo", options: {} },
        ],
      },
      {
        "quip-clash": partyGame({ min: 3, max: 8 }),
        ludo: partyGame({ id: "ludo", min: 2, max: 4 }),
      },
    );
    const a = h.join(code, { name: "A" });
    h.host(host, { c: "start" });
    expect(host.take("error").at(-1)?.msg).toMatch(/needs at least 3 players/);
    h.host(host, { c: "fillBots", on: true });
    h.host(host, { c: "start" });
    await h.settle();
    host.pump();
    expect(host.room?.phase).toBe("intro");
    const bots = host.room?.members.filter((m) => m.bot === true) ?? [];
    expect(bots.map((m) => m.name)).toEqual(["Bot 1", "Bot 2"]);
    await h.advance(1_000, 100);
    a.send({ t: "act", id: 1, a: { type: "submit", text: "me" } });
    await h.advance(3_000, 100, [host]);
    expect(host.room?.phase === "results" || host.room?.phase === "scoreboard").toBe(true);
    expect(standings(host).map((r) => r.id)).toEqual([a.id]);
    // Next game needs 2: turn bots off → it waits; second next skips it.
    h.host(host, { c: "fillBots", on: false });
    await h.advance(3_000, 100, [host]);
    expect(host.room?.phase).toBe("scoreboard");
    expect(host.take("error").at(-1)?.msg).toMatch(/needs at least 2 players/);
    h.host(host, { c: "next" });
    await h.settle();
    host.pump();
    expect(host.room?.phase).toBe("ended");
    expect(h.actor(code).played).toEqual([0, 1]);
  });

  it("bench hand-picks who sits out the next game (and re-picks during the intro)", async () => {
    const { h, host, code } = setup({}, { "quip-clash": partyGame({ min: 2, max: 3 }) });
    const ps = ["A", "B", "C", "D", "E"].map((name) => h.join(code, { name }));
    h.host(host, { c: "bench", ids: ["nobody"] });
    expect(host.take("error").at(-1)?.code).toBe("ILLEGAL");
    h.host(host, { c: "bench", ids: [ps[0]?.id, ps[1]?.id] });
    h.host(host, { c: "start" });
    await h.settle();
    const actor = h.actor(code);
    expect(actor.participants.sort()).toEqual([ps[2]?.id, ps[3]?.id, ps[4]?.id].sort());
    h.host(host, { c: "bench", ids: [ps[4]?.id, ps[3]?.id] });
    await h.settle();
    expect(actor.participants).toContain(ps[0]?.id);
    expect(actor.participants).toContain(ps[1]?.id);
    expect(actor.benched.sort()).toEqual([ps[3]?.id, ps[4]?.id].sort());
    h.host(host, { c: "bench", ids: [ps[0]?.id, ps[1]?.id, ps[2]?.id, ps[3]?.id] });
    expect(host.take("error").at(-1)?.msg).toMatch(/too few players/);
  });

  it("queued audience members fill free seats at the next game boundary (fifo)", async () => {
    const { h, host, code } = setup({
      maxPlayers: 3,
      lateJoin: "queue",
      playlist: [
        { gameId: "quip-clash", options: {} },
        { gameId: "quip-clash", options: { roundSec: 6 } },
      ],
    });
    const a = h.join(code, { name: "A" });
    h.join(code, { name: "B" });
    h.host(host, { c: "start" });
    await h.advance(1_000, 100);
    const late1 = h.join(code, { name: "Late1" }); // mid-game: audience, queued
    const late2 = h.join(code, { name: "Late2" });
    late2.send({ t: "queue", join: true });
    expect(late1.welcome?.you.role).toBe("audience");
    h.host(host, { c: "forceAdvance" });
    await h.advance(2_000, 100, [host]);
    // Boundary: one free seat (maxPlayers 3) goes to the longest-waiting member.
    expect(host.room?.phase).toBe("intro");
    const players = host.room?.members.filter((m) => m.role === "player").map((m) => m.id) ?? [];
    expect(players).toContain(late1.id);
    expect(players).not.toContain(late2.id);
    void a;
  });

  it("playlist.set keeps played entries played", async () => {
    const { h, host, code } = setup(
      {
        playlist: [
          { gameId: "quip-clash", options: {} },
          { gameId: "tune-in", options: {} },
        ],
      },
      { "quip-clash": partyGame(), "tune-in": partyGame({ id: "tune-in" }) },
    );
    h.join(code);
    h.join(code);
    h.host(host, { c: "start" });
    await h.advance(1_000, 100);
    h.host(host, { c: "forceAdvance" });
    await h.settle();
    h.host(host, {
      c: "playlist.set",
      items: [
        { gameId: "doodle", options: {} },
        { gameId: "tune-in", options: {} },
        { gameId: "quip-clash", options: {} },
      ],
    });
    await h.settle();
    expect(h.actor(code).played).toEqual([2]);
    host.pump();
    expect(host.room?.playlistIndex).toBe(2);
  });

  it("an unavailable game is refused with the reason", async () => {
    const { h, host, code } = setup({ playlist: [{ gameId: "chess", options: {} }] });
    h.join(code);
    h.join(code);
    h.host(host, { c: "start" });
    expect(host.take("error").at(-1)?.msg).toMatch(/chess is not available/);
  });

  it("a reconnecting participant takes the seat back from the bot", async () => {
    const h = harness({
      games: { "quip-clash": partyGame() },
      actor: { timings: FAST, botDelayMs: 60_000 },
    });
    const host = h.create({
      playlistMode: "fixed",
      streamDelaySec: 0,
      reconnectGraceSec: 1,
      playlist: [{ gameId: "quip-clash", options: {} }],
    });
    const code = host.room?.code as string;
    const a = h.join(code);
    h.join(code);
    h.host(host, { c: "start" });
    await h.advance(1_000, 100);
    const token = a.token;
    a.close();
    await h.advance(1_500, 100, [host]);
    expect(host.room?.members.find((m) => m.id === a.id)?.bot).toBe(true);
    const back = h.join(code, { token });
    expect(back.id).toBe(a.id);
    await h.settle();
    back.pump();
    host.pump();
    expect(h.actor(code).runner?.isBot(a.id)).toBe(false);
    expect(host.room?.members.find((m) => m.id === a.id)?.bot).toBeUndefined();
    expect((back.view as PartyView).you?.id).toBe(a.id);
    back.send({ t: "act", id: 9, a: { type: "submit", text: "back" } });
    expect(back.take("ack").at(-1)?.ok).toBe(true);
  });

  it("an abandoned seat is released when the game ends", async () => {
    const h = harness({
      games: { "quip-clash": partyGame() },
      actor: { timings: FAST, botDelayMs: 100 },
    });
    const host = h.create({
      playlistMode: "fixed",
      streamDelaySec: 0,
      reconnectGraceSec: 1,
      playlist: [{ gameId: "quip-clash", options: {} }],
    });
    const code = host.room?.code as string;
    const a = h.join(code);
    const b = h.join(code);
    h.host(host, { c: "start" });
    await h.advance(1_000, 100);
    a.close();
    await h.advance(1_300, 100);
    b.send({ t: "act", id: 1, a: { type: "submit", text: "b" } });
    await h.advance(200, 100, [host]);
    expect(host.room?.phase).toBe("results");
    expect(host.room?.members.some((m) => m.id === a.id)).toBe(false);
    // The bot's seat still scored nothing for anyone but real players: a keeps its points.
    expect(standings(host).map((r) => r.id)).toContain(b.id);
  });
});

describe("room actor: moderation, audience, snapshots, restore", () => {
  it("review-wait timeout: a moderation item pending for 20 s resolves as rejected", async () => {
    const h = harness({
      games: { "quip-clash": partyGame({ roundSec: 120 }) },
      actor: { timings: FAST },
    });
    const host = h.create({
      playlistMode: "fixed",
      streamDelaySec: 0,
      moderation: "reveal-review",
      playlist: [{ gameId: "quip-clash", options: {} }],
    });
    const code = host.room?.code as string;
    const panel = h.join(code, { token: host.token, want: "moderator" });
    const ps = [h.join(code), h.join(code), h.join(code)];
    h.host(host, { c: "start" });
    await h.advance(1_000, 100);
    ps[0]?.send({ t: "act", id: 1, a: { type: "submit", text: "wait for me" } });
    ps[1]?.send({ t: "act", id: 1, a: { type: "submit", text: "approve me" } });
    await h.settle();
    const q = panel.take("modq").at(-1)?.items ?? [];
    expect(q.map((i) => i.preview)).toEqual(["wait for me", "approve me"]);
    expect(q[0]?.expiresAt).toBe((q[0]?.createdAt ?? 0) + 20_000);
    panel.send({ t: "mod", cmd: { c: "approve", itemId: `note-${ps[1]?.id}` } });
    panel.send({ t: "mod", cmd: { c: "reject", itemId: "nope" } });
    expect(panel.take("error").at(-1)?.code).toBe("ILLEGAL");
    await h.advance(19_800, 200, [host]);
    let mod = (host.view as PartyView).moderation;
    expect(mod[`note-${ps[0]?.id}`]).toBe("pending");
    expect(mod[`note-${ps[1]?.id}`]).toBe("approved");
    // Paused time does not count toward the timeout.
    h.host(host, { c: "pause" });
    await h.advance(60_000, 5_000, [host]);
    expect((host.view as PartyView).moderation[`note-${ps[0]?.id}`]).toBe("pending");
    h.host(host, { c: "resume" });
    await h.advance(400, 100, [host]);
    mod = (host.view as PartyView).moderation;
    expect(mod[`note-${ps[0]?.id}`]).toBe("rejected");
    expect(h.actor(code).moderationQueue).toEqual([]);
    expect(panel.take("modq").at(-1)?.items).toEqual([]);
    // mute/rename need the production moderation port (moderation.ts, see moderation.test.ts).
    panel.send({ t: "mod", cmd: { c: "mute", id: "x", minutes: 1 } });
    expect(panel.take("error").at(-1)?.msg).toMatch(/moderation port/);
  });

  it("with moderation off, items are approved at once", async () => {
    const h = harness({ games: { "quip-clash": partyGame() }, actor: { timings: FAST } });
    const host = h.create({
      playlistMode: "fixed",
      streamDelaySec: 0,
      playlist: [{ gameId: "quip-clash", options: {} }],
    });
    const code = host.room?.code as string;
    const ps = [h.join(code), h.join(code), h.join(code)];
    h.host(host, { c: "start" });
    await h.advance(1_000, 100);
    ps[0]?.send({ t: "act", id: 1, a: { type: "submit", text: "fine" } });
    await h.settle();
    host.pump();
    expect((host.view as PartyView).moderation[`note-${ps[0]?.id}`]).toBe("approved");
  });

  it("game polls reach the audience and their results reach the game", async () => {
    const h = harness({
      games: { "quip-clash": partyGame({ revealMs: 8_000 }) },
      actor: { timings: FAST },
    });
    const host = h.create({
      playlistMode: "fixed",
      streamDelaySec: 0,
      playlist: [{ gameId: "quip-clash", options: {} }],
    });
    const code = host.room?.code as string;
    const ps = [h.join(code), h.join(code)];
    const aud = [0, 1, 2].map((i) => h.join(code, { want: "audience", ip: `10.3.0.${i}` }));
    h.host(host, { c: "start" });
    await h.advance(1_000, 100, aud);
    const poll = aud[0]?.take("poll").at(-1)?.poll;
    expect(poll?.pollId).toBe("chat");
    for (const c of aud) c.send({ t: "aud", pollId: "chat", choice: ps[0]?.id as string });
    aud[0]?.send({ t: "aud", pollId: "chat", choice: "not-an-option" });
    await h.advance(300, 100, aud);
    expect(aud[0]?.take("tally").at(-1)).toMatchObject({ pollId: "chat", total: 3 });
    for (const p of ps) p.send({ t: "act", id: 1, a: { type: "submit", text: "x" } });
    await h.settle();
    // The early close is held by the minimum audience window (streamDelay 0 + 5 s after open).
    aud[1]?.pump();
    expect(aud[1]?.take("pollEnd")).toEqual([]);
    // Opened at +1.0 s, submitted at +1.3 s: still held at +5.9 s, closed by +6.1 s.
    await h.advance(4_600, 100, aud);
    expect(aud[1]?.take("pollEnd")).toEqual([]);
    await h.advance(200, 100, aud);
    const end = aud[1]?.take("pollEnd").at(-1);
    expect(end?.result.tallies[ps[0]?.id as string]).toBe(3);
    // The game got the aggregate (the view counts 3 voters).
    host.pump();
    expect((host.view as PartyView).chatTotal).toBe(3);
  });

  it("snapshots are written every 20 actions or every 10 s", async () => {
    const saves: RoomRecord[] = [];
    const h = harness({
      games: { "quip-clash": partyGame({ max: 8 }) },
      actor: { timings: { ...FAST, snapshotEveryActions: 20, snapshotIntervalMs: 10_000 } },
    });
    // Count the actor's snapshot writes (membership changes also persist through the manager).
    const persistNow = h.manager.persistNow.bind(h.manager);
    h.manager.persistNow = (room) => {
      persistNow(room);
      const r = h.store.loadRoom(room.code);
      if (r !== null) saves.push(r);
    };
    const host = h.create({
      playlistMode: "fixed",
      streamDelaySec: 0,
      playlist: [{ gameId: "quip-clash", options: { roundSec: 120 } }],
    });
    const code = host.room?.code as string;
    const ps = [h.join(code), h.join(code), h.join(code)];
    h.host(host, { c: "start" });
    await h.advance(1_000, 100);
    const actorSaves = (): number =>
      saves.filter(
        (r) =>
          ((r.actor as { current: { runner: unknown } | null }).current?.runner ?? null) !== null,
      ).length;
    // The game started (the intro→game change counts), then 10 s pass with no change → 1 write.
    const base = actorSaves();
    // 19 illegal actions (duplicates) do not trigger the 20-action write…
    ps[0]?.send({ t: "act", id: 0, a: { type: "submit", text: "a" } });
    for (let i = 1; i < 19; i++)
      ps[0]?.send({ t: "act", id: i, a: { type: "submit", text: "dup" } });
    await h.settle();
    expect(actorSaves()).toBe(base);
    // …the 20th does.
    ps[1]?.send({ t: "act", id: 20, a: { type: "submit", text: "b" } });
    await h.settle();
    expect(actorSaves()).toBe(base + 1);
    const snap = saves.at(-1)?.actor as { current: { runner: { state: string } } };
    expect(JSON.parse(snap.current.runner.state).order).toHaveLength(2);
    // Time-based: changes, then 10 s later a write.
    h.host(host, { c: "pause" });
    await h.advance(10_000, 1_000);
    expect(actorSaves()).toBe(base + 2);
    await h.advance(10_000, 1_000);
    expect(actorSaves()).toBe(base + 2); // nothing changed: no write
    void ps[2];
  });

  it("a room restored from its snapshot continues the running game", async () => {
    const store = new MemoryStore();
    const games = { "quip-clash": partyGame({ roundSec: 120 }) };
    const h1 = harness({ games, store, actor: { timings: FAST } });
    const host = h1.create({
      playlistMode: "fixed",
      streamDelaySec: 0,
      playlist: [{ gameId: "quip-clash", options: {} }],
    });
    const code = host.room?.code as string;
    const ps = [h1.join(code), h1.join(code), h1.join(code)];
    h1.host(host, { c: "start" });
    await h1.advance(1_000, 100);
    ps[0]?.send({ t: "act", id: 1, a: { type: "submit", text: "before crash" } });
    await h1.settle();
    h1.manager.persistNow(h1.room(code));
    const tokens = ps.map((p) => p.token);
    h1.shutdown();

    const h2 = harness({ games, store, actor: { timings: FAST } });
    expect(h2.manager.restoreFromStore()).toBe(1);
    const back = tokens.map((token) => h2.join(code, { token }));
    await h2.settle();
    for (const b of back) b.pump();
    expect((back[0]?.view as PartyView).submitted).toEqual([ps[0]?.id]);
    expect((back[0]?.view as PartyView).you?.note).toBe("before crash");
    back[1]?.send({ t: "act", id: 1, a: { type: "submit", text: "after" } });
    back[2]?.send({ t: "act", id: 1, a: { type: "submit", text: "after" } });
    await h2.settle();
    const room = h2.room(code);
    expect(room.phase).toBe("results");
    expect(
      (room.driver as unknown as { scoreboard: { standings(): unknown[] } }).scoreboard.standings(),
    ).toHaveLength(3);
  });

  it("resync returns the full view at the stream's current seq", async () => {
    const h = harness({ games: { "quip-clash": partyGame() }, actor: { timings: FAST } });
    const host = h.create({
      playlistMode: "fixed",
      streamDelaySec: 0,
      playlist: [{ gameId: "quip-clash", options: {} }],
    });
    const code = host.room?.code as string;
    const a = h.join(code);
    const b = h.join(code);
    h.join(code);
    h.host(host, { c: "start" });
    await h.advance(1_000, 100, [a]);
    b.send({ t: "act", id: 1, a: { type: "submit", text: "x" } });
    await h.settle();
    a.pump();
    const seq = a.viewSeq;
    a.take("view");
    a.send({ t: "resync", lastSeq: 0 });
    const full = a.take("view").at(-1);
    expect(full?.seq).toBe(seq);
    expect(full?.full).toEqual(a.view);
  });

  it("anti-snipe: audience sharing a participant's IP gets the restricted view by direct send", async () => {
    let restrictedViews = 0;
    const base = partyGame() as GameModule<unknown, unknown, unknown, unknown>;
    const spy: AnyGameModule = {
      ...base,
      view(state, viewer) {
        if (viewer.role === "audience" && viewer.restricted === true) restrictedViews++;
        return base.view(state, viewer);
      },
    };
    const h = harness({ games: { "quip-clash": spy }, actor: { timings: FAST } });
    const host = h.create({
      playlistMode: "fixed",
      streamDelaySec: 0,
      playlist: [{ gameId: "quip-clash", options: {} }],
    });
    const code = host.room?.code as string;
    h.join(code, { ip: "192.168.1.5" });
    h.join(code, { ip: "192.168.1.6" });
    const sniper = h.join(code, { want: "audience", ip: "192.168.1.5" });
    const fair = h.join(code, { want: "audience", ip: "172.16.0.1" });
    h.host(host, { c: "start" });
    await h.advance(1_000, 100, [sniper, fair]);
    expect(sniper.conn.topics.has(`r:${code}:aud`)).toBe(false);
    expect(fair.conn.topics.has(`r:${code}:aud`)).toBe(true);
    expect(sniper.view).not.toBeNull();
    expect(restrictedViews).toBeGreaterThan(0);
    // A late sniper is restricted on join too; turning antiSnipe off lifts it.
    const late = h.join(code, { want: "audience", ip: "192.168.1.6" });
    expect(late.conn.topics.has(`r:${code}:aud`)).toBe(false);
    h.host(host, { c: "config", patch: { antiSnipe: false } });
    await h.settle();
    expect(late.conn.topics.has(`r:${code}:aud`)).toBe(true);
  });
});
