# Definition of Done, Visual QA Rubric & Critic Protocol

> Authoritative. `tools/harness/progress.ts` refuses to set any item to `done` without the evidence listed here. Never weaken a gate, test, threshold, scenario or rubric item to get a green result. Doing so is an automatic fail, and the item goes to `blocked`.

---

## 1. Platform items (M0, M1, M10): P-gates

| # | Gate | Check | Threshold |
|---|---|---|---|
| P1 | Typecheck | `pnpm typecheck` | 0 errors |
| P2 | Lint | `pnpm lint` (includes boundary and banned-API rules) | 0 errors, 0 new `eslint-disable` without a `-- reason` |
| P3 | Unit tests | `pnpm test --filter <pkg>` | 100% pass. New code has at least 85% line coverage |
| P4 | Item acceptance | every bullet under the item's **Accept** in ROADMAP.md | each one backed by an automated test or an artifact file |
| P5 | Budgets | `pnpm size`, plus the relevant `perf.spec` | within SPEC §10 |
| P6 | Visual (only M1-05, M1-07, M1-09, M10-01) | the critic protocol (§7) on that item's platform scenarios | same pass bar as games (§4.3) |
| P7 | Docs | the TSDoc on the public API is updated, and `docs/engine-api.md` is regenerated when the API changes | present |

Evidence goes in `artifacts/verify/<item-id>.json`, written by `pnpm verify:item <id>`.

---

## 2. Game items (M2–M9): G-gates

Run `pnpm verify:game <id>` for G1–G11, G13 and G14. G12 (the critic) runs **only when G1–G11 and G14 are green**.

