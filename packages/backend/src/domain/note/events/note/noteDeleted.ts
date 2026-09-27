export { NoteDeleted }

import * as s from "@lib/json/schema"

import { type EventInfo, Id, toSchema, TransformationEvent } from "@be/lib/event-sourcing/event"
import { Note } from "@be/domain/note/aggregate/note"

const type = "NoteDeleted" as const
const args = s.object({
  type: s.stringLiteral(type),
  aggregateId: Id.schema<"Note">(),
})

/** The event tombstoning a note: the aggregate stays, marked `Deleted`. */
class NoteDeleted extends TransformationEvent<Note> {
  static readonly aggregate = Note
  static readonly type = type
  static readonly schema = toSchema(this, args)

  readonly values: s.Infer<typeof args>
  constructor(values: s.Infer<typeof args>) {
    super()
    this.values = values
  }

  transformAggregate(aggregate: Note, info: EventInfo): Note {
    return new Note({
      ...aggregate.values,
      status: "Deleted",
      updatedAt: info.recorded_on,
    })
  }
}
