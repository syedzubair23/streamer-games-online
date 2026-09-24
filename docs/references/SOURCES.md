# Reference image sources

<!-- Generated from docs/references/manifest.json by `pnpm refs:fetch --sources`. Do not edit by hand. -->

Every image is an **official store screenshot** published by the game's developer on its Steam store
page. They are used **only** for critic comparison (DOD §4, §7; ROADMAP M0-06): never shipped, never
committed (see `.gitignore`), never used as texture or asset input. Rebuild the local copies with
`pnpm refs:fetch`; images are scaled to fit 1280×720 and stored as PNG.
A download whose sha256 differs from the one the manifest pins is refused.

## How the `_style/` frames were chosen

These rules were fixed before calibration scoring and do not depend on any score (docs/critic/CALIBRATION.md):

1. Sources: the six ROADMAP M0-06 titles, official Steam store screenshots only. For Jackbox, only Quiplash 3 from The Jackbox Party Pack 7: its sculpted-clay art direction fits research 03 ("toy-real" clay, "nothing fully saturated", "avoid neon"); the other packs and the pack's other games are flat vector or neon.
2. The frame shows play: the game world, or for the party game an in-round screen (prompt, answers, vote). Excluded: title or logo cards, character or splash art, menus and settings or filter grids, and marketing overlays (stickers, stars).
3. No tool UI over the subject: build gizmos, selection brackets, radial menus, pickers, lighting widgets and phone-camera overlays exclude a frame. A thin HUD or toolbar strip along one edge is allowed, since it is part of the shipped look.
4. Day, golden-hour or dusk lighting only; night and uncoloured render modes are excluded. The board anchors the default Play look (research 03: golden hour "is what makes everything look good"); night modes are judged against the golden later.
5. Pick the first 2 qualifying screenshots per source in the store page's published order (appdetails order, recorded in each note). Two per source is the largest equal count every source can meet (Tiny Glade has exactly two qualifying shots), so no single style dominates the leave-one-out contact sheet.
6. Frames are never swapped because of a calibration score. A shortfall is fixed in the rubric anchors (ROADMAP M0-06 Accept).

## `_style/` — house-style board

