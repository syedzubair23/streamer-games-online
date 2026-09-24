# chess: Chess (Tea-House Chess, with Chat vs Streamer)

**Tier:** G7.
- **Modes:** `streamer-vs-chat` (1 player against the audience; **the headline stream mode**), `duel` (2 players), and `team-vs-team` (players split into 2 teams that vote on moves). The default `mode: auto` picks streamer-vs-chat with 1 participant, duel with 2, and team-vs-team with 3 or more.
- **Session:** about 10 min for a 5+3 duel; vote modes are **hard-capped** by `maxMinutes` (default 20) and adjudicated at the cap (R8a), so a chess game can never eat an hour of stream.
- **Audience:** in the vote modes the audience *is* one side, and it guesses the streamer's moves while the streamer thinks. In a duel it plays "guess the move".
- **Manifest:** `tickHz: 0`, `renderMode: "on-demand"`, `teamSupport: "optional"`, `audience: { vote: true, quiz: true }`, `minPlayers: 1`, `maxPlayers: 16`, `estMinutes: [8, 20]`.
- In `duel`, the platform's participant selection (SPEC §3.4) seats exactly 2 players and benches the rest into the audience, where they play guess-the-move.
- **howToPlay:** `["Tap a piece, tap where it goes", "Checkmate the king to win", "Chat votes its moves together"]`

## Why it's in
- The product owner asked for it. Chess is a proven Twitch category.
- "Chat votes the move" is a proven audience format (Chess vs Chat, CHECKMATES, TwitchLichessBot).
- Chess is universally known and cheap to render.

## Rules
- **R1 Rules engine:** full FIDE rules via `chess.js` 1.4 (castling, en passant, promotion, check, checkmate, stalemate, threefold repetition, the 50-move rule, insufficient material). The state stores the **FEN, the move list in SAN, and the start FEN**.
  - The only thing `chess.js` is used for is legality and terminal detection, on both server and client.
  - The state is rebuilt with `new Chess(fen)`, so no chess.js instance is ever stored in state.
- **R2 Setup:**
  - Sides are assigned randomly with `rng`, or white goes to the host-picked player (option `white`).
  - Handicap (`streamer-vs-chat` only): the streamer's side starts without `none | knight | rook | queen`. This is done by editing the start FEN, and castling rights are adjusted to match.
- **R3 Duel clocks:** `time` is one of `3+2`, `5+3` (the default), `10+0`, or `none`.
  - Each side's `remainingMs` is stored. On each move, the mover's clock loses `now − turnStartedAt` and gains the increment. The timer is set to `turnStartedAt + remaining`.
  - A flag loss loses the game, unless the opponent has insufficient material, in which case it is a draw.
  - Clock time is **not** scaled by `timerScale` (a clock is part of the game). `streamDelaySec` does not apply to duel clocks.
- **R4 Promotion:** the action includes `promotion: q|r|b|n`. If `autoQueen` is on, the promotion is always a queen and the controller skips the picker.
- **R5 Resign and draws:**
  - Resign is allowed any time in a duel. In the vote modes, the host can resign on behalf of the streamer's side.
  - Draw offers in a duel: an offer lasts until the next move. Accepting ends the game in a draw.
  - There are no takebacks in v1.
- **R6 Vote move (the audience side in `streamer-vs-chat`, both sides in `team-vs-team`):**
  - When the voting side is to move, a `vote` poll opens. Its options are **all legal moves** (option id = UCI, label = SAN) and its deadline is `timing.input(voteSec*1000)` (20 s by default, plus the stream delay). If every eligible team player has voted and the audience poll (if any) has reached `audienceMin`, the vote may close early, subject to the minimum audience window.
  - In `team-vs-team`, a team's players vote on their phones using a `teamVote` action. The audience poll then opens only if `audienceTeam` is set, meaning chat joins one team as a weighted bloc: `share = 0.5·players + 0.5·audience`.
  - When the poll closes, the plurality move is played. Ties are broken by the `rng`, among the tied moves only.
  - If there were zero votes (or the audience was below `audienceMin` in streamer-vs-chat), `noVotes` decides: `random` plays a random legal move, and `pause` waits for the host to press `forceAdvance`, which then plays a random legal move.
  - The streamer's side has a soft **per-move limit** of `streamerClock` (90 s by default; 0 turns it off). At timeout, the bot move is played. The limit is shown as a gentle candle, not a chess clock, and is not scaled by `timerScale`.
