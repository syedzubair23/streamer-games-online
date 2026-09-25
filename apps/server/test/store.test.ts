import { DEFAULT_ROOM_CONFIG, type RoomConfig } from "@sg/shared";
import { describe, expect, it } from "vitest";
import { MemoryStore, type RoomRecord } from "../src/store/memory.ts";

const record = (code: string, epoch = 1): RoomRecord => ({
  code,
  epoch,
  createdAt: 1,
  config: structuredClone(DEFAULT_ROOM_CONFIG) as RoomConfig,
  overlayKey: "k",
  hostId: "host",
  phase: "lobby",
  sessions: [
    { token: "t", id: "host", role: "host", name: "H", seat: null, ipHash: "x", joinedAt: 1 },
  ],
  savedAt: 2,
});

describe("MemoryStore", () => {
  it("saves, loads, lists and deletes rooms as independent copies", () => {
    const store = new MemoryStore();
    expect(store.kind).toBe("memory");
    const r = record("BCDF");
    store.saveRoom(r);
    r.config.maxPlayers = 2; // mutating the caller's object does not reach the store
    const loaded = store.loadRoom("BCDF");
    expect(loaded?.config.maxPlayers).toBe(8);
    if (loaded) loaded.sessions.length = 0; // nor does mutating what came out
    expect(store.loadRoom("BCDF")?.sessions).toHaveLength(1);
    store.saveRoom(record("GHJK"));
    expect(
      store
        .listRooms()
        .map((x) => x.code)
        .sort(),
    ).toEqual(["BCDF", "GHJK"]);
    store.deleteRoom("BCDF");
    expect(store.loadRoom("BCDF")).toBeNull();
    store.close();
    expect(store.listRooms()).toEqual([]);
  });

  it("hands out increasing epochs per code, above any saved epoch", () => {
    const store = new MemoryStore();
    expect(store.nextEpoch("BCDF")).toBe(1);
    expect(store.nextEpoch("BCDF")).toBe(2);
    expect(store.nextEpoch("GHJK")).toBe(1);
    store.saveRoom(record("MNPQ", 9));
    expect(store.nextEpoch("MNPQ")).toBe(10);
    store.deleteRoom("MNPQ");
    expect(store.nextEpoch("MNPQ")).toBe(11);
  });

  it("keeps a bounded list of results", () => {
    const store = new MemoryStore();
    for (let i = 0; i < MemoryStore.MAX_RESULTS + 5; i++)
      store.saveResult({ code: "BCDF", epoch: 1, gameId: "ludo", finishedAt: i, result: { i } });
    const results = store.results();
    expect(results).toHaveLength(MemoryStore.MAX_RESULTS);
    expect(results[0]?.finishedAt).toBe(5);
  });
});