| # | Gate | How it is checked | Threshold |
|---|---|---|---|
| G1 | Typecheck | `tsc --noEmit -p packages/games/<id>` | 0 errors |
| G2 | Lint | eslint on the package, with rules banning literal colours and durations in `client/**`, `Math.random`/`Date` in `logic/**`, direct `new *Material`, `requestAnimationFrame`, cross-game imports, and any static import of `three` or `@sg/render` from `controller.tsx`/`audience.tsx` (only the lazy `requestBoard()` path may reach them) | 0 errors |
| G3 | Rule tests | `vitest run packages/games/<id>/test/logic.test.ts` | 100% pass. **Every numbered rule and every listed test case in the game spec has at least one test named with its number** (for example `R7:` or `T12:`). Branch coverage on `logic/**` is at least 90% |
| G4 | Contract suite | `runContractSuite(logic)`: determinism, serialize round-trip, secrecy fuzz (200 games), termination, `parseAction` fuzz (1,000 payloads), illegal actions are a no-op | all pass |
| G5 | Bot simulation | `sim.test.ts`: 1,000 seeded bot-vs-bot games for turn-based games, or 200 games for Marble Rally, across every player count and every major option preset in the spec | 0 exceptions, 0 illegal actions, 100% of games end within the spec's max-steps bound, every spec invariant holds after every step, and fairness holds in symmetric games: no seat's win rate exceeds `1.25 / N` for N seats (e.g. 31.25% for 4, 62.5% for 2), unless the spec sets a stricter bound. Chess uses its own T9 bound instead |
| G6 | Scenario coverage | `check-scenarios.ts`: every scenario in the spec's table is registered and renders with no console errors for each role it lists | 100% |
| G7 | Screenshots | the full matrix (§3) is captured, with 0 console errors and 0 blank canvases (pixel-variance check: the standard deviation of luminance is above 4) | 100% |
| G8a | Perf, CI | `perf.spec.ts` on swiftshader at **low** tier with the `midgame` scenario | draws ≤ 60 and triangles ≤ 50k for the whole frame including the environment; programs ≤ 10; texture memory ≤ 24 MB; idle renders = 0/s with ambient off; unmounting returns `renderer.info.memory` to baseline (0 leaked geometries or textures); stage chunk ≤ 60 KB gz (Marble Rally ≤ 70); controller chunk ≤ 25 KB gz |
| G8b | Perf, GPU | `perf.spec.ts` on the gpu project with 4× CPU throttle, low tier, 412×915, playing the spec's "perf script" (a canonical 10 s animation sequence) | p95 frame ≤ 33.3 ms. At high tier, 1920×1080, 1× CPU: p95 ≤ 16.7 ms. Heap growth under 5 MB over a 60 s loop |
| G9 | Accessibility | `a11y.spec.ts` (axe) plus token contrast checks, on the controller and on the stage HUD | 0 serious or critical axe findings; text contrast ≥ 4.5:1 in all modes; tap targets ≥ 44 px at 360 px width; the reduced-motion path renders the scenarios with no confetti or shake; the game can be played by keyboard on desktop |
| G10 | Multiplayer smoke | Playwright plus the bot swarm against a real server, **two runs**: one at the game's `minPlayers` and one at `maxPlayers` (capped at 8 for the run; real pages for 2 players, bots for the rest), each with the Stage and 200 audience bots, at default options; in each run one real player's page is closed mid-game and reopened 10 s later | the game completes; the returning player has the same seat and score; no `seq` gaps stay unresolved; every audience poll in the spec opens and resolves; server p99 action→view ≤ 50 ms; **the Stage window's DOM and WebSocket traffic never contain a `host`-view field or a secret** (asserted by grepping the Stage's received frames for the scenario's secret values) |
| G11 | Content | `content.test.ts` plus the quality sample (SPEC §12) | the packs validate against the schema; item counts meet or exceed the spec; no duplicate items after normalisation; no pack item fails `filterText` at its rating; every trivia item has a `source`; the quality-sample JSON in `artifacts/content/<pack>.json` has mean ≥ 3.8 and no item ≤ 2 |
| G14 | **Pacing & engagement** | `pacing.test.ts`: the sim runner replays 50 seeded games at default options for each of 3 player counts (min, typical, max) with the **timed bot model**: each bot acts at a random point between 25% and 70% of its input window (never instantly), and the audience is simulated as 50 bots that answer every open poll | median game duration within the spec's session range (the `estMinutes` in the manifest); p90 ≤ upper bound × 1.25. **Audience idle gap** (longest stretch with no open audience interaction: poll, guess, enrol, direct action or `tap`) ≤ 30 s, excluding the declared `intro`/`final` phases. **Player idle gap** (longest stretch a connected, non-benched player has neither an input to make nor a reveal involving their own content) ≤ 45 s, unless the spec lists an explicit exception with a reason. The report goes to `artifacts/verify/<id>-pacing.json` with the timeline |
| G12 | Visual critic | §7 protocol | pass bar in §4.3 |
| G13 | Docs & handoff | the spec's "Builder notes" section (20 lines or fewer); `artifacts/handoff/<id>.md` (40 lines or fewer: what changed, scenarios, known gaps, disputed issues) | present and current |

`artifacts/verify/<id>.json` format:

```json
{ "id": "ludo", "commit": "abc123", "at": "2026-10-01T12:00:00Z",
  "gates": { "G1": {"ok": true}, "G2": {"ok": true}, "G3": {"ok": true, "coverage": 93.1},
             "G4": {"ok": true}, "G5": {"ok": true, "games": 1000, "maxSteps": 412, "seatWinRates": [0.26,0.24,0.25,0.25]},
             "G6": {"ok": true}, "G7": {"ok": true, "shots": 84}, "G8a": {"ok": true, "draws": 41, "tris": 30210, "programs": 8, "texMB": 11.2, "stageKB": 38.4, "controllerKB": 14.0},
             "G8b": {"ok": true, "p95Low": 24.1, "p95High": 9.8}, "G9": {"ok": true}, "G10": {"ok": true}, "G11": {"ok": true}, "G13": {"ok": true},
             "G14": {"ok": true, "medianMin": 10.4, "p90Min": 12.9, "audIdleMaxS": 22, "playerIdleMaxS": 38} } }
```

If no GPU runner is available, G8b is recorded as `"skipped": "no-gpu"`. That blocks `done` for **M10-07 only**, not for the game item; the game item is re-checked during M10-07.

---

## 3. Screenshot matrix (per game)

The harness reads `artifacts/scenarios/<id>.json`, which the build emits from `scenarios.ts`.

