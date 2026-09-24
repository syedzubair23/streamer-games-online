# 04 — Performance Engineering Rules (three.js, low-end first)

> Scope: engineering rules for rendering, bundling, physics, networking, input, power and perf testing for a browser party-games platform that has to run on low-end Android phones, school Chromebooks (Celeron/MediaTek, 4 GB RAM, integrated GPU) and on a streamer's PC while OBS is encoding at the same time.
> Status: research + opinionated recommendations, September 2026. three.js is at **r186** (released 2026-09-24).

---

## 0. TL;DR: the 15 rules

1. **Renderer: `WebGLRenderer` (WebGL2) only.** No WebGPU for v1. Revisit in 2027.
2. **Only render when something changes.** Board and turn-based games render on demand. Ambient "modes" (rain, dusk) run at a capped 30 fps and switch off when the tab is hidden.
3. **Draw calls:** ≤ **60** per frame on the low tier, ≤ 150 on high. Hard fail in CI at 100 for a game's low-tier scene.
4. **Triangles:** ≤ **50k** visible on low, ≤ 150k on high.
5. **Pieces that repeat use `InstancedMesh`.** Static decor gets merged at load time (`mergeGeometries`) or goes into a `BatchedMesh`.
6. **Materials:** `MeshMatcapMaterial` / `MeshLambertMaterial` / `MeshToonMaterial` / `MeshBasicMaterial` + baked lighting. **Never `MeshStandardMaterial`/`MeshPhysicalMaterial` on low tier.**
7. **No real-time shadow maps on low tier.** Blob shadows (a textured quad under each piece, instanced). On high tier, at most one 1024² directional shadow map, with `autoUpdate=false` and re-rendered only when pieces move.
8. **DPR:** clamp to `min(devicePixelRatio, 1.5)` on mobile and `min(dpr, 2)` on desktop, with **dynamic resolution** driven by frame time (0.5×–1.0× of the clamp).
9. **No post-processing on low tier.** On high tier, one combined pass at most (vignette + grade + optional FXAA). No bloom/SSAO chains.
10. **Textures:** KTX2 (Basis UASTC/ETC1S), ≤ 1024² per texture on low tier, ≤ **24 MB of GPU texture memory per game**, and one shared atlas per game.
11. **Bundle:** platform shell ≤ **180 KB gz** JS (three core included). Each game is a **lazy chunk ≤ 60 KB gz** of JS + ≤ 1.5 MB of assets. First-game interactive in **< 3 s on "Slow 4G" + 4× CPU throttle**.
12. **Physics:** custom deterministic 2D circle/segment physics (~4 KB) for all flick/slide dexterity games, run **server-authoritative** with a client replay. Load `@dimforge/rapier3d-compat` lazily, and only for a real 3D stacking game (if one survives curation).
13. **Network:** JSON for turn-based and lobby messages (they are rare and small). Binary quantized snapshots + deltas for real-time games. The server aggregates audience votes and broadcasts at ≤ 4 Hz.
14. **Tab hidden → stop rendering, drop the socket send rate, and pause audio contexts.** `visibilitychange` is the source of truth.
15. **Perf harness in CI:** Playwright + CDP CPU throttling (4× / 6×), a frametime percentile logger, and `renderer.info` assertions per game. Numbers go on a dashboard, and regressions fail the PR.

---

## 1. Renderer choice: WebGL2 vs WebGPU (r186)

