export {
  type FromJSON,
  type Infer,
  Decoder,
  type DecoderOptional,
  type DecoderDef,
  type DecodeResult,
  decode,
  object,
  objectMap,
  pair,
  array,
  string,
  number,
  boolean,
  any,
  json,
  nullP,
  stringNumber,
  undefinedP,
  oneOf,
  maybe,
  nullable,
  stringLiteral,
  stringEnum,
  triple,
  always,
  fail,
  failure,
  succeed,
  both,
  optional,
  optionalNullable,
  optionalMaybe,
  optionalDefault,
  stringified,
  recursive,
}

import { type Result, Success, Failure, traverse } from "@lib/result"
import { type Maybe, Just, Nothing, type Nullable } from "@lib/maybe"
import { List } from "@lib/list"
import { type Json } from "@lib/json/types"
import { isRecord } from "@lib/helpers/object"

/** Infer the type from a decoder definition. */
type Infer<A extends Decoder<unknown>> = A extends Decoder<infer B> ? B : never

/** A type that can be decoded from JSON. */
interface FromJSON<T> {
  decoder(): Decoder<T>
}

/**
 * A type-safe monadic decoder combinator.
 *
 * Use like this:
 *
 * ```ts
 * import * as Decoder from "@lib/json/decoder";
 *
 * type Test = {
 *   one: number;
 *   two: boolean;
 *   three: {
 *     inner: string;
 *   };
 * };
 *
 * const testDecoder: Decoder.Decoder<Test> = Decoder.object({
 *   one: Decoder.number,
 *   two: Decoder.boolean,
 *   three: Decoder.object({
 *     inner: Decoder.string,
 *   }),
 * });
 *
 * const decodeJSON = (s: string) => Decoder.decode(JSON.parse(s), testDecoder);
 * ```
 */
class Decoder<T> {
  readonly run: (input: unknown) => DecodeResult<T>
  constructor(run: (input: unknown) => DecodeResult<T>) {
    this.run = run
  }

  chain<W>(f: (v: T) => Decoder<W>): Decoder<W> {
    return new Decoder((u) => this.run(u).chain((v) => f(v).run(u)))
  }

  map<W>(f: (v: T) => W): Decoder<W> {
    return new Decoder((v) => this.run(v).map<W>(f))
  }
}

function decode<T>(input: unknown, decoder: Decoder<T>): Result<string, T> {
  return decoder.run(input).mapFailure(showPath)
}

function showPath([path, error]: [Path, string]): string {
  return error + ". When parsing: " + Array.from(path).join(".")
}

type DecodeResult<T> = Result<[Path, string], T>
type Path = List<string>

const failure = <T>(msg: string): DecodeResult<T> => Failure([List.empty(), msg])

const fail = <T>(msg: string): Decoder<T> => new Decoder((_) => Failure([List.empty(), msg]))

const always = <T>(v: T): Decoder<T> => new Decoder((_) => Success(v))

/** Prefix a sequence index onto the path of a failed element decode. */
const atIndex = <T>(index: number, result: DecodeResult<T>): DecodeResult<T> =>
  result instanceof Failure ? Failure([List.cons(String(index), result.error[0]), result.error[1]]) : result

const succeed = always

const any: Decoder<unknown> = new Decoder((v) => Success(v))

/** Use two decoders on the same input. */
const both = <T, U>(left: Decoder<T>, right: Decoder<U>): Decoder<[T, U]> =>
  new Decoder((u) => {
    const l = left.run(u)
    if (l instanceof Failure) {
      return new Failure(l.error)
    }

    const r = right.run(u)
    if (r instanceof Failure) {
      return new Failure(r.error)
    }

    return Success([l.value, r.value])
  })

const string: Decoder<string> = new Decoder((v) =>
  typeof v === "string" ? Success(v) : failure("expected string but found " + typeof v)
)

const number: Decoder<number> = new Decoder((v) =>
  typeof v === "number" ? Success(v) : failure("expected number but found " + typeof v)
)

