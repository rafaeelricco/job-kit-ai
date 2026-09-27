export {
  type Infer,
  Encoder,
  type EncoderDef,
  type EncoderOptional,
  json,
  boolean,
  number,
  string,
  array,
  object,
  pair,
  maybe,
  nullable,
  triple,
  optional,
  oneOf,
  both,
  stringEnum,
  stringified,
  optionalNullable,
  optionalMaybe,
  recursive,
}

import { type Maybe, Nothing, Just, type Nullable } from "@lib/maybe"
import { type Json, type JsonObject } from "@lib/json/types"

/** Infer the type from an encoder definition. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Infer<A extends Encoder<any>> = A extends Encoder<infer B> ? B : never

/**
 * An Encoder is the opposite of a Decoder.
 *
 * It takes a structured value and transforms it into
 * an object of type Json.
 *
 * ```ts
 * import * as Encoder from "@lib/json/encoder";
 *
 * const user = Encoder.object({
 *   name: Encoder.string,
 *   age: Encoder.number,
 * });
 *
 * user.run({ name: "Ada", age: 36 });
 * ```
 */
class Encoder<A> {
  readonly run: (v: A) => Json
  constructor(f: (v: A) => Json) {
    this.run = f
  }

  rmap<W>(f: (v: W) => A): Encoder<W> {
    return new Encoder((v) => this.run(f(v)))
  }
}

type EncoderDef<A> = {
  [P in keyof A]: Encoder<A[P]> | EncoderOptional<A[P]>
}

const toAny = <T extends Json>(): Encoder<T> => new Encoder((v) => v)

/**
 * Encode two values into a single one.
 * Conflicts result in properties being overwritten.
 */
const both = <T, U>(left: Encoder<T>, right: Encoder<U>): Encoder<[T, U]> =>
  new Encoder(([l, r]) => {
    return Object.assign({}, left.run(l), right.run(r))
  })

const json: Encoder<Json> = toAny()
const boolean: Encoder<boolean> = toAny()
const number: Encoder<number> = new Encoder((input) => {
  if (!Number.isFinite(input)) {
    throw new Error(`Cannot encode non-finite number: ${String(input)}`)
  }
  return input
})

const string: Encoder<string> = toAny()

const array = <A>(encoder: Encoder<A>): Encoder<Array<A>> => new Encoder((input: Array<A>) => input.map(encoder.run))

const object = <A>(encoders: EncoderDef<A>): Encoder<A> =>
  new Encoder((input) => {
    const result = {} as JsonObject
    for (const field in encoders) {
      const encoder = encoders[field]
      switch (true) {
        case encoder instanceof EncoderOptional: {
          const encoded = encoder.encoder.run(input[field])
          if (typeof encoded != "object" || encoded === null || !("nothing" in encoded || "just" in encoded)) {
            throw new Error(`Invalid output of EncoderOptional: ${encoded}`)
          }

          if ("just" in encoded) {
            result[field] = encoded["just"]
          }
          break
        }
        case encoder instanceof Encoder: {
          result[field] = encoder.run(input[field])
          break
        }
        default:
          encoder satisfies never
      }
    }

    return result
  })

const pair = <L, R>(sleft: Encoder<L>, sright: Encoder<R>): Encoder<[L, R]> =>
  new Encoder((input) => {
    const [left, right] = input
    return [sleft.run(left), sright.run(right)]
  })

const triple = <A, B, C>(sA: Encoder<A>, sB: Encoder<B>, sC: Encoder<C>): Encoder<[A, B, C]> =>
  new Encoder((input) => {
    const [a, b, c] = input
    return [sA.run(a), sB.run(b), sC.run(c)]
  })

const maybe = <V>(encoder: Encoder<V>): Encoder<Maybe<V>> =>
  new Encoder((input) => (input instanceof Nothing ? { nothing: {} } : { just: encoder.run(input.value) }) as Json)

const nullable = <V>(encoder: Encoder<V>): Encoder<Nullable<V>> =>
  new Encoder((input) => (input === null ? null : encoder.run(input)))

/** An encoder for object keys that omits the field if the value is Nothing. */
class EncoderOptional<A> {
  readonly encoder: Encoder<A>
  private constructor(encoder: Encoder<A>) {
    this.encoder = encoder
  }

  static from<T>(e: Encoder<Maybe<T>>): EncoderOptional<Maybe<T>> {
    return new EncoderOptional(e)
  }

  rmap<B>(f: (v: B) => A): EncoderOptional<B> {
    return new EncoderOptional(this.encoder.rmap(f))
  }
}

const optionalMaybe = <V>(encoder: Encoder<V>): EncoderOptional<Maybe<V>> => EncoderOptional.from(maybe(encoder))

const optionalNullable = <V>(encoder: Encoder<NonNullable<V>>): EncoderOptional<Nullable<V>> =>
  optionalMaybe(encoder).rmap((v) =>
    v === null ? Nothing()
    : v === undefined ? Nothing()
    : Just<NonNullable<V>>(v)
  )

const optional = <V>(encoder: Encoder<V>): EncoderOptional<V | undefined> =>
  optionalMaybe(encoder).rmap<V | undefined>((input): Maybe<V> => {
    if (typeof input === "undefined") {
      return Nothing() as Maybe<V>
    }
    return Just(input) as Maybe<V>
  })

const oneOf = <V>(f: (v: V) => Encoder<V>): Encoder<V> =>
  new Encoder((input) => {
    const encoder = f(input)
    return encoder.run(input)
  })

const stringEnum = <const T extends string[]>(strs: T): Encoder<T[number]> =>
  string.rmap((input) => {
    if (!strs.includes(input)) {
      throw new Error(`Cannot encode '${input}'. Expected one of '${strs.join(", ")}'"`)
    }
    return input
  })

/** Encode a value into a JSON string by stringifying its JSON representation. */
const stringified = <T>(inner: Encoder<T>): Encoder<T> => string.rmap((v) => JSON.stringify(inner.run(v)))

/** Define a recursive encoder. */
function recursive<A>(f: (p: Encoder<A>) => Encoder<A>): Encoder<A> {
  const base: Encoder<A> = new Encoder((_) => {
    throw new Error("A recursive encoder cannot immediately call itself.")
  })
  const top = f(base)
  // @ts-expect-error assigning to read-only prop
  base.run = top.run
  return top
}
