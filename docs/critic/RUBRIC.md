# Visual QA Rubric

> Copy of `docs/DOD.md` §4 (the authoritative source). `tools/harness/test/critic-kit.test.ts` fails if this
> copy drifts from DOD.md. Change the rubric in DOD.md first, then here, then re-run
> `pnpm critic:calibrate` (ROADMAP M0-06). Never weaken an item, anchor or threshold to get a green result.

### 4.1 Anchors

| Score | Meaning |
|---|---|
| **10** | The reference board's level with nothing left to point to. |
| **9.5** | The reference board's level (`docs/references/_style/`): shipped top-tier cozy-indie craft (Tiny Glade, A Short Hike, Alba) that could sit on the board unnoticed. |
| **9** | The reference board's level, with minor flaws you can point to. Frames of the board's calibre score 9–10. |
| **8.5** | A player would screenshot it, and a streamer would feature it, but next to the board it visibly falls short. |
| **7** | A decent web game. |
| **5** | A working prototype: it runs and its state can be read, but it is engine defaults (grey default materials, browser fonts and controls, primary colours) with no art direction. This band is 4–6. |
| **3** | Broken or placeholder: rendering faults, blank or missing content, error text, or a state that cannot be read. |

Do not round up. When unsure between two bands, choose the lower one.

How to apply the anchors (calibrated in ROADMAP M0-06; `pnpm critic:calibrate` re-checks them). Score every item in two steps:
1. **Band.** Compare the item's craft with the reference board and choose its band: *reference level* (9.0–10, anchor 9.5: it would not look out of place on the board), *screenshot-worthy but visibly below the board* (8.0–8.9, anchor 8.5), *decent web game* (6.5–7.9, anchor 7), *working prototype* (4.0–6.4, anchor 5) or *broken* (below 4, anchor 3). An item leaves the reference band only for a shortfall a viewer would notice at a glance next to the board, and every item scored below 9.0 has an issue that names that shortfall. Several small flaws are never a glance-visible shortfall, and neither are nitpicks the references share.
2. **Place.** Start at the band's anchor and move up or down for the specific strengths and flaws you can point to, without leaving the band. In the reference band, each minor flaw (a tangent, a small label, one soft texture, a stray double space, one hot accent) costs 0.1, or 0.2 if a viewer would notice it on a second look, and an item's minor flaws cost at most 0.5 in total, so such an item scores 9.0–9.5, and only an item with nothing to point to scores above 9.5. Every deduction is named, and the score follows from the issues: an item scored below 9.5 has at least one issue that says what cost it, with severity per §5. Inside the reference band those issues are minor, and an item whose issues are all minor scores at least 9.5 minus 0.2 per issue, never below 9.0 (one small label: 9.3–9.4; two minor flaws: 9.1–9.3; nothing to point to: 9.5 or more). An item below 9.0 has a major issue that names its glance-visible shortfall, and a ★ item below 8.5 a blocker.

"Harsh" means refusing the reference band to work that falls short of the references, never marking the references' own level of craft down. The blind A/B against the references (§4.3.4) is the separate check that our frames really reach that level.
- Score the craft an item asks about in what the frame is trying to show. Where an item's "10 looks like" names our own tokens, fonts, states, lighting conventions (the upper-left key, rim light plus blob shadow), numeric thresholds (22 px text, 4.5:1 contrast, 44 px targets; the automated gates measure those on our builds) or `_style/golden`, a frame that is not ours (a reference, a calibration shot) is judged on the same quality in principle (cohesion, palette discipline, typographic craft, instant legibility of whatever the frame communicates; on items 4 and 5, a different but deliberate and equally polished lighting model or form language, such as soft ambient claymation or crisp isometric pixel art, is not a fault; on item 3, neither is a deliberate, bold party-game palette whose hues are harmonised and whose saturation is controlled, as on the board's party-game frames; on item 7, neither is a deliberate crop of a larger world; on item 2, a frame with no game state is judged on how instantly its subject and any text read at 720p; on items 13 and 17, judge whether the moment or audience information the frame shows is clear, not whether it uses our conventions such as a VS beat, a burst or the purple audience UI), and is not marked down for lacking our game's states, HUD or conventions.
- The "≤ 5 looks like" column describes the working-prototype band (4–6). Score below 4 only for broken or placeholder output (anchor 3).
- Judge the rendered frame, not delivery compression: JPEG artefacts from the stream-sim or a store capture are not item-18 faults (item 2 already judges legibility at stream quality).
- An item about something the frame does not show (a moment, audience UI) is `null` (n/a), not a low score. So is an item with only incidental evidence, such as a lone version label for typography or decorative swatches for accessibility.

### 4.2 Items (★ = hard gate)

