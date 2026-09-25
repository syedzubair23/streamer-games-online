/**
 * A small original fixture content set for Odd One Out: 6 `ooo-categories` (12 secrets each,
 * a 3-clue bank per secret, 6 generic clues) and 20 `ooo-pairs` (18 whose words share a
 * category, 2 that do not). Scenarios and tests use it; the shipped packs live in
 * `content/packs/ooo-categories/` and `content/packs/ooo-pairs/` (M6-02).
 *
 * @module
 */
import type { AnyPack, OooCategory, OooPair, PackKind } from "@sg/shared";
import type { ContentAccess, PackInfo } from "@sg/engine";

type Row = [secret: string, clues: [string, string, string]];

const category = (
  id: string,
  name: string,
  rows: readonly Row[],
  genericClues: OooCategory["genericClues"],
): OooCategory => ({
  id,
  name,
  secrets: rows.map(([s]) => s),
  clueBank: Object.fromEntries(rows.map(([s, c]) => [s, [...c]])) as OooCategory["clueBank"],
  genericClues,
});

/** The fixture categories. */
export const FIXTURE_CATEGORIES: readonly OooCategory[] = [
  category(
    "fx-fruit",
    "Fruit",
    [
      ["Apple", ["orchard", "crunchy", "cider"]],
      ["Banana", ["peel", "monkey", "bunch"]],
      ["Cherry", ["stem", "sundae", "pip"]],
      ["Grape", ["vine", "raisin", "wine"]],
      ["Lemon", ["sour", "zest", "squeeze"]],
      ["Mango", ["tropical", "juicy", "chutney"]],
      ["Orange", ["citrus", "segments", "juice"]],
      ["Peach", ["fuzzy", "cobbler", "stone"]],
      ["Pear", ["gritty", "partridge", "green"]],
      ["Pineapple", ["spiky", "pizza", "crown"]],
      ["Strawberry", ["jam", "shortcake", "seeds"]],
      ["Watermelon", ["summer", "slice", "picnic"]],
    ],
    ["sweet", "healthy", "snack", "tree", "smoothie", "market"],
  ),
  category(
    "fx-animals",
    "Animals",
    [
      ["Cat", ["whiskers", "purr", "meow"]],
      ["Dog", ["bark", "fetch", "leash"]],
      ["Horse", ["saddle", "gallop", "hooves"]],
      ["Cow", ["milk", "dairy", "pasture"]],
      ["Pig", ["oink", "mud", "trough"]],
      ["Sheep", ["wool", "flock", "baa"]],
      ["Lion", ["mane", "roar", "pride"]],
      ["Tiger", ["stripes", "jungle", "prowl"]],
      ["Bear", ["honey", "hibernate", "grizzly"]],
      ["Wolf", ["howl", "pack", "moon"]],
      ["Rabbit", ["carrot", "burrow", "bunny"]],
      ["Fox", ["sly", "bushy", "lair"]],
    ],
    ["fur", "paws", "wild", "tail", "zoo", "cute"],
  ),
  category(
    "fx-kitchen",
    "Kitchen Things",
    [
      ["Spoon", ["soup", "stir", "cereal"]],
      ["Fork", ["prongs", "spaghetti", "twirl"]],
      ["Knife", ["blade", "chop", "sharp"]],
      ["Kettle", ["whistle", "boil", "spout"]],
      ["Toaster", ["crumbs", "pop-up", "bread"]],
      ["Blender", ["smoothie", "whirr", "puree"]],
      ["Oven", ["bake", "preheat", "roast"]],
      ["Fridge", ["cold", "magnets", "leftovers"]],
      ["Whisk", ["eggs", "fluffy", "wire"]],
      ["Ladle", ["scoop", "broth", "pour"]],
      ["Colander", ["drain", "holes", "pasta"]],
      ["Spatula", ["flip", "pancake", "scrape"]],
    ],
    ["cooking", "utensil", "drawer", "handy", "steel", "dinner"],
  ),
  category(
    "fx-weather",
    "Weather",
    [
      ["Rain", ["umbrella", "puddles", "wet"]],
      ["Snow", ["flakes", "sled", "winter"]],
      ["Thunder", ["rumble", "boom", "storm"]],
      ["Lightning", ["flash", "bolt", "zap"]],
      ["Fog", ["misty", "haze", "murky"]],
      ["Hail", ["sleet", "pellets", "bouncy"]],
      ["Rainbow", ["colors", "arc", "gold"]],
      ["Tornado", ["twister", "funnel", "spin"]],
      ["Sunshine", ["bright", "warm", "rays"]],
      ["Wind", ["breeze", "gust", "kite"]],
      ["Drizzle", ["sprinkle", "damp", "light"]],
      ["Frost", ["chilly", "window", "morning"]],
    ],
    ["sky", "forecast", "outside", "season", "clouds", "nature"],
  ),
  category(
    "fx-sports",
    "Sports",
    [
      ["Soccer", ["goal", "pitch", "kick"]],
      ["Tennis", ["racket", "serve", "volley"]],
      ["Golf", ["caddie", "putt", "fairway"]],
      ["Basketball", ["hoop", "dribble", "dunk"]],
      ["Baseball", ["bat", "diamond", "homerun"]],
      ["Swimming", ["pool", "laps", "goggles"]],
      ["Boxing", ["gloves", "bout", "jab"]],
      ["Cycling", ["pedal", "helmet", "wheels"]],
      ["Skiing", ["slopes", "poles", "powder"]],
      ["Surfing", ["waves", "board", "beach"]],
      ["Bowling", ["pins", "strike", "alley"]],
      ["Hockey", ["puck", "zamboni", "faceoff"]],
    ],
    ["team", "tally", "athlete", "match", "trophy", "practice"],
  ),
  category(
    "fx-instruments",
    "Musical Instruments",
    [
      ["Piano", ["keys", "grand", "ivory"]],
      ["Guitar", ["strings", "riff", "pick"]],
      ["Violin", ["fiddle", "chin", "sonata"]],
      ["Drums", ["sticks", "beat", "cymbal"]],
      ["Trumpet", ["brass", "valves", "fanfare"]],
      ["Flute", ["breathy", "silver", "recorder"]],
      ["Harp", ["angelic", "pluck", "lyre"]],
      ["Saxophone", ["jazz", "reed", "sultry"]],
      ["Cello", ["deep", "orchestra", "cellist"]],
      ["Banjo", ["country", "twang", "bluegrass"]],
      ["Ukulele", ["tiny", "hawaii", "luau"]],
      ["Tuba", ["oompah", "huge", "low"]],
    ],
    ["music", "melody", "band", "concert", "notes", "tune"],
  ),
];