- **R7 Guess the move (when `guessTheMove` is on):** in a duel on every turn, and in `streamer-vs-chat` on the **streamer's** turns (so chat is never idle while the streamer thinks).
  - When the turn starts, a `quiz` poll opens with `closeOn: "event"`, all legal moves as options and no speed bonus. It closes the moment the move is made, or at the flag. Stream delay does not apply (SPEC §4): audience phones see the position in real time, and guesses received after the move are discarded.
  - It resolves with the move played. The audience enters moves on the 2D mini board, the same UI as the vote.
  - Guess-the-move only opens a poll if at least 3 s remain on the mover's clock *and* the mover has not already moved (premoves in 3+2 would otherwise produce polls that close instantly; that is accepted and harmless).
- **R8 End:**
  - Checkmate, resign, flag or a draw (stalemate, repetition, 50-move rule, insufficient material, agreement) ends the game.
  - `GameResult`: win 1st / loss 2nd, or both 1st for a draw. In `team-vs-team` the ranking lists the team ids, and Night Champion credits every member of the team.
  - In `streamer-vs-chat` the ranking contains the streamer at place 1 on a win or draw, and is **empty** on a loss (SPEC §5: Night Champion unchanged). Chat's win is celebrated on the Stage ("CHAT WINS 🟣") and every audience member who voted for at least 50% of chat's moves gets +200 play-along points via `audience.award`.
- **R8a Time cap (vote modes):** when `maxMinutes` elapse (measured from the first move, paused time excluded), the game ends as `adjudicated`: the side with more material (P=1, N=B=3, R=5, Q=9) wins if the difference is ≥ 3, otherwise it is a draw. The Stage shows a 2-minute warning chip ("Final 2 minutes!").
- **R9** If a duel player disconnects, their clock keeps running. After `reconnectGraceSec`, the bot moves (a 1-ply capture-preferring random bot). In `team-vs-team`, disconnected voters don't vote.
- **R10 Sim adjudication:** in the tests only, a duel with more than 300 plies is adjudicated as a draw (vote modes are ended by R8a).
- **Duel clocks and `time: none`:** a duel with `time: none` has no pacing bound, so G14 is run with the default `5+3`; the host options form warns "No clock: this can run long on stream".

### Host options
| key | kind | default | range |
|---|---|---|---|
| mode | enum | auto | auto, duel, streamer-vs-chat, team-vs-team |
| maxMinutes | int | 20 | 10–45 (vote modes only) |
| time | enum | 5+3 | 3+2, 5+3, 10+0, none |
| white | enum | random | random, host-pick (seat 0) |
| handicap | enum | none | none, knight, rook, queen |
| autoQueen | bool | false | |
| voteSec | seconds | 20 | 10–60 |
| noVotes | enum | random | random, pause |
| streamerClock | seconds | 90 | 0 (off), 30–300 |
| audienceTeam | enum | none | none, white, black |
| guessTheMove | bool | true | |

## State machine
```
intro → [ply]{ to-move(side) → (human move | vote-open → vote-close → play) → animate(pace 600) } → … → result(pace 6000) → end
```