| Set | States | Modes | Viewports / roles | Count (6 states) |
|---|---|---|---|---|
| **Stage** | every scenario marked `stage` in the spec (6 or more) | day, dusk, night, rain | 360×800 (low tier, DPR 2), 1280×720 (mid), 1920×1080 (high) | 72 |
| **Stream-sim** | the 1920×1080 stage shots | dusk, night | downscaled to 1280×720 and saved as JPEG at quality 60 | 12 |
| **Controller** | every scenario marked `player` or `audience` | dusk, night | 360×800, role player or audience | 2 per state |
| **Snow spot check** | `midgame` | snow | 1920×1080 | 1 |
| **Clips** | each `anim` in the spec (dice roll, capture, reveal, win…) | dusk | 1280×720, 4–6 s WebM, not frozen | 3–6 |

Critic inputs are produced by `pnpm critic:prep <id>`:
- one **contact sheet per mode** for the Stage set (4 images)
- one sheet for Stream-sim
- one for Controller
- the clips
- the A/B pairs

Individual PNGs are available for drill-down.

File naming: `artifacts/screenshots/<id>/round-<r>/<state>__<mode>__<vp|role>.png`.

---

## 4. Visual QA rubric (`docs/critic/RUBRIC.md` is a copy of this section)

### 4.1 Anchors

| Score | Meaning |
|---|---|
| **10** | Can't be told apart from a shipped top-tier cozy indie (Tiny Glade, A Short Hike, Alba). |
| **8.5** | A player would screenshot it, and a streamer would feature it. |
| **7** | A decent web game. |
| **5** | A working prototype. |
| **3** | Broken or placeholder. |

Do not round up. When unsure, score lower.

### 4.2 Items (★ = hard gate)

Scored for each group, where a group is one mode × one viewport. "Clip" items are scored once per game from the clips. "Phone" items are scored only on 360×800 groups.

| # | Item | 10 looks like | ≤ 5 looks like |
|---|---|---|---|
| 1 ★ | **Style consistency** | Board, pieces, room and UI read as one clay, wood and paper world that matches `_style/golden` | Mixed styles, default grey three.js materials, stock widgets |
| 2 ★ | **Stream readability** (judged mainly on Stream-sim) | At 720p JPEG quality 60, whose turn it is, the current state and the scores are clear within 1 s; critical text ≥ 22 px at 1080p | Squinting required; key info sits in the webcam zone |
| 3 | **Palette adherence** | Token colours only; no pure black or white; tinted shadows; identity hexes exact in the HUD | Off-palette, grey shadows, neon |
| 4 | **Lighting & mode identity** | Clear upper-left key light; pieces lift off the board through rim light plus blob shadow; each mode is recognisable at once | Flat or harsh lighting; day and night look alike |
| 5 | **Form softness** | Every edge is beveled or rounded, with chunky toy silhouettes and radii matching the tokens | Sharp boxes, spindly shapes, jagged silhouettes |
| 6 ★ | **Hierarchy & focus** | One obvious focal point; the eye moves action → state → context | Everything shouts; unclear call to action |
| 7 | **Composition & camera** | The mat is framed per SPEC §13.4, with breathing room; stream-safe zones are respected when Stream Layout is on | Cropped board, awkward tangents, dead space |
| 8 | **Typography** | Fredoka, Nunito and Caveat only; correct scale steps; tabular numbers; no widows | Fallback fonts, random sizes, overlapping text |
| 9 | **UI component polish** | Consistent radii, shadows and 4-pt spacing; one icon stroke weight; visible states; no clipping | Misaligned, clipped, default controls |
| 10 | **Surface quality** | Wood, felt, paper and cork read as materials; no visible tiling; subtle grain | Obvious repeats, noise that looks like compression artefacts, blurry board art |
| 11 | **Accessibility** | Colour + glyph identity; passes a deuteranopia/protanopia simulation; contrast ≥ 4.5:1 | Players distinguishable only by red vs green |
| 12 | **Ambient life** (clip) | Steam, lights, weather and the cat make the room feel lived-in and unobtrusive | A dead static scene, or distracting particles |
| 13 | **Moment quality** | Reveal, capture and win moments feel celebratory and clip-worthy, with the result stated clearly | "Player 2 wins" as plain text; confetti hides the result |
| 14 | **Phone layout** (phone) | Everything fits; targets ≥ 44 px; HUD in bars; safe areas respected | Board cut off, overlaps, tiny buttons |
| 15 ★ | **AAA polish gut check** | A stranger believes it's a premium indie game | Looks like a prototype, demo or template |
| 16 | **Motion & feedback** (clip) | Correct easing and springs, with anticipation and follow-through; feedback within 100 ms; nothing snaps or jitters; the camera glides | Linear tweens, pops, jitter, camera cuts |
| 17 | **Audience & stream affordances** | Purple audience UI that is clear at a glance: poll, odds, "chat did this"; the room code is legible; the timer is clear | Audience state invisible or confusing |
| 18 | **Technical cleanliness** | No aliasing shimmer, z-fighting, seams, banding, pop-in, or FOUT captured in the screenshot | Visible artefacts |

