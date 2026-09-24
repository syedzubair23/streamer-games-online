# odd-one-out: Odd One Out

**Tier:** G5.
- **Players:** 4–10 (best at 5–8).
- **Session:** 3–4.5 min per round; a match is 3 rounds (10–14 min).
- **Audience:** knows the secret word (on phones only), bets on the imposter, and its bets feed the "sus meter".
- **Manifest:** `tickHz: 0`, `renderMode: "on-demand"`, `teamSupport: "none"`, `audience: { predict: true }`, `estMinutes: [10, 14]`.
- **No voice assumed.** Most stream players are viewers on phones, not in the streamer's voice call, so discussion happens through on-screen **pointing and quick-chat** (R5); voice is a bonus, never required.
- **howToPlay:** `["Everyone gets the secret word except the Odd One", "Give a one-word clue — not too obvious!", "Vote out the Odd One"]`

## Why it's in
- It fills the social-deduction slot, which produces the most memorable clips on stream.
- Every clue is shown on screen, which is what Jackbox advises for deduction games on stream, and nobody is eliminated.
- It gives about 70% of the fun of Among Us or Werewolf at about 10% of the cost.

## Rules
- **R1 Round setup:**
  - Pick a category and one of its 12 secrets. There are no repeats in the session.
  - Pick the odd ones: `oddCount` is 1, or 2 when there are 8 or more players and the option is `auto`. Odd ones don't know about each other.
  - Pick the clue order: a random start, then seat order.
- **R2 Role reveal:**
  - A regular player's phone shows the category and the secret.
  - An odd one's phone shows the category and "You are the Odd One 🎭".
  - In the Undercover variant, the odd one instead gets the paired *similar* word, with no label, and doesn't know they are odd.
  - The `reveal` phase lasts pace 6000, and every player must tap "Got it", or it auto-advances.
- **R3 Clues:**
  - There are `clueRounds` passes: `auto` (default) is 2 passes for 4–7 players and 1 pass for 8–10. In each pass, every player in order submits a one-word clue within `timing.input(clueSec*1000)` (20 s). (At the old 30 s × 2 passes, 10 players could take 10 minutes of clues alone.)
  - A clue is 1–20 characters with no whitespace after trimming; hyphens are allowed. It goes through `filterText`. A missing clue becomes "…" (a pass).
  - Clues are public at once and shown on the Stage.
- **R4 Saying the word:**
  - If a regular player's clue matches the secret or contains it (after normalization), the round ends immediately. Each odd one scores +2, and that player scores −1.
  - If an odd one's clue matches the secret, the round ends and the odd one scores +3.
  - In the Undercover variant, the odd one's own word does not count here.
