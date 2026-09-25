/**
 * Material factories (SPEC §13.5, §10): the only source of materials. Patches are applied to
 * three's real shader sources, share one program per kind (fixed cache keys) and read shared
 * uniforms, so a mode change never recompiles. The real WebGL compile is covered by
 * `test/browser/render-kit.spec.ts`.
 */
import {
  AdditiveBlending,
  BackSide,
  BoxGeometry,
  Color,
  DataTexture,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshMatcapMaterial,
  MeshToonMaterial,
  PlaneGeometry,
  ShaderLib,
  ShaderMaterial,
  Texture,
} from "three";
import { describe, expect, it } from "vitest";
import {
  applyOptions,
  bakeVertexAO,
  BLOB_INSTANCED_KEY,
  createMaterialFactories,
  createSharedUniforms,
  makeBlobShadowMaterial,
  makeSkyMaterial,
  MATCAP_BLEND_KEY,
  patchInstanceOpacity,
  patchMatcapBlend,
  patchRim,
  RIM_STRENGTH,
  SKY_FRAGMENT,
  TOON_RIM_KEY,
  type PatchableShader,
} from "../src/materials/index.ts";
import type { QualityTier } from "../src/types.ts";

const tex = () => new DataTexture(new Uint8Array(4), 1, 1);
function kit(tier: QualityTier) {
  const t = { ramp: tex(), matcapWarm: tex(), matcapCool: tex(), blob: tex() };
  return { t, m: createMaterialFactories(tier, t) };
}
function shaderOf(lib: {
  uniforms: object;
  vertexShader: string;
  fragmentShader: string;
}): PatchableShader {
  return { uniforms: {}, vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader };
}
function compile(
  material: { onBeforeCompile: (s: never, r: never) => void },
  lib: keyof typeof ShaderLib,
): PatchableShader {
  const s = shaderOf(
    ShaderLib[lib] as { uniforms: object; vertexShader: string; fragmentShader: string },
  );
  material.onBeforeCompile(s as never, {} as never);
  return s;
}

describe("toon (pieces)", () => {
  it("uses the 3-step ramp and the rim toy glow on mid/high only", () => {
    const low = kit("low");
    const a = low.m.makeToon({ color: "#F26B5B" });
    expect(a).toBeInstanceOf(MeshToonMaterial);
    expect(a.gradientMap).toBe(low.t.ramp);
    expect(a.userData["sgKind"]).toBe("toon");
    expect(a.color.getHexString()).toBe("f26b5b");
    const mid = kit("mid").m.makeToon();
    expect(mid.userData["sgKind"]).toBe("toon-rim");
    expect(mid.customProgramCacheKey()).toBe(TOON_RIM_KEY);
    expect(kit("high").m.makeToon({ rim: false }).userData["sgKind"]).toBe("toon");
    expect(low.m.makeToon({ rim: true }).userData["sgKind"]).toBe("toon-rim");
  });

  it("patches three's toon shader with pow(1 - N·V, 3) × 0.35 read from shared uniforms", () => {
    const { m } = kit("mid");
    const mat = m.makeToon();
    const s = compile(mat, "toon");
    expect(s.fragmentShader).toContain("uniform vec3 uRimColor;");
    expect(s.fragmentShader).toContain(
      "pow( 1.0 - saturate( dot( normal, normalize( vViewPosition ) ) ), 3.0 )",
    );
    expect(s.fragmentShader.indexOf("sgRim")).toBeLessThan(
      s.fragmentShader.indexOf("#include <opaque_fragment>"),
    );
    expect(s.uniforms["uRimColor"]).toBe(m.uniforms.uRimColor);
    expect(s.uniforms["uRimStrength"]).toBe(m.uniforms.uRimStrength);
    expect(m.uniforms.uRimStrength.value).toBe(RIM_STRENGTH);
    // Every rim toon shares one program: same key, same uniform objects.
    const other = m.makeToon({ color: "#5BA8F2" });
    expect(other.customProgramCacheKey()).toBe(mat.customProgramCacheKey());
    expect(compile(other, "toon").uniforms["uRimColor"]).toBe(s.uniforms["uRimColor"]);
  });

  it("refuses to patch a shader without the anchor chunk", () => {
    const u = createSharedUniforms();
    expect(() =>
      patchRim({ uniforms: {}, vertexShader: "", fragmentShader: "void main(){}" }, u),
    ).toThrow(/opaque_fragment/);
  });
});

