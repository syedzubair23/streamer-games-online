# trivia-night: Trivia Night (Classic + Bluff)

**Tier:** G3.
- **Players:** 1–10, with an optional team mode.
- **Session:** about 10 min (Classic) or 12–15 min (Bluff or Mixed).
- **Audience:** plays every question on its own leaderboard, predicts the Showdown, and gets one lifeline vote per game.
- **Manifest:** `tickHz: 0`, `renderMode: "on-demand"`, `teamSupport: "optional"`, `audience: { quiz: true, predict: true, vote: true }`, `estMinutes: [8, 15]`.
- **howToPlay:** `["Answer on your phone. Faster = more points", "Bottom two face The Kettle showdown", "Chat plays along on its own leaderboard"]`

## Why it's in
- Trivia is the most popular Jackbox genre, and the Kahoot model is universally familiar.
- The audience gets **real play-along with its own rank**, which is the strongest audience hook in the Jackbox research.
- Bluff mode (Fibbage-style) adds comedy, and the players write the content themselves.

## Rules

### Classic
- **R1** A game has `questions` questions (12 by default).
  - Setup draws them from the selected packs, following the difficulty curve: the first third mostly easy, the middle mostly medium, and the last third mostly hard.
  - Categories do not repeat back to back.
  - No question repeats within a room session. The room keeps a set of used ids, passed in through `content`.
- **R2** Each question runs through these phases:
  1. `category` (pace 1800)
  2. `read`: the question is shown and the answers are hidden (pace 2500 + 40 ms per character, max 6000)
  3. `answer`: the deadline is `timing.input(answerSec*1000)`, 20 s by default. An audience `quiz` poll opens at the same moment, with speed bonus following `speedScoring`.
  4. `reveal` (pace 4000)
- **R3** In the answer phase, each player locks one of 4 options. The first submission is final.
  - The phase ends early once every connected player has answered.
  - The answer time is `receivedAt − answerOpenedAt`, using server times.
- **R4 Scoring:**
  - A correct answer scores **500**, plus a speed bonus of `round(500 × clamp01((window − max(0, t − streamDelay)) / window))` when `speedScoring` is on. Here `window = answerSec*1000*timerScale`, and the first `streamDelay` seconds always count as full speed.
  - When `timerScale = 0` there is no window, so the speed bonus is **off** for the whole game (every correct answer scores a flat 500) and the host dock shows "Speed bonus off (no timer)". This avoids the divide-by-zero.
  - Streak bonus: +100 for each consecutive correct answer beyond the first, capped at +300.
  - Wrong or missing answers score 0 and reset the streak.
- **R5 Showdown, "The Kettle":**
  - It runs after question 4 and question 8, when there are 3 or more players and `showdown` is on.
  - The bottom 2 players by score face off (ties go to the slower total answer time). A `predict` poll ("Who stays cool?") opens for 12 s over those two.
  - Both players answer one showdown question within 10 s.
  - The loser is the player who is wrong. If both are wrong, both lose. If both are right, the slower one loses.
  - **The Showdown is a comeback, not a pile-on.** The winner gets **+750 "Cool Head"** points (enough to leapfrog one or two places at this stage). The loser(s) become **Steamed** for exactly the **next 2 questions**: they score ×0.5 on those, and the status then expires with a "Cooled off!" moment. (The old rule, ×0.5 until 2 correct in a row, compounded the penalty on the players who were already last and could last the whole game, which is the opposite of what keeps a trailing player engaged.)
  - The predict poll resolves with the winner. If both lost, the poll resolves with no winner and everyone's stake is refunded.
- **R6 Lifeline:**
  - It runs once per game, in the scoreboard break after question 4, if `lifeline` is on.
  - An audience `vote` poll ("Give a 50/50 to…") opens over all players for 12 s.
  - If the audience total is at least `audienceMin`, the plurality player (ties broken by the lowest score) gets two wrong options removed **on their phone only** for the next question.
