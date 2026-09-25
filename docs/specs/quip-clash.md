# quip-clash: Quip Clash

**Tier:** G1, the **STYLE GOLDEN**. Its approved screenshots become `docs/references/_style/golden/`.
- **Players:** 3–8, with optional team mode (3 or 4 room teams act as authors).
- **Session:** 12–15 min, in 3 rounds.
- **Audience:** a weighted vote bloc on every matchup, a "who wins this round?" bet while players write, plus the Audience Favourite award.
- **Manifest:** `tickHz: 0`, `renderMode: "on-demand"`, `teamSupport: "optional"`, `audience: { vote: true, predict: true }`, `estMinutes: [12, 15]`, `contentRating: "all"` (the teen packs are opt-in).
- **howToPlay:** `["Write funny answers to prompts", "Two answers go head to head", "Everyone votes. Funniest wins!"]`

## Why it's in
- It is the format Jackbox itself recommends for streaming, and Quiplash is the benchmark audience-vote game, supporting up to 10k audience members.
- Anyone can learn it in 10 seconds, and it produces clip-worthy moments every 30 seconds.
- Its phases (submit, reveal, vote) exercise the platform's audience system first.

## Rules (authoritative)
- **R1** 3–8 seats. In team mode, each room team acts as one "author": any teammate can submit, the last submission before the deadline counts, and teammates can see each other's current submission. Team mode needs **3 or 4 room teams** (2 teams would give N=2 authors, so every matchup is the same pair and nobody but the audience can vote); with `teams.count = 2` the game runs in non-team mode and the host dock says so.
- **R2** Rounds 1 and 2 each use N prompts, where N is the number of authors.
  - Shuffle the authors into a circle. Prompt *i* goes to authors *i* and *(i+1) mod N*.
  - This gives every author exactly 2 prompts, and every prompt exactly 2 authors.
  - No two prompts in one game repeat.
- **R3** Answer phase:
  - The deadline is `timing.input(answerSec*1000)`, 90 s by default.
  - An answer is 1–45 characters after trimming, and goes through `filterText` at the room's filter level.
  - An author can resubmit until the deadline.
  - The **Safety Quip** button fills the answer with a random `safety` line from that prompt's pack item. It can be used once per round per author.
  - The phase ends early once every author has submitted all their prompts.
  - **Audience job during the answer phase (R3a):** a `predict` poll "Who wins this round?" over the authors opens with the phase and closes when the first matchup's `show-prompt` starts. It resolves with the author who scored the most points in that round (ties: the earlier seat). In round 3 the poll is "Who wins Last Quip?". This removes the 90 s audience dead zone.
- **R4** An answer still missing at the deadline counts as blank.
- **R5** Matchups are revealed in prompt order. For each one:
  1. `show-prompt` (pace 2500 ms)
  2. `show-answers` (pace 1500 ms)
  3. `vote`: the deadline is `timing.input(voteSec*1000)`, 20 s by default. At the same moment an audience `vote` poll opens with options A and B.
  4. `results` (pace 4500 ms)
- **R6** Every player who is not one of the matchup's authors (or on their team) casts exactly one vote, A or B, and can change it until the deadline.
  - The phase ends early once all eligible players have voted. The platform's minimum audience window (SPEC §4) holds that close until at least `streamDelaySec + 5 s` after the vote opened, so stream viewers who see the answers late still get to vote. The game just emits the early close.
- **R7** Matchup scoring. The round multiplier is 1 for round 1 and 2 for round 2, and `base = 1000 × multiplier`.
  - `playerShare(X) = votes for X / eligible votes cast`. If no votes were cast, it is 0.5.
  - The audience counts if `poll.total ≥ audienceMin`. In that case `audShare(X) = tally X / total`, and `share(X) = (1−w)·playerShare + w·audShare`, where `w = audienceWeight/100` (default 30). Otherwise `share = playerShare`.
  - Each author scores `round(base × share)`.
- **R8 QUIP-OUT:** every eligible player who voted chose X, at least one of them did, and either the audience did not count or `audShare(X) ≥ 0.8`. X's author then earns a bonus of `+250 × multiplier`.
- **R9 JINX:** if both answers are equal after `normalize()`, voting is skipped, both authors score 0, and the stage shows "JINX!".
- **R10 Blanks:**
  - If one answer is blank, the other author gets `base + QUIP-OUT bonus` automatically and voting is skipped.
  - If both are blank, the matchup is skipped.
