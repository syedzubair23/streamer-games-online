# tune-in: Tune In

**Tier:** G2.
- **Players:** 2–12, in `teams` mode (2 teams, needs 4 or more players) or `ffa` mode.
- **Session:** 10–15 min.
- **Audience:** picks the spectrum card, bets on the result while the psychic writes the clue, and places its own dial (scored; the heatmap blooms on the Stage when the team locks).
- **Manifest:** `tickHz: 0`, `renderMode: "on-demand"`, `teamSupport: "optional"`, `audience: { vote: true, predict: true, dial: true }`, `estMinutes: [10, 15]`.
- **howToPlay:** `["The Psychic sees a secret spot on the dial", "They give a one-line clue", "Tune the dial to the spot!"]`

## Why it's in
- Wavelength is a modern party hit that people learn in 10 seconds.
- Thousands of audience guesses make one beautiful heatmap, which is the best mass-participation visual in the set.
- It is the cheapest game to render, and it is fun with 2 players or with 12.

## Rules
- **R1 Dial units:** 0–1000 map to a 180° arc (0 is the left end of the card, 1000 the right end). The target is `rng.int(901) + 50`, so it falls in 50–950 and never at the extreme ends. It is secret until the reveal.
- **R2 Scoring bands** by distance `d = |dial − target|`:
  - d ≤ 25 scores **4**
  - d ≤ 75 scores **3**
  - d ≤ 125 scores **2**
  - anything further scores **0**
  - A value exactly on a boundary takes the higher score.
- **R3 Psychic rotation:**
  - In teams mode, teams alternate turns, and within a team the psychic rotates by seat.
  - In ffa mode, the psychic rotates through all seats. The game lasts `cycles` full rotations, with a default of 1, or 2 when there are fewer than 4 players. **FFA is capped at 9 turns**: with 10–12 players, 9 psychics are drawn by seeded shuffle (everyone still guesses every turn, and the psychic score uses the mean of guessers, so being skipped as psychic is not a disadvantage in expectation).
- **R4 Card pick:**
  - Two spectrum cards are drawn. If `audiencePicksCard` is on, a `vote` poll opens for `timing.input(10_000)`. The psychic sees the target only **after** the card is chosen (so the audience vote cannot be steered by a psychic who already knows where the target lands).
  - If the audience total is at least `audienceMin`, the plurality card wins, with ties broken by the rng. Otherwise the psychic picks with a 10 s timer, and the first card is picked if they don't act.
