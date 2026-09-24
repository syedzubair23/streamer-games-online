# doodle: Doodle (Guess + Telephone)

**Tier:** G4.
- **Players:** Guess mode 3–12, Telephone mode 4–10. Team Doodle is optional.
- **Session:** Guess mode 8–13 min, Telephone mode 10–14 min.
- **Audience:** guesses every drawing on its own leaderboard, votes the difficulty tier the drawer gets ("make it HARD"), bets on Chain of the Night, votes on the funniest step, and reacts.
- **Manifest:** `tickHz: 0`, `renderMode: "on-demand"`, `teamSupport: "optional"`, `audience: { guess: true, vote: true, predict: true, tap: true }`, `estMinutes: [8, 14]`.
- **Default mode is Guess.** It is the proven stream format (skribbl.io) and keeps the audience busy every second. Telephone is opt-in and cut-first (ROADMAP M5-01b).
- **howToPlay (guess):** `["One player draws a secret word", "Everyone races to guess it", "Faster guesses score more"]`
- **howToPlay (telephone):** `["Write a silly prompt", "Draw what you get, describe what you see", "Watch the chain fall apart!"]`

## Why it's in
- Gartic Phone peaks around 96k Twitch viewers and skribbl.io around 45k. Drawing is the strongest browser-native party genre on stream.
- Drawings are the funniest thing to watch, and each game produces a lot of clips.
- Rendering is cheap: the drawing is one canvas texture on a plane, and strokes are compact vector data.

## Stroke format (shared by both modes)
- **Canvas:** logical size 1024×768. A point is `[x, y]`, integers in 0–1023 and 0–767.
- **Stroke:** `{ id: string, c: 0..11 (palette index), s: 0..3 (size index: 4, 8, 16, 32 px), pts: number[] }`, where `pts` is flat `x0,y0,x1,y1,…`.
  - The client simplifies each stroke with Ramer–Douglas–Peucker (ε = 1.5) and sends batches every 100 ms: `{type:"stroke", id, c, s, pts, done}`, with 128 points or fewer per batch.
  - A drawing is capped at **20,000 points and 600 strokes**. Once a cap is reached, further strokes are rejected.
- **Other drawing actions:** `undo` (removes the last stroke) and `clear`.
- **Tools:** there is no fill tool, only a brush (all 12 palette colours) and an eraser, which is palette index 11 in the paper colour.
- **Palette (12, fixed):** ink `#3B2F3A`, the 8 identity colours, `#8A5A3E` (brown), `#9AA0A6` (grey), and paper `#FBF5EA` (the eraser).

## Guess mode rules
- **R1** A round is one drawing turn per player in seat order. There are `rounds` rounds: `auto` (default) means 2 rounds for 3–4 players and 1 round for 5 or more. (At the old fixed 2 rounds, 12 players meant 24 turns ≈ 35 min.)
- **R2 Word choice:**
  - The drawer is offered 3 words (one easy, one medium, one hard, from the selected packs, with no repeats in the session).
  - If `audiencePicksTier` is on and the audience count is at least `audienceMin`, a `vote` poll **over the difficulty tiers** ("Easy 🌱 / Medium 🌿 / HARD 🌵") opens for `timing.input(8_000)`, and the drawer gets the word of the winning tier. The audience **never sees the words**, so it can still play the guess poll. The Stage shows "Chat chose HARD 🌵", and a HARD turn gives guessers and the drawer ×1.25 points.
  - Otherwise the drawer picks a word within 12 s, and at timeout a random word is chosen.
  - The word is **secret** from everyone except the drawer until `reveal`. (The earlier draft showed the word to the audience *and* ran an audience guess poll on it, which is a contradiction: the audience would be guessing a word printed on their own phone.)
  - **The word is never shown on the Stage** before `reveal`.
- **R3 Draw:**
  - The deadline is `timing.input(drawSec*1000)`, 70 s by default.
  - Hints: blanks are shown from the start (`_ _ _ _`). At 50% and 75% of the time, one letter each is revealed (rng position, never spaces).
  - A word of 3 letters or fewer gets only the 75% hint.
  - Spaces and hyphens are always visible.
- **R4 Guesses:**
  - A guess is 1–32 characters, rate-limited to one per 800 ms per player.
  - **Correct** means that after `normalize()` and stripping one leading article (`a`, `an`, `the`) the guess equals the word or one of its `alt` values. There is **no** "contains the word" rule: it would let a player spam `cat dog fish bird house` and match anything.
  - **Close** means Levenshtein distance ≤ 1 (only for words of 5 or more letters). The guesser gets a private "So close!" `private` effect.
  - Incorrect guesses appear in the stage's guess feed after `filterText`. Correct guesses show as "⭐ Name got it!" and never reveal the text.
  - A player who has guessed correctly can still chat, but their messages go only to the other correct guessers and the drawer.
