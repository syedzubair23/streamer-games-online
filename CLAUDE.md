# Streamer Games Online: agent rules

Cozy browser party games for streamers: a three.js **Stage** on stream, phones as controllers,
the audience part of every game. pnpm workspaces, TypeScript strict, Node 22, pnpm 12.
Authoritative docs: `docs/SPEC.md` (what), `docs/ROADMAP.md` (items), `docs/DOD.md` (done).

## Session start (always, in order, under 2 minutes)

1. Read this file.
2. `pnpm progress show <your item id>`: status, owner, legal next states, evidence paths.
   No item assigned? Stop and ask. `pnpm progress list building` shows who is on what.
3. Read your item in `docs/ROADMAP.md` (Goal / Files / Depends / Accept), then only what it cites:
   - game items: `docs/specs/<game>.md`, SPEC §9.3, §9.4, §13, §14, `docs/engine-api.md`,
     and the latest `artifacts/critic/<game>/round-*.json` if one exists;
   - platform items: the SPEC sections and `docs/research/*.md` sections the item names.
4. Check the current state before changing anything: `pnpm verify:game <game>` (games) or
   `pnpm typecheck && pnpm lint && pnpm test` (platform).
5. `pnpm progress set <id> status=building owner=<you>`.

Keep context small: at most CLAUDE.md, one spec, one progress row, the latest critic JSON.

## Where things live (SPEC §9.2)

| Path | Package | Owner |
|---|---|---|
| `packages/shared/` | `@sg/shared`: protocol, room, rng (sfc32), diff, codec, text, content schema | engine |
| `packages/engine/` | `@sg/engine`: GameModule/ClientModule API, GameRunner, `testing/` kit | engine |
| `packages/render/` | `@sg/render`: renderer, loop, quality tiers, materials, textures, room, fx | engine |
| `packages/ui/` | `@sg/ui`: tokens, Preact components, HUD layout, transitions, icons | engine |
| `packages/audio/` | `@sg/audio`: synth sfx, ambience, lofi, buses | engine |
| `packages/games/<id>/` | `@sg/game-<id>`: `src/logic/`, `src/bot.ts`, `src/content/`, `src/client/`, `src/scenarios.ts`, `test/` | that game's builder |
| `content/packs/<kind>/` | content packs (server-read only) | game builders, per kind |
| `apps/server/`, `apps/client/` | `@sg/server`, `@sg/client` | engine |
| `tools/harness/`, `tools/bots/` | `@sg/harness` (verify, screenshots, progress), `@sg/bots` | engine |
| `artifacts/` | evidence: `verify/`, `handoff/`, `screenshots/`, `critic/`, `perf/` | harness output |

Dependency rules (enforced by eslint-plugin-boundaries): games import only `@sg/shared` and
`@sg/engine`; a game's `src/client/**` may add `@sg/render`, `@sg/ui`, `@sg/audio`, `three`.
`logic/**` never imports three, the DOM, render, ui or audio. No game imports another game.
`apps/server` never imports a `client` entry.

## Scope rules

- One item per agent. Touch only the files your ROADMAP item lists under **Files**.
- Game builders: only `packages/games/<id>/**`, `content/packs/<your kinds>/**` and your spec's
  "Builder notes" section (20 lines or fewer).
- Engine code (`packages/{shared,engine,render,ui,audio}`, `apps/*`, `tools/*`) belongs to the
  engine owner. Need a change? Add an entry to `docs/engine-requests.md` and stub it locally
  behind an interface. Requests are triaged between waves.
- Shared root files (`package.json`, `pnpm-lock.yaml`, tsconfig references): minimal additive
  edits only, and re-read right before writing; other agents work in the same tree.
- Never delete, skip or weaken a test, lint rule, DoD gate, scenario or rubric threshold to get
  green. That is an automatic fail and the item goes to `blocked`.
- Never stub or fake anything an item's **Accept** requires.

## Code rules

- TypeScript strict with `noUncheckedIndexedAccess`. No `any`; no `eslint-disable` without
  `-- reason`.
- `logic/` is pure and deterministic: `ctx.rng` (`@sg/shared` rng), `ctx.now`, `ctx.timing`
  only. No `Math.random`, `Date`, timers, DOM or three in `logic/**`.
- Secrets live under `secret`/`hidden` keys. `view()` is the security boundary. The Stage renders
  only the `stage` view and never shows a secret; host-only info goes to the host panel.
- Materials and textures only from `ctx.materials` / `ctx.textures` (`@sg/render` factories);
  no `new *Material`, no `import * as THREE`, no `requestAnimationFrame` in games.
- Colours, radii, durations and easings only from `@sg/ui` tokens and the active ambient mode.
  No literals in `games/*/src/client/**`.
- Rendering: instance repeated pieces, zero per-frame allocations, dispose on unmount, respect
  the quality tier (`low|mid|high`), stay inside the SPEC §10 budgets.
- Controllers are DOM/SVG and never statically import three or `@sg/render`.
- Every visible state is reachable as a scenario:
  `/dev/scenario?game=&state=&mode=&seed=&role=` (SPEC §14).
- Motion: enter 220–320 ms ease-out, exit 160–200 ms; nothing snaps; honour reduced motion.
- Public API gets TSDoc; `docs/engine-api.md` is regenerated when the engine API changes.

## Checks

```sh
pnpm typecheck                 # P1 / G1
pnpm lint                      # P2 / G2 (boundaries, banned APIs)
pnpm test                      # P3; one package: pnpm vitest run --project <package name>
pnpm size                      # P5 budgets
pnpm verify:item <id>          # platform item evidence -> artifacts/verify/<id>.json
pnpm verify:game <game>        # G-gates -> artifacts/verify/<game>.json
```

## Progress and status (DOD §8)

`progress.json` is the source of truth; `PROGRESS.md` is generated. Never hand-edit either.

```sh
pnpm progress show <id>
pnpm progress set <id> status=<status> [owner=<name>] [notes="<= 3 lines"] [reason="..."]
pnpm progress render           # regenerate PROGRESS.md (render --check verifies it)
pnpm progress list [status]
pnpm progress check            # progress.json matches ROADMAP.md and PROGRESS.md is current
```

Lifecycle: `todo → building → verifying → critic → fixing → verifying → … → done`; items without
visuals go `verifying → done`; `blocked` (needs `reason=`) is reachable from any state.
The tool refuses illegal transitions and missing evidence:

- `→ verifying` needs the handoff (`artifacts/handoff/<id>.md`, 40 lines or fewer).
- `→ critic` needs a green verify JSON (G8b may be `skipped: "no-gpu"`).
- `→ done` needs the verify JSON green at a commit on the current history and, for visual items,
  the latest `artifacts/critic/<…>/round-*.json` with `pass: true` and no open blockers.
- More than 5 critic rounds without a pass: `blocked`.

Never mark an item `done` by any other route. Claims without artifacts don't count.

## Done means

Platform items (M0, M1, M10): P-gates in DOD §1. Game items (M2–M9): G-gates in DOD §2, then
the critic loop in DOD §7 (fresh critics, never the builder; do not grade your own visuals).
Plus every bullet under the item's **Accept**, each backed by a test or an artifact.

## Session end

- Write `artifacts/handoff/<id>.md` (40 lines or fewer: what changed, how to verify, known gaps,
  disputed issues as `disputed: <reason>`).
- Update your row: `pnpm progress set <id> status=… notes="…"` (notes 3 lines or fewer).
- Commits look like `<item-id>: <what>`. Link paths in notes; never paste large files.