| File | Source game | Store page | Image URL | What to take from it |
|---|---|---|---|---|
| `_style/a-short-hike-01.png` | A Short Hike | https://store.steampowered.com/app/1055540/ | https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1055540/ss_f2123fea859e299736a3e99d130238c784d53e75.1920x1080.jpg | Store shot #1. Hand-built island village: warm rim light, chunky soft forms |
| `_style/a-short-hike-02.png` | A Short Hike | https://store.steampowered.com/app/1055540/ | https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1055540/ss_0e864bf975bb71f238de6861fc8fd3d6ed6e4ce8.1920x1080.jpg | Store shot #2. Climbing past the waterfall: friendly scale, saturated but warm palette, one small hero |
| `_style/unpacking-01.png` | Unpacking | https://store.steampowered.com/app/1135690/ | https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1135690/ss_b32bfdd3f68e1f9e264bd37e10a464629ca034f8.1920x1080.jpg | Store shot #1. Lived-in bedroom diorama: objects that tell a story |
| `_style/unpacking-02.png` | Unpacking | https://store.steampowered.com/app/1135690/ | https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1135690/ss_9b358510285a4b70e446237de5996bc434415c01.1920x1080.jpg | Store shot #2. Loft-bed bedroom mid-unpack: tidy isometric diorama, readable props, soft palette |
| `_style/alba-01.png` | Alba: A Wildlife Adventure | https://store.steampowered.com/app/1337010/ | https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1337010/ss_042f8b0fd51f97b7e09d0e9e658c22b3304b0a2a.1920x1080.jpg | Store shot #1. Sunny coast: soft rounded forms, warm key light, clear focal character |
| `_style/alba-02.png` | Alba: A Wildlife Adventure | https://store.steampowered.com/app/1337010/ | https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1337010/ss_ce424baa7b22e8436e71b98b8c4b5c9c151ebb6c.1920x1080.jpg | Store shot #2. Forest boardwalk: warm directional light, impressionist softness, atmospheric depth |
| `_style/tiny-glade-01.png` | Tiny Glade | https://store.steampowered.com/app/2198150/ | https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/2198150/ss_1a98b0d5e8111f100b3ececda8f682333337e3cb.1920x1080.jpg | Store shot #1. Overgrown ruin garden: soft rounded forms, lush painterly foliage, gentle light (thin build toolbar on the bottom edge) |
| `_style/tiny-glade-02.png` | Tiny Glade | https://store.steampowered.com/app/2198150/ | https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/2198150/ss_533b0699cd1d6692cfa332f234ce03a36c547480.1920x1080.jpg | Store shot #6 (first qualifying after #1). Castle at dusk: pastel gradient sky, impressionist foliage |
| `_style/townscaper-01.png` | Townscaper | https://store.steampowered.com/app/1291340/ | https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1291340/ss_989ff1808d9416c7b22da3e16ee54874697b1cea.1920x1080.jpg | Store shot #1. Pastel island town: colour tied to mood, clean toy forms |
| `_style/townscaper-02.png` | Townscaper | https://store.steampowered.com/app/1291340/ | https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1291340/ss_fcd697b91c82dfd151954070ce20bda18fcb6475.1920x1080.jpg | Store shot #2. Harbour-front terrace: candy palette, chunky rounded facades on calm water |
| `_style/jackbox-party-pack-7-01.png` | The Jackbox Party Pack 7 | https://store.steampowered.com/app/1211630/ | https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1211630/ss_c508b8c68753ba872d64181c75c5c103838ceab6.1920x1080.jpg | Store shot #2 (first Quiplash 3 in-round shot). Vote: two big clay answer bubbles, obvious either/or choice, clear call to action, room code |
| `_style/jackbox-party-pack-7-02.png` | The Jackbox Party Pack 7 | https://store.steampowered.com/app/1211630/ | https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1211630/ss_fcf663fd157d91452b068b271807f5d4ea635ee9.1920x1080.jpg | Store shot #3. Vote result: answers with their authors and voter tags, clay avatars, legible on stream |

## `chess/`

| File | Source game | Store page | Image URL | What to take from it |
|---|---|---|---|---|
| `chess/chess-ultra-01.png` | Chess Ultra | https://store.steampowered.com/app/518060/ | https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/518060/ss_9b62ac94aff0772124b669c3add7e14172a17257.1920x1080.jpg | Board on a lived-in desk, clear framing |
| `chess/chess-ultra-02.png` | Chess Ultra | https://store.steampowered.com/app/518060/ | https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/518060/ss_b737a5f02a9e423a8d80215b0485c536b6b9e1a1.1920x1080.jpg | Red and white set, warm table props |
| `chess/chess-ultra-03.png` | Chess Ultra | https://store.steampowered.com/app/518060/ | https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/518060/ss_ca0ba763401dd89aa330d40f7dac704a75f471a9.1920x1080.jpg | Board with info panel |
| `chess/chess-ultra-04.png` | Chess Ultra | https://store.steampowered.com/app/518060/ | https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/518060/ss_15c2e9776d997c1f06acea90456f549b9f85659f.1920x1080.jpg | Twitch vote: chat plays the move |

## `doodle/`

| File | Source game | Store page | Image URL | What to take from it |
|---|---|---|---|---|
| `doodle/drawful-2-01.png` | Drawful 2 | https://store.steampowered.com/app/442070/ | https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/442070/ss_9d292ec7f06d2d19f67cadea7063b907838bb234.1920x1080.jpg | Drawful 2 lobby: room code and doodled avatars |
| `doodle/drawful-2-02.png` | Drawful 2 | https://store.steampowered.com/app/442070/ | https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/442070/ss_e19d50c7aafaf684139bdc50222987e585a18c3d.1920x1080.jpg | Drawful 2: drawing with guesses |
| `doodle/drawful-2-03.png` | Drawful 2 | https://store.steampowered.com/app/442070/ | https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/442070/ss_a8f9c73f18556ee41f8055de6e4fc70408912458.1920x1080.jpg | Drawful 2: scoreboard |
| `doodle/drawful-2-04.png` | Drawful 2 | https://store.steampowered.com/app/442070/ | https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/442070/ss_0f4df8db1d1d4e221ea3ca3fd4db7e42badcac74.1920x1080.jpg | Drawful 2: most-liked reveal |