- **R4a Result bet (audience job during the clue phase):** when `clue` starts, a `predict` poll "How close will they get?" opens with options `bullseye` (4 pts), `close` (2–3 pts) and `miss` (0). It closes when `guess` starts and resolves at `reveal` with the team's band (teams mode) or the **best** guesser's band (FFA).
- **R5 Clue:**
  - The psychic submits a text clue of 1–40 characters within `timing.input(clueSec*1000)` (45 s).
  - The clue is **rejected** (the state is unchanged and the psychic gets a private "try another" message) if it contains a digit, or if any normalized token of a card end (length 3 or more) appears as a token or a substring of a clue token.
  - If the psychic times out, the bot takes over (the bot uses the card's `examples` list).
- **R6 Guess (teams mode):**
  - The psychic's team shares a single dial. Any member can `setDial(v)`, limited to 5 per second per player, and the last value wins.
  - Any member can `lock`. Otherwise the dial locks at the deadline (`timing.input(guessSec*1000)`, 40 s). A `lock` is accepted only after the dial has been moved at least once or 5 s have passed, so a trigger-happy teammate cannot lock at 500 by accident.
  - If the team has only the psychic, the audience mean becomes the team's dial when the audience counted; otherwise the dial locks at 500.
- **R7 Steal (teams mode, if `steal` is on):**
  - After the lock, members of the other team each pick `left` or `right` within `timing.input(10_000)`. The plurality decides, and a tie means no steal.
  - The steal is correct if the target is on that side of the locked dial. A correct steal earns the other team 1 point.
  - If the dial equals the target exactly, there is no steal.
- **R8 Catch-up:** in teams mode, if a team scores 4 and is still behind or tied after scoring, it takes the next turn again. This can happen at most once in a row.
- **R9 FFA guess:** every non-psychic player sets and locks their own dial by the deadline, and scores band points. The psychic scores `round(mean of the guessers' points)`.
- **R10 Audience dial:**
  - Every turn a `dial` poll opens together with the guess phase and closes at the lock. It is opened with `hideLive: true` unless the `liveHeatmap` option is on: while the team deliberates, the Stage shows only a purple "🟣 1,204 dialled in" counter, and at the lock the fireflies **bloom** into the full heatmap. (A live heatmap lets the team simply copy chat's crowd average, which kills both the team's decision and the "Chat beat you!" moment.)
  - On resolve, the target is given with the bands `[{within:25,points:100},{within:75,points:60},{within:125,points:30}]`.
  - If the audience mean's band is higher than the team's band, the stage plays the "Chat beat you!" moment.
- **R11 End:**
  - Teams mode ends when a team reaches `scoreToWin` (8). If both teams reach it on the same turn, the higher score wins, then the team that scored last.
  - Teams mode is capped at 12 turns, after which the highest score wins (a tie at the cap plays one sudden-death turn per team).
  - Pacing math (why these defaults): a turn is ~10 s card pick + ≤ 45 s clue + ≤ 40 s guess + ≤ 13 s steal + 7.5 s reveal/score ≈ 75–115 s. At the old 10-point / 60 s / 45 s / 20-turn defaults a typical game ran ~20–25 min, far past the 10–15 min slot.
  - FFA mode ends after its cycles, ranked by score, with ties sharing the place.
- **R12** If the psychic disconnects, the bot gives the clue.

### Host options
| key | kind | default | range |
|---|---|---|---|
| mode | enum | auto | auto (teams if 4 or more players), teams, ffa |
| packs | pack spectrum multi | ["spectrum-core"] | |
| clueSec | seconds | 45 | 20–120 |
| guessSec | seconds | 40 | 20–90 |
| scoreToWin | int | 8 | 5–15 |
| steal | bool | true | |
| audiencePicksCard | bool | true | |
| liveHeatmap | bool | false | |
| cycles | int | 0 (auto) | 0–3 |

## State machine
```
intro → [turn]: card-pick → clue → guess → (steal)? → reveal(pace 5000) → turn-score(pace 2500) → next turn | final(pace 8000) → end
```

## Types
```ts
interface TiState {
  phase: "intro"|"card-pick"|"clue"|"guess"|"steal"|"reveal"|"turn-score"|"final";
  mode: "teams"|"ffa"; turn: number; deadline: number|null;
  psychic: PlayerId; activeTeam?: TeamId;
  cardChoices: [Card, Card]; card?: Card;          // Card = { id, left: string, right: string, examples?: string[] }
  clue?: string;
  hidden: { target: number; ffaDials: Record<PlayerId, { v: number; locked: boolean }> };  // each player sees only own ffa dial
  dial: number;                                  // team dial (teams) — public
  stealPicks: Record<PlayerId, "left"|"right">;
  last?: { target: number; dial: number; points: number; steal?: { side: "left"|"right"; ok: boolean }; audMean?: number; audBand?: number; ffa?: Record<PlayerId, number> };
  scores: Record<string, number>; catchUpUsed: boolean; turnsPerSeat: Record<PlayerId, number>;
}
type TiAction = { type: "pickCard"; idx: 0|1 } | { type: "clue"; text: string } | { type: "setDial"; v: number } | { type: "lock" } | { type: "steal"; side: "left"|"right" };
```

## Views
- **Target:** only the psychic's player view includes `target`, during `clue` and `guess`. The target becomes public at `reveal`.
- **FFA dials:** before the reveal, each player sees only their own dial. The stage sees only which players have locked.
- **Team dial:** live and visible to everyone, because it is part of the show.
- **Stage:** the card, the clue, the dial, the lock state and scores. The audience histogram arrives through `tally` messages.

## Audience hooks
- The card-pick `vote`, the result `predict` (R4a), the `dial` play-along with scoring, and the "Chat beat you!" moment.
- The audience's leaderboard points are credited by the platform.

### Audience job per phase (G14)
| Phase | Typical length | Audience job |
|---|---|---|
| card-pick | 10–13 s | card `vote` |
| clue | ≤ 48 s | result `predict` |
| guess | ≤ 43 s | `dial` |
| steal | ≤ 13 s | reactions (short phase) |
| reveal / turn-score | 7.5 s | reactions (short phase) |

Player idle exception (FFA with 2 players): none needed. Teams mode: the non-active team's idle stretch (clue + guess, up to ~88 s) is an **accepted exception** because they watch their opponents and then steal; in G14 it is measured against 100 s instead of 45 s.

## Visual & animation spec
- **Mat and dial:**
  - A felt mat. At its centre sits a vintage wooden radio: a half-disc dial face (a canvas texture of the card with its left and right labels in Fredoka, 40 px or more at 1080p), a brass needle, and two chunky knobs.
  - The needle follows the dial value with the `snappy` spring, sways slightly on changes, and plays the `tick` sound quantized per 50 units.
- **Target zones:** a colour-banded wedge (4/3/2 bands in success, warning and info tints) printed on a paper disc under a wooden shutter. At `reveal` the shutter slides aside (700 ms, `ease-inout`), then the band glows and the points chip pops.
- **Audience heatmap:**
  - Fireflies along the arc. Visually this is one ring mesh with a 50×1 `DataTexture`; bin intensity sets the brightness of the purple glow, lerped at 4 Hz.
  - On top of that there are at most 40 instanced firefly sprites, sampled by histogram weight.
  - The audience mean is shown as a small purple pin.
- **Clue:** handwritten (Caveat) on a paper tag hanging from the radio. It must be readable at 720p (36 px or more).
- **Steal:** two arrow placards, "◀ LEFT" and "RIGHT ▶", in the stealing team's colour, with vote chips.
- **Teams:** the score dials sit as two wooden pegboards at the sides of the radio (Tomato vs Sky).
- **Final:** confetti in the winning team's colour, and the radio plays the win chord with a speaker-cone wobble.
- **Controller:**
  - The psychic sees the target wedge (private) on a 2D SVG dial, plus the clue input.
  - Guessers get a large draggable semicircle dial across the full width (tap or drag), plus a Lock button.
  - Steal is two big buttons.
  - The audience dial uses the platform's generic `dial` UI, a semicircle slider.

## Scenarios
| id | roles | description | what the critic should see | anim |
|---|---|---|---|---|
| card-pick | stage, audience | Two cards shown, audience voting 55/45 | Both cards legible, purple vote bars | — |
| clue-writing | stage, player(psychic) | Psychic writing; phone shows the target wedge | Stage: "Psychic is thinking…"; phone: wedge plus input | — |
| clue-bet | stage, audience | Psychic writing, result bet 30/50/20 | "Psychic is thinking…", purple bet bars; audience predict UI | — |
| guessing | stage, player | Team dial at 612, hidden heatmap ("🟣 800 dialled in") | Readable clue tag, needle, counter chip | `needle` 800 ms |
| heatmap-bloom | stage | The lock moment with 800 simulated guesses | Fireflies bloom along the arc, purple mean pin | `bloom` 1200 ms |
| steal | stage, player | Other team picking a side | Placards and chips | — |
| reveal | stage | Shutter open, 3-point hit, audience beat the team | Bands, points chip, "Chat beat you!" | `reveal` 1400 ms |
| ffa-reveal | stage | 6 FFA dials revealed as coloured pins | Pins with glyphs, per-player points | `reveal` 1400 ms |
| final | stage | Team Sky wins 10–7 | Celebration, scores | `win` 2000 ms |

**Perf script:** `needle`, then `bloom`, then `reveal`, with the heatmap updating at 4 Hz for 5 s (the `liveHeatmap` path).

## Edge cases
- A dial value outside 0–1000 or not an integer is rejected by `parseAction`.
- A team with one member gets the audience dial (R6), and if there is no audience, the dial locks at 500.
- The clue filter must not reject common short words: only tokens of 3 or more characters are checked.
- Both cards come from the same pack: the pair is re-drawn so the two cards differ.
- A player joins mid-game: they sit out until the next turn boundary (as audience), and in teams mode they are auto-assigned to the smaller team.

## Test cases
- **T1** Band boundaries: 25 scores 4, 26 scores 3, 75 scores 3, 125 scores 2, 126 scores 0.
- **T2** The target is always within 50–950 (property test).
- **T3** The clue filter rejects "hot" for the card "Cold ↔ Hot", rejects "h0t2", and accepts "Sauna".
- **T4** Steal logic, including the dial-equals-target case.
- **T5** Catch-up triggers only when the team is still behind or tied, and only once in a row.
- **T6** Secrecy: the target is absent from every view except the psychic's before the reveal.
- **T7** FFA scoring: the psychic's score is the mean of the guessers' points.
- **T8** Audience-below-minimum card pick falls back to the psychic.
- **T9** The game ends at scoreToWin or at the turn cap.
- **T10** Bots complete 2–12 players in both modes.
- **T11** The result predict opens at `clue`, closes at `guess`, and resolves with the correct band (teams and FFA).
- **T12** With `liveHeatmap` off, the dial poll is opened with `hideLive: true`.
- **T13** `lock` is rejected before the dial has moved and before 5 s have passed.
- **Invariants:** the dial is always in 0–1000; scores never decrease. **Max steps:** 2,000.

## Content
Card: `{ id, left, right, examples: string[3] }`, for example `{ left: "Underrated", right: "Overrated" }`. The `spectrum-core` pack needs 200 or more cards, all original.

## Builder notes
