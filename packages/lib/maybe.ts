export {
  type Maybe,
  type Nullable,
  type Infer,
  type IMaybe,
  CallableJust as Just,
  CallableNothing as Nothing,
  fromOptional,
  fromNullable,
  catMaybes,
  mapMaybe,
}

import Callable from "@lib/callable"

/**
 * A type which represents the existence or absence of a value in a
 * robust and unambiguous manner.
 *
 * Values can be extracted using `instanceof` tests.
 *
 * ```ts
 * switch (true) {
 *   case x instanceof Just:
 *     // use x.value here
 *     break;
 *   case x instanceof Nothing:
 *     break;
 *   default:
 *     x satisfies never;
 * }
 * ```
 */
type Maybe<T> = Just<T> | Nothing<T>

type Nullable<T> = T | null

/** Infer the type from a Maybe definition. */
type Infer<A extends Maybe<unknown>> = A extends Maybe<infer B> ? B : never

// prettier-ignore
interface IMaybe<T> {
  isJust() : boolean;
  isNothing() : boolean;
  map<W>(f: (t: T) => W) : Maybe<W>
  withDefault(def: T) : T
  expect(msg : string) : T
  maybe<W>(def: W, f: (t: T) => W) : W
  unwrap<W>(f: () => W, g: (t:T) => W) : W
  chain<W>(f : (t: T) => Maybe<W>) : Maybe<W>
  alt(other: Maybe<T>) : Maybe<T>
  asNullable() : Nullable<T>
}

/** Wrap a present value. Use at system boundaries or to lift a value into a `Maybe<T>`. */
// prettier-ignore
class Just<T> implements IMaybe<T> {
  static new<W>(v:W) : Just<W> { return new Just(v); }

  readonly value : T;
  constructor(v: T) { this.value = v; }
  toString() {
    return `Just(${this.value})`;
  }

  /** Returns true if this is a `Just`. Prefer `instanceof Just` — booleans don't narrow the type. */
  isJust() { return true; }
  /** Returns true if this is a `Nothing`. Prefer `instanceof Nothing` — booleans don't narrow the type. */
  isNothing() { return false; }
  /** Transform the contained value if present; `Nothing` passes through unchanged. */
  map<W>(f: (t: T) => W) : Maybe<W> { return new Just(f(this.value)); }
  /** Unwrap the value, returning `def` if this is a `Nothing`. */
  withDefault(_: T) { return this.value; }
  /**
   * Unwrap the value or throw `new Error(msg)`. Only use for catastrophic
   * programmer bugs — use `withDefault` or `maybe` for recoverable absence.
   */
  expect(_ : string) : T { return this.value }
  /** Fold into a `W`: return `def` for `Nothing`, else apply `f` to the value. */
  maybe<W>(_: W, f: (t: T) => W) : W { return f(this.value); }
  /** Exhaustive two-branch fold: `f()` on `Nothing`, `g(value)` on `Just`. */
  unwrap<W>(_: () => W, g: (t:T) => W) : W { return g(this.value); }
  /** Monadic bind. Use when `f` returns `Maybe<W>` — avoids `Maybe<Maybe<W>>`. */
  chain<W>(f : (t: T) => Maybe<W>) : Maybe<W> { return f(this.value); }
  /** Fallback to `other` if this is a `Nothing`. Chainable: `primary.alt(secondary).alt(fallback)`. */
  alt(_: Maybe<T>) : Maybe<T> { return this }
  /** Convert to `T | null` at a system boundary. */
  asNullable() { return this.value }
}

/** Represent absence. Use instead of returning `null`/`undefined` from domain code. */
// prettier-ignore
class Nothing<T> implements IMaybe<T> {
  static new<T>() : Nothing<T> { return new Nothing(); }
  constructor() {}
  toString() {
    return "Nothing()";
  }

  /** Returns true if this is a `Just`. Prefer `instanceof Just` — booleans don't narrow the type. */
  isJust() { return false; }
  /** Returns true if this is a `Nothing`. Prefer `instanceof Nothing` — booleans don't narrow the type. */
  isNothing() { return true; }
  /** Transform the contained value if present; `Nothing` passes through unchanged. */
  map<W>(_: (t: T) => W) : Maybe<W> { return new Nothing(); }
  /** Unwrap the value, returning `def` if this is a `Nothing`. */
  withDefault(d: T) { return d; }
  /**
   * Unwrap the value or throw `new Error(msg)`. Only use for catastrophic
   * programmer bugs — use `withDefault` or `maybe` for recoverable absence.
   */
  expect(msg : string) : T { throw new Error(msg); }
  /** Fold into a `W`: return `def` for `Nothing`, else apply `f` to the value. */
  maybe<W>(def: W, _: (t: T) => W) : W { return def; }
  /** Exhaustive two-branch fold: `f()` on `Nothing`, `g(value)` on `Just`. */
  unwrap<W>(f: () => W, _: (t:T) => W) : W { return f(); }
  /** Monadic bind. Use when `f` returns `Maybe<W>` — avoids `Maybe<Maybe<W>>`. */
  chain<W>(_ : (t: T) => Maybe<W>) : Maybe<W> {
    return new Nothing();
  }
  /** Fallback to `other` if this is a `Nothing`. Chainable: `primary.alt(secondary).alt(fallback)`. */
  alt(other: Maybe<T>) : Maybe<T> { return other; }
  /** Convert to `T | null` at a system boundary. */
  asNullable() : Nullable<T> { return null }
}

/**
 * Boundary helper: `undefined` becomes `Nothing`, any other value becomes `Just`.
 * Don't mix with `fromNullable`.
 *
 * ```ts
 * fromOptional(undefined); // Nothing
 * fromOptional(0);         // Just(0)
 * ```
 */
function fromOptional<T>(v: undefined | T): Maybe<T> {
  if (typeof v === "undefined") {
    return new Nothing()
  } else {
    return new Just(v)
  }
}

/**
 * Boundary helper: `null` becomes `Nothing`, any other value becomes `Just`.
 * Don't mix with `fromOptional`.
 *
 * ```ts
 * fromNullable(null); // Nothing
 * fromNullable(0);    // Just(0)
 * ```
 */
function fromNullable<T>(v: NonNullable<T> | null): Maybe<T> {
  if (v === null) {
    return new Nothing()
  } else {
    return new Just(v)
  }
}

/** Remove Nothings from an array. */
function catMaybes<T>(xs: Array<Maybe<T>>): Array<T> {
  const r: Array<T> = []
  for (const x of xs) {
    x.map((v) => r.push(v))
  }
  return r
}

/** Map and filter using maybes. */
function mapMaybe<T, W>(xs: Array<T>, f: (v: T) => Maybe<W>): Array<W> {
  const r: Array<W> = []
  for (const x of xs) {
    f(x).map((v) => r.push(v))
  }
  return r
}

/* eslint-disable no-var */
var CallableJust = Callable(Just) as typeof Just & typeof Just.new
var CallableNothing = Callable(Nothing) as typeof Nothing & typeof Nothing.new