- **R5 Scoring per turn:**
  - A correct guesser scores `100 + round(200 × remaining / total)`, and the first correct guesser gets +50.
  - The drawer scores 60 per correct guesser, capped at 360.
  - On a HARD tier turn chosen by the audience (R2), every score in this rule is ×1.25 (rounded).
  - The turn ends when every guesser is correct, or at the deadline.
  - Then comes `reveal`: the word is shown on the Stage (pace 4000).
- **R6 Report:**
  - Guessers can press "Report drawing" (for letters or inappropriate drawings). If 50% or more of the connected guessers report, the turn ends at once, the drawer scores 0, and the stage shows "Drawing skipped".
  - The host can skip (`onHostCommand skipItem`) or blur the drawing from the host dock.
- **R7 Team Doodle** (teams on): teams alternate turns, with one drawer per team turn. Only the drawing team guesses for the first 60% of the time, and then the other team can steal. A correct team guess scores `200 + round(300 × remaining / total)` to the team.
- **R8 End:** ranking by score, with ties sharing the place. Highlight: "Best Artist" goes to the player whose drawings got the most correct guessers.

## Telephone mode rules
- **R9** The chain length is `L = min(N, maxSteps)`, where `maxSteps` defaults to **6** (range 4–10).
  - Step 0 is `write`: each player writes a prompt (3–60 characters, filtered) within `timing.input(40_000)`.
  - Steps then alternate `draw` (`drawSecT`, 60 s) and `describe` (35 s), up to L steps.
  - Pacing math: with N=8 and L=6, creation is 40 + 3×60 + 2×35 ≈ 5 min and the reveal is 8 chains × 6 steps × 4 s + 8 votes × 10 s ≈ 4.5 min, so ~10–11 min in total. The old defaults (L = N up to 12, 75 s draws, 6 s per step) ran 25+ min at 12 players.
- **R9a Audience during creation:** the Stage cannot show any work in progress without spoiling the reveal, so the audience gets (1) a `predict` poll "Whose chain wins Chain of the Night?" over the chain owners, open for the whole creation phase and resolved after the last chain vote, and (2) a rolling `tap` "Hype the artists" meter whose level sets the intensity of the reveal confetti. The Stage shows "N of M done" plates and a looping sketch animation.
- **R10 Routing:** at step k, player i works on chain `(i + k) mod N`. For k ≥ 1 they receive only the content of step k−1 of that chain. With L ≤ N, nobody sees their own chain before the reveal.
- **R11 Missing submissions:**
  - A missing prompt is replaced with a random easy doodle word.
  - A missing description becomes "(they fell asleep 💤)".
  - A missing drawing is kept as empty, and the stage renders a "zzz" sketch stamp.
  - A disconnected player's bot does the same.
- **R12 Reveal:**
  - Chains are presented one at a time, each step at a time, advanced by the chain owner's phone or by the host. They auto-advance after 4 s per step when `autoReveal` is on (the owner can advance sooner).
  - Audience reactions play live.
  - After each chain, a `vote` poll ("Funniest moment?") opens over the chain's drawings for `timing.input(10_000)`. Players also vote; they can vote once per chain and cannot vote for their own step.
- **R13 Telephone scoring:** each player vote on your step scores +100, and each audience plurality win scores +300 (when the audience counts). The ranking is by these points. Highlight: "Chain of the Night" goes to the chain with the most total votes.
- **R14** Telephone variants (`variant`):
  - `classic`
  - `speed`: all timers ×0.5
  - `peek`: the drawer only sees the previous description for 5 s, after which it hides

### Host options
| key | kind | default | range |
|---|---|---|---|
| mode | enum | guess | guess, telephone |
| packs | pack doodle-words multi | ["doodle-core"] | the kids pack auto-selects in family mode |
| customWords | enum | off | off, mix, only (the host pastes a word list in the options form; stored as a pack; custom words have no tier, so the tier vote is skipped for them) |
| rounds | enum | auto | auto, 1, 2, 3 |
| drawSec | seconds | 70 | 40–150 |
| hints | bool | true | |
| audiencePicksTier | bool | true | |
| drawSecT | seconds | 60 | 40–150 |
| maxSteps | int | 6 | 4–10 |
| variant | enum | classic | classic, speed, peek |
| autoReveal | bool | true | |

## State machine
```
guess: intro → [turn]{word-pick(audience tier vote or drawer) → draw → reveal(pace 4000)} ×(N×rounds) → final → end
telephone: intro → write → (draw → describe)… (L steps) → reveal{chain c: step k… → chain-vote} ×N → final → end
```

