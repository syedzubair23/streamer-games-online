import { describe, expect, it } from "vitest";
import { outDirFor, pageInputs } from "../vite.config.ts";

describe("client build pages (SPEC §14: /dev/scenario outside production only)", () => {
  it("leaves the scenario page out of the production build", () => {
    expect(Object.keys(pageInputs("production", "/x/"))).toEqual(["main"]);
    expect(pageInputs("scenario", "/x/")).toEqual({
      main: "/x/index.html",
      "dev/scenario": "/x/dev/scenario.html",
      "dev/audio": "/x/dev/audio.html",
    });
    expect(Object.keys(pageInputs("development"))).toContain("dev/scenario");
    expect(Object.keys(pageInputs("development"))).toContain("dev/audio");
  });

  it("builds harness bundles into their own directory", () => {
    expect(outDirFor("scenario")).toBe("../../artifacts/tmp/scenario-client");
    expect(outDirFor("production")).toBe("dist");
  });
});
