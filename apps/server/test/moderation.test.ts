/**
 * Moderation & safety (ROADMAP M1-04, SPEC §9.7) through the real RoomManager + room actor on
 * a fake clock. Each ROADMAP Accept bullet has a test named after it.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { AnyGameModule } from "@sg/engine";
import {
  actionText,
  BanList,
  createModeration,
  GameRegistry,
  PackLibrary,
  type Moderation,
  type ModerationFactory,
  type RoomActorOptions,
} from "../src/index.ts";
import { partyGame, type PartyView } from "./fixtures/party.ts";
import { RoomHarness, type FakeClient } from "./room-harness.ts";
import { startServer, Client } from "./helpers.ts";

const FAST = { introMs: 1_000, resultsMs: 1_000, scoreboardMs: 1_000 };
const harnesses: RoomHarness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.shutdown();
});

/** A harness wired like `createServer`: Moderation port, ban list, ban guard. */
function rig(
  game: AnyGameModule = partyGame({ roundSec: 120 }),
  actor: Partial<RoomActorOptions> = {},
) {
  const bans = new BanList();
  let port: Moderation | null = null;
  const base = createModeration({ bans });
  const moderation: ModerationFactory = (ctx, ms) => {
    port = base(ctx, ms) as Moderation;
    return port;
  };
  const h = new RoomHarness({
    games: { "quip-clash": game },
    actor: { timings: FAST, moderation, onBan: (room, s) => bans.ban(room, s), ...actor },
  });
  h.manager.addGuard(bans.guard);
  harnesses.push(h);
  return {
    h,
    bans,
    port: (): Moderation => {
      if (port === null) throw new Error("no room yet");
      return port;
    },
  };
}

function room(h: RoomHarness, config: Record<string, unknown> = {}) {
  const host = h.create({
    playlistMode: "fixed",
    streamDelaySec: 0,
    playlist: [{ gameId: "quip-clash", options: {} }],
    ...config,
  });
  return { host, code: host.room?.code as string };
}

function nameOf(c: FakeClient, id: string): string | undefined {
  c.pump();
  return c.room?.members.find((m) => m.id === id)?.name;
}

