# 01 — Game Catalog: What to Build (and What Not To)

> Research output for the streamer party-games platform (browser, three.js + TypeScript, cozy lofi style, low-end-device target).
> User directive: **do not ship every game.** Ship only the games people are most likely to engage with, play, and enjoy on stream.
> Date: 2026-09-24.

---

## 0. TL;DR

**Launch Set (8):**

| # | Working name | Based on | Genre slot | Why it made the cut |
|---|---|---|---|---|
| 1 | **Ludo** | Ludo / Ludo King | Board (luck) | User named it. About 70M MAU, 1B+ downloads for Ludo King. Anyone can play, and big swings make good TV. |
| 2 | **Chess** (+ *Chat vs Streamer*) | chess.com / lichess / "Chess vs Chat" | Board (skill) | User named it. Chess is a proven Twitch category, and "chat votes the move" is a proven audience format. |
| 3 | **Doodle** (Guess mode + Telephone mode) | skribbl.io + Gartic Phone | Drawing | Gartic Phone peaks around 96k Twitch viewers. Drawing is the funniest content to watch on a stream. |
| 4 | **Quip Clash** | Quiplash | Writing / party | Jackbox's own pick for streaming. It's the best format for audience voting. |
| 5 | **Trivia Night** (Classic + Bluff mode) | Trivia Murder Party + Fibbage + Kahoot | Trivia | The most popular Jackbox genre. The audience can play along with its own leaderboard. |
| 6 | **Tune In** | Wavelength | Team / mass participation | You learn it in 10 seconds. Showing the audience's guesses as a histogram looks great, and it costs almost nothing to render. |
| 7 | **Odd One Out** | Spyfall / Chameleon / Undercover | Social deduction | Werewolf-style tension in 3–5 minute rounds, all deduced on screen, with nobody eliminated. |
| 8 | **Marble Rally** | Marbles on Stream | Physics / mass audience | Hundreds of chatters can take part at once (Marbles on Stream supports ~900). No skill needed and endlessly watchable. |

**Next Wave (6):** Mini Golf (simultaneous), Team Words (Codenames-like), Crazy Eights (Uno-like), Chat Wordle / Word Race, Duel Arcade (Connect 4 / RPS / Air Hockey brackets), Pin the Globe (GeoGuessr-lite).

**Cut (for now):** Among Us-likes, Werewolf/Mafia with elimination, Fall Guys-likes, Battleship, Pool, Bowling, Darts, Charades, Stream Raiders-style meta games. Reasons are in §5.

---

## 1. What the evidence says makes a streamer/party game work