## Types
```ts
interface ChessState {
  phase: "intro"|"to-move"|"voting"|"result";
  mode: "duel"|"streamer-vs-chat"|"team-vs-team"; startFen: string; fen: string; san: string[]; uciHistory: string[];
  sides: { w: SideOwner; b: SideOwner };          // SideOwner = { kind: "player"; id } | { kind: "audience" } | { kind: "team"; teamId }
  clock?: { w: number; b: number; inc: number; turnStartedAt: number };
  deadline: number|null; drawOffer?: "w"|"b"; lastMove?: { from: string; to: string; san: string; captured?: string; check: boolean; promotion?: string };
  captured: { w: string[]; b: string[] };
  hidden: { teamVotes: Record<PlayerId, string /*uci*/> };   // view() projects to per-move counts + the viewer's own vote
  voteSummary?: { top: { uci: string; san: string; pct: number }[]; total: number };  // after close
  result?: { winner: "w"|"b"|null; reason: "checkmate"|"resign"|"flag"|"stalemate"|"repetition"|"fifty"|"material"|"agreement"|"adjudicated" };
  firstMoveAt: number | null; pausedMs: number;     // R8a time cap
}
type ChessAction =
  | { type: "move"; from: string; to: string; promotion?: "q"|"r"|"b"|"n" }
  | { type: "teamVote"; uci: string }
  | { type: "resign" } | { type: "offerDraw" } | { type: "acceptDraw" };
```

## Views
- Chess is a game of full information. All roles see the board, the clocks and the history.
- `hidden.teamVotes` is projected into counts per move, and each player sees their own vote.
- The player view adds `you: { color, legal: {from,to,promotion?}[], canOfferDraw }`.
- The stage adds the live audience or team top-3 move arrows from the `tally` messages (the client computes them).

## Audience hooks
- A move `vote` poll for each chat move.
- A `quiz` guess-the-move poll during duels, and on the streamer's turns in streamer-vs-chat.
- **A custom audience panel** (`audience.tsx`, required): a lightweight **2D SVG board**, with no three.js, where the viewer taps from-square then to-square. It shows the current top-3 votes as purple arrows with percentages.

### Audience job per phase (G14)
| Mode / phase | Audience job |
|---|---|
| duel, every turn | guess-the-move `quiz` (event-closed) |
| streamer-vs-chat, chat's turn | move `vote` (≤ 23 s) |
| streamer-vs-chat, streamer's turn | guess-the-move `quiz` |
| team-vs-team | move `vote` if `audienceTeam` is set, otherwise guess-the-move `quiz` on both teams' turns |

Player idle exception: a duel player waiting on the opponent's move (bounded by the clock) and a team voter waiting on the other team's vote (≤ 23 s) are accepted; in `streamer-vs-chat` the streamer waits ≤ 23 s per chat move.

## Visual & animation spec
- **Board:** a two-tone wood inlay (warm maple and walnut, from the procedural wood texture tinted by the tokens) with a bevelled frame and engraved coordinates. It is **one mesh**, and picking is analytic (the board plane gives file and rank).
- **Pieces:**
  - Chunky stylised lathe pieces with extruded crowns and knight heads (a simple extruded silhouette with a bevel), at most 600 triangles each on low.
  - **Clay matcap**, tinted with the fixed tokens `chess-light` `#F1E6D2` (cream) and `chess-dark` `#7FA88E` (sage), defined in SPEC §13.3.
  - 6 InstancedMeshes (one per piece type) with `instanceColor`, plus instanced blob shadows.
- **Move animation:** the piece lifts 0.15 u (120 ms), slides with `ease-inout` (60 ms per square, clamped to 250–550 ms), and sets down with `snappy` plus a `tok` sound. Knights arc. For castling, the rook follows 120 ms later.
- **Capture:** the captured piece hops, spins, shrinks and puffs, then re-appears in the **wooden capture tray** beside the board (`bouncy`). A material-difference chip (+3) sits by the tray.
- **Check:** the king's square gets a soft `danger` glow pulse, and a gentle `fail` sound plays. **Checkmate:** a slow camera Focus on the king, which topples over (a rotation with the `wobbly` spring), then confetti in the winner's side colour.
- **Last move:** from and to squares get soft `info` highlights. Legal targets for the selected piece are shown as dots, and captures as rings.
- **Clocks:** a flip-dial wooden chess clock prop, with its digits on the DOM HUD next to it in Fredoka tabular. The active side's plunger is down. At 10 s or less the digits turn `warning`, and at 5 s or less `danger` with a tick sound.
- **Vote mode:** purple arrows (flat extruded arrow meshes, instanced ×3) on the board show the top 3 moves, with thickness following the vote share and a live % label (DOM). A vote countdown ring sits on the audience panel. The winning arrow flashes, and then the piece moves.
- **Teapot prop** with steam at the table edge; it counts toward the environment budget and is shared with the room.
- **Controller:** the shared `board2d` **SVG** board (no three.js; the same component as the audience panel), **oriented to the player's colour** (the phone only), with tap-tap and drag, piece glyphs drawn as flat versions of the Stage's clay pieces in `chess-light`/`chess-dark`, a promotion picker sheet, resign and draw buttons behind a "…" menu, and the clocks at the top and bottom. Team voters see the same board and their vote marks a purple arrow. An opt-in "3D board" toggle swaps in `requestBoard()`.

