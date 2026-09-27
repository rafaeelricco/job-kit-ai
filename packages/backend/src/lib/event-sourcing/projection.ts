export { accept }

import * as d from "@lib/json/decoder"
import * as s from "@lib/json/schema"

import { type Maybe, Nothing, Just } from "@lib/maybe"

type Decoder<T> = d.Decoder<T>
type Schema<T> = s.Schema<T>

/**
 * `Schema<any>` mirrors `@lib/json/schema`'s own `Infer<A extends Schema<any>>`
 * bound (see its definition) — `s.Infer<T[number]["schema"]>` below needs
 * `T[number]["schema"]` to satisfy that exact constraint. `T` itself is
 * still inferred from the concrete array of event classes at each call site
 * (e.g. `accept([NoteCreated, NoteUpdated, NoteDeleted])`), so no precision
 * is lost there; only the abstract bound checked inside this function's
 * body needs the `any`.
 */
type EventConstructor = { type: string; schema: Schema<any> }

/**
 * Given some event classes, creates a decoder for those classes.
 * Makes sure to error if decoding those class object fail, but
 * succeeds if the encoded event was of another class.
 *
 * To be used in decoding events for projections and reactions.
 *
 * ```ts
 * accept([NoteCreated, NoteUpdated, NoteDeleted])
 * ```
 */
function accept<T extends [...EventConstructor[]]>(ts: T): Decoder<Maybe<s.Infer<T[number]["schema"]>>> {
  type Ty = s.Infer<T[number]["schema"]>
  return d.object({ type: d.string }).chain(({ type: ty }) => {
    const c = ts.find((t) => t.type === ty)
    return c ? (c.schema.decoder.map(Just) as Decoder<Maybe<Ty>>) : d.succeed(Nothing())
  })
}
