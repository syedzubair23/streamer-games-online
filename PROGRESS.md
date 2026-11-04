# Progress

> Generated from `progress.json` by `pnpm progress render`. Do not edit by hand:
> change status with `pnpm progress set <id> status=<status>` (see CLAUDE.md).

**74 items:** todo 53 · done 19 · blocked 2

## M0 (6/6 done)

| ID | Item | Status | Critic | Owner | Updated | Notes |
|---|---|---|---|---|---|---|
| M0-01 | Monorepo scaffold | **done** | - | step0-sync | 2026-09-24 20:18Z | re-verified at 9922016 during M0 progress sync; artifacts/verify/M0-01.json |
| M0-02 | @sg/shared foundations | **done** | - | step0-sync | 2026-09-24 20:18Z | re-verified at 9922016 during M0 progress sync; artifacts/verify/M0-02.json |
| M0-03 | Agent house rules + progress tooling | **done** | - | step0-sync | 2026-09-24 20:18Z | re-verified at 9922016 during M0 progress sync; artifacts/verify/M0-03.json |
| M0-04 | @sg/engine: module API, GameRunner, testing kit | **done** | - | merger | 2026-09-24 21:11Z | verified on main at 2a8f8f9; 0 critic rounds (non-visual) |
| M0-05 | Scenario route + Playwright harness | **done** | - | merger | 2026-09-24 23:10Z | merged item/M0-05; verify:item green on main |
| M0-06 | Critic kit + reference board | **done** | - | step0-sync | 2026-09-24 20:18Z | re-verified at 9922016 during M0 progress sync; artifacts/verify/M0-06.json |

## M1 (6/10 done)

| ID | Item | Status | Critic | Owner | Updated | Notes |
|---|---|---|---|---|---|---|
| M1-01 | Server transport, sessions, codes, roles, reconnection | **done** | - | builder | 2026-09-24 23:50Z | verified green at merge commit; non-visual, no critic stage |
| M1-02 | Room actor + GameRunner integration | **done** | - | merger | 2026-09-25 08:42Z |  |
| M1-03 | AudienceAggregator | **done** | - | merger | 2026-09-25 09:30Z |  |
| M1-04 | Moderation & safety | **done** | - | merger | 2026-09-25 09:58Z |  |
| M1-05 | @sg/ui design system | **blocked** | 0/5 | - | 2026-09-25 20:01Z | blocked: failed 5 rounds (verify 9, critic 8.53): M105-R5-01 (item 1, a hard-gate item): R4-05 asked for stronger weather cues, and the fix went too far. Rain is now an even pinstripe of diagonal lines at a fixed pitch, and snow is a regular grid of equal dots and hollow rings. Both are static: frames taken at 0, 400 and 800 ms are byte-identical. They read as printed wallpaper, so style consistency in rai |
| M1-06 | @sg/render kit | **done** | - | merger | 2026-09-25 08:52Z |  |
| M1-07 | Cozy Table diorama, ambient modes, camera, FX | **blocked** | 0/5 | - | 2026-09-25 16:20Z | blocked: failed 5 rounds (verify 6, critic 6.7): DoD P6 (visual critic, DOD §4.3/§7) has not passed. artifacts/critic/M1-07/round-5.json, committed at HEAD 4fe9383, has pass=false with minScore 6.7 and 4 open blockers. M17-R5-01: item 1 style consistency, the walls and floor read as flat fills against the clay props. M17-R5-02: item 6, in the establishing shot the mat is about 8% of the frame and the windo |
| M1-08 | @sg/audio | **done** | - | merger | 2026-09-25 10:18Z | merged to main at 8dc7c6f; verify:item green |
| M1-09 | Client shell | todo | 0/5 | - | - |  |
| M1-10 | Bot swarm & load gate | todo | - | - | - |  |

## M2 `quip-clash` (1/6 done)

| ID | Item | Status | Critic | Owner | Updated | Notes |
|---|---|---|---|---|---|---|
| M2-01 | quip-clash: Logic | **done** | - | merger | 2026-09-25 19:59Z |  |
| M2-02 | quip-clash: Content | todo | - | - | - |  |
| M2-03 | quip-clash: Stage | todo | 0/5 | - | - |  |
| M2-04 | quip-clash: Controller | todo | 0/5 | - | - |  |
| M2-05 | quip-clash: Verify & critic | todo | 0/5 | - | - |  |
| M2-06 | quip-clash: Golden promotion | todo | 0/5 | - | - |  |

## M3 `tune-in` (1/5 done)

| ID | Item | Status | Critic | Owner | Updated | Notes |
|---|---|---|---|---|---|---|
| M3-01 | tune-in: Logic | **done** | - | merger | 2026-10-06 22:30Z | Merged to main; verify:item green at 66e89c6. Handoff: artifacts/handoff/M3-01.md |
| M3-02 | tune-in: Content | todo | - | - | - |  |
| M3-03 | tune-in: Stage | todo | 0/5 | - | - |  |
| M3-04 | tune-in: Controller | todo | 0/5 | - | - |  |
| M3-05 | tune-in: Verify & critic | todo | 0/5 | - | - |  |

## M4 `trivia-night` (1/6 done)

