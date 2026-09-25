# marble-rally: Marble Rally

**Tier:** G8 (the last game; it has the most engine work).
- **Players:** the whole audience races up to 500 marbles (host cap 50–1000, server hard cap 1000). Seated players are **featured marbles**.
- **Session:** 5 races of 2–3 min each, 10–15 min in total.
- **Audience:** this game is the audience hook. Viewers enrol, nudge and bet.
- **Manifest:** `tickHz: 60`, `renderMode: "continuous"` (during races only; otherwise on-demand), `teamSupport: "optional"`, `audience: { direct: true, predict: true }`, `minPlayers: 0`, `maxPlayers: 8`, `estMinutes: [10, 15]`.
- **howToPlay:** `["Tap JOIN to drop your marble in", "Nudge it once per checkpoint", "First to the finish wins!"]`

## Why it's in
- Marbles on Stream holds 16M+ hours watched with around 900 chat players per race. It is the proven "everyone in chat plays at once" format.
- It needs no skill, is endlessly watchable, and races are short.
- It is the only launch game where every viewer has a piece on the board.

## Physics (engine work in M9-00)
- **Model:** the track is an upright wooden pegboard marble run leaning against the window. **The simulation is 2D** (x, y with gravity along −y) and the presentation is 3D.
- **World:** 4096 units wide and 8192 units tall. The start gate is at the top (y ≈ 8000) and the finish line near the bottom (y ≈ 200).
- **Fixed-point integer maths, fully deterministic:**
  - Positions are `int32` in 1/16 unit, so the world spans 0–65,536 × 0–131,072.
  - Velocities are `int32` in 1/16 unit per tick.
  - There are no floats in the solver core. Use integer square root and precomputed normal vectors for segments (stored as fixed-point, 1/4096).
  - The rate is 60 steps per second, with 2 substeps per step.
- **Bodies:**
  - Marbles are circles with a radius of 44 units.
  - The static track is made of segments (with thickness) plus circle pegs.
  - Zones: `boost` (a velocity add), `funnel` (wall segments), `gate` (a checkpoint line), `finish` (a line).
- **Response:** restitution 5/8 against walls and 3/4 between marbles. Tangential friction is `v_t -= v_t/16`, gravity is −3 per tick², and the speed cap is 96 per tick.
- **Broadphase:** a uniform grid with 128-unit cells. Pairs are resolved in a stable order (by ascending id). Positions are corrected by splitting the overlap equally.
- **Budget:** 500 marbles must step in 4 ms or less per step on the dev machine, including broadphase (a unit benchmark).
- **Server authority:** the server runs the solver in `onTick`. Clients never simulate; they interpolate snapshots.

## Rules
- **R1 Enrolment:** before race 1 an `audience.enroll` window opens for `joinSec` (30 s by default), capped at `cap`.
  - Audience members join with `{t:"enroll", skin}`, and each `audId` gets one marble per race.
  - **Entrants stay in.** Everyone who raced is automatically re-entered in the next race (same skin) unless they tapped "Sit out" or have been disconnected for more than 30 s. Before races 2+, the enrolment window only admits newcomers and queued viewers and lasts `max(10, joinSec / 2)` s (15 s by default). Re-joining every race was the #1 friction point in the draft and cost ~2 min of dead air over 5 races.
  - Seated players are auto-entered as featured marbles, marked with a larger name tag and their identity colour ring.
  - Twitch `!play` works through the M10 plugin.
  - People who join after the window closes are queued for the next race.
- **R2 Grid:** marbles are placed in the start tray in enrolment order, shuffled with `rng`, on a hexagonal packing of rows. Featured marbles are spread evenly across the grid.
- **R3 Race:**
  - `countdown` (pace 3000), then `race`, which lasts until every marble has finished or DNF'd, or `raceMaxSec` (120 s) is reached. Then `podium` (pace 8000).
  - The track id comes from `tracks`: the host's selection, rotated.
