/**
 * Content pack types and zod schemas (SPEC §12). `PackKind` and `Pack<T>` are copied exactly
 * from the spec; the per-kind item shapes come from each game spec:
 *
 * | kind | item | spec |
 * |---|---|---|
 * | `quip-prompts` | {@link QuipPrompt} | quip-clash "Content" |
 * | `trivia-mc` | {@link TriviaMcItem} | trivia-night `McItem` + question-writing rules |
 * | `trivia-bluff` | {@link TriviaBluffItem} | trivia-night `BluffItem`, R9 |
 * | `spectrum` | {@link SpectrumCard} | tune-in "Content" |
 * | `doodle-words` | {@link DoodleWord} | doodle "Content" |
 * | `ooo-categories` | {@link OooCategory} | odd-one-out "Content" |
 * | `ooo-pairs` | {@link OooPair} | odd-one-out "Content" |
 *
 * Packs are read by the server only; clients never receive a whole pack.
 *
 * @module
 */
import { z } from "zod";
import { cleanUserText, hasProfanity, normalize } from "./text.ts";

// ---------------------------------------------------------------------------------------------
// Copied exactly from SPEC §12.
// ---------------------------------------------------------------------------------------------

// prettier-ignore
export type PackKind = "quip-prompts" | "trivia-mc" | "trivia-bluff" | "spectrum" | "doodle-words" | "ooo-categories" | "ooo-pairs";
// prettier-ignore
export interface Pack<T> { id: string; kind: PackKind; name: string; lang: "en"; rating: "all" | "teen"; version: number; items: T[] }

// ---------------------------------------------------------------------------------------------
// Item schemas
// ---------------------------------------------------------------------------------------------

/** Every pack kind, in spec order. */
export const PACK_KINDS = [
  "quip-prompts",
  "trivia-mc",
  "trivia-bluff",
  "spectrum",
  "doodle-words",
  "ooo-categories",
  "ooo-pairs",
] as const satisfies readonly PackKind[];

/** Host custom packs hold at most 2,000 items (SPEC §12). */
export const CUSTOM_PACK_MAX_ITEMS = 2000;

/** Trivia questions fit in 3 lines at 40 px (trivia-night "Content"). */
export const TRIVIA_QUESTION_MAX = 110;
/** Trivia options fit their button (trivia-night "Content"). */
export const TRIVIA_OPTION_MAX = 28;

const text = (max: number) => z.string().trim().min(1).max(max);
const id = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/, "ids are lowercase letters, digits and - _ .");
const sourceUrl = z.url({ protocol: /^https?$/ });

const distinct = (values: readonly string[]): boolean =>
  new Set(values.map(normalize)).size === values.length;

/** `quip-prompts` item: `{ id, text, safety: [3 strings], tags? }`. */
export const QuipPromptSchema = z.strictObject({
  id,
  text: text(140),
  safety: z.tuple([text(60), text(60), text(60)]),
  tags: z.array(text(32)).optional(),
});
export type QuipPrompt = z.infer<typeof QuipPromptSchema>;

/** `trivia-mc` item (trivia-night `McItem`), including the question-writing length rules. */
export const TriviaMcItemSchema = z
  .strictObject({
    id,
    q: text(TRIVIA_QUESTION_MAX),
    options: z.tuple([
      text(TRIVIA_OPTION_MAX),
      text(TRIVIA_OPTION_MAX),
      text(TRIVIA_OPTION_MAX),
      text(TRIVIA_OPTION_MAX),
    ]),
    correct: z.literal([0, 1, 2, 3]),
    category: text(40),
    difficulty: z.literal([1, 2, 3]),
    source: sourceUrl,
    validUntil: z.iso.date().optional(),
  })
  .refine((item) => distinct(item.options), {
    message: "options must be distinct",
    path: ["options"],
  });
export type TriviaMcItem = z.infer<typeof TriviaMcItemSchema>;

/** `trivia-bluff` item (trivia-night `BluffItem`, R9): a prompt with a blank and ≥ 3 house lies. */
export const TriviaBluffItemSchema = z
  .strictObject({
    id,
    prompt: text(140).regex(/_{3,}/, "prompt must contain a blank (___)"),
    truth: text(40),
    alts: z.array(text(40)),
    houseLies: z.array(text(40)).min(3),
    category: text(40),
    source: sourceUrl,
  })
  .refine(
    (item) => {
      const truths = new Set([item.truth, ...item.alts].map(normalize));
      return item.houseLies.every((lie) => !truths.has(normalize(lie)));
    },
    { message: "a house lie equals the truth or one of its alts", path: ["houseLies"] },
  )
  .refine((item) => distinct(item.houseLies), {
    message: "house lies must be distinct",
    path: ["houseLies"],
  });
export type TriviaBluffItem = z.infer<typeof TriviaBluffItemSchema>;