/** A number serialized as a string, e.g. `"12.5"`. The whole string must be numeric. */
const stringNumber: Decoder<number> = string.chain((s) => {
  // `Number("")` is 0, so guard blank input explicitly.
  const v = s.trim() === "" ? NaN : Number(s)
  return Number.isFinite(v) ? succeed(v) : fail("not a valid number: " + s)
})

const boolean: Decoder<boolean> = new Decoder((v) =>
  typeof v === "boolean" ? Success(v) : failure("expected boolean but found " + typeof v)
)

const array = <V>(decodeValue: Decoder<V>): Decoder<Array<V>> =>
  new Decoder((input) => {
    if (!Array.isArray(input)) {
      return failure("expected array but found " + typeof input)
    }

    return traverse(List.from(input.map((v, i) => [i, v] as const)), ([i, v]) => atIndex(i, decodeValue.run(v))).map(
      (list) => Array.from(list)
    )
  })

type DecoderDef<A> = {
  [P in keyof A]: Decoder<A[P]> | DecoderOptional<A[P]>
}

/** Ignores extra properties. */
const object = <A>(decoders: DecoderDef<A>): Decoder<A> =>
  new Decoder((input) => {
    if (!isRecord(input)) {
      return failure("expected object but found " + (Array.isArray(input) ? "array" : typeof input))
    }
    const obj = input as { [P in keyof A]: unknown }

    const result = {} as A
    for (const field in decoders) {
      const decoder = decoders[field]

      const decoded =
        decoder instanceof DecoderOptional ?
          obj[field] === undefined ?
            decoder.decoder.run({ nothing: {} })
          : decoder.decoder.run({ just: obj[field] })
        : decoder.run(obj[field])

      switch (true) {
        case decoded instanceof Success:
          result[field] = decoded.value
          break
        case decoded instanceof Failure: {
          const [path, msg] = decoded.error
          return Failure([List.cons(field, path), msg])
        }
        default:
          return decoded satisfies never
      }
    }

    return Success(result)
  })

type ObjectMap<A> = { [x: string]: A }

const objectMap = <A>(decoder: Decoder<A>): Decoder<ObjectMap<A>> =>
  new Decoder((input) => {
    if (!isRecord(input)) {
      return failure("expected object but found " + (Array.isArray(input) ? "array" : typeof input))
    }

    // object without a prototype or built-in functions.
    const result = Object.create(null) as ObjectMap<A>
    for (const field in input) {
      const decoded = decoder.run(input[field])
      switch (true) {
        case decoded instanceof Success:
          result[field] = decoded.value
          break
        case decoded instanceof Failure: {
          const [path, msg] = decoded.error
          return Failure([List.cons(field, path), msg])
        }
        default:
          return decoded satisfies never
      }
    }

    return Success(result)
  })

const pair = <L, R>(ldecode: Decoder<L>, rdecode: Decoder<R>): Decoder<[L, R]> =>
  new Decoder((input) => {
    if (!Array.isArray(input)) {
      return failure("expected array but found " + typeof input)
    }
    if (input.length !== 2) {
      return failure("expected array with 2 elements but it found " + input.length)
    }
    const [l, r] = input

    return atIndex(0, ldecode.run(l)).chain((left) =>
      atIndex(1, rdecode.run(r)).chain((right) => Success([left, right]))
    )
  })

const triple = <A, B, C>(pA: Decoder<A>, pB: Decoder<B>, pC: Decoder<C>): Decoder<[A, B, C]> =>
  new Decoder((input) => {
    if (!Array.isArray(input)) {
      return failure("expected array but found " + typeof input)
    }
    if (input.length !== 3) {
      return failure("expected array with 3 elements but it found " + input.length)
    }
    const [ia, ib, ic] = input

    return atIndex(0, pA.run(ia)).chain((a) =>
      atIndex(1, pB.run(ib)).chain((b) => atIndex(2, pC.run(ic)).chain((c) => Success([a, b, c])))
    )
  })