- **R4 Checkpoints:** each track has 3 `gate` lines. The progress metric is the checkpoint index, then the distance along the track's authored centre polyline (`progress: 0–10000`).
- **R5 Nudge:**
  - Each entrant may send `{nudge: -1|1}` via `audAct` once per checkpoint section, `nudges` times per race in total (default 3).
  - It applies an impulse of `(±24, +8)` per tick for 6 ticks, at the next tick after it is received (server time).
  - Excess or invalid nudges are ignored silently. The game enforces the per-section and per-race limits; the platform only applies its generic 5 msg/s audience socket limit (SPEC §9.5).
- **R6 Stuck rule:**
  - A marble whose progress rises by less than 16 in 4 s gets a deterministic kick (`rng.fork("kick:"+id)`, a random ±x impulse).
  - After 12 s with no progress, it is marked **DNF**.
- **R7 Elimination gates** (`eliminations` on): at gates 1 and 2, once 50% of the living marbles have crossed, a gate "closes" when the slowest 20% of the field reaches it. Those marbles are eliminated with a trapdoor drop (a DNF with a fun fx). There are never fewer than 8 living marbles.
- **R8 Chaos buttons (host):** `wind` (a horizontal force of ±2 per tick² for 3 s) and `shake` (a random ±16 impulse on every marble). Each can be used at most twice per race, and neither during the last 10 s of the race.
- **R9 Race points:** finish places 1–10 score 25, 18, 15, 12, 10, 8, 6, 4, 2, 1. Every finisher scores +1, and DNF scores 0.
  - Audience entrants get these points as **play-along points** through `audience.award`.
  - Featured players get them as in-game scores.
- **R10 Tournament:** `races` races (5 by default). The final ranking of featured players is by total points, then best single finish. The audience tournament top 10 is shown on the final screen.
  - With 0 seated players, `GameResult.ranking` is empty (the Night Champion score is unchanged) and the audience results still count.
- **R11 Bets:** if there are 2 or more featured marbles, a `predict` poll over them ("Who places highest?") opens during enrolment and closes at the countdown. It resolves with the best-placed featured marble.
- **R12 Teams** (room teams on): each entrant takes their team colour ring (audience members pick a team on enrolment, or get auto-balanced). A team scores the sum of the points of its best 5 finishers per race. The ranking is then by team.
- **R13 Skins:** `skin = colorSlot (0–7) × 6 + pattern (0–5)`. The patterns are solid, swirl, stripe, dots, cat-eye and galaxy. Skins are cosmetic only.

### Host options
| key | kind | default | range |
|---|---|---|---|
| races | int | 5 | 1–10 |
| tracks | enum | rotate | rotate, pencil-drop, cup-cascade, book-stack-switchback |
| cap | int | 500 | 50–1000 |
| joinSec | seconds | 30 | 15–60 |
| raceMaxSec | seconds | 120 | 60–180 |
| nudges | int | 3 | 0–3 |
| eliminations | bool | true | |
| chaos | bool | true | |

## Network
- **Binary frames**, using the `stream` effect (SPEC §9.6):
  - `0x01` snapshots on the stage topic at 10 Hz (a delta, with a keyframe every 2 s). Positions are sent as `i16`: the fixed-point value divided by 32, which gives 2 world units of precision.
  - `0x02` full ranking frames on the **stage topic only** at 2 Hz.
  - `0x03` "your rank" frames (7 bytes) to each enrolled socket at 1 Hz, via the `streamEach` effect.
- **Frame size:** 500 marbles × 6 bytes is about 3 KB per keyframe, and deltas are usually smaller. **Only Stage and overlay clients subscribe to `0x01` and `0x02`.** Audience phones get only `0x03` plus the JSON view (which carries the top 10). Egress at 5,000 viewers / 500 entrants: stage ≈ 30 KB/s, phones ≈ 3.5 KB/s of `0x03` plus JSON view patches on events, well inside the SPEC §10 budget.
- **JSON views** carry phase, race number, track id, entrant count, the top 10 standings with names, the featured list, chaos cooldowns and deadlines. These are not sent per tick: the view changes only on phase, checkpoint and finish events. The `onTick` step returns the same view object while positions change only in the stream, so no diffs are generated.
- **Audience view:** it is shared, so it carries no per-viewer fields. Each entrant's socket receives its marble id once (`{t:"fx", events:[{name:"enrolled", data:{mid}}]}`, re-sent on reconnect) and then its own `0x03` frames to show "You: 37th / 412".