### 4.3 Pass bar

A game (or a visual platform item) **passes** only if **all** of these hold:
1. In **every** group: the **mean ≥ 8.5**, **no item < 7.5**, and **every ★ item ≥ 8.5**.
2. Clip items (12, 16) are ≥ 8.0.
3. There are **0 open blockers**, and no previously fixed issue has come back.
4. **Blind A/B:**
   - Against `_style/golden`: our shot is chosen or tied in **at least 50%** of pairs for "which looks more cohesive with a cozy, premium house style".
   - Against external references: chosen or tied in **at least 30%** of pairs.
5. **Style golden (M2 quip-clash) only:** every ★ item ≥ 9.0, and the external-reference A/B ≥ 40%.

Pass decision: two independent critics score each round. Merge per item and group: **★ items use the minimum** of the two scores; **all other items use the mean**. If the two critics differ by more than 1.5 on any ★ item in any group, or their overall means differ by more than 1.5, a third critic scores and the **median** of the three is used for every item. (Pure min-merging of every item across ~14 groups was rejected: with two independent noisy scorers it makes "mean ≥ 8.5 in every group" statistically unreachable even for work that deserves to pass, which would push every game to `blocked`.)

Groups scored per round: 4 modes × 3 viewports (12) + `stream/dusk` + `stream/night` = 14, plus the clip items and the snow spot check (items 1, 3, 4, 18 only, same thresholds).

---

## 5. Critic report schema (`docs/critic/report.schema.json`)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["game", "round", "critic", "pass", "ab", "scores", "clipScores", "minScore", "issues"],
  "properties": {
    "game": { "type": "string" },
    "round": { "type": "integer", "minimum": 1 },
    "critic": { "type": "string" },
    "pass": { "type": "boolean" },
    "ab": { "type": "array", "items": { "type": "object", "required": ["pair", "choice", "why"],
      "properties": { "pair": {"type": "string"}, "choice": {"enum": ["A", "B", "tie"]}, "why": {"type": "string", "maxLength": 300} } } },
    "scores": { "type": "object", "description": "key = '<mode>/<viewport>' e.g. 'night/360x800' or 'stream/dusk'; value = map item# -> score or null (n/a)",
      "additionalProperties": { "type": "object", "additionalProperties": { "type": ["number", "null"], "minimum": 1, "maximum": 10 } } },
    "clipScores": { "type": "object", "properties": { "12": {"type": "number"}, "16": {"type": "number"} } },
    "minScore": { "type": "number" },
    "issues": { "type": "array", "items": { "type": "object",
      "required": ["id", "item", "severity", "files", "region", "problem", "rule", "fix"],
      "properties": {
        "id": { "type": "string", "pattern": "^[A-Z0-9]{2,4}-R[0-9]+-[0-9]{2}$" },
        "item": { "type": "integer", "minimum": 1, "maximum": 18 },
        "severity": { "enum": ["blocker", "major", "minor"] },
        "files": { "type": "array", "items": {"type": "string"}, "minItems": 1 },
        "region": { "type": "string", "description": "e.g. 'bottom-right 20%', 'P3 plate'" },
        "problem": { "type": "string" },
        "rule": { "type": "string", "description": "violated SPEC/research section or token, e.g. 'SPEC §13.3 identity P2 hex'" },
        "fix": { "type": "string", "description": "concrete: token, px, ms, easing, value change" },
        "regressionOf": { "type": "string" } } } }
  }
}
```

Issue severity:
- **blocker:** a ★ item is below 8.5, the state is unreadable, a secret leaks on the Stage, a visual bug breaks the flow, or a fixed issue came back.
- **major:** any item below 8.5.
- **minor:** everything else.

---

## 6. Prompts (`docs/critic/BUILDER_PROMPT.md`, `docs/critic/CRITIC_PROMPT.md`)

### 6.1 Builder prompt (fill in `{{…}}`)

```text
You are the builder for {{GAME_NAME}} ({{id}}) on our browser streamer party-games platform
(three.js + TypeScript). Make it utterly beautiful and make it feel like a AAA cozy game:
the warmth of A Short Hike and Tiny Glade, the on-stream readability of Jackbox, the board
clarity of Lichess. Every single thing should be at that level: the mat and pieces, the
materials and lighting, every reveal, the transitions, hover and press states, the win moment,
the idle ambience, the sound cues, the audience moments and the phone controller. A viewer
watching a 720p stream on a phone should understand it instantly and want to join.

