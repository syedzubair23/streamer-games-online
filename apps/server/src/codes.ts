/**
 * Room codes (SPEC §3 step 1, §9.5): 4 letters from the 20-consonant alphabet (no vowels, so no
 * accidental words), checked against a blocklist anyway, unique among live and recently ended
 * rooms, and versioned with a `roomEpoch` so tokens from an earlier room with the same code
 * are rejected.
 *
 * @module
 */
import { randomInt } from "node:crypto";
import { isRoomCode, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from "@sg/shared";
import type { Clock, TimerHandle } from "./config.ts";

/**
 * Letter sequences that must not appear anywhere in a code. Consonant-only, so these are the
 * abbreviations, slurs and hate symbols that survive the missing vowels.
 */
export const CODE_BLOCKED_SUBSTRINGS: readonly string[] = [
  "FCK",
  "FKK",
  "FK",
  "FCKN",
  "FGT",
  "FGGT",
  "KKK",
  "NGR",
  "NGGR",
  "NGG",
  "NZ",
  "SS",
  "CNT",
  "CCK",
  "CK",
  "DCK",
  "DKK",
  "PSS",
  "PNS",
  "SHT",
  "TWT",
  "WNK",
  "WTF",
  "STF",
  "SX",
  "SXX",
  "XXX",
  "JZZ",
  "JZ",
  "KLL",
  "HH",
  "RPD",
  "RP",
  "BTCH",
  "BCH",
  "SLT",
  "THT",
  "TTS",
  "PRN",
  "PMP",
  "GZ",
  "FRT",
  "DMN",
  "GDM",
  "CRP",
  "MFR",
  "MF",
  "BJ",
  "DLD",
  "NCK",
  "VJJ",
  "PDF",
  "PDFL",
  "CP",
  "KMS",
  "LMFT",
  "STD",
  "NSFW",
  "NSFL",
];

/** Whole codes that are blocked outright (read as words or loaded acronyms). */
export const CODE_BLOCKED_CODES: readonly string[] = [
  "BTCH",
  "BNGR",
  "CHNK",
  "CNTS",
  "DRGS",
  "NGRS",
  "PHKK",
  "PRCK",
  "SPCK",
  "SPRM",
  "TRDS",
  "TWTS",
  "WHRS",
  "WNKR",
];

const BLOCKED_CODES = new Set(CODE_BLOCKED_CODES);

/** True when a code contains a blocked sequence or is blocked outright. */
export function isBlockedCode(code: string): boolean {
  if (BLOCKED_CODES.has(code)) return true;
  for (const bad of CODE_BLOCKED_SUBSTRINGS) if (code.includes(bad)) return true;
  return false;
}

/** Uniform integer source in `[0, max)`; `crypto.randomInt` by default. */
export type RandomIndex = (max: number) => number;

/** Options for {@link CodeRegistry}. */
export interface CodeRegistryOptions {
  clock: Clock;
  /** How long an ended room's code stays reserved (SPEC §9.5: 30 min). */
  releaseMs: number;
  random?: RandomIndex;
  /** Returns the epoch to use when a code is (re)issued; defaults to an in-memory counter. */
  nextEpoch?: (code: string) => number;
}

/** A code handed out by {@link CodeRegistry.issue}. */
export interface IssuedCode {
  code: string;
  /** Starts at 1 and increases every time this code is issued again. */
  epoch: number;
}

/**
 * Issues and tracks room codes. A code is `live` while its room exists, `reserved` for
 * `releaseMs` after the room ends, then free again (with a higher epoch next time).
 */
export class CodeRegistry {
  readonly #live = new Set<string>();
  readonly #reserved = new Map<string, TimerHandle>();
  readonly #epochs = new Map<string, number>();
  readonly #random: RandomIndex;
  readonly #nextEpoch: (code: string) => number;

  constructor(private readonly o: CodeRegistryOptions) {
    this.#random = o.random ?? ((max) => randomInt(max));
    this.#nextEpoch =
      o.nextEpoch ??
      ((code) => {
        const e = (this.#epochs.get(code) ?? 0) + 1;
        this.#epochs.set(code, e);
        return e;
      });
  }

  /** Every syntactically possible code: 20^4 = 160,000. */
  static readonly SPACE = ROOM_CODE_ALPHABET.length ** ROOM_CODE_LENGTH;

  /** A random code (may be blocked or taken; see {@link issue}). */
  #candidate(): string {
    let code = "";
    for (let i = 0; i < ROOM_CODE_LENGTH; i++)
      code += ROOM_CODE_ALPHABET[this.#random(ROOM_CODE_ALPHABET.length)] ?? "";
    return code;
  }

  /** Whether a code is unavailable (live or reserved). */
  isTaken(code: string): boolean {
    return this.#live.has(code) || this.#reserved.has(code);
  }

  /**
   * Issues a fresh code, never a blocked, live or reserved one. Tries random codes first and
   * falls back to a linear scan from a random start, so it only returns `null` when every
   * allowed code is in use.
   */
  issue(): IssuedCode | null {
    for (let attempt = 0; attempt < 64; attempt++) {
      const code = this.#candidate();
      if (isRoomCode(code) && !isBlockedCode(code) && !this.isTaken(code)) return this.#take(code);
    }
    const n = ROOM_CODE_ALPHABET.length;
    const start = this.#random(CodeRegistry.SPACE);
    for (let k = 0; k < CodeRegistry.SPACE; k++) {
      let v = (start + k) % CodeRegistry.SPACE;
      let code = "";
      for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
        code = (ROOM_CODE_ALPHABET[v % n] ?? "") + code;
        v = Math.floor(v / n);
      }
      if (!isBlockedCode(code) && !this.isTaken(code)) return this.#take(code);
    }
    return null;
  }

  #take(code: string): IssuedCode {
    this.#live.add(code);
    return { code, epoch: this.#nextEpoch(code) };
  }

  /**
   * Marks a restored room's code as live (crash restore, M10-03) without issuing a new epoch.
   * Returns false when the code is already live.
   */
  adopt(code: string): boolean {
    if (this.#live.has(code)) return false;
    const t = this.#reserved.get(code);
    if (t !== undefined) {
      this.o.clock.clearTimeout(t);
      this.#reserved.delete(code);
    }
    this.#live.add(code);
    return true;
  }

  /** The room ended: keep the code reserved for `releaseMs`, then free it. */
  release(code: string): void {
    if (!this.#live.delete(code)) return;
    if (this.o.releaseMs <= 0) return;
    const t = this.o.clock.setTimeout(() => this.#reserved.delete(code), this.o.releaseMs);
    this.#reserved.set(code, t);
  }

  /** Number of live codes. */
  get liveCount(): number {
    return this.#live.size;
  }

  /** Cancels pending release timers. */
  dispose(): void {
    for (const t of this.#reserved.values()) this.o.clock.clearTimeout(t);
    this.#reserved.clear();
  }
}