- **R11 Round 3, "Last Quip":**
  - One prompt goes to every author, with a `timing.input(75_000)` answer deadline.
  - Every player then gets **3 votes** to spread across the other answers, within `timing.input(voteSec × 1.5 × 1000)` (30 s by default). The phase ends early when every player has allocated all 3. They cannot vote for their own answer, but they may stack more than one vote on the same answer.
  - At the same time the audience gets a `vote` poll over all answers.
  - `playerShare(X) = votes X / all player votes`. The audience blend is the same as in R7. Each author scores `round(3000 × share)`.
  - A blank answer scores 0 and is not shown.
- **R12** The game ends after round 3.
  - The ranking is by total score. Ties are broken by more QUIP-OUTs, then by earliest seat.
  - Highlights: "Audience Favourite" goes to the answer with the highest single audShare across the game (only when the audience counted), and "Quip-Out King" goes to whoever has the most QUIP-OUTs.
- **R13** Moderation, when `RoomConfig.moderation = reveal-review`:
  - Every submitted answer emits a `moderate` effect.
  - At `show-answers`, if an answer in the matchup is still pending, the phase waits in `review-wait`. The pending text is shown only in the **host panel pop-out** and on moderator devices; the Stage dock shows "1 answer awaiting review". To keep the wait short, answers are queued for review the moment they are submitted, not at reveal.
  - A rejected answer is replaced by a safety quip and marked "edited by host".
  - An answer still pending 20 s into `review-wait` is treated as rejected (SPEC §9.7).
- **R14 Disconnects:**
  - A disconnected author's bot submits safety quips 10 s before the deadline.
  - A disconnected voter's vote is simply missing.
  - If there are fewer than 3 connected authors for 30 s, the host is prompted to end the game early (`forceAdvance` ends it with the current ranking).

### Host options
| key | kind | default | range / choices |
|---|---|---|---|
| packs | pack (quip-prompts, multi) | `["quip-core"]` | the `quip-spicy` pack is hidden when contentFilter is family |
| answerSec | seconds | 90 | 45–180 |
| voteSec | seconds | 20 | 10–40 |
| audienceWeight | int | 30 | 0–50, step 5 |
| rounds | enum | "3" | "2" (skip round 2), "3" |
| safetyQuip | bool | true | |

## State machine
```
intro(pace 6000) → r1:answer → r1:matchup[i]{show-prompt → show-answers → (review-wait)? → vote → results} ×N
  → r1:scores(pace 5000) → r2:… → r2:scores → r3:answer → r3:show-all(pace 3000) → r3:vote → r3:results(pace 7000) → final(pace 9000) → end
```
Phase ids: `intro | answer | show-prompt | show-answers | review-wait | vote | results | scores | show-all | final`, plus `round: 1|2|3` and `matchup: number`.

## Types
```ts
type AuthorId = string; // playerId or teamId in team mode
interface QcState {
  phase: Phase; round: 1|2|3; matchup: number; deadline: number | null;
  authors: { id: AuthorId; members: PlayerId[]; colorSlot: number }[];
  prompts: { id: string; text: string; authors: [AuthorId, AuthorId] | AuthorId[]; round: 1|2|3 }[];
  hidden: { answers: Record<string /*promptId*/, Record<AuthorId, { text: string; safety: boolean; mod: "ok"|"pending"|"edited" }>>; safetyPool: Record<string, string[]> };
  revealed: Record<string /*promptId*/, { answers: Record<AuthorId, string>; }>;   // copied from hidden at show-answers
  votes: Record<PlayerId, string | Record<AuthorId, number>>;                    // current matchup / last quip
  results: Record<string /*promptId*/, { points: Record<AuthorId, number>; playerShare: Record<AuthorId, number>; audShare?: Record<AuthorId, number>; quipOut?: AuthorId; jinx?: true }>;
  scores: Record<AuthorId, number>; quipOuts: Record<AuthorId, number>; safetyUsed: Record<AuthorId, number /*round*/>;
  options: QcOptions;
}
type QcAction =
  | { type: "answer"; promptId: string; text: string }
  | { type: "safety"; promptId: string }
  | { type: "vote"; choice: AuthorId }                        // R5 matchup
  | { type: "lastVote"; alloc: Record<AuthorId, number> };    // R11, sum = 3
```

## Views per role
| Field | stage / audience | player (author) | host |
|---|---|---|---|
| phase, round, deadline, scores, authors | ✔ | ✔ | ✔ |
| who has finished answering (ids only) | ✔ | ✔ | ✔ |
| own prompts plus own current answers | ✗ | ✔ (their own only) | ✗ |
| current matchup prompt | from `show-prompt` | ✔ | ✔ |
| answers A/B | from `show-answers` (pending shown as blurred) | ✔ | ✔, including pending text for review |
| authors of A/B | from `results` | from `results` | from `results` |
| eligible to vote plus own vote | ✗ | ✔ | ✗ |
| results (points, shares, quip-out) | from `results` | ✔ | ✔ |

