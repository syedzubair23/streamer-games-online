import { describe, expect, it } from "vitest";
import { normalizeIp, parseUrl, resolveClientIp, statusLine } from "../src/transport/types.ts";
import { startServer } from "./helpers.ts";

describe("transport helpers", () => {
  it("normalises IPv4-mapped and expanded addresses", () => {
    expect(normalizeIp("::ffff:10.1.2.3")).toBe("10.1.2.3");
    expect(normalizeIp("0000:0000:0000:0000:0000:ffff:7f00:0001")).toBe("127.0.0.1");
    expect(normalizeIp("0000:0000:0000:0000:0000:0000:0000:0001")).toBe("::1");
    expect(normalizeIp(" 2001:DB8::1 ")).toBe("2001:db8::1");
    expect(normalizeIp("192.168.0.9")).toBe("192.168.0.9");
  });

  it("takes the right-most X-Forwarded-For entry only behind a trusted proxy", () => {
    expect(resolveClientIp("10.0.0.1", "6.6.6.6, 203.0.113.7", true)).toBe("203.0.113.7");
    expect(resolveClientIp("10.0.0.1", "6.6.6.6, 203.0.113.7", false)).toBe("10.0.0.1");
    expect(resolveClientIp("10.0.0.1", "", true)).toBe("10.0.0.1");
    expect(resolveClientIp("10.0.0.1", undefined, true)).toBe("10.0.0.1");
    expect(resolveClientIp("10.0.0.1", "1.1.1.1, ", true)).toBe("10.0.0.1");
  });

  it("parses URLs and status lines", () => {
    expect(parseUrl("/a%20b?x=1&x=2&y=")).toEqual({ path: "/a b", query: { x: "1", y: "" } });
    expect(parseUrl("nopath")).toEqual({ path: "/nopath", query: {} });
    expect(parseUrl("/bad%E0%A4%A")).toEqual({ path: "/bad%E0%A4%A", query: {} });
    expect(statusLine(404)).toBe("404 Not Found");
    expect(statusLine(299)).toBe("299 Unknown");
  });
});

describe.each(["uws", "ws"] as const)("%s transport behind a proxy", (transport) => {
  it("counts per-IP limits by the forwarded client IP", async () => {
    const s = await startServer(transport, { trustProxy: true, perIpConnections: 1 });
    try {
      const { Client } = await import("./helpers.ts");
      const a = await Client.connect(s.url, { "x-forwarded-for": "198.51.100.1" });
      const b = await Client.connect(s.url, { "x-forwarded-for": "198.51.100.2" });
      await expect(Client.connect(s.url, { "x-forwarded-for": "198.51.100.1" })).rejects.toThrow(
        "429",
      );
      a.close();
      b.close();
      // Unknown paths on the WebSocket port are refused.
      const res = await fetch(`${s.http}/nothing-here`);
      expect(res.status).toBe(404);
    } finally {
      await s.close();
    }
  });
});