describe("M1-04 moderation & safety", () => {
  it("family mode masks bad text in names and answers", async () => {
    const { h } = rig();
    const { host, code } = room(h, { contentFilter: "family", moderation: "reveal-review" });
    const panel = h.join(code, { token: host.token, want: "moderator" });
    const a = h.join(code, { name: "fuckface" });
    const b = h.join(code, { name: "Bea" });
    h.join(code, { name: "Cy" });
    await h.settle();
    expect(nameOf(host, a.id)).not.toMatch(/fuck/i);
    expect(nameOf(host, a.id)).toContain("*");
    expect(nameOf(host, b.id)).toBe("Bea");

    h.host(host, { c: "start" });
    await h.advance(1_000, 100);
    a.send({ t: "act", id: 1, a: { type: "submit", text: "what the fuck" } });
    b.send({ t: "act", id: 2, a: { type: "submit", text: "a clean line" } });
    await h.settle();
    expect(a.take("ack").at(-1)).toEqual({ t: "ack", id: 1, ok: true });
    // The game only ever saw the masked text: the owner's own view, the review queue, every frame.
    expect((a.view as PartyView).you?.note).toBe("what the ****");
    const q = panel.take("modq").at(-1)?.items ?? [];
    expect(q.map((i) => i.preview)).toEqual(["what the ****", "a clean line"]);
    for (const c of [host, panel, a, b]) expect(c.rawText()).not.toMatch(/what the fuck/);

    // Renames are filtered too.
    panel.send({ t: "mod", cmd: { c: "rename", id: b.id, name: "  shit  head " } });
    await h.settle();
    expect(nameOf(host, b.id)).toBe("**** head");
  });

  it("standard mode passes text unchanged (the Stage blurs flagged text itself)", async () => {
    const { h } = rig();
    const { host, code } = room(h);
    const a = h.join(code, { name: "fuckface" });
    h.join(code);
    await h.settle();
    expect(nameOf(host, a.id)).toBe("fuckface");
    h.host(host, { c: "start" });
    await h.advance(1_000, 100);
    a.send({ t: "act", id: 1, a: { type: "submit", text: "what the fuck" } });
    await h.settle();
    a.pump();
    expect((a.view as PartyView).you?.note).toBe("what the fuck");
  });

  it("with reveal-review, onModeration is withheld until a moderator approves, and the stage view shows the item as pending", async () => {
    const calls: { itemId: string; approved: boolean }[] = [];
    const base = partyGame({ roundSec: 120 });
    const inner = base.onModeration?.bind(base);
    const spied: AnyGameModule = {
      ...base,
      onModeration(state, itemId, approved, ctx) {
        calls.push({ itemId, approved });
        return inner === undefined ? { state } : inner(state, itemId, approved, ctx);
      },
    };
    const { h } = rig(spied);
    const { host, code } = room(h, { moderation: "reveal-review" });
    const panel = h.join(code, { token: host.token, want: "moderator" });
    const mod = h.join(code, { name: "Mod", want: "audience" });
    h.host(host, { c: "promote", id: mod.id, role: "moderator" });
    const a = h.join(code);
    const b = h.join(code);
    h.join(code);
    h.host(host, { c: "start" });
    await h.advance(1_000, 100);
    a.send({ t: "act", id: 1, a: { type: "submit", text: "SECRET-unreviewed-line" } });
    b.send({ t: "act", id: 1, a: { type: "submit", text: "second line" } });
    await h.advance(5_000, 500, [host]);

    const itemA = `note-${a.id}`;
    const itemB = `note-${b.id}`;
    expect(calls).toEqual([]);
    expect((host.view as PartyView).moderation).toEqual({ [itemA]: "pending", [itemB]: "pending" });
    expect(
      mod
        .take("modq")
        .at(-1)
        ?.items.map((i) => i.itemId),
    ).toEqual([itemA, itemB]);
    expect(panel.take("modq").at(-1)?.items).toHaveLength(2);

    mod.send({ t: "mod", cmd: { c: "approve", itemId: itemA } });
    await h.settle();
    host.pump();
    expect(calls).toEqual([{ itemId: itemA, approved: true }]);
    expect((host.view as PartyView).moderation[itemA]).toBe("approved");
    expect((host.view as PartyView).moderation[itemB]).toBe("pending");
    panel.send({ t: "mod", cmd: { c: "reject", itemId: itemB } });
    await h.settle();
    host.pump();
    expect(calls).toEqual([
      { itemId: itemA, approved: true },
      { itemId: itemB, approved: false },
    ]);
    expect((host.view as PartyView).moderation[itemB]).toBe("rejected");
    // The captured Stage never received the queue or the unreviewed text.
    expect(host.rawText()).not.toContain('"t":"modq"');
    expect(host.rawText()).not.toContain("SECRET-unreviewed-line");
  });

  it("a banned token or IP hash cannot rejoin", async () => {
    const { h, bans } = rig();
    const { host, code } = room(h);
    const bad = h.join(code, { name: "Troll", ip: "10.9.9.9" });
    const token = bad.token;
    const kicked = h.join(code, { name: "Kicked", ip: "10.8.8.8" });
    h.join(code, { ip: "10.1.1.2" });
    h.host(host, { c: "kick", id: bad.id, ban: true });
    h.host(host, { c: "kick", id: kicked.id });
    expect(bad.conn.closedWith).toEqual({ code: 4001, reason: "banned" });
    expect(bans.isBanned(h.room(code), { token })).toBe(true);

    // Same token from a new IP.
    const byToken = h.join(code, { token, ip: "10.7.7.7" });
    expect(byToken.take("error").at(-1)?.code).toBe("BANNED");
    expect(byToken.welcome).toBeNull();
    expect(byToken.conn.closedWith?.reason).toBe("banned");
    // Same IP with a fresh identity, as a player or as audience.
    for (const want of ["player", "audience", "moderator"] as const) {
      const byIp = h.join(code, { ip: "10.9.9.9", want });
      expect(byIp.take("error").at(-1)?.code).toBe("BANNED");
      expect(byIp.welcome).toBeNull();
    }
    // A plain kick is not a ban, and other IPs are unaffected.
    expect(h.join(code, { ip: "10.8.8.8" }).welcome).not.toBeNull();
    expect(h.join(code, { ip: "10.5.5.5" }).welcome).not.toBeNull();
    expect(host.room?.members.some((m) => m.name === "Troll")).toBe(false);

    // Bans belong to the room instance and are dropped with it.
    expect(bans.roomCount).toBe(1);
    h.shutdown();
    expect(bans.roomCount).toBe(0);
  });

  it("a muted player's text actions return MUTED", async () => {
    const { h, port } = rig();
    const { host, code } = room(h);
    const panel = h.join(code, { token: host.token, want: "moderator" });
    const mod = h.join(code, { name: "Mod", want: "audience" });
    h.host(host, { c: "promote", id: mod.id, role: "moderator" });
    const a = h.join(code);
    const b = h.join(code);
    h.join(code);
    h.host(host, { c: "start" });
    await h.advance(1_000, 100);

    mod.send({ t: "mod", cmd: { c: "mute", id: a.id, minutes: 1 } });
    expect(mod.take("error")).toEqual([]);
    expect(a.take("fx").flatMap((f) => f.events.map((e) => e.name))).toContain("muted");
    expect(port().mutedUntil(a.id)).toBe(h.clock.now() + 60_000);

    a.send({ t: "act", id: 7, a: { type: "submit", text: "let me talk" } });
    expect(a.take("ack").at(-1)).toEqual({ t: "ack", id: 7, ok: false, err: "MUTED" });
    // Non-text actions are not muted (they reach the game, which judges them).
    a.send({ t: "act", id: 8, a: { type: "nudge" } });
    expect(a.take("ack").at(-1)).toEqual({ t: "ack", id: 8, ok: false, err: "ILLEGAL" });
    expect((host.view as PartyView | null)?.submitted ?? []).not.toContain(a.id);

    // The mute runs out; minutes 0 lifts one early.
    mod.send({ t: "mod", cmd: { c: "mute", id: b.id, minutes: 5 } });
    b.send({ t: "act", id: 1, a: { type: "submit", text: "hi" } });
    expect(b.take("ack").at(-1)?.err).toBe("MUTED");
    panel.send({ t: "mod", cmd: { c: "mute", id: b.id, minutes: 0 } });
    expect(b.take("fx").flatMap((f) => f.events.map((e) => e.name))).toContain("unmuted");
    b.send({ t: "act", id: 2, a: { type: "submit", text: "hi" } });
    expect(b.take("ack").at(-1)).toEqual({ t: "ack", id: 2, ok: true });

    await h.advance(60_000, 10_000);
    expect(port().mutedUntil(a.id)).toBeNull();
    a.send({ t: "act", id: 9, a: { type: "submit", text: "back again" } });
    expect(a.take("ack").at(-1)).toEqual({ t: "ack", id: 9, ok: true });

    // Permissions: nobody mutes the host; only the host mutes a moderator; unknown ids are illegal.
    mod.send({ t: "mod", cmd: { c: "mute", id: "host", minutes: 1 } });
    expect(mod.take("error").at(-1)?.code).toBe("NOT_ALLOWED");
    mod.send({ t: "mod", cmd: { c: "mute", id: mod.id, minutes: 1 } });
    expect(mod.take("error").at(-1)?.code).toBe("NOT_ALLOWED");
    mod.send({ t: "mod", cmd: { c: "rename", id: "nobody", name: "x" } });
    expect(mod.take("error").at(-1)?.code).toBe("ILLEGAL");
    // Players cannot moderate at all (session gate).
    a.send({ t: "mod", cmd: { c: "mute", id: b.id, minutes: 1 } });
    expect(a.take("error").at(-1)?.code).toBe("NOT_ALLOWED");
    panel.send({ t: "mod", cmd: { c: "mute", id: mod.id, minutes: 1 } });
    expect(panel.take("error")).toEqual([]);
  });

  it("rename cleans the name and rebroadcasts the room", async () => {
    const { h } = rig();
    const { host, code } = room(h);
    const a = h.join(code, { name: "Old" });
    host.send({ t: "mod", cmd: { c: "rename", id: a.id, name: "  New‮ Name  " } });
    await h.settle();
    expect(nameOf(a, a.id)).toBe("New Name");
    host.send({ t: "mod", cmd: { c: "rename", id: a.id, name: "‎" } });
    expect(host.take("error").at(-1)?.code).toBe("ILLEGAL");
  });
});