## Audience hooks
- A `vote` poll for every matchup, and an N-option poll for Last Quip. Live tallies drive the heart-jar animation.
- The round-winner `predict` poll during each answer phase (R3a); the Stage shows the live odds as purple chips on the writer tokens ("Chat's pick: 🟣 41%").
- The Audience Favourite highlight.
- The stage label for the audience's pick reads "Chat picked" in audience purple.

### Audience job per phase (G14)
| Phase | Typical length | Audience job |
|---|---|---|
| answer | 45–90 s | round-winner `predict` |
| show-prompt / show-answers | 4 s | reactions (short phase) |
| vote | 8–23 s | matchup `vote` |
| results / scores | 4.5–5 s | reactions (short phase) |
| r3 vote | ≤ 33 s | Last Quip `vote` |

Player idle exception: none. Non-authors vote in every matchup; authors are the matchup.

## Visual & animation spec
- **Mat and set:**
  - A cork mat, with a small raised wooden "open-mic" stage at the back of the table carrying a tiny mic prop and one warm halo spotlight.
  - Two paper answer cards (extrude, `radius-lg`, paper texture) on little wooden easel stands, left (A) and right (B). The text is rendered into the card's canvas texture in Nunito 800 (must wait for `document.fonts.ready`) at 44 px or more at 1080p.
  - The prompt sits on a pinned index card at the top of the board, written in Caveat.
- **Answer phase:**
  - One felt "writer" token per author sits around the cork, in identity colour with its glyph.
  - When an author finishes, a paper-plane puff flies from their token into a wire tray (`bouncy` spring, `tok` sound).
  - The HUD timer ring sits at the top centre.
- **Reveal:**
  - The prompt card flips in (flip 320 ms).
  - The answer cards pop up with `bouncy`, B landing 120 ms after A.
  - The camera glides to Focus on the pair.
- **Vote:**
  - Two glass jars in front of the cards.
  - Player votes arrive as paper hearts in the voter's identity colour.
  - Audience votes arrive as purple hearts, one heart per 2% of share and at most 50 per jar. They fall with a slight flutter (a pooled `InstancedMesh`).
  - The jar fill level follows the blended share, using the `gentle` spring.
- **Results:**
  - Author name chips drop onto the cards.
  - A points counter rolls up.
  - The winner's card gets the spotlight halo at 1.4× and a mini confetti burst of 24 pieces.
