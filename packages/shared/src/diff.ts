/**
 * Structural JSON diff/patch for view sync (SPEC §9.6): the server sends `patch` messages whose
 * `ops` come from {@link diff}, and clients rebuild the next view with {@link apply}.
 *
 * Semantics (both functions agree on them):
 * - Paths are arrays of segments: `string` keys into objects, integer `number` indices into
 *   arrays. The empty path is the root.
 * - `set` writes a value. On an array, the index may be at most `length` (`length` appends).
 * - `del` removes an object key, or splices an array element out (later elements shift down).
 *   {@link diff} only ever deletes the last element of an array, so shifting never matters for
 *   its own output.
 * - Values are JSON: an object key whose value is `undefined` is treated as absent (that is what
 *   JSON.stringify does on the wire).
 *
 * {@link apply} never mutates its input: it copies only the containers along changed paths and
 * shares everything else with `prev`.
 *
 * @module
 */
import type { PatchOp } from "./protocol.ts";

/** A JSON value. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

type Path = (string | number)[];
type Obj = Record<string, unknown>;

/** Thrown by {@link apply} when an op does not fit the document (clients answer with `resync`). */
export class PatchError extends Error {
  constructor(
    message: string,
    /** Index of the failing op within the ops array. */
    readonly opIndex: number,
  ) {
    super(message);
    this.name = "PatchError";
  }
}

/**
 * The ops that turn `prev` into `next`, such that `apply(prev, diff(prev, next))` deep-equals
 * `next`. Returns `[]` when they are already equal. Unchanged subtrees are skipped by reference
 * first, so diffing successive immutable views costs time proportional to what changed.
 *
 * When an array would need more ops than it has elements (for example after an insertion at the
 * front shifts everything), the whole array is sent as one `set` instead.
 */
export function diff(prev: unknown, next: unknown): PatchOp[] {
  const ops: PatchOp[] = [];
  walk(prev, next, [], ops);
  return ops;
}

function walk(a: unknown, b: unknown, path: Path, ops: PatchOp[]): void {
  if (a === b) return;
  if (Array.isArray(a) && Array.isArray(b)) {
    const start = ops.length;
    const shared = Math.min(a.length, b.length);
    for (let i = 0; i < shared; i++) walk(a[i], b[i], [...path, i], ops);
    for (let i = a.length; i < b.length; i++)
      ops.push({ op: "set", path: [...path, i], value: b[i] });
    for (let i = a.length - 1; i >= b.length; i--) ops.push({ op: "del", path: [...path, i] });
    // Many element ops (e.g. after an insertion shifted everything): send the array whole when
    // that is no bigger on the wire. Only measured when there is more than one op.
    if (ops.length - start > 1 && jsonSize(ops.slice(start)) >= jsonSize(b) + 24) {
      ops.length = start;
      ops.push({ op: "set", path, value: b });
    }
    return;
  }
  if (isObject(a) && isObject(b)) {
    for (const key of Object.keys(a)) {
      if (a[key] !== undefined && getOwn(b, key) === undefined) {
        ops.push({ op: "del", path: [...path, key] });
      }
    }
    for (const key of Object.keys(b)) {
      const value = b[key];
      if (value === undefined) continue;
      const old = getOwn(a, key);
      if (old === undefined) ops.push({ op: "set", path: [...path, key], value });
      else walk(old, value, [...path, key], ops);
    }
    return;
  }
  if (typeof a === "number" && typeof b === "number" && Number.isNaN(a) && Number.isNaN(b)) return;
  ops.push({ op: "set", path, value: b });
}

/**
 * Applies `ops` to `prev` and returns the new document. `prev` is not modified; unchanged
 * subtrees are shared with it.
 * @throws PatchError if a path does not exist, a segment has the wrong type for its container,
 * an array index is out of range, or the root is deleted.
 */