## Types
```ts
interface Drawing { strokes: Stroke[]; points: number; skipped?: boolean; empty?: boolean }
interface DoodleState {
  mode: "guess"|"telephone"; phase: Phase; deadline: number|null; round: number; turn: number;
  drawer?: PlayerId; hint?: string;                         // "_ a _ _ _"
  drawing: Drawing;                                         // guess: public live drawing
  feed: { by: PlayerId; text?: string; correct?: true }[];   // last 30
  correct: Record<PlayerId, number /*points*/>; reports: PlayerId[];
  hidden: {
    word?: { w: string; alt: string[] }; wordChoices?: string[]; usedWords: string[];
    chains?: { owner: PlayerId; steps: ChainStep[] }[];      // per-player step input is projected from here by view()
  };
  reveal?: { chain: number; step: number; steps: ChainStep[] };  // only the steps revealed so far (copied from hidden)
  scores: Record<string, number>; votes: Record<PlayerId, number /*stepIdx*/>;
}
type ChainStep = { kind: "text"; text: string; by: PlayerId } | { kind: "draw"; drawing: Drawing; by: PlayerId };
type DoodleAction =
  | { type: "pickWord"; idx: 0|1|2 }
  | { type: "stroke"; id: string; c: number; s: number; pts: number[]; done: boolean }
  | { type: "undo" } | { type: "clear" }
  | { type: "guess"; text: string }
  | { type: "report" }
  | { type: "write"; text: string }                         // telephone prompt/describe
  | { type: "advance" }                                     // telephone reveal (owner/host)
  | { type: "vote"; step: number };
```

## Views
- **Guess mode:**
  - The drawer's view has the word (and, during `word-pick`, the 3 choices when the drawer picks).
  - The audience view, the Stage and other players see only the hint (and during the tier vote, only the tier names).
  - Everyone sees the live drawing and the filtered feed. The text of correct guesses is never in any view.
- **Telephone mode:** each player's view contains only the input they need for the current step (the previous step of their assigned chain). The stage and audience see "N of M done" plates. At the reveal, the stage and every view get the revealed steps.

## Audience hooks
- A `guess` poll per Guess turn, with `accept` set to the word plus its alts. The count of correct audience members is shown as "🟣 214 chatters got it", and the first 3 names are shown. The **"Chat vs Players"** race chip shows whether the first correct chatter beat the first correct player.
- The difficulty-tier `vote`.
- In Telephone mode: the Chain of the Night `predict` and the hype `tap` meter during creation (R9a), and the per-chain `vote`.
- Reactions: laughs trigger a laugh-o-meter wobble on the easel.

### Audience job per phase (G14)
| Phase | Typical length | Audience job |
|---|---|---|
| word-pick | ≤ 11 s | tier `vote` |
| draw | ≤ 73 s | `guess` |
| reveal | 4 s | reactions (short phase) |
| tel write / draw / describe | ≤ 63 s each | Chain of the Night `predict` + hype `tap` |
| tel reveal | 4 s per step | reactions; per-chain `vote` after each chain |

Player idle exception: in Telephone reveal, a player's own content appears in most chains, so the 45 s rule is met by "a reveal involving their own content".

## Visual & animation spec
- **Set:**
  - A paper sketchbook on a small wooden easel at the centre of the table, with pencil and eraser props and a pencil cup.
  - The drawing lives on a `CanvasTexture` (1024×768 on mid/high, 512×384 on low) mapped to the paper plane. It uses `NoColorSpace` and `LinearFilter`, and is updated incrementally: only new segments are drawn into the 2D canvas, and the texture is flagged `needsUpdate` at most 30 times per second on mid/high and **15 on low** (each flag re-uploads the whole canvas; 30 full uploads/s of a 3 MB texture is the single biggest GPU-bandwidth risk in the set).
  - Strokes use round caps and joins with slight pressure-free smoothing (quadratic midpoints).
- **Live pencil:** a small 3D pencil prop follows the latest stroke point with the `snappy` spring while drawing is in progress. It hides after 600 ms of idle.
- **Hint:** large letter tiles as blank wooden Scrabble-like tiles under the easel. Revealed letters flip over (320 ms).
- **Guess feed:** on the HUD at the right side (clear of the webcam zone): chat bubbles as paper strips, up to 8 visible. A correct guess plays a sparkle, a star chip, the `success` sound, and a mini confetti burst in the guesser's colour from their plate.
- **Reveal:** the word is written in Caveat across a paper banner that unrolls over the easel. Each player's points chip pops from their plate.
- **Telephone reveal:**
  - The sketchbook page turns with a paper-curl vertex shader (one shared material from the factory, requested via engine-request if needed) over 700 ms.
  - Text steps are rendered on a paper card in Caveat, drawings on a page.
  - The author chip is shown on each step.