- **QUIP-OUT:** the "QUIP-OUT!" banner (`t-hero`, Fredoka) slides in with `ease-back`, followed by full confetti in the winner's colour and the `win` sound.
- **JINX:** both cards bonk together, a puff plays, and the banner reads "JINX!" in `warning`.
- **Last Quip:** up to 8 small cards in a 4×2 fan on the cork. Votes show as heart stickers stacking on the cards.
- **Final:** a 3-step podium made of wooden blocks, with the winner's writer token doing a `wobbly` squash-jump, confetti and the win chord.
- **Budget:** at most 30 draws for the game's own content on low: cards 1 instanced, jars 2, hearts 1 instanced, tokens 1 instanced, podium 1.
- **Controller (phone):**
  - An answer screen showing the prompt on a paper card, a 45-character input with a counter, and a big Submit button plus a Safety button.
  - For voting, two big answer cards to tap (the player's own matchup shows "You're in this one!").
  - For Last Quip, the answers as rows with − and + steppers, 3 hearts in total.

## Scenarios
| id | roles | description | what the critic should see | anim |
|---|---|---|---|---|
| intro | stage | 6 players, round 1 intro card | Round card, player tokens around the cork, room code chip | — |
| answering | stage, player | Round 1 answering, 4 of 6 done, deadline 42 s | Finished tokens with planes in the tray; player: prompt + input | `plane` 600 ms |
| reveal | stage | Matchup 2, both answers shown | Two readable cards, prompt card, spotlight | `reveal` 900 ms |
| voting | stage, player, audience | Vote phase, 3 of 4 players voted, audience tally 62/38 | Jars filling, purple hearts, timer | `hearts` 1500 ms |
| results | stage | Results with author chips and points | Clear winner, points roll-up | `results` 1200 ms |
| quipout | stage | QUIP-OUT moment | Banner + confetti, the result still readable | `quipout` 1600 ms |
| jinx | stage | JINX moment | Bonked cards + banner | `jinx` 900 ms |
| last-quip | stage, player | Round 3 vote, 7 answers | Card fan readable at 720p; player steppers | — |
| final | stage | Final podium | Podium, winner celebration, highlights chips | `win` 2000 ms |
| review-wait | stage, host | An answer pending moderation | Stage: blurred card + "awaiting review" chip, no text anywhere; host panel: the text with approve/reject | — |
| round-predict | stage, audience | Round 1 answering with the round-winner bet open, odds 41/22/… | Purple odds chips on writer tokens; audience predict UI | — |

**Perf script:** reveal, then hearts, then results, then quipout, back to back.

## Edge cases
- 3 players (N=3): each matchup has exactly 1 eligible voter, and the audience blend matters.
- In team mode with 3 teams of 2, N=3 authors and voters are the 2 players of the other team.
- An author submits an answer identical to their own other answer: this is allowed.
- A filtered answer in family mode shows masked; the author may resubmit.
- The host skips while in `vote`: the result is computed from the votes so far.
- The audience is below `audienceMin`: the jar shows purple hearts, but the chip says "chat vote not counted (need 5)".
- The deadline arrives with timerScale 0: there is no deadline, and the host's `forceAdvance` moves on.
- Every prompt pack is exhausted: fall back to the core pack, and report an error only if fewer than N×2+1 prompts are available (setup refuses to start, and the host sees a message).

## Test cases (G3)
- **T1** The assignment gives each author exactly 2 prompts and each prompt 2 distinct authors, for N=3..8 (property test).
- **T2** Scoring with no audience: votes 2–1 give 667/333 in round 1.
- **T3** Audience blend: w=0.3, player share 1.0, audience share 0.4 gives a share of 0.82.
- **T4** A QUIP-OUT requires audShare ≥ 0.8 when the audience counts.
- **T5** JINX detection is case- and punctuation-insensitive.
- **T6** One blank answer: the other author gets base + bonus automatically, with no vote phase.
- **T7** A player cannot vote in their own matchup; an illegal vote leaves the state unchanged.
- **T8** Last Quip rejects allocations that don't sum to 3 or include the voter's own answer.
- **T9** Safety quip is limited to once per round.
- **T10** Moderation: a pending answer blocks `show-answers`, and a rejected answer is replaced with "edited by host".
- **T11** Secrecy: before `show-answers`, no stage, audience or other-player view contains any answer text.
- **T12** Bots finish a full game for N=3..8 in both team and non-team mode.
- **T13** Tie-break order is QUIP-OUTs, then seat.
- **T14** The round-winner predict poll opens with the answer phase, closes at the first `show-prompt`, and resolves with the round's top scorer.
- **T15** Team mode with `teams.count = 2` falls back to non-team mode; with 3 teams, N=3.
- **T16** Last Quip vote has a deadline of `timing.input(voteSec × 1.5 × 1000)` and ends early when all allocations are complete.
- **Invariants:** the sum of the authors' `playerShare` in a matchup is 1 (or both 0.5); scores never decrease; `deadline` is set if and only if the phase is an input phase and timerScale is not 0. **Max steps:** 400.

## Content
Pack item: `{ id, text: "The worst thing to hear from your dentist: ___", safety: [3 strings], tags?: string[] }`. The packs are `quip-core` (at least 400 items, rated all) and `quip-spicy` (at least 150 items, rated teen). All text is original.

## Builder notes
(Builder-owned, 20 lines or fewer.)
- Votes name answer **slots** (`A`/`B`; Last Quip `c1..c8`), not author ids: the views table hides authorship until `results`.
- Stage/audience see vote **counts** only (`votesCast`/`votersEligible`) and ballots from `results`; who may vote would reveal the authors.
- Room settings (`moderation`, `contentFilter`, `audienceMin`) come from `ctx.room` (ER-006) or `createQuipClash(room)`; default room otherwise.
- Safety lines are drawn without replacement per prompt (an overwritten or rejected one goes back unless another author holds it), so matchups never get an accidental JINX. Once all 3 are out (Last Quip, more than 3 takers) a random line another author holds is reused, so Safety, the R13 replacement and the R14 fill always get a line. Safety quips (R14 fills too) are reviewed like any answer (R13). Bots use Safety only while an unused line is left (ER-008).
- After the players' vote ends the game waits up to 15 s for the audience result (the runner holds early closes), then scores without chat.
- Too few prompts: stays in `intro` with `error` and no timer; `forceAdvance` ends it with an empty ranking. `skipItem` is unused.
- R14 safety fill is done by the game (timer 10 s before the deadline); `bot()` returns null for away seats.
- Scenarios are "as of" `SCENARIO_NOW`; live tallies come as `audience-tally` fx. `midgame` (= voting) is the G8a perf scenario.
- **G14 conflict (for M2-05):** timed-bot medians are 6.1 / 8.8 / 10.6 min at 3 / 6 / 8 players against `estMinutes [12, 15]`; even with every window used in full a 3-player game lasts about 8.7 min. Idle gaps pass (audience 9.5 s, player 11.7 s). Needs a spec decision.
