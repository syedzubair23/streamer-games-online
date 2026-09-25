import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseServerConfig } from "../src/config.ts";
import { bearer, createHttpHandler, serveStatic } from "../src/http.ts";
import { RoomManager } from "../src/room-manager.ts";
import { MemoryStore } from "../src/store/memory.ts";
import type { HttpRequestInfo } from "../src/transport/types.ts";
import { FakeClock } from "./fake-clock.ts";

let dir = "";
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "sg-static-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>SGO</title>");
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "stage-abc.js"), "export {}");
  writeFileSync(join(dir, "logo.svg"), "<svg/>");
  writeFileSync(join(dir, "data.xyz"), "?");
  mkdirSync(join(dir, "folder.d"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const req = (path: string, extra: Partial<HttpRequestInfo> = {}): HttpRequestInfo => ({
  method: "GET",
  path,
  query: {},
  headers: {},
  ip: "9.9.9.9",
  ...extra,
});

const text = (body: string | Uint8Array | undefined): string =>
  typeof body === "string" ? body : Buffer.from(body ?? new Uint8Array()).toString("utf8");

describe("HTTP routes", () => {
  const clock = new FakeClock();
  const config = parseServerConfig({ adminKey: "a".repeat(24), publicListing: false });

  it("guards the admin endpoint and hides it when no key is set", async () => {
    const manager = new RoomManager({ config, store: new MemoryStore(), clock });
    const handle = createHttpHandler({ manager, config, transport: "ws", startedAt: clock.now() });
    expect((await handle(req("/api/admin/rooms"))).status).toBe(403);
    expect(
      (await handle(req("/api/admin/rooms", { headers: { authorization: "Bearer nope" } }))).status,
    ).toBe(403);
    const ok = await handle(
      req("/api/admin/rooms", { headers: { authorization: `Bearer ${"a".repeat(24)}` } }),
    );
    expect(ok.status).toBe(200);
    expect(JSON.parse(text(ok.body))).toEqual({ rooms: [] });
    const noKey = createHttpHandler({
      manager,
      config: parseServerConfig({}),
      transport: "ws",
      startedAt: 0,
    });
    expect((await noKey(req("/api/admin/rooms"))).status).toBe(404);
    expect((await handle(req("/api/rooms"))).status).toBe(404); // listing off
    expect((await handle(req("/api/unknown"))).status).toBe(404);
    expect((await handle(req("/index.html"))).status).toBe(404); // no staticDir
    expect((await handle(req("/api/rooms/BCDF/overlay-key"))).status).toBe(403);
    expect((await handle(req("/api/rooms/zz"))).status).toBe(404);
    const health = await handle(req("/health"));
    expect(health.headers?.["cache-control"]).toBe("no-store");
    expect(health.headers?.["x-content-type-options"]).toBe("nosniff");
    manager.shutdown();
  });

  it("parses bearer tokens", () => {
    expect(bearer(req("/", { headers: { authorization: "Bearer abc" } }))).toBe("abc");
    expect(bearer(req("/", { headers: { authorization: "bearer  abc " } }))).toBe("abc");
    expect(bearer(req("/", { headers: { authorization: "Basic abc" } }))).toBeNull();
    expect(bearer(req("/"))).toBeNull();
  });

  it("serves the client build with SPA fallback and no path escape", async () => {
    const index = await serveStatic(dir, "/");
    expect(index.status).toBe(200);
    expect(index.headers?.["content-type"]).toMatch(/text\/html/);
    expect(index.headers?.["cache-control"]).toBe("no-cache");
    const asset = await serveStatic(dir, "/assets/stage-abc.js");
    expect(asset.headers?.["content-type"]).toMatch(/javascript/);
    expect(asset.headers?.["cache-control"]).toMatch(/immutable/);
    expect((await serveStatic(dir, "/logo.svg")).headers?.["content-type"]).toBe("image/svg+xml");
    expect((await serveStatic(dir, "/data.xyz")).headers?.["content-type"]).toBe(
      "application/octet-stream",
    );
    // App routes fall back to index.html; missing files with an extension are 404.
    const route = await serveStatic(dir, "/host/BCDF");
    expect(text(route.body)).toContain("<title>SGO</title>");
    expect((await serveStatic(dir, "/missing.js")).status).toBe(404);
    expect((await serveStatic(dir, "/folder.d")).status).toBe(404);
    // Traversal stays inside the root.
    const up = await serveStatic(dir, "/../../etc/passwd");
    expect(text(up.body)).not.toContain("root:");
    expect((await serveStatic(dir, "/..%2F..%2Fsecret.js")).status).toBe(404);
    // No index.html: app routes are 404.
    const empty = mkdtempSync(join(tmpdir(), "sg-empty-"));
    expect((await serveStatic(empty, "/host")).status).toBe(404);
    rmSync(empty, { recursive: true, force: true });
  });

  it("routes non-API paths to the static root through the handler", async () => {
    const cfg = parseServerConfig({ staticDir: dir });
    const manager = new RoomManager({ config: cfg, store: new MemoryStore(), clock });
    const handle = createHttpHandler({ manager, config: cfg, transport: "uws", startedAt: 0 });
    expect(text((await handle(req("/BCDF"))).body)).toContain("SGO");
    const post = await handle(req("/", { method: "PUT" }));
    expect(post.status).toBe(405);
    expect(post.headers?.["allow"]).toBe("GET, HEAD");
    manager.shutdown();
  });
});
