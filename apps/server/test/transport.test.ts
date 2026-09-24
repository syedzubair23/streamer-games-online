/**
 * M1-01 acceptance, end to end: real `ws` clients against a real server, once per transport.
 */
import { isRoomCode, ROOM_CODE_ALPHABET } from "@sg/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryStore, type RunningServer } from "../src/index.ts";
import { Client, createRoom, join, startServer } from "./helpers.ts";

type Srv = RunningServer & { url: string; http: string };

describe.each(["uws", "ws"] as const)("%s transport", (transport) => {
  const servers: Srv[] = [];
  const clients: Client[] = [];
  const start = async (
    ...args: Parameters<typeof startServer> extends [unknown, ...infer R] ? R : never
  ) => {
    const s = await startServer(transport, ...args);
    servers.push(s);
    return s;
  };
  const track = <T extends { c?: Client; host?: Client }>(x: T): T => {
    if (x.c) clients.push(x.c);
    if (x.host) clients.push(x.host);
    return x;
  };

  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    for (const s of servers.splice(0)) await s.close();
  });

  it("create → hello → welcome works", async () => {
    const s = await start();
    const { host, welcome } = track(await createRoom(s.url, {}, "Maple"));
    expect(welcome.v).toBe(1);
    expect(welcome.you).toMatchObject({ id: "host", role: "host", name: "Maple", seat: null });
    expect(welcome.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(isRoomCode(welcome.room.code)).toBe(true);
    expect(welcome.room).toMatchObject({ phase: "lobby", hostId: "host", audienceCount: 0 });
    expect(typeof welcome.serverNow).toBe("number");

    const { c, reply } = track(
      await join(s.url, { code: welcome.room.code.toLowerCase(), name: "Juniper" }),
    );
    expect(reply.t).toBe("welcome");
    if (reply.t !== "welcome") return;
    expect(reply.you).toMatchObject({
      id: "p1",
      role: "player",
      name: "Juniper",
      seat: 0,
      colorSlot: 0,
    });
    expect(reply.token).not.toBe(welcome.token);
    expect(reply.room.members.map((m) => m.id)).toEqual(["host", "p1"]);
    // The host hears about the new member.
    const room = await host.next("room", (m) => m.room.members.some((x) => x.id === "p1"));
    expect(room.room.members.find((m) => m.id === "p1")).toMatchObject({
      connected: true,
      seat: 0,
    });
    // Tokens, passwords and the overlay key never appear in the public snapshot.
    const snap = JSON.stringify(room.room);
    expect(snap).not.toContain(welcome.token);
    expect(snap).not.toContain(reply.token);
    expect(snap).not.toContain(s.manager.rooms.get(welcome.room.code)?.overlayKey ?? "@@");
    await c.flush();
  });

  it("a wrong code returns BAD_CODE", async () => {
    const s = await start();
    const { welcome } = track(await createRoom(s.url));
    const free =
      [...ROOM_CODE_ALPHABET].map((l) => l.repeat(4)).find((x) => x !== welcome.room.code) ??
      "BBBB";
    const a = track(await join(s.url, { code: free }));
    expect(a.reply).toMatchObject({ t: "error", code: "BAD_CODE" });
    const b = track(await join(s.url, { code: "AEIO" }));
    expect(b.reply).toMatchObject({ t: "error", code: "BAD_CODE" });
    // The socket stays usable: a corrected hello on the same socket joins.
    a.c.send({ t: "hello", v: 1, want: "player", code: welcome.room.code, name: "Retry" });
    expect((await a.c.next("welcome")).you.role).toBe("player");
  });

  it("a full room puts the joiner in the audience", async () => {
    const s = await start();
    const { host, welcome } = track(await createRoom(s.url, { maxPlayers: 2 }));
    const code = welcome.room.code;
    const seats: (number | null)[] = [];
    for (const name of ["A", "B", "C"]) {
      const { reply } = track(await join(s.url, { code, name }));
      if (reply.t !== "welcome") throw new Error(JSON.stringify(reply));
      seats.push(reply.you.seat);
      if (name === "C") {
        expect(reply.you).toMatchObject({ role: "audience", seat: null, colorSlot: null });
        expect(reply.you.id).toMatch(/^a\d+$/);
      }
    }
    expect(seats).toEqual([0, 1, null]);
    const room = await host.next("room", (m) => m.room.audienceCount === 1);
    expect(room.room.members.filter((m) => m.role === "player")).toHaveLength(2);
    // Asking for the audience directly also works while seats are free.
    const { welcome: w2 } = track(await createRoom(s.url));
    const v = track(await join(s.url, { code: w2.room.code, want: "audience" }));
    expect(v.reply.t === "welcome" && v.reply.you.role).toBe("audience");
  });

  it("a password is required when one is set", async () => {
    const s = await start();
    const { host, welcome } = track(await createRoom(s.url, { password: "cocoa" }));
    const code = welcome.room.code;
    expect(welcome.room.config).toMatchObject({ hasPassword: true });
    expect(JSON.stringify(welcome.room)).not.toContain("cocoa");
    expect(track(await join(s.url, { code })).reply).toMatchObject({
      t: "error",
      code: "BAD_PASSWORD",
    });
    expect(track(await join(s.url, { code, password: "Cocoa" })).reply).toMatchObject({
      t: "error",
      code: "BAD_PASSWORD",
    });
    const ok = track(await join(s.url, { code, password: "cocoa" }));
    expect(ok.reply.t).toBe("welcome");
    // A reconnect with a live token does not need the password again.
    if (ok.reply.t !== "welcome") return;
    const token = ok.reply.token;
    ok.c.close();
    await ok.c.closed;
    const back = track(await join(s.url, { code, token }));
    expect(back.reply).toMatchObject({ t: "welcome", you: { id: "p1", seat: 0 } });
    // The host can change the password; new joiners then need the new one.
    host.send({ t: "host", cmd: { c: "config", patch: { password: "tea" } } });
    await host.next("room", (m) => m.room.config.hasPassword);
    expect(track(await join(s.url, { code, password: "cocoa" })).reply).toMatchObject({
      code: "BAD_PASSWORD",
    });
    expect(track(await join(s.url, { code, password: "tea" })).reply.t).toBe("welcome");
    host.send({ t: "host", cmd: { c: "config", patch: { password: "" } } });
    await host.next("room", (m) => !m.room.config.hasPassword);
    expect(track(await join(s.url, { code })).reply.t).toBe("welcome");
  });

  it("codes use only the 20-consonant alphabet", async () => {
    const s = await start();
    const codes = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const { welcome } = track(await createRoom(s.url));
      codes.add(welcome.room.code);
    }
    expect(codes.size).toBe(12);
    for (const code of codes) expect(code).toMatch(new RegExp(`^[${ROOM_CODE_ALPHABET}]{4}$`));
  });

  it("a blocklisted code is never issued by the server", async () => {
    // Force the random source to propose "FCKB" (blocked: contains FCK) before anything else.
    const letters = [..."FCKB"].map((l) => ROOM_CODE_ALPHABET.indexOf(l));
    let i = 0;
    const s = await start(
      {},
      {
        random: (max) =>
          i < letters.length ? (letters[i++] ?? 0) : Math.floor(Math.random() * max),
      },
    );
    const { welcome } = track(await createRoom(s.url));
    expect(welcome.room.code).not.toBe("FCKB");
    expect(i).toBe(4);
  });

  it("a reconnect within the grace period restores role and seat", async () => {
    const s = await start();
    const { host, welcome } = track(await createRoom(s.url, { reconnectGraceSec: 30 }));
    const code = welcome.room.code;
    const p1 = track(await join(s.url, { code, name: "Ash" }));
    const p2 = track(await join(s.url, { code, name: "Birch" }));
    if (p1.reply.t !== "welcome" || p2.reply.t !== "welcome") throw new Error("join failed");
    expect(p2.reply.you.seat).toBe(1);
    p2.c.close();
    const away = await host.next(
      "room",
      (m) => m.room.members.find((x) => x.id === "p2")?.connected === false,
    );
    expect(away.room.members.find((x) => x.id === "p2")?.seat).toBe(1);
    // A newcomer does not take the held seat.
    const p3 = track(await join(s.url, { code, name: "Cedar" }));
    expect(p3.reply.t === "welcome" && p3.reply.you.seat).toBe(2);
    const back = track(
      await join(s.url, { code, token: p2.reply.token, want: "audience", name: "Other" }),
    );
    expect(back.reply).toMatchObject({
      t: "welcome",
      token: p2.reply.token,
      you: { id: "p2", role: "player", seat: 1, name: "Birch", colorSlot: 1 },
    });
    await host.next("room", (m) => m.room.members.find((x) => x.id === "p2")?.connected === true);
    // The host reloading the Stage keeps the host role too.
    host.close();
    await host.closed;
    const h2 = track(await join(s.url, { code, token: welcome.token }));
    expect(h2.reply).toMatchObject({ t: "welcome", you: { id: "host", role: "host" } });
  });

  it("after the grace period the seat is released and the token is forgotten", async () => {
    const s = await start();
    const { host, welcome } = track(await createRoom(s.url, { reconnectGraceSec: 1 }));
    const code = welcome.room.code;
    const p = track(await join(s.url, { code, name: "Elm" }));
    if (p.reply.t !== "welcome") throw new Error("join failed");
    p.c.close();
    const away = await host.next(
      "room",
      (m) => m.room.members.find((x) => x.id === "p1")?.connected === false,
    );
    await host.next(
      "room",
      (m) => m.seq > away.seq && !m.room.members.some((x) => x.id === "p1"),
      5000,
    );
    const again = track(await join(s.url, { code, token: p.reply.token, name: "Elm" }));
    expect(again.reply).toMatchObject({ t: "welcome", you: { id: "p2", seat: 0 } });
  });

  it("a second socket for the same session replaces the first; the host panel is a separate surface", async () => {
    const s = await start();
    const { host, welcome } = track(await createRoom(s.url));
    const code = welcome.room.code;
    const panel = track(await join(s.url, { code, token: welcome.token, want: "moderator" }));
    expect(panel.reply).toMatchObject({ t: "welcome", you: { role: "host" } });
    await host.flush(); // the Stage socket is still open
    expect(host.isOpen).toBe(true);
    const stage2 = track(await join(s.url, { code, token: welcome.token, want: "player" }));
    expect(stage2.reply.t).toBe("welcome");
    expect((await host.closed).code).toBe(4000);
    await panel.c.flush();
    expect(panel.c.isOpen).toBe(true);
  });

  it("the join rate limit triggers at the configured value", async () => {
    const s = await start({ perIpJoinsPerMin: 5 });
    const { welcome } = track(await createRoom(s.url)); // attempt 1
    const code = welcome.room.code;
    const tokens: string[] = [];
    for (let k = 0; k < 4; k++) {
      const { reply } = track(await join(s.url, { code })); // attempts 2..5
      expect(reply.t).toBe("welcome");
      if (reply.t === "welcome") tokens.push(reply.token);
    }
    const sixth = track(await join(s.url, { code }));
    expect(sixth.reply).toMatchObject({ t: "error", code: "RATE_LIMIT" });
    const badCode = track(await join(s.url, { code: "BBBB" }));
    expect(badCode.reply).toMatchObject({ code: "RATE_LIMIT" });
    // HTTP probing counts too.
    expect((await fetch(`${s.http}/api/rooms/${code}`)).status).toBe(429);
    // A live session reconnecting with its token is not a new join attempt.
    const back = track(await join(s.url, { code, token: tokens[0] }));
    expect(back.reply.t).toBe("welcome");
  });

  it("the join rate limit defaults to 40/min/IP", async () => {
    const s = await start();
    expect(s.manager.config.perIpJoinsPerMin).toBe(40);
    // 40 attempts pass (spread over sockets: a pre-join socket may send 5 msg/s).
    let bad = 0;
    for (let k = 0; k < 8; k++) {
      const c = await Client.connect(s.url);
      clients.push(c);
      for (let j = 0; j < 5; j++) c.send({ t: "hello", v: 1, want: "player", code: "BBBB" });
      for (let j = 0; j < 5; j++) if ((await c.next("error")).code === "BAD_CODE") bad++;
    }
    expect(bad).toBe(40);
    const last = track(await join(s.url, { code: "BBBB" }));
    expect(last.reply).toMatchObject({ code: "RATE_LIMIT" });
  });

  it("30 clients from one IP can all join (classroom case)", async () => {
    const s = await start();
    const { host, welcome } = track(await createRoom(s.url, { maxPlayers: 12 }));
    const joins = await Promise.all(
      Array.from({ length: 30 }, (_, k) =>
        join(s.url, { code: welcome.room.code, name: `Kid ${k + 1}` }),
      ),
    );
    for (const j of joins) clients.push(j.c);
    const roles = joins.map((j) => (j.reply.t === "welcome" ? j.reply.you.role : j.reply.code));
    expect(roles.filter((r) => r === "player")).toHaveLength(12);
    expect(roles.filter((r) => r === "audience")).toHaveLength(18);
    const room = await host.next(
      "room",
      (m) => m.room.audienceCount === 18 && m.room.members.length === 13,
    );
    expect(new Set(room.room.members.map((m) => m.seat)).size).toBe(13);
    expect(s.manager.connectionCount).toBe(31);
  });

  it("the 16 KB payload cap drops the connection", async () => {
    const s = await start();
    const c = await Client.connect(s.url);
    clients.push(c);
    // Just under the cap is fine.
    const pad = "x".repeat(16 * 1024 - 64);
    c.send({ t: "ping", ts: 7, pad });
    expect((await c.next("pong")).ts).toBe(7);
    // Over the cap closes the socket.
    c.sendRaw(JSON.stringify({ t: "ping", ts: 8, pad: "x".repeat(16 * 1024) }));
    const { code } = await c.closed;
    expect([1006, 1009]).toContain(code);
    expect(c.inbox.some((m) => m.t === "pong" && m.ts === 8)).toBe(false);
  });

  it("the overlay key gives read-only access", async () => {
    const s = await start();
    const { host, welcome } = track(await createRoom(s.url, { password: "secret" }));
    const code = welcome.room.code;
    const nope = await fetch(`${s.http}/api/rooms/${code}/overlay-key`);
    expect(nope.status).toBe(403);
    const res = await fetch(`${s.http}/api/rooms/${code}/overlay-key`, {
      headers: { authorization: `Bearer ${welcome.token}` },
    });
    expect(res.status).toBe(200);
    const { key } = (await res.json()) as { key: string };
    expect(key).toMatch(/^[A-Za-z0-9_-]{16}$/); // 96 bits

    const wrong = track(await join(s.url, { code, want: "overlay", overlayKey: "A".repeat(16) }));
    expect(wrong.reply).toMatchObject({ t: "error", code: "NOT_ALLOWED" });
    const o = track(await join(s.url, { code, want: "overlay", overlayKey: key }));
    expect(o.reply).toMatchObject({ t: "welcome", you: { role: "overlay", seat: null } });

    o.c.send({ t: "act", id: 41, a: { cell: 4 } });
    expect(await o.c.next("ack", (m) => m.id === 41)).toEqual({
      t: "ack",
      id: 41,
      ok: false,
      err: "NOT_ALLOWED",
    });
    o.c.send({ t: "host", cmd: { c: "start" } });
    expect((await o.c.next("error")).code).toBe("NOT_ALLOWED");
    o.c.send({ t: "aud", pollId: "p", choice: "a" });
    expect((await o.c.next("error")).code).toBe("NOT_ALLOWED");
    o.c.send({ t: "mod", cmd: { c: "approve", itemId: "x" } });
    expect((await o.c.next("error")).code).toBe("NOT_ALLOWED");
    // Reading still works, and the overlay is not a member.
    o.c.send({ t: "resync", lastSeq: 0 });
    const r = await o.c.next("room");
    expect(r.room.members.map((m) => m.role)).toEqual(["host"]);
    await host.flush();
  });

  it("gates roles, validates frames and answers version mismatches", async () => {
    const s = await start();
    const { host, welcome } = track(await createRoom(s.url));
    const code = welcome.room.code;
    // Before joining, only hello/create/ping are allowed.
    const pre = await Client.connect(s.url);
    clients.push(pre);
    pre.send({ t: "act", id: 1, a: null });
    expect((await pre.next("error")).code).toBe("NOT_ALLOWED");
    pre.sendRaw("{not json");
    expect((await pre.next("error")).code).toBe("ILLEGAL");
    pre.send({ t: "teleport" });
    expect((await pre.next("error")).code).toBe("ILLEGAL");
    pre.sendRaw(Buffer.from([1, 2, 3]));
    expect((await pre.next("error")).code).toBe("ILLEGAL");

    const p = track(await join(s.url, { code }));
    // No game is running: actions are illegal (acked), and players cannot send host commands.
    p.c.send({ t: "act", id: 9, a: {} });
    expect(await p.c.next("ack")).toEqual({ t: "ack", id: 9, ok: false, err: "ILLEGAL" });
    p.c.send({ t: "act", id: 10 }); // missing `a` is still an action: validated by the game
    expect((await p.c.next("ack")).id).toBe(10);
    p.c.send({ t: "act", id: 11.5, a: 1 });
    expect((await p.c.next("error")).code).toBe("ILLEGAL");
    p.c.send({ t: "host", cmd: { c: "start" } });
    expect((await p.c.next("error")).code).toBe("NOT_ALLOWED");
    p.c.send({ t: "aud", pollId: "x", choice: 1 });
    expect((await p.c.next("error")).code).toBe("NOT_ALLOWED");
    p.c.send({ t: "hello", v: 1, code, want: "player" });
    expect((await p.c.next("error")).code).toBe("NOT_ALLOWED");
    // The host's game commands need the room actor; config commands work in the lobby.
    host.send({ t: "host", cmd: { c: "start" } });
    expect((await host.next("error")).code).toBe("ILLEGAL");
    host.send({ t: "host", cmd: { c: "ambient", mode: "rain" } });
    expect(
      (await host.next("room", (m) => m.room.config.theme.ambient === "rain")).seq,
    ).toBeGreaterThan(0);
    host.send({ t: "host", cmd: { c: "revealCode", on: false } });
    await host.next("room", (m) => m.room.config.hideCode);
    host.send({ t: "host", cmd: { c: "config", patch: { maxPlayers: 99 } } });
    expect((await host.next("error")).code).toBe("ILLEGAL");
    host.send({ t: "act", id: 3, a: 0 });
    expect((await host.next("ack")).err).toBe("NOT_ALLOWED");

    const old = await Client.connect(s.url);
    clients.push(old);
    old.send({ t: "hello", v: 2, code, want: "player" });
    expect((await old.next("error")).code).toBe("VERSION");
    expect((await old.closed).code).toBe(4003);
  });

  it("audience members can queue for the next round", async () => {
    const s = await start();
    const { host, welcome } = track(await createRoom(s.url));
    const a = track(await join(s.url, { code: welcome.room.code, want: "audience" }));
    a.c.send({ t: "queue", join: true });
    expect((await host.next("room", (m) => m.room.queueCount === 1)).room.audienceCount).toBe(1);
    a.c.send({ t: "queue", join: false });
    await host.next("room", (m) => m.room.queueCount === 0);
    a.c.send({ t: "react", e: "heart" });
    a.c.send({ t: "tap", pollId: "none", n: 3 });
    await a.c.flush();
  });

  it("enforces the per-IP connection cap and the per-socket message rate", async () => {
    const s = await start({ perIpConnections: 3, playerMsgPerSec: 20 });
    const open = [
      await Client.connect(s.url),
      await Client.connect(s.url),
      await Client.connect(s.url),
    ];
    clients.push(...open);
    await expect(Client.connect(s.url)).rejects.toThrow("HTTP 429");
    open[0]?.close();
    await vi.waitFor(() => expect(s.manager.connectionCount).toBe(2));
    clients.push(await Client.connect(s.url));

    open[1]?.send({ t: "create", v: 1, name: "Rate" });
    const w = await open[1]?.next("welcome");
    open[2]?.send({ t: "hello", v: 1, want: "player", code: w?.room.code ?? "" });
    await open[2]?.next("welcome");
    for (let k = 0; k < 60; k++) open[2]?.send({ t: "act", id: k, a: 0 });
    const acks = [];
    for (let k = 0; k < 60; k++) acks.push(await open[2]?.next("ack", (m) => m.id === k));
    const limited = acks.filter((a) => a?.err === "RATE_LIMIT").length;
    expect(limited).toBeGreaterThanOrEqual(30);
    expect(limited).toBeLessThanOrEqual(45);
  });

  it("closes sockets that never say hello", async () => {
    const s = await start({ helloTimeoutMs: 200 });
    const c = await Client.connect(s.url);
    clients.push(c);
    expect((await c.closed).code).toBe(4008);
  });

  it("cleans up an empty room and keeps its code reserved", async () => {
    const s = await start({ roomCleanupMs: 50, codeReleaseMs: 60_000 });
    const { host, welcome } = track(await createRoom(s.url));
    const code = welcome.room.code;
    host.close();
    await vi.waitFor(() => expect(s.manager.rooms.has(code)).toBe(false));
    expect(s.manager.codes.isTaken(code)).toBe(true);
    expect(s.store.loadRoom(code)).toBeNull();
    expect(track(await join(s.url, { code })).reply).toMatchObject({ code: "BAD_CODE" });
  });

  it("restores rooms from the store so tokens still work after a restart", async () => {
    const store = new MemoryStore();
    const a = await start({}, { store });
    const { host, welcome } = track(await createRoom(a.url, { password: "pw" }));
    const p = track(await join(a.url, { code: welcome.room.code, password: "pw", name: "Oak" }));
    if (p.reply.t !== "welcome") throw new Error("join failed");
    await host.flush();
    await vi.waitFor(() => expect(store.loadRoom(welcome.room.code)?.sessions).toHaveLength(2));
    await a.close();

    const b = await start({}, { store });
    const back = track(await join(b.url, { code: welcome.room.code, token: p.reply.token }));
    expect(back.reply).toMatchObject({ t: "welcome", you: { id: "p1", seat: 0, name: "Oak" } });
    const fresh = track(await join(b.url, { code: welcome.room.code, password: "pw" }));
    expect(fresh.reply).toMatchObject({ t: "welcome", you: { id: "p2", seat: 1 } });
  });

  it("serves /health and the join pre-check over HTTP", async () => {
    const s = await start({ publicListing: true });
    const health = (await (await fetch(`${s.http}/health`)).json()) as Record<string, unknown>;
    expect(health).toMatchObject({ ok: true, transport, protocol: 1, rooms: 0 });
    const { welcome } = track(await createRoom(s.url, { visibility: "public", password: "x" }));
    const info = (await (await fetch(`${s.http}/api/rooms/${welcome.room.code}`)).json()) as Record<
      string,
      unknown
    >;
    expect(info).toEqual({
      code: welcome.room.code,
      hasPassword: true,
      seatFree: true,
      phase: "lobby",
    });
    expect((await fetch(`${s.http}/api/rooms/BBBB`)).status).toBe(404);
    const list = (await (await fetch(`${s.http}/api/rooms`)).json()) as { rooms: unknown[] };
    expect(list.rooms).toHaveLength(1);
    expect((await fetch(`${s.http}/ws`)).status).toBe(426);
    const head = await fetch(`${s.http}/health`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect((await fetch(`${s.http}/health`, { method: "POST" })).status).toBe(405);
  });
});