/** `spectrum` card (tune-in): `{ id, left, right, examples: [3 strings] }`. */
export const SpectrumCardSchema = z
  .strictObject({
    id,
    left: text(32),
    right: text(32),
    examples: z.tuple([text(48), text(48), text(48)]),
  })
  .refine((card) => normalize(card.left) !== normalize(card.right), {
    message: "left and right must differ",
    path: ["right"],
  });
export type SpectrumCard = z.infer<typeof SpectrumCardSchema>;

/** `doodle-words` item: `{ w, alt?, d: 1|2|3 }` (easy/medium/hard). */
export const DoodleWordSchema = z.strictObject({
  w: text(32),
  alt: z.array(text(32)).optional(),
  d: z.literal([1, 2, 3]),
});
export type DoodleWord = z.infer<typeof DoodleWordSchema>;

/**
 * `ooo-categories` item: `{ id, name, secrets: string[12], clueBank: Record<secret, string[3]>,
 * genericClues: string[6] }`. A category with fewer than 12 secrets is rejected
 * (odd-one-out "Edge cases"), and `clueBank` must have exactly one entry per secret.
 */
export const OooCategorySchema = z
  .strictObject({
    id,
    name: text(40),
    secrets: z.array(text(32)).length(12),
    clueBank: z.record(z.string(), z.tuple([text(32), text(32), text(32)])),
    genericClues: z.tuple([text(32), text(32), text(32), text(32), text(32), text(32)]),
  })
  .refine((cat) => distinct(cat.secrets), {
    message: "secrets must be distinct",
    path: ["secrets"],
  })
  .refine(
    (cat) => {
      const keys = Object.keys(cat.clueBank);
      return (
        keys.length === cat.secrets.length &&
        cat.secrets.every((s) => Object.hasOwn(cat.clueBank, s))
      );
    },
    { message: "clueBank must have exactly one entry per secret", path: ["clueBank"] },
  );
export type OooCategory = z.infer<typeof OooCategorySchema>;

/** `ooo-pairs` item (Undercover): `{ a, b, category }`, e.g. cat / dog. */
export const OooPairSchema = z
  .strictObject({ a: text(32), b: text(32), category: text(40) })
  .refine((pair) => normalize(pair.a) !== normalize(pair.b), {
    message: "a and b must differ",
    path: ["b"],
  });
export type OooPair = z.infer<typeof OooPairSchema>;

/** Item type per pack kind. */
export interface PackItemMap {
  "quip-prompts": QuipPrompt;
  "trivia-mc": TriviaMcItem;
  "trivia-bluff": TriviaBluffItem;
  spectrum: SpectrumCard;
  "doodle-words": DoodleWord;
  "ooo-categories": OooCategory;
  "ooo-pairs": OooPair;
}

/** Item schema per pack kind. */
export const PACK_ITEM_SCHEMAS: { [K in PackKind]: z.ZodType<PackItemMap[K]> } = {
  "quip-prompts": QuipPromptSchema,
  "trivia-mc": TriviaMcItemSchema,
  "trivia-bluff": TriviaBluffItemSchema,
  spectrum: SpectrumCardSchema,
  "doodle-words": DoodleWordSchema,
  "ooo-categories": OooCategorySchema,
  "ooo-pairs": OooPairSchema,
};

/** A validated pack of a known kind. */
export type TypedPack<K extends PackKind> = Pack<PackItemMap[K]> & { kind: K };
/** A validated pack of any kind (discriminated by `kind`). */
export type AnyPack = { [K in PackKind]: TypedPack<K> }[PackKind];

/** The uniqueness key of an item within its pack: its `id`, or the normalised word/pair. */
function itemKey(kind: PackKind, item: unknown): string {
  switch (kind) {
    case "doodle-words":
      return normalize((item as DoodleWord).w);
    case "ooo-pairs": {
      const pair = item as OooPair;
      return [normalize(pair.a), normalize(pair.b)].sort().join("\u0000");
    }
    default:
      return (item as { id: string }).id;
  }
}

/** The zod schema for a whole pack of `kind`: the envelope plus item validation and uniqueness. */
export function packSchema<K extends PackKind>(kind: K): z.ZodType<TypedPack<K>> {
  const items = PACK_ITEM_SCHEMAS[kind] as z.ZodType<PackItemMap[K]>;
  return z
    .strictObject({
      id,
      kind: z.literal(kind),
      name: text(60),
      lang: z.literal("en"),
      rating: z.enum(["all", "teen"]),
      version: z.int().min(1),
      items: z.array(items).min(1),
    })
    .superRefine((pack, ctx) => {
      const seen = new Map<string, number>();
      pack.items.forEach((item, index) => {
        const key = itemKey(kind, item);
        const first = seen.get(key);
        if (first === undefined) seen.set(key, index);
        else {
          ctx.addIssue({
            code: "custom",
            message: `duplicate item (same as items[${first}])`,
            path: ["items", index],
          });
        }
      });
    }) as unknown as z.ZodType<TypedPack<K>>;
}