const oneOf = <V>(decoders: ReadonlyArray<Decoder<V>>): Decoder<V> =>
  new Decoder((input) => {
    const errors: Array<[Path, string]> = []

    for (const decoder of decoders) {
      const decoded = decoder.run(input)
      if (decoded instanceof Success) {
        return decoded
      }
      errors.push(decoded.error)
    }

    return Failure<[Path, string], V>([List.empty(), errors.map(showPath).join("\n")])
  })

const maybe = <V>(decoder: Decoder<V>): Decoder<Maybe<V>> =>
  oneOf([object({ nothing: object({}) }).map((_) => Nothing<V>()), object({ just: decoder }).map((v) => Just(v.just))])

const nullable = <V>(decoder: Decoder<V>): Decoder<Nullable<V>> => oneOf([nullP, decoder])

const nullP: Decoder<null> = new Decoder((v) =>
  v === null ? Success(null) : failure("expected null but found " + typeof v)
)

const undefinedP: Decoder<undefined> = new Decoder((v) =>
  v === undefined ? Success(undefined) : failure("expected `undefined` " + typeof v)
)

/** Useful for parsing tag names in discriminated unions. */
const stringLiteral = <T extends string>(str: T): Decoder<T> =>
  new Decoder((v) => (v === str ? Success(v as T) : failure(`expected '${str}' but found '${v}'`)))

/**
 * Marks an object field as optional. Absent-field handling comes from
 * the helper that built it: `optionalMaybe` → `Nothing`, `optional` →
 * `undefined`, `optionalNullable` → `null`, `optionalDefault` → `def`.
 */
class DecoderOptional<A> {
  readonly decoder: Decoder<A>
  private constructor(decoder: Decoder<A>) {
    this.decoder = decoder
  }
  static from<A>(d: Decoder<A>): DecoderOptional<Maybe<A>> {
    return new DecoderOptional(maybe(d))
  }

  map<W>(f: (v: A) => W): DecoderOptional<W> {
    return new DecoderOptional(this.decoder.map<W>(f))
  }
}

const optionalMaybe = <V>(decoder: Decoder<V>): DecoderOptional<Maybe<V>> => DecoderOptional.from(decoder)

/** A field that may be absent or hold JSON `null`; both decode as `null`. */
const optionalNullable = <V>(decoder: Decoder<NonNullable<V>>): DecoderOptional<Nullable<V>> =>
  optionalMaybe(nullable(decoder)).map((v) => v.asNullable())

/** An object field that may be absent. */
const optional = <V>(decoder: Decoder<V>): DecoderOptional<V | undefined> =>
  optionalMaybe(decoder).map((v) => (v instanceof Nothing ? undefined : v.value))

/** If the field is absent, the default value will be used. */
const optionalDefault = <V>(def: V, decoder: Decoder<V>): DecoderOptional<V> => {
  return optionalMaybe(decoder).map((v) => v.withDefault(def))
}

/** Define a recursive decoder. */
function recursive<A>(f: (p: Decoder<A>) => Decoder<A>): Decoder<A> {
  const base: Decoder<A> = fail("A recursive decoder cannot immediately call itself.")
  const top = f(base)
  // @ts-expect-error will complain that 'run' is readonly. But we are doing this on purpose here.
  base.run = top.run
  return top
}

const json: Decoder<Json> = recursive((json) =>
  oneOf<Json>([nullP, string, number, boolean, array(json), objectMap(json)])
)

const stringEnum = <const T extends string[]>(strs: T): Decoder<T[number]> => oneOf(strs.map(stringLiteral))

/** Decode a value from a string by treating the string as a stringified JSON value. */
const stringified = <T>(inner: Decoder<T>): Decoder<T> =>
  string
    .chain((str) => {
      try {
        return succeed(JSON.parse(str))
      } catch {
        return fail("Invalid JSON string")
      }
    })
    .chain((json) => new Decoder((_) => inner.run(json)))