describe("M1-04 units", () => {
  it("actionText finds only a top-level string `text` field", () => {
    expect(actionText({ type: "answer", promptId: "p", text: "hey" })).toBe("hey");
    expect(actionText({ type: "guess", option: "a" })).toBeNull();
    expect(actionText({ text: 3 })).toBeNull();
    expect(actionText(["text"])).toBeNull();
    expect(actionText("text")).toBeNull();
    expect(actionText(null)).toBeNull();
  });

  it("BanList keys bans by room instance (a re-issued code starts clean)", () => {
    const bans = new BanList();
    const r1 = { code: "ABCD", epoch: 1 };
    bans.banKeys(r1, { token: "t", ipHash: "h", twitchId: "tw" });
    expect(bans.isBanned(r1, { token: "t" })).toBe(true);
    expect(bans.isBanned(r1, { ipHash: "h" })).toBe(true);
    expect(bans.isBanned(r1, { twitchId: "tw" })).toBe(true);
    expect(bans.isBanned(r1, { token: "other", ipHash: "other" })).toBe(false);
    expect(bans.isBanned({ code: "ABCD", epoch: 2 }, { token: "t", ipHash: "h" })).toBe(false);
    expect(bans.isBanned({ code: "WXYZ", epoch: 1 }, { token: "t" })).toBe(false);
    bans.banKeys(r1, { token: "" });
    expect(bans.isBanned(r1, { token: "" })).toBe(false);
    bans.forget(r1);
    expect(bans.isBanned(r1, { token: "t" })).toBe(false);
  });
});