## `ludo/`

| File | Source game | Store page | Image URL | What to take from it |
|---|---|---|---|---|
| `ludo/ludo-supremo-01.png` | Ludo Supremo | https://store.steampowered.com/app/487580/ | https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/487580/ss_26057b88fd45082ebfc528947d98dc5b7e29b4e5.1920x1080.jpg | 3D cross board, soft wood, home bases |
| `ludo/ludo-supremo-02.png` | Ludo Supremo | https://store.steampowered.com/app/487580/ | https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/487580/ss_0264e26aa244b65668c3d0f80edcbfa069d9e42a.1920x1080.jpg | Tilted board, coloured pawns |
| `ludo/ludo-supremo-03.png` | Ludo Supremo | https://store.steampowered.com/app/487580/ | https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/487580/ss_e19954c238bd854ae70f4ec3daa5962e53116621.1920x1080.jpg | Close-up: pawns, die and path |
| `ludo/ludo-supremo-04.png` | Ludo Supremo | https://store.steampowered.com/app/487580/ | https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/487580/ss_08a7d0eced530b5e61fd456ed639cb7f295725f0.1920x1080.jpg | Full board framing with dice |

## `marble-rally/`

| File | Source game | Store page | Image URL | What to take from it |
|---|---|---|---|---|
| `marble-rally/marbles-on-stream-01.png` | Marbles on Stream | https://store.steampowered.com/app/1170970/ | https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1170970/ss_865fb13885fb9aa111cca0885d5e320d1ce3ba9d.1920x1080.jpg | Start pen: hundreds of marbles |
| `marble-rally/marbles-on-stream-02.png` | Marbles on Stream | https://store.steampowered.com/app/1170970/ | https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1170970/ss_c367949db2a221ef39a7ba9010b8ad6f22c42ded.1920x1080.jpg | Marble swirl: mass-participation spectacle |
| `marble-rally/marbles-on-stream-03.png` | Marbles on Stream | https://store.steampowered.com/app/1170970/ | https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1170970/ss_2400b78c7048331fa0bca829d76c3231f9a99fd7.1920x1080.jpg | Track with many marbles and hazards |
| `marble-rally/marbles-on-stream-04.png` | Marbles on Stream | https://store.steampowered.com/app/1170970/ | https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1170970/ss_ff89691d26e3e8921fee20720e55f2768eba1aa9.1920x1080.jpg | Close race on a banked track |

## `odd-one-out/`

| File | Source game | Store page | Image URL | What to take from it |
|---|---|---|---|---|
| `odd-one-out/jackbox-party-pack-3-01.png` | The Jackbox Party Pack 3 | https://store.steampowered.com/app/434170/ | https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/434170/ss_759d8128e817d616a42d3e0105b66993a4f4b0ae.1920x1080.jpg | Fakin' It: the faker is still at large |
| `odd-one-out/jackbox-party-pack-3-02.png` | The Jackbox Party Pack 3 | https://store.steampowered.com/app/434170/ | https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/434170/ss_4ac83d3bbc7ac03ef9f74d84bac089f8f5ee1ec6.1920x1080.jpg | Fakin' It: secret task with player voting |
| `odd-one-out/jackbox-party-pack-10-01.png` | The Jackbox Party Pack 10 | https://store.steampowered.com/app/2216830/ | https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/2216830/ss_1b720299cedb559ebaf09078f4fd3678de59329f.1920x1080.jpg | Accusation: the outlier reveal |
| `odd-one-out/jackbox-party-pack-6-01.png` | The Jackbox Party Pack 6 | https://store.steampowered.com/app/1005300/ | https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1005300/ss_5a0df7906eb33342d68d12d4df2b6a54c136c9ce.1920x1080.jpg | Push The Button: vote result on the ship |

