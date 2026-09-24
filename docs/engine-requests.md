# Engine requests

Game builders do not edit engine code (`packages/{shared,engine,render,ui,audio}`, `apps/*`,
`tools/*`). When you need a change there, add a request below and stub it locally behind an
interface in your own package. The engine owner triages this file between waves (ROADMAP
"Ownership rules"). Any accepted engine change re-runs every done game's screenshots.

Rules:
- One request per `###` block. Newest at the bottom. Never delete a request; change its status.
- Keep each request 15 lines or fewer. Link paths instead of pasting code.
- Status is one of `open`, `accepted`, `rejected`, `done`. Only the engine owner changes it.

## Template

```markdown
### ER-<nnn> <short title>
- **From:** <item id> (<agent/owner>)
- **Package:** @sg/<package> (`<path>`)
- **Status:** open
- **Need:** what the game needs, in one or two sentences.
- **Why:** the spec rule or gate that requires it (e.g. `docs/specs/ludo.md` R7, DOD G8a).
- **Proposed API:** the smallest signature that would work.
- **Local stub:** where your interface/stub lives until this lands.
- **Resolution:** (engine owner) what was done, in which commit.
```

## Requests

### ER-001 tictactoe fixture controller: invalid ARIA grid
- **From:** M0-05 (harness builder)
- **Package:** @sg/engine (`packages/engine/test/fixtures/tictactoe/client.ts`)
- **Status:** open
- **Need:** the controller's board uses `role="grid"` on a plain div of buttons, with no `row`/`gridcell` children.
- **Why:** axe reports it as a critical `aria-required-children` finding, so `pnpm verify:game tictactoe` has G9 red (DOD G9: 0 serious or critical findings). The harness is right; the fixture is wrong.
- **Proposed API:** none; use `role="group"` with `aria-label="Board"` (or add rows and gridcells).
- **Local stub:** none needed; the gate reports it.
- **Resolution:**