Scored for each group, where a group is one mode × one viewport. "Clip" items are scored once per game from the clips. "Phone" items are scored only on 360×800 groups.

| # | Item | 10 looks like | ≤ 5 looks like |
|---|---|---|---|
| 1 ★ | **Style consistency** | Board, pieces, room and UI read as one clay, wood and paper world that matches `_style/golden` | Mixed styles, default grey three.js materials, stock widgets |
| 2 ★ | **Stream readability** (judged mainly on Stream-sim) | At 720p JPEG quality 60, whose turn it is, the current state and the scores are clear within 1 s; critical text ≥ 22 px at 1080p | Squinting required; key info sits in the webcam zone |
| 3 | **Palette adherence** | Token colours only; no pure black or white; tinted shadows; identity hexes exact in the HUD | Off-palette, grey shadows, neon |
| 4 | **Lighting & mode identity** | Clear upper-left key light; pieces lift off the board through rim light plus blob shadow; each mode is recognisable at once | Flat or harsh lighting; day and night look alike |
| 5 | **Form softness** | Every edge is beveled or rounded, with chunky toy silhouettes and radii matching the tokens | Sharp boxes, spindly shapes, jagged silhouettes |
| 6 ★ | **Hierarchy & focus** | One obvious focal point; the eye moves action → state → context | Everything shouts; unclear call to action |
| 7 | **Composition & camera** | The mat is framed per SPEC §13.4, with breathing room; stream-safe zones are respected when Stream Layout is on | Cropped board, awkward tangents, dead space |
| 8 | **Typography** | Fredoka, Nunito and Caveat only; correct scale steps; tabular numbers; no widows | Fallback fonts, random sizes, overlapping text |
| 9 | **UI component polish** | Consistent radii, shadows and 4-pt spacing; one icon stroke weight; visible states; no clipping | Misaligned, clipped, default controls |
| 10 | **Surface quality** | Wood, felt, paper and cork read as materials; no visible tiling; subtle grain | Obvious repeats, noise that looks like compression artefacts, blurry board art |
| 11 | **Accessibility** | Colour + glyph identity; passes a deuteranopia/protanopia simulation; contrast ≥ 4.5:1 | Players distinguishable only by red vs green |
| 12 | **Ambient life** (clip) | Steam, lights, weather and the cat make the room feel lived-in and unobtrusive | A dead static scene, or distracting particles |
| 13 | **Moment quality** | Reveal, capture and win moments feel celebratory and clip-worthy, with the result stated clearly | "Player 2 wins" as plain text; confetti hides the result |
| 14 | **Phone layout** (phone) | Everything fits; targets ≥ 44 px; HUD in bars; safe areas respected | Board cut off, overlaps, tiny buttons |
| 15 ★ | **AAA polish gut check** | A stranger believes it's a premium indie game | Looks like a prototype, demo or template |
| 16 | **Motion & feedback** (clip) | Correct easing and springs, with anticipation and follow-through; feedback within 100 ms; nothing snaps or jitters; the camera glides | Linear tweens, pops, jitter, camera cuts |
| 17 | **Audience & stream affordances** | Purple audience UI that is clear at a glance: poll, odds, "chat did this"; the room code is legible; the timer is clear | Audience state invisible or confusing |
| 18 | **Technical cleanliness** | No aliasing shimmer, z-fighting, seams, banding, pop-in, or FOUT captured in the screenshot | Visible artefacts |

### 4.3 Pass bar

A game (or a visual platform item) **passes** only if **all** of these hold:
1. In **every** group: the **mean ≥ 8.5**, **no item < 7.5**, and **every ★ item ≥ 8.5**.
2. Clip items (12, 16) are ≥ 8.0.
3. There are **0 open blockers**, and no previously fixed issue has come back.
4. **Blind A/B:**
   - Against `_style/golden`: our shot is chosen or tied in **at least 50%** of pairs for "which looks more cohesive with a cozy, premium house style".
   - Against external references: chosen or tied in **at least 30%** of pairs.
5. **Style golden (M2 quip-clash) only:** every ★ item ≥ 9.0, and the external-reference A/B ≥ 40%.

Pass decision: two independent critics score each round. Merge per item and group: **★ items use the minimum** of the two scores; **all other items use the mean**. If the two critics differ by more than 1.5 on any ★ item in any group, or their overall means differ by more than 1.5, a third critic scores and the **median** of the three is used for every item. (Pure min-merging of every item across ~14 groups was rejected: with two independent noisy scorers it makes "mean ≥ 8.5 in every group" statistically unreachable even for work that deserves to pass, which would push every game to `blocked`.)

Groups scored per round: 4 modes × 3 viewports (12) + `stream/dusk` + `stream/night` = 14, plus the clip items and the snow spot check (items 1, 3, 4, 18 only, same thresholds).
