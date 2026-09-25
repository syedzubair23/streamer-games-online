/// <reference lib="dom" />
/**
 * The `@sg/render` ↔ `@sg/engine` contract (M1-06).
 *
 * The package boundaries (SPEC §9.2) let `@sg/render` import only `@sg/shared` and three.js,
 * so `packages/render/src/types.ts` mirrors the `@sg/engine` client interfaces member for member
 * instead of importing them. This root test may import both packages: the type-level checks
 * below fail `pnpm typecheck` on any drift, and the runtime checks prove the real factories
 * satisfy the engine's `StageContext` members and that the shared constant lists agree.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import type * as Engine from "../packages/engine/src/client-module.ts";
import { EASING_NAMES, QUALITY_TIERS, SPRING_NAMES } from "../packages/engine/src/client-module.ts";
import * as R from "../packages/render/src/index.ts";
import { fakeCanvasFactory } from "../packages/render/test/helpers/fake-canvas.ts";

/** `A` and `B` are mutually assignable (the same structural type). */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const same = <T extends true>(): T => true as T;

describe("render types mirror the engine client contract", () => {
  it("each mirrored type is structurally identical to the engine's", () => {
    same<Same<R.QualityTier, Engine.QualityTier>>();
    same<Same<R.ColorLike, Engine.ColorLike>>();
    same<Same<R.Vec3Like, Engine.Vec3Like>>();
    same<Same<R.PointerLike, Engine.PointerLike>>();
    same<Same<R.EasingName, Engine.EasingName>>();
    same<Same<R.SpringName, Engine.SpringName>>();
    same<Same<R.SpringConfig, Engine.SpringConfig>>();
    same<Same<R.SpringPresets, Engine.SpringPresets>>();
    same<Same<R.TweenHandle, Engine.TweenHandle>>();
    same<Same<R.TweenOptions, Engine.TweenOptions>>();
    same<Same<R.TweenApi, Engine.TweenApi>>();
    same<Same<R.MaterialOptions, Engine.MaterialOptions>>();
    same<Same<R.MaterialFactories, Engine.MaterialFactories>>();
    same<Same<R.TextureName, Engine.TextureName>>();
    same<Same<R.ProceduralTextureOptions, Engine.ProceduralTextureOptions>>();
    same<Same<R.ProceduralTextures, Engine.ProceduralTextures>>();
    same<Same<R.PickApi, Engine.PickApi>>();
    expectTypeOf<R.RenderMaterials>().toMatchTypeOf<Engine.StageContext["materials"]>();
    expectTypeOf<R.TextureKit["api"]>().toEqualTypeOf<R.ProceduralTextures>();
    expectTypeOf<R.TweenEngine>().toMatchTypeOf<Engine.StageContext["tween"]>();
    expectTypeOf<R.RenderLoop>().toMatchTypeOf<Engine.StageContext["loop"]>();
    expectTypeOf<R.LoopApi>().toMatchTypeOf<Engine.StageContext["loop"]>();
    expectTypeOf<R.Picker>().toMatchTypeOf<Engine.StageContext["pick"]>();
    expectTypeOf<typeof R.SPRINGS>().toMatchTypeOf<Engine.StageContext["springs"]>();
    expectTypeOf<R.QualityTier>().toEqualTypeOf<Engine.StageContext["quality"]>();
  });

  it("the shared constant lists agree", () => {
    expect([...R.QUALITY_TIERS]).toEqual([...QUALITY_TIERS]);
    expect([...R.EASING_NAMES]).toEqual([...EASING_NAMES]);
    expect([...R.SPRING_NAMES]).toEqual([...SPRING_NAMES]);
    expect(Object.keys(R.SPRINGS).sort()).toEqual([...SPRING_NAMES].sort());
  });

  it("the real factories fill the StageContext members games use", () => {
    const kit = R.createTextureKit({ tier: "low", canvas: fakeCanvasFactory() });
    const materials: Engine.MaterialFactories = R.createMaterialFactories("low", {
      ramp: kit.api.ramp(),
      matcapWarm: kit.api.matcap({ variant: "warm" }),
      matcapCool: kit.api.matcap({ variant: "cool" }),
      blob: kit.api.blob(),
    });
    const textures: Engine.ProceduralTextures = kit.api;
    const tweens: Engine.TweenApi = R.createTweens();
    for (const name of ["makeToon", "makeMatcap", "makeLambertVC", "makeBasic"] as const)
      expect(typeof materials[name]).toBe("function");
    for (const name of R.TEXTURE_NAMES) expect(typeof textures[name]).toBe("function");
    expect(typeof tweens.to).toBe("function");
    kit.dispose();
  });
});