/** Result of {@link parsePack}. */
export type PackResult<P> = { ok: true; pack: P } | { ok: false; errors: string[] };

/**
 * Validates an unknown JSON value as a pack. The kind comes from `json.kind`, or must equal
 * `expectedKind` when given. Errors are `"path: message"` strings.
 */
export function parsePack(json: unknown): PackResult<AnyPack>;
export function parsePack<K extends PackKind>(
  json: unknown,
  expectedKind: K,
): PackResult<TypedPack<K>>;
export function parsePack(json: unknown, expectedKind?: PackKind): PackResult<AnyPack> {
  const kind = (json as { kind?: unknown } | null)?.kind;
  if (!isPackKind(kind)) {
    return { ok: false, errors: [`kind: expected one of ${PACK_KINDS.join(", ")}`] };
  }
  if (expectedKind !== undefined && kind !== expectedKind) {
    return { ok: false, errors: [`kind: expected ${expectedKind}, got ${kind}`] };
  }
  const result = packSchema(kind).safeParse(json);
  if (result.success) return { ok: true, pack: result.data as AnyPack };
  return { ok: false, errors: result.error.issues.map(formatIssue) };
}

/** True when `kind` is a known pack kind. */
export function isPackKind(kind: unknown): kind is PackKind {
  return typeof kind === "string" && (PACK_KINDS as readonly string[]).includes(kind);
}

/** Result of {@link validateCustomPack}. */
export type CustomPackResult<P> =
  | { ok: true; pack: P; removed: { index: number; reason: "profanity" }[] }
  | { ok: false; errors: string[] };

/**
 * Validates a host-uploaded JSON pack (SPEC §12): the same schema as built-in packs, at most
 * {@link CUSTOM_PACK_MAX_ITEMS} items, then filtered: items with profanity in any text field are
 * dropped (and reported in `removed`). A pack left with no items is rejected.
 */
export function validateCustomPack<K extends PackKind>(
  json: unknown,
  expectedKind: K,
): CustomPackResult<TypedPack<K>> {
  const count = (json as { items?: unknown } | null)?.items;
  if (Array.isArray(count) && count.length > CUSTOM_PACK_MAX_ITEMS) {
    return { ok: false, errors: [`items: at most ${CUSTOM_PACK_MAX_ITEMS} items`] };
  }
  const parsed = parsePack(json, expectedKind);
  if (!parsed.ok) return parsed;
  const removed: { index: number; reason: "profanity" }[] = [];
  const items = parsed.pack.items.filter((item, index) => {
    const bad = collectStrings(item).some(hasProfanity);
    if (bad) removed.push({ index, reason: "profanity" });
    return !bad;
  });
  if (items.length === 0) return { ok: false, errors: ["items: no items left after filtering"] };
  return { ok: true, pack: { ...parsed.pack, items } as TypedPack<K>, removed };
}

/** Result of {@link parseWordList}. */
export interface WordListResult {
  words: string[];
  /** Counts of dropped lines by reason. */
  dropped: { duplicate: number; profanity: number; overLimit: number };
}

/**
 * Parses a pasted newline-separated list (host custom words, SPEC §12): each line is cleaned
 * and capped at `maxLength` characters (default 32), blank lines are skipped, duplicates
 * (after {@link normalize}) and lines containing profanity are dropped, and at most
 * {@link CUSTOM_PACK_MAX_ITEMS} words are kept.
 */
export function parseWordList(input: string, maxLength = 32): WordListResult {
  const words: string[] = [];
  const seen = new Set<string>();
  const dropped = { duplicate: 0, profanity: 0, overLimit: 0 };
  for (const line of input.split(/\r\n|\r|\n/)) {
    const word = cleanUserText(line, maxLength);
    if (word.length === 0) continue;
    const key = normalize(word);
    if (key.length === 0) continue; // punctuation only: nothing to guess
    if (seen.has(key)) {
      dropped.duplicate++;
      continue;
    }
    if (hasProfanity(word)) {
      dropped.profanity++;
      continue;
    }
    if (words.length >= CUSTOM_PACK_MAX_ITEMS) {
      dropped.overLimit++;
      continue;
    }
    seen.add(key);
    words.push(word);
  }
  return { words, dropped };
}

function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out);
  else if (typeof value === "object" && value !== null) {
    for (const [key, v] of Object.entries(value)) {
      out.push(key);
      collectStrings(v, out);
    }
  }
  return out;
}

function formatIssue(issue: z.core.$ZodIssue): string {
  return `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`;
}