/** The fixture pairs: 18 inside one category, then 2 with no matching category. */
export const FIXTURE_PAIRS: readonly OooPair[] = [
  { a: "Lemon", b: "Orange", category: "Fruit" },
  { a: "Peach", b: "Pear", category: "Fruit" },
  { a: "Strawberry", b: "Cherry", category: "Fruit" },
  { a: "Cat", b: "Dog", category: "Animals" },
  { a: "Lion", b: "Tiger", category: "Animals" },
  { a: "Wolf", b: "Fox", category: "Animals" },
  { a: "Spoon", b: "Ladle", category: "Kitchen Things" },
  { a: "Fork", b: "Knife", category: "Kitchen Things" },
  { a: "Oven", b: "Toaster", category: "Kitchen Things" },
  { a: "Rain", b: "Drizzle", category: "Weather" },
  { a: "Snow", b: "Hail", category: "Weather" },
  { a: "Fog", b: "Frost", category: "Weather" },
  { a: "Soccer", b: "Hockey", category: "Sports" },
  { a: "Baseball", b: "Basketball", category: "Sports" },
  { a: "Skiing", b: "Surfing", category: "Sports" },
  { a: "Violin", b: "Cello", category: "Musical Instruments" },
  { a: "Guitar", b: "Banjo", category: "Musical Instruments" },
  { a: "Trumpet", b: "Tuba", category: "Musical Instruments" },
  { a: "Coffee", b: "Tea", category: "Drinks" },
  { a: "Castle", b: "Palace", category: "Buildings" },
];

/** The fixture categories as the default `ooo-core` pack. */
export const FIXTURE_CORE_PACK: AnyPack = {
  id: "ooo-core",
  kind: "ooo-categories",
  name: "Fixture categories",
  lang: "en",
  rating: "all",
  version: 1,
  items: [...FIXTURE_CATEGORIES],
};

/** The fixture pairs as the `ooo-pairs` pack. */
export const FIXTURE_PAIRS_PACK: AnyPack = {
  id: "ooo-pairs",
  kind: "ooo-pairs",
  name: "Fixture pairs",
  lang: "en",
  rating: "all",
  version: 1,
  items: [...FIXTURE_PAIRS],
};

/**
 * A synchronous in-memory {@link ContentAccess} over packs (scenarios run in the browser, so they
 * cannot use the vitest-based `fakeContent`). `used` lists content keys already played.
 */
export function packContent(
  packs: readonly AnyPack[],
  used: readonly string[] = [],
): ContentAccess {
  return {
    packs: (kind: PackKind): readonly PackInfo[] =>
      packs
        .filter((p) => p.kind === kind)
        .map((p) => ({
          id: p.id,
          kind: p.kind,
          name: p.name,
          rating: p.rating,
          count: p.items.length,
        })),
    items: (kind, packIds) =>
      packIds.flatMap((id) => {
        const pack = packs.find((p) => p.id === id && p.kind === kind);
        return pack === undefined ? [] : (pack.items as never[]);
      }),
    isUsed: (_kind, key) => used.includes(key),
  };
}

/** The fixture content (categories + pairs). */
export const fixtureContent = (): ContentAccess =>
  packContent([FIXTURE_CORE_PACK, FIXTURE_PAIRS_PACK]);