## Scenarios
| id | roles | description | what the critic should see | anim |
|---|---|---|---|---|
| opening | stage, player | Duel after 1.e4 e5, 5+3 clocks | Clean board, clocks, last-move highlight | `slide` 600 ms |
| midgame | stage, player | A seeded 24-ply position with captures in trays | Readable position, trays, material chip | — |
| capture | stage | Bishop takes knight | Puff, then the tray landing | `capture` 900 ms |
| check | stage | Check on the king | Danger glow | `check` 800 ms |
| chat-vote | stage, audience | Streamer vs Chat, vote 52/31/17 | Purple arrows, % labels, audience 2D board | `arrows` 800 ms |
| team-vote | stage, player | Team vs Team, the Tomato team voting | Team chips, arrows in the team colour + purple for the audience bloc | — |
| checkmate | stage | Mate position | King topple, confetti, result banner | `mate` 2000 ms |
| promotion | player | Promotion picker sheet | 4 big piece buttons | — |
| streamer-thinking | stage, audience | Streamer vs Chat, streamer to move, guess-the-move open with 340 guesses | "Chat is guessing your move…" chip, purple guess counter; audience 2D board | — |
| time-cap | stage | Vote mode at the 2-minute warning | "Final 2 minutes!" chip, material chip prominent | — |

**Perf script:** `slide` ×4, then `capture`, then `arrows`, then `mate`.

## Edge cases
- Promotion without a `promotion` field when autoQueen is off: the move is rejected with `ILLEGAL`.
- A flag at the same instant as a mate: the server processes events in order, and the mate wins if the move arrived before the timer fired.
- A vote tie where every tied move leads to stalemate: still broken by the rng.
- No legal moves when the poll would open: the terminal state is detected first, so no poll opens.
- The handicap removes a rook: castling rights on that side are removed.
- Streamer vs Chat with the audience below minimum and `noVotes = pause`: the host dock shows "Chat needs 5 voters", with a Force button.

## Test cases
- **T1** FEN round-trip and deterministic replay from `uciHistory`.
- **T2** All terminal reasons, using known FEN fixtures for mate, stalemate, repetition, the 50-move rule and insufficient material.
- **T3** Clock math with the increment, and a flag against insufficient material being a draw.
- **T4** Promotion handling and autoQueen.
- **T5** Vote plurality, ties by rng, zero votes under both policies, and the `audienceTeam` 50/50 blend.
- **T6** Handicap FENs are legal, and castling rights are adjusted.
- **T7** Guess-the-move resolves with the played move.
- **T8** `parseAction` rejects squares outside a1–h8 and bad promotion values.
- **T10** `maxMinutes` adjudication: material difference ≥ 3 wins, otherwise draw; paused time is excluded.
- **T11** `mode: auto` selects streamer-vs-chat / duel / team-vs-team by participant count; a streamer-vs-chat loss yields an empty ranking.
- **T12** Guess-the-move opens on the streamer's turns in streamer-vs-chat and discards guesses received after the move.
- **T9** Bots complete every mode. In duel sims, results are sane: no side wins more than 60% in bot-vs-bot play; each game hits a terminal state or adjudication.
- **Invariants:** the FEN always equals replaying `uciHistory` from `startFen`; clocks never go negative in the view. **Max steps:** 700.

## Builder notes
