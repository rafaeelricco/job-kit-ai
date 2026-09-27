export {
  type RemoteData,
  CallableSuccess as Ready,
  CallableFailure as Failed,
  CallableNotAsked as NotAsked,
  CallableLoading as Loading,
}

import { type Nullable, type Maybe, Nothing, Just } from "@lib/maybe"

import Callable from "@lib/callable"

/**
 * Represents the state of data that is fetched from a remote source.
 *
 * A value is either not yet requested, loading, failed with an error, or
 * successfully loaded (`Ready`).
 *
 * ```ts
 * const data: RemoteData<string, User> = Ready(user);
 * switch (true) {
 *   case data instanceof NotAsked:
 *   case data instanceof Loading:
 *     break;
 *   case data instanceof Failed:
 *     data.error;
 *     break;
 *   case data instanceof Ready:
 *     data.value;
 *     break;
 *   default:
 *     data satisfies never;
 * }
 * ```
 */
type RemoteData<E, T> = NotAsked<E, T> | Loading<E, T> | Failed<E, T> | Ready<E, T>

interface IRemoteData<E, T> {
  map<W>(f: (t: T) => W): RemoteData<E, W>
  chain<W>(f: (t: T) => RemoteData<E, W>): RemoteData<E, W>
  unwrapFailure<W>(def: W, f: (e: E) => W): W
  toMaybe(): Maybe<T>
  readonly isLoading: boolean
  readonly isReady: boolean
  readonly isFailed: boolean
}

/**
 * Initial state: the request hasn't been made yet. For "asked but empty",
 * use `Ready([])` instead — `NotAsked` is not a generic "no data" state.
 */
class NotAsked<E, T> implements IRemoteData<E, T> {
  // @ts-expect-error Unused _tag's existence prevents structural comparison
  private readonly _tag: null = null
  static new<E, T>(): NotAsked<E, T> {
    return new NotAsked()
  }
  /** Transform only if `Ready`; `Loading`/`Failed`/`NotAsked` pass through unchanged. */
  map<W>(_: (t: T) => W): RemoteData<E, W> {
    return new NotAsked()
  }
  /** Chain a `RemoteData`-returning fn without double-wrapping. */
  chain<W>(_: (t: T) => RemoteData<E, W>) {
    return new NotAsked<E, W>()
  }
  /** Return `f(error)` on `Failed`, otherwise return `def`. */
  unwrapFailure<W>(def: W, _: (e: E) => W): W {
    return def
  }
  /** Collapse to `Just(value)` on `Ready`, otherwise `Nothing`. */
  toMaybe(): Maybe<T> {
    return Nothing()
  }
  /** `true` only in `Loading`. Prefer `instanceof Loading` + `satisfies never` for exhaustive narrowing. */
  readonly isLoading = false
  /** `true` only in `Ready`. Prefer `instanceof Ready` + `satisfies never` for exhaustive narrowing. */
  readonly isReady = false
  /** `true` only in `Failed`. Prefer `instanceof Failed` + `satisfies never` for exhaustive narrowing. */
  readonly isFailed = false
}

type Bytes = number

type LoadingDetails = {
  uploaded: Bytes
  uploadSize: Nullable<Bytes>
  downloaded: Bytes
  downloadSize: Nullable<Bytes>
}

/** In-flight state. Optionally carries upload/download progress via `details`. */
class Loading<E, T> implements IRemoteData<E, T> {
  // @ts-expect-error Unused _tag's existence prevents structural comparison
  private readonly _tag: null = null
  readonly uploaded: Bytes
  readonly uploadSize: Nullable<Bytes>
  readonly downloaded: Bytes
  readonly downloadSize: Nullable<Bytes>
  constructor(details: Nullable<LoadingDetails> = null) {
    this.uploaded = details?.uploaded ?? 0
    this.uploadSize = details?.uploadSize ?? null
    this.downloaded = details?.downloaded ?? 0
    this.downloadSize = details?.downloadSize ?? null
  }

  static new<E, T>(details: Nullable<LoadingDetails> = null): Loading<E, T> {
    return new Loading(details)
  }

