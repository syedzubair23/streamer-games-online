# Critic calibration

**Required streak:** 3 consecutive passing runs, with distinct seeds, on the current configuration.

`pnpm critic:calibrate` scores every `docs/references/_style/` image plus the grey default three.js
fixture (`tools/harness/calibration/grey-default-threejs.png`). Each image goes to 2 fresh, blind,
read-only critics, and their scores are merged per §4.3. Target: every reference (each image, not the board mean) at 9–10, and the fixture at 4–6.

`pnpm critic:calibrate --check` accepts only when the latest N runs (N = the streak above) on the
**current configuration** all pass and have distinct seeds. A failed run on that configuration breaks the streak. The configuration is:
- the sha256 of RUBRIC.md,
- the sha256 of report.schema.json,
- the protocol hash (the calibration prompt, the §4.1 deduction rules the replies are validated against, and the bands),
- the subject list,
- the sha256 of every subject image the critics saw.

Editing any of these makes every earlier run stale. `docs/references/manifest.json` also pins the sha256 of each `_style` source download, and `pnpm refs:fetch` refuses an image that differs.

This file is kept out of RUBRIC.md on purpose: calibration critics read RUBRIC.md and must not learn what the subjects are.

## Reference board (fixed before scoring, round 3)

Round 2 curated the board on the dependent variable: frames that scored under 9 were swapped for frames that scored higher. That was wrong, and it has been undone. The board is now chosen by the written rules in `manifest.json` → `styleSelection` (rendered in `docs/references/SOURCES.md`). The rules were fixed before any round-3 scoring:
- official store shots of the six sources;
- Jackbox means Quiplash 3 only (research 03: clay, not neon);
- the frame shows play, with no title or logo cards, menus or marketing overlays;
- no tool UI over the subject;
- day, golden-hour or dusk lighting;
- the **first 2 qualifying shots per source, in store order**. Two is the largest equal count every source can meet, because Tiny Glade has exactly two qualifying shots.

The rules readmit frames that round 2 had dropped for low scores: Alba's forest boardwalk and Quiplash 3's vote result. They also replace the Quiplash 3 title card with in-round screens: the vote and the vote result. Board: 12 images, 2 each from A Short Hike, Unpacking, Alba, Tiny Glade, Townscaper and Jackbox. No frame has been swapped because of a score since.

## Anchor revisions (all runs are kept under `artifacts/critic/_calibration/`)

Rounds 1–2 (runs 16-30 … 18-07):
1. Baseline: references scored 6.7–8.8. Revisions spelled out the 5 and 3 anchors, made the board the top of the scale, added a 9 anchor and gave critics a leave-one-out contact sheet. The fixture stayed at about 4.2 throughout.
2. Round 2 added "minor flaws cost ≤ 0.5 in total and do not stack below 9.0". Critics ignored it: they logged only minor issues yet scored items 8.6–8.9. The verifier's run 18-07 failed, with the Quiplash 3 title at 8.91 and the vote at 9.00. The wording was not enforceable, and the references sat on the 9.0 line.

Round 3, on the rule-chosen board:
3. **Band first, then place** (§4.1 "How to apply", run 18-25). Critics first choose a band by comparing the frame with the board: reference 9.0–10 around 9.5, screenshot-worthy 8.0–8.9, and so on. They then place the score inside the band from its anchor. A new 9.5 anchor names the board's own level. On item 3, a bold but harmonised party-game palette is not a fault. Result: FAILED. `townscaper-02` scored 8.82 and `alba-02` 8.99. Critics still scored 9.0–9.3 with no issue named.
4. **Every deduction is named** (run 18-28). An item below 9.5 must carry an issue, and the validator now rejects a reply that breaks this. A rejected critic is re-spawned once, per DOD §7, and told only which rule its reply broke. Lighting conventions (upper-left key, rim plus blob shadow) were added to the list of house conventions that are judged in principle. Result: passed, but at min 9.02. Critics attached one minor nitpick to almost every item and deducted 0.5 for it.
5. **Per-flaw cost** (run 18-31): each minor flaw costs 0.1, or 0.2 if a viewer would notice it on a second look. Result: passed at min 9.09. Critics still deducted 0.3–0.5 per single minor issue.
6. **The score follows from the issues** (§4.1 step 2 and DOD §5 severity; run 18-34 and the streak). The validator enforces these rules for every item:

   | Item state | Required |
   |---|---|
   | All issues minor | Score ≥ 9.5 − 0.2 per issue, never below 9.0 |
   | Scored below 9.0 | A **major** issue naming the glance-visible shortfall |
   | ★ item below 8.5 | A **blocker** issue |

   The major rule needed a matching change to the DOD §5 "major" definition. Harshness is unchanged: an item still drops as far as the critic judges, as long as the critic names a major shortfall (for example `townscaper-02`, item 7, "about 42% empty sky": 8.4, run 18-28). The fixture stayed at 4.30–4.45.

Run 18-34 passed (min 9.15, mean 9.30). It was scored before the protocol hash existed, so it does not count towards the streak.

## Status: accepted

The accepted streak is 3 consecutive passing runs on the final configuration. There were no failed runs on that configuration.

| Run | Seed | References min | References mean | Fixture | Re-spawned critics |
|---|---|---|---|---|---|
| 18-39 | 1511757826 | 9.25 | 9.31 | 4.30 | 8 of 26 |
| 18-41 | 1254800371 | 9.23 | 9.30 | 4.39 | 7 of 26 |
| 18-43 (`latest.json`) | 1747397529 | 9.24 | 9.30 | 4.45 | 7 of 26 |

Every re-spawn was triggered by the per-flaw rule, for example "item 7 is scored 9.2 with 1 minor issue". Every re-spawned critic then returned a valid report. Across the streak, the lowest single reference score is 9.23 (`tiny-glade-02`), and every subject stayed within 0.1 of its mean from run to run.