## State machine
```
intro → [race r]{ enroll(joinSec) → countdown → race(tick) → podium } ×races → final(pace 10000) → end
```

## Types
```ts
interface MrState {
  phase: "intro"|"enroll"|"countdown"|"race"|"podium"|"final";
  race: number; trackId: TrackId; deadline: number|null; raceStartedAt: number|null; tick: number;
  entrants: { mid: number; owner: { kind: "aud"; audId: AudId } | { kind: "player"; id: PlayerId }; name: string; skin: number; teamId?: TeamId; featured: boolean }[];
  sim: { x: number[]; y: number[]; vx: number[]; vy: number[]; alive: number[] /*0|1*/; cp: number[]; progress: number[]; lastProgressTick: number[]; finishedAt: number[] /*tick or -1*/; nudgesLeft: number[]; impulse: number[] };   // flat arrays (JSON-safe)
  finishOrder: number[]; chaos: { wind: number; shake: number; windUntilTick: number; windDir: -1|1 };
  standings: { mid: number; name: string; featured: boolean; place: number }[];   // top 10 public
  totals: Record<string /*PlayerId|AudId|TeamId*/, number>;
  queue: { audId: AudId; name: string; skin: number }[];
}
type MrAction = { type: "chaos"; kind: "wind" | "shake"; dir?: -1|1 };      // host (actor role host)
type MrAudAction = { nudge: -1 | 1 } | { sitOut: boolean };   // sitOut applies from the next race (R1)
```
`serialize` must round-trip the flat sim arrays exactly. Snapshots taken during a race are allowed (the SQLite restore resumes the race).

### Audience job per phase (G14)
| Phase | Typical length | Audience job |
|---|---|---|
| enroll | 15–30 s | enrol + skin pick; featured-marble `predict` |
| countdown | 3 s | — |
| race | 60–100 s | `nudge` direct actions + watching own rank |
| podium | 8 s | reactions |

Player idle exception: none; featured players have the same nudge controls.

## Visual & animation spec
- **Set:**
  - A tall wooden pegboard leans against the window, so the ambient sky shows through the gaps.
  - Track pieces are procedural: **pencil ramps** (lathe hexagonal pencils), **paper-cup funnels** (lathe), **book-stack drops** (rounded boxes with canvas-drawn spines), **ruler rails**, and a **toy-train crossing** that is purely cosmetic and moves on a fixed loop.
  - Static track geometry is merged into 2–3 draws. The authored track JSON drives both the physics segments and the visual pieces.