READ FIRST, in order (nothing else unless needed):
 1. CLAUDE.md
 2. docs/specs/{{id}}.md   (your contract: rules, states, views, audience hooks, scenarios, tests)
 3. docs/SPEC.md §9.3, §9.4, §13, §14 (API, tokens, scenario contract), docs/engine-api.md
 4. docs/references/_style/golden/ and docs/references/{{id}}/ (the bar you are judged against)
 5. `pnpm progress show {{item}}` and the latest artifacts/critic/{{id}}/round-*.json if any

HARD RULES:
 - Touch only packages/games/{{id}}/**, content/packs/<your kinds>/**, your spec's Builder notes.
   Need engine changes? Write docs/engine-requests.md and stub it locally behind an interface.
 - logic/ is pure and deterministic (ctx.rng, ctx.now, ctx.timing only). Secrets live under
   `secret`/`hidden` keys. view() is the security boundary. The Stage never shows secrets.
 - Materials/textures ONLY from ctx.materials/ctx.textures; colors/durations/easings ONLY from tokens;
   repeated pieces instanced; zero per-frame allocations; dispose everything; no rAF.
 - Budgets: low tier ≤ 60 draws / 50k tris incl. environment (your share ≤ 48 / 35k), ≤ 10 programs,
   stage chunk ≤ 60 KB gz, controller ≤ 25 KB gz. Controllers are DOM/SVG; never import three there.
 - The Stage renders only the `stage` view. Host-only info goes to the host panel, never the Stage.
 - Every state in the spec's Scenarios table must be registered and render deterministically.
 - All 5 ambient modes and 360x800 / 1280x720 / 1920x1080 must look right.

WORK LOOP:
 1. TDD the logic (a test per numbered rule R# and test case T#), then bot, contract, 1000-game sim,
    then the G14 pacing report. If pacing fails, change timers/defaults per the spec's pacing
    table (never loosen G14) and record it in Builder notes.
 2. Stage + controller + scenarios. 3. `pnpm verify:game {{id}}` until G1–G11, G13, G14 are green.
 4. Write artifacts/handoff/{{id}}.md (≤ 40 lines). Do NOT grade your own visuals.
 5. On a critic report: fix blockers → majors → minors; you may dispute an issue only by adding
    "disputed: <reason>" in the handoff. Re-verify, hand off again.
Stop only when a harsh blind critic, comparing your screenshots side by side with the golden and
references, would pick yours or call it a tie in every mode and viewport.
```

### 6.2 Critic prompt (a fresh agent every round; never the builder)

```text
You are a ruthless visual and UX critic for a cozy, lofi, AAA-polish streamer party game.
You have NOT seen the code or the builder's notes and must not open them. Inputs, only:
 - artifacts/critic/{{id}}/round-{{r}}/sheets/*.png (contact sheets), clips/*.webm, shots/*.png (drill-down)
 - artifacts/critic/{{id}}/ab-{{r}}/pair-*.png (A|B side by side, order randomized; key hidden)
 - docs/critic/RUBRIC.md, docs/references/_style/golden/*, docs/references/{{id}}/*
 - docs/specs/{{id}}.md section "Scenarios" only (what each state should show)
 - previous round's issue IDs + one-line summaries (to check regressions), nothing else
Step 1 BLIND A/B: for each pair, choose A, B or tie for "more cohesive, premium cozy house style"
 in ≤ 2 sentences. Commit before step 2.
Step 2 SCORE every rubric item 1–10 for every group (mode × viewport, plus stream/dusk and
 stream/night) using the anchors. 8.5 = a player would screenshot it. Don't round up; if unsure, lower.
Step 3 ISSUES: every item < 8.5 needs ≥ 1 issue with id, item, severity, files, region, violated
 rule (cite SPEC/research section or token), and a concrete fix (token, px, ms, easing, value).
 No vague notes ("make it pop" is invalid). Mark regressions with regressionOf.
Output ONLY JSON valid against docs/critic/report.schema.json. Compute pass using RUBRIC §4.3
 from your own scores (the orchestrator recomputes it with the other critic's minimums).
```

---

## 7. Critic loop protocol

```
builder: Mx-01..04 → `verify:game` (G1–G11, G13, G14 green) → handoff → status: verifying → critic
round r = 1..5:
  harness: `pnpm critic:prep <id> --round r`  (shots, stream-sim, sheets, clips, A/B pairs + hidden key)
  spawn 2 FRESH critics in parallel (no builder context, no prior critic reasoning; only prior issue IDs)
  orchestrator: validate both JSONs against schema (invalid → re-spawn that critic once)
               → merge per §4.3 (★ = min, others = mean; 3rd critic + median on > 1.5 disagreement) → apply §4.3
  pass  → status: done; copy passing shots to artifacts/critic/<id>/approved/; (M2: promote to golden)
  fail  → status: fixing; spawn fresh builder with: spec + merged report + last handoff only
          builder fixes blockers → majors → minors; G1–G11 must stay green; hand off
early escalation: if the merged minScore rises < 0.3 over 2 consecutive rounds → status: blocked
after round 5 without pass → status: blocked; orchestrator writes artifacts/critic/<id>/BLOCKED.md
          (remaining issues, disputed items, recommendation) for a human
```

Rules:
- **Calibration first:** M0-06 must pass before any critic round counts (see ROADMAP). Before the golden exists (M0-06, M1-07, and M2 itself), item 1 is scored against `docs/references/_style/` and research 03 instead of `_style/golden`, and the golden A/B (§4.3.4, first bullet) is skipped; it is replaced by the external-reference A/B at ≥ 40%. After M2-06, M1-07's platform scenarios are re-scored against the golden (ROADMAP M2-06).
- **Pacing before polish:** a game whose G14 pacing gate fails never enters the critic loop; fix the design first, then the pixels.
- **Regressions:** an issue fixed in round r that comes back in round r+k is automatically a blocker.
- **Disputes:** only the orchestrator decides. A dispute it accepts is recorded in the report as `waived` with a reason. A waiver is **never** allowed for ★ items or secret leaks.
- **Drift guard:** after every 5 games reach `done`, and in M10-09, a fresh critic re-scores every done game's approved shots against the golden. Any game that drops below the bar goes back to `fixing`.
- **Engine-change regression:** a change to shared packages re-runs the screenshots of every done game. If pixelmatch shows more than 2% of pixels changed in any shot, that game gets a 1-round critic re-check.

---

## 8. Status lifecycle & evidence

`todo → building → verifying → critic → fixing → verifying → critic … → done`, and `blocked` (with a reason) is reachable from any state.

| Transition | Required evidence (checked by `progress.ts`) |
|---|---|
| → verifying | the handoff exists |
| → critic | `artifacts/verify/<id>.json` with G1–G11, G13 and G14 `ok` (G8b may be `skipped: no-gpu`) |
| → done | the verify JSON is still green at the current commit, **and** the merged critic report has `pass: true` (only for items with visuals), **and** no open blockers |
| → blocked | `blockedReason` is set |

Every commit message looks like `<item-id>: <what>`. Nobody hand-edits `PROGRESS.md`.