## `quip-clash/`

| File | Source game | Store page | Image URL | What to take from it |
|---|---|---|---|---|
| `quip-clash/jackbox-party-pack-7-01.png` | The Jackbox Party Pack 7 | https://store.steampowered.com/app/1211630/ | https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1211630/ss_c508b8c68753ba872d64181c75c5c103838ceab6.1920x1080.jpg | Quiplash 3 head-to-head answers |
| `quip-clash/jackbox-party-pack-3-01.png` | The Jackbox Party Pack 3 | https://store.steampowered.com/app/434170/ | https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/434170/ss_3a13c7dd4eaae85008207e81c982eae35af3139e.1920x1080.jpg | Quiplash (Party Pack 3) vote screen |
| `quip-clash/jackbox-party-pack-3-02.png` | The Jackbox Party Pack 3 | https://store.steampowered.com/app/434170/ | https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/434170/ss_f236ee261683e4cd4c13dbd29b710af78a86392d.1920x1080.jpg | Quiplash (Party Pack 3) matchup with vote counts |

## `trivia-night/`

| File | Source game | Store page | Image URL | What to take from it |
|---|---|---|---|---|
| `trivia-night/trivia-murder-party-3-01.png` | Trivia Murder Party 3 | https://store.steampowered.com/app/3048060/ | https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/3048060/a41872c9b7d4bba61cafe37bf6749754eda18e9a/ss_a41872c9b7d4bba61cafe37bf6749754eda18e9a.1920x1080.jpg | Trivia Murder Party 3: question card in a lit diorama |
| `trivia-night/trivia-murder-party-3-02.png` | Trivia Murder Party 3 | https://store.steampowered.com/app/3048060/ | https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/3048060/b120a0e706debff3c98eecb9daedfc9bd9d123f3/ss_b120a0e706debff3c98eecb9daedfc9bd9d123f3.1920x1080.jpg | Trivia Murder Party 3: minigame with player list |
| `trivia-night/jackbox-party-pack-3-01.png` | The Jackbox Party Pack 3 | https://store.steampowered.com/app/434170/ | https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/434170/ss_4d1856b132fbef7f59c20f0f5a8de150595666ef.1920x1080.jpg | Trivia Murder Party: question with numbered answers |
| `trivia-night/jackbox-survey-scramble-01.png` | The Jackbox Survey Scramble | https://store.steampowered.com/app/2948640/ | https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/2948640/ss_6506be5fafcf2bad40a834044bcd5209fbb5a01f.1920x1080.jpg | Survey Scramble: answer grid with score |

## `tune-in/`

| File | Source game | Store page | Image URL | What to take from it |
|---|---|---|---|---|
| `tune-in/jackbox-party-pack-9-01.png` | The Jackbox Party Pack 9 | https://store.steampowered.com/app/1850960/ | https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1850960/ss_8dce394084d9904b7223efc659d07824a461957b.1920x1080.jpg | Nonsensory: two-ended scale with player markers |
| `tune-in/jackbox-party-pack-9-02.png` | The Jackbox Party Pack 9 | https://store.steampowered.com/app/1850960/ | https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1850960/ss_8c1a96bf83ab3b8c7efb26d3ee4aa6dc36b44dae.1920x1080.jpg | Nonsensory: numeric scale and reveal |
| `tune-in/jackbox-party-pack-9-03.png` | The Jackbox Party Pack 9 | https://store.steampowered.com/app/1850960/ | https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1850960/ss_33b6d93b4db4628398aaacd0eb6ba80a9ae1d694.1920x1080.jpg | Quixort: spectrum ordering, team score |
| `tune-in/jackbox-party-pack-3-01.png` | The Jackbox Party Pack 3 | https://store.steampowered.com/app/434170/ | https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/434170/ss_d163c26c405ec2362686f4720f7e7532a8af454c.1920x1080.jpg | Guesspionage: percentage dial guess |