- **R7 Scoreboard breaks** come after questions 4, 8 and 12 (pace 4000). In team mode, a team's score is the sum of its members' scores and the team answer is the members' plurality. In that case each member's lock is a vote, and the team answer is fixed at the deadline or when all members have locked, with ties going to the earliest vote.
- **R8 End:** ranking by score. Ties are broken by lower total correct-answer time, then by seat.

### Bluff (Fibbage-style)
- **R9** Each bluff item has a `prompt` with a blank, a `truth`, `alts` (accepted variants of the truth) and a `category`.
  - Phase `write`: every player writes a lie of 1–40 characters within `timing.input(lieSec*1000)` (60 s).
  - A lie is **rejected** as "too close to the truth" (private message, the player retries) if its normalized form equals the truth or an alt, or has Levenshtein distance ≤ 1 from one of them for strings of 5 or more characters.
  - A missing lie at the deadline is replaced by one of the item's `houseLies`.
- **R10** Duplicate lies (equal after normalization) are merged into one option, and every author of that lie is credited.
- **R11** Phase `pick`: the options are the truth plus all lies (plus house lies to reach at least 4 options), shuffled.
  - Each player picks one option within 20 s and cannot pick their own lie (it is removed from their option list).
  - An audience `quiz` poll over the same options opens with no speed bonus.
- **R12 Bluff scoring:**
  - Picking the truth scores +1000.
  - Each player fooled by your lie gives you +500.
  - Audience fooled: the author(s) get `round(500 × audienceShare(lie))` split equally, but only when the audience counted.
  - Picking a house lie scores 0.
- **R13** Phase `reveal`: lies are revealed one by one, least-picked first, each showing its author(s) and who fell for it (pace 1800 each), and the truth comes last (pace 3000).
- **R14 Modes:**
  - `classic`: R1–R8.
  - `bluff`: `bluffRounds` items (6 by default), with no Showdown.
  - `mixed`: 8 classic questions, then 3 bluff items, with the Showdown after question 4 only.

### Host options
| key | kind | default | range |
|---|---|---|---|
| mode | enum | classic | classic, bluff, mixed |
| packs | pack trivia-mc multi | ["trivia-general"] | 8 category packs |
| bluffPacks | pack trivia-bluff multi | ["bluff-core"] | |
| questions | int | 12 | 6–20 |
| bluffRounds | int | 6 | 3–10 |
| answerSec | seconds | 20 | 10–40 |
| lieSec | seconds | 60 | 30–120 |
| speedScoring | bool | true | |
| showdown | bool | true | |
| lifeline | bool | true | |
| difficulty | enum | curve | easy, curve, hard |

## State machine
```
intro → Q[i]{category → read → answer → reveal} → (i%4==0: scoreboard → lifeline-vote? → showdown{predict → answer → verdict}?)
      → … → final → end
bluff: intro → B[j]{prompt → write → pick → reveal-lies → reveal-truth → scores} → final
```

## Types
```ts
interface McItem { id: string; q: string; options: [string,string,string,string]; correct: 0|1|2|3; category: string; difficulty: 1|2|3; source: string; validUntil?: string }
interface BluffItem { id: string; prompt: string; truth: string; alts: string[]; houseLies: string[]; category: string; source: string }
interface TnState {
  phase: Phase; mode: "classic"|"bluff"|"mixed"; index: number; deadline: number|null; openedAt: number|null;
  current?: { kind: "mc"; id: string; q: string; options: string[]; category: string } | { kind: "bluff"; id: string; prompt: string; category: string };
  hidden: {
    queue: (McItem|BluffItem)[]; correct?: number; truth?: string; alts?: string[];
    answers: Record<PlayerId, { choice: number; at: number }>;
    lies: Record<PlayerId, string>; lifelineRemoved?: { player: PlayerId; remove: [number, number] };
    bluffAuthors: Record<string /*optionId*/, PlayerId[]>;   // copied to public `revealedAuthors` in reveal-lies
    picks: Record<PlayerId, string>;                         // copied to public `revealedPicks` in reveal-lies
    showdownCorrect?: number;
  };
  bluffOptions?: { id: string; text: string }[];            // public in pick phase (no authors)
  revealedAuthors?: Record<string, PlayerId[]>; revealedPicks?: Record<PlayerId, string>;
  lastReveal?: { correct: number; perPlayer: Record<PlayerId, { ok: boolean; points: number; ms: number }>; audiencePct?: number[] };
  scores: Record<string, number>; streaks: Record<PlayerId, number>; steamed: Record<PlayerId, { questionsLeft: 0|1|2 }>;
  showdown?: { players: [PlayerId, PlayerId]; q?: { q: string; options: string[] }; verdict?: PlayerId[] };
  totalCorrectMs: Record<PlayerId, number>;
}
type TnAction = { type: "answer"; choice: 0|1|2|3 } | { type: "lie"; text: string } | { type: "pick"; optionId: string };
```
**Implementation rule:** anything secret lives under `hidden` and is copied into a public field only when its reveal phase starts.

