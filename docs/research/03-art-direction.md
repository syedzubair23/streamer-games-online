# 03 — Art Direction & UX System: "Cozy Table"

> One style for every game: a warm, soft, clay-toy diorama on a lamp-lit table, seen through a slightly dreamy lofi lens.
> Everything here is chosen to be **cheap on the GPU** (school Chromebooks, low-end Android at 30–60 fps) and to **ship almost no asset bytes**.
> Anything this doc doesn't cover should follow the same four principles.

---

## 0. The Four Principles (tie-breakers for every decision)

1. **Soft, not flat.** Round corners everywhere (3D bevels, UI radii, easing). Nothing is pure black, pure white or fully saturated. Shadows are tinted (warm purple or blue), never grey.
2. **Toy-real.** Pieces look like objects you could pick up: painted wood, felt, clay, paper. Each one is a single chunky shape with a bevel. No realism, no photo textures, no fine detail below ~4 px on screen.
3. **Readable on a 720p stream thumbnail.** A viewer on a phone, watching a compressed Twitch stream, can tell whose turn it is, what just happened and who is winning within 1 second. Readability beats beauty whenever they conflict.
4. **Calm motion, lively moments.** The ambient world breathes slowly (4–12 s loops). Gameplay events are snappy (120–400 ms) with a small overshoot. Big moments (win, capture, reveal) get one short, generous celebration and then calm down again.

**Reference board (what to take from each):**
| Reference | Take | Avoid |
|---|---|---|
| Monument Valley | Pastel gradient skies, pure geometric shapes, colour-coded depth | Impossible geometry that makes the camera confusing |
| A Short Hike | Chunky pixel-soft feel, warm rim light, friendly scale | Low-res pixelation (it makes UI text look muddy on stream) |
| Alba / Tiny Glade | Warm directional light, impressionist softness, golden hour | Expensive GI and real-time shadow cascades |
| Unpacking | A cosy, "lived-in" room, objects that tell a story, satisfying placement | Top-down only |
| Lofi Girl | Window + rain + lamp mood, a desk as a stage, a cat | Anime character rendering |
| Townscaper | Bouncy placement springs, a pastel palette tied to mood | Water reflections (too expensive) |