export function apply<T = unknown>(prev: unknown, ops: readonly PatchOp[]): T {
  let root: unknown = prev;
  /** Containers created by this call, which may be mutated in place. */
  const owned = new WeakSet<object>();

  const own = (container: unknown[] | Obj): unknown[] | Obj => {
    if (owned.has(container)) return container;
    const copy = Array.isArray(container) ? container.slice() : copyObject(container);
    owned.add(copy);
    return copy;
  };

  for (let index = 0; index < ops.length; index++) {
    const op = ops[index] as PatchOp;
    const fail = (why: string): never => {
      throw new PatchError(
        `patch op ${index} (${op.op} ${JSON.stringify(op.path)}): ${why}`,
        index,
      );
    };
    if (!Array.isArray(op.path)) fail("path must be an array");
    const { path } = op;

    if (path.length === 0) {
      if (op.op === "del") fail("cannot delete the root");
      root = (op as { value: unknown }).value;
      continue;
    }

    // Walk down, copying each container on the way so the final write lands in an owned copy.
    if (!isContainer(root)) fail("root is not an object or array");
    root = own(root as unknown[] | Obj);
    let parent = root as unknown[] | Obj;
    for (let depth = 0; depth < path.length - 1; depth++) {
      const seg = path[depth] as string | number;
      const child = read(parent, seg, fail);
      if (!isContainer(child)) fail(`segment ${depth} does not lead to an object or array`);
      const copy = own(child as unknown[] | Obj);
      write(parent, seg, copy, fail);
      parent = copy;
    }

    const last = path[path.length - 1] as string | number;
    if (op.op === "set") {
      write(parent, last, op.value, fail);
    } else if (op.op === "del") {
      remove(parent, last, fail);
    } else {
      fail(`unknown op ${JSON.stringify((op as { op: unknown }).op)}`);
    }
  }
  return root as T;
}

function read(
  container: unknown[] | Obj,
  seg: string | number,
  fail: (why: string) => never,
): unknown {
  if (Array.isArray(container)) {
    if (!isIndex(seg) || seg >= container.length)
      fail(`array index ${String(seg)} is out of range`);
    return container[seg as number];
  }
  if (typeof seg !== "string") fail(`object key must be a string, got ${typeof seg}`);
  if (!Object.hasOwn(container, seg)) fail(`key ${JSON.stringify(seg)} does not exist`);
  return container[seg as string];
}

function write(
  container: unknown[] | Obj,
  seg: string | number,
  value: unknown,
  fail: (why: string) => never,
): void {
  if (Array.isArray(container)) {
    if (!isIndex(seg) || seg > container.length) fail(`array index ${String(seg)} is out of range`);
    container[seg as number] = value;
    return;
  }
  if (typeof seg !== "string") fail(`object key must be a string, got ${typeof seg}`);
  // defineProperty, not assignment: a key such as "__proto__" must become an own data property.
  Object.defineProperty(container, seg as string, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function remove(
  container: unknown[] | Obj,
  seg: string | number,
  fail: (why: string) => never,
): void {
  if (Array.isArray(container)) {
    if (!isIndex(seg) || seg >= container.length)
      fail(`array index ${String(seg)} is out of range`);
    container.splice(seg as number, 1);
    return;
  }
  if (typeof seg !== "string") fail(`object key must be a string, got ${typeof seg}`);
  if (!Object.hasOwn(container, seg)) fail(`key ${JSON.stringify(seg)} does not exist`);
  delete container[seg as string];
}

function copyObject(source: Obj): Obj {
  const copy: Obj = {};
  for (const key of Object.keys(source)) {
    Object.defineProperty(copy, key, {
      value: source[key],
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return copy;
}

function jsonSize(value: unknown): number {
  return JSON.stringify(value).length;
}

/** Reads an own property only: `{}["__proto__"]` must not see `Object.prototype`. */
function getOwn(source: Obj, key: string): unknown {
  return Object.hasOwn(source, key) ? source[key] : undefined;
}

function isObject(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isContainer(value: unknown): boolean {
  return typeof value === "object" && value !== null;
}

function isIndex(seg: unknown): seg is number {
  return typeof seg === "number" && Number.isInteger(seg) && seg >= 0;
}