## Views
- The correct index, the truth, lies before the pick phase, authors before the reveal, and other players' answers before the reveal all stay hidden.
- A player sees their own lock state and choice. Only the lifeline recipient sees the removed options.
- Stage and audience see: the question and options (from `answer`), the count of players who have answered with their plates marked, the countdown, and at reveal each player's result and the audience percentage per option.

## Audience hooks
- A `quiz` poll on every question and every bluff pick, for audience play-along points and a rank.
- A `predict` poll on each Showdown.
- The lifeline `vote`.
- The stage shows an audience bar on each answer book at the reveal ("Chat: 64%").
- **Chat vs Players** line on the scoreboard break: the audience's average correct rate against the players' ("Chat 71% · Players 64%"), which gives a solo streamer (Chat Only preset) a clear rival.

### Audience job per phase (G14)
| Phase | Typical length | Audience job |
|---|---|---|
| category / read | 1.8–6 s | reactions (short phase) |
| answer | ≤ 23 s | `quiz` |
| reveal / scoreboard | 4 s | reactions (short phase) |
| lifeline-vote | 12 s | `vote` |
| showdown | ≤ 25 s | `predict` |
| bluff write | ≤ 63 s | **Bluff bet:** a `predict` poll "Who fools the most players?" over the players, resolved at the end of reveal-lies |
| bluff pick | ≤ 23 s | `quiz` |

## Visual & animation spec
- **Set:** a library nook. The mat is a cork board. The question is a large index card (paper texture, Nunito 800 for the question, 40 px or more at 1080p, wrapped at 3 lines or fewer, with auto-shrink to a 34 px minimum).
- **Answer tiles:** four coloured **books** (Tomato, Sky, Sunflower and Mint spines, each with its glyph and a letter A–D) standing on a small shelf. They slide out 0.3 units toward the camera when the options appear (60 ms stagger).
  - At the reveal, the correct book tips forward and glows `success`, and the wrong books darken (`uDim` 0.25).
  - Player avatar chips hop onto the book each player chose.
- **Timer:** a candle burning down beside the card. The flame is a sprite halo and the wax height is a scale transform. The HUD ring is shown too.
  - At 5 s or less the flame flickers faster.
  - In rain mode a soft thunder rumble plays at 3 s.
- **Showdown, "The Kettle":**
  - The camera goes to Focus on a copper kettle prop. The two players' tokens sit on either side of it.
  - On the verdict, the kettle whistles (a synthesized steam sound), steam puffs play (`puff` in white), and the loser's token turns translucent with a steam swirl (the Steamed state is shown as a steam chip on their plate).
- **Bluff:** option cards pinned to the cork like notes. During reveal-lies each card flips over to show its author chips, and "fooled" string lines draw from the fooled players' tokens to the card. The truth card gets a gold pin and confetti.
- **Controller:** 4 huge coloured buttons with letters, glyphs and the option text, a lock confirmation ("Locked in!"), and after the reveal a ✔ or ✗ with the points earned. Bluff mode uses a text input and then a list of option buttons.
- **Audience controller:** the platform's generic `quiz` UI, the same 4 colours, plus the viewer's own rank chip.