Tiny Glade is the closest mood reference: its "painterly 3D art style with soft, rounded shapes, warm dynamic lighting and a vibrant pastel colour palette", and golden hour, "warm directional light with long shadows", is what makes everything look good ([Medium review](https://medium.com/@adventuresinindiegaming/doodle-designer-tiny-glade-5fac5a60ebb4), [Switchblade Gaming](https://www.switchbladegaming.com/cozy-games/tiny-glade-tips-and-tricks/)). We get about 80% of that look with baked and fake lighting.

---

## 1. The Shared "Table Diorama" Concept

Every game is set on **The Table**, a round-cornered wooden table in a small cosy room corner. The room is a fixed backdrop. The **Play Mat** (the game-specific surface) sits on the table.

```
      ┌──────────── window (sky gradient + weather layer) ──────────┐
      │   plant    string lights                    lamp           │
      │                                                  ☼ (warm   │
      │  ┌────────────── TABLE (wood, beveled) ──────────────┐ key)  │
      │  │   ┌──────── PLAY MAT (felt / board / paper) ───┐  │       │
      │  │   │        game pieces, cards, dice            │  │  mug  │
      │  │   └────────────────────────────────────────────┘  │  cat  │
      │  └───────────────────────────────────────────────────┘       │
      └──────────────────────────────────────────────────────────────┘
```

### 1.1 Layers (from back to front)
| Layer | Content | Tech | Budget |
|---|---|---|---|
| L0 Sky | Window pane with a vertical gradient + optional clouds/stars | 1 full-screen-ish quad, gradient shader, 2–3 uniforms | 2 tris |
| L1 Room | Back wall, window frame, shelf, plant, lamp, string lights | Merged static mesh, vertex colours, **baked AO in vertex colours** | ≤ 3k tris, 1 draw call |
| L2 Table | Beveled rounded-rect wooden table | 1 mesh, procedural wood texture (see §6) | ≤ 800 tris, 1 draw |
| L3 Play Mat | Game board (Ludo cross, chess grid, felt oval for cards) | Canvas-generated texture on a plane or thin beveled slab | ≤ 500 tris, 1 draw |
| L4 Pieces | Tokens, cards, dice, tiles | **InstancedMesh** per piece type, toon/matcap | ≤ 150 tris per piece, 1 draw per type |
| L5 Props | Mug (steam), cat (sleeping, tail swish), book stack, headphones | Optional, gated by quality tier | ≤ 2k tris total |
| L6 Weather | Rain streaks on the window, snow outside, dust motes in lamp light | One `Points` or instanced quad system, ≤ 300 particles | 1 draw |
| L7 HUD | DOM/CSS overlay (not WebGL) | HTML + CSS | 0 GPU draws |

**Hard budget (Tier Low):** ≤ 40 draw calls, ≤ 25k triangles, 1 shadow-free directional light, DPR capped at 1.25, 30 fps target.
**Tier High:** ≤ 80 draw calls, ≤ 80k triangles, one 1024² shadow map *only* for pieces (static scene baked), DPR up to 2, 60 fps.

### 1.2 Consistent camera language
Every game uses the same four camera states. They are the same moves across all games, so both viewers and players learn them once.

| State | Use | Default framing | FOV |
|---|---|---|---|
| **Establishing** | Lobby, game intro, results | Room visible: 3/4 view, ~35° elevation, table in the lower 2/3 | 35° |
| **Play** (default) | Normal gameplay | Play mat fills ~80% of the short screen axis, **~55° elevation** (a high 3/4 view: board is readable and pieces still have volume) | 30° |
| **Focus** | Dice roll, card reveal, capture, drawing canvas | Dolly toward the event point, 15–25% closer, then back after the beat | 28° |
| **Top-down** (accessibility / host option) | Chess, word grids, drawing | 88° elevation, near-orthographic feel | 20° |

Rules:
- Low FOV (28–35°) gives the "tilt-shift miniature" diorama look and reduces perspective distortion on the board.
- The camera **never cuts** during gameplay. It always glides (see §4 spring `camera`). Cuts are allowed only behind a scene transition wipe.
- **Idle drift:** in Play state, the camera orbits ±1.5° yaw on a 14 s sine loop. It turns off when the "reduce motion" setting is on and for 2 s after any input.
- **Portrait/phone:** the camera raises its elevation to ~65° and pulls back so the whole mat fits the width. The HUD moves to top and bottom bars.
- **Stream-safe framing:** the host's "Stream Layout" setting keeps the bottom-right 22% × 30% and the top-left 20% × 12% free of critical board content (webcam and alert zones). This is done with a camera view offset (`camera.setViewOffset`), not by changing the scene.
- Board orientation: the current player's home side rotates toward the camera **only in local/hot-seat mode**. On stream the board stays fixed (the audience needs spatial consistency).

### 1.3 Per-game mat mapping (the same table, a different mat)
| Game family | Mat surface | Piece style |
|---|---|---|
| Ludo / Snakes & Ladders / race boards | Painted wood board with a thick bevel, pastel quadrants | Rounded "pawn" tokens (lathe geometry, 24 segments), toon material |
| Chess / Checkers | Two-tone wood inlay grid | Stylised chunky pieces (lathe + small extrude crowns), clay matcap |
| Card games (Uno-likes, Crazy Eights, Exploding-style) | Green-teal felt oval | Rounded-corner card planes, canvas-drawn faces, slight bend in hand |
| Drawing / guessing (Pictionary-likes) | Paper sketchbook on the table | Pencil + eraser props, canvas texture as the drawing surface |
| Word / trivia / social (Codenames-, Wavelength-, trivia-likes) | Cork board or index cards on felt | Paper cards with tape, dial prop for Wavelength-style |
| Dexterity / stacking (Jenga-likes) | Felt coaster | Beveled wood blocks, one InstancedMesh |
| Dice games (Yahtzee-likes) | Felt dice tray with a wooden rim | Rounded-cube dice (beveled box, pips baked into the texture) |

---

## 2. Colour System

### 2.1 Structure
Colour is **tokens**, never hard-coded. There are three token groups:
1. **Mode tokens**: change with the ambient mode (sky, light, fog, room tint, UI surface tint).
2. **Identity tokens**: player/team colours. They are **identical in every mode**, so red is always red. Lighting may warm or cool them in 3D, but the HUD always shows the exact hex.
3. **Semantic tokens**: success, warning, danger, info. Fixed, with a mode-specific `-ink` variant for contrast.

All mode changes **lerp** over 2.5 s (colours in linear space, `THREE.Color.lerp`, CSS via `@property` transitions on custom properties).

### 2.2 Ambient mode palettes (exact tokens)

Token meaning:
- `sky-top` / `sky-bottom`: window gradient
- `hemi-sky` / `hemi-ground`: `HemisphereLight` colours
- `key`: directional (sun/lamp) colour, and `key-i` its intensity
- `fill-i`: hemisphere intensity
- `fog`: scene fog / clear colour
- `wall`, `wood`, `felt`: room surfaces
- `shadow`: blob shadow tint
- `ui-bg`, `ui-surface`, `ui-ink`, `ui-muted`, `ui-line`: HUD
- `accent`: primary CTA
- `glow`: lamp/string-light emissive

#### Day ("Sunday Morning")
| Token | Hex | | Token | Hex |
|---|---|---|---|---|
| sky-top | `#9FD3F2` | | wall | `#F3E6D3` |
| sky-bottom | `#FDEBD3` | | wood | `#C98E5B` |
| hemi-sky | `#DDEEFF` | | felt | `#5FA89A` |
| hemi-ground | `#E9C9A3` | | shadow | `#6B4F6E` @ 28% |
| key | `#FFF4E0` (i = 2.2) | | glow | `#FFE7B0` (off, 0.1) |
| fill-i | 1.1 | | fog | `#F6E7D6` |
| ui-bg | `#FFF8EF` | | ui-surface | `#FFFFFF` @ 86% |
| ui-ink | `#3B2F3A` | | ui-muted | `#8A7A86` |
| ui-line | `#EADBC8` | | accent | `#FF8A65` |

#### Golden Hour ("Late Afternoon") — the default hero mode
| Token | Hex | | Token | Hex |
|---|---|---|---|---|
| sky-top | `#F6A58B` | | wall | `#F0D2B6` |
| sky-bottom | `#FFE1A8` | | wood | `#B87445` |
| hemi-sky | `#FFD2B0` | | felt | `#4F9488` |
| hemi-ground | `#B7797A` | | shadow | `#7A3F5C` @ 32% |
| key | `#FFC98A` (i = 2.6, low angle 18°) | | glow | `#FFC26B` (0.5) |
| fill-i | 0.8 | | fog | `#F4C9A6` |
| ui-bg | `#FFF3E4` | | ui-surface | `#FFF9F1` @ 88% |
| ui-ink | `#3D2A33` | | ui-muted | `#8F7078` |
| ui-line | `#F0D3B8` | | accent | `#F2705A` |

#### Night ("Lamp On")
| Token | Hex | | Token | Hex |
|---|---|---|---|---|
| sky-top | `#1C2140` | | wall | `#3A3553` |
| sky-bottom | `#3D3A6B` | | wood | `#8A5A3E` |
| hemi-sky | `#5A5F9E` | | felt | `#3D7A74` |
| hemi-ground | `#2A2338` | | shadow | `#120E24` @ 45% |
| key | `#FFC98A` lamp (i = 2.4, from lamp position) | | glow | `#FFB45E` (1.0) |
| fill-i | 0.45 | | fog | `#262544` |
| ui-bg | `#1F1D33` | | ui-surface | `#2C2946` @ 88% |
| ui-ink | `#F5EDE3` | | ui-muted | `#A89EBC` |
| ui-line | `#403B5E` | | accent | `#FFB36B` |

#### Rain ("Rainy Window")
| Token | Hex | | Token | Hex |
|---|---|---|---|---|
| sky-top | `#7D8FA6` | | wall | `#D8D6DA` |
| sky-bottom | `#B8C3CF` | | wood | `#A57A5C` |
| hemi-sky | `#B9C8D8` | | felt | `#56908C` |
| hemi-ground | `#6D6470` | | shadow | `#3A3F55` @ 34% |
| key | `#E8EEF5` (i = 1.3) + lamp `#FFD08F` (glow 0.7) | | glow | `#FFD08F` (0.7) |
| fill-i | 1.0 | | fog | `#A9B3BF` |
| ui-bg | `#F2F1F4` | | ui-surface | `#FFFFFF` @ 84% |
| ui-ink | `#2F3342` | | ui-muted | `#7B8093` |
| ui-line | `#D9DBE3` | | accent | `#6FA8DC` |

#### Snow ("First Snow") — optional/seasonal
| Token | Hex | | Token | Hex |
|---|---|---|---|---|
| sky-top | `#C9D8EC` | | wall | `#EFE9EE` |
| sky-bottom | `#F4F1F6` | | wood | `#B7835F` |
| hemi-sky | `#E6EEFA` | | felt | `#5E9A96` |
| hemi-ground | `#C7B3B8` | | shadow | `#56507A` @ 26% |
| key | `#F7F3FF` (i = 1.8) | | glow | `#FFD9A0` (0.6) |
| fill-i | 1.2 | | fog | `#E9ECF4` |
| ui-bg | `#FAF8FC` | | ui-surface | `#FFFFFF` @ 88% |
| ui-ink | `#34324A` | | ui-muted | `#8886A0` |
| ui-line | `#E2DEEA` | | accent | `#E77FA0` |

> **Mode rule:** a mode changes the *light and air*, never the identity of objects. The felt stays teal-ish, wood stays wood, player colours stay exact. Night is the only dark-UI mode. The HUD switches to its dark variant using `ui-*` tokens.

### 2.3 Identity (player / team) colours — fixed in all modes
There are 8 slots. Chosen to be distinguishable in hue **and** lightness, and tested for deuteranopia and protanopia by pairing each colour with a **shape glyph** (colour is never the only cue).

| Slot | Name | Base (3D & chip) | Deep (text/outline) | Glyph |
|---|---|---|---|---|
| P1 | Tomato | `#F26B5B` | `#B8382C` | ● circle |
| P2 | Sky | `#5BA8F2` | `#2A6DB3` | ▲ triangle |
| P3 | Sunflower | `#F5C04A` | `#A87A10` | ■ square |
| P4 | Mint | `#5CC79A` | `#23845C` | ◆ diamond |
| P5 | Lilac | `#A98BE8` | `#6A4DB8` | ★ star |
| P6 | Peach | `#FF9F6E` | `#C0602F` | ✚ plus |
| P7 | Teal | `#3FB8C4` | `#1D7782` | ⬟ pentagon |
| P8 | Rose | `#EE86B9` | `#B0457C` | ♥ heart |

Classic Ludo uses P1, P2, P3 and P4 (red, blue, yellow, green), so it is instantly recognisable. Teams A/B default to **Tomato vs Sky**.

### 2.4 Semantic
| Token | Hex | Ink (light UI) | Ink (night UI) |
|---|---|---|---|
| success | `#6CC08B` | `#2E7A4A` | `#9BE0B2` |
| warning | `#F5B94A` | `#96650A` | `#FFD98A` |
| danger | `#EC6A6A` | `#A83434` | `#FF9C9C` |
| info | `#6FA8DC` | `#2F659A` | `#A7CCF0` |
| audience | `#B58AF0` (purple = "chat did this") | `#6B45A8` | `#D3B8FF` |

**Audience purple** is reserved. Every audience-driven thing (votes, predictions, chat-spawned events) uses it, so viewers learn "purple = us".

### 2.5 Contrast rules
- HUD body text ≥ 4.5:1 against `ui-surface` (all `ui-ink`/`ui-surface` pairs above pass). Large display text ≥ 3:1.
- Any text over the 3D scene sits on a `ui-surface` pill. There is never raw text over 3D.
- Turn indicator: the active player's colour at full saturation with a `glow` ring. Inactive players are desaturated to 45% using `filter: saturate(.45)` in the HUD, and 3D pieces get a `uDim` uniform of 0.25.

---

## 3. Typography (Google Fonts)

| Role | Font | Weights | Why |
|---|---|---|---|
| **Display** (titles, winner banners, big numbers, countdowns) | **Fredoka** (variable) | 500, 600, 700 | Rounded, chunky, playful but not childish. Variable, so one file ([madegooddesigns](https://madegooddesigns.com/nunito-alternatives/)) |
| **UI / body** (buttons, labels, chat, rules) | **Nunito** (variable) | 500, 700, 800 | A warm rounded sans that stays legible at small sizes. Strong workhorse for UI ([Medium](https://medium.com/@GlobalOngoing/top-10-google-fonts-for-enhanced-readability-and-versatility-44d080867355)) |
| **Mono / numeric** (timers, room codes, scores) | **Nunito** with `font-variant-numeric: tabular-nums`. Room codes use **JetBrains Mono** 600 only if Nunito's I/l/1 confusion shows up in testing | — | Tabular digits stop timers from jittering |
| **Handwritten accent** (sticky notes, drawing game prompts, "sketchbook" UI) | **Caveat** | 600 | Paper/lofi flavour. Use sparingly (≤ 1 element per screen) |

Loading: `display=swap`, subset `latin` + `latin-ext`, self-host the woff2 files after the first build (≈ 90 KB total). Preload Nunito only; Fredoka can arrive late.

**Type scale** (rem, base 16 px, ratio ~1.25; clamp for stream/phone):
| Token | Size | Font / weight | Line height | Use |
|---|---|---|---|---|
| `t-hero` | `clamp(2.5rem, 6vw, 4.5rem)` | Fredoka 700 | 1.0 | Winner, "Your turn!" |
| `t-h1` | 2rem | Fredoka 600 | 1.1 | Screen titles |
| `t-h2` | 1.5rem | Fredoka 600 | 1.15 | Card titles |
| `t-body` | 1rem | Nunito 600 | 1.45 | Body |
| `t-label` | 0.875rem | Nunito 800, +2% tracking, UPPERCASE optional | 1.2 | Chips, tabs |
| `t-small` | 0.75rem | Nunito 700 | 1.3 | Metadata. **Never** used for gameplay-critical info |

**Stream minimum:** anything a viewer must read renders at ≥ 22 px at 1080p (≈ 2% of screen height). The host's "Stream Mode" setting scales the HUD by 1.2×.

---

## 4. Motion Language

### 4.1 Easing & duration tokens
| Token | Curve | Duration | Use |
|---|---|---|---|
| `ease-out-soft` | `cubic-bezier(0.22, 1, 0.36, 1)` (easeOutQuint) | 240 ms | Default enter, hovers |
| `ease-in-soft` | `cubic-bezier(0.55, 0, 0.78, 0.4)` | 160 ms | Exits (always faster than enters) |
| `ease-inout` | `cubic-bezier(0.65, 0, 0.35, 1)` | 400–700 ms | Camera, mode crossfades, scene wipes |
| `ease-back` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | 320 ms | Pop-ins, chips, toasts (a small overshoot) |
| `dur-micro` | — | 90–120 ms | Press states |
| `dur-short` | — | 180–240 ms | UI enter/exit |
| `dur-med` | — | 320–450 ms | Piece moves (per hop), card flips |
| `dur-long` | — | 600–900 ms | Camera moves, scene transitions |
| `dur-ambient` | — | 4–14 s loops | Breathing, idle drift, steam, tail |

### 4.2 Springs (for 3D and draggable UI)
Use a tiny semi-implicit Euler spring (≈ 30 lines, no library). Values are for mass = 1.

| Name | Stiffness | Damping | Feel | Use |
|---|---|---|---|---|
| `snappy` | 520 | 34 | Crisp, ~3% overshoot | Piece land, button press |
| `bouncy` | 380 | 18 | Toy-like, ~15% overshoot | Token pop, card deal, chip appear |
| `gentle` | 170 | 26 | No overshoot | Camera, panels |
| `wobbly` | 240 | 12 | Jelly | Win celebration squash |
| `camera` | 120 | 22 | Soft, floaty | Camera state changes |

(Framer Motion or react-spring users can map these directly. They are equivalent to `{stiffness, damping}`.)

### 4.3 Canonical 3D motions
**Piece move (Ludo-style hops):**
- Each tile hop is a parabolic arc: `y = 4h·t(1−t)` with h = 0.35 × tile size, 180 ms per hop (speeds to 120 ms after 4 hops).
- Squash on land: scale `(1.12, 0.85, 1.12)` → spring `snappy` back to 1. A soft "tok" sfx is pitched +1 semitone per hop (rising scale = satisfying).
- A blob shadow shrinks and fades with height (`scale = 1 − 0.4·y/h`, `opacity × (1 − 0.5·y/h)`).

**Chess slide:** the piece lifts 0.15 u (120 ms), slides with `ease-inout` (≈ 60 ms per square, clamped to 250–550 ms), and sets down with `snappy`. Knights arc instead of sliding.

**Capture:** the captured piece does a small hop, spins 1 full turn, and shrinks to 0 over 350 ms into a **puff** (6 instanced soft circles in the victim's colour). Camera micro-shake: 2 px equivalent, 120 ms, only on captures and only on the High tier. There is **no shake** when reduce-motion is on.

**Dice roll (cheap, deterministic, synced):**
- The server sends the result, and the client plays a *pre-authored* roll. Do not use a physics engine.
- Throw: the die arcs from the player's side with 2–3 bounces (decaying parabolas: 0.6, 0.25, 0.08 of the initial height), while tumbling with angular velocity decaying `ω *= 0.9` per frame-equivalent.
- The final 250 ms slerps the quaternion to the orientation showing the server result (precomputed 6 face quaternions + random yaw). The tumble hides the correction.
- Total 1.1–1.4 s. Each bounce plays a "tok" sfx (the lowpass cutoff drops per bounce). After landing, the die pulses once (`bouncy` 1 → 1.15 → 1) and the result chip pops in the HUD.

**Card deal / flip:** deal = fly along an arc with a 12° roll, 260 ms stagger of 60 ms. Flip = rotate Y 0→180° over 320 ms `ease-inout`, lift 0.1 u at the midpoint, swap the face texture at 90°. Cards in hand fan with a 4° spread and hover-lift 0.08 u + 1.04 scale.

**Turn change:** the ring around the active player's avatar/home area pulses (scale 1 → 1.06, 1.4 s loop, `ease-inout`). The "Your turn" banner is `t-hero`, slides down 24 px with `ease-back`, holds 900 ms, and exits with `ease-in-soft`. The camera nudges 5% toward that player's side.

**Ambient life (always on unless reduce motion):** mug steam (3 billboard puffs, UV scroll), cat tail swish (bone-free: vertex shader sine on the tail vertices, masked by vertex colour), string lights flicker ±8% on staggered 3–7 s sines, and dust motes (Tier High only, 40 points) drift in the lamp beam.

### 4.4 UI micro-interactions
- **Button press:** `translateY(2px)`, shadow shrinks, `scale(0.97)`, 90 ms. Release uses `bouncy`. Add a soft "pop" sfx.
- **Hover (pointer devices only, `@media (hover:hover)`):** lift `-2px`, shadow grows, 160 ms.
- **Chips / toggles:** the knob slides with `snappy`. The track colour crossfades over 180 ms.
- **Number changes (scores, timers):** a rolling counter (digits slide up 100% with `ease-out-soft`, 240 ms). A score increase flashes `success` for 400 ms.
- **Timer urgency:** at ≤ 10 s the ring turns `warning`. At ≤ 5 s it turns `danger`, and each second ticks a soft pulse (scale 1.04) with a "tick" sfx. The screen never flashes red.
- **Vote bars (audience):** the bars grow with spring `gentle`. The leader gets a crown glyph that pops with `bouncy`.

### 4.5 Scene / page transitions
There are two, and both are cheap:
1. **"Lamp Blink" (between screens inside the same room, e.g. lobby → game):** the camera dollies (`camera` spring). Meanwhile the HUD panels exit (fade + 8 px down, 160 ms), the mat swaps under a 250 ms **"cloth drape"** (the old mat scales Y to 0.02 and fades, the new one rises with `bouncy`), and the new HUD enters with a 40 ms stagger.
2. **"Iris" (room → different room/server, loading, reconnect):** a full-screen CSS radial-gradient mask closes to a soft circle (600 ms `ease-inout`), shows a loading vignette (the mug steams and shows a tip text), then reopens. It is CSS only (`mask-image` with an animated `@property --r`). It costs zero GPU draws.

Mode switch (day → night, etc.): all tokens lerp over 2.5 s. At the same time, the window gets a 400 ms "curtain" parallax slide so the change feels intentional.

### 4.6 Celebration / confetti (cheap)
- **One InstancedMesh** of 120 (Low) or 300 (High) paper-confetti quads. Each instance stores pos/vel/rot in a Float32Array. Simulate on the CPU with `vel.y -= g·dt; vel *= 0.985; rot += spin·dt` plus a sine flutter on x (`sin(t·6 + seed)·0.3`). Upload with `instanceMatrix.needsUpdate`. Colours are the winner's identity colour + `accent` + `sunflower`, set via `instanceColor`.
- Material: `MeshBasicMaterial` with a double-sided 2-colour tint (the back face darkened by 25% in the shader to fake a paper flip). No lighting cost.
- Lifetime 2.2 s, then the pool is reused. **Never allocate per frame.**
- Paired with: the winner's pieces do a `wobbly` squash-jump in sequence (80 ms stagger), the winner banner shows, the string lights brighten to 1.4× for 1 s, and a major-chord sfx plays.
- A "mini celebration" (capture, correct guess, streak) = 24 confetti in a burst at the event point plus a `bouncy` chip.

### 4.7 Reduce motion
`prefers-reduced-motion` OR an in-app toggle turns off camera drift, shake, confetti (replaced by a 600 ms colour glow) and parallax, and makes piece hops 50% shorter. Gameplay-state animations stay (they carry information), but they run at 0.6× duration.

---

## 5. Lighting Recipe (three.js, cheap)

### 5.1 Base rig (all tiers)
```ts
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;  // or AgX; test on mid-range Android
renderer.toneMappingExposure = 1.0;                   // per-mode token can nudge 0.9–1.1
renderer.shadowMap.enabled = tier === 'high';          // pieces only
renderer.setPixelRatio(Math.min(devicePixelRatio, tier === 'low' ? 1.25 : 2));

const hemi = new THREE.HemisphereLight(mode.hemiSky, mode.hemiGround, mode.fillI);
const key  = new THREE.DirectionalLight(mode.key, mode.keyI);
key.position.set(-4, 7, 3);                // upper-left, the "window/lamp" side, constant across games
scene.fog = new THREE.Fog(mode.fog, 18, 42); // hides the room edges, costs nothing
```
- **Only 2 real lights.** Lamps and string lights are *emissive* vertex colours plus a sprite halo (additive, `depthWrite:false`). They do not use `PointLight`s.
- Light direction is **always upper-left** across games and modes. The Night lamp sits upper-right and is the only exception, and it is still one directional light that moves.

### 5.2 Materials (pick per object, never mix PBR in)
| Material | Where | Why it's cheap |
|---|---|---|
| `MeshToonMaterial` + 3-step `gradientMap` (DataTexture 3×1, `NearestFilter`) | Pieces, dice, props | Cheaper than Phong/Standard, soft cel bands ([three.js docs](https://threejs.org/docs/pages/MeshToonMaterial.html), [sbcode](https://sbcode.net/threejs/meshtoonmaterial/)) |
| `MeshMatcapMaterial` with a **canvas-generated** clay matcap | Chess pieces, "clay" objects, UI-3D icons | No lights evaluated at all. Soft clay look. Tint matcap per mode by blending 2 matcaps via `onBeforeCompile` |
| `MeshLambertMaterial` + vertex colours (baked AO) | Room, table | Per-vertex lighting on low-tier, looks soft |
| `MeshBasicMaterial` | Sky, halos, confetti, blob shadows | No lighting |

Gradient map values (softer than default toon): `[0.55, 0.8, 1.0]` luminance steps. The darkest step is tinted toward `shadow` via `onBeforeCompile`, which gives purple-warm shadows.

**Rim/fresnel "toy glow"** (a signature detail, cheap): add 4 lines in `onBeforeCompile` to pieces: `rim = pow(1.0 - dot(N, V), 3.0) * 0.35;` mixed toward `hemi-sky`. It gives the soft backlit outline from A Short Hike and Alba and separates pieces from the board without outlines.

### 5.3 Shadows
- **Default (all tiers): blob shadows.** Each piece gets a soft radial-gradient quad (one shared 64² canvas texture, `MeshBasicMaterial`, `multiply` blending or `transparent` with the `shadow` token colour, `depthWrite:false`, `polygonOffset`). Instanced alongside the pieces, so it costs one draw call for all shadows. Offset 0.05 u away from the light direction.
- **Baked static shadows:** the room and table have shadows/AO baked into vertex colours at build time (or painted into the procedural table texture as a soft darker ellipse under the mat).
- **Tier High only:** one 1024² `PCFSoftShadowMap` with a tight orthographic frustum hugging the mat, `shadow.radius = 4`. Only pieces cast. Only the mat receives. `shadowMap.autoUpdate = false`, and call `needsUpdate = true` only when a piece moves. Most frames then have zero shadow cost. (See Codrops on scene efficiency: [tympanus.net](https://tympanus.net/codrops/2025/02/11/building-efficient-three-js-scenes-optimize-performance-while-maintaining-quality/).)

### 5.4 "Post-processing" without post-processing
There is no EffectComposer and no bloom/SSAO/DOF render passes. Get the look in other ways:
- **Vignette + grain + warm tone:** a **CSS overlay** `div` over the canvas:
  - Vignette: `radial-gradient(ellipse at center, transparent 55%, rgba(40,20,40,.28) 100%)`
  - Grain: a 128² canvas-generated noise PNG as `background-image`, `mix-blend-mode: overlay`, opacity 0.06 (night 0.09). It is animated by shifting `background-position` in 4 steps at 8 fps (`steps(4)`), which is cheap.
  - Composited by the browser, so no extra WebGL pass.
- **Fake bloom:** additive halo sprites on the lamp, string lights and winner piece.
- **Fake DOF (tilt-shift):** the room layer (L1) uses a slightly desaturated, fog-heavy material. Optional Tier High: a single-pass tilt-shift blur on the top/bottom 15% of the screen, as a CSS `backdrop-filter: blur(2px)` on two gradient-masked strips. Test performance. Off on Low.
- **Colour grade:** it is baked into the mode tokens. There is no LUT.

### 5.5 Quality tiers (auto-detected, host/user override)
| | Low | Medium | High |
|---|---|---|---|
| DPR cap | 1.0–1.25 | 1.5 | 2.0 |
| Shadows | blob | blob | blob + 1 shadow map (pieces) |
| Rim light | off | on | on |
| Props (cat, mug, plant sway) | static | animated | animated + dust motes |
| Weather particles | 80 | 180 | 300 |
| Confetti | 120 | 200 | 300 |
| Antialias | off (FXAA-free; rely on DPR) | `antialias:true` | `antialias:true` |
| Grain overlay | static | animated | animated |

Auto-detect: start at Medium, sample frame time over 90 frames, and drop a tier if p90 > 22 ms. Raise after 10 s if p90 < 10 ms. Also cap by `navigator.hardwareConcurrency ≤ 4` → start Low.

---

## 6. Procedural Textures (ship ~0 image bytes)

Everything is generated at boot on an `OffscreenCanvas` (with a `<canvas>` fallback), cached as `CanvasTexture`, and optionally cached to IndexedDB as a blob so the next visit loads instantly. Target: **< 150 ms total generation on a Chromebook**, done during the Iris loading screen.

A shared helper is a **value-noise / fBm** function (seeded, 2–4 octaves) on a small grid, upscaled with bilinear filtering. There is no Perlin library.

| Texture | Size | Recipe |
|---|---|---|
| **Wood (table)** | 512×256 | Base `wood` colour. Grain = `sin((x + fbm(x·0.02, y·0.2)·40)·0.08)` → mix between `wood` and `wood·0.82`. Add 2–3 darker knots (radial rings), a 3% noise speckle, and a baked soft darker ellipse where the mat sits. Mode tint happens in the material colour, not the texture |
| **Felt** | 256² (repeat) | `felt` base + high-frequency noise at ±4% luminance + 1 px fibre streaks (200 short random lines at 5% opacity). `RepeatWrapping`, anisotropy 4 |
| **Paper** | 256² (repeat) | Off-white `#FBF5EA` + low-freq fBm blotches ±3% + fine grain ±2%. Optional faint blue ruled lines for the sketchbook |
| **Cork** | 256² | Tan `#D2A679` + dense 1–2 px dark/light speckles |
| **Board art** (Ludo, chess, S&L) | 1024² (Low: 512²) | Drawn with Canvas 2D paths: rounded-rect tiles, soft inner shadow via `shadowBlur`, identity colours, glyphs, safe-square stars. Painted over the wood texture with 92% opacity so the grain shows through ("painted wood") |
| **Card faces** | Atlas 1024² on Low/Med (8×4 grid of 128×179 cells); 2048² on High (256×358 cells) | Canvas-drawn: rounded-rect, a 6 px `ui-line` border, big corner numerals in Fredoka (**wait for `document.fonts.ready`**), a centre glyph. A light paper noise overlay |
| **Dice pips** | 128² per face, 6-face atlas | Cream `#FFF6E6` + `ui-ink` pips with a soft inner shadow |
| **Blob shadow** | 64² | Radial gradient, alpha 1 → 0 with a smoothstep falloff |
| **Clay matcap** | 256² | Radial gradient sphere: highlight top-left (`#FFFFFF`), mid (`#E8DCD6`), rim bottom-right toward `#9C8AA0`, plus a subtle second highlight. Generate 2 variants (warm/cool) and blend per mode |
| **Toon gradient** | 3×1 DataTexture | `[140, 205, 255]` |
| **Sky** | none (shader) | Vertical mix `sky-bottom → sky-top` with a smoothstep. Stars at night = hashed noise threshold in the shader. Clouds = 3 soft sprite blobs drifting |
| **Rain on window** | Shader | Streaks: `fract(uv.y·k + t·speed + hash(col))` masked to thin lines. Droplets: sparse hashed circles with a slight refraction offset of the sky UV. One quad |
| **Grain overlay** | 128² | White noise, then box-blurred 1 px, stored as a PNG data URL for the CSS overlay |
| **Confetti** | none | Solid-colour quads |

3D geometry is also procedural: `LatheGeometry` pawns/chess pieces from ~8-point profiles, rounded boxes (a small `RoundedBoxGeometry` from three/examples, 2–3 segments), `ExtrudeGeometry` with `bevelEnabled` for tiles and cards. Aim for a **zero-byte model pipeline in v1**. The only optional glTF assets are the cat and plant (≤ 40 KB each, Draco/meshopt) if the procedural versions look weak.

---

## 7. UI Component Language

**Material metaphor:** *soft paper cards on the table*. The UI is warm, slightly translucent paper with rounded corners that sits over the scene. It is not glassy neon.

### 7.1 Shape & depth tokens
| Token | Value |
|---|---|
| `radius-sm` | 10px (chips, inputs) |
| `radius-md` | 16px (buttons, list rows) |
| `radius-lg` | 24px (cards, panels) |
| `radius-xl` | 32px (modals, sheets) |
| `radius-pill` | 999px |
| `shadow-1` | `0 1px 0 rgba(255,255,255,.6) inset, 0 2px 6px rgba(59,47,58,.10)` |
| `shadow-2` | `0 1px 0 rgba(255,255,255,.6) inset, 0 6px 18px rgba(59,47,58,.14)` |
| `shadow-3` | `0 12px 36px rgba(59,47,58,.20)` |
| Night shadows | the same with `rgba(0,0,0,.35)` and the inset highlight at `.06` |
| `blur-surface` | `backdrop-filter: blur(10px) saturate(1.1)`, **disabled on Low tier** (falls back to 96% opaque `ui-surface`) |
| spacing | 4-pt grid: 4, 8, 12, 16, 24, 32, 48 |

### 7.2 Components
- **Button (primary):** pill/`radius-md`, height 48 (touch ≥ 44), `accent` fill, `ui-ink` (or white if contrast passes) Nunito 800. It has a 3 px darker "base" bottom border (`accent` −18% L) so it reads as a chunky toy button. Pressed: the border collapses to 1 px and it moves down 2 px.
- **Button (secondary):** `ui-surface` fill, 2 px `ui-line` border, `ui-ink` text.
- **Button (ghost/icon):** 44×44 circle with a hover tint of 8% `ui-ink`.
- **Card / panel:** `ui-surface`, `radius-lg`, `shadow-2`, 20–24 px padding. The header uses Fredoka `t-h2`. Optional top "tape" strip (a Caveat label on a 6°-rotated translucent rectangle) for lobby/game cards.
- **Game tile (game picker):** 4:3 card with a live mini-diorama thumbnail (pre-rendered once at boot to a 256² render target, then used as an `<img>` blob). Name, 👥 player range, ⏱ round length, and an "Audience: Vote/Predict/Join" chip row. Hover tilts it 3° in 3D (CSS `perspective`).
- **Chip:** `radius-pill`, 28–32 px tall, `t-label`. Variants: identity (colour dot + glyph + name), status (semantic colour at 15% bg, ink text), audience (purple).
- **Player plate (HUD):** avatar circle (identity colour ring 3 px), name, score (tabular), and a turn ring. The active plate scales to 1.06 and gets the glow. A disconnected plate shows 50% opacity + a "zzz" chip.
- **Toast:** bottom-centre (desktop: top-right, clear of the stream webcam zone), `radius-md`, `shadow-3`, icon + one line, and a 4 s auto-dismiss with a thin progress underline. Enter: `ease-back` from 12 px down. Stack ≤ 3 and collapse older ones.
- **Modal / sheet:** desktop = centred `radius-xl` card, max-width 520. Phone = bottom sheet with a drag handle and spring `gentle`. The backdrop is `ui-ink` at 30% with no blur on Low. Focus-trapped, and Esc closes it.
- **Timer ring:** an SVG circle stroke 6 px that depletes clockwise, with the number in Fredoka in the centre.
- **Audience panel:** a purple-tinted card, vote bars with percentages, prediction odds, and a "chat is voting…" pulsing dots animation.
- **Inputs:** 48 px tall, `radius-sm`, 2 px `ui-line` border that becomes `accent` with a 4 px `accent` @ 25% focus ring.
- **Focus visible:** always a 3 px offset ring in `accent`. Never remove outlines.

### 7.3 Iconography
Rounded-stroke icons (**Phosphor "bold" or "duotone"** or **Lucide** at 2.25 stroke). Tree-shake so only used icons ship. The duotone secondary colour is `accent` @ 30%. Identity glyphs (§2.3) are custom SVG paths with rounded joins.

### 7.4 HUD layout (landscape)
```
┌─────────────────────────────────────────────────────────────┐
│ [Room code • Game • Round 2/5]            [mode ☀] [⚙] [⤢] │  top bar (thin, translucent)
│ ┌Players┐                                          ┌Audience┐│
│ │ P1 ●  │           3D table (Play camera)         │ votes  ││
│ │ P2 ▲  │                                          │ predict││
│ │ P3 ■  │                                          └────────┘│
│ └───────┘                                                    │
│            [ contextual action bar: Roll / Play card ]        │  bottom center
└─────────────────────────────────────────────────────────────┘   (bottom-right kept free for webcam)
```
Portrait: top = players row (horizontal scroll), bottom = action bar + collapsible audience sheet.

---

## 8. Audio Direction

**Mood:** a warm lofi room. Soft, rounded, low-mid heavy, nothing piercing (no energy above ~6 kHz in UI sfx). Everything goes through one master chain: `sfxBus → lowpass(7 kHz) → compressor (gentle) → master`, and `musicBus → master`. Separate volume sliders for Music, SFX and Ambience. **"Streamer mode"** ducks the music to −12 dB automatically while a host mic-safe flag is set, and defaults music to 35%.

### 8.1 Synthesised UI sfx (WebAudio, 0 bytes)
All use `OscillatorNode` + `GainNode` envelopes (attack/decay via `setTargetAtTime` or `linearRampToValueAtTime`). Sine/triangle waves give mellow tones ([sonoport](https://sonoport.github.io/synthesising-sounds-webaudio.html), [Chris Lowis on envelopes](https://chrislowis.co.uk/2013/06/17/synthesis-web-audio-api-envelopes)). Keep one shared `AudioContext`, resumed on first user gesture.

| Sound | Recipe |
|---|---|
| `pop` (button) | Sine 660→440 Hz pitch drop over 60 ms, gain A 3 ms / D 90 ms, peak 0.25 |
| `tick` (hover/timer) | Triangle 1200 Hz, 25 ms, peak 0.08, through lowpass 3 kHz |
| `tok` (piece land / dice bounce) | Sine 220 Hz + a noise burst (8 ms, bandpass 900 Hz Q 1.5), D 120 ms. Pitch +1 semitone per consecutive hop (C major pentatonic) |
| `card` (deal/flip) | Noise burst 40 ms, bandpass sweeping 2 k→800 Hz, peak 0.12 ("fwip") |
| `chime` (your turn) | Two triangle notes E5 → B5 at 90 ms apart, D 500 ms, + a quiet sine an octave below |
| `success` | Arpeggio C5-E5-G5 at 60 ms steps, triangle, D 300 ms each |
| `fail` (soft, never harsh) | Sine G4 → E4 glide 180 ms, D 250 ms |
| `capture` | `tok` + downward sine sweep 500→180 Hz over 200 ms ("bloop") |
| `win` | Major 7th chord (Cmaj7) triangle stack, A 20 ms, D 1.6 s, plus a sparkle of 6 random pentatonic high notes over 800 ms |
| `vote` (audience) | Soft marimba-ish: sine + 4× harmonic at 10% gain, very short. Purple = audience, so this sound = audience |
| Mode switch | A filtered noise swell 0.6 s (rain mode adds the rain bed) |

**Pentatonic rule:** every pitched sfx is quantised to **C major pentatonic** so overlapping sounds never clash, and random variation (±2 cents detune, ±1 pentatonic step) stops repetition fatigue.

### 8.2 Ambience & music
- **Ambience beds (procedural):** rain = pink noise → lowpass 1.2 kHz + random droplet "tik"s (short bandpassed noise, Poisson ~6/s). Night = a very low room tone + an occasional far-off cricket (a 4.5 kHz sine chirp at a very low gain). Day = soft room tone + rare bird chirps (FM sine, 2 s). A fireplace/lamp hum is not needed.
- **Music:** option A (v1): **a generative lofi loop** in WebAudio. A 4-bar ii–V–I–vi progression in a jazzy voicing (Rhodes-ish: sine + detuned triangle + tremolo LFO 4 Hz), a kick/snare from noise and sine sweeps at 72–84 BPM, swing 58%, and a vinyl crackle (sparse noise clicks + lowpassed hiss at −38 dB). Swap between 4 seeded chord sets per mode. Option B: 2–3 licensed or commissioned lofi tracks at 96 kbps Opus (~2 MB each), lazy-loaded after the first game starts. **Recommendation:** ship A first, and add B as an optional "curated playlist".
- **DMCA / streamer safety:** all audio is original or procedurally generated, and the UI states "Stream-safe audio ✓". This matters to streamers.
- The music softly ducks 4 dB during reveals/countdowns and swells back after the win sting.

---

## 9. Ambient Modes — Scene Behaviour Summary
| Mode | Window | Key light | Room | Particles | Audio bed |
|---|---|---|---|---|---|
| Day | Blue→cream sky, 2 slow clouds | High, cool-white, from the window | Lamp off | none (dust motes on High) | Room tone + birds |
| Golden Hour (default) | Peach→honey sky, the sun low in frame | Low 18°, long amber blob-shadow offset | String lights on at 50% | Dust motes (High) | Room tone + soft wind |
| Night | Indigo, twinkling hashed stars, a moon sprite | The lamp becomes the key (upper-right) | Lamp + lights 100%, the window is the darkest area | Fireflies outside the window (≤ 12 sprites) | Crickets, low hum |
| Rain | Grey-blue, streaking droplets shader | Soft cool key + warm lamp glow | Lamp on 70% | Rain streaks on the glass | Rain bed + droplets |
| Snow | Pale lilac-white, drifting flakes | Soft, bright, cool | Lamp on 60%, a scarf on the chair | 150 snow points outside | Muffled room tone + faint wind |

The host can **auto-cycle** modes (e.g. every 20 min, or tied to the real local time). A "Mode" chip in the top bar lets the audience vote on the next mode, which is a cheap, fun audience hook.

---

## 10. Implementation Notes (perf guardrails for art)
- **Render on demand:** when nothing animates (no ambient loop on Low + idle), drop to ~10 fps or pause the rAF loop. Ambient loops on Low tier run at 30 fps.
- Merge static room geometry into one BufferGeometry at build time. Use one material via vertex colours.
- InstancedMesh for pieces, blob shadows, confetti and particles. Identity colour via `instanceColor`.
- Share materials. Use `onBeforeCompile` shader chunks for rim/mode tint. Pre-compile with `renderer.compile(scene, camera)` during the Iris load to avoid first-move hitches.
- No transparent sorting nightmares: transparent objects (halos, shadows, confetti) use `depthWrite:false` and explicit `renderOrder`.
- Textures: power-of-two, mipmaps on for felt/wood, `NearestFilter` for the toon ramp, and anisotropy ≤ 4.
- The HUD is DOM. Do not render text in WebGL except card faces/board numbers baked into canvases.
- Measure: target the Low tier at **≤ 8 ms GPU on an Intel UHD 600 Chromebook** at 1366×768, and **≤ 12 ms frame on a Snapdragon 665-class phone**.

---

## 11. Visual QA Rubric (for the critic agent, scored on screenshots)

Score each check **1–10**. **Ship bar: an average ≥ 8.0 AND no single check < 6.** Checks marked ★ are "hard gates": < 7 blocks release regardless of average.
Screenshots required per game: Establishing, Play (mid-game), Focus event (dice/capture/reveal), Results. Each in **Golden Hour + Night**, plus **one phone portrait** and **one 1280×720 stream-scaled** capture (downscale the 1080p capture to 720p and JPEG q=60 to simulate a Twitch stream).

| # | Check | 10 looks like | 1–4 looks like |
|---|---|---|---|
| 1 ★ | **Style consistency** | Pieces, board, room and UI all read as one cosy clay/wood/paper world. It matches other games in the platform. No asset looks "from another game" | Mixed styles: realistic textures next to toon, default three.js grey materials, stock UI widgets |
| 2 ★ | **Stream-thumbnail readability** | At 720p/JPEG-60, whose turn it is, the current state and the scores are legible within 1 s. Text ≥ 22 px @1080p | Viewers would squint. Small text, tiny pieces, low contrast, important info in the webcam corner |
| 3 | **Palette adherence** | Only token colours. No pure #000 or #FFF. Shadows are tinted. Saturation is controlled. The identity colours exactly match the §2.3 hexes in the HUD | Off-palette colours, grey or black shadows, neon oversaturation, muddy browns |
| 4 | **Lighting mood** | A clear upper-left key, soft warm/cool contrast, pieces "pop" from the board via rim + blob shadow, and the mode is instantly identifiable | Flat and evenly lit, or harsh dark shadows. Pieces blend into the board. Day and Night look alike |
| 5 | **Form softness** | Every visible edge is beveled or rounded. Silhouettes are chunky and toy-like. The UI radii match the tokens | Sharp box edges, thin spindly shapes, aliasing staircases on silhouettes |
| 6 ★ | **Hierarchy & focus** | One obvious focal point per frame (the active piece, CTA or reveal). The eye path goes action → state → context. The HUD doesn't compete with the board | Everything shouts equally. Several competing highlights. The CTA is unclear |
| 7 | **Composition & camera** | The mat is well-framed per §1.2, there is breathing room, the horizon/window is placed pleasingly, and the stream-safe zones are respected | Board cropped, awkward tangents, the camera too low (occlusion) or too high (flat), empty dead space |
| 8 | **Typography** | Only Fredoka/Nunito(/Caveat accent). Correct scale steps, tabular numbers, no widows in banners, consistent weights | Fallback system fonts (FOUT captured), random sizes, cramped or overlapping text |
| 9 | **UI component polish** | Consistent radii, shadows, padding on the 4-pt grid, icons at one stroke weight, visible focus states, no clipping or overflow | Misaligned elements, inconsistent paddings, clipped text, default browser controls |
| 10 | **Texture & surface quality** | The procedural wood, felt and paper read as materials at a glance, and repeats are invisible. The grain overlay is subtle (felt, not seen) | Obvious tiling, noise that looks like compression artefacts, grain too strong, blurry board art |
| 11 | **Colour-blind & accessibility** | Identity is shown by colour + glyph. It passes a deuteranopia/protanopia simulation (use a simulator on the screenshot). Text contrast is ≥ 4.5:1 | Players can only be told apart by red/green. Low-contrast text on the 3D scene |
| 12 | **Ambient life & atmosphere** (judge from a 3-frame sequence or GIF) | The room feels inhabited: steam, lights, weather, the cat. The mode's weather is convincing yet unobtrusive | A dead static scene, or distracting busy particles over gameplay |
| 13 | **Moment quality** (Focus/Results shots) | The dice, capture or win moment feels celebratory: a clear result chip, confetti in the winner's colours, a banner. It's clean enough to clip for TikTok | A bland result, text-only "Player 2 wins", or confetti that obscures the result |
| 14 | **Portrait/phone layout** | Everything fits. Touch targets ≥ 44 px. The board is fully visible. The HUD is in bars. There's no overlap with the notch or safe areas | The board is cut off, the HUD overlaps pieces, and buttons are tiny |
| 15 | **"AAA polish" gut check** | A stranger would believe this is a premium indie title (the Tiny Glade / Alba / Monument Valley tier). You'd want to screenshot it | Looks like a prototype, a web demo or a template |

**Critic instructions:** for each score < 8, give (a) the exact region of the screenshot, (b) which principle or token it violates (cite the doc section), and (c) a concrete fix ("raise rim intensity 0.35→0.5", "move timer out of bottom-right stream zone"). Do not give generic advice.

---

## 12. Sources
- three.js `MeshToonMaterial` docs (gradientMap, NoColorSpace): https://threejs.org/docs/pages/MeshToonMaterial.html
- MeshToonMaterial tutorial, stepped DataTexture with NearestFilter: https://sbcode.net/threejs/meshtoonmaterial/
- Codrops — Building Efficient Three.js Scenes (2025): https://tympanus.net/codrops/2025/02/11/building-efficient-three-js-scenes-optimize-performance-while-maintaining-quality/
- Tiny Glade art style analysis: https://medium.com/@adventuresinindiegaming/doodle-designer-tiny-glade-5fac5a60ebb4
- Tiny Glade golden-hour lighting tips: https://www.switchbladegaming.com/cozy-games/tiny-glade-tips-and-tricks/
- Tiny Glade on Steam (mood reference): https://store.steampowered.com/app/2198150/Tiny_Glade/
- Fredoka / Nunito / Baloo comparison: https://madegooddesigns.com/nunito-alternatives/
- Nunito readability for UI: https://medium.com/@GlobalOngoing/top-10-google-fonts-for-enhanced-readability-and-versatility-44d080867355
- Rounded display type in game UI (Palworld case): https://madegooddesigns.com/palworld-font/
- Synthesising sounds with Web Audio API: https://sonoport.github.io/synthesising-sounds-webaudio.html
- Web Audio envelopes: https://chrislowis.co.uk/2013/06/17/synthesis-web-audio-api-envelopes
