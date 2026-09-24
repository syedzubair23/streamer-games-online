# ludo: Ludo (Garden Ludo; "Quick Ludo" by default)

**Tier:** G6.
- **Players:** 2–4, with 2v2 teams (partners sit opposite).
- **Session:** 8–12 min in Quick mode, 20–30 min in Classic mode.
- **Audience:** 2 Blessing Die votes per game, a "who finishes first" prediction, and the capture hype meter.
- **Manifest:** `tickHz: 0`, `renderMode: "on-demand"`, `teamSupport: "optional"`, `audience: { vote: true, predict: true, tap: true }`, `estMinutes: [8, 12]` (Quick; Classic declares 20–30 via its preset and is excluded from G14's duration check but not from its idle checks).
- **Honest assessment:** Ludo is the weakest audience game in the set (the audience mostly watches dice). It earns its place through universal familiarity and the product owner's request, and it stays out of the Quick Stream Set. Keep every turn fast: the default timers below plus hop animations must keep a 4-player Quick game ≤ 12 min at G14.
- **howToPlay:** `["Roll the die, move a token", "Land on a rival to send them home", "Get your tokens home first!"]`

## Why it's in
- The product owner asked for it. Ludo King has about 70M monthly players, so the rules are universally known, including by non-gamers.
- Big luck swings and captures make good TV. Quick Ludo keeps a game under 12 minutes.
- The audience can change the story (a Blessing re-roll) without breaking fairness.

## Board model
- **Track:** the standard cross-shaped track, 52 main squares with absolute indices 0–51 running clockwise.
- **Seats and starting squares:** each seat has a colour and a start square: seat 0 Tomato at 0, seat 1 Sky at 13, seat 2 Sunflower at 26, seat 3 Mint at 39. Two-player games use seats 0 and 2.
- **Token progress `p`:**
  - −1 means the token is in its base.
  - 0–50 is the main track, relative to the seat's start, so the absolute square is `(start + p) % 52`.
  - 51–55 is the seat's private home column.
  - **56 means home.**
- **Safe squares:** absolute squares {0, 13, 26, 39} (the starts) and {8, 21, 34, 47} (the stars).

## Rules
- **R1** Each seat has `tokens` tokens (2 in Quick mode, 4 in Classic mode), and all of them start in the base.
- **R2 Turn:**
  1. `roll`: the player sends `roll` within `timing.input(rollSec*1000)` (10 s), otherwise the bot rolls. The die is `rng.int(6)+1`, rolled on the server.
  2. `move`: if there is any legal move, the player picks a token within `timing.input(moveSec*1000)` (15 s), otherwise the bot picks. If there is no legal move, the turn passes after pace 1200 with a "shrug" fx.
- **R3 Legal moves** for die value d:
  - A token in the base can move to p=0 if d is one of the exit numbers (`exit`: `"6"` gives {6}, `"56"` gives {5, 6}).
  - A token on the track can move to p+d if p+d ≤ 56. If `exactFinish` is off, p+d is capped at 56 instead.
  - When `blockades` is on, a move may not pass or land on a square holding 2 or more tokens of one opposing seat. Home columns are never blocked.
  - When `mustCapture` is on and any legal move captures, only capturing moves are legal.
- **R4 Capture:** landing on a main-track square that is not a safe square and holds opposing tokens (from a seat that is not your team partner) sends all of those tokens back to the base.
  - With `captureMode` set to `back3`, captured tokens instead move back 3 squares. They never go below p=0, and a token moved back this way never triggers another capture.
  - Tokens of any colours may share a safe square.
- **R5 Extra roll:** a 6 grants one, as do a capture (if `captureBonus` is on) and reaching home (if `homeBonus` is on). More than one reason still gives only one extra roll.
- **R6 Triple six:** when `tripleSix` is on, rolling a 6 for the third time in a row voids that roll (no move) and ends the turn. The moves from the earlier two sixes stand.
- **R7 Teams:** partners are seats 0 and 2, and seats 1 and 3. Once all of a player's own tokens are home, that player moves their partner's tokens with their own rolls. A team finishes when both partners' tokens are all home.
- **R8 End:**
  - When `playToPlaces` is off, the game ends when the first seat (or team) is finished. That seat is 1st, and the others are ranked by total progress (the sum of `p`, counting −1 as 0), with ties sharing the place.
  - When `playToPlaces` is on, the game continues until only one seat is left.
- **R9 Blessing Die** (`blessings`, default 2, range 0–3):
  - A `vote` poll ("Bless a player 🟣") over the seats opens for `timing.input(15_000)`. The first one opens after the first capture of the game or at global turn 8, whichever comes first. Later ones open 10 turns after the previous blessing resolves.
  - If the audience total is at least `audienceMin`, the plurality seat gets a **blessing** (ties go to the seat with the lowest progress). Otherwise nobody does.
  - During a later turn, after any roll, a blessed player may send `reroll` once. This replaces the die value and consumes the blessing. An unused blessing lasts until the end of the game.
- **R10 Prediction:** a `predict` poll ("Who finishes first?") over the seats opens at the start of the game and closes at the start of global turn 6. It resolves with the 1st-place seat when the game ends.
- **R11 Hype meter:**
  - Rolling `tap` polls, each lasting 20 s, run for the whole game.
  - On each close, `meter += taps`. When `meter ≥ 60 × max(1, audienceCount/25)`, the meter is **armed**.
  - The next capture fires the fx `petal-storm` (cosmetic) and resets the meter. Live tallies animate the meter.
- **R12 Disconnect:** the bot rolls and moves right away (no waiting for the timers) while the player is disconnected. The player takes the seat back when they rejoin.
- **R13 Bot policy** (also used for timeouts), in order of priority:
  1. capture
  2. enter home
  3. leave the base
  4. move a token out of danger (an opponent 1–6 squares behind it)
  5. advance the most advanced token that stays safe
  6. otherwise, the token with the highest progress

  Random tie-break using `rng`.

### Host options
| key | kind | default | range |
|---|---|---|---|
| preset | enum | quick | quick (tokens 2, exit 56), classic (tokens 4, exit 6) |
| tokens | int | 2 | 1–4 (overrides the preset) |
| exit | enum | "56" | "6", "56" |
| tripleSix | bool | true | |
| blockades | bool | false | |
| captureMode | enum | home | home, back3 |
| captureBonus | bool | true | |
| homeBonus | bool | true | |
| mustCapture | bool | false | |
| exactFinish | bool | true | |
| rollSec | seconds | 10 | 5–30 |
| moveSec | seconds | 15 | 5–45 |
| blessings | int | 2 | 0–3 |
| playToPlaces | bool | false | |

## State machine
```
intro → [turn seat s]{ roll → (move | pass) → (extra? → roll …) } → … → finished(pace 1500) → final(pace 8000) → end
```

## Types
```ts
interface LudoState {
  phase: "intro"|"roll"|"move"|"pass"|"finished"|"final";
  seats: { seat: 0|1|2|3; player: PlayerId; colorSlot: number; teamId?: TeamId }[];
  tokens: Record<PlayerId, number[]>;          // progress per token (−1..56)
  current: PlayerId; die: number|null; sixes: number; deadline: number|null; turnCount: number;
  legal: number[];                             // token indices movable (public — it's on stream anyway)
  lastMove?: { player: PlayerId; token: number; from: number; to: number; path: number[] /*absolute squares or home idx*/; captured: { player: PlayerId; token: number; from: number }[]; home: boolean };
  blessings: Record<PlayerId, number>; blessingsLeft: number; nextBlessingTurn: number | null;
  meter: number; armed: boolean; finishedOrder: PlayerId[];
}
type LudoAction = { type: "roll" } | { type: "move"; token: number } | { type: "reroll" };
```
Ludo has no hidden information. The only secret is the `rng` state, which lives in the runner and never in the view.

## Views
Every role sees the full state. A player's view adds `you: { seat, canRoll, canMove: number[], canReroll }`.

### Audience job per phase (G14)
| Phase | Typical length | Audience job |
|---|---|---|
| whole game | — | rolling hype `tap` meter (R11), always open |
| turns 0–5 | — | "who finishes first" `predict` |
| blessing windows (×2) | ≤ 18 s | Blessing `vote` |

Player idle exception: in a 4-player game a player waits for 3 opponents' turns (~3 × 8–15 s). Accepted up to 60 s in G14, because turns are short, every capture can involve them, and the board is on their phone.

## Visual & animation spec
- **Board:** a painted-wood board with a thick bevel, with a garden-plot theme:
  - pastel quadrant bases drawn as little planter boxes
  - stars on the safe squares
  - home columns as flower-bed paths
  - a small pond-and-flower centre for home

  It is drawn with Canvas 2D over the wood texture at 92% opacity (research 03 §6), as **one mesh**.
- **Tokens:** lathe "felt gnome" pawns (24 segments, at most 600 triangles on low), toon material, in identity colours with the glyph printed on the cap's top. They use **one InstancedMesh** with `instanceColor`, plus instanced blob shadows. A token stack on one square shows as offset mini-stacks (±0.15 tile).
- **Die:** the chunky wooden die from `@sg/render/pieces/dice`. The pre-authored roll lands on the server's value, is thrown from the current seat's side and lasts 1.1–1.4 s, with a `tok` sound per bounce. The result chip pops in the HUD.
- **Move:**
  - Each tile hop follows the arc `y = 4h·t(1−t)`, with h = 0.35 tile. A hop takes 180 ms, speeding up to 120 ms after 4 hops.
  - The token squashes on landing (1.12, 0.85) and springs back (`snappy`), and the `tok` sound rises one pentatonic step per hop.
  - A token leaving the base does a pop-up from its planter.
  - A token reaching home jumps into the pond, which plays a splash of 6 instanced droplets, and plays the `success` sound.
- **Capture:** the victim hops, spins and shrinks into a **dandelion puff** in its own colour, then re-grows in its base planter (`bouncy`). The capture plays a camera micro-shake (high tier only) and the `capture` sound. If the hype meter is armed, a **petal storm** in audience purple follows: 80 petals from the confetti pool.
- **Turn:** the current seat's base gets a glow ring pulse, the camera nudges 5% toward that seat, and the "Your turn" banner shows on that player's phone with a `chime`.
- **Legal token highlight:** a soft pulsing ring decal under each movable token, with the target square shown as a ghost dot preview while the player hovers or taps to select.
- **Blessing:** a purple sparkle halo orbits the blessed seat's plate, and "Re-roll 🟣" appears on their phone after a roll.
- **Controller:**
  - The shared `board2d` **SVG** cross-track board (no three.js), styled with the same tokens and painted-garden palette as the Stage board, rotated so that the player's own base is at the bottom (the phone only; the stage never rotates). Tokens hop along SVG paths with the same timings as the Stage. An opt-in "3D board" toggle swaps in the `requestBoard()` low-tier board.
  - A giant Roll button.
  - Tap-to-select with snap-to-nearest legal token (a 44 px halo), and one tap on the destination preview confirms.
  - Arrow keys and Enter on desktop.

## Scenarios
| id | roles | description | what the critic should see | anim |
|---|---|---|---|---|
| opening | stage, player | 4 players, turn 1, die mid-roll | Board framed, die tumbling, turn ring; phone: SVG board with own base at the bottom and a giant Roll button | `dice` 1300 ms |
| midgame | stage, player, audience | 20 seeded bot turns in, 4 players | Readable positions, legal highlights, scores/progress plates | — |
| move-hops | stage | A 5-square hop sequence | Arcs, squash, blob shadows | `hops` 1100 ms |
| capture | stage | Capture with the armed petal storm | Dandelion puff, purple petals, result chip | `capture` 1200 ms |
| blessing-vote | stage, audience | Blessing poll 48/30/22 | Purple vote bars on the stage HUD, seats | — |
| teams | stage | 2v2 mid-game, one partner finished | Team pairing clear (plates grouped, colours) | — |
| endgame | stage | Two players one move from home | Tension: glow on home-column tokens | — |
| victory | stage | Winner | Pond splash, confetti, podium plates | `win` 2000 ms |

**Perf script:** `dice`, then `hops`, then `capture` (with petals), then `win`.

## Edge cases
- 3 players: seats 0, 1 and 2.
- Every legal move is blocked by blockades: the turn passes with a shrug.
- A 6 is rolled but nothing can move: that still grants the extra roll, unless it is the third six.
- A die of 6 with p=50 and exact finish on: moving to 56 is legal. With p=52 and d=6 the move is illegal, and p=52 with d=4 lands exactly on 56.
- Re-roll after a triple six: the re-roll may not be used to escape R6. The void is applied first and ends the turn.
- A partner's token captures the other partner's token: this is impossible, since partners never capture each other.
- The turn player disconnects in the middle of the roll animation: the server keeps going and the bot moves after pace.

## Test cases
- **T1** Legal moves for each exit setting.
- **T2** Exact finish, including an overshoot being illegal.
- **T3** A capture on a safe square is not allowed; tokens share the square instead.
- **T4** `back3` capture mode, with the p=0 floor.
- **T5** Blockade blocks passing but not home columns.
- **T6** Must-capture filtering.
- **T7** Extra-roll rules combine, but grant one roll at most.
- **T8** Triple six voids the third roll.
- **T9** Teams: a finished player moves the partner's tokens, and the team win needs both partners.
- **T10** End ranking by progress, with ties shared.
- **T11** The blessing's timing, allocation, and the single-use re-roll.
- **T12** The prediction closes at turn 6 and resolves with 1st place.
- **T13** The hype meter threshold scales with the audience count.
- **T14** Bot policy priority order.
- **T15** Fairness in the simulation: over 1,000 games of 4 bots, no seat wins more than 30%.
- **T16** With `blessings: 2`, exactly 2 blessing polls open per game (when the game lasts long enough), the second 10 turns after the first resolves.
- **Invariants:** every token's progress is in −1..56; there are never tokens of two different non-partner colours on a non-safe main square; `legal` equals the recomputed legal moves. **Max steps:** 3,000 (Quick), 8,000 (Classic).

## Builder notes