describe("matcap (clay)", () => {
  it("blends warm and cool matcaps by a shared uniform (no texture swap, no recompile)", () => {
    const { m, t } = kit("low");
    const blend = m.makeMatcap();
    expect(blend).toBeInstanceOf(MeshMatcapMaterial);
    expect(blend.matcap).toBe(t.matcapWarm);
    expect(blend.customProgramCacheKey()).toBe(MATCAP_BLEND_KEY);
    const s = compile(blend, "matcap");
    expect(s.fragmentShader).toContain(
      "mix( texture2D( matcap, uv ), texture2D( uMatcapCool, uv ), uMatcapBlend )",
    );
    expect(s.uniforms["uMatcapCool"]?.value).toBe(t.matcapCool);
    m.setMatcapBlend(0.4);
    expect(s.uniforms["uMatcapBlend"]?.value).toBe(0.4);
    m.setMatcapBlend(7);
    expect(m.uniforms.uMatcapBlend.value).toBe(1);
    m.setMatcapBlend(-1);
    expect(m.uniforms.uMatcapBlend.value).toBe(0);
  });

  it("single-flavour variants use the stock program", () => {
    const { m, t } = kit("mid");
    const cool = m.makeMatcap({ variant: "cool" });
    expect(cool.matcap).toBe(t.matcapCool);
    expect(cool.userData["sgKind"]).toBe("matcap-cool");
    const warm = m.makeMatcap({ variant: "warm", color: new Color(1, 0, 0) });
    expect(warm.matcap).toBe(t.matcapWarm);
    expect(warm.color.r).toBe(1);
    expect(() =>
      patchMatcapBlend(
        { uniforms: {}, vertexShader: "", fragmentShader: "" },
        createSharedUniforms(),
      ),
    ).toThrow(/matcap/);
  });
});

describe("lambert + vertex-colour AO (room, table)", () => {
  it("turns vertex colours on by default", () => {
    const { m } = kit("low");
    const a = m.makeLambertVC({ color: "#C98E5B" });
    expect(a).toBeInstanceOf(MeshLambertMaterial);
    expect(a.vertexColors).toBe(true);
    expect(a.userData["sgKind"]).toBe("lambert-vc");
    expect(m.makeLambertVC({ vertexColors: false }).userData["sgKind"]).toBe("lambert");
  });

  it("bakes darker AO low down and on downward faces", () => {
    const g = bakeVertexAO(new BoxGeometry(1, 1, 1, 1, 2, 1));
    const c = g.getAttribute("color");
    const pos = g.getAttribute("position");
    const nrm = g.getAttribute("normal");
    let top = 0;
    let bottomSide = 1;
    let under = 1;
    for (let i = 0; i < c.count; i++) {
      const y = pos.getY(i);
      if (y > 0.49 && nrm.getY(i) > 0.9) top = Math.max(top, c.getX(i));
      if (y < -0.49 && Math.abs(nrm.getY(i)) < 0.1) bottomSide = Math.min(bottomSide, c.getX(i));
      if (nrm.getY(i) < -0.9) under = Math.min(under, c.getX(i));
    }
    expect(top).toBe(1);
    expect(bottomSide).toBeCloseTo(0.65, 5);
    expect(under).toBeLessThan(bottomSide);
    const flat = bakeVertexAO(new PlaneGeometry(1, 1), { strength: 0.5, underside: 0, falloff: 2 });
    expect(flat.getAttribute("color").getX(0)).toBeGreaterThan(0);
    const noNormals = new BoxGeometry();
    noNormals.deleteAttribute("normal");
    expect(bakeVertexAO(noNormals).hasAttribute("color")).toBe(true);
  });
});