- **R5 Discussion:**
  - Lasts `timing.input(discussSec*1000)` (45 s). Voice is optional.
  - **Pointing:** each player can `point` at one other player (changeable, or `null` to lower their hand). The Stage shows a small paw-point arrow from their plush to the target, and the phone shows who is pointing at you. Points are public and non-binding.
  - **Quick-chat:** each player can send one of 8 fixed lines, at most one per 4 s: "It's you! 👉", "Trust me", "Your clue was weird", "Too obvious…", "I'm not sure", "Vote with me", "Not me!", "Hmm 🤔". They appear as speech bubbles above the plush for 3 s. There is no free text, so there is nothing to moderate.
  - Players can tap "Ready to vote". Once every player is ready, the phase ends early (subject to the platform's minimum audience window, SPEC §4).
- **R6 Vote:**
  - Each player secretly votes for one other player within 20 s. Votes are revealed together.
  - The plurality player is **accused**.
  - If there is a tie, a revote among the tied players (15 s, the tied players can't vote for themselves) decides it. A second tie means **the odd ones win the round** (each odd one scores +3).
  - Missing votes don't count.
- **R7 Accused is an odd one:**
  - Classic variant: that odd one gets a **last guess**, picking the secret from the category's 12 options on their phone within 20 s.
    - A correct guess steals the round: each odd one scores +2 and regular players score 0.
    - A wrong guess: each regular player scores +2, and regular players who voted for an odd one score +1 more.
  - Undercover variant: there is no guess, and regular players score +2 each.
  - With 2 odd ones, only the accused odd one guesses, and a correct guess gives both odd ones +2.
- **R8 Accused is innocent:** each odd one scores +3, and the stage plays a "Wrong!" reveal of the real odd one(s).
- **R9 Match end:** after `rounds` rounds (3 by default), the ranking is by score, with ties sharing the place. Highlight: "Master of Disguise" goes to the most points earned as an odd one.
- **R10 Disconnects** (consistent with the platform's seat hold, SPEC §3):
  - A disconnected regular player's bot gives a clue from `category.clueBank[secret]` and votes randomly.
  - A disconnected odd one's bot gives a clue from `category.genericClues` (clues that fit the whole category, since the odd one does not know the secret) and votes randomly.
  - The round is **voided** (no score, next round starts) only if an odd one is still disconnected when the `vote` phase starts, because a bot-played odd one makes the deduction meaningless. Reconnecting before then keeps the round alive.
- **R11 Anti-sniping:**
  - The secret appears only in: regular players' views, the audience view (if `audienceSecret` is `phones`), and the host panel / moderator views **only when the host is not seated** (never the Stage window, SPEC §2).
  - The **stage view never contains the secret** until the round-end reveal.
  - The server strips the secret from the audience view **for any audience session whose IP hash matches a seated player's IP hash** (when `RoomConfig.antiSnipe` is on, the default). The platform does this by computing a second audience view with `ViewerKey {role:"audience", restricted:true}` (SPEC §9.3) and sending it to those sessions. Benched players (SPEC §3.4) are audience for this game and see the audience view normally.
  - Known limit, accepted: a determined player can still read the secret off the stream if they watch it from another network. The design relies on `audienceSecret: phones` making sniping pointless for fun; hosts of competitive rooms set it to `off`.

### Host options
| key | kind | default | range |
|---|---|---|---|
| packs | pack ooo-categories multi | ["ooo-core"] | |
| variant | enum | classic | classic, undercover |
| oddCount | enum | auto | auto, 1, 2 |
| rounds | int | 3 | 2–8 |
| clueRounds | enum | auto | auto, 1, 2, 3 |
| clueSec | seconds | 20 | 10–60 |
| discussSec | seconds | 45 | 20–180 |
| audienceSecret | enum | phones | phones, off |

## State machine
```
intro → [round]{deal → reveal → clues(pass p, player i)… → discuss → vote → (revote)? → accuse-reveal(pace 4000)
         → (last-guess)? → round-result(pace 6000)} ×rounds → final → end
```

## Types
```ts
interface OooState {
  phase: Phase; round: number; deadline: number|null; variant: "classic"|"undercover";
  category: { id: string; name: string; options: string[] /*12, public: shown on phones during last-guess & on stage after reveal*/ };
  order: PlayerId[]; turn: { pass: number; idx: number };
  clues: { by: PlayerId; text: string; pass: number }[];
  ready: PlayerId[];
  points: Record<PlayerId, PlayerId | null>;          // R5 pointing (public)
  chat: { by: PlayerId; line: 0|1|2|3|4|5|6|7; at: number }[];   // R5 quick-chat, last 12
  hidden: { secret: string; decoy?: string; odd: PlayerId[]; votes: Record<PlayerId, PlayerId>; guess?: string; used: string[] };
  revealedVotes?: Record<PlayerId, PlayerId>; accused?: PlayerId; tied?: PlayerId[];
  roundResult?: { secret: string; odd: PlayerId[]; outcome: "caught-wrong-guess"|"caught-stole"|"innocent-accused"|"tie-twice"|"said-word"|"odd-said-word"|"void"; points: Record<PlayerId, number> };
  scores: Record<PlayerId, number>; oddPoints: Record<PlayerId, number>;
}
type OooAction = { type: "gotIt" } | { type: "clue"; text: string } | { type: "ready" } | { type: "vote"; target: PlayerId } | { type: "guess"; option: string }
  | { type: "point"; target: PlayerId | null } | { type: "quick"; line: 0|1|2|3|4|5|6|7 };   // point/quick allowed in clues + discuss phases
```

## Views
| | stage | player (regular) | player (odd) | audience | audience (restricted) | host panel (host not seated) |
|---|---|---|---|---|---|---|
| secret | only in roundResult | ✔ | ✗ ("You are the Odd One"); in Undercover shows the decoy as if it were the secret | ✔ if `phones` | ✗ | ✔ |
| who is odd | only in roundResult | ✗ | only self | ✗ | ✗ | ✗ (even the host doesn't learn who is odd; this avoids a streamer tell) |
| votes | at reveal | own vote | own vote | at reveal | at reveal | at reveal |

## Audience hooks
- A `predict` poll ("Who's the Odd One?") over the players. It opens when the clues phase starts and closes when the vote phase starts, then resolves with the odd one (with 2 odd ones, it resolves with the accused odd one if there was one, otherwise the first odd one).
- The live tallies drive the **sus meter**: a small purple cloud above each plush, whose size is proportional to its tally share.

### Audience job per phase (G14)
| Phase | Typical length | Audience job |
|---|---|---|
| reveal | ≤ 6 s | reactions (short phase) |
| clues | 1–3 min | imposter `predict` (open) |
| discuss | ≤ 48 s | imposter `predict` (open) |
| vote / revote | ≤ 23 s | reactions + watching the sus meter freeze; the predict closed at vote start. Accepted: under 30 s |
| accuse-reveal / last-guess / round-result | ≤ 30 s | reactions (the payoff of the bet) |

Player idle exception: during the clue pass, a player waits for up to (N−1) × 20 s between their own clues; this is allowed because they can `point` and `quick`-chat throughout the clues phase, which counts as an input.

## Visual & animation spec
- **Set:**
  - A felt mat with a glowing lantern centrepiece (the "campfire": emissive plus a halo, flickering with a 3–7 s sine).
  - Player avatars are **plush animal figures** (fox, bear, bunny, frog, owl, cat, deer, hedgehog, duck, panda). Each is built from rounded primitives, with an identity-colour scarf and glyph badge. They sit in a circle around the lantern.
  - Pieces are instanced by shape: 10 animal variants share one merged geometry set with vertex colours, 2–3 draws in total.
- **Clues:**
  - Each clue rises from the lantern as a **paper lantern** carrying the word in Caveat or Nunito 800, 40 px or more at 1080p. It floats to a slot in a ring above that player's plush.
  - Pass 2 clues stack beneath the pass 1 clues.
  - The active clue-giver's plush does a little bounce and gets a spotlight halo, and the camera nudges toward them.
- **Vote reveal:** a slow spotlight sweep (1.8 s), then vote strings (thin coloured lines) draw from each voter to their target all at once. The accused plush hops to the centre.
- **Odd one reveal:** the odd plush pulls on a little mask (a scale-in mask mesh) and the 🎭 banner shows. If the guess steals the round, confetti fires in the odd one's colour; otherwise the regular players do a group `wobbly` cheer.
- **Round result:** a card showing the secret, which odd one it was, and the points.
- **Controller:**
  - A big secret card that can be revealed by tap-and-hold (hold to peek, so a phone visible on a streamer's webcam doesn't leak it).
  - The clue input when it's the player's turn.
  - During clues and discussion: a row of player plates to point at, and a 2×4 grid of quick-chat chips.
  - A vote grid of player plates.
  - The last-guess grid of 12 options.

## Scenarios
| id | roles | description | what the critic should see | anim |
|---|---|---|---|---|
| reveal-roles | stage, player(regular), player(odd), audience | Role reveal | Stage: plushes + "Check your phone"; phones: secret or odd card | — |
| clues | stage | Pass 2, 11 lanterns placed, player 4 giving a clue, sus clouds | Readable lantern words, active spotlight, purple clouds | `lantern` 1200 ms |
| discuss | stage, audience, player(regular) | Discussion, 3 of 6 ready, predict odds, 4 paw-points and 2 quick-chat bubbles | Ready chips, odds panel, readable point arrows and bubbles; phone: point row + quick-chat grid | `bubble` 600 ms |
| vote-reveal | stage | Vote strings to the accused | Strings, accused plush centre | `strings` 2000 ms |
| last-guess | stage, player(odd) | The odd one picking from 12 options | Stage: tension; phone: grid | — |
| odd-caught | stage | Wrong guess, regular players cheer | Mask on, cheer, result card | `mask` 1500 ms |
| odd-wins | stage | Innocent accused | "Wrong!" reveal, odd confetti | `mask` 1500 ms |
| final | stage | Match podium | Podium + Master of Disguise | `win` 2000 ms |

**Perf script:** `lantern` ×3, then `strings`, then `mask`.

## Edge cases
- 4 players with 1 odd one; the `auto` setting never picks 2 odd ones for fewer than 8 players.
- A regular player's clue is part of the secret: this does not end the round. R4 triggers only when the clue **equals or contains** the secret. For the secret "sunflower", the clue "sunflowers" triggers it and "sun" does not.
- An accused player is disconnected: the vote result stands. If an odd one was accused and disconnected, their bot makes a random guess.
- The host is seated: the host dock shows "You are playing — secrets hidden".
- A pack category with fewer than 12 secrets is rejected at pack validation.

## Test cases
- **T1** Odd-count selection is 1 for fewer than 8 players and 2 for 8 or more with `auto`.
- **T2** Every scoring outcome in R4–R8 (a table test).
- **T3** Tie, revote, then a second tie means the odd ones win.
- **T4** Clue validation: whitespace is rejected and hyphens are allowed.
- **T5** Secrecy fuzz across every view in the Views table, including the restricted audience and the host-seated case.
- **T6** The Undercover odd one sees the decoy as if it were the secret, and never sees the odd label.
- **T7** An odd one still disconnected at `vote` start voids the round; one who reconnects before then does not, and their bot's clues come from `genericClues`.
- **T10** `point` and `quick` are accepted only in clues/discuss, quick-chat is limited to one per 4 s per player, and lines outside 0–7 are rejected by `parseAction`.
- **T11** `clueRounds: auto` gives 2 passes for 4–7 players and 1 for 8–10.
- **T8** The predict poll resolves with the correct option.
- **T9** Bots complete 4–10 players in both variants.
- **Invariants:** `hidden.odd` is never empty during a round; there is exactly one clue per player per pass. **Max steps:** 1,000.

## Content
- The `ooo-core` pack needs 30 or more categories: `{ id, name, secrets: string[12], clueBank: Record<secret, string[3]>, genericClues: string[6] }`.
- The `ooo-pairs` pack needs 150 or more pairs for Undercover: `{ a, b, category }`, for example "cat / dog".
- Everything is rated all.

## Builder notes