- **Controller, drawing screen:** the full-width canvas (1024×768 logical, letterboxed), a palette row of 12 chunky dots, a size selector with 4 dots, undo, clear, and the word at the top. It uses `getCoalescedEvents`. There is no zoom.
- **Controller, other screens:** a guess input with a big "Guess" button and the feed. The Telephone input screens use the same parts.
- **Audience:** the generic `guess` UI plus a mini view of the drawing (a 2D canvas fed by the same stroke stream, no three.js) and the hint tiles. The audience never sees the word before `reveal`.

## Scenarios
| id | roles | description | what the critic should see | anim |
|---|---|---|---|---|
| word-pick | stage, player(drawer), audience | Audience tier vote 20/35/45 | Stage: "Chat is choosing the difficulty…" with purple tier bars; audience: 3 tier buttons (no words); drawer: "Chat is picking your word" | — |
| tel-creating | stage, audience | Telephone draw step with the Chain of the Night bet open | "5 of 8 done" plates, sketch loop, purple bet bars, hype meter | — |
| drawing | stage, player(drawer), player(guesser) | 45% into a cat drawing, 2 hints revealed, feed with misses and 2 correct | Readable drawing, tiles, feed, pencil prop | `pencil` 1500 ms |
| correct-guess | stage | Moment of a correct guess | Sparkle, star chip, confetti from the plate | `correct` 900 ms |
| reveal | stage | Word banner unroll + points | Banner, point chips | `reveal` 1200 ms |
| tel-draw | stage, player | Telephone draw step, 5 of 8 done | Stage: plates plus a "drawing…" doodle animation; phone: prompt and canvas | — |
| tel-reveal | stage | Chain 2, step 3, page turning | Page curl, author chip, readable text | `page` 900 ms |
| tel-vote | stage, audience | Chain vote | Thumbnails of the chain's drawings, purple tallies | — |
| final | stage | Podium + "Best Artist" + gallery strip | Celebration, gallery | `win` 2000 ms |

**Perf script:** `pencil` with 600 stroke points streamed in, then `correct`, then `page`.

## Edge cases
- The drawer disconnects mid-turn: the turn ends, correct guessers keep their points, and the drawer's bot does not draw (a bot draw would be meaningless). The next turn follows.
- Words with spaces ("ice cream"): hints keep the space visible, and normalization collapses spaces.
- A guess in a different case or with accents is correct after normalization.
- The canvas point limit is reached: the drawer sees "Page full!" and undo still works.
- 10 players in Telephone mode with `maxSteps` 6: chains have 6 steps, and routing still never repeats a player within a chain.
- The family filter hits a telephone prompt: it is masked and the player may resubmit before the deadline.

## Test cases
- **T1** Correct and close matching table, including alts, leading articles and accents; a multi-word spam guess containing the word is **not** correct.
- **T2** Hint schedule: letters at 50% and 75% only, never spaces, and short words get the 75% hint only.
- **T3** Scoring: guesser time scaling and the drawer cap of 360.
- **T4** The 50% report threshold skips the turn.
- **T5** Stroke validation: out-of-range points, more than 128 points per batch, and the total cap are rejected.
- **T6** Undo and clear semantics.
- **T7** Telephone routing: no player sees their own chain, and each player works exactly one step per phase (property test for N=4..10 and any 4 ≤ L ≤ N).
- **T8** Telephone missing-submission fallbacks.
- **T9** Secrecy: the word never appears in the stage view, the audience view or a guesser's view before the reveal (including during the tier vote); telephone steps never leak outside the routing rule.
- **T12** The tier vote gives the drawer the word of the winning tier, applies ×1.25 on HARD, and falls back to drawer choice below `audienceMin`.
- **T13** `rounds: auto` gives 2 rounds for 3–4 players and 1 for 5+; Telephone `maxSteps` defaults to 6.
- **T10** Team Doodle: the steal window opens at 60%.
- **T11** Bots complete both modes for every player count. The guess bot guesses the word with probability 0.3 per 5 s, and the drawer bot draws random scribble strokes.
- **Invariants:** `drawing.points ≤ 20000`; the feed never contains the text of a correct guess. **Max steps:** 20,000 (strokes count as steps).

## Content
Word item: `{ w: "cat", alt?: ["kitty"], d: 1|2|3 }`. Every word must be drawable in 70 s by a non-artist (concrete nouns, actions and simple scenes; no abstract concepts in easy/medium). The `doodle-core` pack needs 1,200 or more words (about 40% easy, 40% medium, 20% hard). The `doodle-kids` pack needs 300 or more words (all easy or medium, rated all). No brands or trademarks.

## Builder notes