| ID | Item | Status | Critic | Owner | Updated | Notes |
|---|---|---|---|---|---|---|
| M4-01 | trivia-night: Logic | **done** | - | merger | 2026-10-06 22:30Z | Merged to main; verify:item green at 66e89c6. Handoff: artifacts/handoff/M4-01.md |
| M4-01b | trivia-night: Bluff mode logic | todo | - | - | - |  |
| M4-02 | trivia-night: Content | todo | - | - | - |  |
| M4-03 | trivia-night: Stage | todo | 0/5 | - | - |  |
| M4-04 | trivia-night: Controller | todo | 0/5 | - | - |  |
| M4-05 | trivia-night: Verify & critic | todo | 0/5 | - | - |  |

## M5 `doodle` (1/7 done)

| ID | Item | Status | Critic | Owner | Updated | Notes |
|---|---|---|---|---|---|---|
| M5-01 | doodle: Logic | **done** | - | claude | 2026-11-04 06:33Z | Green at 1998956 with plain settings after ER-013; T9 secrecy test has an explicit 60 s timeout. ER-010 and ER-011 open. |
| M5-01b | doodle: Telephone mode logic | todo | - | - | - |  |
| M5-02 | doodle: Content | todo | - | - | - |  |
| M5-03 | doodle: Stage | todo | 0/5 | - | - |  |
| M5-04 | doodle: Controller | todo | 0/5 | - | - |  |
| M5-05 | doodle: Verify & critic | todo | 0/5 | - | - |  |
| M5-06 | doodle: Stroke pipeline | todo | - | - | - |  |

## M6 `odd-one-out` (1/5 done)

| ID | Item | Status | Critic | Owner | Updated | Notes |
|---|---|---|---|---|---|---|
| M6-01 | odd-one-out: Logic | **done** | - | claude | 2026-11-03 21:58Z | Green at fe07629 with SG_FFMPEG and VITEST_MAX_WORKERS=4; plain verify fails until ER-013 lands. Disputed for M6-05: audience poll gap, 4-player length. |
| M6-02 | odd-one-out: Content | todo | - | - | - |  |
| M6-03 | odd-one-out: Stage | todo | 0/5 | - | - |  |
| M6-04 | odd-one-out: Controller | todo | 0/5 | - | - |  |
| M6-05 | odd-one-out: Verify & critic | todo | 0/5 | - | - |  |

## M7 `ludo` (0/5 done)

| ID | Item | Status | Critic | Owner | Updated | Notes |
|---|---|---|---|---|---|---|
| M7-01 | ludo: Logic | todo | - | - | - |  |
| M7-02 | ludo: Content | todo | - | - | - |  |
| M7-03 | ludo: Stage | todo | 0/5 | - | - |  |
| M7-04 | ludo: Controller | todo | 0/5 | - | - |  |
| M7-05 | ludo: Verify & critic | todo | 0/5 | - | - |  |

## M8 `chess` (0/6 done)

| ID | Item | Status | Critic | Owner | Updated | Notes |
|---|---|---|---|---|---|---|
| M8-01 | chess: Logic | todo | - | - | - |  |
| M8-01b | chess: Team vs Team plus the guess-the-move play-along | todo | - | - | - |  |
| M8-02 | chess: Content | todo | - | - | - |  |
| M8-03 | chess: Stage | todo | 0/5 | - | - |  |
| M8-04 | chess: Controller | todo | 0/5 | - | - |  |
| M8-05 | chess: Verify & critic | todo | 0/5 | - | - |  |

## M9 `marble-rally` (2/7 done)

| ID | Item | Status | Critic | Owner | Updated | Notes |
|---|---|---|---|---|---|---|
| M9-00 | marble-rally: Physics solver | **done** | - | merger | 2026-09-25 10:52Z |  |
| M9-00b | marble-rally: Tracks | **done** | - | merger | 2026-09-25 13:36Z | verified 1 round, 0 critic rounds |
| M9-01 | marble-rally: Logic | todo | - | - | - |  |
| M9-02 | marble-rally: Content | todo | - | - | - |  |
| M9-03 | marble-rally: Stage | todo | 0/5 | - | - |  |
| M9-04 | marble-rally: Controller | todo | 0/5 | - | - |  |
| M9-05 | marble-rally: Verify & critic | todo | 0/5 | - | - |  |

## M10 (0/11 done)

| ID | Item | Status | Critic | Owner | Updated | Notes |
|---|---|---|---|---|---|---|
| M10-01 | Overlay layouts | todo | 0/5 | - | - |  |
| M10-02 | Twitch chat plugin | todo | - | - | - |  |
| M10-03 | SqliteStore + crash restore | todo | - | - | - |  |
| M10-04 | Public room browser | todo | - | - | - |  |
| M10-05 | Service worker + prefetch polish | todo | - | - | - |  |
| M10-06 | DOM/SVG Stage fallback | todo | - | - | - |  |
| M10-07 | Perf lab pass | todo | - | - | - |  |
| M10-08 | Accessibility sweep | todo | 0/5 | - | - |  |
| M10-09 | Drift guard re-critic | todo | 0/5 | - | - |  |
| M10-10 | Launch soak | todo | - | - | - |  |
| M10-11 | Docs | todo | - | - | - |  |