  /** Transform only if `Ready`; `Loading`/`Failed`/`NotAsked` pass through unchanged. */
  map<W>(_: (t: T) => W): RemoteData<E, W> {
    return new Loading<E, W>(this)
  }
  /** Chain a `RemoteData`-returning fn without double-wrapping. */
  chain<W>(_: (t: T) => RemoteData<E, W>) {
    return new Loading<E, W>(this)
  }
  /** Return `f(error)` on `Failed`, otherwise return `def`. */
  unwrapFailure<W>(def: W, _: (e: E) => W): W {
    return def
  }
  /** Collapse to `Just(value)` on `Ready`, otherwise `Nothing`. */
  toMaybe(): Maybe<T> {
    return Nothing()
  }
  /** `true` only in `Loading`. Prefer `instanceof Loading` + `satisfies never` for exhaustive narrowing. */
  readonly isLoading = true
  /** `true` only in `Ready`. Prefer `instanceof Ready` + `satisfies never` for exhaustive narrowing. */
  readonly isReady = false
  /** `true` only in `Failed`. Prefer `instanceof Failed` + `satisfies never` for exhaustive narrowing. */
  readonly isFailed = false
}

/** Terminal failure state carrying the error payload. */
class Failed<E, T> implements IRemoteData<E, T> {
  // @ts-expect-error Unused _tag's existence prevents structural comparison
  private readonly _tag: null = null
  readonly error: E
  static new<E, T>(e: E): Failed<E, T> {
    return new Failed(e)
  }
  constructor(e: E) {
    this.error = e
  }
  /** Transform only if `Ready`; `Loading`/`Failed`/`NotAsked` pass through unchanged. */
  map<W>(_: (t: T) => W): RemoteData<E, W> {
    return new Failed(this.error)
  }
  /** Chain a `RemoteData`-returning fn without double-wrapping. */
  chain<W>(_: (t: T) => RemoteData<E, W>) {
    return new Failed<E, W>(this.error)
  }
  /** Return `f(error)` on `Failed`, otherwise return `def`. */
  unwrapFailure<W>(_: W, f: (e: E) => W): W {
    return f(this.error)
  }
  /** Collapse to `Just(value)` on `Ready`, otherwise `Nothing`. */
  toMaybe(): Maybe<T> {
    return Nothing()
  }
  /** `true` only in `Loading`. Prefer `instanceof Loading` + `satisfies never` for exhaustive narrowing. */
  readonly isLoading = false
  /** `true` only in `Ready`. Prefer `instanceof Ready` + `satisfies never` for exhaustive narrowing. */
  readonly isReady = false
  /** `true` only in `Failed`. Prefer `instanceof Failed` + `satisfies never` for exhaustive narrowing. */
  readonly isFailed = true
}

/** Terminal success state carrying the loaded value. */
class Ready<E, T> implements IRemoteData<E, T> {
  // @ts-expect-error Unused _tag's existence prevents structural comparison
  private readonly _tag: null = null
  static new<E, T>(v: T): Ready<E, T> {
    return new Ready(v)
  }
  readonly value: T
  constructor(v: T) {
    this.value = v
  }
  /** Transform only if `Ready`; `Loading`/`Failed`/`NotAsked` pass through unchanged. */
  map<W>(f: (t: T) => W): RemoteData<E, W> {
    return new Ready(f(this.value))
  }
  /** Chain a `RemoteData`-returning fn without double-wrapping. */
  chain<W>(f: (t: T) => RemoteData<E, W>) {
    return f(this.value)
  }
  /** Return `f(error)` on `Failed`, otherwise return `def`. */
  unwrapFailure<W>(def: W, _: (e: E) => W): W {
    return def
  }
  /** Collapse to `Just(value)` on `Ready`, otherwise `Nothing`. */
  toMaybe(): Maybe<T> {
    return Just(this.value)
  }
  /** `true` only in `Loading`. Prefer `instanceof Loading` + `satisfies never` for exhaustive narrowing. */
  readonly isLoading = false
  /** `true` only in `Ready`. Prefer `instanceof Ready` + `satisfies never` for exhaustive narrowing. */
  readonly isReady = true
  /** `true` only in `Failed`. Prefer `instanceof Failed` + `satisfies never` for exhaustive narrowing. */
  readonly isFailed = false
}

const CallableNotAsked = Callable(NotAsked) as typeof NotAsked & typeof NotAsked.new

const CallableLoading = Callable(Loading) as typeof Loading & typeof Loading.new

const CallableFailure = Callable(Failed) as typeof Failed & typeof Failed.new

const CallableSuccess = Callable(Ready) as typeof Ready & typeof Ready.new