describe("basic (sky planes, halos, confetti, shadows)", () => {
  it("builds the additive halo recipe", () => {
    const { m, t } = kit("low");
    const halo = m.makeBasic({ additive: true, map: t.blob, color: "#FFC26B", opacity: 0.8 });
    expect(halo).toBeInstanceOf(MeshBasicMaterial);
    expect(halo.blending).toBe(AdditiveBlending);
    expect(halo.transparent).toBe(true);
    expect(halo.depthWrite).toBe(false);
    expect(halo.opacity).toBe(0.8);
    expect(halo.map).toBe(t.blob);
    expect(m.makeBasic({ additive: true, depthWrite: true }).depthWrite).toBe(true);
    expect(m.makeBasic().userData["sgKind"]).toBe("basic");
  });

  it("applies options: opacity < 1 implies transparent unless told otherwise", () => {
    const a = new MeshBasicMaterial();
    applyOptions(a, { opacity: 0.5 });
    expect(a.transparent).toBe(true);
    const b = new MeshBasicMaterial();
    applyOptions(b, { opacity: 0.5, transparent: false, vertexColors: true, map: null });
    expect(b.transparent).toBe(false);
    expect(b.vertexColors).toBe(true);
    applyOptions(b, undefined);
    expect(b.opacity).toBe(0.5);
  });
});

describe("sky", () => {
  it("is an unlit back-face gradient with uniforms for a no-recompile mode lerp", () => {
    const sky = makeSkyMaterial({ top: "#9FD3F2", bottom: "#FDEBD3", stars: 0.5 });
    expect(sky).toBeInstanceOf(ShaderMaterial);
    expect(sky.side).toBe(BackSide);
    expect(sky.depthWrite).toBe(false);
    expect(sky.fog).toBe(false);
    expect(sky.uniforms.uTop.value.getHexString()).toBe("9fd3f2");
    expect(sky.uniforms.uStars.value).toBe(0.5);
    expect(SKY_FRAGMENT).toContain("#include <colorspace_fragment>");
    expect(SKY_FRAGMENT).toContain("smoothstep( uLow, uHigh, d.y )");
    const def = kit("low").m.makeSky();
    expect(def.uniforms.uTop.value.getHexString()).toBe("f6a58b"); // Golden Hour default
    expect(def.uniforms.uStars.value).toBe(0);
  });
});

describe("blob shadows", () => {
  it("tints the shared blob with the shadow token, no depth write, polygon offset", () => {
    const { m, t } = kit("low");
    const b = m.makeBlobShadow({ color: "#6B4F6E", opacity: 0.28 });
    expect(b.map).toBe(t.blob);
    expect(b.transparent).toBe(true);
    expect(b.depthWrite).toBe(false);
    expect(b.polygonOffset).toBe(true);
    expect(b.opacity).toBe(0.28);
    expect(b.color.getHexString()).toBe("6b4f6e");
    expect(makeBlobShadowMaterial({ map: new Texture() }).opacity).toBe(0.32);
  });

  it("reads per-instance opacity from aOpacity when instanced", () => {
    const { m } = kit("mid");
    const b = m.makeBlobShadow({ instanced: true });
    expect(b.customProgramCacheKey()).toBe(BLOB_INSTANCED_KEY);
    const s = compile(b, "basic");
    expect(s.vertexShader).toContain("attribute float aOpacity;");
    expect(s.vertexShader).toContain("vSgOpacity = aOpacity;");
    expect(s.fragmentShader).toContain("diffuseColor.a *= vSgOpacity;");
    expect(() =>
      patchInstanceOpacity({ uniforms: {}, vertexShader: "", fragmentShader: "" }),
    ).toThrow(/blob/);
  });
});

describe("shared uniforms", () => {
  it("setRimColor writes into the shared colour (lerped by the mode system)", () => {
    const { m } = kit("high");
    const c = m.uniforms.uRimColor.value;
    m.setRimColor("#DDEEFF");
    expect(m.uniforms.uRimColor.value).toBe(c);
    expect(c.getHexString()).toBe("ddeeff");
    expect(m.tier).toBe("high");
  });
});