describe("M1-04 createServer wiring", () => {
  it("the production server installs the ban guard and the moderation port", async () => {
    const server = await startServer(
      "ws",
      {},
      {
        games: new GameRegistry({ "quip-clash": partyGame() }, {}),
        packs: PackLibrary.empty(),
        restore: false,
      },
    );
    const clients: Client[] = [];
    try {
      const host = await Client.connect(server.url);
      clients.push(host);
      host.send({ t: "create", v: 1, name: "Host", config: {} });
      const welcome = await host.next("welcome");
      const code = welcome.room.code;
      const p = await Client.connect(server.url);
      clients.push(p);
      p.send({ t: "hello", v: 1, code, want: "player", name: "P" });
      const pw = await p.next("welcome");
      host.send({ t: "mod", cmd: { c: "mute", id: pw.you.id, minutes: 1 } });
      host.send({ t: "mod", cmd: { c: "rename", id: pw.you.id, name: "Renamed" } });
      await host.next("room", (m) => m.room.members.some((x) => x.name === "Renamed"));
      host.send({ t: "host", cmd: { c: "kick", id: pw.you.id, ban: true } });
      await p.closed;
      // Same token (and same IP): refused.
      const again = await Client.connect(server.url);
      clients.push(again);
      again.send({ t: "hello", v: 1, code, want: "player", token: pw.token });
      expect((await again.next("error")).code).toBe("BANNED");
      expect((await again.closed).reason).toBe("banned");
    } finally {
      for (const c of clients) c.ws.close();
      await server.close();
    }
  });
});