- **Marbles:**
  - A glass look from a **matcap glass variant** (the factory's `makeMatcap("glass")`) with `instanceColor` tint mixing the `glass` token with the identity colour, plus a pattern swirl from a 6-cell pattern atlas indexed per instance through an instanced attribute.
  - Everything is drawn with **one InstancedMesh** (an icosphere of detail 1, 80 triangles).
  - The render cap is 150 marbles on low, 300 on mid and 500 on high. Marbles beyond the cap, chosen by lowest rank, render as a `Points` layer of coloured dots, which is one more draw.
  - Featured marbles get a halo ring (instanced) and a DOM name tag projected to screen space, with at most 8 tags.
- **Motion:** clients render 100 ms behind the latest snapshot and interpolate linearly between snapshots. Marble rotation is derived from its x velocity (visual only).
- **Camera:**
  - During enrolment and countdown, the Establishing framing shows the whole board.
  - During the race, the camera **follows the leading pack**: its y target is the median y of the top 10, with the `camera` spring and a dead zone of 8% of the screen height.
  - Near the finish there is a 0.5× slow-mo visual effect: the client plays back at half speed for 1.5 s and then catches up. The server is unchanged.
  - After the finish, the camera Focuses on the podium.
- **Nudge feedback:** a purple ripple ring on the nudged marble.
- **Chaos:** the wind button makes paper streamers flutter across the screen and the pegboard shake shakes. Each gets a HUD banner.
- **Eliminations:** gates are cardboard trapdoors that flip open, and eliminated marbles fall into a cup behind.
- **Finish:** a finish flag waves (vertex shader in the factory's flag material). Each of the top 3 gets a confetti burst in its colour, and a **podium** of wooden blocks shows the top 3 marbles with names.
- **HUD:** the live top-10 leaderboard on the left (it animates rank changes with the rolling number and slide), the entrant count, the race number, and the checkpoint split times of featured marbles.
- **Audience controller:** the enrol screen with a skin picker (8 colours × 6 patterns, rendered as small CSS radial-gradient circles, no three.js), a big JOIN button, and in the race huge ◀ NUDGE ▶ buttons with a remaining-nudges counter plus "You: 37th / 412" and your checkpoint. Between races: your result, your tournament total, and a "Sit out next race" toggle.
- **Player controller:** the same as the audience controller, marked as featured.

## Scenarios
| id | roles | description | what the critic should see | anim |
|---|---|---|---|---|
| enroll | stage, audience | 312 entrants in the tray, 12 s left | The board framed, the tray full of coloured marbles, the join counter, the QR/code | — |
| countdown | stage | 3-2-1 with featured tags | Countdown banner, tags | `countdown` 3000 ms |
| race-early | stage, audience | Tick 600 of a seeded race with 500 marbles | A readable pack, the leaderboard, a nudge ripple | — |
| race-chaos | stage | Wind active | Streamers, banner, the pack drifting | `wind` 1500 ms |
| elimination | stage | Gate 1 trapdoor dropping the slowest | Flipping trapdoor, falling marbles | `trapdoor` 1200 ms |
| finish | stage | The leader crossing, slow-mo | Flag, confetti, the leaderboard lock-in | `finish` 2000 ms |
| podium | stage | Race podium | Podium blocks, names, points | `win` 2000 ms |
| final | stage | Tournament final + audience top 10 | Featured podium + audience table | — |

Scenario builders run the real solver for N ticks from the seed, so the scenarios stay deterministic.

**Perf script:** a 10 s playback of recorded snapshots at 500 marbles (the harness replays a fixture stream), plus `finish`. Budgets: low tier must hold 150 instanced marbles plus dots within 60 draws and 50k triangles.

## Edge cases
- 0 entrants: the race is skipped with a "Nobody joined" card, and after 2 empty races in a row the game ends.
- Fewer than 8 entrants: eliminations are disabled for that race.
- Every marble is stuck: DNFs roll in until the race ends at `raceMaxSec`.
- A marble finishes on the same tick as another: the tie is broken by marble id order (deterministic) and they are shown as the same finish time.
- A viewer reconnects mid-race: the same `audId` keeps the same marble, and the server re-sends the `enrolled` fx after the reconnect.
- Twitch and web both enrol the same person: these are separate ids, since the platform cannot know they are the same person. That is accepted.
- The server restarts mid-race: the snapshot restore resumes the race at the last saved tick. Clients see a keyframe.

## Test cases
- **T1** Solver determinism: 3 runs with the same seed and input schedule produce byte-identical serialized sims after 3,600 ticks.
- **T2** No marble ever tunnels through a segment (a sweep test at the speed cap, 10k random shots).
- **T3** Energy sanity: in a closed box **with gravity set to 0**, total kinetic energy never rises except from boosts and nudges; with gravity on, total mechanical energy (kinetic + potential) never rises by more than the integer-rounding tolerance of 1 unit per marble per tick.
- **T4** The stuck kick and the DNF timing.
- **T5** The elimination gate never leaves fewer than 8 living marbles.
- **T6** Nudge limits: per section, per race, and invalid values rejected.
- **T7** Race points, the audience award mapping and the team best-5 scoring.
- **T8** Enrolment cap, late joins queued, one marble per `audId`; entrants carry over to the next race unless they sat out or were disconnected > 30 s; race 2+ enrolment lasts `max(10, joinSec/2)` s.
- **T13** `0x03` frames go only to enrolled sockets, at ≤ 1 Hz, and the audience topic never carries `0x01` or `0x02`.
- **T9** The bet resolves to the best featured marble.
- **T10** Binary frame encode and decode round-trip, with delta plus keyframe reconstruction on the client equal to the server positions quantized to 2 units.
- **T11** Performance: 500 marbles step in 4 ms or less.
- **T12** A 200-game simulation (with 0–8 players and 0–500 entrants) completes with no exceptions, and every race ends within `raceMaxSec`.
- **Invariants:** all positions stay inside the world bounds; the number of finished marbles is never more than the number of entrants; `finishOrder` has no duplicates. **Max steps:** 5 races × (120 s × 60 + events), about 40,000.

## Content
The tracks live in `packages/games/marble-rally/src/tracks/*.json`: `{ id, name, segments: [x1,y1,x2,y2,thick][], pegs: [x,y,r][], zones: {...}, centerline: [x,y][], visuals: {...} }`. Each is authored and tuned so that a typical race lasts 60–100 s, with at least 60% of marbles finishing and no guaranteed-stuck spots (checked by 200 simulated races per track).

## Builder notes
- **Solver (M9-00):** `src/logic/physics/` (`compileTrack`, `createSolver`, `createBodies`, `step`). Pure integers; state is `Bodies` (`x, y, vx, vy, alive, ix, iy`), JSON via `bodiesToJson`/`bodiesFromJson` (exact).
- **Track physics JSON (world units):** `segments [x1,y1,x2,y2,thick]`, `pegs [x,y,r]`, `arcs [cx,cy,r,ax,ay,bx,by,thick]` (CCW sweep from direction a to b; a = b is a full ring; end caps added), `zones.funnel` (segments), `zones.gates`/`zones.finish` `[x1,y1,x2,y2]`, `zones.boost [x1,y1,x2,y2,vx,vy]` (fixed units per tick, once per forward crossing).
- **Lines:** forward = crossing from the left side of a→b to its right (author lines left-to-right for downward travel). `step` returns events `kind, index, marble, dir, substep`.
- **Inputs:** nudges, shake and kicks go in `ix/iy` (consumed next step); wind is `step(..., { windX })`; `alive = 0` freezes a marble (finished/DNF).
- **Contact model:** position projection (equal pair split), velocity from correction (PBD), then a velocity pass: impacts faster than 6/tick use e = 3/4 (pairs), 5/8 + `v_t/16` friction (walls); slower resting contacts are inelastic and roll without friction (the spec's friction applies per impact, otherwise heaps would never flow).
- **Energy guard:** once per tick, per island of marbles that touched during it, the tick may not add mechanical energy beyond the T3 rounding allowance (1/marble/tick; strict at g = 0); boosts apply after it. Heaps flow on ramps of 10° or more; below ≈5° they creep, so author ramps at ≥ 10° and rely on R6 kicks for rare stalls.
- **Perf:** ≈0.8 ms/step for a 500-marble race, ≈0.35 ms for a 500-marble pile (T11 runs in a plain Node process; Vitest's import rewrite is ~3× slower).
- **Tracks (M9-00b):** `src/logic/tracks/` (`TRACKS`, `getCourse`, `trackProgress(course, x, y, prev)`, tray `slots`, `gateProgress`); the JSON sits under `logic/` (not `src/tracks/`) because `logic/**` may only import logic. Made by `test/author-tracks.ts` (`pnpm --filter @sg/game-marble-rally tracks:author`; a test fails if JSON and source drift). Every collider maps to one `visuals.pieces` entry (pencil, ruler, book, cup, deflector, frame, dowel).
- **Slope rule (measured):** single marbles only speed up on slopes ≥ ≈27° (integer velocities cannot hold g·sinθ < 1/tick under T3); below that they coast frictionless and a stopped one stays put until kicked. So: 32° kickers wherever marbles land, coasting runs ≤ 600 between 200-unit kicker teeth, a 45° lip at each level end, drop gaps ≥ 450 (narrower ones arch and jam).
- **R5/R6 for M9-01:** use `tracks/tuning.ts` (kick ±48–80 x; DNF after 12 s without the best progress rising by 16). `tracks:check` = 200 races/track (200–500 entrants, nudges on half, eliminations and chaos off) plus 200 rest probes → `artifacts/verify/M9-00b-tracks.json`; `tracks:preview` writes SVGs via `@sg/game-marble-rally/preview`.
