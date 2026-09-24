# 05 — Builder Prompting Style & Multi-Agent Development Harness

Status: research + proposal, 2026-09-24
Scope: (A) What Matt Shumer's prompting style actually is and a reusable builder/critic prompt template for per-game subagents. (B) The harness that keeps a long multi-agent build on track: CLAUDE.md, PROGRESS tracker, per-game specs, definition of done, deterministic scenario URLs, Playwright screenshot capture, critic loop.

---

## Part A — Matt Shumer's prompting style

### A.1 What he actually did (primary sources)

- **The "Claude of Duty" prompt** (July 2026, Claude Opus 5, three.js, zero external assets). Full text as published in the repo ([prompt.md](https://github.com/mshumer/Claude-of-Duty/blob/main/prompt.md), [X post](https://x.com/mattshumer_/status/2081100592689324502)):

  > I want you to build a first-person shooter at the level of the most recent Call of Duty games. It should be utterly perfect, visually beautiful, with every single thing done at AAA quality—from textures to physics to anything you could think of.
  >
  > Fan out sub-agents and have sub-agents tackle each one individually so that the game is utterly perfect. You should /loop on each item and have a separate sub-agent check it visually to ensure it looks triple A. That separate sub-agent should be a really harsh critic, and if it doesn't look triple A, it should keep going.
  >
  > Don't stop until each sub-agent is utterly wowed with the quality when compared with the actual Call of Duty game. It should literally compare them side by side blind and say which one looks better. Do this in ThreeJS. /loop until it's utterly perfect. Fan out sub-agents and ultracode.

- **He named the technique the "Gauntlet Loop"** ([X](https://x.com/mattshumer_/status/2081830214384886228), [how-to thread](https://x.com/mattshumer_/status/2081857631254372509)): "The agent (not you!!) breaks the goal into parts, gives each part a specialist builder and a ruthless blind critic sub-agent, with a mandate to only pass if the generated artifact is better than some real-world equivalent."
- A generalised seed template and five principles are written up at [explainx.ai](https://explainx.ai/blog/gauntlet-loop-matt-shumer-builder-critic-agent-technique-2026). Press coverage: [Decrypt](https://decrypt.co/374560/dumbest-ai-prompt-claude-beat-careful-game-design), [Enterprise DNA](https://enterprisedna.co/resources/ai-pulse/ai-pulse-2026-07-26-matt-shumer-one-shot-a-aaa-quality-fps-in-three-js-with-clau/). The result was about 55k LOC across 11 subsystems.
- Earlier work in the same vein: [gpt-prompt-engineer / claude-prompt-engineer](https://github.com/mshumer/gpt-prompt-engineer) ([X](https://x.com/mattshumer_/status/1770494629844074975)). It generates many candidate prompts, runs them in a ranked tournament and keeps the winner. Same idea as the Gauntlet Loop: comparison-based judging beats abstract self-assessment.

### A.2 The principles

1. **Name a concrete, inspectable reference bar.** Don't say "make it good". Say "at the level of X", where X is a real product the critic can look at. Per explainx, this is the one requirement that can't be skipped. Without a real reference, critics make up arbitrary standards and burn tokens.
2. **Use maximalist quality language.** "Utterly perfect", "AAA", "every single thing … from textures to physics to anything you could think of." It raises the model's ambition ceiling and lists the quality dimensions so none get skipped.
3. **The agent does the decomposition, not the human.** The prompt is short and delegates planning ("fan out sub-agents … tackle each one individually").
4. **Builder and critic are separate agents.** The critic never sees the builder's reasoning or excuses. This matches Anthropic's own finding: "separating the agent doing the work from the agent judging it proves to be a strong lever" against self-evaluation bias ([InfoQ on Anthropic's 3-agent harness](https://infoq.com/news/2026/04/anthropic-three-agent-harness-ai/)).
5. **Judge visually.** The critic looks at rendered output (screenshots, video), not code.
6. **Judge blind and side by side.** The critic compares A and B with labels stripped and says which is better. This is harder to game than a 1–10 score.
7. **Loop until pass.** "Don't stop until … utterly wowed." Anthropic's evaluator loops ran 5–15 iterations per run.

### A.3 Caveats to design around

- **Hype vs. reality.** An independent audit had 11 critics score the FPS 3.5–5.0/10 against real CoD ([Enterprise DNA](https://enterprisedna.co/resources/ai-pulse/ai-pulse-2026-07-26-matt-shumer-one-shot-a-aaa-quality-fps-in-three-js-with-clau/)). Agents that say they are "utterly wowed" are inflated. **Our fix:** a written rubric with score anchors, fresh critics every round, and a blind A/B against reference images stored in the repo.
- **"Loop until perfect" has no budget.** On a 20+ game build that means runaway cost and oscillation. **Our fix:** at most N rounds (default 5), then escalate to a human with the remaining issues.
- **It works best in heavily documented genres** (Decrypt's contamination point). Ludo, chess and trivia are also heavily documented, which helps. Novel party mechanics need tighter specs.
- **The literal CoD bar is wrong for us.** Our bar is *cozy, lofi, soft, readable on a 360px phone and on a 1080p stream*, not photoreal. The reference set has to reflect that (see A.5).

### A.4 How we adapt it

We keep the spirit (a real reference bar, maximalist craft language, a separate harsh blind critic, looping) and add what a 20-game, weeks-long build needs:

| Shumer original | Our harness |
|---|---|
| One mega-prompt, agent self-decomposes | Orchestrator already has a roadmap. Each builder gets **one game + its spec** |
| "Compare with actual CoD" | Compare against the **reference board** in `docs/references/<game>/` plus our own **style golden** (the approved first game) |
| Critic "utterly wowed" | Rubric with 1–10 anchors; pass = **every item ≥ 8.5** in every mode × viewport, and a blind A/B that doesn't lose to the style golden |
| /loop forever | Max 5 rounds per critic cycle, then `BLOCKED` with the issue list |
| Visual only | Visual plus hard gates: typecheck, lint, unit tests, bot-simulated full match, perf budget |

### A.5 Reference bar for our visual style

Keep 3–6 PNGs per game in `docs/references/<game>/`, plus `docs/references/_style/` for the house style. Suggested anchors for the "cozy / lofi / soft / modern" feel:

- Style: *A Short Hike*, *Unpacking*, *Alba: A Wildlife Adventure*, *Townscaper*, *Lofi Girl* stream scenes, Monument Valley (lighting and palette).
- Party UI clarity: Jackbox Party Packs (big type, instant readability on stream), Gartic Phone, skribbl.io.
- Board games: Lichess/Chess.com board readability. Ludo King's layout is the familiar baseline to beat on charm.
- Once game #1 passes, add its screenshots to `_style/golden/`. **Every later game is blind-A/B'd against it** for style consistency. This stops quality drift across the build.

(Reference images are for critic comparison only and are never shipped.)

### A.6 BUILDER PROMPT TEMPLATE (give to each game-building subagent)

Fill in `{{…}}`. Keep it short at the top and hard at the bottom: the ambition first, the contract after.

```text
You are the builder for {{GAME_NAME}} on our browser streamer party-games platform
(three.js + TypeScript). Build it so it is utterly beautiful and feels like a AAA
cozy game: the level of polish of {{REFERENCE_TITLES e.g. "A Short Hike's warmth +
Jackbox's on-stream readability + Lichess's board clarity"}}. Every single thing
should be done at that quality: the board, pieces, materials, lighting, the dice
roll, turn transitions, hover and press states, the win moment, the idle ambience,
the sound hooks, the spectator overlay, and anything else you can think of.
Someone watching a stream on a phone should be able to follow it instantly and
want to join.

READ FIRST (in this order, and nothing else unless needed):
  1. CLAUDE.md                       (house rules; non-negotiable)
  2. docs/specs/{{game}}.md          (the contract: rules, states, scenarios, DoD)
  3. docs/style/STYLE.md             (tokens, palette per ambient mode, motion curves)
  4. docs/references/{{game}}/ + docs/references/_style/golden/  (the bar you are judged against)
  5. PROGRESS.md row for {{game}} + the last critic report in artifacts/critic/{{game}}/ if any

HARD CONSTRAINTS:
  - Use only the shared engine: src/core (room, turn, rng, net), src/render (scene,
    ambient modes, materials, postfx), src/ui (tokens, components). Do not fork them.
    If the engine lacks something, write a request to docs/engine-requests.md and
    stub it locally behind an interface.
  - Game logic lives in src/games/{{game}}/logic/ as pure, deterministic TS
    (seeded RNG only, no DOM, no three.js, no Date.now). Rendering reads state; it
    never mutates it.
  - Register scenarios {{LIST from spec, e.g. lobby, opening, midgame, capture,
    endgame, victory}} so ?game={{game}}&state=<s>&mode=<m>&seed=<n> renders
    deterministically with no interaction.
  - Perf budget: <= {{150}} draw calls, <= {{80k}} tris, <= {{60}}MB GPU mem, 60fps on
    desktop, >= 30fps at the "low" quality tier (the Chromebook/low-end phone
    profile), JS for this game <= {{120}}KB gz. No external runtime assets beyond
    the shared atlas; procedural or shared-atlas only.
  - Everything must look right in ALL ambient modes (day, dusk, night, rain) and at
    360x800 portrait, 1280x720, and 1920x1080 (stream).

WORK LOOP:
  1. Write the logic with its unit tests first (TDD). Then the bot player. Then the
     full-match simulation test (1000 seeded matches, no exceptions, every game terminates).
  2. Build the visuals and interaction. Register the scenarios.
  3. Run `npm run verify:game -- {{game}}` (typecheck, lint, tests, sim, perf,
     screenshots). Fix until green.
  4. Hand off by writing artifacts/handoff/{{game}}.md: what changed, the
     scenarios list, known gaps. Do NOT grade your own work; a separate critic will,
     blind, against the references. Do not argue with the critic in code comments.
  5. When you get a critic report, fix every issue scored < 8.5, highest severity
     first, re-run verify, and hand off again.

Don't stop at "works". Stop when a harsh, blind critic comparing your screenshots
side by side with the references would choose yours or call it a tie, in every
mode and viewport. Update PROGRESS.md (your row only) before you finish.
```

### A.7 CRITIC PROMPT TEMPLATE (fresh subagent every round, never the builder)

```text
You are a ruthless visual and UX critic for a cozy, lofi, AAA-polish streamer party
game. You have NOT seen the code or the builder's notes, and you must not read them.
Your inputs are only:
  - artifacts/screenshots/{{game}}/round-{{r}}/*.png  (states x modes x viewports)
  - artifacts/screenshots/{{game}}/round-{{r}}/*.webm (short interaction clips, if present)
  - docs/references/{{game}}/*, docs/references/_style/golden/*
  - docs/critic/RUBRIC.md
  - docs/specs/{{game}}.md section "Scenarios" (to know what each state should show)

Step 1: BLIND A/B. For each of the pairs in artifacts/critic/{{game}}/ab-{{r}}/
(images labelled only A and B, order randomised by the harness) say which is better
and why in <= 2 sentences. Only afterwards will you be told which was ours.
Step 2: Score every rubric item 1-10 for EVERY screenshot group (mode x viewport).
Use the anchors in RUBRIC.md. 8.5 means "a player would screenshot this"; 10 means
"indistinguishable from a shipped top-tier indie". Do not round up. If unsure, score lower.
Step 3: List issues. Each issue: id, rubric item, severity (blocker|major|minor),
screenshot file(s), what is wrong, what "fixed" looks like (concrete: px, color
token, easing, timing). No vague notes ("make it pop").

Output ONLY JSON matching docs/critic/report.schema.json. Pass = true only if every
item in every group is >= 8.5, there are no blockers, and the A/B is not lost to the style golden.
```

---

## Part B — Development harness

Design goals: (1) any agent can pick up cold in under 2 minutes; (2) context stays small, so each agent reads one spec and one progress row, not the whole repo; (3) quality can't drift, because every game faces the same automated gates and the same calibrated critic; (4) nothing is marked done without evidence. This follows Anthropic's long-running-agent guidance: a structured feature list the agent may not quietly edit, a progress file, git checkpoints, a fixed session-start routine, and browser-automation verification ([Anthropic Engineering](https://anthropic.com/engineering/effective-harnesses-for-long-running-agents), [cwc-long-running-agents](https://github.com/anthropics/cwc-long-running-agents)). It also uses context resets with handoff artifacts instead of compaction ([InfoQ](https://infoq.com/news/2026/04/anthropic-three-agent-harness-ai/)).

### B.1 Repo layout

```
CLAUDE.md                     # house rules (short, <= 150 lines)
PROGRESS.md                   # human-readable roadmap, generated from progress.json
progress.json                 # source of truth for status (JSON = harder for agents to corrupt)
docs/
  research/                   # these docs
  style/STYLE.md              # tokens, palettes per mode, motion, typography
  specs/_TEMPLATE.md
  specs/<game>.md             # one per game: rules, states, scenarios, DoD overrides
  critic/RUBRIC.md            # scoring items + anchors
  critic/report.schema.json
  references/_style/golden/   # approved screenshots of the style-golden game
  references/<game>/          # reference imagery for blind A/B
  engine-requests.md          # builders ask for core changes here, orchestrator triages
  decisions/ADR-XXXX.md       # architecture decisions
src/
  core/ render/ ui/ net/      # shared engine (owned by the orchestrator/engine agent)
  games/<game>/{logic,bot,view,scenarios.ts,index.ts}
  dev/scenario.ts             # URL param system
tests/                        # vitest: logic + sim
e2e/screenshots.spec.ts       # Playwright capture
scripts/verify-game.ts        # runs the whole DoD for one game
scripts/progress.ts           # regenerates PROGRESS.md, validates transitions
artifacts/                    # gitignored except critic reports
  screenshots/<game>/round-<r>/
  critic/<game>/round-<r>.json
  handoff/<game>.md
  perf/<game>.json
```

### B.2 CLAUDE.md (drop-in)

```markdown
# Streamer Games Online: agent rules

## Session start (always, in order)
1. Read this file, then PROGRESS.md. Find YOUR assigned item. If none is assigned, stop and ask.
2. Read only: docs/specs/<your game>.md, docs/style/STYLE.md, the last critic report for your item.
3. `npm run verify:game -- <game>` to see the current state before changing anything.

## Scope rules
- One game/item per agent. Touch only src/games/<game>/**, tests for it, its spec's
  "Builder notes" section, and your PROGRESS row (via `npm run progress -- set ...`).
- src/core, src/render, src/ui, src/net are engine code. Don't edit them; file a
  request in docs/engine-requests.md. Only the engine agent edits them.
- Never delete or weaken a test, a DoD item, a scenario, or a rubric threshold to get green.
  That is an automatic fail.
- Never mark an item `done` yourself. Only `npm run verify:game` + a passing critic
  report can move it to `done` (scripts/progress.ts enforces this).

## Code rules
- TypeScript strict. No `any` without a `// reason:` comment.
- Logic is pure and deterministic: seeded RNG from src/core/rng, no Date/Math.random/DOM/three in logic/.
- Rendering: shared materials/atlas only, instancing for repeated pieces, no per-frame
  allocations, dispose on unmount, respect the quality tier (low|med|high).
- All colors, radii, durations, easings come from src/ui/tokens + the active ambient mode. No literals.
- Every visible state must be reachable via a scenario (?game=&state=&mode=&seed=).
- Motion: enter 220-320ms ease-out-cubic, exit 160-200ms; nothing snaps; respect prefers-reduced-motion.

## Done means
See the DoD in docs/specs/_TEMPLATE.md. Evidence goes in artifacts/. Claims without artifacts don't count.

## Session end
- Commit with message `<game>: <what>`, and update your PROGRESS row + notes (<= 3 lines).
- Write artifacts/handoff/<game>.md if handing to the critic.
- Keep context small: don't paste large files into notes; link paths.
```

### B.3 progress.json + PROGRESS.md

Status lifecycle (enforced by `scripts/progress.ts`, which rejects illegal jumps):

`todo → spec → building → verifying → critic → fixing → (critic …) → done`, plus `blocked` from any state (it needs a reason).

`progress.json` entry:

```json
{
  "id": "ludo",
  "tier": 1,
  "owner": "builder-ludo-02",
  "status": "fixing",
  "criticRound": 2,
  "maxRounds": 5,
  "gates": {
    "typecheck": true, "lint": true, "unit": true, "sim": true,
    "perf": false, "screenshots": true, "critic": false
  },
  "lastCritic": { "round": 2, "minScore": 7.5, "failing": ["rain/360x800: board-legibility 7.5", "night/*: piece-silhouette 8.0"] },
  "blockedReason": null,
  "notes": "Perf: shadow map too big on low tier; switching to blob shadows.",
  "updated": "2026-09-24T12:00:00Z"
}
```

`PROGRESS.md` is **generated** (never hand-edited), so the orchestrator reads one small table:

```markdown
| Game | Tier | Status | Round | typecheck | lint | unit | sim | perf | shots | critic | min score | Owner | Notes |
|------|------|--------|-------|---|---|---|---|---|---|---|-----|-------|-------|
| engine-core | 0 | done | - | ✅ | ✅ | ✅ | - | ✅ | ✅ | ✅ | 8.8 | engine | |
| ludo | 1 | fixing | 2/5 | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ❌ | 7.5 | builder-ludo-02 | blob shadows |
```

Commands: `npm run progress -- set ludo status=verifying`, `npm run progress -- show ludo` (prints just that row plus the last critic failing items, which keeps context small).

### B.4 docs/specs/<game>.md template

```markdown
# <Game>
Tier: 1 | Players: 2-4 (+teams?) | Round length target: 6-12 min | Audience hooks: predict winner, vote "chaos dice"

## Why it's in (engagement case)
<= 3 bullets: proven streamer/party hit, learnable in < 30s, fun to watch.

## Rules (authoritative, numbered)
1. ...
### Host options (customizable)
| option | type | default | range |

## State model
TypeScript types for GameState, Action, and the phases enum. Legal-move function signature.

## Audience / streamer features
Voting, predictions, reactions, and what the spectator overlay shows.

## Visual direction
Hero moment(s): e.g. dice tumble with soft bounce, capture pop, victory confetti in mode-tinted palette.
Camera: fixed ortho-ish 3/4, 35mm feel. Readability: piece silhouette readable at 360px width.
Reference images: docs/references/<game>/

## Scenarios (must be registered, deterministic)
| state id | description | what the critic should see |
| lobby | 4 seats, 2 filled | seat cards, invite code large |
| opening | turn 1, dice rolling mid-anim frozen at t=0.5 | ... |
| midgame | seed-driven 20 moves in | ... |
| capture | frame right after a capture | capture FX visible |
| endgame | one player 1 move from win | tension UI |
| victory | winner screen | ... |

## Definition of Done (defaults below; list overrides here)
## Builder notes (builder-owned, <= 20 lines)
```

### B.5 Definition of Done (per game, all mandatory)

| # | Gate | How it's checked | Threshold |
|---|------|------------------|-----------|
| 1 | Typecheck | `tsc --noEmit` | 0 errors |
| 2 | Lint | `eslint src/games/<g>` (+ rule: no literal colors/durations) | 0 errors |
| 3 | Logic unit tests | `vitest run tests/<g>` | 100% pass; each numbered spec rule has ≥1 test; ≥90% branch coverage on logic/ |
| 4 | Bot-simulated full match | `vitest run tests/<g>/sim` runs N seeded bot-vs-bot matches (N=1000 for turn-based, 200 for real-time) | 0 exceptions, 0 illegal moves, 100% terminate within max turns, no invariant violations; the win distribution is sane (no seat > 60% in symmetric games) |
| 5 | Scenario coverage | script checks every spec scenario is registered and renders with no console errors | 100% |
| 6 | Screenshots | Playwright: states × modes × viewports | all captured, 0 console errors, no blank/NaN canvas (pixel variance check) |
| 7 | Perf budget | Playwright + `renderer.info` + CDP CPU throttle 4× on the "low" tier | draw calls ≤150, tris ≤80k, p95 frame ≤33ms at low tier under 4× throttle, ≤16.7ms desktop; heap growth <5MB over a 60s idle loop; game chunk ≤120KB gz |
| 8 | Visual critic | fresh critic subagent per RUBRIC.md | **every rubric item ≥ 8.5 in every (mode × viewport) group**, 0 blockers, blind A/B not lost to style golden |
| 9 | Accessibility basics | automated | text contrast ≥4.5:1 in all modes, tap targets ≥44px at 360px, reduced-motion path works |
| 10 | Multiplayer smoke | 2–4 headless clients join a room, play 10 turns, one disconnects and reconnects | state converges, no desync |
| 11 | Docs | spec "Builder notes" + handoff updated; PROGRESS row regenerated | present |

`npm run verify:game -- <g>` runs 1–7, 9 and 10 and writes `artifacts/verify/<g>.json`. Gate 8 runs only once 1–7 are green, so critic tokens aren't spent on broken builds.

### B.6 Scenario URL system (`src/dev/scenario.ts`)

URL: `?game=ludo&state=midgame&mode=night&seed=3&vp=mobile&quality=low&t=0.5&freeze=1&hud=1`

| param | meaning |
|---|---|
| `game` | game id (loads only that game's chunk) |
| `state` | scenario id registered by the game |
| `mode` | `day` \| `dusk` \| `night` \| `rain` |
| `seed` | RNG seed (drives the scenario builder and any randomized visuals such as particles) |
| `quality` | `low` \| `med` \| `high` (forces the tier) |
| `t` | normalized time within the scenario's hero animation (0–1) to freeze on |
| `freeze` | `1` = pause the render clock after the first stable frame (deterministic screenshots) |
| `hud` | `0` hides UI for board-only shots |
| `role` | `host` \| `player` \| `spectator` (which overlay is shown) |

Contract each game implements:

```ts
// src/dev/scenario.ts
export interface ScenarioCtx { seed: number; rng: Rng; players: number; role: Role }
export interface Scenario<S> {
  id: string;
  description: string;
  build(ctx: ScenarioCtx): S;             // pure: returns a full GameState
  anim?: { name: string; duration: number }; // hero animation that `t` scrubs
}
export type ScenarioRegistry<S> = Record<string, Scenario<S>>;

// src/games/ludo/scenarios.ts
export const scenarios: ScenarioRegistry<LudoState> = {
  midgame: {
    id: 'midgame',
    description: '20 seeded bot moves in, 4 players',
    build: ({ rng, players }) => playBots(initialState({ players }), rng, 20),
  },
  capture: { id: 'capture', description: 'frame after capture', build: ..., anim: { name: 'capture', duration: 0.6 } },
};
```

Boot behavior in dev and preview builds only (tree-shaken from prod unless `?dev` is allowed by the host):
1. Parse params → `setAmbientMode(mode, { instant: true })` → `setQuality(q)`.
2. `state = scenarios[state].build({ seed, rng: createRng(seed), ... })` → mount the view with no network (local room).
3. If `t` is set, seek the hero animation to `t`. If `freeze=1`, stop the clock after 2 stable frames.
4. Set `window.__SCENE_READY__ = true` and `window.__SCENE_INFO__ = { drawCalls, tris, fps }`. Playwright waits on this, never on timeouts.
5. Determinism: all `Math.random` in render code goes through `rng.visual(seed)`, and fonts/atlas are preloaded before ready.

### B.7 Playwright screenshot script (`e2e/screenshots.spec.ts`)

```ts
import { test, expect, devices } from '@playwright/test';
import fs from 'node:fs';

const GAME = process.env.GAME!;                          // e.g. ludo
const ROUND = process.env.ROUND ?? 'latest';
const MODES = (process.env.MODES ?? 'day,dusk,night,rain').split(',');
const spec = JSON.parse(fs.readFileSync(`artifacts/scenarios/${GAME}.json`, 'utf8')); // emitted by build
const STATES: string[] = process.env.STATES?.split(',') ?? spec.states;
const SEED = process.env.SEED ?? '3';

const VIEWPORTS = {
  mobile:  { viewport: { width: 360, height: 800 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  desktop: { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 },
  stream:  { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 },
} as const;

for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
  test.describe(`${GAME} @ ${vpName}`, () => {
    test.use(vp);
    for (const state of STATES) for (const mode of MODES) {
      test(`${state} / ${mode}`, async ({ page }) => {
        const errors: string[] = [];
        page.on('console', m => m.type() === 'error' && errors.push(m.text()));
        page.on('pageerror', e => errors.push(String(e)));

        const url = `/?game=${GAME}&state=${state}&mode=${mode}&seed=${SEED}&freeze=1&quality=${vpName === 'mobile' ? 'low' : 'high'}`;
        await page.goto(url);
        await page.waitForFunction(() => (window as any).__SCENE_READY__ === true, null, { timeout: 20_000 });

        const dir = `artifacts/screenshots/${GAME}/round-${ROUND}`;
        const file = `${dir}/${state}__${mode}__${vpName}.png`;
        await page.screenshot({ path: file, animations: 'disabled' });

        const info = await page.evaluate(() => (window as any).__SCENE_INFO__);
        fs.mkdirSync(`artifacts/perf/${GAME}`, { recursive: true });
        fs.writeFileSync(`artifacts/perf/${GAME}/${state}__${mode}__${vpName}.json`, JSON.stringify(info));

        expect(errors, errors.join('\n')).toHaveLength(0);
        expect(info.drawCalls).toBeLessThanOrEqual(150);
      });
    }
  });
}
```

Plus:
- `e2e/clips.spec.ts` records a 4–6s `.webm` of each hero animation (no `freeze`), so the critic can judge motion and not only stills.
- `scripts/contact-sheet.ts` tiles each game's PNGs into one grid image per mode. The critic gets 4 sheets, not 72 files, which saves a lot of vision tokens. Individual files are for drill-down only.
- `scripts/ab-pairs.ts` pairs our shots with reference/golden images, randomizes the A/B order and writes a hidden key to `artifacts/critic/<g>/ab-<r>.key.json` that the critic can't read.
- `playwright.config.ts`: `webServer: { command: 'npm run preview', port: 4173 }`, `use.baseURL`, `fullyParallel: true`, one Chromium project with `--use-gl=angle --use-angle=swiftshader` for CI determinism, plus a GPU project for local runs.
- Perf gate: a separate test with CDP `Emulation.setCPUThrottlingRate({ rate: 4 })` samples `performance.now()` frame deltas for 10s in the `midgame` scenario (unfrozen) and asserts p95.

Matrix size per game ≈ 6 states × 4 modes × 3 viewports = 72 shots, about 1–2 minutes in parallel.

### B.8 Critic rubric (`docs/critic/RUBRIC.md`, abbreviated)

Each item is scored 1–10 per (mode × viewport) group. Anchors: **5** = functional prototype; **7** = decent web game; **8.5** = "a player would screenshot this / a streamer would feature it"; **10** = shipped top-tier indie.

1. **Readability at a glance.** Game state understandable in 2s on a 360px phone and a scaled-down stream.
2. **Style cohesion.** Matches STYLE.md and the golden: soft palette, rounded forms, gentle lighting, no off-style assets.
3. **Ambient mode quality.** The mode reads clearly (night is moody but still legible; rain has visible but non-noisy particles and wet sheen) and contrast holds.
4. **Composition and layout.** Hierarchy, safe areas, no overlap or clipping, balanced negative space, streamer-overlay safe zones.
5. **Materials and lighting.** Pieces feel tactile and cozy (soft AO, rim light, no flat-shaded or plastic look), within low-tier limits.
6. **Motion and feedback** (from clips). Easing, anticipation and follow-through; every action gives feedback within 100ms; nothing snaps or jitters.
7. **Typography and UI polish.** Token fonts, sizes and spacing; buttons have states; no default-browser look.
8. **Juice and hero moments.** Dice, capture and win moments feel celebratory and "clip-worthy".
9. **Audience/stream affordances.** Vote/predict UI is clear, room code is legible on stream, spectator overlay is useful.
10. **Technical cleanliness.** No aliasing shimmer, z-fighting, texture seams, banding or pop-in.

`report.schema.json`:

```json
{ "game": "ludo", "round": 2, "pass": false,
  "ab": [{ "pair": "p1", "choice": "B", "why": "..." }],
  "scores": { "night/360x800": { "readability": 7.5, "style": 9, "...": 0 } },
  "minScore": 7.5,
  "issues": [{ "id": "L2-03", "item": "readability", "severity": "blocker",
               "files": ["midgame__night__mobile.png"],
               "problem": "Blue pieces vanish on the night board (contrast ~1.8:1)",
               "fix": "Use token piece.blue.night (#8FB8FF) + 2px rim light; target >= 3:1 vs board" }] }
```

### B.9 Critic loop protocol

```
orchestrator
  ├─ assign builder(g)  ── status: building
  │     builder: TDD logic → bot → sim → view → scenarios → verify:game green → handoff
  ├─ status: verifying   (script-only; if red → back to builder, no critic spent)
  ├─ round r = 1..MAX(5):
  │     harness: screenshots + clips + contact sheets + A/B pairs → artifacts/…/round-r
  │     spawn FRESH critic(g, r)  (no builder context, no previous critic's reasoning;
  │            only gets the previous round's issue IDs to check for regressions)
  │     critic → artifacts/critic/g/round-r.json (validated against schema)
  │     pass? → status: done, promote screenshots, stop
  │     else  → status: fixing; builder (fresh context: spec + report + handoff only)
  │             fixes blockers → majors → minors; verify:game must stay green
  ├─ after MAX rounds with no pass → status: blocked, orchestrator summarizes remaining
  │     issues for a human; optionally one "second-opinion" critic to catch miscalibration
  └─ drift guard: every 5 games done, re-run a critic on ALL done games' golden shots
        against the current golden; any game that drops < 8.5 reopens as `fixing`
```

Rules that make the loop converge:
- **The critic never sees builder code, notes or arguments** (Shumer's blind critic, Anthropic's separated evaluator).
- **Fresh critic each round** to avoid anchoring. To reduce variance, the pass decision can use two critics and take the **min** score per item.
- **Issues must be actionable** (file, token, number). The schema rejects issues without a `fix`.
- **Regression check.** A fixed issue that comes back counts as a blocker.
- **Oscillation stop.** If minScore doesn't improve by ≥0.3 across 2 rounds, escalate early instead of burning rounds.
- **The builder may dispute** exactly by adding `"disputed": "<reason>"` to an issue in its handoff. The orchestrator (not the builder) decides.
- **Critic calibration.** Before the build starts, score the reference images themselves; they should land at 9–10. Score a deliberately rough prototype; it should land at 4–6. If not, fix the rubric anchors first.

### B.10 Keeping context small (anti-bloat rules)

- Each agent reads at most: CLAUDE.md, one spec, STYLE.md, one progress row, the latest critic JSON. Target under 15k tokens of docs.
- The engine exposes a **stable, documented API** (`docs/engine-api.md`, generated from TSDoc) so builders never read engine source.
- Critic input is contact sheets and clips, not code.
- Handoffs are capped at 40 lines. Notes in progress.json are capped at 3 lines. Long history lives in git log, not in docs.
- Use context resets with handoff artifacts over long-lived agents: one builder session per game per round.

### B.11 Build order

1. **Engine plus style golden first.** Build core (room, turn, rng, net), render (ambient modes, material library, quality tiers), ui tokens, the scenario system and the Playwright harness. Then build **one tier-1 game** (e.g. Ludo) all the way to critic pass. Its screenshots become `_style/golden`.
2. Then fan out tier-1 games in parallel, 3–5 builders at a time, each with its own critic loop.
3. The engine agent triages `engine-requests.md` between waves. Any engine change triggers a screenshot regression run on all `done` games, using pixel-diff against their last passing shots and a threshold before re-critic.

---

## Sources
- Matt Shumer, Claude of Duty prompt: https://github.com/mshumer/Claude-of-Duty/blob/main/prompt.md
- Matt Shumer on X (prompt): https://x.com/mattshumer_/status/2081100592689324502
- Matt Shumer on X (Gauntlet Loop definition): https://x.com/mattshumer_/status/2081830214384886228
- Matt Shumer on X (how-to thread): https://x.com/mattshumer_/status/2081857631254372509
- explainx.ai, Gauntlet Loop explained: https://explainx.ai/blog/gauntlet-loop-matt-shumer-builder-critic-agent-technique-2026
- Decrypt coverage and caveats: https://decrypt.co/374560/dumbest-ai-prompt-claude-beat-careful-game-design
- Enterprise DNA (independent audit 3.5–5/10): https://enterprisedna.co/resources/ai-pulse/ai-pulse-2026-07-26-matt-shumer-one-shot-a-aaa-quality-fps-in-three-js-with-clau/
- mshumer/gpt-prompt-engineer (tournament-ranked prompts): https://github.com/mshumer/gpt-prompt-engineer
- Anthropic, Effective harnesses for long-running agents: https://anthropic.com/engineering/effective-harnesses-for-long-running-agents
- anthropics/cwc-long-running-agents: https://github.com/anthropics/cwc-long-running-agents
- InfoQ on Anthropic's planner/generator/evaluator harness: https://infoq.com/news/2026/04/anthropic-three-agent-harness-ai/
