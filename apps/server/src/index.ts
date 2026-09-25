/**
 * @packageDocumentation
 * @sg/server: Authoritative game server: uWebSockets.js/ws transports, sessions, room actors, audience aggregation, moderation and storage.
 *
 * {@link createServer} wires config, store, room manager, the room actor (game registry,
 * content packs), HTTP routes and a transport into one listening server; `bin.ts` is the
 * process entry around it.
 */
import { createAudienceAggregator } from "./audience/aggregator.ts";
import type { Clock, ServerConfig } from "./config.ts";
import { GameRegistry, PackLibrary } from "./games.ts";
import { createHttpHandler } from "./http.ts";
import { createRoomActorFactory, type RoomActorOptions } from "./room.ts";
import { RoomManager, type DriverFactory, type JoinGuard } from "./room-manager.ts";
import { MemoryStore, type Store } from "./store/memory.ts";
import type { Transport, TransportFactory, TransportOptions } from "./transport/types.ts";

export * from "./audience/aggregator.ts";
export * from "./audience/leaderboard.ts";
export * from "./audience/polls/index.ts";
export * from "./audience/reactions.ts";
export * from "./audience/seeds.ts";
export * from "./codes.ts";
export * from "./config.ts";
export * from "./fanout.ts";
export * from "./games.ts";
export * from "./http.ts";
export * from "./playlist.ts";
export * from "./room.ts";
export * from "./room-manager.ts";
export * from "./scoreboard.ts";
export * from "./session.ts";
export * from "./store/memory.ts";
export * from "./transport/types.ts";

/** Package name, used by the process entry (`bin.ts`) in its startup line. */
export const SERVER_NAME = "@sg/server" as const;

/** Options for {@link createServer}. */
export interface CreateServerOptions {
  config: ServerConfig;
  /** Defaults to a {@link MemoryStore}. (`STORE=sqlite` arrives with M10-03.) */
  store?: Store;
  clock?: Clock;
  /** Replaces the room actor entirely (tests of the bare manager). */
  driver?: DriverFactory;
  /** Game modules; default: every game's `@sg/game-<id>/logic` entry, preloaded at start. */
  games?: GameRegistry;
  /** Content packs; default: `content/packs` of this repo. */
  packs?: PackLibrary;
  /** Room actor tuning (seeds, phase lengths, audience/moderation ports, ban hook). */
  actor?: Omit<RoomActorOptions, "manager" | "games" | "packs">;
  guards?: JoinGuard[];
  /** Random source for room codes. */
  random?: (max: number) => number;
  /** Restore rooms from the store before listening (crash restore). Default true. */
  restore?: boolean;
}

/** A listening server. */
export interface RunningServer {
  /** The port actually bound (useful with `port: 0`). */
  port: number;
  manager: RoomManager;
  transport: Transport;
  store: Store;
  /** Stops listening, closes every socket and timer. Idempotent. */
  close(): Promise<void>;
}

/** Loads the transport implementation lazily, so `ws`-only hosts never load the uWS binary. */
export async function loadTransport(kind: ServerConfig["transport"]): Promise<TransportFactory> {
  if (kind === "uws") return (await import("./transport/uws.ts")).createUwsTransport;
  return (await import("./transport/ws.ts")).createWsTransport;
}

/** Builds and starts a server. */
export async function createServer(o: CreateServerOptions): Promise<RunningServer> {
  const { config } = o;
  if (config.store === "sqlite" && o.store === undefined)
    throw new Error("STORE=sqlite needs the SqliteStore (M10-03); use STORE=memory for now");
  const store = o.store ?? new MemoryStore();
  const holder: { manager: RoomManager | null } = { manager: null };
  const managerRef = (): RoomManager => {
    if (holder.manager === null) throw new Error("server not ready");
    return holder.manager;
  };
  let driver = o.driver;
  if (driver === undefined) {
    const games = o.games ?? new GameRegistry();
    await games.preload();
    driver = createRoomActorFactory({
      // The AudienceAggregator (M1-03) is the production audience port.
      audience: createAudienceAggregator(),
      ...o.actor,
      manager: managerRef,
      games,
      packs: o.packs ?? PackLibrary.load(),
    });
  }
  const http = createHttpHandler({
    get manager(): RoomManager {
      return managerRef();
    },
    config,
    transport: config.transport,
    startedAt: (o.clock ?? { now: Date.now }).now(),
  });
  const manager = new RoomManager({
    config,
    store,
    ...(o.clock ? { clock: o.clock } : {}),
    driver,
    ...(o.guards ? { guards: o.guards } : {}),
    ...(o.random ? { random: o.random } : {}),
    http,
  });
  holder.manager = manager;
  if (o.restore !== false) manager.restoreFromStore();
  const options: TransportOptions = {
    maxPayloadBytes: config.maxPayloadBytes,
    idleTimeoutSec: config.idleTimeoutSec,
    maxBackpressureBytes: config.maxBackpressureBytes,
    trustProxy: config.trustProxy,
  };
  const transport = (await loadTransport(config.transport))(manager, options);
  manager.attachTransport(transport);
  let port: number;
  try {
    port = await transport.listen(config.host, config.port);
  } catch (err) {
    manager.shutdown();
    await transport.close();
    throw err;
  }
  let closing: Promise<void> | null = null;
  return {
    port,
    manager,
    transport,
    store,
    close() {
      closing ??= (async () => {
        manager.shutdown();
        await transport.close();
      })();
      return closing;
    },
  };
}