## Scenarios
| id | roles | description | what the critic should see | anim |
|---|---|---|---|---|
| category | stage | Category card "Geography", Q5 of 12 | Category card flip | `flip` 600 ms |
| answering | stage, player, audience | Q5 answer phase, 3 of 5 locked, 11 s left | Readable question card, books, candle, locked plates | — |
| reveal | stage | Correct = C, audience 64% right | Tipping glowing book, chips on books, audience bars | `reveal` 1200 ms |
| scoreboard | stage | After Q4 with streaks, one player Steamed | Rolling scores, steam chip | `scores` 1000 ms |
| showdown | stage, audience | Kettle face-off, predict tally 70/30 | Kettle focus, two tokens, purple odds | — |
| showdown-verdict | stage | Loser steamed | Whistle steam, translucent token | `steam` 1500 ms |
| bluff-pick | stage, player | 6 options on cork | Readable notes, timer; player option list | — |
| bluff-reveal | stage | Lie revealed with 3 fooled players | Strings from tokens, author chips | `fooled` 1400 ms |
| final | stage | Winner + audience MVP | Podium, confetti, top audience chip | `win` 2000 ms |

**Perf script:** `flip`, then `reveal`, then `steam`, then `win`.

## Edge cases
- One player (solo, with an audience): Showdown and lifeline are disabled automatically.
- A question's `validUntil` has passed: the question is skipped at setup.
- A player answers after the deadline because of latency: the late answer is rejected (the server time decides).
- Team mode with an empty team: the empty team is excluded.
- All players lie with the same text: the merged option counts as one lie, and house lies fill the option list up to at least 4.
- Duplicate truth-like lies across players: each is rejected on submission (R9), not after the fact.

## Test cases
- **T1** Speed bonus math, including stream-delay compensation and a timerScale of 1.5.
- **T2** Streak cap is +300.
- **T3** Showdown selection breaks ties by slower total answer time, and the verdict matrix covers all four right/wrong combinations.
- **T4** The Showdown winner gets +750; Steamed ×0.5 applies to exactly the next 2 questions and then expires, whether those answers were right or wrong.
- **T13** With `timerScale = 0`, correct answers score a flat 500 and no speed bonus is computed.
- **T5** Lifeline changes only the recipient's view.
- **T6** Bluff rejection of the truth, its alts and Levenshtein-1 variants; duplicate merging credits every author.
- **T7** Bluff scoring, including the audience-fooled split between two authors.
- **T8** A player can't pick their own lie.
- **T9** Secrecy: `correct` and `truth` never appear in any view before the reveal (fuzz test).
- **T10** No question repeats within a session given the used set, and categories don't repeat back to back.
- **T11** Mixed mode ordering.
- **T12** Bots finish 1–10 players in every mode.
- **Invariants:** at most one lock per player per question; the pick options always include the truth. **Max steps:** 1,500.

## Content
- `trivia-mc` packs: `trivia-general`, `trivia-geography`, `trivia-science`, `trivia-history`, `trivia-movies-tv`, `trivia-music`, `trivia-gaming`, `trivia-food-nature`. Together they need **960 or more items** (40 per category per difficulty). Each item needs a `source` URL, and questions that depend on a date need `validUntil`.
- **Question-writing rules** (checked in the quality sample): the question fits in 3 lines at 40 px (≤ 110 characters); options ≤ 28 characters each; exactly one defensible answer; no "which of these is NOT"; distractors are plausible and of the same type; fun-fact tone over textbook tone.
- The `bluff-core` pack needs **200 or more** items, each with 3 house lies.
- All wording is original. Verification is per ROADMAP M4-02: every item fact-checked by a second agent, then a 10% re-check with 0 errors allowed.

## Builder notes
