export { Future, type Cancel }

import * as F from "fluture"

import { type Result, Success, Failure } from "@lib/result"
import type { FutureInstance } from "fluture"

type Cancel = () => void

type Fut<E, C> = { [K in keyof C]: Future<E, C[K]> }

/**
 * A lazy asynchronous computation that produces either a rejection value
 * of type `E` or a success value of type `T`.
 *
 * Unlike Promises, Futures are not executed until explicitly forked and
 * can be safely cancelled. This is a thin wrapper around Fluture.
 */
class Future<E, T> {
  readonly inner: FutureInstance<E, T>

  /**
   * Build a cancellable `Future` from an imperative body. Return a cancel
   * function from `f` to clean up resources (timers, subscriptions, etc.).
   *
   * ```ts
   * const f = Future.create<never, number>((reject, resolve) => {
   *   const id = setTimeout(() => resolve(42), 1000);
   *   return () => clearTimeout(id);
   * });
   * ```
   */
  static create<E, T>(f: (r: F.RejectFunction<E>, a: F.ResolveFunction<T>) => Cancel | void): Future<E, T> {
    return new Future(
      F.Future((r, a) => {
        const cancel = f(r, a)
        return cancel === undefined ? () => {} : cancel
      })
    )
  }

  /** For inherently uncancellable operations. Prefer `create` when a cancel path exists. */
  static createUncancellable<E, T>(f: (r: F.RejectFunction<E>, a: F.ResolveFunction<T>) => void): Future<E, T> {
    return new Future(
      F.Future((r, a) => {
        f(r, a)
        return () => {} // No-op cancel function
      })
    )
  }

  /** Lift a value into an already-resolved `Future`. */
  static resolve<E, T>(x: T): Future<E, T> {
    return new Future(F.resolve(x))
  }

  /** Lift a value into an already-rejected `Future`. */
  static reject<E, T>(x: E): Future<E, T> {
    return new Future(F.reject(x))
  }

  /**
   * Wrap a `Promise` producer. Always produces `Future<Error, T>` — use
   * `.mapRej()` to narrow the error type. Loses cancellation; use
   * `Future.create` for operations that must be cancellable.
   *
   * Don't double-wrap: pass `() => fn()`, not `async () => { const r = await fn(); return r; }`.
   */
  static attemptP<T>(f: () => Promise<T>): Future<Error, T> {
    return new Future(F.attemptP(f))
  }

  /**
   * Guaranteed resource cleanup. `release` runs whether `consume` succeeds or
   * fails — use for locks, connections, file descriptors.
   */
  static bracket<E, A, B, C>(acquire: Future<E, A>, release: (_: A) => Future<E, C>, consume: (_: A) => Future<E, B>) {
    return new Future(F.hook(acquire.inner)((x) => release(x).inner)((x) => consume(x).inner))
  }

  /** Run `xs` with at most `n` in flight concurrently; results are collected in order. */
  static parallel<E, T>(n: number, xs: Array<Future<E, T>>): Future<E, Array<T>> {
    return new Future(F.parallel(n)(xs.map((f) => f.inner)))
  }

  /**
   * Run a named map of futures concurrently and collect results under the same keys.
   *
   * ```ts
   * Future.concurrently({ user: fetchUser(id), posts: fetchPosts(id) })
   *   .fork(handleError, ({ user, posts }) => render(user, posts));
   * ```
   */
  static concurrently<E, C extends { [k: string]: unknown }>(obj: Fut<E, C>): Future<E, C> {
    const futures: Future<E, Record<string, unknown>>[] = []

    Object.keys(obj).forEach(<K extends string & keyof C>(key: K) => {
      const fut = obj[key] as Future<E, C[K]>
      futures.push(fut.map((value) => ({ [key]: value })))
    })

    return Future.parallel(Infinity, futures).map((results) =>
      results.reduce((acc, x) => Object.assign(acc, x), {} as Record<string, unknown>)
    ) as Future<E, C>
  }