**Facts (September 2026):**
- three.js ships `WebGPURenderer`. It uses WebGPU when available and **automatically falls back to a WebGL2 backend** otherwise. Materials must be node/TSL-based to work on both ([three.js manual: WebGPURenderer](https://threejs.org/manual/en/webgpurenderer.html), [docs](https://threejs.org/docs/pages/WebGPURenderer.html)).
- Global WebGPU support is quoted at roughly 87% ([Utsubo, 100 tips, 2026](https://www.utsubo.com/blog/threejs-best-practices-100-tips)). The missing ~13% is **exactly our audience**: older Android, locked-down school Chromebooks on managed Chrome channels, iOS/Safari edge cases, and blocklisted GPU drivers.
- Since r181, the `WebGPURenderer` has a built-in Inspector. stats-gl broke on WebGPU in r181 ([forum](https://discourse.threejs.org/t/webgpu-r181-fyi-stats-gl-no-longer-compatible-with-webgpu/87944)). The tooling is still settling.
- Latest releases: r183 (Feb 2026), r184 (Apr), r185 (Jul), r186 (Sep 24) ([releases](https://github.com/mrdoob/three.js/releases)).

**Decision: `WebGLRenderer` with WebGL2 for v1.**
- Our scenes are simple (a board, pieces, a room). WebGPU's wins are in compute and in very high draw-call scenes, and we never have those.
- `WebGPURenderer` plus the node system pulls in more code (the TSL node library), and its WebGL2 fallback path is less battle-tested on bad drivers than `WebGLRenderer`, which has had a decade of hardening.
- Shader compile hitches matter more to us than peak throughput.
- **Keep a migration path open:** no `onBeforeCompile` hacks in shared materials. Keep all custom shading in 3–4 platform material factories (`makeMatcap()`, `makeToon()`, `makeGround()`, `makeSky()`) so they can be ported to TSL in one place later.
- Pin the three version (`"three": "0.186.x"`), and upgrade on purpose once per quarter.

```ts
const renderer = new WebGLRenderer({
  canvas,
  antialias: tier !== 'low',        // MSAA off on low tier; FXAA-lite or nothing
  powerPreference: 'default',       // NOT 'high-performance': that drains laptop battery and breaks dual-GPU OBS setups
  stencil: false,
  depth: true,
  alpha: false,                     // opaque canvas = cheaper compositing
  preserveDrawingBuffer: false,
});
renderer.outputColorSpace = SRGBColorSpace;
renderer.toneMapping = NoToneMapping; // grade in the baked textures/matcaps instead
```

If `canvas.getContext('webgl2')` fails, show a **2D DOM fallback** for turn-based games (every board game's state is renderable as SVG/DOM) rather than a crash screen. This is cheap to build because game logic is renderer-agnostic (see §9).

---

## 2. Device tiers and quality presets

Detect once at boot, then adapt at runtime (§4).

| Tier | Detection heuristic | DPR clamp | MSAA | Shadows | Post | Ambient FPS cap | Tri budget | Draw calls |
|---|---|---|---|---|---|---|---|---|
| **low** | `navigator.hardwareConcurrency <= 4` OR `deviceMemory <= 4` OR mobile UA + `max(screen) * dpr > 2000`, OR the boot micro-benchmark is > 8 ms | 1.0–1.25 | off | blob only | none | 30 | 50k | 60 |
| **mid** | default | 1.5 | 2× (if cheap) | blob + optional contact | vignette/grade | 30 | 100k | 100 |
| **high** | desktop, ≥ 8 cores, benchmark < 3 ms | 2.0 | 4× | 1 × 1024² dir map | 1 combined pass | 60 | 150k | 150 |

- Budgets follow the common guidance of "~100 draw calls on mobile, <100k vertices" ([Utsubo](https://www.utsubo.com/blog/threejs-best-practices-100-tips), [Three.js Roadmap: draw calls](https://threejsroadmap.com/blog/draw-calls-the-silent-killer)). Mobile draw calls cost ~0.1 ms of CPU each, so 200 draws already blow a 16.6 ms frame. We target lower because **the streamer's PC is also running OBS + game capture + browser source**, and Chromebooks are CPU-bound.
- **Boot micro-benchmark** (≈150 ms, runs while the lobby loads): render 20 frames of a representative scene offscreen and take the median frametime. `WEBGL_debug_renderer_info` GPU strings are unreliable and deprecated in Firefox/Safari, so use them only as a tiebreaker.
- Users and hosts can override the tier (Settings → Graphics: Battery / Balanced / Pretty). **Browser-source/OBS mode** (a `?obs=1` URL param) forces a fixed 1080p internal resolution, 60 fps and high tier. It is the one place we spend GPU, because it is what viewers see.

---

## 3. Scene construction rules

### 3.1 Draw calls
- **Every repeated piece is an `InstancedMesh`**: Ludo tokens (16 → 1–4 draws, one per color, or 1 draw with `instanceColor`), chess pieces (6 geometries → 6 draws, colored through `setColorAt`), cards (1 draw), tiles, dice, confetti particles, blob shadows (1 draw).
- **Varied static geometry sharing one material** → `BatchedMesh` (r159+, multi-draw) or merge at load with `BufferGeometryUtils.mergeGeometries` ([bersus.io: instancing & batching](https://bersus.io/insights/creative-dev/threejs-optimizing-instancing-and-batching/), [Codrops: instances](https://tympanus.net/codrops/2025/07/10/three-js-instances-rendering-multiple-objects-simultaneously/)).
- **The room/environment ("cozy lofi desk/table")** is authored as **one mesh with one atlas + baked lightmap**, plus separate instanced props where needed. Target: environment ≤ 8 draws.
- **Board = 1 mesh**, with the grid/art in the texture (not 64 chess squares as meshes).
- **Picking without per-object meshes:** raycast against `InstancedMesh` (it supports `instanceId`), or better for boards, **analytic picking**: intersect the ray with the board plane → `(file, rank)` → piece lookup. That is O(1) and allocates nothing.
- **Text/UI goes in DOM/CSS overlays, not in WebGL.** Names, timers, chat, vote bars and leaderboards are HTML on top of the canvas: crisp at any DPR, accessible, free of draw calls, and animated with CSS transforms/opacity only (compositor-thread). For 3D-anchored labels (a name above a token), project to screen space once per rendered frame and set `transform: translate3d()`.
- **Frustum culling** stays on (the default). Set `frustumCulled=false` only on instanced meshes whose bounds you don't update, or call `computeBoundingSphere()` after moving instances.
- **`matrixAutoUpdate = false`** on everything static. Call `updateMatrix()` once.

### 3.2 Geometry
- Low-poly by art direction (it fits cozy/soft). Piece LOD: chess pieces ≤ 1.5k tris each on high and ≤ 600 on low (swap geometry per tier; no runtime LOD switching needed on a fixed camera).
- glTF with **meshopt compression** (`EXT_meshopt_compression` + quantization) instead of Draco. The meshopt decoder is ~6 KB gz vs Draco's ~300 KB wasm/js, and it decodes faster. Use `gltf-transform optimize --compress meshopt --texture-compress ktx2`.
- Smooth shading with normals baked in. Fake rounded bevels with a matcap, not with geometry.

### 3.3 Materials (the cozy look, cheap)

| Material | Per-pixel cost | Use for |
|---|---|---|
| `MeshBasicMaterial` + baked lightmap | lowest | environment, board, sky, anything static |
| `MeshMatcapMaterial` | very low (1 tex lookup, no lights) | **default for pieces**: gives the soft clay/ceramic lofi look for free, and a matcap swap = ambient mode swap |
| `MeshLambertMaterial` | low (per-fragment Lambert since r151ish, no specular) | pieces that must react to a moving light (e.g. a lamp at night) |
| `MeshToonMaterial` | low (gradient map ramp) | stylized characters/avatars, and the "cel" soft look with a 3–4 step gradient |
| `MeshStandardMaterial` | high (PBR, env map, many lights) | **banned on low/mid**. High tier only for a hero object, if at all |
| `MeshPhysicalMaterial` | very high | **banned** |

- **Ambient modes (day/dusk/night/rain) swap uniforms, not scenes:** a matcap texture set per mode (4 small 256² matcaps), the lightmap intensity/tint via a single shared uniform (`uAmbientTint`), sky gradient colors and fog color. Crossfade the modes over 1.5 s by lerping the uniforms and blending two matcaps in a tiny custom `ShaderMaterial` or `onBeforeCompile`-free node. No re-compilation during the switch: **pre-warm with `renderer.compile(scene, camera)`** at game load.
- **Rain** is one instanced quad-streak mesh (≤ 400 instances on low) animated in the vertex shader from `uTime` (no CPU per-drop updates), plus a CSS/DOM "window droplets" overlay. It stays at 30 fps.
- Keep the **total distinct shader programs per game ≤ 10** (check `renderer.info.programs.length`). Every program is a compile hitch on Chromebooks.
- `transparent: true` only where needed (it sorts and overdraws). Use alpha-test/cutout (`alphaTest=0.5`) for foliage/decals, and `depthWrite=false` for blob shadows.

### 3.4 Shadows
- **Low/mid tier: blob shadows.** One `InstancedMesh` of quads with a radial-gradient texture, positioned under each piece and scaled/faded by height (e.g. a jumping token). Cost: 1 draw call total. This is also the most "cozy" look: soft and never aliased.
- **Board-game contact shadows are baked** into the board lightmap for static decor.
- **High tier (optional):** one `DirectionalLight` shadow at 1024² `PCFSoftShadowMap` (512–1024 is the mobile guidance and 1024–2048 the desktop guidance, per [Utsubo](https://www.utsubo.com/blog/threejs-best-practices-100-tips)). Set `renderer.shadowMap.autoUpdate = false` and `renderer.shadowMap.needsUpdate = true` **only on frames where a piece moved**. Tight shadow-camera frustum around the board only.
- **Never use point-light shadows** (a cube map = 6 extra renders).

### 3.5 Textures
- **KTX2/Basis Universal** for everything that isn't UI. ETC1S for color/albedo (smallest), UASTC for normal-ish/matcap where quality shows. KTX2 uses 4–8× less VRAM than decoded PNG/JPG ([Utsubo](https://www.utsubo.com/blog/threejs-best-practices-100-tips)). A 2048² PNG costs ~21 MB of VRAM with mips, whatever its size on disk.
- **Budgets per game:** ≤ 24 MB GPU texture memory on low, ≤ 64 MB on high. Max dimension 1024² on low and 2048² on high (serve two KTX2 variants, `@1x`/`@2x`, chosen by tier).
- **One atlas per game** for pieces/props. The environment has its own atlas + lightmap, **shared across all games** (the "room" is a platform asset and stays cached).
- Mipmaps on. `anisotropy` = 1 on low and 4 on high.
- Transcoder (`basis_transcoder.wasm`, ~200 KB) is loaded once by the shell and cached (service worker).
- **Dispose on game unload:** `geometry.dispose()`, `material.dispose()`, `texture.dispose()`, and `renderer.renderLists.dispose()`. Assert in dev that `renderer.info.memory.textures/geometries` return to the shell baseline after leaving a game (a leak detector in the harness).

### 3.6 Post-processing
- Low: none. Do the color grade in the textures/matcaps. A vignette can be a **CSS radial-gradient overlay** (compositor-only).
- Mid/high: **a single custom fullscreen pass** (grade + vignette + subtle grain + optional FXAA) rendered from a half-float target. Skip `EffectComposer` chains, and skip bloom entirely (bloom's mip chain is the #1 perf killer on integrated GPUs). Fake glows with additive sprite billboards.

---

## 4. Resolution: DPR clamp + dynamic resolution

```ts
// quality.ts
const DPR_CLAMP = isMobile ? 1.5 : 2.0;            // per tier: low=1.0/1.25
let scale = 1.0;                                    // dynamic factor, 0.5..1.0
const TARGET_MS = 1000 / targetFps;                 // 33.3 (30fps) or 16.7 (60fps)
const ft = new Float32Array(30); let i = 0;         // ring buffer of GPU-ish frame times

export function onFrame(dtMs: number) {
  ft[i++ % 30] = dtMs;
  if (i % 30 !== 0) return;                          // evaluate every 30 rendered frames
  const p90 = percentile(ft, 0.9);
  if (p90 > TARGET_MS * 1.15 && scale > 0.5)  setScale(scale - 0.1);   // down fast
  else if (p90 < TARGET_MS * 0.7 && scale < 1.0) setScale(scale + 0.05); // up slow (hysteresis)
}
function setScale(s: number) {
  scale = Math.round(s * 20) / 20;                   // quantize → avoid realloc thrash
  renderer.setPixelRatio(Math.min(devicePixelRatio, DPR_CLAMP) * scale);
  renderer.setSize(w, h, false);
}
```

Rules:
- **Clamp first, then scale dynamically.** Rendering at a DPR of 3 on a phone means 9× the pixels of DPR 1 for almost no visible gain on a small canvas.
- **Measure with the rAF delta only on frames you actually render** (render-on-demand frames are sparse, so don't feed idle gaps into the controller). Ignore the first 60 frames after a game load or a mode switch (shader compile hitches).
- **Asymmetric hysteresis:** step down after 1 bad window, and step up only after 3 good windows. Never change more than once per second (a canvas resize reallocates the framebuffers).
- **Floor at 0.5.** If the game is still over budget at 0.5, drop a tier: turn off MSAA, then ambient particles, then the high shadow map. Log a `quality_downgrade` telemetry event.
- The **OBS/browser-source mode** disables dynamic resolution (fixed output), because stream viewers need a stable image.
- Keep the UI crisp regardless: DOM overlays render at native DPR even when WebGL is at 0.6×.

---

## 5. Render loop: on-demand and tab-aware

Most of our catalog (Ludo, Chess, card/party/drawing/trivia games) is **idle more than 90% of the time**. Rendering 60 fps of an unchanged board burns the battery of every phone in a 20-person room and heats the Chromebooks.

```ts
// loop.ts — single platform-owned loop; games never call rAF themselves
let needsRender = true, activeAnimations = 0, rafId = 0;
let ambientFps = tier === 'high' ? 60 : 30, lastAmbient = 0;

export const invalidate = () => { needsRender = true; kick(); };
export const beginAnim = () => { activeAnimations++; kick(); };   // tweens call begin/end
export const endAnim   = () => { activeAnimations--; };

function kick() { if (!rafId && !document.hidden) rafId = requestAnimationFrame(tick); }

function tick(now: number) {
  rafId = 0;
  const ambientDue = ambientOn && now - lastAmbient >= 1000 / ambientFps - 1;
  if (needsRender || activeAnimations > 0 || ambientDue) {
    if (ambientDue) lastAmbient = now;
    updateTweens(now); renderer.render(scene, camera); needsRender = false;
    quality.onFrame(now - prev); prev = now;
  }
  if (activeAnimations > 0 || ambientOn) rafId = requestAnimationFrame(tick);
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { cancelAnimationFrame(rafId); rafId = 0; audioCtx.suspend(); net.setBackground(true); }
  else { audioCtx.resume(); net.setBackground(false); invalidate(); }
});
```

Rules:
- **One loop owned by the platform.** Games get `invalidate()`, `beginAnim()/endAnim()` and a tween helper. They never call `requestAnimationFrame` directly (lint rule: `no-restricted-globals`).
- **Idle cost target: 0 renders/s** with ambient off, and ≤ 30 renders/s with ambient on (low/mid). **Ambient "breathing"** (steam from a mug, drifting dust, rain) is a *host-togglable* setting and defaults to **on for the host/OBS view, and off for player phones in Battery mode**.
- Real-time games (air hockey, racing, reaction) declare `mode: 'continuous'` in their manifest, and the loop runs every rAF while that game is active.
- **Tab hidden:** rAF already pauses in background tabs. Also suspend the `AudioContext`, stop any `setInterval`-driven work, and tell the server "background" (it stops sending cosmetic events like cursor/emote streams to this client and sends only authoritative state). On return, request a full snapshot rather than replaying missed deltas.
- **Throttle `resize`** events via `ResizeObserver` → apply on the next rAF only.
- **Zero per-frame allocations** in hot paths: reuse `Vector3`/`Matrix4` scratch objects and preallocate the tween pool. GC pauses on Chromebooks are 10–30 ms hitches.
- Prefer `renderer.setAnimationLoop(null)`, meaning our own rAF, so we control on-demand rendering.

---

## 6. Bundling, tree-shaking and code-splitting

### 6.1 Toolchain
- **Vite (Rollup) + TypeScript**, `build.target: 'es2020'`, `build.modulePreload: { polyfill: false }`, and brotli + gzip precompression at the CDN.
- `import { WebGLRenderer, Scene, ... } from 'three'`. Named imports only; **never `import * as THREE`** (lint rule). Import addons from `three/addons/...` individually (`BufferGeometryUtils`, `GLTFLoader`, `KTX2Loader`, `MeshoptDecoder`).
- Reality check: `WebGLRenderer` pulls in most of the core (all built-in material shader chunks are string modules referenced by `ShaderLib`). Tree-shaking gets you from ~530 KB to ~320 KB minified in simple apps ([mattdesl/threejs-tree-shake](https://github.com/mattdesl/threejs-tree-shake)). Expect **three core ≈ 120–150 KB gz** in practice. That is acceptable because it is **loaded once and cached** for every game.
- Run `rollup-plugin-visualizer` and **`size-limit` in CI** on every PR.

### 6.2 Bundle budgets (gzip; brotli is ~15% smaller)

| Chunk | Budget | Contents |
|---|---|---|
| `shell` (critical) | **≤ 180 KB** | router, lobby UI, WebSocket client, three core, loop, quality, platform materials, tween lib, input |
| `room-env` assets | ≤ 1.2 MB | shared cozy room glTF (meshopt) + KTX2 atlas/lightmaps + 4×matcap sets. Cached by the service worker |
| `game-<id>` JS | **≤ 60 KB** each | game rules (shared with server), view, UI panels |
| `game-<id>` assets | ≤ 1.5 MB low / 3 MB high | pieces glTF, atlas, SFX (Opus/WebM, mono, 48–64 kbps) |
| `physics-2d` | ≤ 5 KB | custom solver, shared by the dexterity games |
| `rapier3d-compat` | ~500 KB+ gz (wasm inlined) | **only** if a 3D stacking game ships; lazily loaded by that one game |
| `basis_transcoder` | ~200 KB | loaded once, SW-cached |

**Load-time targets** (Playwright, "Slow 4G" + 4× CPU throttle, cold cache): lobby interactive < 2.5 s. First game playable < 3.0 s after "Start". Switching between games (warm shell) < 1.2 s. Warm-cache game switch < 400 ms.

### 6.3 Each game is a lazy chunk with a manifest

```ts
// games/registry.ts — the shell only knows manifests (tiny, eagerly bundled)
export const games = {
  ludo:  { title: 'Ludo',  mode: 'on-demand',  players: [2, 4], load: () => import('./ludo/index') },
  chess: { title: 'Chess', mode: 'on-demand',  players: [2, 2], load: () => import('./chess/index') },
  airhockey: { title: 'Air Hockey', mode: 'continuous', players: [2, 2], physics: '2d',
               load: () => import('./airhockey/index') },
} satisfies Record<string, GameManifest>;
```

- A host's room config lists the enabled games. The shell **prefetches the next queued game's chunk + assets** during the current round's results screen (`<link rel="modulepreload">` + `fetch` with `priority: 'low'`), so transitions feel instant (part of the "AAA polish").
- A **service worker** (Workbox) caches the shell, the room environment and every game a user has played. Versioned asset URLs (content hashes) make updates safe.
- **Games must not import other games.** Shared code lives in `@platform/*`. An ESLint boundary rule plus a chunk-graph check in CI (no game chunk may contain another game's module) enforce this.
- Game rules (pure TS, zero three imports) live in `games/<id>/rules.ts` and are **imported by both server and client**. That is one source of truth, and it enables the DOM fallback and headless tests.

---

## 7. Physics for dexterity games

Candidate dexterity games (subject to the curation doc): carrom/crokinole-style flicking, shuffleboard/curling, air hockey, mini-golf (top-down), billiards-lite, coin-push, and maybe a "Jenga" stacker.

**Key insight:** nearly all engaging tabletop dexterity games are **2D physics on a plane with a 3D presentation**: discs, pucks and balls sliding on a table. Only stacking games (Jenga, tower building) need true 3D rigid-body physics.

### Options

| Option | Size (gz) | Pros | Cons | Verdict |
|---|---|---|---|---|
| **Custom 2D circles + static segments/arcs** | ~3–5 KB | Tiny, fully deterministic (fixed timestep, no sleeping heuristics we don't control), trivially runs in Node for server authority, easy to tune "feel" | We write/maintain it (~400 LOC: integrate, broadphase grid, circle-circle + circle-segment impulses, restitution, rolling friction) | **Primary choice** |
| Planck.js (Box2D port) | ~60 KB | Robust, polygons, joints, deterministic-ish in JS | Heavier; more than we need | Fallback if we need polygons/joints |
| Matter.js | ~80 KB | Popular | Not deterministic, jittery stacking, slower | No |
| cannon-es | ~50 KB | Pure JS 3D, sync init | Community-maintained, slower than Rapier, unstable stacking | No |
| Rapier (`@dimforge/rapier2d/3d-compat`) | ~500 KB gz wasm ([abratabia](https://www.abratabia.com/game-physics/best-web-physics-engine.php)) | Fastest, stable stacking, **cross-platform deterministic** build available, SIMD builds 2–5× faster than 2024 | Big download, async wasm init, `-compat` base64 inlining for bundlers ([npm rapier2d-compat](https://www.npmjs.com/package/@dimforge/rapier2d-compat)) | **Only** for a true 3D stacking game, lazily loaded in that game's chunk |

Sources: [abratabia: best web physics engine](https://www.abratabia.com/game-physics/best-web-physics-engine.php), [mysimulator: cannon-es vs rapier vs ammo](https://www.mysimulator.uk/content/references/physics-engines-comparison.html), [three.js forum: Rapier vs Cannon](https://discourse.threejs.org/t/rapier-vs-cannon-performance/53475), [Rapier JS getting started](https://rapier.rs/docs/user_guides/templates/getting_started_js/).

### Authority model

**Turn-based dexterity games (carrom, crokinole, shuffleboard, curling, mini-golf, billiards)** use the "shot" model:
1. The client aims locally (a pure visual preview: trajectory line from the first-bounce raycast only, no full sim, to prevent "aimbot" previews).
2. The client sends `{shot: angle, power, spin}` (≈8 bytes).
3. The **server simulates the whole shot** with the same custom solver at a fixed 120 Hz step until everything is at rest (typically < 5 ms CPU).
4. The server broadcasts `{shot, seed, finalState}`. All clients **replay the same deterministic sim locally** for the animation and then **snap to `finalState`** (it corrects any float drift; with integer/fixed-point or careful ordering there is none).
5. Spectators and the stream view get identical animations with ~zero bandwidth. This is ideal for the audience: an instant replay is just a re-run.

- Determinism tips: a fixed timestep, no `Math.random` in the sim (seeded PRNG), stable iteration order, avoid `Math.sin/cos/pow` in the core loop (use precomputed tables/fixed values), or run in **fixed-point integers** (e.g. 1 unit = 1/1024 mm) for guaranteed cross-device identity.

**Real-time dexterity (air hockey, bumper discs):**
- **Server-authoritative** at 30–60 Hz sim, snapshots at 20 Hz.
- The client **predicts its own mallet** (input → immediate local move) and **interpolates** the puck and the opponent 100 ms behind. Short-horizon puck extrapolation only on local collision with your own mallet, with server reconciliation on the next snapshot.
- Keep real-time games to **2 active players + audience**. Real-time over WebSocket/TCP with 20 players on school Wi-Fi is a recipe for a bad stream moment.

**3D stacking (if kept):** Rapier3D, client-simulated by the **active player only**. Stream the rigid-body transforms of the moved + touched blocks (quantized) at 20 Hz to others. The server validates only coarse outcomes (a tower fell = height dropped / blocks on the floor). Accept that it is not cheat-proof; it's a party game.

---

## 8. Networking: message size and cadence

### 8.1 Format
- **Lobby, chat, turn-based moves, votes (client→server):** JSON. Messages are rare (≤ 1/s per user) and small, and JSON is debuggable. Keep keys short in hot messages (`{t:'mv',f:12,to:28}`).
- **Real-time state (server→client snapshots):** **binary** (`ArrayBuffer` + `DataView`), with a 1-byte message type, a 2-byte sequence number and quantized fields:
  - Position on a 2D table: `int16` per axis (1/32 mm is plenty) = 4 bytes/object instead of ~40 bytes of JSON.
  - Angle: `uint16` (0–65535 → 0–2π). Velocity: `int16` if needed for extrapolation.
  - Air hockey snapshot: 3 objects × 6 bytes + a 4-byte header = **22 bytes** at 20 Hz ≈ 0.44 KB/s per client.
- **Delta state:** send only fields that changed since the last **acked** snapshot (a bitmask header). Full snapshot on join/reconnect/tab-return. For turn-based games the "delta" is simply the move event; clients apply it through the shared `rules.ts`.
- **Server framework option:** Colyseus's `@colyseus/schema` does binary delta encoding out of the box (and has room/lobby concepts). This is worth adopting to avoid writing serialization by hand. The alternative is a hand-rolled `ws`/uWebSockets.js server with the shared rules. Either works; decide in the architecture doc.
- **Enable `permessage-deflate` only for large, rare messages** (full snapshots, leaderboards) or disable it. Per-message compression costs CPU on both ends and hurts tiny high-frequency binary frames. uWebSockets.js's shared compressor is a good middle ground.

### 8.2 Audience scale (the streamer-specific part)
A stream can bring 500–5,000 audience members into one room. Rules:
- **The audience never receives per-user events.** The server aggregates votes/predictions/reactions and broadcasts **tallies at ≤ 4 Hz** (e.g. `[votesA, votesB, votesC]` as 3 × uint16).
- Reactions/emotes: clients send them, and the server buckets them per 250 ms and broadcasts `{emoteId: count}`. The client renders a *representative* number of floating emotes (cap 30 on screen, instanced sprites), not one per event.
- **Rate-limit client→server** per connection (token bucket: 5 msgs/s for audience, 20 msgs/s for players, 60/s for a real-time mallet).
- Audience clients get game state at a reduced rate (turn-based: same events; real-time: 10 Hz snapshots, interpolated 200 ms behind). The stream (OBS) view is itself just a privileged spectator client.
- Consider a **fan-out tier** (Redis pub/sub or a dedicated broadcaster process) once rooms exceed ~2k sockets. Keep player sockets and audience sockets on separate channels so an audience flood never delays player input.

### 8.3 Resilience
- Heartbeat at 10 s, auto-reconnect with exponential backoff + jitter, resume token → the server replays the full snapshot.
- Show connection quality in the UI (latency dot). On mobile, a `visibilitychange` to hidden lets the OS kill the socket, so reconnect silently on resume.

---

## 9. Input (touch-first)

- **Pointer Events only** (`pointerdown/move/up/cancel`), with `touch-action: none` on the canvas and `setPointerCapture` on drag start. This handles mouse, touch and pen uniformly.
- **Hit targets ≥ 44×44 CSS px** (Apple HIG) / 48 dp (Material). On small boards (Ludo on a phone), use **snap-to-nearest legal move**: tap anywhere near a movable token and the closest legal token highlights, then tap again or confirm. Also offer **tap-to-select, tap-destination**, never drag-only.
- **Flick/aim gestures** (carrom, shuffleboard) use pull-back slingshot aiming with a dead zone (8 px) and a power curve clamped to screen size. Sample velocity from the last 60 ms of pointer history (coalesced events: `getCoalescedEvents()` where available). Provide a **"confirm shot" button alternative** for accessibility and imprecise touch.
- Keep `pointermove` handlers cheap: store the latest position and process it inside the rAF tick. Mark listeners `{ passive: true }` wherever `preventDefault` isn't needed.
- Disable double-tap zoom (`touch-action: manipulation` on UI buttons), long-press context menus on the canvas (`contextmenu` preventDefault) and text selection on game UI (`user-select: none`).
- **Haptics:** `navigator.vibrate(10)` on Android for dice rolls/captures, behind a setting. It silently no-ops on iOS.
- Respect `prefers-reduced-motion`: shorten camera moves, disable screen shake and use crossfades instead of flies.
- The keyboard is fully supported on Chromebooks (arrow keys/Enter move a board cursor). This matters for schools and accessibility.

---

## 10. Battery, thermals and the streamer's machine

- **Idle = zero GPU work** (render on demand, §5). This is the biggest battery win by far.
- Ambient effects cap at **30 fps** on all non-high tiers. Players' phones show ambient "lite" (sky/lighting tint only, no particles) in Battery mode.
- `powerPreference: 'default'`. `'high-performance'` forces the dGPU on laptops (battery) and can put the browser on a different GPU than OBS's capture, causing copies/stutter.
- **Thermal-throttle detection:** if p90 frametime degrades steadily over 5+ minutes at constant scene complexity, step quality down pre-emptively. Low-end phones throttle 30–50% after ~10 min.
- **Audio:** one `AudioContext`, SFX pre-decoded to `AudioBuffer`s (short, mono), and a lofi music bed as a single streamed `<audio>` element (hardware-decoded, cheaper than a WebAudio decode). Suspend on hidden.
- **Timers:** no `setInterval` for animation. Game clocks are rendered from `serverTime - startTime` in the DOM at 4 Hz (a text update), not per frame.
- **Streamer PC budget:** the host/OBS view must hold 60 fps using **< 25% of one CPU core and < 20% GPU** on a GTX 1060 / Iris Xe class machine *while* OBS encodes. Test with OBS actually running (§11).

---

## 11. Perf test harness

### 11.1 In-app instrumentation (dev + `?perf=1` in prod)
```ts
// perf/hud.ts — overlay + logger (tree-shaken out unless flag/dev)
const info = renderer.info;           // set info.autoReset = false and reset() per frame if using multiple passes
function sample(frameMs: number) {
  log.push({
    t: performance.now(), frameMs,
    calls: info.render.calls, tris: info.render.triangles,
    geoms: info.memory.geometries, texs: info.memory.textures,
    programs: info.programs?.length ?? 0,
    dpr: renderer.getPixelRatio(), heapMB: (performance as any).memory?.usedJSHeapSize / 1e6,
  });
}
```
- Report **p50/p90/p99 frametime**, % of frames > 33 ms ("jank"), and the long-task count (`PerformanceObserver({type:'longtask'})`), not average FPS. On on-demand games, measure only during animations (a dice roll + token move is the canonical test animation).
- **stats-gl** ([github](https://github.com/RenaudRohlinger/stats-gl)) for the live dev HUD with GPU timings on WebGL (`EXT_disjoint_timer_query_webgl2` where supported). Note it broke on WebGPU in r181, which is irrelevant for us on WebGL.
- **Spector.js** for frame captures when draw counts look wrong.
- `window.__perf.dump()` exports JSON for bug reports. The **host can enable "Perf overlay"** in room settings to diagnose viewer complaints live.

### 11.2 Automated CI (Playwright + Chrome DevTools Protocol)
```ts
// e2e/perf/ludo.perf.spec.ts
test('ludo low-tier budget', async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });                 // ~Chromebook
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150,
        downloadThroughput: 1.6e6 / 8, uploadThroughput: 750e3 / 8 });            // Slow 4G
  await page.setViewportSize({ width: 412, height: 915 });                          // Pixel-ish
  await page.goto('/test-room?game=ludo&bots=3&tier=low&perf=1&seed=42');
  await page.waitForFunction(() => (window as any).__perf.ready);
  await page.evaluate(() => (window as any).__perf.runScript('roll-and-move', 20));  // scripted bot turns
  const r = await page.evaluate(() => (window as any).__perf.summary());
  expect(r.maxDrawCalls).toBeLessThanOrEqual(60);
  expect(r.maxTriangles).toBeLessThanOrEqual(50_000);
  expect(r.p90FrameMs).toBeLessThanOrEqual(33.3);
  expect(r.idleRendersPerSec).toBe(0);            // on-demand really is idle
  expect(r.leakedTextures).toBe(0);               // after unload → back to shell baseline
});
```
- Matrix: `{ low (6× CPU, 412×915, DPR 2.625), mid (4×), high (1×, 1920×1080) } × every game`.
- Headless Chrome uses SwiftShader unless you pass `--use-angle=...`/`--enable-gpu`. Run GPU-dependent frametime tests on a **self-hosted runner with a real iGPU** (an Intel N100 mini-PC ≈ Chromebook-class). Assert draw calls/tris/leaks/bundle sizes on every CI run anyway (GPU-independent).
- **Lighthouse CI** (`@lhci/cli`) on the lobby and on a game's first load: budgets for TBT < 300 ms, LCP < 2.5 s and JS transfer size per the budget table. `size-limit` fails the PR on chunk-budget breaches.
- **Real-device lab (manual, pre-release):** a Moto G-class Android (Snapdragon 4xx/Helio G), a 2020-era Chromebook (Celeron N4020, 4 GB), an iPhone SE 2/3, a mid laptop running OBS with a browser source at 1080p60. 15-minute soak test per game (thermals + leaks).
- **Telemetry in prod:** a sampled (1%) RUM beacon with tier, p90 frametime, dynamic-res scale, downgrades, WebGL2 failures, and load times per game. This tells us which games need optimization work on real audience hardware.

---

## 12. Per-game perf checklist (copy into every game PR)

- [ ] Manifest declares `mode: on-demand | continuous` and a `physics` need.
- [ ] Low tier: ≤ 60 draws, ≤ 50k tris, ≤ 10 programs, ≤ 24 MB textures, `renderer.info` asserted in the perf test.
- [ ] Repeated pieces are `InstancedMesh`. The board is one mesh. Text is DOM.
- [ ] Materials come from the platform factories only (matcap/lambert/toon/basic).
- [ ] Blob shadows only (a high-tier shadow map re-renders on piece movement only).
- [ ] `renderer.compile()` pre-warm at load, and no new shader programs mid-game.
- [ ] Zero allocations in the per-frame path (checked with a DevTools allocation timeline).
- [ ] JS chunk ≤ 60 KB gz, assets ≤ 1.5 MB (low). Does not import other games.
- [ ] Full `dispose()` on unload, with the leak test green.
- [ ] Touch: 44 px targets, tap-to-move alternative, works one-handed on a 360-px-wide screen.
- [ ] Network: turn events via JSON; if real-time, binary quantized snapshots ≤ 64 bytes at 20 Hz.
- [ ] Works (turn-based) in the DOM fallback when WebGL2 is unavailable.

---

## Sources
- three.js releases (r183–r186): https://github.com/mrdoob/three.js/releases
- three.js manual, WebGPURenderer (WebGL2 fallback behavior): https://threejs.org/manual/en/webgpurenderer.html and https://threejs.org/docs/pages/WebGPURenderer.html
- Utsubo, "100 Three.js Tips That Actually Improve Performance (2026)" (draw-call/vertex budgets, KTX2 VRAM, DPR cap, shadow-map sizes, WebGPU ~87%, r181 Inspector): https://www.utsubo.com/blog/threejs-best-practices-100-tips
- Utsubo, "What's New in Three.js (2026)": https://www.utsubo.com/blog/threejs-2026-what-changed
- three.js forum, stats-gl vs WebGPU in r181: https://discourse.threejs.org/t/webgpu-r181-fyi-stats-gl-no-longer-compatible-with-webgpu/87944
- Three.js Roadmap, "Draw Calls: The Silent Killer": https://threejsroadmap.com/blog/draw-calls-the-silent-killer
- bersus.io, "Optimizing Three.js: Draw Calls, Instancing & Batching": https://bersus.io/insights/creative-dev/threejs-optimizing-instancing-and-batching/
- Codrops, "Three.js Instances" (2025): https://tympanus.net/codrops/2025/07/10/three-js-instances-rendering-multiple-objects-simultaneously/
- mattdesl/threejs-tree-shake (bundle-size numbers): https://github.com/mattdesl/threejs-tree-shake
- three.js issue #9852 (wildcard import bundle bloat): https://github.com/mrdoob/three.js/issues/9852
- abratabia, "Best Physics Engine for Web Games" (Rapier ~500 KB wasm, SIMD builds, 2D alternatives): https://www.abratabia.com/game-physics/best-web-physics-engine.php
- Rapier npm (compat builds): https://www.npmjs.com/package/@dimforge/rapier2d-compat ; https://rapier.rs/docs/user_guides/templates/getting_started_js/
- Physics comparison (cannon-es vs rapier vs ammo): https://www.mysimulator.uk/content/references/physics-engines-comparison.html
- three.js forum, Rapier vs Cannon performance: https://discourse.threejs.org/t/rapier-vs-cannon-performance/53475
- stats-gl: https://github.com/RenaudRohlinger/stats-gl