1. **Phones as controllers plus a room code is the proven model.** Jackbox's growth on stream comes from viewers joining from their phones with a code. Since Party Pack 3, every Jackbox game has supported 8–16 players plus **up to 10,000 audience members** ([PlayStation Blog](https://blog.playstation.com/2015/06/30/quiplash-new-party-game-expands-audience-participation-to-10000/), [Jackbox Wiki](https://jackboxgames.fandom.com/wiki/The_Jackbox_Party_Pack_(series))). **Our platform has to be phone-first for players and audience. The three.js scene is the "TV" that the streamer shares.**
2. **What Jackbox itself says works on stream** ([Jackbox: best games for streaming](https://jackboxgames.com/here-are-the-best-jackbox-games-for-streaming)):
   - A soothing pace with **no quick-time events**, because stream delay breaks reflex play.
   - **Extended timers to cover lag.**
   - **Strong moderation.**
   - Deduction that happens **on screen**, not through silent private communication. Werewolf-style private whispering is weak on stream.
3. **The audience needs a real job, not just a like button.** Jackbox's audience mechanics fall into five kinds ([Jackbox blog](https://www.jackboxgames.com/blog/how-audience-play-along-differs-in-each-jackbox-game)):
   - voting on what players submit
   - playing along with their **own score and rank** (Fibbage 4)
   - **predicting** outcomes (Trivia Murder Party's Killing Room)
   - **affecting the environment** (Mad Verse City spam-to-destroy, Drawful Animate)
   - **deciding outcomes** (Roomerang's Audience Advantage eliminates a player)

   **We will build all five as a shared Audience Layer that every game plugs into (§4).**
4. **Mass-participation "chat games" hold large, steady audiences.**
   - Marbles on Stream: ~16.4M hours watched, ~2.6k average viewers, supports ~900 simultaneous chat players via `!play` ([Streams Charts](https://streamscharts.com/games/marbles-on-stream), [TwitchTracker](https://twitchtracker.com/games/509511)).
   - "Chess vs Chat" tools, where the most-voted move gets played, have been made again and again because the format works ([Chess vs Chat on Steam](https://store.steampowered.com/app/1888920/Chess_vs_Chat/), [TwitchLichessBot](https://github.com/xSplasher/TwitchLichessBot), [CHECKMATES](https://zerofiftyone.itch.io/checkmates)).
5. **Drawing games are the strongest browser-native party genre on Twitch.** Gartic Phone: ~4.8M hours watched this year, peak ~96k viewers. skribbl.io: ~462k hours, peak ~45k. Telephone chaos makes better TV, and guess-the-drawing is better for quick drop-ins ([Streams Charts: Gartic Phone](https://streamscharts.com/games/gartic-phone), [Streams Charts: skribbl.io](https://streamscharts.com/games/skribblio), [OnlineParty.Games comparison](https://onlineparty.games/compare/gartic-phone-vs-skribbl-io)). **Ship both modes in one game.**
6. **Board staples bring in huge casual audiences.** Ludo King has ~70M MAU and 1B+ downloads ([Wikipedia](https://en.wikipedia.org/wiki/Ludo_King), [Unity case study](https://unity.com/resources/ludoking)), and much of that audience are non-gamers.
7. **Modern tabletop party hits that "work with everyone":** Codenames (4M+ monthly players on the official web version), Wavelength ("best party game since Codenames"), and Just One (Spiel des Jahres 2019) ([codenames.game](https://codenames.game/), [Wavelength – Wikipedia](https://en.wikipedia.org/wiki/Wavelength_(game)), [Just One – Wikipedia](https://en.wikipedia.org/wiki/Just_One_(board_game))).
8. **Guessing and trivia do well with big streamers.**
   - GeoGuessr: ~11M hours watched this year, peaks of 200k+, driven by streamer events ([Streams Charts](https://streamscharts.com/games/geoguessr), [Stream Hatchet](https://streamhatchet.com/blog/the-rise-of-geoguessr-on-live-streaming/)).
   - Golf With Your Friends: ~3.4M hours, peak ~43k, streamed much more on weekends when groups get together ([SullyGnome](https://sullygnome.com/game/golf_with_your_friends)).

### Design rules that follow from this
- **Delay-tolerant by default.** Every timed input window is at least 10s, plus a host-set "stream delay" padding of 0–8s. Nothing is reflex-based on the audience side.
- **Learn it in 30 seconds.** Each game has one animated "how to play" card of three steps or fewer, shown during the lobby countdown.
- **Rounds of 1–5 minutes, sessions of 10–25 minutes.** Viewers come and go, and the host should be able to switch games often.
- **No dead players.** Eliminated or waiting players join the audience role, keeping points and votes, so nobody sits idle.
- **Everything shows on the TV scene.** Phones hold private info and inputs. The drama is always visible on the shared screen.

---

## 2. Scoring matrix

Each criterion is scored 1–5 (5 = best). **Low compute** and **Impl. cost** are scored so that 5 means cheap. Weighted total (max 75) uses these weights:

| Criterion | Weight |
|---|---|
| Engagement / replayability | 3 |
| Watchability on stream | 3 |
| Audience participation | 3 |
| Learn in 30s | 2 |
| Round length | 1 |
| Player range | 1 |
| Low compute | 1 |
| Impl. cost | 1 |

| Candidate | Engage | Watch | Audience | Learn | Round | Players | Compute | Cost | **Weighted** | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|
| Doodle (skribbl + Gartic) | 5 | 5 | 4 | 5 | 5 | 5 | 5 | 4 | **71** | LAUNCH |
| Quip Clash (Quiplash) | 5 | 5 | 5 | 5 | 5 | 5 | 5 | 4 | **74** | LAUNCH |
| Trivia Night (TMP/Fibbage/Kahoot) | 5 | 4 | 5 | 5 | 5 | 5 | 5 | 3 | **70** | LAUNCH (content cost) |
| Tune In (Wavelength) | 4 | 4 | 5 | 5 | 5 | 5 | 5 | 5 | **69** | LAUNCH |
| Marble Rally (Marbles on Stream) | 4 | 5 | 5 | 5 | 5 | 5 | 3 | 3 | **68** | LAUNCH |
| Odd One Out (Spyfall/Chameleon) | 5 | 4 | 3 | 4 | 5 | 4 | 5 | 5 | **63** | LAUNCH |
| Chess + Chat vs Streamer | 4 | 4 | 4 | 3 | 3 | 2 | 5 | 4 | **56** | LAUNCH (user-named) |
| Ludo | 3 | 4 | 3 | 5 | 2 | 3 | 5 | 4 | **54** | LAUNCH (user-named) |
| Team Words (Codenames) | 5 | 4 | 4 | 4 | 4 | 5 | 5 | 5 | **66** | NEXT WAVE (see note) |
| Chat Wordle / Word Race | 4 | 3 | 5 | 5 | 5 | 5 | 5 | 5 | **66** | NEXT WAVE |
| Mini Golf (simultaneous) | 5 | 5 | 3 | 5 | 4 | 4 | 3 | 2 | **62** | NEXT WAVE |
| Pin the Globe (GeoGuessr-lite) | 4 | 4 | 5 | 5 | 5 | 5 | 4 | 3 | **66** | NEXT WAVE (content cost) |
| Crazy Eights (Uno-like) | 4 | 3 | 3 | 5 | 4 | 4 | 5 | 4 | **57** | NEXT WAVE |
| Duel Arcade (C4 / RPS / Air Hockey) | 3 | 4 | 4 | 5 | 5 | 2 | 4 | 4 | **58** | NEXT WAVE |
| Werewolf/Mafia (classic) | 4 | 3 | 3 | 3 | 1 | 4 | 5 | 4 | 50 | Cut (replaced by Odd One Out) |
| Among Us-like | 5 | 5 | 2 | 3 | 2 | 4 | 2 | 1 | 51 | Cut (real-time + voice + scope) |
| Fall Guys-like | 4 | 5 | 2 | 5 | 4 | 4 | 1 | 1 | 53 | Cut (netcode/compute) |
| Pool / Billiards | 3 | 3 | 2 | 4 | 2 | 2 | 3 | 2 | 41 | Cut |
| Bowling / Darts | 2 | 3 | 2 | 5 | 3 | 3 | 4 | 3 | 44 | Cut (possible "Pub Night" mode later) |
| Battleship | 2 | 2 | 2 | 5 | 2 | 1 | 5 | 5 | 41 | Cut |
| Charades | 3 | 3 | 2 | 5 | 4 | 4 | 5 | 5 | 52 | Cut (needs webcams) |

**Note on Team Words vs Odd One Out.** Codenames scores slightly higher on paper. I still put Odd One Out in the launch set for two reasons:
1. The set needs a **social deduction** slot, and that genre drives the most memorable "clip moments" on stream.
2. Tune In already covers the "team clue-giving" feel.

Team Words is the first game to add after launch.

**Note on Ludo and Chess.** They score lowest among the launch games because rounds are long and they suit 2–4 players. They're in because the user asked for them, and because §3 redesigns them to fit streaming: speed variants, team play, and audience hooks.

---

## 3. Launch Set: detailed specs

Visual baseline for every game: **one cozy diorama.** Each game is a small tabletop scene placed on a wooden desk by a big window in a lofi room, with plants, a mug with steam, and fairy lights. The ambient mode (Day / Dusk / Night / Rain) changes:
- the light coming through the window
- the color grade
- the rain streaks on the glass
- the lamp glow

It changes nothing about how games play.

Rendering approach:
- Low-poly, soft rounded forms, pastel palette.
- Baked AO or lightmaps plus one directional light and cheap fake soft shadows (blob or contact shadow texture).
- MeshToon or matcap materials.
- Target <50k triangles and <60 draw calls per scene. Pieces use instancing.

### 3.1 Ludo — "Garden Ludo"
- **Players:** 2–4 seats. **Teams mode:** 2v2, partners opposite, and each partner may move the other's tokens once their own are home. **Audience:** unlimited.
- **Round length:** classic is 20–40 min, which is too long, so **"Quick Ludo" is the stream default** at 8–12 min:
  - 2 tokens per player instead of 4
  - a token leaves base on a 5 or a 6
  - optional 60s turn timer (auto-move after 15s idle)
- **Core loop:** roll, pick a token (phone shows only legal moves, highlighted), move, capture or reach safety, and a 6 gives an extra roll.
- **Audience hooks:**
  - **Blessing Dice.** Once per round the audience votes on which player gets a "blessed die" re-roll.
  - **Predictions.** "Who reaches home first?" with points for correct audience picks.
  - **Capture hype meter.** Audience taps fill a meter that triggers a confetti or petal burst plus a sting sound on the next capture. This is cosmetic only.
- **Customization:**
  - tokens per player (1–4)
  - exit numbers (6 only, or 5/6)
  - triple-six penalty on/off
  - safe squares on/off
  - capture sends home vs sends back N squares
  - must-capture rule
  - exact roll to finish on/off
  - turn timer
  - power-up squares (swap, shield, double) for a "chaos" preset
- **Visual concept:** the board is a small garden plot. Tokens are felt garden gnomes or mushrooms in four pastel colors. Tokens hop along the path with a squash-and-stretch arc, and a captured token gets gently "poofed" back to its planter base with a dandelion puff. The die is a big chunky wooden die with a physics-looking tumble that is **pre-baked**: we pick one of about 12 tumble animations that ends on the server-chosen face, so no physics engine is needed.
- **Rules edge cases:**
  - Three sixes in a row voids the turn (configurable).
  - Blockades (two tokens of the same color on one square) block others or not, per config.
  - Capturing on safe or start squares is not allowed.
  - Exact roll to enter home. With no legal move, auto-pass after an animated shrug.
  - A disconnected player gets a bot that auto-moves; rejoining takes the seat back.
  - In teams mode a win needs both partners home.
  - **RNG is always server-side**, never client-side, so the result can be trusted on stream.

### 3.2 Chess — "Tea-House Chess"
- **Players:** 2, or **Chat vs Streamer**, or **Team vs Team**, where each side is a group that votes on moves. **Audience:** unlimited.
- **Round length:**
  - default 5+3 blitz, ~10 min
  - 3+2 and 10+0 presets
  - vote-mode game: ~20–30 min, 20–30s per move vote
- **Core loop:** select a piece, see legal moves highlighted, make the move, clock switches.
- **Audience hooks:**
  - **Chat vs Streamer.** Audience members propose moves on their phones. The top 3 proposals become a vote, and the plurality move is played. Chess vs Chat and CHECKMATES show this works.
  - **"Guess the move."** During normal play the audience predicts the player's next move and earns points for correct picks.
  - **Live eval bar**, an optional low-compute Stockfish WASM on the **host** only and off by default. It creates drama without spoiling moves.
  - Reactions: gasp or clap emotes that float up over the board.
- **Team mode:** Team vs Team vote chess, or **consultation chess** (2–3 players per side who discuss and one captain submits). Plain 2v2 bughouse is too hard to follow on stream, so it's not a default.
- **Customization:**
  - time controls and increment
  - Chess960 (Fischer random)
  - handicap (streamer plays without a queen/rook)
  - takebacks on/off
  - move-vote timer
  - premoves on/off
  - "hide eval" toggle
- **Visual concept:** a teahouse table. The pieces are soft ceramic with a matte glaze, cream vs sage green, next to a steaming teapot. Moves slide with a soft ease and a tiny "clack" puff. Captured pieces sit on a small wooden tray. The chess clock is a flip-dial wooden clock.
- **Rules edge cases:**
  - Full FIDE rules: castling rights, en passant, promotion picker (auto-queen toggle), threefold repetition, the 50-move rule, stalemate, insufficient material, and timeout vs insufficient material counting as a draw.
  - Use a proven library for rules and validation (e.g., `chess.js`) on the server.
  - Vote chess ties are broken by earliest-reaching-plurality or by random choice. If nobody votes, a random legal move is played or the lowest-eval blunder guard kicks in (configurable).
  - Anti-griefing in vote mode: a trolling minority can't override the plurality.

### 3.3 Doodle — draw & guess + telephone
- **Players:**
  - Guess mode: 3–16 players. The audience can guess too, on its own leaderboard.
  - Telephone mode: 4–14 players. The audience votes favorites during the reveal.
- **Round length:**
  - Guess: 60–80s per drawing, one full rotation of 8–12 min.
  - Telephone: 10–15 min including the reveal, which is the highlight.
- **Core loops:**
  - *Guess:* the drawer picks from 3 words, draws on the phone or desktop canvas, and others type guesses. Points depend on how fast you guess, and the drawer scores when people guess. Letter hints reveal over time.
  - *Telephone:* everyone writes a prompt, then drawings and descriptions alternate down the chain. At the end, each chain replays one step at a time on the TV.
- **Audience hooks:**
  - Audience guesses in Guess mode, with a separate leaderboard. The top audience guesser is shown each round.
  - Audience "best drawing" vote, with a gallery at the end.
  - **Audience word pick.** The audience votes on which of the three words the drawer has to draw, which is great for chaos.
  - Telephone reveal gets live reactions (laugh-o-meter).
- **Team mode:** "Team Doodle" Pictionary-style. Teams alternate, one drawer and the rest of the team guesses, and the other team can steal after 30s.
- **Customization:**
  - word packs (default, kids, gaming, custom list pasted by host)
  - draw time
  - rounds
  - hints on/off
  - brush palette (limited palette looks nicer and is cheaper)
  - Telephone variants: *animation* (each player adds a frame), *speedrun* (half time), *secret* (you can't see the full previous step, only a peek)
- **Visual concept:**
  - The TV shows a sketchbook on an easel in the cozy room. The drawing streams in as **vector strokes** (point arrays, simplified with Ramer-Douglas-Peucker and sent in small batches), which gets a "live pencil" feel with tiny bandwidth.
  - Strokes render into a 2D canvas used as a `CanvasTexture` on the paper mesh, so three.js cost is basically one textured plane.
  - The Telephone reveal flips pages with a soft paper-curl vertex shader.
- **Rules edge cases:**
  - Drawers writing letters or numbers: add a vote-kick-drawing and a "report" option.
  - Close guesses ("you're close!") use Levenshtein distance ≤1, done server-side.
  - Guesses containing the answer are hidden from chat.
  - If the drawer disconnects mid-turn, the turn is skipped and points are prorated.
  - Guessers who already got it can't leak the answer: their chat is limited to other correct guessers.
  - Telephone with an odd player count or disconnects: chain routing is precomputed and a dropped player's step is auto-filled ("They fell asleep") or skipped.
  - **Moderation:** word filter on guesses and prompts, streamer "hide drawing" and "skip" buttons, an optional audience-drawing blur until the host approves, and the **drawing gallery is off by default for audience-submitted content.**

### 3.4 Quip Clash — prompt & vote comedy
- **Players:** 3–8 players, 10,000+ audience voters (design target: thousands).
- **Round length:** 3 rounds, ~12–15 min. Each matchup vote is 15–20s.
- **Core loop:**
  - Each player gets 2 prompts (e.g., "The worst thing to hear from your dentist: ___").
  - Each prompt goes to exactly 2 players.
  - The answers go head to head on the TV, and players plus the audience vote.
  - Points depend on vote share, with a bonus for a unanimous "QUIP-OUT."
  - The final round is one prompt for everyone, and you spread 3 votes around.
- **Audience hooks:**
  - **The audience vote counts as a weighted bloc**, e.g., audience share × 30% of points, so a huge chat can't completely swamp the players.
  - "Audience favorite" award.
  - Audience-written prompts (host-approved queue), which viewers love.
- **Team mode:** pairs write together (either teammate submits, both see a draft), 2v2v2v2.
- **Customization:**
  - prompt packs (family-friendly default, spicy opt-in, custom)
  - answer timer (default 90s, extended for stream delay)
  - audience weight %
  - rounds
  - "Safety quip" button that auto-fills a pack answer if a player is stuck
- **Visual concept:** two speech-bubble cards pop up on little wooden stands at a cozy open-mic café. Votes fall as paper hearts into the winning side's jar. The winning answer card gets a tiny spotlight and the crowd silhouettes sway.
- **Rules edge cases:**
  - Blank answer: automatic loss plus a gentle roast line.
  - Identical answers ("jinx") split points.
  - Players can't vote on their own matchup.
  - The audience vote only counts when the audience count is ≥ N.
  - With an odd number of players, prompt assignment rotates so everyone gets 2.
  - **Moderation is critical:** profanity filter levels, hosts can censor an answer before reveal (blurred), kick/ban per room, and a family mode that also filters player names.

### 3.5 Trivia Night — classic quiz + bluff mode
- **Players:** 1–10 players on the main leaderboard, plus **the audience as full players with its own ranked leaderboard** (the Fibbage 4 / Kahoot model).
- **Round length:** 10–12 questions at 15–20s each, ~10 min per game. Bluff mode is ~12–15 min.
- **Core loops:**
  - *Classic:* the question shows on the TV, you answer multiple choice on your phone, faster answers score more, and there's a streak bonus. Every 4 questions comes a **"Showdown"**: the bottom players face a sudden-death mini-challenge (a tip of the hat to Trivia Murder Party's Killing Room, restyled cozy as "The Kettle": lose and you're "steamed" into ghost mode, and ghosts can still earn a comeback).
  - *Bluff (Fibbage-style):* a fill-in-the-blank obscure fact. Everyone writes a believable lie, then everyone picks the true answer from the lies plus the truth. You score for finding the truth and for fooling others.
- **Audience hooks:**
  - Audience answers every question.
  - Audience **predicts who wins the Showdown**.
  - The audience can "throw a lifeline" once per game: 50/50 for the player it votes for.
  - Final audience rank shown at the end.
- **Team mode:** team captains lock in the answer or the team majority vote wins, for classroom or community events.
- **Customization:**
  - category packs (general, gaming, movies, geography, custom CSV/JSON import)
  - difficulty curve
  - question timer
  - speed scoring on/off (off helps players with stream delay or high ping)
  - Showdown on/off
  - number of questions
- **Visual concept:** a quiz show held in a cozy library nook. Question cards are index cards flipped by a paper animation, answer tiles are four colored books sliding out of a shelf, and the timer is a candle burning down. In Rain mode, thunder rumbles when the timer is almost out.
- **Rules edge cases:**
  - Speed scoring must use **server-received time adjusted for the question-display time on that client**, or just use flat scoring when the host enables "stream-delay fairness."
  - Ties are broken by total answer time, then by sudden death.
  - Bluff mode: lies equal (case- or space-insensitive, fuzzy) to the truth are rejected with "too close to the truth, try another," and duplicate lies are merged.
  - Content QA: every question needs a source and a date-validity flag.
- **Content cost warning:** this game lives or dies on its question bank. Plan for 3–5k curated questions at launch, plus community packs.

### 3.6 Tune In — Wavelength-style dial
- **Players:** 2–12 in 2 teams (or free-for-all). **The audience places its own dial**, the best mass-participation visual in the set.
- **Round length:** ~45–60s per clue, a game to 10 points in ~10–15 min.
- **Core loop:**
  - A spectrum card appears (e.g., HOT ↔ COLD, UNDERRATED ↔ OVERRATED).
  - The psychic secretly sees the target zone and gives a one-line clue ("Pineapple on pizza").
  - The team drags a dial to where they think the target is.
  - The opposing team guesses LEFT or RIGHT of the dial for a steal point.
  - The dial reveals and points land 4/3/2.
- **Audience hooks:**
  - **The audience's answers show as a live histogram or heatmap arc** over the dial (thousands of taps give one smooth curve). The audience gets its own score.
  - An "Audience beat the team" moment.
  - The audience can pick which of 2 spectrum cards the psychic gets.
- **Team mode:** native (red vs blue). FFA variant: everyone places their own dial and scores by closeness.
- **Customization:**
  - spectrum card packs plus custom cards
  - clue timer
  - score to win
  - steal on/off
  - "no numbers or synonyms" clue filter strictness
  - psychic rotation
- **Visual concept:** a vintage radio dial on the desk that you "tune." The needle has a spring-damped sway, and the target reveal slides back a wooden shutter showing a color-banded arc. Audience guesses glow as soft fireflies along the arc and fade into a gradient.
- **Rules edge cases:**
  - Clues that are numbers or direct words from the card are flagged (auto-check plus the other team can challenge).
  - A dial exactly on a zone boundary takes the higher score.
  - With only one team member, the psychic gives the clue and the audience acts as the guessing "team."
  - Catch-up rule (from Wavelength): a team gets an extra turn if it scores exactly 4 while behind.

### 3.7 Odd One Out — Spyfall / Chameleon-style deduction
- **Players:** 4–10 (best at 5–8). **Audience** knows the secret (dramatic irony, the thing that makes deduction fun to watch) and bets on who the imposter is.
- **Round length:** 3–5 min per round. A match is 3–5 rounds.
- **Core loop:**
  - Everyone gets the secret word or location on their phone except the Odd One (they see "You are the Odd One" plus the category).
  - Each player takes one turn giving a **one-word association on screen** (shown on the TV, so the deduction is visible, per Jackbox's streaming advice).
  - Discuss (voice optional, text on screen), then everyone votes.
  - If the Odd One is caught, they get one guess at the secret word to steal the win.
- **Audience hooks:**
  - **Audience sees the secret** (streamer can toggle this so they don't see it themselves; see edge cases).
  - Audience bets on suspects with "prediction points."
  - Audience "sus meter" on each player, shown as a small cloud over their avatar.
  - Optional "audience hint": if the audience majority is right, one player gets a nudge.
- **Team mode:** 2 imposters in games with 8+ players (they don't know each other in "chaos" mode). Or the Undercover variant: 2 sides with similar words (cat vs dog) and nobody knows which side they're on.
- **Customization:**
  - category packs
  - number of odd ones
  - clue rounds (1–3)
  - discussion timer
  - "Undercover" variant (similar word vs no word)
  - voice vs text-only mode
  - whether the audience sees the secret
- **Visual concept:** a cozy campfire at night. Player avatars are small plush animals on logs, and clue words float up from the fire as glowing paper lanterns. The vote reveal is a dramatic slow spotlight sweep, and the Odd One's plush pulls on a little mask.
- **Rules edge cases:**
  - **Streamer as a player + audience sees the secret = stream sniping.** Default: the audience view of the secret is **only shown on phones, never on the TV scene**, and it's hidden from the host's own device when the host is playing. Warn the streamer to use a delay.
  - Clue equals the secret word: automatic loss for that player.
  - Vote ties: revote between the tied players, and a second tie means the Odd One wins.
  - Disconnect of the Odd One ends the round with no score.

### 3.8 Marble Rally — mass-audience physics race
- **Players:** the whole audience. Each viewer drops one marble (target 200–500 on screen, overflow joins as "ghost fans" who bet). The streamer and players can be "featured marbles."
- **Round length:** 60–120s per race, plus a 30s join window. Tournament: 5 races with cumulative points.
- **Core loop:**
  - The host picks a track and the join window opens. Viewers join from phone or `!play` in chat (optional Twitch/YouTube chat bridge later).
  - The race runs. Marbles bump and funnel, and there are elimination gates.
  - Podium and leaderboard.
- **Audience hooks:** this game *is* the audience hook.
  - Customizable marble skin (earned or unlocked colors, hats).
  - **Bets** on the featured marbles.
  - **One "Nudge" per race per viewer**: a tiny impulse during a 3s window at fixed checkpoints (delay-safe, adds dexterity and agency).
  - Streamer "chaos buttons": wind gust, fan, trapdoor.
- **Team mode:** team colors (e.g., stream team vs chat, or 4 house colors), scored as the team's best 5 finishers.
- **Customization:**
  - track selection and rotation
  - marble count cap (auto-scaled by device tier)
  - elimination gates
  - chaos buttons
  - race length
  - point tables
  - skin rules
- **Visual concept:** a handmade wooden and cardboard marble run on the desk: paper-cup loops, pencil ramps, book-stack drops, and a toy train crossing. Marbles are glossy glass spheres drawn with **one `InstancedMesh`** and a fake glass matcap. The camera follows the leader, with slow-mo at the finish line and a "camera cut" to the featured marble.
- **Compute plan (important):**
  - Physics is **server-authoritative and deterministic** (a fixed-step custom sphere-vs-static-triangle solver, or Rapier compiled to WASM on the server).
  - The server sends **compressed position snapshots at 10–15 Hz** for the top N marbles, and clients interpolate.
  - Low-tier devices render ≤150 marbles and turn the rest into distant particles.
  - Alternative: send the seed plus inputs and have clients re-simulate. Cheaper on bandwidth but risky across floating-point differences between devices, so it's not recommended.
- **Rules edge cases:**
  - Stuck marbles: a "boost after N seconds without progress" rule, then disqualify.
  - Ties are decided by frame-exact finish order.
  - Joins after the window closes are queued for the next race.
  - Anti-bot: one marble per authenticated viewer or device fingerprint, and a rate limit.

---

## 4. Cross-game systems these games require

Build these once as platform features, not inside each game:

1. **Audience Layer SDK.** Each game exposes hooks for:
   - `vote(options)`
   - `predict(question, options)`
   - `playAlong(question) → own leaderboard`
   - `influence(action, cooldown)` (cosmetic or bounded)
   - `react(emoji)`

   The platform shows these on the audience phone UI and on a TV overlay strip. Aggregate votes server-side and send sums, never per-user events, to the TV.
2. **Stream-delay compensation.** A host setting (0–8s) that pads every audience window. The TV scene shows a "votes closing" state instead of a hard cut.
3. **Moderation suite.**
   - Profanity filter levels, applied to names, answers, guesses and prompts.
   - Host review-before-reveal.
   - Kick/ban.
   - Family mode.
   - Streamer mode that hides room codes, or shows a QR plus a refreshable code.
4. **Content packs.** A JSON schema shared by word lists, prompts, questions and spectrum cards, supporting host custom packs, pack ratings and language tags.
5. **Idle-proof flow.** Disconnected players are replaced by a bot, eliminated players move to the audience, and late joiners enter the audience first and take a seat next round.
6. **Session playlist.** The host queues games ("Quip Clash → Doodle → Marble Rally") with cumulative "Night Champion" scoring across games, which ties the session together.

---

## 5. Next Wave (post-launch, in order)

| # | Game | Based on | Why it's next | Why it's not in the launch set |
|---|---|---|---|---|
| 1 | **Team Words** | Codenames | Best team word game there is, and its official web version has 4M+ monthly players. Chat can act as the "field agents" team. | Overlaps with Tune In. Launch set already has enough word games. |
| 2 | **Pin the Globe** | GeoGuessr | Huge stream numbers (200k+ peaks). Audience pins make a beautiful heatmap. | Street View imagery can't be used cheaply or legally. Needs our own stylized "postcard" or photo-clue content plus a globe view. |
| 3 | **Mini Golf (simultaneous)** | Golf With Your Friends | Great TV, ~3.4M hours watched, and a weekend-group favorite. | Physics, level design and deterministic replays are expensive. Everyone plays at once as ghosts to avoid turn waits. |
| 4 | **Chat Wordle / Word Race** | Wordle / typing races / Bananagrams | Everyone in the audience plays the same puzzle, and the host plays against the crowd. Very cheap to build. | Lower watchability. Works best as a "between games" filler. |
| 5 | **Crazy Eights** | Uno (generic, no trademark) | Universally known, and rule customization (stacking, jump-in, 7-0) is exactly what hosts love. | 2–8 players only. Audience role is weak (predictions, "bless a card"). |
| 6 | **Duel Arcade** | Connect 4, Rock-Paper-Scissors, Air Hockey | **Bracket tournaments** with audience predictions for each match. RPS tournaments scale to hundreds of entrants. | 1v1 games. Their value comes from the bracket system, not from any single game. |

**Honorable mentions:** Just One (co-op clue game, could be a Tune In mode), Fibbage-standalone (already a Trivia mode), Mafia with "no-elimination" scoring, and a "Pub Night" bundle (darts / bowling / shuffleboard) as cheap flicked-physics mini-games.

### Why the rest were cut
- **Among Us-likes:** real-time movement netcode, voice-chat dependence, long rounds, and a huge scope. Odd One Out gets about 70% of the fun for about 10% of the cost.
- **Werewolf/Mafia (classic):** needs a moderator, has night/day pacing, and elimination leaves players idle for 10+ minutes. Its private deduction is weak on stream.
- **Fall Guys-likes:** 3D real-time physics with many players breaks the low-end-device and low-compute constraints, and stream delay makes audience involvement impossible.
- **Pool / Bowling / Darts:** turn-taking with long idle waits and precise physics. Fine as cheap "Pub Night" filler later, not as tentpoles.
- **Battleship:** slow, hidden information, low watchability.
- **Charades:** needs webcams. Doodle covers the same "act it out" urge.
- **Stream Raiders / Twitch Plays-style persistent games:** long-term economies are a different product. Marble Rally plus Chess vs Chat cover "chat controls the game."
- **Kahoot:** absorbed into Trivia Night.

---

## 6. Build order and effort estimate (relative)

| Order | Game | Relative effort | Main risk |
|---|---|---|---|
| 1 | Quip Clash | S | Moderation, prompt content |
| 2 | Tune In | S | Spectrum card content |
| 3 | Trivia Night | M | Question bank size and quality |
| 4 | Doodle | M | Stroke sync, moderation of drawings |
| 5 | Odd One Out | S | Stream sniping, word packs |
| 6 | Ludo | M | Pacing, bot AI (simple heuristics suffice) |
| 7 | Chess | M | Rules library, vote mode UX, clocks |
| 8 | Marble Rally | L | Server physics, instanced rendering at scale, anti-bot |

Recommendation: build 1–3 first. They share almost everything: prompt→submit→reveal→vote, which is the exact spine the Audience Layer needs. That shared phase machine then powers the rest.

**Legal note:** game mechanics generally aren't protected by copyright, but names, trade dress, card text and art are. Use original names (Quip Clash, Tune In, Odd One Out, Team Words, Crazy Eights) and original prompt, question and spectrum content. Never copy Jackbox prompts or Codenames or Wavelength card text.

---

## Sources
- Jackbox — Best games for streaming: https://jackboxgames.com/here-are-the-best-jackbox-games-for-streaming
- Jackbox — How audience play-along differs per game: https://www.jackboxgames.com/blog/how-audience-play-along-differs-in-each-jackbox-game
- PlayStation Blog — Quiplash 10,000 audience: https://blog.playstation.com/2015/06/30/quiplash-new-party-game-expands-audience-participation-to-10000/
- Jackbox Wiki — Party Pack series: https://jackboxgames.fandom.com/wiki/The_Jackbox_Party_Pack_(series)
- Trivia Murder Party (Jackbox): https://www.jackboxgames.com/games/trivia-murder-party
- Streams Charts — Gartic Phone: https://streamscharts.com/games/gartic-phone
- Streams Charts — skribbl.io: https://streamscharts.com/games/skribblio
- OnlineParty.Games — Gartic Phone vs skribbl.io: https://onlineparty.games/compare/gartic-phone-vs-skribbl-io
- Streams Charts — Marbles on Stream: https://streamscharts.com/games/marbles-on-stream
- TwitchTracker — Marbles on Stream: https://twitchtracker.com/games/509511
- Wikipedia — Ludo King: https://en.wikipedia.org/wiki/Ludo_King
- Unity — Ludo King case study: https://unity.com/resources/ludoking
- Chess vs Chat (Steam): https://store.steampowered.com/app/1888920/Chess_vs_Chat/
- TwitchLichessBot: https://github.com/xSplasher/TwitchLichessBot
- CHECKMATES (itch.io): https://zerofiftyone.itch.io/checkmates
- Codenames Online: https://codenames.game/
- Wikipedia — Wavelength: https://en.wikipedia.org/wiki/Wavelength_(game)
- Wikipedia — Just One: https://en.wikipedia.org/wiki/Just_One_(board_game)
- Streams Charts — GeoGuessr: https://streamscharts.com/games/geoguessr
- Stream Hatchet — GeoGuessr on live streaming: https://streamhatchet.com/blog/the-rise-of-geoguessr-on-live-streaming/
- SullyGnome — Golf With Your Friends: https://sullygnome.com/game/golf_with_your_friends