  /** Map `xs` with `f` and run the resulting futures with unbounded concurrency. */
  static mapConcurrently<A, E, T>(f: (_: A) => Future<E, T>, xs: Array<A>): Future<E, Array<T>> {
    return Future.parallel(Infinity, xs.map(f))
  }

  /** Run two futures in parallel and pair their results. */
  static both<E, A, B>(x: Future<E, A>, y: Future<E, B>): Future<E, [A, B]> {
    return new Future(F.both(x.inner)(y.inner))
  }

  /** First to settle wins — useful for timeouts: `Future.race(request, timeout)`. */
  static race<E, T>(x: Future<E, T>, y: Future<E, T>): Future<E, T> {
    return new Future(F.race(x.inner)(y.inner))
  }

  /** Sequential traversal. Use `parallel` or `mapConcurrently` when order doesn't matter. */
  static traverse<A, E, T>(f: (_: A) => Future<E, T>, xs: Array<A>): Future<E, Array<T>> {
    return xs.reduce(
      (acc, x) => acc.chain((ys) => f(x).map((y) => [...ys, y])),
      Future.resolve([]) as Future<E, Array<T>>
    )
  }

  /** Resolve with `value` after `milliseconds`. The timer is cleared if cancelled. */
  static resolveAfter<E, T>(milliseconds: number, value: T): Future<E, T> {
    return Future.create((_, res) => {
      const timer = setTimeout(() => res(value), milliseconds)
      return function cancel() {
        clearTimeout(timer)
      }
    })
  }

  constructor(inner: FutureInstance<E, T>) {
    this.inner = inner
  }

  /** Transform the success value. */
  map<W>(f: (_: T) => W): Future<E, W> {
    return new Future(F.map(f)(this.inner))
  }

  /** Transform the error value; the future stays rejected. */
  mapRej<W>(f: (_: E) => W): Future<W, T> {
    return new Future(F.mapRej(f)(this.inner))
  }

  /** Transform both branches in one call. */
  bimap<F, W>(f: (_: E) => F, g: (_: T) => W): Future<F, W> {
    return this.map(g).mapRej(f)
  }

  /**
   * Sequential async composition. Short-circuits on rejection.
   *
   * ```ts
   * fetchUser(id).chain(u => fetchPosts(u.id).map(posts => ({ u, posts })));
   * ```
   */
  chain<W>(f: (_: T) => Future<E, W>): Future<E, W> {
    const g = (x: T): FutureInstance<E, W> => f(x).inner
    return new Future(F.chain(g)(this.inner))
  }

  /** Recover from rejection by returning a new `Future`. */
  chainRej<F>(f: (_: E) => Future<F, T>): Future<F, T> {
    const g = (x: E): FutureInstance<F, T> => f(x).inner
    return new Future(F.chainRej(g)(this.inner))
  }

  /** Branch on both rejected and resolved paths into a single continuation. */
  bichain<F, W>(f: (_: E) => Future<F, W>, g: (_: T) => Future<F, W>): Future<F, W> {
    const h = (x: E): FutureInstance<F, W> => f(x).inner
    const i = (x: T): FutureInstance<F, W> => g(x).inner
    return new Future(F.bichain(h)(i)(this.inner))
  }

  /** Run `act` for its effects regardless of whether `this` settled with success or failure. */
  finally(act: Future<E, void>): Future<E, T> {
    return new Future(F.lastly(act.inner)(this.inner))
  }

  /**
   * Execute the future. Nothing runs until `fork` is called. Returns a `Cancel`
   * function — store it if cancellation is needed.
   */
  fork(f: (_: E) => void, g: (_: T) => void): Cancel {
    return F.fork(f)(g)(this.inner)
  }

  /** Convert to a native `Promise`, mapping the error branch through `f` to an `Error`. */
  promise(f: (_: E) => Error): Promise<T> {
    return F.promise(this.mapRej(f).inner)
  }

  /** Convert to `Promise<Result<E, T>>` — the returned Promise never rejects. */
  promiseR(): Promise<Result<E, T>> {
    const f: Future<never, Result<E, T>> = this.map<Result<E, T>>(Success).chainRej((e) => Future.resolve(Failure(e)))
    return F.promise(f.inner)
  }
}
