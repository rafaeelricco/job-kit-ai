export { type Trampoline, tailRecursive, end, fix }

/**
 * A value that represents a suspended recursive computation.
 *
 * Use `tailRecursive` or `fix` to build trampolined functions that won't
 * blow the stack on deeply recursive calls. Call `.run()` to evaluate.
 *
 * ```ts
 * import { end, tailRecursive } from "@lib/trampoline";
 *
 * const sum = tailRecursive((n: number, acc: number) =>
 *   n === 0 ? end(acc) : sum(n - 1, acc + n)
 * );
 *
 * sum(10_000, 0).run(); // 50005000
 * ```
 */
type Trampoline<A> = End<A> | Rec<A> | Bind<A>

/**
 * Evaluate a trampoline in constant stack space.
 *
 * Every iteration performs one step: force a `Rec`, apply a continuation to
 * a finished `End`, or re-associate a left-nested `Bind` into a right-nested
 * one. No step recurses into `run`, so depth never reaches the JS stack.
 */
function run<A>(tramp: Trampoline<A>): A {
  let current: Trampoline<A> = tramp
  for (;;) {
    if (current instanceof End) {
      return current.value
    }
    if (current instanceof Rec) {
      current = current.fun()
    } else {
      current = current.step()
    }
  }
}

const rec = <A>(f: () => Trampoline<A>): Trampoline<A> => new Rec(f)

const end = <A>(v: A): Trampoline<A> => new End(v)

const bind = <A, B>(inner: Trampoline<A>, continuation: (v: A) => Trampoline<B>): Trampoline<B> =>
  new Bind((k) => k(inner, continuation))

class End<A> {
  value: A
  constructor(v: A) {
    this.value = v
  }
  run(): A {
    return run(this)
  }
  map<B>(f: (v: A) => B): Trampoline<B> {
    return end(f(this.value))
  }
}

class Rec<A> {
  fun: () => Trampoline<A>
  constructor(f: () => Trampoline<A>) {
    this.fun = f
  }
  run(): A {
    return run(this)
  }
  map<B>(f: (v: A) => B): Trampoline<B> {
    return bind(this, (v) => end(f(v)))
  }
}

/** A `Bind` consumer, polymorphic in the hidden intermediate type `A`. */
type BindFold<B, R> = <A>(inner: Trampoline<A>, continuation: (v: A) => Trampoline<B>) => R

/**
 * A deferred transformation of another trampoline. The intermediate value
 * type is existential: it is only reachable through `fold`, which keeps the
 * `inner`/`continuation` pairing type-safe without erasing either side.
 */
class Bind<B> {
  readonly fold: <R>(k: BindFold<B, R>) => R
  constructor(fold: <R>(k: BindFold<B, R>) => R) {
    this.fold = fold
  }
  run(): B {
    return run(this)
  }
  map<C>(f: (v: B) => C): Trampoline<C> {
    return bind(this, (v) => end(f(v)))
  }
  /** Advance one step toward a value without growing the stack. */
  step(): Trampoline<B> {
    return this.fold((inner, continuation) => {
      if (inner instanceof End) {
        return continuation(inner.value)
      }
      if (inner instanceof Rec) {
        return bind(inner.fun(), continuation)
      }
      // Re-associate `(x >>= g) >>= f` into `x >>= (v => g(v) >>= f)`.
      return inner.fold((innermost, first) => bind(innermost, (v) => bind(first(v), continuation)))
    })
  }
}

type Fun<A extends unknown[], B> = (...args: A) => B

function fix<A extends unknown[], R>(
  f: Fun<[Fun<A, Trampoline<R>>, (r: R) => Trampoline<R>], Fun<A, Trampoline<R>>>
): Fun<A, R> {
  let lazy_f: Fun<A, Trampoline<R>> = (..._: A) => {
    throw new Error("recursion error")
  }
  const recurse: Fun<A, Trampoline<R>> = (...args: A) => rec(() => lazy_f(...args))
  lazy_f = f(recurse, end)
  return (...args: A) => lazy_f(...args).run()
}

function tailRecursive<A extends unknown[], R>(f: Fun<A, Trampoline<R>>): Fun<A, Trampoline<R>> {
  return (...args: A) => rec(() => f(...args))
}
