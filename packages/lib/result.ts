export { type Result, type IResult, CallableSuccess as Success, CallableFailure as Failure, traverse, traverse_ }

import { type Trampoline, end, tailRecursive } from "@lib/trampoline"
import { List } from "@lib/list"

import Callable from "@lib/callable"

/**
 * Represents the result of a computation that may fail.
 *
 * Either `Success<E, T>` wrapping a successful value, or `Failure<E, T>`
 * wrapping an error value.
 *
 * ```ts
 * const r: Result<string, number> = Success(42);
 * switch (true) {
 *   case r instanceof Success:
 *     r.value;
 *     break;
 *   case r instanceof Failure:
 *     r.error;
 *     break;
 *   default:
 *     r satisfies never;
 * }
 * ```
 */
type Result<E, T> = Success<E, T> | Failure<E, T>

interface IResult<E, T> {
  isSuccess(): boolean
  isFailure(): boolean
  map<W>(f: (t: T) => W): Result<E, W>
  mapFailure<W>(f: (t: E) => W): Result<W, T>
  either<W>(f: (e: E) => W, g: (s: T) => W): W
  chain<W>(f: (t: T) => Result<E, W>): Result<E, W>
  unwrap(f: (e: E) => string): T
  withDefault(f: (e: E) => T): T
}

/** Wrap a computed value. Use to return from a fallible operation that succeeded. */
class Success<E, T> implements IResult<E, T> {
  readonly value: T

  static new<E, T>(v: T): Success<E, T> {
    return new Success(v)
  }
  constructor(v: T) {
    this.value = v
  }

  /** Returns true if this is a `Success`. Prefer `instanceof Success` for narrowing. */
  isSuccess() {
    return true
  }
  /** Returns true if this is a `Failure`. Prefer `instanceof Failure` for narrowing. */
  isFailure() {
    return false
  }
  /** Transform the success value; `Failure` passes through unchanged. */
  map<W>(f: (t: T) => W): Result<E, W> {
    return new Success(f(this.value))
  }
  /** Transform the error value; `Success` passes through unchanged. */
  mapFailure<W>(_: (t: E) => W): Result<W, T> {
    return new Success(this.value)
  }
  /** Exhaustive fold: `f(error)` on `Failure`, `g(value)` on `Success`. */
  either<W>(_: (e: E) => W, g: (s: T) => W): W {
    return g(this.value)
  }
  /** Monadic sequencing. Short-circuits on the first `Failure`. */
  chain<W>(f: (t: T) => Result<E, W>): Result<E, W> {
    return f(this.value)
  }
  /**
   * Unwrap the value or throw an `Error` built from `f(error)`. Boundary-only —
   * don't mix with try/catch; use `either` or `withDefault` in business logic.
   */
  unwrap(_: (e: E) => string): T {
    return this.value
  }
  /** Recover from `Failure` by mapping the error to a default value. */
  withDefault(_: (e: E) => T) {
    return this.value
  }
}

/** Wrap an error value. Return from a fallible operation instead of throwing — reserve `throw` for catastrophic bugs. */
class Failure<E, T> implements IResult<E, T> {
  readonly error: E

  static new<E, T>(v: E): Failure<E, T> {
    return new Failure(v)
  }
  constructor(v: E) {
    this.error = v
  }

  /** Returns true if this is a `Success`. Prefer `instanceof Success` for narrowing. */
  isSuccess() {
    return false
  }
  /** Returns true if this is a `Failure`. Prefer `instanceof Failure` for narrowing. */
  isFailure() {
    return true
  }
  /** Transform the success value; `Failure` passes through unchanged. */
  map<W>(_: (t: T) => W): Result<E, W> {
    return new Failure(this.error)
  }
  /** Transform the error value; `Success` passes through unchanged. */
  mapFailure<W>(f: (t: E) => W): Result<W, T> {
    return new Failure(f(this.error))
  }
  /** Exhaustive fold: `f(error)` on `Failure`, `g(value)` on `Success`. */
  either<W>(f: (e: E) => W, _: (s: T) => W): W {
    return f(this.error)
  }
  /** Monadic sequencing. Short-circuits on the first `Failure`. */
  chain<W>(_: (t: T) => Result<E, W>): Result<E, W> {
    return new Failure(this.error)
  }
  /**
   * Unwrap the value or throw an `Error` built from `f(error)`. Boundary-only —
   * don't mix with try/catch; use `either` or `withDefault` in business logic.
   */
  unwrap(f: (error: E) => string): T {
    throw new Error(f(this.error))
  }
  /** Recover from `Failure` by mapping the error to a default value. */
  withDefault(f: (e: E) => T) {
    return f(this.error)
  }
}

/** Traverse a `List<A>` with a fallible fn. Short-circuits on the first `Failure`. */
function traverse<T, A, E>(xs: List<A>, f: (v: A) => Result<E, T>): Result<E, List<T>> {
  const go: (done: List<T>, todo: List<A>) => Trampoline<Result<E, List<T>>> = tailRecursive((done, todo) => {
    switch (true) {
      case "head" in todo.value: {
        const { head, tail } = todo.value
        const r = f(head)
        switch (true) {
          case r instanceof Success: {
            const value = r.value
            return go(List.cons(value, done), tail)
          }
          case r instanceof Failure:
            return end(new Failure(r.error))
          default:
            return r satisfies never
        }
      }
      case "empty" in todo.value:
        return end(new Success(done.reverse()))
      default:
        return todo.value satisfies never
    }
  })

  return go(List.empty(), xs).run()
}

/** Array version of `traverse`. Short-circuits on the first `Failure`. */
function traverse_<T, A, E>(xs: Array<A>, f: (v: A) => Result<E, T>): Result<E, Array<T>> {
  return traverse(List.from(xs), f).map((r) => r.toArray())
}

const CallableSuccess = Callable(Success) as typeof Success & typeof Success.new

const CallableFailure = Callable(Failure) as typeof Failure & typeof Failure.new
